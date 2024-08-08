import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';
import Exa from 'exa-js';
import { fetchAndCombineJsonFiles } from './scrape.ts';

// Environment interface
export interface Env {
	EXA_API_KEY: string;
	SUPABASE_URL: string;
	SUPABASE_ANON_KEY: string;
}

// Initialize app
const app = new OpenAPIHono<Env>();

// Middleware
app.use('/api/*', cors({ origin: '*' }));
app.use('/api/*', async (c, next) => {
	const apiKey = c.req.header('X-API-Key');
	if (!apiKey) {
		return c.json({ error: 'API key is required' }, 401);
	}

	const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY);

	// Query the users table for the provided API key
	const { data, error } = await supabase
		.from('user')
		.select('plan')
		.eq('api_key', apiKey)
		.single()

	if (error || !data) {
		return c.json({ error: 'Invalid API key' }, 401);
	}

	if (data.plan !== 'pro') {
		return c.json({ error: 'This API is only available for pro users' }, 403);
	}

	await next();
});

// Swagger UI
app.get('/ui', swaggerUI({ url: '/doc' }));
app.get('/', (c) => c.redirect('/ui'));

// OpenAPI documentation
app.doc('/doc', {
	info: {
		title: 'Adjacent News API',
		version: 'v1',
	},
	openapi: '3.1.0',
	servers: [
		{
			url: 'https://api.data.adj.news',
			description: 'Production API server',
		},
	],
});
// Updated Schemas
const NewsSchema = z.object({
	market: z.string().openapi({
		example: 'Will the winner of the 2024 USA presidential election win Pennsylvania?',
	}),
	startDate: z.string().optional().openapi({
		example: '2024-08-01',
		description: 'Start date for news articles (YYYY-MM-DD)',
	}),
	endDate: z.string().optional().openapi({
		example: '2024-08-07',
		description: 'End date for news articles (YYYY-MM-DD)',
	}),
	numResults: z.number().optional().openapi({
		example: 10,
		description: 'Number of results to return (default: 10, max: 50)',
	}),
}).openapi({
	'x-api-key': {
		in: 'header',
		name: 'X-API-Key',
		required: true,
	},
});

const AllMarketsSchema = z.object({
	index: z.string().optional().openapi({
		example: '101',
		description: 'Index for pagination, optional.',
	}),
	platform: z.string().optional().openapi({
		example: 'Kalshi',
		description: 'Filter markets by platform',
	}),
	status: z.string().optional().openapi({
		example: 'active',
		description: 'Filter markets by status (e.g., active, finalized)',
	}),
	category: z.string().optional().openapi({
		example: 'Politics',
		description: 'Filter markets by category',
	}),
}).openapi({
	'x-api-key': {
		in: 'header',
		name: 'X-API-Key',
		required: true,
	},
});

const MarketsByHeadline = z.object({
	headline: z.string().openapi({
		example: 'Will the winner of the 2024 USA presidential election win Pennsylvania?',
	}),
	matchThreshold: z.number().optional().openapi({
		example: 0.8,
		description: 'Matching threshold for related markets (0.0 to 1.0)',
	}),
	matchCount: z.number().optional().openapi({
		example: 3,
		description: 'Number of related markets to return',
	}),
}).openapi({
	'x-api-key': {
		in: 'header',
		name: 'X-API-Key',
		required: true,
	},
});

// Updated Route definitions
const newsRoute = createRoute({
	method: 'get',
	path: '/api/news/{market}',
	description: 'Get news articles for the given market',
	request: {
		params: NewsSchema,
		headers: {
			'x-api-key': z.string().nonempty().description('Your API key'),
		},
	},
	responses: {
		200: {
			description: 'News articles for the given market',
			content: {
				'application/json': {
					schema: z.object({
						result: z.string(),
					}),
				},
			},
		},
	},
});

const allMarketsRoute = createRoute({
	method: 'get',
	path: '/api/markets/{index}',
	description: 'Get all markets, returns 100 at a time.',
	request: {
		params: AllMarketsSchema,
		headers: {
			'x-api-key': z.string().nonempty().description('Your API key'),
		},
	},
	responses: {
		200: {
			description: 'Get All Markets',
			content: {
				'application/json': {
					schema: z.object({
						result: z.string(),
					}),
				},
			},
		},
	},
});

const marketsByHeadlineRoute = createRoute({
	method: 'get',
	path: '/api/markets/headline/{headline}',
	description: 'Get related markets by headline',
	request: {
		params: MarketsByHeadline,
		headers: {
			'x-api-key': z.string().nonempty().description('Your API key'),
		},
	},
	responses: {
		200: {
			description: 'Get related markets by headline',
			content: {
				'application/json': {
					schema: z.object({
						result: z.string(),
					}),
				},
			},
		},
	},
});

// Updated Route handlers
app.openapi(newsRoute, async (c) => {
	const exa = new Exa(c.env.EXA_API_KEY);
	const { market, startDate, endDate, numResults } = c.req.param();
	const endDateObj = endDate ? new Date(endDate) : new Date();
	const startDateObj = startDate ? new Date(startDate) : new Date(endDateObj);
	startDateObj.setDate(startDateObj.getDate() - 7);

	try {
		const results = await exa.search(market, {
			type: "neural",
			useAutoprompt: true,
			numResults: Math.min(numResults || 10, 50),
			category: "news",
			startCrawlDate: startDateObj.toISOString(),
			endCrawlDate: endDateObj.toISOString(),
			startPublishedDate: startDateObj.toISOString(),
			endPublishedDate: endDateObj.toISOString(),
			excludeDomains: ["kalshi.com", "metaculus.com", "manifold.markets", "polymarket.com"]
		});
		return c.json(results);
	} catch (error) {
		c.status(500);
		return c.json({ error: "An error occurred while fetching news articles. Please try again later." });
	}
});

app.openapi(allMarketsRoute, async (c) => {
	const { index, platform, status, category } = c.req.param();
	const startIndex = index ? parseInt(index) : 0;
	let markets = await fetchAndCombineJsonFiles();

	// Apply filters
	if (platform) {
		markets = markets.filter(market => market.Platform === platform);
	}
	if (status) {
		markets = markets.filter(market => market.Status === status);
	}
	if (category) {
		markets = markets.filter(market => market.Category === category);
	}

	const slicedMarkets = markets?.slice(startIndex, startIndex + 100);
	return c.json(slicedMarkets);
});

app.openapi(marketsByHeadlineRoute, async (c) => {
	const { headline, matchThreshold, matchCount } = c.req.param();
	const url = 'https://fyeyeurwgxklumxgpcgz.supabase.co/functions/v1/embed';
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${c.env.SUPABASE_ANON_KEY}`
	};

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: headers,
			body: JSON.stringify({ input: headline }),
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const embedding = await response.json();
		let markets = await useRelatedMarkets(embedding, c.env, matchThreshold, matchCount);
		markets = markets.map(({ question_embedding, ...rest }) => rest);

		return c.json(markets?.length > 0 ? markets : "No related markets. Explore at https://data.adj.news");
	} catch (error) {
		console.error('Error fetching embedding:', error);
		return c.json("Error processing your request. Please try again later.");
	}
});

// Updated helper function
function useRelatedMarkets(embedding, env, matchThreshold = 0.803, matchCount = 3) {
	const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
	return supabase.rpc('match_documents', {
		query_embedding: embedding.embedding,
		match_threshold: matchThreshold,
		match_count: matchCount,
	}).then(({ data: documents }) => documents)
		.catch(error => {
			console.error(error);
			return [];
		});
}

// 404 handler
app.notFound(c => c.text('Not found', 404));

export default app;