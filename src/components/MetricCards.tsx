import { CoinScanResult, Timeframe } from '../types';
import { TrendingUp, TrendingDown, RefreshCw, Zap, Flame, ShieldAlert } from 'lucide-react';

interface MetricCardsProps {
  scannedList: CoinScanResult[];
  selectedTimeframe: Timeframe;
}

export function MetricCards({ scannedList, selectedTimeframe }: MetricCardsProps) {
  // Count counts of different crossover trends for the primary selected timeframe
  let goldCrossCount = 0;
  let deadCrossCount = 0;
  let bullishCount = 0;
  let bearishCount = 0;

  scannedList.forEach(coin => {
    const tfData = coin.timeframes[selectedTimeframe];
    if (tfData) {
      if (tfData.overallRating === 'golden_cross') goldCrossCount++;
      else if (tfData.overallRating === 'dead_cross') deadCrossCount++;
      else if (tfData.overallRating === 'bullish') bullishCount++;
      else if (tfData.overallRating === 'bearish') bearishCount++;
    }
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      {/* Golden Cross Card */}
      <div className="bg-[#121418] border border-[#2a2d33] rounded p-3 shadow-md flex justify-between items-center transition-all hover:border-[#3a3f4b]">
        <div className="space-y-0.5">
          <span className="text-[10px] uppercase font-mono tracking-wider text-yellow-500 font-bold">GOLDEN CROSSES ★</span>
          <h3 className="text-2xl font-black font-mono text-white leading-none">{goldCrossCount}</h3>
          <p className="text-[9px] text-gray-500 font-mono">Reversión Alcista Reciente</p>
        </div>
        <div className="w-9 h-9 bg-yellow-500/10 rounded flex items-center justify-center text-yellow-500 border border-yellow-500/20">
          <Flame className="w-5 h-5 animate-pulse" />
        </div>
      </div>

      {/* Bullish Card */}
      <div className="bg-[#121418] border border-[#2a2d33] rounded p-3 shadow-md flex justify-between items-center transition-all hover:border-[#3a3f4b]">
        <div className="space-y-0.5">
          <span className="text-[10px] uppercase font-mono tracking-wider text-green-400 font-bold">BULLISH ALIGNMENT ✔️</span>
          <h3 className="text-2xl font-black font-mono text-green-400 leading-none">{bullishCount}</h3>
          <p className="text-[9px] text-gray-500 font-mono">EMAs Alcistas Consolidadas</p>
        </div>
        <div className="w-9 h-9 bg-green-500/10 rounded flex items-center justify-center text-green-400 border border-green-500/25">
          <TrendingUp className="w-5 h-5" />
        </div>
      </div>

      {/* Dead Cross Card */}
      <div className="bg-[#121418] border border-[#2a2d33] rounded p-3 shadow-md flex justify-between items-center transition-all hover:border-[#3a3f4b]">
        <div className="space-y-0.5">
          <span className="text-[10px] uppercase font-mono tracking-wider text-fuchsia-500 font-bold">DEAD CROSSES 💀</span>
          <h3 className="text-2xl font-black font-mono text-fuchsia-400 leading-none">{deadCrossCount}</h3>
          <p className="text-[9px] text-gray-500 font-mono">Reversión Bajista Reciente</p>
        </div>
        <div className="w-9 h-9 bg-fuchsia-500/10 rounded flex items-center justify-center text-fuchsia-400 border border-fuchsia-500/20">
          <ShieldAlert className="w-5 h-5" />
        </div>
      </div>

      {/* Bearish Card */}
      <div className="bg-[#121418] border border-[#2a2d33] rounded p-3 shadow-md flex justify-between items-center transition-all hover:border-[#3a3f4b]">
        <div className="space-y-0.5">
          <span className="text-[10px] uppercase font-mono tracking-wider text-red-500 font-bold">BEARISH ALIGNMENT ❌</span>
          <h3 className="text-2xl font-black font-mono text-red-400 leading-none">{bearishCount}</h3>
          <p className="text-[9px] text-gray-500 font-mono">EMAs Bajistas Consolidadas</p>
        </div>
        <div className="w-9 h-9 bg-red-500/10 rounded flex items-center justify-center text-red-400 border border-red-500/25">
          <TrendingDown className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}
