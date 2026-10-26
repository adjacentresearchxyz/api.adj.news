import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	aggregateOhlc,
	easternMidnightUtc,
	mergeLevelPrints,
	pageCandles,
} from './ohlc.ts';
import type { LevelPrint } from './types.ts';

/** Prints inside two UTC hours, plus a point exactly on the later boundary. */
const SERIES: LevelPrint[] = [
	{ timestamp: '2026-10-26T12:10:00Z', price: 10 },
	{ timestamp: '2026-10-26T12:40:00Z', price: 14 },
	{ timestamp: '2026-10-26T12:55:00Z', price: 9 },
	{ timestamp: '2026-10-26T13:05:00Z', price: 11 },
	{ timestamp: '2026-10-26T13:50:00Z', price: 12 },
	{ timestamp: '2026-10-26T14:00:00Z', price: 18 },
];

const WIDE = { fromMs: Date.parse('2026-10-26T00:00:00Z'), toMs: Date.parse('2026-10-27T00:00:00Z') };

test('known series buckets into OHLC and skips the empty hour', () => {
	const candles = aggregateOhlc(SERIES, '1hour', WIDE, 'asc');
	assert.deepEqual(candles, [
		{ timestamp: '2026-10-26T13:00:00Z', open: 10, high: 14, low: 9, close: 9 },
		{ timestamp: '2026-10-26T14:00:00Z', open: 11, high: 12, low: 11, close: 12 },
		{ timestamp: '2026-10-26T15:00:00Z', open: 18, high: 18, low: 18, close: 18 },
	]);
	for (const candle of candles) {
		assert.equal(Object.prototype.hasOwnProperty.call(candle, 'volume'), false);
		assert.ok(candle.high >= candle.open && candle.high >= candle.close && candle.high >= candle.low);
		assert.ok(candle.low <= candle.open && candle.low <= candle.close && candle.low <= candle.high);
	}
});

test('a print on a bucket boundary opens the next candle', () => {
	const candles = aggregateOhlc(
		[{ timestamp: '2026-10-26T13:00:00Z', price: 5 }],
		'1hour',
		WIDE,
		'asc',
	);
	assert.equal(candles.length, 1);
	assert.equal(candles[0].timestamp, '2026-10-26T14:00:00Z');
	assert.equal(candles[0].open, 5);
	assert.equal(candles[0].close, 5);
});

test('from is inclusive and to is exclusive on the bucket end', () => {
	const candles = aggregateOhlc(SERIES, '1hour', {
		fromMs: Date.parse('2026-10-26T14:00:00Z'),
		toMs: Date.parse('2026-10-26T15:00:00Z'),
	});
	assert.deepEqual(candles.map((candle) => candle.timestamp), ['2026-10-26T14:00:00Z']);
});

test('5min candles keep only buckets that contain a print', () => {
	const candles = aggregateOhlc(SERIES, '5min', WIDE, 'asc');
	assert.deepEqual(
		candles.map((candle) => candle.timestamp),
		[
			'2026-10-26T12:15:00Z',
			'2026-10-26T12:45:00Z',
			'2026-10-26T13:00:00Z',
			'2026-10-26T13:10:00Z',
			'2026-10-26T13:55:00Z',
			'2026-10-26T14:05:00Z',
		],
	);
	assert.deepEqual(candles[0], {
		timestamp: '2026-10-26T12:15:00Z',
		open: 10,
		high: 10,
		low: 10,
		close: 10,
	});
});

test('daily candles use US Eastern midnights and stamp the bucket end', () => {
	const points: LevelPrint[] = [
		{ timestamp: '2026-10-25T04:00:00Z', price: 100 },
		{ timestamp: '2026-10-25T16:00:00Z', price: 110 },
		{ timestamp: '2026-10-25T23:00:00Z', price: 90 },
		{ timestamp: '2026-10-26T04:00:00Z', price: 95 },
	];
	const candles = aggregateOhlc(
		points,
		'1d',
		{ fromMs: Date.parse('2026-10-25T00:00:00Z'), toMs: Date.parse('2026-10-28T00:00:00Z') },
		'asc',
	);
	assert.deepEqual(candles, [
		{ timestamp: '2026-10-26T04:00:00Z', open: 100, high: 110, low: 90, close: 90 },
		{ timestamp: '2026-10-27T04:00:00Z', open: 95, high: 95, low: 95, close: 95 },
	]);
});

