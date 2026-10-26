import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCandleApp } from './routes.ts';
import type { ExistsQuery, ExistsResult, LevelPrint, PriceQuery, PriceResult, PriceSource } from './types.ts';

const NOW = Date.parse('2026-10-26T15:00:00Z');

const SERIES: LevelPrint[] = [
	{ timestamp: '2026-10-26T12:10:00Z', price: 10 },
	{ timestamp: '2026-10-26T12:40:00Z', price: 14 },
	{ timestamp: '2026-10-26T12:55:00Z', price: 9 },
	{ timestamp: '2026-10-26T13:05:00Z', price: 11 },
	{ timestamp: '2026-10-26T13:50:00Z', price: 12 },
];

class MemorySource implements PriceSource {
	calls: PriceQuery[] = [];
	existsCalls: ExistsQuery[] = [];
	private readonly points: LevelPrint[];
	private readonly found: boolean;
	constructor(points: LevelPrint[] = SERIES, found = true) {
		this.points = points;
		this.found = found;
	}

	async getPrints(query: PriceQuery): Promise<PriceResult> {
		this.calls.push(query);
		return { ok: true, points: this.points };
	}

	async exists(query: ExistsQuery): Promise<ExistsResult> {
		this.existsCalls.push(query);
		if (!this.found) {
			return {
				ok: false,
				status: 404,
				body: { error: 'not_found', message: 'upstream' },
			};
		}
		return { ok: true };
	}
}

function appFor(source: PriceSource) {
	return createCandleApp({ priceSource: source, now: () => NOW });
}

async function get(app: ReturnType<typeof appFor>, path: string, headers?: Record<string, string>) {
	const response = await app.request(`http://localhost${path}`, { headers });
	const body: unknown = await response.json();
	return { status: response.status, body };
}

test('public index candles return OHLC for the known series without a credential', async () => {
	const source = new MemorySource();
	const { status, body } = await get(
		appFor(source),
		'/api/v1/public/indices/red/candles?interval=1hour&from=2026-10-26T13:00:00Z&to=2026-10-26T15:00:00Z&order=asc',
	);
	assert.equal(status, 200);
	assert.deepEqual(body, {
		data: [
			{ timestamp: '2026-10-26T13:00:00Z', open: 10, high: 14, low: 9, close: 9 },
			{ timestamp: '2026-10-26T14:00:00Z', open: 11, high: 12, low: 11, close: 12 },
		],
		meta: { total: 2, page: 1, per_page: 100, total_pages: 1, has_next: false, has_prev: false },
	});
	assert.equal(source.calls[0].tier, 'public');
	assert.equal(source.calls[0].kind, 'index');
	assert.equal(source.calls[0].id, 'red');
	assert.equal(source.calls[0].authorization, undefined);
	assert.equal(source.existsCalls.length, 0);
});

test('authenticated rate candles accept a bearer token and forward it', async () => {
	const source = new MemorySource();
	const { status, body } = await get(
		appFor(source),
		'/api/v1/rates/adj_redp/candles?interval=1hour&from=2026-10-26T13:00:00Z&to=2026-10-26T15:00:00Z',
		{ authorization: 'Bearer ak_test' },
	);
	assert.equal(status, 200);
	const payload = body as { data: { timestamp: string; close: number }[] };
	assert.deepEqual(
		payload.data.map((candle) => [candle.timestamp, candle.close]),
		[
			['2026-10-26T14:00:00Z', 12],
			['2026-10-26T13:00:00Z', 9],
		],
	);
	assert.equal(source.calls[0].tier, 'authenticated');
	assert.equal(source.calls[0].kind, 'rate');
	assert.equal(source.calls[0].authorization, 'Bearer ak_test');
	assert.equal(source.calls[0].sourceInterval, '1min');
});

test('public and authenticated routes agree on the same prints', async () => {
	const publicSource = new MemorySource();
	const authedSource = new MemorySource();
	const query = 'interval=1hour&from=2026-10-26T13:00:00Z&to=2026-10-26T15:00:00Z&order=asc';
	const pub = await get(appFor(publicSource), `/api/v1/public/indices/red/candles?${query}`);
	const authed = await get(appFor(authedSource), `/api/v1/indices/red/candles?${query}`, {
		authorization: 'Bearer ak_test',
	});
	assert.equal(pub.status, 200);
	assert.equal(authed.status, 200);
	assert.deepEqual(pub.body, authed.body);
});

