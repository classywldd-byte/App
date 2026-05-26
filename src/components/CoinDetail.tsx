import { useState, useEffect, useRef, useMemo } from 'react';
import { CoinScanResult, Timeframe, Kline } from '../types';
import { calculateMA, analyzeCrossover, IndicatorType } from '../utils/indicators';
import { fetchSymbolData } from '../utils/binance';
import { playAlertSound } from '../utils/audio';
import { LightweightChart } from './LightweightChart';
import { PriceDisplay } from './PriceDisplay';
import { ChevronRight, ExternalLink, Activity, Sparkles, TrendingUp, TrendingDown, ArrowRight, Maximize2, Minimize2, Bell, BellOff } from 'lucide-react';

function loadCcxt(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).ccxt) return resolve((window as any).ccxt);
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/ccxt@4.5.55/dist/ccxt.browser.min.js';
    script.onload = () => resolve((window as any).ccxt);
    script.onerror = () => reject(new Error('Failed to load CCXT'));
    document.head.appendChild(script);
  });
}

interface CoinDetailProps {
  coin: CoinScanResult;
  selectedTimeframe: Timeframe;
  indicatorType: IndicatorType;
  onClose: () => void;
  onOpenCoinglass: (symbol: string) => void;
}

export function CoinDetail({ coin, selectedTimeframe, indicatorType, onClose, onOpenCoinglass }: CoinDetailProps) {
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>(selectedTimeframe);
  const activeTimeframeRef = useRef(activeTimeframe);
  useEffect(() => { activeTimeframeRef.current = activeTimeframe; }, [activeTimeframe]);

  const [dataByTf, setDataByTf] = useState<Partial<Record<Timeframe, { closes: number[], klines: Kline[] }>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [liveAggPrice, setLiveAggPrice] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const prevCrossRefs = useRef<Partial<Record<Timeframe, string>>>({});
  const retryTimeout = useRef<NodeJS.Timeout | null>(null);

  const timeframes: Timeframe[] = ['3m', '5m', '15m', '30m', '1h', '4h'];

  // 1. Fetch historical data on mount for ALL timeframes
  useEffect(() => {
    let active = true;
    async function loadAll() {
      setLoading(true);
      setError('');
      try {
        const results = await Promise.all(
          timeframes.map(tf => fetchSymbolData(coin.symbol, tf, 60).then(res => ({ tf, res })))
        );
        if (!active) return;
        const newMap: Partial<Record<Timeframe, { closes: number[], klines: Kline[] }>> = {};
        for (const { tf, res } of results) {
          newMap[tf] = res;
        }
        setDataByTf(newMap);
      } catch (err: any) {
        if (!active) return;
        setError('No se pudo cargar históricos para este símbolo');
      } finally {
        if (active) setLoading(false);
      }
    }
    loadAll();
    return () => { active = false; };
  }, [coin.symbol]);

  // 2. Real-time websocket updating for ALL timeframes multiplexed
  useEffect(() => {
    if (loading || error || Object.keys(dataByTf).length !== timeframes.length) return;

    let ws: WebSocket | null = null;
    let isClosed = false;
    let currentUrlIndex = 0;
    let reconnectAttempts = 0;

    // Subscribe to @aggTrade for real-time price updates
    const streamName = `${coin.symbol.toLowerCase()}@aggTrade`;
    
    // Direct Binance URLs
    const urlsToTry = [
      `wss://fstream.binance.com/ws/${streamName}`, 
      `wss://stream.binance.com:9443/ws/${streamName}`
    ];

    console.log(`[WS Detail] Constructing stream: ${streamName}`);
    
    function connect() {
      if (isClosed) return;
      
      const url = urlsToTry[currentUrlIndex];
      console.log(`[WS Detail] Attempting connection to ${url}...`);
      
      const socket = new WebSocket(url);
      ws = socket;

      socket.onopen = () => {
        console.log(`[WS Detail] Opened!`);
        setWsConnected(true);
        reconnectAttempts = 0;
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          if (msg.e === 'aggTrade') {
            const price = parseFloat(msg.p);
            setLiveAggPrice(price);
            
            setDataByTf(prev => {
              const newPrev = { ...prev };
              let changed = false;
              
              for (const tf in prev) {
                const currentTfData = prev[tf as Timeframe];
                if (!currentTfData || currentTfData.klines.length === 0) continue;

                const klines = [...currentTfData.klines];
                const closes = [...currentTfData.closes];
                const lastIdx = klines.length - 1;
                
                klines[lastIdx] = {
                  ...klines[lastIdx],
                  c: price,
                  h: Math.max(klines[lastIdx].h, price),
                  l: Math.min(klines[lastIdx].l, price)
                };
                closes[lastIdx] = price;

                newPrev[tf as Timeframe] = { klines, closes };
                changed = true;
              }
              
              return changed ? newPrev : prev;
            });
          }
        } catch (err) {
          // ignore parsing error
        }
      };

      socket.onerror = (err) => {
        if (currentUrlIndex === urlsToTry.length - 1) {
          console.warn(`[WS Detail] Error on fallback:`, err);
        }
      };

      socket.onclose = (e) => {
        console.log(`[WS Detail] Closed, code: ${e.code}, reason: ${e.reason}`);
        handleReconnect();
      };
    }

    function handleReconnect() {
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
      }
      setWsConnected(false);
      if (isClosed) return;

      if (currentUrlIndex < urlsToTry.length - 1) {
        currentUrlIndex++;
        console.log(`[WS Detail] Trying fallback URL...`);
        connect();
        return;
      }

      currentUrlIndex = 0;
      reconnectAttempts++;
      const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 15000);
      
      console.log(`[WS Detail] Retrying all URLs in ${delay}ms...`);
      if (retryTimeout.current) clearTimeout(retryTimeout.current);
      retryTimeout.current = setTimeout(connect, delay);
    }

    connect();

    return () => {
      isClosed = true;
      if (retryTimeout.current) clearTimeout(retryTimeout.current);
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(); } catch (e) {}
      }
      setWsConnected(false);
    };
  }, [coin.symbol, loading, error, Object.keys(dataByTf).length === timeframes.length]);

  // 3. HTTP Polling Fallback in case WebSocket is geoblocked/fails to connect
  useEffect(() => {
    if (loading || error || wsConnected) return;

    console.log(`[WS Detail Fallback] WebSocket is offline or geoblocked. Polling HTTP API for ${coin.symbol} on ${activeTimeframe}`);

    const intervalId = setInterval(async () => {
      try {
        let fetchedKlines: Kline[] = [];
        let fetchedCloses: number[] = [];
        let success = false;
        
        // 1. Try CCXT fallback first for klines
        try {
          const ccxt = await loadCcxt();
          const restExchange = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'future' } });
          const tfMap: Record<string, string> = {
            '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h'
          };
          
          // Format symbol for CCXT Futures (e.g. BTCUSDT -> BTC/USDT:USDT)
          const cleanSym = coin.symbol.replace('USDT', '');
          const symStr = `${cleanSym}/USDT:USDT`;
          
          const ohlcv = await restExchange.fetchOHLCV(symStr, tfMap[activeTimeframe] || '15m', undefined, 60);
          
          const newKlines = ohlcv.map((k: any) => ({
             time: Math.floor(k[0] / 1000),
             o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5])
          }));
          
          fetchedKlines = newKlines;
          fetchedCloses = newKlines.map(k => k.c);
          success = true;
        } catch (ccxtErr) {
          console.warn(`[WS Detail Fallback] CCXT error:`, ccxtErr);
        }

        // 2. Direct Binance API
        if (!success) {
          const res = await fetchSymbolData(coin.symbol, activeTimeframe, 60);
          fetchedKlines = res.klines;
          fetchedCloses = res.closes;
        }
        
        if (fetchedKlines.length > 0) {
          const latestVal = fetchedKlines[fetchedKlines.length - 1].c;
          setLiveAggPrice(latestVal);
        }
        
        setDataByTf(prev => ({
          ...prev,
          [activeTimeframe]: { klines: fetchedKlines, closes: fetchedCloses }
        }));
      } catch (err) {
        console.warn(`[WS Detail Fallback] Polling error for ${coin.symbol}:`, err);
      }
    }, 4500);

    return () => clearInterval(intervalId);
  }, [coin.symbol, activeTimeframe, loading, error, wsConnected]);

  // Compute live crosses for all timeframes to check alerts
  const crossesForAllTfs: Partial<Record<Timeframe, string>> = {};
  for (const tf of timeframes) {
    const d = dataByTf[tf];
    if (d && d.closes.length > 18) {
      const ema9 = calculateMA(d.closes, 9, indicatorType);
      const ema18 = calculateMA(d.closes, 18, indicatorType);
      const cross = analyzeCrossover(ema9, ema18);
      crossesForAllTfs[tf] = cross.value;
    } else {
      crossesForAllTfs[tf] = coin.timeframes[tf]?.cross9_18.value || 'bearish';
    }
  }

  // Play sound if alerts enabled and a new meaningful cross emerges on ANY timeframe
  useEffect(() => {
    if (!alertsEnabled) {
      prevCrossRefs.current = {};
      return;
    }
    
    let anyGolden = false;
    let anyDead = false;

    for (const tf of timeframes) {
      const currentVal = crossesForAllTfs[tf];
      if (!currentVal) continue;

      const prevVal = prevCrossRefs.current[tf];
      
      if (prevVal === undefined) {
        prevCrossRefs.current[tf] = currentVal;
        continue;
      }
      
      if (currentVal !== prevVal) {
        if (currentVal === 'golden_cross') anyGolden = true;
        if (currentVal === 'dead_cross') anyDead = true;
        prevCrossRefs.current[tf] = currentVal;
      }
    }

    if (anyGolden) {
      console.log(`[Alert] Cross bullish in some TF!`);
      playAlertSound('bullish');
    } else if (anyDead) {
      console.log(`[Alert] Cross bearish in some TF!`);
      playAlertSound('bearish');
    }
  }, [JSON.stringify(crossesForAllTfs), alertsEnabled]);

  const activeData = dataByTf[activeTimeframe] || { closes: [], klines: [] };
  const tfData = coin.timeframes[activeTimeframe];

  // Calculate live indicators for the specific ACTIVE timeframe
  const klinePrice = activeData.klines.length > 0 ? activeData.klines[activeData.klines.length - 1].c : coin.price;
  const livePrice = liveAggPrice !== null ? liveAggPrice : klinePrice;

  // Clone active klines to inject real-time price on the very last candle
  const displayKlines = [...activeData.klines];
  if (displayKlines.length > 0 && liveAggPrice !== null) {
    const lastIdx = displayKlines.length - 1;
    displayKlines[lastIdx] = {
      ...displayKlines[lastIdx],
      c: liveAggPrice,
      h: Math.max(displayKlines[lastIdx].h, liveAggPrice),
      l: Math.min(displayKlines[lastIdx].l, liveAggPrice)
    };
  }

  const fullCloses = activeData.closes;
  const ema9Series = fullCloses.length ? calculateMA(fullCloses, 9, indicatorType) : [];
  const ema18Series = fullCloses.length ? calculateMA(fullCloses, 18, indicatorType) : [];
  const ema27Series = fullCloses.length ? calculateMA(fullCloses, 27, indicatorType) : [];
  const ema36Series = fullCloses.length ? calculateMA(fullCloses, 36, indicatorType) : [];
  const ema45Series = fullCloses.length ? calculateMA(fullCloses, 45, indicatorType) : [];
  const ema56Series = fullCloses.length ? calculateMA(fullCloses, 56, indicatorType) : [];

  const latestEma9 = ema9Series.length ? ema9Series[ema9Series.length - 1] : (tfData?.ema9 ?? null);
  const latestEma18 = ema18Series.length ? ema18Series[ema18Series.length - 1] : (tfData?.ema18 ?? null);
  const latestEma27 = ema27Series.length ? ema27Series[ema27Series.length - 1] : (tfData?.ema27 ?? null);
  const latestEma36 = ema36Series.length ? ema36Series[ema36Series.length - 1] : (tfData?.ema36 ?? null);
  const latestEma45 = ema45Series.length ? ema45Series[ema45Series.length - 1] : (tfData?.ema45 ?? null);
  const latestEma56 = ema56Series.length ? ema56Series[ema56Series.length - 1] : (tfData?.ema56 ?? null);

  const liveCross9_18 = (ema9Series.length && ema18Series.length) ? analyzeCrossover(ema9Series, ema18Series) : (tfData ? tfData.cross9_18 : { value: 'bearish' as const, barsAgo: 999 });
  const liveCross27_36 = (ema27Series.length && ema36Series.length) ? analyzeCrossover(ema27Series, ema36Series) : (tfData ? tfData.cross27_36 : { value: 'bearish' as const, barsAgo: 999 });
  const liveCross45_56 = (ema45Series.length && ema56Series.length) ? analyzeCrossover(ema45Series, ema56Series) : (tfData ? tfData.cross45_56 : { value: 'bearish' as const, barsAgo: 999 });

  // Prepare chart lines if data exists
  const emaData = useMemo(() => [
    { values: ema9Series.slice(-60), color: '#34d399', label: 'EMA 9' },
    { values: ema18Series.slice(-60), color: '#10b981', label: 'EMA 18' },
    { values: ema27Series.slice(-60), color: '#60a5fa', label: 'EMA 27' },
    { values: ema36Series.slice(-60), color: '#3b82f6', label: 'EMA 36' },
    { values: ema45Series.slice(-60), color: '#a78bfa', label: 'EMA 45' },
    { values: ema56Series.slice(-60), color: '#ec4899', label: 'EMA 56' },
  ], [ema9Series, ema18Series, ema27Series, ema36Series, ema45Series, ema56Series]);

  const emaDataFullscreen = useMemo(() => [
    { values: ema9Series.slice(-100), color: '#34d399', label: 'EMA 9' },
    { values: ema18Series.slice(-100), color: '#10b981', label: 'EMA 18' },
    { values: ema27Series.slice(-100), color: '#60a5fa', label: 'EMA 27' },
    { values: ema36Series.slice(-100), color: '#3b82f6', label: 'EMA 36' },
    { values: ema45Series.slice(-100), color: '#a78bfa', label: 'EMA 45' },
    { values: ema56Series.slice(-100), color: '#ec4899', label: 'EMA 56' },
  ], [ema9Series, ema18Series, ema27Series, ema36Series, ema45Series, ema56Series]);

  let chartContent = null;
  if (!loading && !error && displayKlines.length >= 30) {
    const subsetKlines = displayKlines.slice(-60);

    chartContent = (
      <LightweightChart 
        klines={subsetKlines} 
        emas={emaData}
        symbol={coin.symbol}
        timeframe={activeTimeframe}
        height={isFullscreen ? 650 : 450}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-[#000]/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fade-in">
      <div 
        className="bg-[#121418] border border-[#2a2d33] rounded max-w-5xl w-full overflow-hidden shadow-2xl animate-scale-up flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Banner header */}
        <div className="bg-[#1c1f26] px-5 py-3 border-b border-[#2a2d33] flex justify-between items-center">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black font-sans text-white tracking-tight">{coin.symbol}</h2>
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 bg-yellow-500/10 rounded text-yellow-500 border border-yellow-500/20">FUTURES</span>
              {wsConnected ? (
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 bg-green-500/10 rounded text-green-400 border border-green-500/20 animate-pulse">WS LIVE</span>
              ) : (
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 bg-amber-500/10 rounded text-amber-500 border border-amber-500/20">HTTP BACKUP</span>
              )}
            </div>
            <p className="text-[10px] text-gray-400 mt-1 font-mono">Panel Analítico Completo</p>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                const newState = !alertsEnabled;
                setAlertsEnabled(newState);
                // Play a brief test ping when turned on
                if (newState) playAlertSound('neutral');
              }}
              title={alertsEnabled ? "Desactivar alarmas" : "Activar alarmas de cruces"}
              className={`flex items-center justify-center p-1.5 rounded transition-colors border cursor-pointer ${
                alertsEnabled ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-500' : 'bg-[#121418] border-[#2a2d33] text-gray-500 hover:text-gray-300 hover:bg-[#2a2d33]'
              }`}
            >
              {alertsEnabled ? <Bell className="w-3.5 h-3.5 animate-pulse" /> : <BellOff className="w-3.5 h-3.5" />}
            </button>
            <button 
              onClick={onClose}
              className="text-gray-400 hover:text-white bg-[#121418] hover:bg-[#2a2d33] px-2 py-1 rounded border border-[#2a2d33] transition-colors text-xs font-bold cursor-pointer font-mono h-full"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Navigation tabs */}
        <div className="flex border-b border-[#2a2d33] bg-[#0c0d0e]/60 p-1 gap-1">
          {(['3m', '5m', '15m', '30m', '1h', '4h'] as Timeframe[]).map((tf) => (
            <button
              key={tf}
              onClick={() => setActiveTimeframe(tf)}
              className={`flex-1 py-1 rounded text-[10px] font-mono font-black transition-all ${
                activeTimeframe === tf 
                  ? 'bg-yellow-500 text-black shadow'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        {/* Pane scrollable */}
        <div className="p-5 flex-1 overflow-y-auto space-y-4 scrollbar-thin">
          
          {/* Prices & Volatility info grid */}
          <div className="grid grid-cols-3 gap-1 py-2 px-3 bg-[#0c0d0e]/40 border border-[#2a2d33] rounded">
            <div className="text-center border-r border-[#1c1f26]">
              <p className="text-[9px] font-mono uppercase tracking-wider text-gray-500">Precio actual</p>
              <PriceDisplay price={livePrice} className="text-sm font-black font-mono text-white mt-0.5 block" />
            </div>
            <div className="text-center border-r border-[#1c1f26]">
              <p className="text-[9px] font-mono uppercase tracking-wider text-gray-500">Cambio 24H</p>
              <p className={`text-sm font-black font-mono mt-0.5 ${coin.change24h >= 0 ? 'text-green-400' : 'text-rose-400'}`}>
                {coin.change24h >= 0 ? '+' : ''}{coin.change24h.toFixed(2)}%
              </p>
            </div>
            <div className="text-center">
              <p className="text-[9px] font-mono uppercase tracking-wider text-gray-500">Volatilidad</p>
              <p className="text-sm font-black font-mono text-teal-400 mt-0.5">
                {coin.volatility24h.toFixed(2)}%
              </p>
            </div>
          </div>

          {/* Indicators details */}
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2">
              <Activity className="w-6 h-6 animate-spin text-yellow-500" />
              <p className="text-[10px] font-mono text-gray-500 uppercase">Modelando curvas de cruce EMAs...</p>
            </div>
          ) : error ? (
            <div className="py-8 text-center text-xs font-mono text-rose-400">{error}</div>
          ) : tfData ? (
            <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-4">
              
              {/* Chart container goes first and spans full height of grid row */}
              <div className="md:row-span-2">
                <div className="bg-[#0c0d0e]/60 rounded border border-[#2a2d33] p-3 space-y-2 relative h-full flex flex-col">
                  <div className="flex justify-between items-center pb-2 border-b border-[#1c1f26]">
                    <span className="text-[10px] font-mono font-bold text-gray-400">PANE DE GRÁFICO REALTIME</span>
                    <button 
                      onClick={() => setIsFullscreen(true)}
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#121418] border border-[#2a2d33] text-[10px] text-gray-400 hover:text-white hover:bg-yellow-500 hover:text-black transition-all cursor-pointer font-mono font-bold"
                    >
                      <Maximize2 className="w-3 h-3" /> Pantalla Completa
                    </button>
                  </div>
                  <div className="flex-1">
                    {chartContent}
                  </div>
                </div>
              </div>

              {/* EMA parameters metrics table */}
              <div className="bg-[#0c0d0e]/20 border border-[#2a2d33] rounded p-3 h-fit">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-450 font-sans mb-2 flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-yellow-500" />
                  Métricas de EMA en {activeTimeframe}
                </h4>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px]">
                  <div className="flex justify-between items-center py-0.5 border-b border-[#1c1f26]">
                    <span className="text-gray-500">EMA 9:</span>
                    <span className="text-green-400 font-bold">${latestEma9 ? latestEma9.toFixed(4) : '-'}</span>
                  </div>
                  <div className="flex justify-between items-center py-0.5 border-b border-[#1c1f26]">
                    <span className="text-gray-500">EMA 18:</span>
                    <span className="text-green-500 font-bold">${latestEma18 ? latestEma18.toFixed(4) : '-'}</span>
                  </div>
                  <div className="flex justify-between items-center py-0.5 border-b border-[#1c1f26]">
                    <span className="text-gray-500">EMA 27:</span>
                    <span className="text-blue-400 font-bold">${latestEma27 ? latestEma27.toFixed(4) : '-'}</span>
                  </div>
                  <div className="flex justify-between items-center py-0.5 border-b border-[#1c1f26]">
                    <span className="text-gray-500">EMA 36:</span>
                    <span className="text-indigo-450 font-bold">${latestEma36 ? latestEma36.toFixed(4) : '-'}</span>
                  </div>
                  <div className="flex justify-between items-center py-0.5 border-b border-[#1c1f26]">
                    <span className="text-gray-500">EMA 45:</span>
                    <span className="text-pink-400 font-bold">${latestEma45 ? latestEma45.toFixed(4) : '-'}</span>
                  </div>
                  <div className="flex justify-between items-center py-0.5 border-b border-[#1c1f26]">
                    <span className="text-gray-500">EMA 56:</span>
                    <span className="text-pink-500 font-bold">${latestEma56 ? latestEma56.toFixed(4) : '-'}</span>
                  </div>
                </div>
              </div>

              {/* Status breakdown */}
              <div className="bg-[#0c0d0e]/30 border border-[#2a2d33] rounded p-3 space-y-2 h-fit">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-400 font-sans mb-1">
                  Evaluación de Cruces
                </h4>

                {/* Cross 9/18 */}
                <div className="flex justify-between items-center text-[11px] py-1 border-b border-[#1c1f26] last:border-none">
                  <span className="font-mono text-gray-400">Cruce 1 (EMA 9/18):</span>
                  <div className="flex items-center gap-2">
                    <CrossBadge value={liveCross9_18.value} />
                    {liveCross9_18.barsAgo !== 999 && (
                      <span className="text-[10px] font-mono text-gray-500">hace {liveCross9_18.barsAgo} velas</span>
                    )}
                  </div>
                </div>

                {/* Cross 27/36 */}
                <div className="flex justify-between items-center text-[11px] py-1 border-b border-[#1c1f26] last:border-none">
                  <span className="font-mono text-gray-400">Cruce 2 (EMA 27/36):</span>
                  <div className="flex items-center gap-2">
                    <CrossBadge value={liveCross27_36.value} />
                    {liveCross27_36.barsAgo !== 999 && (
                      <span className="text-[10px] font-mono text-gray-500">hace {liveCross27_36.barsAgo} velas</span>
                    )}
                  </div>
                </div>

                {/* Cross 45/56 */}
                <div className="flex justify-between items-center text-[11px] py-1 last:border-none">
                  <span className="font-mono text-gray-400">Cruce 3 (EMA 45/56):</span>
                  <div className="flex items-center gap-2">
                    <CrossBadge value={liveCross45_56.value} />
                    {liveCross45_56.barsAgo !== 999 && (
                      <span className="text-[10px] font-mono text-gray-500">hace {liveCross45_56.barsAgo} velas</span>
                    )}
                  </div>
                </div>
              </div>

            </div>
          ) : (
            <div className="py-8 text-center text-xs font-mono text-gray-500">No hay datos para este interval</div>
          )}
        </div>

        {/* Footer actions */}
        <div className="bg-[#0c0d0e] px-5 py-3.5 border-t border-[#2a2d33] flex flex-wrap gap-2">
          <button
            onClick={() => onOpenCoinglass(coin.symbol)}
            className="flex-1 min-w-[140px] flex justify-center items-center gap-1.5 bg-[#121418] hover:bg-[#1c1f26] hover:text-blue-400 text-gray-300 py-2 rounded text-[11px] font-bold transition-all border border-[#2a2d33] cursor-pointer"
          >
            Coinglass (App) <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <a
            href={`https://www.coinglass.com/tv/es/Binance_${coin.symbol}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 min-w-[140px] flex justify-center items-center gap-1.5 bg-[#121418] hover:bg-[#1c1f26] hover:text-blue-400 text-gray-300 py-2 rounded text-[11px] font-bold transition-all border border-[#2a2d33]"
          >
            Coinglass (Web) <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <a
            href={`https://www.binance.com/es/futures/${coin.symbol}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 min-w-[140px] flex justify-center items-center gap-1.5 bg-[#121418] hover:bg-[#1c1f26] hover:text-white text-gray-300 py-2 rounded text-[11px] font-bold transition-all border border-[#2a2d33]"
          >
            Binance <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={onClose}
            className="flex-1 min-w-[140px] bg-yellow-500 hover:bg-yellow-400 text-black py-2 rounded text-[11px] font-black transition-all shadow-md active:scale-[0.98] cursor-pointer"
          >
            Cerrar Análisis
          </button>
        </div>
      </div>

      {/* Immersive Fullscreen Chart Overlay */}
      {isFullscreen && (
        <div className="fixed inset-0 bg-[#0c0d0e] z-[100] flex flex-col animate-fade-in p-6 overflow-hidden">
          <div className="flex justify-between items-center border-b border-[#2a2d33] pb-4 mb-4">
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-lg font-black font-sans text-white tracking-tight">{coin.symbol}</h3>
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 bg-yellow-500/10 rounded text-yellow-500 border border-yellow-500/20">FUTURES LIVE</span>
              <span className="text-xs font-mono text-gray-400">Intervalo: <strong>{activeTimeframe}</strong></span>
              <span className="text-xs font-mono text-gray-400">
                Precio actual: <PriceDisplay price={livePrice} className="text-green-400 font-bold font-mono inline-block" />
              </span>
            </div>
            <button
              onClick={() => setIsFullscreen(false)}
              className="flex items-center gap-1.5 bg-[#121418] hover:bg-rose-600 hover:text-white px-3 py-1.5 rounded border border-[#2a2d33] text-xs font-mono text-black font-semibold cursor-pointer transition-all hover:border-transparent text-gray-300"
            >
              <Minimize2 className="w-3.5 h-3.5" /> Salir Pantalla Completa
            </button>
          </div>

          {/* Timeframe selector inside fullscreen window */}
          <div className="flex gap-2 mb-4 bg-[#121418] border border-[#2a2d33] p-1.5 rounded max-w-md">
            {(['3m', '5m', '15m', '30m', '1h', '4h'] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => setActiveTimeframe(tf)}
                className={`flex-1 py-1 px-3 rounded text-xs font-mono font-black transition-all cursor-pointer ${
                  activeTimeframe === tf 
                    ? 'bg-yellow-500 text-black shadow-md'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          {/* Expansive Fullscreen Chart */}
          <div className="flex-1 bg-[#0c0d0e]/95 border border-[#2a2d33] rounded p-4 flex flex-col justify-center relative min-h-0">
            <LightweightChart 
              klines={displayKlines.slice(-50)} // Show slightly more candles inside fullscreen!
              emas={emaDataFullscreen}
              symbol={coin.symbol}
              timeframe={activeTimeframe}
              height={window.innerHeight - 240} // Expansively scale height to viewport size
            />
          </div>

          {/* Mini technical bar at the bottom */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-4 text-center">
            <div className="bg-[#121418] border border-[#2a2d33] p-2 rounded">
              <p className="text-[10px] font-mono text-gray-500 uppercase">EMA 9</p>
              <p className="text-xs font-mono font-bold text-green-400">${latestEma9 ? latestEma9.toFixed(4) : '-'}</p>
            </div>
            <div className="bg-[#121418] border border-[#2a2d33] p-2 rounded">
              <p className="text-[10px] font-mono text-gray-500 uppercase">EMA 18</p>
              <p className="text-xs font-mono font-bold text-green-500">${latestEma18 ? latestEma18.toFixed(4) : '-'}</p>
            </div>
            <div className="bg-[#121418] border border-[#2a2d33] p-2 rounded">
              <p className="text-[10px] font-mono text-gray-500 uppercase">EMA 27</p>
              <p className="text-xs font-mono font-bold text-blue-400">${latestEma27 ? latestEma27.toFixed(4) : '-'}</p>
            </div>
            <div className="bg-[#121418] border border-[#2a2d33] p-2 rounded">
              <p className="text-[10px] font-mono text-gray-500 uppercase">EMA 36</p>
              <p className="text-xs font-mono font-bold text-indigo-400">${latestEma36 ? latestEma36.toFixed(4) : '-'}</p>
            </div>
            <div className="bg-[#121418] border border-[#2a2d33] p-2 rounded">
              <p className="text-[10px] font-mono text-gray-500 uppercase">EMA 45</p>
              <p className="text-xs font-mono font-bold text-pink-400">${latestEma45 ? latestEma45.toFixed(4) : '-'}</p>
            </div>
            <div className="bg-[#121418] border border-[#2a2d33] p-2 rounded">
              <p className="text-[10px] font-mono text-gray-500 uppercase">EMA 56</p>
              <p className="text-xs font-mono font-bold text-pink-505 text-pink-500">${latestEma56 ? latestEma56.toFixed(4) : '-'}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CrossBadge({ value }: { value: CoinScanResult['timeframes'][string]['cross9_18']['value'] }) {
  const stylesObj = {
    golden_cross: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-bold',
    bullish: 'bg-green-500/10 text-green-400 border border-green-500/15',
    dead_cross: 'bg-rose-500/15 text-rose-300 border border-rose-500/30 font-bold',
    bearish: 'bg-red-500/10 text-red-400 border border-red-500/15',
  };

  const labelObj = {
    golden_cross: '🔥 Golden Cross',
    bullish: '📈 Bullish',
    dead_cross: '🥀 Dead Cross',
    bearish: '📉 Bearish',
  };

  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${stylesObj[value]}`}>
      {labelObj[value]}
    </span>
  );
}
