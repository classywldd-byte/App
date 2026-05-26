import { CoinScanResult, Timeframe, Kline } from '../types';
import { calculateMA, analyzeCrossover, getOverallRating, IndicatorType } from './indicators';

// We support both direct browser fetches and proxy fallback
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';
const BINANCE_SPOT_BASE = 'https://api.binance.com';

// Cache for proxy path
const PROXY_BASE = '/api/binance';

/**
 * Perform a fetch with a timeout
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 6000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

/**
 * Safely fetch from Binance API, automatically trying direct fetch first, or falling back to proxy if it fails.
 */
async function binanceFetch(path: string, isFutures = true): Promise<any> {
  // 1. Try direct fetch to Binance first
  const directBase = isFutures ? BINANCE_FUTURES_BASE : BINANCE_SPOT_BASE;
  const directUrl = `${directBase}${path}`;

  try {
    const res = await fetchWithTimeout(directUrl);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    // Silent fail for direct fetch, it will fall back to proxy
  }

  // 2. Fallback: Query through our local express server proxy
  const proxyUrl = `${PROXY_BASE}?path=${encodeURIComponent(path)}&futures=${isFutures ? 'true' : 'false'}`;
  const res = await fetchWithTimeout(proxyUrl);
  if (res.ok) {
    return await res.json();
  }
  
  throw new Error(`Server proxy failed with status: ${res.status}`);
}

/**
 * Fetches the active top USDT pairs from Binance Futures, sorted by volume.
 */
export async function fetchTop100Symbols(): Promise<any[]> {
  try {
    // Fetch 24hr ticker from Binance Futures
    const tickers = await binanceFetch('/fapi/v1/ticker/24hr', true);
    
    // Filter active USDT contracts (exclude indices, quarters, and stablecoin mixtures if desired)
    // We only want standard USDT pairs (e.g., BTCUSDT, ETHUSDT) and make sure volume > 0
    const usdtPairs = tickers.filter((t: any) => 
      t.symbol.endsWith('USDT') && 
      !t.symbol.includes('_') && // exclude quarterly/delivery contracts e.g. BTCUSDT_260327
      parseFloat(t.quoteVolume) > 0
    );

    // Sort by 24h volume (quoteVolume) descending
    usdtPairs.sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

    // Return the top 100
    return usdtPairs.slice(0, 100);
  } catch (err) {
    console.warn('Failed to fetch from Futures API, trying Spot API tickers...', err);
    // If futures fetch completely fails, fallback to Spot ticker 24hr
    const spotTickers = await binanceFetch('/api/v3/ticker/24hr', false);
    const spotUsdtPairs = spotTickers.filter((t: any) => 
      t.symbol.endsWith('USDT') && 
      parseFloat(t.quoteVolume) > 0
    );
    spotUsdtPairs.sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    return spotUsdtPairs.slice(0, 100);
  }
}

/**
 * Fetches klines (candles) for a single symbol and timeframe
 */
export async function fetchSymbolData(symbol: string, interval: Timeframe, limit = 100): Promise<{ closes: number[], klines: Kline[] }> {
  const path = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const klines = await binanceFetch(path, true);
  
  // Index 1: O, 2: H, 3: L, 4: C, 5: V
  const formattedKlines = klines.map((k: any) => ({
    time: Math.floor(k[0] / 1000), // Convert ms to seconds for lightweight-charts
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  }));
  
  return {
    closes: formattedKlines.map(k => k.c),
    klines: formattedKlines,
  };
}

/**
 * Scan a single symbol's EMA crossings across all 6 timeframes
 */
export async function scanSingleSymbol(
  symbolData: any,
  timeframes: Timeframe[],
  indicatorType: IndicatorType = 'EMA'
): Promise<CoinScanResult | null> {
  const symbol = symbolData.symbol;
  const price = parseFloat(symbolData.lastPrice || symbolData.price || '0');
  const change24h = parseFloat(symbolData.priceChangePercent || '0');
  const volume24h = parseFloat(symbolData.quoteVolume || '0');
  
  const high = parseFloat(symbolData.highPrice || '0');
  const low = parseFloat(symbolData.lowPrice || '0');
  const volatility24h = low > 0 ? ((high - low) / low) * 100 : 0;

  const results: CoinScanResult['timeframes'] = {};

  // For each timeframe, fetch klines and compute indicators
  for (const interval of timeframes) {
    try {
      // Fetch closes
      const { closes } = await fetchSymbolData(symbol, interval, 100);
      if (closes.length < 56) {
        // Not enough candles to form EMAs
        continue;
      }

      // Calculate EMAs
      const ema9 = calculateMA(closes, 9, indicatorType);
      const ema18 = calculateMA(closes, 18, indicatorType);
      const ema27 = calculateMA(closes, 27, indicatorType);
      const ema36 = calculateMA(closes, 36, indicatorType);
      const ema45 = calculateMA(closes, 45, indicatorType);
      const ema56 = calculateMA(closes, 56, indicatorType);

      // Detect state and crossover
      const cross9_18 = analyzeCrossover(ema9, ema18);
      const cross27_36 = analyzeCrossover(ema27, ema36);
      const cross45_56 = analyzeCrossover(ema45, ema56);

      // Overall timeframe rating
      const overallRating = getOverallRating(
        cross9_18.value,
        cross27_36.value,
        cross45_56.value
      );

      results[interval] = {
        ema9: ema9[ema9.length - 1],
        ema18: ema18[ema18.length - 1],
        ema27: ema27[ema27.length - 1],
        ema36: ema36[ema36.length - 1],
        ema45: ema45[ema45.length - 1],
        ema56: ema56[ema56.length - 1],
        cross9_18,
        cross27_36,
        cross45_56,
        overallRating,
      };
    } catch (e) {
      // Skip this timeframe but don't break the entire symbol
    }
  }

  // If we could not scan any timeframe, return null
  if (Object.keys(results).length === 0) {
    return null;
  }

  return {
    symbol,
    name: symbol.replace('USDT', ''), // Clean display name, e.g. BTCUSDT -> BTC
    price,
    change24h,
    volume24h,
    volatility24h,
    timeframes: results,
  };
}