test('Eastern midnight follows the DST transitions', () => {
	// 2026-03-08 is the spring-forward. Midnight that morning is still EST (05:00Z).
	assert.equal(new Date(easternMidnightUtc({ y: 2026, m: 3, d: 8 })).toISOString(), '2026-03-08T05:00:00.000Z');
	// The next midnight is EDT (04:00Z).
	assert.equal(new Date(easternMidnightUtc({ y: 2026, m: 3, d: 9 })).toISOString(), '2026-03-09T04:00:00.000Z');
	// 2026-11-01 is the fall-back. Midnight that morning is still EDT (04:00Z).
	assert.equal(new Date(easternMidnightUtc({ y: 2026, m: 11, d: 1 })).toISOString(), '2026-11-01T04:00:00.000Z');
	assert.equal(new Date(easternMidnightUtc({ y: 2026, m: 11, d: 2 })).toISOString(), '2026-11-02T05:00:00.000Z');

	const spring = aggregateOhlc(
		[
			{ timestamp: '2026-03-08T04:30:00Z', price: 1 },
			{ timestamp: '2026-03-08T05:30:00Z', price: 2 },
		],
		'1d',
		{ fromMs: Date.parse('2026-03-07T00:00:00Z'), toMs: Date.parse('2026-03-10T00:00:00Z') },
		'asc',
	);
	assert.deepEqual(
		spring.map((candle) => [candle.timestamp, candle.close]),
		[
			['2026-03-08T05:00:00Z', 1],
			['2026-03-09T04:00:00Z', 2],
		],
	);
});

test('equal timestamps keep input order for open and close', () => {
	const candles = aggregateOhlc(
		[
			{ timestamp: '2026-10-26T12:10:00Z', price: 3 },
			{ timestamp: '2026-10-26T12:10:00Z', price: 7 },
		],
		'1hour',
		WIDE,
		'asc',
	);
	assert.equal(candles[0].open, 3);
	assert.equal(candles[0].close, 7);
	assert.equal(candles[0].high, 7);
	assert.equal(candles[0].low, 3);
});

test('empty history and unusable rows produce no candles', () => {
	assert.deepEqual(aggregateOhlc([], '1hour', WIDE), []);
	assert.deepEqual(
		aggregateOhlc([{ timestamp: 'not-a-time', price: 1 }, { timestamp: '2026-10-26T12:00:00Z', price: Number.NaN }], '1hour', WIDE),
		[],
	);
});

test('daily prints fill only Eastern days the finer series missed', () => {
	const merged = mergeLevelPrints(
		[
			{ timestamp: '2026-10-25T16:00:00Z', price: 10 },
			{ timestamp: '2026-10-25T20:00:00Z', price: 30 },
		],
		[
			{ timestamp: '2026-10-25T04:00:00Z', price: 99 },
			{ timestamp: '2026-10-20T04:00:00Z', price: 50 },
		],
	);
	const candles = aggregateOhlc(
		merged,
		'1d',
		{ fromMs: Date.parse('2026-10-20T00:00:00Z'), toMs: Date.parse('2026-10-27T00:00:00Z') },
		'asc',
	);
	assert.deepEqual(candles, [
		{ timestamp: '2026-10-21T04:00:00Z', open: 50, high: 50, low: 50, close: 50 },
		{ timestamp: '2026-10-26T04:00:00Z', open: 10, high: 30, low: 10, close: 30 },
	]);
});

test('pagination uses the list envelope and an empty page still reports one total page', () => {
	const candles = aggregateOhlc(SERIES, '1hour', WIDE, 'desc');
	const page = pageCandles(candles, 2, 2);
	assert.equal(page.data.length, 1);
	assert.equal(page.data[0].timestamp, '2026-10-26T13:00:00Z');
	assert.deepEqual(page.meta, {
		total: 3,
		page: 2,
		per_page: 2,
		total_pages: 2,
		has_next: false,
		has_prev: true,
	});
	assert.deepEqual(pageCandles([], 1, 100).meta, {
		total: 0,
		page: 1,
		per_page: 100,
		total_pages: 1,
		has_next: false,
		has_prev: false,
	});
});
