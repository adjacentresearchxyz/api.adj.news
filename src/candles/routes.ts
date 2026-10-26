import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

import { handleCandles, type CandleDeps } from './handler.ts';
import type { AccessTier, SeriesKind } from './types.ts';
import { createUpstreamPriceSource } from './upstream.ts';

const candleSchema = z
	.object({
		timestamp: z.string().openapi({
			format: 'date-time',
			example: '2026-10-26T13:00:00Z',
			description:
				'End of the candle, in UTC. Sub-daily buckets are UTC-aligned. A 1d bucket ends at the next US Eastern midnight.',
		}),
		open: z.number().openapi({
			example: 10,
			description: 'First published level in the bucket.',
		}),
		high: z.number().openapi({
			example: 14,
			description: 'Highest published level in the bucket.',
		}),
		low: z.number().openapi({
			example: 9,
			description: 'Lowest published level in the bucket.',
		}),
		close: z.number().openapi({
			example: 9,
			description: 'Last published level in the bucket.',
		}),
	})
	.openapi('LevelCandle');

const listSchema = z
	.object({
		data: z.array(candleSchema),
		meta: z.object({
			total: z.number().nullable(),
			page: z.number(),
			per_page: z.number(),
			total_pages: z.number().nullable(),
			has_next: z.boolean(),
			has_prev: z.boolean(),
		}),
	})
	.openapi('LevelCandleList');

const errorSchema = z
	.object({
		error: z.string(),
		message: z.string().optional(),
		status: z.number().optional(),
		upgrade_url: z.string().optional(),
	})
	.openapi('CandleError');

const querySchema = z.object({
	interval: z.string().optional().openapi({
		description:
			'Bucket size. Public: 1hour (30d window) or 1d (90d window). Authenticated: 1min, 5min, 1hour, or 1d. daily and 1day are aliases of 1d. Defaults to 1hour on the public tier and 5min when authenticated.',
		example: '1hour',
	}),
	from: z.string().optional().openapi({
		description:
			'Inclusive lower bound on the candle timestamp (the bucket end). ISO-8601, or YYYY-MM-DD for the start of that UTC day.',
		example: '2026-10-26T00:00:00Z',
	}),
	to: z.string().optional().openapi({
		description:
			'Exclusive upper bound on the candle timestamp. ISO-8601, or YYYY-MM-DD for the start of the next UTC day.',
		example: '2026-10-27T00:00:00Z',
	}),
	page: z.string().optional().openapi({ description: '1-based page number. Defaults to 1.', example: '1' }),
	per_page: z.string().optional().openapi({
		description: 'Candles per page (1-500). Defaults to 100.',
		example: '100',
	}),
	order: z.string().optional().openapi({
		description: 'Sort by candle timestamp. Defaults to desc (newest bucket end first).',
		example: 'desc',
	}),
	api_key: z.string().optional().openapi({
		description: 'API key. Authenticated routes accept this or a Bearer token. Ignored on public routes.',
	}),
});

const exampleList = {
	data: [
		{
			timestamp: '2026-10-26T14:00:00Z',
			open: 11,
			high: 12,
			low: 11,
			close: 12,
		},
		{
			timestamp: '2026-10-26T13:00:00Z',
			open: 10,
			high: 14,
			low: 9,
			close: 9,
		},
	],
	meta: {
		total: 2,
		page: 1,
		per_page: 100,
		total_pages: 1,
		has_next: false,
		has_prev: false,
	},
};

function description(kind: SeriesKind, tier: AccessTier): string {
	const subject = kind === 'index' ? 'index' : 'reference rate';
	const scale =
		kind === 'index'
			? 'Levels stay on the index scale (political indices are roughly 50-150; point indices such as team indices start at 1000).'
			: 'Levels stay on the rate scale, 0-100.';
	const access =
		tier === 'public'
			? 'No credential. Values are the 15-minute-delayed public series. interval is 1hour (30-day window) or 1d (90-day window). A 1d candle inside the hourly window is the OHLC of those hourly levels. An older day in the 90-day window uses that day\'s published daily level, so open, high, low, and close are equal.'
			: 'Requires the same Bearer token or api_key as price history. Realtime reads use that route\'s plan gate (Pro or Premium); a 403 from the price read is returned unchanged. interval is 1min, 5min, 1hour, or 1d. Candles are aggregated from the finest published level series that fits the window (1min, then 5min, then 1hour), and never from a series coarser than the candle.';
	return [
		`OHLC candles for one ${subject}, bucketed from published levels.`,
		'These are calculated levels, not venue trades: there is no bid, ask, or volume.',
		'timestamp is the end of the bucket, in UTC, the same convention as market candles.',
		'1min, 5min, and 1hour buckets align to UTC.',
		'1d buckets use US Eastern midnights, the same day boundary as price history, and timestamp is the following Eastern midnight.',
		'A bucket with no level is omitted, not filled with null OHLC.',
		'Official daily values on /daily-values are a separate series and are not changed.',
		scale,
		access,
	].join(' ');
}