test('empty history is an empty list, not a fabricated candle', async () => {
	const source = new MemorySource([]);
	const { status, body } = await get(appFor(source), '/api/v1/public/rates/adj_redp/candles?interval=1d');
	assert.equal(status, 200);
	assert.deepEqual(body, {
		data: [],
		meta: { total: 0, page: 1, per_page: 100, total_pages: 1, has_next: false, has_prev: false },
	});
	assert.equal(source.existsCalls.length, 1);
});

test('an unknown index is not found', async () => {
	const source = new MemorySource([], false);
	const { status, body } = await get(appFor(source), '/api/v1/public/indices/missing/candles');
	assert.equal(status, 404);
	assert.deepEqual(body, { error: 'not_found', message: 'Index not found' });
});

test('an unknown rate is not found', async () => {
	const source = new MemorySource([], false);
	const { status, body } = await get(
		appFor(source),
		'/api/v1/rates/missing/candles',
		{ authorization: 'Bearer ak_test' },
	);
	assert.equal(status, 404);
	assert.deepEqual(body, { error: 'not_found', message: 'Rate not found' });
});

test('from must be earlier than to', async () => {
	const source = new MemorySource();
	const { status, body } = await get(
		appFor(source),
		'/api/v1/public/indices/red/candles?from=2026-10-27T00:00:00Z&to=2026-10-26T00:00:00Z',
	);
	assert.equal(status, 400);
	assert.deepEqual(body, { error: 'bad_request', message: 'from must be earlier than to.' });
	assert.equal(source.calls.length, 0);
});

test('public rejects a 1min interval and does not read prices', async () => {
	const source = new MemorySource();
	const { status, body } = await get(appFor(source), '/api/v1/public/indices/red/candles?interval=1min');
	assert.equal(status, 400);
	assert.deepEqual(body, {
		error: 'bad_request',
		message: "Invalid public interval '1min'. Allowed: 1hour (30d window), 1d (90d window).",
	});
	assert.equal(source.calls.length, 0);
});

test('authenticated rejects an unknown interval and a missing credential', async () => {
	const source = new MemorySource();
	const missing = await get(appFor(source), '/api/v1/indices/red/candles?interval=1min');
	assert.equal(missing.status, 401);
	assert.deepEqual(missing.body, { error: 'Missing or invalid Authorization header', status: 401 });

	const invalid = await get(appFor(source), '/api/v1/indices/red/candles?interval=weekly', {
		authorization: 'Bearer ak_test',
	});
	assert.equal(invalid.status, 400);
	assert.deepEqual(invalid.body, {
		error: 'bad_request',
		message: "Invalid interval 'weekly'. Allowed: 1min, 5min, 1hour, 1d.",
	});
	assert.equal(source.calls.length, 0);

	const keyed = await get(appFor(source), '/api/v1/rates/adj_redp/candles?interval=5min&api_key=ak_test');
	assert.equal(keyed.status, 200);
	assert.equal(source.calls[0].apiKey, 'ak_test');
	assert.equal(source.calls[0].tier, 'authenticated');
});

test('public daily candles ask for hourly and daily levels', async () => {
	const source = new MemorySource();
	const { status } = await get(
		appFor(source),
		'/api/v1/public/indices/red/candles?interval=1d&from=2026-08-01T00:00:00Z&to=2026-10-26T15:00:00Z',
	);
	assert.equal(status, 200);
	const intervals = source.calls.map((call) => call.sourceInterval).sort();
	assert.deepEqual(intervals, ['1d', '1hour']);
	assert.equal(source.calls.every((call) => call.tier === 'public'), true);
});

test('a refused price read is passed through', async () => {
	const source: PriceSource = {
		async getPrints() {
			return {
				ok: false,
				status: 403,
				body: {
					error: 'Insufficient scope: a Pro or Premium API plan is required',
					status: 403,
					upgrade_url: 'https://adjacent.markets/subscribe',
				},
			};
		},
		async exists() {
			return { ok: true };
		},
	};
	const { status, body } = await get(appFor(source), '/api/v1/indices/red/candles?interval=1hour', {
		authorization: 'Bearer ak_test',
	});
	assert.equal(status, 403);
	assert.deepEqual(body, {
		error: 'Insufficient scope: a Pro or Premium API plan is required',
		status: 403,
		upgrade_url: 'https://adjacent.markets/subscribe',
	});
});
