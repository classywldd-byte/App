export type IndicatorType = 'EMA' | 'HMA' | 'DEMA' | 'TEMA' | 'ALMA' | 'KAMA' | 'WMA' | 'ZLEMA';

/**
 * EMA mathematical calculation
 */
export function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  if (closes.length < period) {
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

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
  }
  const sma = sum / period;

  for (let i = 0; i < period - 1; i++) {
    ema[i] = closes[i];
  }
  ema[period - 1] = sma;

  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

export function calculateWMA(closes: number[], period: number): number[] {
  const result = new Array(closes.length);
  const denominator = (period * (period + 1)) / 2;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result[i] = closes[i];
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += closes[i - j] * (period - j);
      }
      result[i] = sum / denominator;
    }
  }
  return result;
}

export function calculateHMA(closes: number[], period: number): number[] {
  const halfPeriod = Math.floor(period / 2);
  const sqrtPeriod = Math.floor(Math.sqrt(period));
  const wmaHalf = calculateWMA(closes, halfPeriod);
  const wmaFull = calculateWMA(closes, period);
  const rawHMA = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    rawHMA[i] = (2 * wmaHalf[i]) - wmaFull[i];
  }
  return calculateWMA(rawHMA, sqrtPeriod);
}

export function calculateDEMA(closes: number[], period: number): number[] {
  const ema1 = calculateEMA(closes, period);
  const ema2 = calculateEMA(ema1, period);
  const result = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    result[i] = 2 * ema1[i] - ema2[i];
  }
  return result;
}

export function calculateTEMA(closes: number[], period: number): number[] {
  const ema1 = calculateEMA(closes, period);
  const ema2 = calculateEMA(ema1, period);
  const ema3 = calculateEMA(ema2, period);
  const result = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    result[i] = 3 * ema1[i] - 3 * ema2[i] + ema3[i];
  }
  return result;
}

export function calculateZLEMA(closes: number[], period: number): number[] {
  const lag = Math.floor((period - 1) / 2);
  const zlema = new Array(closes.length);
  const data = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    if (i < lag) {
      data[i] = closes[i];
    } else {
      data[i] = closes[i] + (closes[i] - closes[i - lag]);
    }
  }
  return calculateEMA(data, period);
}

export function calculateKAMA(closes: number[], period: number, fastEnd = 2, slowEnd = 30): number[] {
  const result = new Array(closes.length);
  const fastCmp = 2 / (fastEnd + 1);
  const slowCmp = 2 / (slowEnd + 1);
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      result[i] = closes[i];
    } else {
      const change = Math.abs(closes[i] - closes[i - period]);
      let volatility = 0;
      for (let j = 0; j < period; j++) {
        volatility += Math.abs(closes[i - j] - closes[i - j - 1]);
      }
      const er = volatility === 0 ? 0 : change / volatility;
      const sc = Math.pow((er * (fastCmp - slowCmp)) + slowCmp, 2);
      result[i] = result[i - 1] + sc * (closes[i] - result[i - 1]);
    }
  }
  return result;
}

export function calculateALMA(closes: number[], period: number, offset = 0.85, sigma = 6): number[] {
  const result = new Array(closes.length);
  const m = Math.floor(offset * (period - 1));
  const s = period / sigma;
  
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result[i] = closes[i];
    } else {
      let wSum = 0;
      let pSum = 0;
      for (let j = 0; j < period; j++) {
        // According to ALMA formula j goes from 0 to period-1 
        const w = Math.exp(-Math.pow(j - m, 2) / (2 * Math.pow(s, 2)));
        pSum += closes[i - period + 1 + j] * w;
        wSum += w;
      }
      result[i] = pSum / wSum;
    }
  }
  return result;
}

export function calculateMA(closes: number[], period: number, type: IndicatorType = 'EMA'): number[] {
  switch (type) {
    case 'HMA': return calculateHMA(closes, period);
    case 'DEMA': return calculateDEMA(closes, period);
    case 'TEMA': return calculateTEMA(closes, period);
    case 'ALMA': return calculateALMA(closes, period);
    case 'KAMA': return calculateKAMA(closes, period);
    case 'WMA': return calculateWMA(closes, period);
    case 'ZLEMA': return calculateZLEMA(closes, period);
    case 'EMA':
    default:
      return calculateEMA(closes, period);
  }
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
