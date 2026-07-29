/**
 * Screener Service
 * 
 * Orchestrates fetching candle data and running all technical indicators
 * to classify coins as bearish, bullish, or neutral.
 */

const { fetchSymbols, fetchCandlesForSymbol } = require('./fetchSymbolsService');
const {
    calculateEMA,
    calculateSupertrend,
    detectChoCH
} = require('./indicatorsService');

// ─── ANALYZE A SINGLE SYMBOL ─────────────────────────────────────────────────

/**
 * Run all 3 indicators on a symbol's candle data and return classification
 * 
 * @param {string} symbol - The trading symbol
 * @param {Array<{open: number, high: number, low: number, close: number, time: number, volume: number}>} candles - OHLCV data (oldest first)
 * @param {Object} params - Indicator parameters
 * @param {number} params.emaPeriod - EMA period (default 200)
 * @param {number} params.supertrendPeriod - Supertrend ATR period (default 10)
 * @param {number} params.supertrendMultiplier - Supertrend multiplier (default 3)
 * @param {number} params.chochLookback - ChoCH swing lookback (default 5)
 * @returns {Object} Analysis result with classification
 */
function analyzeSymbol(symbol, candles, params = {}) {
    const {
        emaPeriod = 200,
        supertrendPeriod = 10,
        supertrendMultiplier = 3,
        chochLookback = 5
    } = params;

    if (!candles || candles.length < emaPeriod) {
        return {
            symbol,
            classification: 'insufficient_data',
            error: `Need at least ${emaPeriod} candles, got ${candles ? candles.length : 0}`
        };
    }

    // Sort candles oldest-first (ascending by time)
    const sorted = [...candles].sort((a, b) => a.time - b.time);

    const closes = sorted.map(c => c.close);
    const latestCandle = sorted[sorted.length - 1];
    const currentPrice = latestCandle.close;

    // ── 1. Calculate 200 EMA ──
    const emaValues = calculateEMA(closes, emaPeriod);
    const currentEMA = emaValues[emaValues.length - 1];
    const priceVsEma = currentPrice > currentEMA ? 'above' : 'below';

    // ── 2. Calculate Supertrend ──
    const supertrendValues = calculateSupertrend(sorted, supertrendPeriod, supertrendMultiplier);
    const latestSupertrend = supertrendValues[supertrendValues.length - 1];
    const supertrendDirection = latestSupertrend ? (latestSupertrend.direction === 1 ? 'bullish' : 'bearish') : 'unknown';
    const supertrendValue = latestSupertrend ? latestSupertrend.value : null;

    // ── 3. Detect Change of Character ──
    const choch = detectChoCH(sorted, chochLookback);

    // ── CLASSIFICATION LOGIC ──
    // Bearish: Supertrend negative + below 200 EMA + bearish ChoCH
    // Bullish: Supertrend positive + above 200 EMA + bullish ChoCH
    // Neutral: otherwise

    let classification = 'neutral';
    const signals = {
        emaSignal: priceVsEma === 'below' ? 'bearish' : 'bullish',
        supertrendSignal: supertrendDirection,
        chochSignal: choch ? choch.type : 'none'
    };

    // Count bearish and bullish signals
    const bearishCount = Object.values(signals).filter(s => s === 'bearish').length;
    const bullishCount = Object.values(signals).filter(s => s === 'bullish').length;

    if (bearishCount >= 2) {
        classification = 'bearish';
    } else if (bullishCount >= 2) {
        classification = 'bullish';
    }

    // If all 3 agree, mark as strong
    if (bearishCount === 3) classification = 'strong_bearish';
    if (bullishCount === 3) classification = 'strong_bullish';

    return {
        symbol,
        classification,
        currentPrice,
        ema200: currentEMA ? parseFloat(currentEMA.toFixed(4)) : null,
        priceVsEma,
        supertrendDirection,
        supertrendValue: supertrendValue ? parseFloat(supertrendValue.toFixed(4)) : null,
        choch: choch ? {
            type: choch.type,
            level: parseFloat(choch.level.toFixed(4)),
            detectedAt: choch.detectedAt
        } : null,
        signals,
        candleCount: sorted.length
    };
}

// ─── SCREEN ALL SYMBOLS ──────────────────────────────────────────────────────

/**
 * Fetch all symbols, get their candle data, and run analysis
 * Returns classified results grouped by bearish/bullish/neutral
 * 
 * @param {Object} params - Indicator parameters (passed to analyzeSymbol)
 * @returns {Promise<{ bearish: Array, bullish: Array, neutral: Array, errors: Array, meta: Object }>}
 */
async function screenAllSymbols(params = {}) {
    console.log('[Screener] Fetching symbols...');
    const symbols = await fetchSymbols();
    console.log(`[Screener] Found ${symbols.length} symbols. Fetching candle data...`);

    // 30-day lookback with 1h candles = ~720 candles (enough for 200 EMA)
    const end = Math.floor(Date.now() / 1000);
    const start = end - (30 * 24 * 60 * 60);

    const results = {
        strong_bearish: [],
        bearish: [],
        neutral: [],
        bullish: [],
        strong_bullish: [],
        insufficient_data: [],
        meta: {
            totalSymbols: symbols.length,
            resolution: '1h',
            lookbackDays: 30,
            analyzedAt: new Date().toISOString()
        }
    };

    // Process symbols with a small delay to avoid rate limiting
    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        try {
            console.log(`[Screener] (${i + 1}/${symbols.length}) Analyzing ${symbol}...`);
            const candles = await fetchCandlesForSymbol(symbol, '1h', start, end);

            if (!candles || candles.length === 0) {
                results.insufficient_data.push({ symbol, error: 'No candle data returned' });
                continue;
            }

            const analysis = analyzeSymbol(symbol, candles, params);
            results[analysis.classification].push(analysis);
        } catch (err) {
            console.error(`[Screener] Error analyzing ${symbol}:`, err.message);
            results.insufficient_data.push({ symbol, error: err.message });
        }

        // Rate limit: 50ms delay between requests
        if (i < symbols.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    console.log(`[Screener] Done. Strong Bearish: ${results.strong_bearish.length}, Bearish: ${results.bearish.length}, Neutral: ${results.neutral.length}, Bullish: ${results.bullish.length}, Strong Bullish: ${results.strong_bullish.length}`);

    return results;
}

module.exports = { analyzeSymbol, screenAllSymbols };
