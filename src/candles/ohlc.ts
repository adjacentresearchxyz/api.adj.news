import type { CandleInterval, LevelPrint, SortOrder } from './types.ts';

export type Candle = {
	/** End of the bucket, UTC. The bucket is `[start, timestamp)`. */
	timestamp: string;
	open: number;
	high: number;
	low: number;
	close: number;
};

export const INTERVAL_MS: Record<CandleInterval, number> = {
	'1min': 60_000,
	'5min': 5 * 60_000,
	'1hour': 60 * 60_000,
	'1d': 24 * 60 * 60_000,
};

const EASTERN = 'America/New_York';

export function formatUtc(ms: number): string {
	return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

type Ymd = { y: number; m: number; d: number };

function partsIn(ms: number, timeZone: string): Record<string, string> {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(ms));
	const out: Record<string, string> = {};
	for (const part of parts) {
		if (part.type !== 'literal') out[part.type] = part.value;
	}
	return out;
}

/** US Eastern calendar date of a UTC instant. */
export function easternYmd(ms: number): Ymd {
	const part = partsIn(ms, EASTERN);
	return { y: Number(part.year), m: Number(part.month), d: Number(part.day) };
}

export function easternDateKey(ms: number): string {
	const { y, m, d } = easternYmd(ms);
	return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

function addCalendarDays(ymd: Ymd, days: number): Ymd {
	const utc = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days));
	return { y: utc.getUTCFullYear(), m: utc.getUTCMonth() + 1, d: utc.getUTCDate() };
}

/**
 * UTC instant of midnight US Eastern on a calendar day.
 * DST transitions are resolved by shifting until the Eastern clock reads midnight.
 */
export function easternMidnightUtc(ymd: Ymd): number {
	let utc = Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12, 0, 0);
	for (let attempt = 0; attempt < 4; attempt++) {
		const part = partsIn(utc, EASTERN);
		let hour = Number(part.hour);
		let y = Number(part.year);
		let m = Number(part.month);
		let d = Number(part.day);
		const minute = Number(part.minute);
		const second = Number(part.second);
		if (hour === 24) {
			hour = 0;
			const next = addCalendarDays({ y, m, d }, 1);
			y = next.y;
			m = next.m;
			d = next.d;
		}
		const localAsUtc = Date.UTC(y, m - 1, d, hour, minute, second);
		const desired = Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0);
		const delta = desired - localAsUtc;
		utc += delta;
		if (delta === 0) return utc;
	}
	return utc;
}

function bucketOf(ms: number, interval: CandleInterval): { startMs: number; endMs: number } {
	if (interval === '1d') {
		const ymd = easternYmd(ms);
		const startMs = easternMidnightUtc(ymd);
		const endMs = easternMidnightUtc(addCalendarDays(ymd, 1));
		return { startMs, endMs };
	}
	const size = INTERVAL_MS[interval];
	const startMs = Math.floor(ms / size) * size;
	return { startMs, endMs: startMs + size };
}

type Bucket = {
	endMs: number;
	open: number;
	high: number;
	low: number;
	close: number;
};

/**
 * Bucket level prints into OHLC candles.
 *
 * Sub-daily buckets align to UTC. Daily buckets align to US Eastern midnights,
 * matching index price history, but `timestamp` is the bucket end (the next
 * Eastern midnight), matching market candles.
 *
 * Empty buckets are omitted. A single print becomes open = high = low = close.
 * Volume is not derived.
 */
export function aggregateOhlc(
	points: LevelPrint[],
	interval: CandleInterval,
	range: { fromMs: number; toMs: number },
	order: SortOrder = 'desc',
): Candle[] {
	const stamped: { ms: number; price: number; index: number }[] = [];
	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		const ms = Date.parse(point.timestamp);
		if (!Number.isFinite(ms) || !Number.isFinite(point.price)) continue;
		stamped.push({ ms, price: point.price, index });
	}
	stamped.sort((a, b) => a.ms - b.ms || a.index - b.index);

	const buckets: Bucket[] = [];
	let current: Bucket | undefined;
	for (const point of stamped) {
		const { endMs } = bucketOf(point.ms, interval);
		if (!current || current.endMs !== endMs) {
			current = {
				endMs,
				open: point.price,
				high: point.price,
				low: point.price,
				close: point.price,
			};
			buckets.push(current);
			continue;
		}
		if (point.price > current.high) current.high = point.price;
		if (point.price < current.low) current.low = point.price;
		current.close = point.price;
	}

	const filtered = buckets.filter((bucket) => bucket.endMs >= range.fromMs && bucket.endMs < range.toMs);
	filtered.sort((a, b) => (order === 'asc' ? a.endMs - b.endMs : b.endMs - a.endMs));
	return filtered.map((bucket) => ({
		timestamp: formatUtc(bucket.endMs),
		open: bucket.open,
		high: bucket.high,
		low: bucket.low,
		close: bucket.close,
	}));
}

/**
 * Prefer intraday prints. A daily published level is used only for an Eastern
 * day that has no finer print, and it is placed at the timestamp the price
 * API already gave it (bucket start). One print makes open, high, low, and
 * close identical, which is the whole observation we have for that day.
 */
export function mergeLevelPrints(finer: LevelPrint[], daily: LevelPrint[]): LevelPrint[] {
	const covered = new Set<string>();
	for (const point of finer) {
		const ms = Date.parse(point.timestamp);
		if (Number.isFinite(ms)) covered.add(easternDateKey(ms));
	}
	const extra = daily.filter((point) => {
		const ms = Date.parse(point.timestamp);
		return Number.isFinite(ms) && !covered.has(easternDateKey(ms));
	});
	return [...finer, ...extra];
}

export function pageCandles(candles: Candle[], page: number, perPage: number) {
	const total = candles.length;
	const totalPages = total === 0 ? 1 : Math.ceil(total / perPage);
	const start = (page - 1) * perPage;
	const data = start >= total ? [] : candles.slice(start, start + perPage);
	return {
		data,
		meta: {
			total,
			page,
			per_page: perPage,
			total_pages: totalPages,
			has_next: page < totalPages,
			has_prev: page > 1,
		},
	};
}
