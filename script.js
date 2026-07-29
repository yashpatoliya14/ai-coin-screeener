/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AI Coin Screener — All-in-One Script (Auto-runs every 4 hours)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 *  A standalone script that fetches all Delta Exchange futures symbols,
 *  calculates technical indicators (200 EMA, Supertrend, ChoCH), and
 *  classifies coins as bearish or bullish.
 * 
 *  - Runs immediately on start, then repeats every 4 hours
 *  - Sends desktop notifications with summary after each scan
 *  - Saves results to logs/ directory
 * 
 *  Usage:  node script.js
 *  Stop:   Ctrl+C
 * ═══════════════════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.india.delta.exchange/v2';
const SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
const LOGS_DIR = path.join(__dirname, 'logs');


// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 1: DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch helper with automatic retries and exponential backoff
 */
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (err) {
            if (i === retries - 1) throw err;
            console.log(`      ⚠️ Fetch failed (${err.message}). Retrying in ${delay}ms... (${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // exponential backoff
        }
    }
}

/**
 * Fetch all live futures/perpetual symbols from Delta Exchange
 * @returns {Promise<string[]>} Array of trading symbols
 */
async function fetchSymbols() {
    const response = await fetchWithRetry(`${BASE_URL}/products`);
    const data = await response.json();
    const products = data.result;
    const futuresSymbols = products
        .filter(p =>
            ["perpetual_futures", "futures"].includes(p.contract_type) &&
            p.state === "live" &&
            p.trading_status === "operational"
        )
        .map(p => p.symbol);
    return futuresSymbols;
}

async function fetchCandlesForSymbol(symbol, resolution = '1h', start, end) {
    const response = await fetchWithRetry(
        `${BASE_URL}/history/candles?symbol=${symbol}&resolution=${resolution}&start=${start}&end=${end}`
    );
    const data = await response.json();
    return data.result || [];
}


// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 2: TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── EMA (Exponential Moving Average) ────────────────────────────────────────

/**
 * Calculate Exponential Moving Average
 * @param {number[]} closes - Array of closing prices (oldest first)
 * @param {number} period - EMA period (e.g. 200)
 * @returns {number[]} Array of EMA values (same length as closes, first `period-1` are null)
 */
function calculateEMA(closes, period) {
    if (closes.length < period) return closes.map(() => null);

    const k = 2 / (period + 1);
    const emaValues = new Array(closes.length).fill(null);

    // Seed with SMA of first `period` values
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += closes[i];
    }
    emaValues[period - 1] = sum / period;

    // Calculate EMA for remaining values
    for (let i = period; i < closes.length; i++) {
        emaValues[i] = closes[i] * k + emaValues[i - 1] * (1 - k);
    }

    return emaValues;
}

// ─── ATR (Average True Range) ────────────────────────────────────────────────

/**
 * Calculate Average True Range
 * @param {Array<{high: number, low: number, close: number}>} candles - OHLC candles (oldest first)
 * @param {number} period - ATR period (default 10)
 * @returns {number[]} Array of ATR values (same length as candles, first `period` are null)
 */
function calculateATR(candles, period = 10) {
    if (candles.length < period + 1) return candles.map(() => null);

    const trValues = new Array(candles.length).fill(null);
    const atrValues = new Array(candles.length).fill(null);

    // First TR is just high - low (no previous close)
    trValues[0] = candles[0].high - candles[0].low;

    // Calculate True Range for each candle
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;

        trValues[i] = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
    }

    // First ATR = SMA of first `period` TR values
    let atrSum = 0;
    for (let i = 0; i < period; i++) {
        atrSum += trValues[i];
    }
    atrValues[period - 1] = atrSum / period;

    // Smoothed ATR (Wilder's smoothing)
    for (let i = period; i < candles.length; i++) {
        atrValues[i] = (atrValues[i - 1] * (period - 1) + trValues[i]) / period;
    }

    return atrValues;
}

// ─── SUPERTREND ──────────────────────────────────────────────────────────────

/**
 * Calculate Supertrend indicator
 * @param {Array<{high: number, low: number, close: number}>} candles - OHLC candles (oldest first)
 * @param {number} period - ATR period (default 10)
 * @param {number} multiplier - ATR multiplier (default 3)
 * @returns {Array<{value: number, direction: number}|null>}
 *   direction: 1 = bullish, -1 = bearish
 */
function calculateSupertrend(candles, period = 10, multiplier = 3) {
    const atrValues = calculateATR(candles, period);
    const result = new Array(candles.length).fill(null);

    let prevFinalUpper = 0;
    let prevFinalLower = 0;
    let prevSupertrend = 0;
    let prevDirection = 1;

    for (let i = 0; i < candles.length; i++) {
        if (atrValues[i] === null) continue;

        const { high, low, close } = candles[i];
        const atr = atrValues[i];
        const hl2 = (high + low) / 2;

        // Basic bands
        const basicUpper = hl2 + multiplier * atr;
        const basicLower = hl2 - multiplier * atr;

        // Final upper band: only decreases (or resets when close breaks above it)
        let finalUpper;
        if (prevFinalUpper === 0) {
            finalUpper = basicUpper;
        } else {
            finalUpper = (basicUpper < prevFinalUpper || candles[i - 1].close > prevFinalUpper)
                ? basicUpper
                : prevFinalUpper;
        }

        // Final lower band: only increases (or resets when close breaks below it)
        let finalLower;
        if (prevFinalLower === 0) {
            finalLower = basicLower;
        } else {
            finalLower = (basicLower > prevFinalLower || candles[i - 1].close < prevFinalLower)
                ? basicLower
                : prevFinalLower;
        }

        // Determine direction
        let direction;
        let supertrendValue;

        if (prevSupertrend === 0) {
            direction = close > finalUpper ? 1 : -1;
        } else if (prevDirection === 1) {
            direction = close < finalLower ? -1 : 1;
        } else {
            direction = close > finalUpper ? 1 : -1;
        }

        supertrendValue = direction === 1 ? finalLower : finalUpper;

        result[i] = { value: supertrendValue, direction };

        prevFinalUpper = finalUpper;
        prevFinalLower = finalLower;
        prevSupertrend = supertrendValue;
        prevDirection = direction;
    }

    return result;
}

// ─── SWING POINTS (Fractal Detection) ───────────────────────────────────────

/**
 * Find swing highs and swing lows using fractal detection
 * A swing high has a high greater than N candles on each side
 * A swing low has a low less than N candles on each side
 *
 * @param {Array<{high: number, low: number, close: number, time: number}>} candles
 * @param {number} lookback - Number of candles on each side to confirm (default 5)
 * @returns {{ swingHighs: Array, swingLows: Array }}
 */
function findSwingPoints(candles, lookback = 5) {
    const swingHighs = [];
    const swingLows = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
        let isSwingHigh = true;
        let isSwingLow = true;

        for (let j = 1; j <= lookback; j++) {
            if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
                isSwingHigh = false;
            }
            if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
                isSwingLow = false;
            }
            if (!isSwingHigh && !isSwingLow) break;
        }

        if (isSwingHigh) {
            swingHighs.push({ index: i, price: candles[i].high, time: candles[i].time });
        }
        if (isSwingLow) {
            swingLows.push({ index: i, price: candles[i].low, time: candles[i].time });
        }
    }

    return { swingHighs, swingLows };
}

// ─── CHANGE OF CHARACTER (ChoCH) ────────────────────────────────────────────

/**
 * Detect Change of Character (ChoCH)
 *
 * - Bearish ChoCH: In an uptrend (HH + HL), price closes below the most recent Higher Low
 * - Bullish ChoCH: In a downtrend (LH + LL), price closes above the most recent Lower High
 *
 * @param {Array<{high: number, low: number, close: number, time: number}>} candles
 * @param {number} lookback - Swing point lookback (default 5)
 * @returns {{ type: string, level: number, detectedAt: number, detectedIndex: number }|null}
 */
function detectChoCH(candles, lookback = 5) {
    const { swingHighs, swingLows } = findSwingPoints(candles, lookback);

    if (swingHighs.length < 2 || swingLows.length < 2) return null;

    // Merge swing points into a single timeline sorted by index
    const allSwings = [];
    for (const sh of swingHighs) {
        allSwings.push({ ...sh, type: 'high' });
    }
    for (const sl of swingLows) {
        allSwings.push({ ...sl, type: 'low' });
    }
    allSwings.sort((a, b) => a.index - b.index);

    // Determine market structure by tracking HH/HL and LH/LL patterns
    let lastHigh = null;
    let lastLow = null;
    let trend = null;   // 'up' or 'down'
    let keyLevel = null;
    let keyLevelType = null; // 'HL' or 'LH'

    for (const swing of allSwings) {
        if (swing.type === 'high') {
            if (lastHigh !== null) {
                if (swing.price > lastHigh.price) {
                    if (trend === 'up' || trend === null) {
                        trend = 'up';
                    }
                } else {
                    if (trend === 'down' || trend === null) {
                        trend = 'down';
                        keyLevel = swing;
                        keyLevelType = 'LH';
                    }
                }
            }
            lastHigh = swing;
        } else {
            if (lastLow !== null) {
                if (swing.price < lastLow.price) {
                    if (trend === 'down' || trend === null) {
                        trend = 'down';
                    }
                } else {
                    if (trend === 'up' || trend === null) {
                        trend = 'up';
                        keyLevel = swing;
                        keyLevelType = 'HL';
                    }
                }
            }
            lastLow = swing;
        }
    }

    if (!keyLevel) return null;

    // Check recent candles (after last swing) for a structural break
    const lastSwingIndex = allSwings[allSwings.length - 1].index;
    const checkFrom = lastSwingIndex + 1;

    // Bearish ChoCH: uptrend, price breaks below the most recent Higher Low
    if (trend === 'up' && keyLevelType === 'HL') {
        const recentHL = keyLevel;
        for (let i = checkFrom; i < candles.length; i++) {
            if (candles[i].close < recentHL.price) {
                return {
                    type: 'bearish',
                    level: recentHL.price,
                    detectedAt: candles[i].time,
                    detectedIndex: i
                };
            }
        }
    }

    // Bullish ChoCH: downtrend, price breaks above the most recent Lower High
    if (trend === 'down' && keyLevelType === 'LH') {
        const recentLH = keyLevel;
        for (let i = checkFrom; i < candles.length; i++) {
            if (candles[i].close > recentLH.price) {
                return {
                    type: 'bullish',
                    level: recentLH.price,
                    detectedAt: candles[i].time,
                    detectedIndex: i
                };
            }
        }
    }

    return null;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 3: ANALYSIS & CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run all 3 indicators on a symbol's candle data and return classification
 *
 * Classification logic (2-of-3 signal agreement):
 *   strong_bearish  → all 3 signals bearish
 *   bearish         → 2 of 3 signals bearish
 *   neutral         → mixed signals
 *   bullish         → 2 of 3 signals bullish
 *   strong_bullish  → all 3 signals bullish
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

    // ── Classification ──
    let classification = 'neutral';
    const signals = {
        emaSignal: priceVsEma === 'below' ? 'bearish' : 'bullish',
        supertrendSignal: supertrendDirection,
        chochSignal: choch ? choch.type : 'none'
    };

    const bearishCount = Object.values(signals).filter(s => s === 'bearish').length;
    const bullishCount = Object.values(signals).filter(s => s === 'bullish').length;

    if (bearishCount >= 2) classification = 'bearish';
    else if (bullishCount >= 2) classification = 'bullish';

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


// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 4: MAIN — SCREEN ALL SYMBOLS
// ═══════════════════════════════════════════════════════════════════════════════

async function screenAllSymbols() {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  AI Coin Screener — Scanning all symbols...');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');

    // 1. Fetch all live futures symbols
    console.log('[1/3] Fetching symbols from Delta Exchange...');
    const symbols = await fetchSymbols();
    console.log(`      Found ${symbols.length} live futures symbols.\n`);

    // 2. Fetch 30-day 1h candle data & analyze each symbol
    const end = Math.floor(Date.now() / 1000);
    const start = end - (30 * 24 * 60 * 60); // 30 days ago

    const results = {
        strong_bearish: [],
        bearish: [],
        neutral: [],
        bullish: [],
        strong_bullish: [],
        insufficient_data: []
    };

    console.log('[2/3] Fetching candles & running indicators (EMA-200, Supertrend, ChoCH)...');
    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        try {
            process.stdout.write(`      (${i + 1}/${symbols.length}) ${symbol}...`);
            const candles = await fetchCandlesForSymbol(symbol, '1h', start, end);

            if (!candles || candles.length === 0) {
                results.insufficient_data.push({ symbol, error: 'No candle data' });
                process.stdout.write(' ⚠ no data\n');
                continue;
            }

            const analysis = analyzeSymbol(symbol, candles);
            results[analysis.classification].push(analysis);

            const icon = {
                strong_bearish: '🔴🔴',
                bearish: '🔴',
                neutral: '⚪',
                bullish: '🟢',
                strong_bullish: '🟢🟢',
                insufficient_data: '⚠'
            }[analysis.classification] || '?';

            process.stdout.write(` ${icon} ${analysis.classification}\n`);
        } catch (err) {
            results.insufficient_data.push({ symbol, error: err.message });
            process.stdout.write(` ❌ error: ${err.message}\n`);
        }

        // Rate limit: 50ms between requests
        if (i < symbols.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    // 3. Print summary
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SCREENING RESULTS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log(`  🔴🔴 Strong Bearish:  ${results.strong_bearish.length}`);
    console.log(`  🔴   Bearish:         ${results.bearish.length}`);
    console.log(`  ⚪   Neutral:         ${results.neutral.length}`);
    console.log(`  🟢   Bullish:         ${results.bullish.length}`);
    console.log(`  🟢🟢 Strong Bullish:  ${results.strong_bullish.length}`);
    console.log(`  ⚠    Insufficient:    ${results.insufficient_data.length}`);
    console.log('');

    // Print strong bearish coins
    if (results.strong_bearish.length > 0) {
        console.log('───────────────────────────────────────────────────────────');
        console.log('  🔴🔴 STRONG BEARISH COINS (all 3 signals bearish)');
        console.log('───────────────────────────────────────────────────────────');
        for (const coin of results.strong_bearish) {
            console.log(`  ${coin.symbol.padEnd(20)} Price: ${coin.currentPrice}  |  EMA200: ${coin.ema200}  |  ST: ${coin.supertrendDirection}  |  ChoCH: ${coin.choch?.type || 'none'}`);
        }
        console.log('');
    }

    // Print bearish coins
    if (results.bearish.length > 0) {
        console.log('───────────────────────────────────────────────────────────');
        console.log('  🔴 BEARISH COINS (2 of 3 signals bearish)');
        console.log('───────────────────────────────────────────────────────────');
        for (const coin of results.bearish) {
            console.log(`  ${coin.symbol.padEnd(20)} Price: ${coin.currentPrice}  |  EMA200: ${coin.ema200}  |  ST: ${coin.supertrendDirection}  |  ChoCH: ${coin.choch?.type || 'none'}`);
        }
        console.log('');
    }

    // Print strong bullish coins
    if (results.strong_bullish.length > 0) {
        console.log('───────────────────────────────────────────────────────────');
        console.log('  🟢🟢 STRONG BULLISH COINS (all 3 signals bullish)');
        console.log('───────────────────────────────────────────────────────────');
        for (const coin of results.strong_bullish) {
            console.log(`  ${coin.symbol.padEnd(20)} Price: ${coin.currentPrice}  |  EMA200: ${coin.ema200}  |  ST: ${coin.supertrendDirection}  |  ChoCH: ${coin.choch?.type || 'none'}`);
        }
        console.log('');
    }

    // Print bullish coins
    if (results.bullish.length > 0) {
        console.log('───────────────────────────────────────────────────────────');
        console.log('  🟢 BULLISH COINS (2 of 3 signals bullish)');
        console.log('───────────────────────────────────────────────────────────');
        for (const coin of results.bullish) {
            console.log(`  ${coin.symbol.padEnd(20)} Price: ${coin.currentPrice}  |  EMA200: ${coin.ema200}  |  ST: ${coin.supertrendDirection}  |  ChoCH: ${coin.choch?.type || 'none'}`);
        }
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Scan completed at ${new Date().toLocaleString()}`);
    console.log('═══════════════════════════════════════════════════════════');

    return results;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 5: NOTIFICATIONS & LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a message via Telegram Bot API
 */
async function sendTelegramMessage(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId || token === 'your_bot_token_here' || chatId === 'your_chat_id_here') {
        console.log('⚠️ Telegram configuration missing or using placeholders in .env. Skipping Telegram alert.');
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML'
            })
        });
        const data = await response.json();
        if (!data.ok) {
            console.error('❌ Telegram Bot API Error:', data.description);
        } else {
            console.log('📤 Telegram notification sent successfully!');
        }
    } catch (err) {
        console.error('❌ Failed to send Telegram notification:', err.message);
    }
}

