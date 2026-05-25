/**
 * EMA mathematical calculation:
 * EMA_t = (Price_t * alpha) + (EMA_{t-1} * (1 - alpha))
 * where alpha = 2 / (period + 1)
 *
 * For the initial EMA, we can use the simple moving average (SMA) of the first 'period' closing prices,
 * or simply the closing price of the first item to seed it.
 */
export function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  if (closes.length < period) {
    // Fallback: If not enough data, return array filled with close or standard EMA using what we have
    const k = 2 / (period + 1);
    const ema: number[] = [];
    let current = closes[0];
    for (let i = 0; i < closes.length; i++) {
      current = closes[i] * k + current * (1 - k);
      ema.push(current);
    }
    return ema;
  }

  const ema: number[] = new Array(closes.length);
  const k = 2 / (period + 1);

  // Initialize first value with SMA of the first 'period' elements
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
  }
  const sma = sum / period;

  // Let all indexes prior to period-1 be SMA-approximations (or same as SMA)
  for (let i = 0; i < period - 1; i++) {
    ema[i] = closes[i]; // seed values
  }
  ema[period - 1] = sma;

  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

export type CrossType = 'bullish' | 'bearish' | 'golden_cross' | 'dead_cross';

export interface CrossoverResult {
  value: CrossType;
  barsAgo: number;
}

/**
 * Detects crossovers between a short EMA and a long EMA.
 * A golden cross is defined as the fast EMA crossing ABOVE the slow EMA in the last few candles (e.g., 3 candles).
 * A dead cross is defined as the fast EMA crossing BELOW the slow EMA in the last few candles.
 * If no recent cross, returns 'bullish' if fast > slow, and 'bearish' if fast < slow.
 */
export function analyzeCrossover(fastEMA: number[], slowEMA: number[]): CrossoverResult {
  const len = fastEMA.length;
  if (len < 2 || slowEMA.length < 2) {
    return { value: 'bearish', barsAgo: 0 };
  }

  const latestFast = fastEMA[len - 1];
  const latestSlow = slowEMA[len - 1];

  // We check up to the last 4 candles to see if a crossover recently happened
  // Index 0 means the current candle, index 1 means previous, etc.
  for (let offset = 0; offset < Math.min(len - 1, 5); offset++) {
    const i = len - 1 - offset;
    const fastNow = fastEMA[i];
    const slowNow = slowEMA[i];
    const fastPrev = fastEMA[i - 1];
    const slowPrev = slowEMA[i - 1];

    // Check if fast crossed ABOVE slow (Golden Cross)
    if (fastPrev <= slowPrev && fastNow > slowNow) {
      return {
        value: 'golden_cross',
        barsAgo: offset
      };
    }

    // Check if fast crossed BELOW slow (Dead Cross)
    if (fastPrev >= slowPrev && fastNow < slowNow) {
      return {
        value: 'dead_cross',
        barsAgo: offset
      };
    }
  }

  // If no crossover in the last 4 candles, return current state
  if (latestFast > latestSlow) {
    return { value: 'bullish', barsAgo: 999 };
  } else {
    return { value: 'bearish', barsAgo: 999 };
  }
}

/**
 * Computes the overall rating for a symbol across a single timeframe based on the three EMAs crossovers:
 * - EMA 9 / 18
 * - EMA 27 / 36
 * - EMA 45 / 56
 *
 * Rules:
 * - If there are any golden crosses, we rank that highly as potentially explosive.
 * - If they are all bullish (fast > slow), we classify as 'bullish'.
 * - If they are all bearish (fast < slow), we classify as 'bearish'.
 * - Default: average tendency.
 */
export function getOverallRating(
  cross1: CrossType,
  cross2: CrossType,
  cross3: CrossType
): CrossType {
  // If there is ANY recent golden cross, highlight it!
  if (cross1 === 'golden_cross' || cross2 === 'golden_cross' || cross3 === 'golden_cross') {
    return 'golden_cross';
  }
  
  // If there is ANY recent dead cross, warning highlight!
  if (cross1 === 'dead_cross' || cross2 === 'dead_cross' || cross3 === 'dead_cross') {
    return 'dead_cross';
  }

  // Count bullish/bearish
  let bullCount = 0;
  let bearCount = 0;

  [cross1, cross2, cross3].forEach(c => {
    if (c === 'bullish') bullCount++;
    if (c === 'bearish') bearCount++;
  });

  return bullCount >= 2 ? 'bullish' : 'bearish';
}
