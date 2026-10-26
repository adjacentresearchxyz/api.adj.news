import type {
	ErrorBody,
	ExistsQuery,
	ExistsResult,
	LevelPrint,
	PriceQuery,
	PriceResult,
	PriceSource,
	SeriesKind,
	AccessTier,
} from './types.ts';

const DEFAULT_ORIGIN = 'https://api.adjacent.markets';
const PAGE_SIZE = 1000;
const MAX_PAGES = 25;

export function createUpstreamPriceSource(origin: string = DEFAULT_ORIGIN): PriceSource {
	const base = origin.replace(/\/$/, '');
	return {
		getPrints: (query) => fetchPrints(base, query),
		exists: (query) => fetchExists(base, query),
	};
}

export function seriesPath(kind: SeriesKind, tier: AccessTier, id: string, leaf: 'prices' | ''): string {
	const root = tier === 'public' ? '/api/v1/public' : '/api/v1';
	const collection = kind === 'index' ? 'indices' : 'rates';
	const suffix = leaf === 'prices' ? '/prices' : '';
	return `${root}/${collection}/${encodeURIComponent(id)}${suffix}`;
}

async function fetchPrints(origin: string, query: PriceQuery): Promise<PriceResult> {
	const points: LevelPrint[] = [];
	let previousMarker = '';
	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = new URL(seriesPath(query.kind, query.tier, query.id, 'prices'), origin);
		url.searchParams.set('interval', query.sourceInterval);
		url.searchParams.set('per_page', String(PAGE_SIZE));
		url.searchParams.set('page', String(page));
		url.searchParams.set('order', 'asc');
		url.searchParams.set('start', query.start);
		url.searchParams.set('end', query.end);
		if (query.apiKey) url.searchParams.set('api_key', query.apiKey);

		let response: Response;
		try {
			response = await fetch(url, { headers: authHeaders(query.authorization), signal: AbortSignal.timeout(20_000) });
		} catch {
			return { ok: false, status: 503, body: { error: 'upstream_error', message: 'Price history request failed' } };
		}
		const parsed = await readJson(response);
		if (!response.ok) return { ok: false, status: response.status, body: parsed.body };
		const batch = readPrints(parsed.body);
		if (batch.length === 0) break;
		const marker = `${batch[0].timestamp}:${batch.length}:${batch[batch.length - 1].timestamp}`;
		if (marker === previousMarker) break;
		previousMarker = marker;
		points.push(...batch);
		const meta = parsed.body.meta;
		const hasNext = meta && typeof meta === 'object' && (meta as { has_next?: unknown }).has_next === true;
		if (!hasNext) break;
		if (page === MAX_PAGES) {
			return {
				ok: false,
				status: 400,
				body: {
					error: 'bad_request',
					message: 'Price window is too large to build candles. Narrow from and to.',
				},
			};
		}
	}
	return { ok: true, points };
}

async function fetchExists(origin: string, query: ExistsQuery): Promise<ExistsResult> {
	const url = new URL(seriesPath(query.kind, query.tier, query.id, ''), origin);
	if (query.apiKey) url.searchParams.set('api_key', query.apiKey);
	let response: Response;
	try {
		response = await fetch(url, { headers: authHeaders(query.authorization), signal: AbortSignal.timeout(20_000) });
	} catch {
		return { ok: false, status: 503, body: { error: 'upstream_error', message: 'Price history request failed' } };
	}
	if (response.ok) {
		await response.body?.cancel();
		return { ok: true };
	}
	const parsed = await readJson(response);
	return { ok: false, status: response.status, body: parsed.body };
}

function authHeaders(authorization: string | undefined): Headers {
	const headers = new Headers({ accept: 'application/json' });
	if (authorization) headers.set('authorization', authorization);
	return headers;
}

async function readJson(response: Response): Promise<{ body: ErrorBody }> {
	try {
		const payload: unknown = await response.json();
		if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
			return { body: payload as ErrorBody };
		}
	} catch {
		// Fall through to a stable error body.
	}
	return {
		body: {
			error: response.ok ? 'upstream_error' : 'upstream_error',
			message: 'Price history request failed',
		},
	};
}

function readPrints(body: ErrorBody): LevelPrint[] {
	const data = body.data;
	if (!Array.isArray(data)) return [];
	const points: LevelPrint[] = [];
	for (const row of data) {
		if (!row || typeof row !== 'object') continue;
		const timestamp = (row as { timestamp?: unknown }).timestamp;
		const price = (row as { price?: unknown }).price;
		if (typeof timestamp !== 'string' || typeof price !== 'number' || !Number.isFinite(price)) continue;
		points.push({ timestamp, price });
	}
	return points;
}

export function notFoundBody(kind: SeriesKind): ErrorBody {
	return { error: 'not_found', message: kind === 'index' ? 'Index not found' : 'Rate not found' };
}
