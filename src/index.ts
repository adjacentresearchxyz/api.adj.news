import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';

// Import string similarity for related markets
import { stringSimilarity } from "string-similarity-js";

// Import Exa
import Exa from 'exa-js';

// Import Scrape
import { fetchAndCombineJsonFiles } from './scrape.ts';

const app = new OpenAPIHono()
app.use('/api/*', cors({ origin: '*' }));

// Use the middleware to serve Swagger UI at /ui
app.get('/ui', swaggerUI({ url: '/doc' }))

// Define the OpenAPI spec
app.doc('/doc', {
	info: {
		title: 'Adjacent News API',
		version: 'v1',
	},
	openapi: '3.1.0'
})

// redirect to ui
app.get("/", c => c.redirect('/ui'));

// 404 for everything else
app.notFound(c => c.text('Not found', 404));

// --- Define the OpenAPI Schema ---
const NewsSchema = z.object({
	market: z.string().openapi({
		example: 'Will the winner of the 2024 USA presidential election win Pennsylvania?',
	})
})

const AllMarketsSchema = z.object({
	index: z.string().optional().openapi({
		example: '101'
	})
})
const MarketsByHeadline = z.object({
	headline: z.string().openapi({
		example: 'Will the winner of the 2024 USA presidential election win Pennsylvania?'
	})
})

// --- Define the OpenAPI Route ---
const newsRoute = createRoute({
	method: 'get',
	path: '/api/news/{market}',
	description: 'Get news articles for the given market',
	request: {
		params: NewsSchema,
	},
	responses: {
		200: {
			description: 'News articles for the given market',
			content: {
				'application/json': {
					schema: z.object({
						result: z.string()
					})
				}
			}
		}
	}
});

const allMarketsRoute = createRoute({
	method: 'get',
	path: '/api/markets/{index}',
	description: 'Get all markets, returns 100 at a time.',
	request: {
		params: AllMarketsSchema,
	},
	responses: {
		200: {
			description: 'Get All Markets',
			content: {
				'application/json': {
					schema: z.object({
						result: z.string()
					})
				}
			}
		}
	}
});

const marketsByHeadlineRoute = createRoute({
	method: 'get',
	path: '/api/markets/headline/{headline}',
	description: 'Get related markets by headline',
	request: {
		params: MarketsByHeadline,
	},
	responses: {
		200: {
			description: 'Get related markets by headline',
			content: {
				'application/json': {
					schema: z.object({
						result: z.string()
					})
				}
			}
		}
	}
});

// --- Consume the OpenAPI Routes ---
app.openapi(newsRoute, async (c) => {
	const exa = new Exa(c.env.EXA_API_KEY);

	// Retrieve the validated search parameters
	const { market } = c.req.param();

	// Get the current date and the date one week ago
	const endDate = new Date();
	const startDate = new Date();
	startDate.setDate(startDate.getDate() - 7);

	// Fetch news for the given market
	const results = await exa.search(market, {
		  type: "neural",
		  useAutoprompt: true,
		  numResults: 10,
		//   text: {
		// 	includeHtmlTags: true
		//   }// use to enable text content
		  category: "news",
		  startCrawlDate: startDate.toISOString(),
		  endCrawlDate: endDate.toISOString(),
		  startPublishedDate: startDate.toISOString(),
		  endPublishedDate: endDate.toISOString(),
		  excludeDomains: ["kalshi.com", "metaculus.com", "manifold.markets", "polymarket.com"]
	}).catch((error) => {
		c.status(500)
		return ["An error occurred while fetching news articles. Please try again later."];
	});

	// Return the results
	return c.json(results);
});

app.openapi(allMarketsRoute, async (c) => {
	const { index } = c.req.param();
	let number;
	if (!index) {
		number = 0;
	} else {
		number = parseInt(index);
	};

    const markets = await fetchAndCombineJsonFiles();
	const slicedMarkets = markets?.slice(number, number + 100);

    return c.json(slicedMarkets);
});

function formatMarketTitle(title) {
    return title
        .replace(/-/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, l => l.toUpperCase());
}

app.openapi(marketsByHeadlineRoute, async (c) => {
	const { headline } = c.req.param();
    const markets = await fetchAndCombineJsonFiles();

	const similarMarkets = markets?.filter(market => {  
		const formattedMarketTitle = formatMarketTitle(market.Question.Title);
		const similarity = stringSimilarity(headline, formattedMarketTitle, 1);
		return similarity > 0.90; // adjust this threshold as needed
	});

    return c.json(similarMarkets?.length > 0 ? similarMarkets?.slice(0, 3) : "No related markets. Explore at https://data.adj.news");
});

export default app;