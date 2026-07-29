require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express')

const { fetchSymbols, fetchPrices, fetchCandlesDataForAllSymbols } = require('./services/fetchSymbolsService')
const { screenAllSymbols } = require('./services/screenerService')
const app = express()

app.get('/get-all-symbols-price', async (req, res) => {
    const prices = await fetchPrices()
    res.send(prices)
})

app.get("/get-all-symbols-candleData", async (req,res)=>{
    const end = Math.floor(Date.now() / 1000); // current timestamp
    const start = end - (7 * 24 * 60 * 60); // 7 days ago
    const allCandlesData = await fetchCandlesDataForAllSymbols(start,end)
    res.send(allCandlesData)
})

// ─── SCREENER ENDPOINTS ──────────────────────────────────────────────────────

/**
 * GET /screen
 * Full screening results grouped by classification:
 * { strong_bearish, bearish, neutral, bullish, strong_bullish, insufficient_data, meta }
 */
app.get('/screen', async (req, res) => {
    try {
        const results = await screenAllSymbols()
        res.json(results)
    } catch (err) {
        console.error('[/screen] Error:', err.message)
        res.status(500).json({ error: 'Screening failed', details: err.message })
    }
})

/**
 * GET /screen/bearish
 * Returns only bearish + strong_bearish coins
 */
app.get('/screen/bearish', async (req, res) => {
    try {
        const results = await screenAllSymbols()
        res.json({
            count: results.strong_bearish.length + results.bearish.length,
            strong_bearish: results.strong_bearish,
            bearish: results.bearish,
            meta: results.meta
        })
    } catch (err) {
        console.error('[/screen/bearish] Error:', err.message)
        res.status(500).json({ error: 'Screening failed', details: err.message })
    }
})

/**
 * GET /screen/bullish
 * Returns only bullish + strong_bullish coins
 */
app.get('/screen/bullish', async (req, res) => {
    try {
        const results = await screenAllSymbols()
        res.json({
            count: results.strong_bullish.length + results.bullish.length,
            strong_bullish: results.strong_bullish,
            bullish: results.bullish,
            meta: results.meta
        })
    } catch (err) {
        console.error('[/screen/bullish] Error:', err.message)
        res.status(500).json({ error: 'Screening failed', details: err.message })
    }
})

app.listen(3000, () => {
    console.log('Coin Screener API listening on port 3000!')
})