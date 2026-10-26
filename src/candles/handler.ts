import { aggregateOhlc, pageCandles } from './ohlc.ts';
import { loadLevelPrints } from './load.ts';
import { hasCredential, parseCandleQuery } from './query.ts';
import type { AccessTier, ErrorBody, PriceSource, SeriesKind } from './types.ts';
import { notFoundBody } from './upstream.ts';

export type CandleDeps = {
	priceSource: PriceSource;
	now?: () => number;
};

export type CandleHttpRequest = {
	kind: SeriesKind;
	tier: AccessTier;
	id: string;
	query: Record<string, string | undefined>;
	authorization: string | null;
};

export type CandleHttpResponse = {
	status: number;
	body: unknown;
	headers: Record<string, string>;
};

const UNAUTHORIZED: ErrorBody = {
	error: 'Missing or invalid Authorization header',
	status: 401,
};

/**
 * Build one candle response.
 *
 * Authenticated routes require the same credential shape as price history
 * (Bearer token or `api_key`) and forward it. Plan enforcement stays on the
 * upstream price read, whose 403 is returned unchanged.
 * Public routes never forward a credential, so they stay on the delayed tier.
 */
export async function handleCandles(deps: CandleDeps, request: CandleHttpRequest): Promise<CandleHttpResponse> {
	const headers = cacheHeaders(request.tier);
	if (request.tier === 'authenticated' && !hasCredential(request.authorization, request.query.api_key)) {
		return { status: 401, body: UNAUTHORIZED, headers };
	}

	const nowMs = deps.now ? deps.now() : Date.now();
	const parsed = parseCandleQuery(request.query, request.tier, nowMs);
	if (parsed.ok === false) return { status: parsed.status, body: parsed.body, headers };

	const credential =
		request.tier === 'authenticated'
			? { authorization: request.authorization ?? undefined, apiKey: request.query.api_key }
			: {};

	if (!parsed.value.emptyWindow) {
		const loaded = await loadLevelPrints({
			source: deps.priceSource,
			kind: request.kind,
			id: request.id,
			tier: request.tier,
			interval: parsed.value.interval,
			fromMs: parsed.value.fromMs,
			toMs: parsed.value.toMs,
			...credential,
		});
		if (loaded.ok === false) return { status: loaded.status, body: loaded.body, headers };
		if (loaded.points.length > 0) {
			const candles = aggregateOhlc(
				loaded.points,
				parsed.value.interval,
				{ fromMs: parsed.value.fromMs, toMs: parsed.value.toMs },
				parsed.value.order,
			);
			return { status: 200, body: pageCandles(candles, parsed.value.page, parsed.value.perPage), headers };
		}
	}

	const existence = await deps.priceSource.exists({
		kind: request.kind,
		id: request.id,
		tier: request.tier,
		...credential,
	});
	if (existence.ok === false) {
		if (existence.status === 404) {
			return { status: 404, body: notFoundBody(request.kind), headers };
		}
		return { status: existence.status, body: existence.body, headers };
	}
	return {
		status: 200,
		body: pageCandles([], parsed.value.page, parsed.value.perPage),
		headers,
	};
}

function cacheHeaders(tier: AccessTier): Record<string, string> {
	if (tier === 'public') {
		return { 'cache-control': 'public, max-age=15, s-maxage=60, stale-while-revalidate=60' };
	}
	return { 'cache-control': 'private, no-store' };
}
