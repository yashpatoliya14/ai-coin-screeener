/**
 * Technical Indicators Service
 * 
 * Pure calculation functions for:
 * - EMA (Exponential Moving Average)
 * - ATR (Average True Range)
 * - Supertrend
 * - Swing Point Detection (Fractals)
 * - Change of Character (ChoCH)
 */

// ─── EMA ─────────────────────────────────────────────────────────────────────

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

// ─── ATR ─────────────────────────────────────────────────────────────────────

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
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += trValues[i];
    }
    atrValues[period - 1] = sum / period;

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
 *   direction: 1 = bullish (price above supertrend), -1 = bearish (price below supertrend)
 */
function calculateSupertrend(candles, period = 10, multiplier = 3) {
    const atrValues = calculateATR(candles, period);
    const result = new Array(candles.length).fill(null);

    let prevFinalUpper = 0;
    let prevFinalLower = 0;
    let prevSupertrend = 0;
    let prevDirection = 1; // start assuming bullish

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
            // First calculation — guess from close vs bands
            direction = close > finalUpper ? 1 : -1;
        } else if (prevDirection === 1) {
            // Was bullish
            direction = close < finalLower ? -1 : 1;
        } else {
            // Was bearish
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

// ─── SWING POINTS ────────────────────────────────────────────────────────────

/**
 * Find swing highs and swing lows using fractal detection
 * A swing high has a high greater than N candles on each side
 * A swing low has a low less than N candles on each side
 * 
 * @param {Array<{high: number, low: number, close: number, time: number}>} candles - OHLC candles (oldest first)
 * @param {number} lookback - Number of candles on each side to confirm (default 5)
 * @returns {{ swingHighs: Array<{index: number, price: number, time: number}>, swingLows: Array<{index: number, price: number, time: number}> }}
 */
function findSwingPoints(candles, lookback = 5) {
    const swingHighs = [];
    const swingLows = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
        let isSwingHigh = true;
        let isSwingLow = true;

        for (let j = 1; j <= lookback; j++) {
            // Check left and right neighbors for swing high
            if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
                isSwingHigh = false;
            }
            // Check left and right neighbors for swing low
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
 * @param {Array<{high: number, low: number, close: number, time: number}>} candles - OHLC candles (oldest first)
 * @param {number} lookback - Swing point lookback (default 5)
 * @returns {{ type: string, level: number, detectedAt: number, detectedIndex: number }|null}
 *   type: 'bullish' or 'bearish', or null if no ChoCH detected
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
    let trend = null; // 'up' or 'down'
    let keyLevel = null; // the level that if broken confirms ChoCH
    let keyLevelType = null; // 'HL' or 'LH'

    for (const swing of allSwings) {
        if (swing.type === 'high') {
            if (lastHigh !== null) {
                if (swing.price > lastHigh.price) {
                    // Higher High — uptrend continuation
                    if (trend === 'up' || trend === null) {
                        trend = 'up';
                    }
                } else {
                    // Lower High — potential downtrend
                    if (trend === 'down' || trend === null) {
                        trend = 'down';
                        keyLevel = swing;
                        keyLevelType = 'LH';
                    }
                }
            }
            lastHigh = swing;
        } else {
            // swing low
            if (lastLow !== null) {
                if (swing.price < lastLow.price) {
                    // Lower Low — downtrend continuation
                    if (trend === 'down' || trend === null) {
                        trend = 'down';
                    }
                } else {
                    // Higher Low — potential uptrend
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

    // Now check recent candles (after the last swing point) for a break
    const lastSwingIndex = allSwings[allSwings.length - 1].index;
    const checkFrom = lastSwingIndex + 1;

    // Bearish ChoCH: uptrend, price breaks below the most recent Higher Low
    if (trend === 'up' && keyLevelType === 'HL') {
        // Find the most recent Higher Low
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

module.exports = {
    calculateEMA,
    calculateATR,
    calculateSupertrend,
    findSwingPoints,
    detectChoCH
};
