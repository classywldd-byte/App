export interface Kline {
  time: number; // Unix timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

export interface CoinScanResult {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  volume24h: number;
  volatility24h: number; // calculated as (high - low) / low * 100
  timeframes: {
    [interval: string]: {
      ema9: number;
      ema18: number;
      ema27: number;
      ema36: number;
      ema45: number;
      ema56: number;
      
      // Cross 1: 9 / 18
      cross9_18: {
        value: 'bullish' | 'bearish' | 'golden_cross' | 'dead_cross';
        barsAgo: number; // how many candles ago the cross happened
      };
      
      // Cross 2: 27 / 36
      cross27_36: {
        value: 'bullish' | 'bearish' | 'golden_cross' | 'dead_cross';
        barsAgo: number;
      };
      
      // Cross 3: 45 / 56
      cross45_56: {
        value: 'bullish' | 'bearish' | 'golden_cross' | 'dead_cross';
        barsAgo: number;
      };
      
      // Overall Rating based on state of the crosses
      overallRating: 'bullish' | 'bearish' | 'golden_cross' | 'dead_cross';
    };
  };
}

export type Timeframe = '3m' | '5m' | '15m' | '30m' | '1h' | '4h';

export interface ScanProgress {
  status: 'idle' | 'fetching_pairs' | 'scanning' | 'completed' | 'error';
  currentSymbol: string;
  processedCount: number;
  totalCount: number;
  errorMessage?: string;
}
