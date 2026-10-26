import { mergeLevelPrints } from './ohlc.ts';
import { chooseSourceInterval, estimatePrints, MAX_PRINTS, sourceWindow } from './query.ts';
import type { AccessTier, CandleInterval, PriceResult, PriceSource, SeriesKind } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_HOURLY_LOOKBACK_MS = 30 * DAY_MS;

export type LoadRequest = {
	source: PriceSource;
	kind: SeriesKind;
	id: string;
	tier: AccessTier;
	interval: CandleInterval;
	fromMs: number;
	toMs: number;
	authorization?: string;
	apiKey?: string;
};

function tooLarge(): PriceResult {
	return {
		ok: false,
		status: 400,
		body: {
			error: 'bad_request',
			message: 'Price window is too large to build candles. Narrow from and to.',
		},
	};
}

/**
 * Load the level prints a candle is built from.
 *
 * Public daily candles use hourly levels for the last 30 days (real high and
 * low of that series) and the published daily level for older days in the
 * 90-day window. Those older days have a single observation.
 */
export async function loadLevelPrints(request: LoadRequest): Promise<PriceResult> {
	const auth = { authorization: request.authorization, apiKey: request.apiKey };
	if (request.tier === 'public' && request.interval === '1d') {
		const hourlyFrom = Math.max(request.fromMs, request.toMs - PUBLIC_HOURLY_LOOKBACK_MS);
		const hourlyWindow = sourceWindow(hourlyFrom, request.toMs, '1hour');
		const dailyWindow = sourceWindow(request.fromMs, request.toMs, '1d');
		const [hourly, daily] = await Promise.all([
			request.source.getPrints({
				kind: request.kind,
				id: request.id,
				tier: request.tier,
				sourceInterval: '1hour',
				start: hourlyWindow.start,
				end: hourlyWindow.end,
				...auth,
			}),
			request.source.getPrints({
				kind: request.kind,
				id: request.id,
				tier: request.tier,
				sourceInterval: '1d',
				start: dailyWindow.start,
				end: dailyWindow.end,
				...auth,
			}),
		]);
		if (!hourly.ok) return hourly;
		if (!daily.ok) return daily;
		return { ok: true, points: mergeLevelPrints(hourly.points, daily.points) };
	}

	const windowMs = request.toMs - request.fromMs;
	const sourceInterval = chooseSourceInterval(request.tier, request.interval, windowMs);
	if (estimatePrints(sourceInterval, windowMs) > MAX_PRINTS) return tooLarge();
	const window = sourceWindow(request.fromMs, request.toMs, sourceInterval);
	return request.source.getPrints({
		kind: request.kind,
		id: request.id,
		tier: request.tier,
		sourceInterval,
		start: window.start,
		end: window.end,
		...auth,
	});
}