const specs: { kind: SeriesKind; tier: AccessTier; path: string; summary: string }[] = [
	{
		kind: 'index',
		tier: 'public',
		path: '/api/v1/public/indices/{id}/candles',
		summary: 'Get public index candles',
	},
	{
		kind: 'index',
		tier: 'authenticated',
		path: '/api/v1/indices/{id}/candles',
		summary: 'Get index candles',
	},
	{
		kind: 'rate',
		tier: 'public',
		path: '/api/v1/public/rates/{id}/candles',
		summary: 'Get public reference rate candles',
	},
	{
		kind: 'rate',
		tier: 'authenticated',
		path: '/api/v1/rates/{id}/candles',
		summary: 'Get reference rate candles',
	},
];

function buildRoute(spec: (typeof specs)[number]) {
	return createRoute({
		method: 'get',
		path: spec.path,
		summary: spec.summary,
		description: description(spec.kind, spec.tier),
		request: {
			params: z.object({
				id: z.string().openapi({
					description:
						spec.kind === 'index'
							? 'Index id or ticker (the price route is case-insensitive).'
							: 'Rate id.',
					example: spec.kind === 'index' ? 'red' : 'adj_redp',
				}),
			}),
			query: querySchema,
		},
		responses: {
			200: {
				description: 'Candles in the requested window. Empty when the series has no levels there.',
				content: { 'application/json': { schema: listSchema, example: exampleList } },
			},
			400: {
				description: 'Invalid interval, bound, or page parameter.',
				content: {
					'application/json': {
						schema: errorSchema,
						example:
							spec.tier === 'public'
								? {
										error: 'bad_request',
										message:
											"Invalid public interval '1min'. Allowed: 1hour (30d window), 1d (90d window).",
									}
								: {
										error: 'bad_request',
										message: "Invalid interval 'weekly'. Allowed: 1min, 5min, 1hour, 1d.",
									},
					},
				},
			},
			401: {
				description: 'Authenticated route called without a Bearer token or api_key.',
				content: {
					'application/json': {
						schema: errorSchema,
						example: { error: 'Missing or invalid Authorization header', status: 401 },
					},
				},
			},
			403: {
				description: 'The price read refused the credential. Pro or Premium is required for realtime history.',
				content: {
					'application/json': {
						schema: errorSchema,
						example: {
							error: 'Insufficient scope: a Pro or Premium API plan is required',
							status: 403,
							upgrade_url: 'https://adjacent.markets/subscribe',
						},
					},
				},
			},
			404: {
				description: spec.kind === 'index' ? 'Index not found' : 'Rate not found',
				content: {
					'application/json': {
						schema: errorSchema,
						example: {
							error: 'not_found',
							message: spec.kind === 'index' ? 'Index not found' : 'Rate not found',
						},
					},
				},
			},
		},
	});
}

export function createCandleApp(deps: CandleDeps) {
	const app = new OpenAPIHono();
	registerCandleRoutes(app, deps);
	return app;
}

export function registerCandleRoutes(app: OpenAPIHono, deps?: CandleDeps) {
	for (const spec of specs) {
		const route = buildRoute(spec);
		app.openapi(route, async (c) => {
			const env = c.env as { ADJACENT_API_ORIGIN?: string } | undefined;
			const source =
				deps?.priceSource ??
				createUpstreamPriceSource(env?.ADJACENT_API_ORIGIN ?? 'https://api.adjacent.markets');
			const result = await handleCandles(
				{ priceSource: source, now: deps?.now },
				{
					kind: spec.kind,
					tier: spec.tier,
					id: c.req.param('id'),
					query: {
						interval: c.req.query('interval'),
						from: c.req.query('from'),
						to: c.req.query('to'),
						page: c.req.query('page'),
						per_page: c.req.query('per_page'),
						order: c.req.query('order'),
						api_key: c.req.query('api_key'),
					},
					authorization: c.req.header('authorization') ?? null,
				},
			);
			return c.json(result.body, result.status as 200, result.headers);
		});
	}
}