/**
 * Save screening results to a JSON log file
 */
function saveResultsLog(results) {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `scan_${timestamp}.json`;
    const filepath = path.join(LOGS_DIR, filename);

    const logData = {
        scanTime: new Date().toISOString(),
        summary: {
            strong_bearish: results.strong_bearish.length,
            bearish: results.bearish.length,
            neutral: results.neutral.length,
            bullish: results.bullish.length,
            strong_bullish: results.strong_bullish.length,
            insufficient_data: results.insufficient_data.length
        },
        strong_bearish: results.strong_bearish.map(c => c.symbol),
        strong_bullish: results.strong_bullish.map(c => c.symbol),
        bearish: results.bearish.map(c => c.symbol),
        bullish: results.bullish.map(c => c.symbol),
        fullResults: results
    };

    fs.writeFileSync(filepath, JSON.stringify(logData, null, 2));
    console.log(`  📁 Results saved to: ${filepath}`);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 6: SCHEDULER — RUN EVERY 4 HOURS
// ═══════════════════════════════════════════════════════════════════════════════

let scanCount = 0;

async function runScan() {
    scanCount++;
    const scanLabel = `Scan #${scanCount}`;

    try {
        console.log(`\n\n🕐 [${scanLabel}] Starting at ${new Date().toLocaleString()}...\n`);

        const results = await screenAllSymbols();

        // Build and Send Telegram message
        let telegramMessage = `<b>📊 AI Coin Screener - Scan #${scanCount}</b>\n`;
        telegramMessage += `🕒 <i>${new Date().toLocaleString()}</i>\n\n`;
        telegramMessage += `🔴🔴 Strong Bearish: <b>${results.strong_bearish.length}</b>\n`;
        telegramMessage += `🔴 Bearish: <b>${results.bearish.length}</b>\n`;
        telegramMessage += `🟢 Bullish: <b>${results.bullish.length}</b>\n`;
        telegramMessage += `🟢🟢 Strong Bullish: <b>${results.strong_bullish.length}</b>\n`;
        telegramMessage += `⚠️ Insufficient: <b>${results.insufficient_data.length}</b>\n\n`;

        if (results.strong_bullish.length > 0) {
            telegramMessage += `<b>🟢🟢 STRONG BULLISH COINS:</b>\n`;
            results.strong_bullish.slice(0, 15).forEach(c => {
                telegramMessage += `• <code>${c.symbol}</code> (Price: ${c.currentPrice})\n`;
            });
            if (results.strong_bullish.length > 15) {
                telegramMessage += `...and ${results.strong_bullish.length - 15} more\n`;
            }
            telegramMessage += `\n`;
        }

        if (results.strong_bearish.length > 0) {
            telegramMessage += `<b>🔴🔴 STRONG BEARISH COINS:</b>\n`;
            results.strong_bearish.slice(0, 15).forEach(c => {
                telegramMessage += `• <code>${c.symbol}</code> (Price: ${c.currentPrice})\n`;
            });
            if (results.strong_bearish.length > 15) {
                telegramMessage += `...and ${results.strong_bearish.length - 15} more\n`;
            }
            telegramMessage += `\n`;
        }

        await sendTelegramMessage(telegramMessage);

        // Save results log
        saveResultsLog(results);

        // Print next scan time
        const nextScan = new Date(Date.now() + SCAN_INTERVAL_MS);
        console.log('');
        console.log(`  ⏰ Next scan at: ${nextScan.toLocaleString()} (in 4 hours)`);
        console.log('  💡 Press Ctrl+C to stop the scheduler.');
        console.log('');

    } catch (err) {
        console.error(`\n❌ [${scanLabel}] Fatal error:`, err.message);
        await sendTelegramMessage(`❌ <b>Coin Screener ERROR [${scanLabel}]</b>\n\nError: <code>${err.message}</code>`);
    }
}

// ─── START ───────────────────────────────────────────────────────────────────

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  AI Coin Screener — 4-Hour Scheduler');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Started at:    ${new Date().toLocaleString()}`);
console.log(`  Scan interval: Every 4 hours`);
console.log(`  Logs saved to: ${LOGS_DIR}`);
console.log('  Press Ctrl+C to stop.');
console.log('═══════════════════════════════════════════════════════════');

// Run immediately on start
runScan();

// Then repeat every 4 hours
const intervalId = setInterval(runScan, SCAN_INTERVAL_MS);

// Graceful shutdown on Ctrl+C
process.on('SIGINT', () => {
    console.log('\n\n👋 Scheduler stopped. Total scans completed: ' + scanCount);
    clearInterval(intervalId);
    process.exit(0);
});
