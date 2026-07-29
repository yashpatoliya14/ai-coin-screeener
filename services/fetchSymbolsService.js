const fetchSymbols = async () => {
    const response = await fetch("https://api.india.delta.exchange/v2/products")
    const data = await response.json()
    const products = data.result
    console.log(typeof products)
    const futuresSymbols = products
        .filter(p =>
            ["perpetual_futures", "futures"].includes(p.contract_type) &&
            p.state === "live" &&
            p.trading_status === "operational"
        )
        .map(p => p.symbol);
    return futuresSymbols
}

/*
 - fetch price for each symbol
*/


const fetchPrices = async () => {
    const futuresSymbols = await fetchSymbols()
    const prices = await Promise.all(futuresSymbols.map(async (symbol) => {
        const response = await fetch(`https://api.india.delta.exchange/v2/tickers/${symbol}`)
        const data = await response.json()
        const price = data.result.spot_price
        return { symbol, price}
    }))
    return prices
}

/**
 * Fetch candle data for a single symbol
 * @param {string} symbol - Trading symbol
 * @param {string} resolution - Candle resolution (e.g. '1h', '4h', '1d')
 * @param {number} start - Start timestamp (unix seconds)
 * @param {number} end - End timestamp (unix seconds)
 * @returns {Promise<Array<{open: number, high: number, low: number, close: number, time: number, volume: number}>>}
 */
const fetchCandlesForSymbol = async (symbol, resolution = '1h', start, end) => {
    const response = await fetch(
        `https://api.india.delta.exchange/v2/history/candles?symbol=${symbol}&resolution=${resolution}&start=${start}&end=${end}`
    )
    const data = await response.json()
    return data.result || []
}

const fetchCandlesDataForAllSymbols = async (start, end, resolution = '1h') => {
    console.log(start, end)
    const futuresSymbols = await fetchSymbols()
    const candlesData = await Promise.all(futuresSymbols.map(async (symbol) => {
        const candles = await fetchCandlesForSymbol(symbol, resolution, start, end)
        return { symbol, candles}
    }))
    return candlesData
}


module.exports = { fetchSymbols, fetchPrices, fetchCandlesForSymbol, fetchCandlesDataForAllSymbols }