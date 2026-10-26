/** Published index or rate level. `timestamp` is when that level was recorded. */
export type LevelPrint = {
	timestamp: string;
	price: number;
};

export type SeriesKind = 'index' | 'rate';
export type AccessTier = 'public' | 'authenticated';
export type CandleInterval = '1min' | '5min' | '1hour' | '1d';
export type SortOrder = 'asc' | 'desc';

export type ErrorBody = Record<string, unknown>;

export type PriceQuery = {
	kind: SeriesKind;
	id: string;
	tier: AccessTier;
	/** Resolution to request from price history. May be finer than the candle. */
	sourceInterval: CandleInterval;
	start: string;
	end: string;
	authorization?: string;
	apiKey?: string;
};

export type ExistsQuery = {
	kind: SeriesKind;
	id: string;
	tier: AccessTier;
	authorization?: string;
	apiKey?: string;
};

export type PriceResult =
	| { ok: true; points: LevelPrint[] }
	| { ok: false; status: number; body: ErrorBody };

export type ExistsResult = { ok: true } | { ok: false; status: number; body: ErrorBody };

/** Reads published level prints. Implementations must not invent bid, ask, or volume. */
export interface PriceSource {
	getPrints(query: PriceQuery): Promise<PriceResult>;
	exists(query: ExistsQuery): Promise<ExistsResult>;
}
