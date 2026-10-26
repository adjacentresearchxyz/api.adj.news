import { INTERVAL_MS } from './ohlc.ts';
import type { AccessTier, CandleInterval, ErrorBody, SortOrder } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stay under this many published prints per candle request. */
export const MAX_PRINTS = 20_000;

const PUBLIC_INTERVALS: CandleInterval[] = ['1hour', '1d'];
const AUTHED_INTERVALS: CandleInterval[] = ['1min', '5min', '1hour', '1d'];
const RANK: CandleInterval[] = ['1min', '5min', '1hour', '1d'];

export type ResolvedCandleQuery = {
	interval: CandleInterval;
	fromMs: number;
	toMs: number;
	page: number;
	perPage: number;
	order: SortOrder;
	/** Public history does not cover `[fromMs, toMs)`. */
	emptyWindow: boolean;
};

function bad(message: string): { ok: false; status: 400; body: ErrorBody } {
	return { ok: false, status: 400, body: { error: 'bad_request', message } };
}

function normalizeInterval(raw: string | undefined, tier: AccessTier): CandleInterval | { error: string } {
	if (raw === undefined || raw.trim() === '') {
		return tier === 'public' ? '1hour' : '5min';
	}
	const token = raw.trim();
	const aliased = token === 'daily' || token === '1day' ? '1d' : token;
	const allowed = tier === 'public' ? PUBLIC_INTERVALS : AUTHED_INTERVALS;
	if (!allowed.includes(aliased as CandleInterval)) {
		if (tier === 'public') {
			return {
				error: `Invalid public interval '${token}'. Allowed: 1hour (30d window), 1d (90d window).`,
			};
		}
		return { error: `Invalid interval '${token}'. Allowed: 1min, 5min, 1hour, 1d.` };
	}
	return aliased as CandleInterval;
}

function parseBound(raw: string, field: 'from' | 'to'): { ms: number } | { error: string } {
	const value = raw.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const ms = Date.parse(`${value}T00:00:00Z`);
		if (!Number.isFinite(ms)) return { error: `Invalid ${field} timestamp.` };
		// `to` is exclusive, so a date-only upper bound covers that entire UTC day.
		if (field === 'to') return { ms: ms + DAY_MS };
		return { ms };
	}
	if (!value.includes('T')) return { error: `Invalid ${field} timestamp.` };
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) return { error: `Invalid ${field} timestamp.` };
	return { ms };
}

function parsePositiveInt(raw: string | undefined, field: 'page' | 'per_page', fallback: number, max: number) {
	if (raw === undefined || raw.trim() === '') return { value: fallback };
	if (!/^\d+$/.test(raw.trim())) {
		const message =
			field === 'page'
				? 'page must be an integer greater than or equal to 1.'
				: 'per_page must be an integer from 1 to 500.';
		return { error: message };
	}
	const value = Number(raw.trim());
	if (field === 'page' && value < 1) return { error: 'page must be an integer greater than or equal to 1.' };
	if (field === 'per_page' && (value < 1 || value > max)) {
		return { error: 'per_page must be an integer from 1 to 500.' };
	}
	return { value };
}

function lookbackMs(tier: AccessTier, interval: CandleInterval): number {
	if (tier === 'public') return (interval === '1d' ? 90 : 30) * DAY_MS;
	if (interval === '1min' || interval === '5min') return 7 * DAY_MS;
	if (interval === '1hour') return 30 * DAY_MS;
	return 90 * DAY_MS;
}

export function parseCandleQuery(
	query: Record<string, string | undefined>,
	tier: AccessTier,
	nowMs: number,
): { ok: true; value: ResolvedCandleQuery } | { ok: false; status: 400; body: ErrorBody } {
	const intervalResult = normalizeInterval(query.interval, tier);
	if (typeof intervalResult !== 'string') return bad(intervalResult.error);

	const pageResult = parsePositiveInt(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
	if ('error' in pageResult) return bad(pageResult.error);
	const perPageResult = parsePositiveInt(query.per_page, 'per_page', 100, 500);
	if ('error' in perPageResult) return bad(perPageResult.error);

	let order: SortOrder = 'desc';
	if (query.order !== undefined && query.order.trim() !== '') {
		if (query.order !== 'asc' && query.order !== 'desc') {
			return bad(`Invalid order '${query.order}'. Allowed: asc, desc.`);
		}
		order = query.order;
	}

	let fromMs: number | undefined;
	let toMs: number | undefined;
	if (query.from !== undefined && query.from.trim() !== '') {
		const parsed = parseBound(query.from, 'from');
		if ('error' in parsed) return bad(parsed.error);
		fromMs = parsed.ms;
	}
	if (query.to !== undefined && query.to.trim() !== '') {
		const parsed = parseBound(query.to, 'to');
		if ('error' in parsed) return bad(parsed.error);
		toMs = parsed.ms;
	}
	if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) {
		return bad('from must be earlier than to.');
	}

	const lookback = lookbackMs(tier, intervalResult);
	let resolvedTo = toMs ?? nowMs;
	if (tier === 'public' && resolvedTo > nowMs) resolvedTo = nowMs;
	let resolvedFrom = fromMs ?? resolvedTo - lookback;
	if (tier === 'public' && resolvedFrom < resolvedTo - lookback) {
		resolvedFrom = resolvedTo - lookback;
	}

	return {
		ok: true,
		value: {
			interval: intervalResult,
			fromMs: resolvedFrom,
			toMs: resolvedTo,
			page: pageResult.value,
			perPage: perPageResult.value,
			order,
			emptyWindow: resolvedFrom >= resolvedTo,
		},
	};
}

export function hasCredential(authorization: string | null, apiKey: string | undefined): boolean {
	if (apiKey !== undefined && apiKey.trim() !== '') return true;
	if (authorization === null) return false;
	const value = authorization.trim();
	return value !== '' && value !== 'Bearer';
}

/**
 * Finest published interval that can fill `candle` without reading more than
 * MAX_PRINTS points. Never coarser than the candle itself.
 */
export function chooseSourceInterval(tier: AccessTier, candle: CandleInterval, windowMs: number): CandleInterval {
	const allowed = tier === 'public' ? PUBLIC_INTERVALS : AUTHED_INTERVALS;
	const candleRank = RANK.indexOf(candle);
	const candidates = allowed.filter((interval) => RANK.indexOf(interval) <= candleRank);
	for (const interval of candidates) {
		if (estimatePrints(interval, windowMs) <= MAX_PRINTS) return interval;
	}
	return candidates[candidates.length - 1];
}

export function estimatePrints(interval: CandleInterval, windowMs: number): number {
	if (windowMs <= 0) return 0;
	return Math.ceil(windowMs / INTERVAL_MS[interval]);
}

export function sourceWindow(fromMs: number, toMs: number, sourceInterval: CandleInterval): { start: string; end: string } {
	const widen = sourceInterval === '1d' ? 2 * DAY_MS : INTERVAL_MS[sourceInterval];
	return {
		start: new Date(fromMs - widen).toISOString(),
		end: new Date(toMs).toISOString(),
	};
}
