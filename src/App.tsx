import { useState, useEffect, useRef } from 'react';
import { CoinScanResult, Timeframe, ScanProgress } from './types';
import { fetchTop100Symbols, scanSingleSymbol } from './utils/binance';
import { MetricCards } from './components/MetricCards';
import { CoinDetail } from './components/CoinDetail';
import { 
  Play, 
  Square, 
  Search, 
  HelpCircle, 
  Flame, 
  TrendingUp, 
  TrendingDown, 
  Zap, 
  AlertTriangle, 
  RotateCw, 
  ArrowUpDown, 
  ExternalLink, 
  Compass, 
  ChevronRight,
  Filter
} from 'lucide-react';

import { PriceDisplay } from './components/PriceDisplay';

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

export default function App() {
  // Scanner states
  const [scannedCoins, setScannedCoins] = useState<CoinScanResult[]>(() => {
    try {
      const cached = localStorage.getItem('binance_futures_scan');
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });

  const [progress, setProgress] = useState<ScanProgress>({
    status: 'idle',
    currentSymbol: '',
    processedCount: 0,
    totalCount: 0
  });

  // UI Filtering & Sorting configurations
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('15m');
  const [activeTimeframes, setActiveTimeframes] = useState<Timeframe[]>(() => {
    try {
      const saved = localStorage.getItem('binance_futures_active_timeframes');
      return saved ? JSON.parse(saved) : ['3m', '5m', '15m', '30m', '1h', '4h'];
    } catch {
      return ['3m', '5m', '15m', '30m', '1h', '4h'];
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTrendFilter, setSelectedTrendFilter] = useState<string>('all');
  const [sortMethod, setSortMethod] = useState<'crossover_volatility' | 'crossover_volume' | 'pure_volatility' | 'pure_volume'>(() => {
    const saved = localStorage.getItem('binance_futures_sort_method');
    return saved ? (saved as any) : 'crossover_volatility';
  });
  const [selectedCoinSymbol, setSelectedCoinSymbol] = useState<string | null>(null);
  const [previewCoinglassSymbol, setPreviewCoinglassSymbol] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState<number>(3); // Standard request queue pacing
  const [lastScanTime, setLastScanTime] = useState<string>('04:00:52');

  // Scanner cancel control ref
  const cancelScanRef = useRef<boolean>(false);

  // Persistence local storage updater
  useEffect(() => {
    if (scannedCoins.length > 0) {
      localStorage.setItem('binance_futures_scan', JSON.stringify(scannedCoins));
    }
  }, [scannedCoins]);

  useEffect(() => {
    localStorage.setItem('binance_futures_active_timeframes', JSON.stringify(activeTimeframes));
  }, [activeTimeframes]);

  useEffect(() => {
    localStorage.setItem('binance_futures_sort_method', sortMethod);
  }, [sortMethod]);

  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');

  // Real-time WebSocket for active tickers list
  useEffect(() => {
    if (scannedCoins.length === 0 || progress.status === 'scanning' || progress.status === 'fetching_pairs') {
      setWsStatus('disconnected');
      return;
    }

    let ws: WebSocket | null = null;
    let isClosed = false;
    let reconnectAttempts = 0;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let pollInterval: NodeJS.Timeout | null = null;

    // For real-time tick-by-tick updates on prices, we use a combined @aggTrade stream for all scanned coins
    const streamKeys = scannedCoins.map(c => `${c.symbol.toLowerCase()}@aggTrade`);
    
    // We chunk the streams in case there are too many (Binance allows up to 200 streams per socket)
    const streamsParam = streamKeys.slice(0, 150).join('/');

    // Direct Binance URLs. Fallback from futures to spot.
    const urlsToTry = [
      `wss://fstream.binance.com/stream?streams=${streamsParam}`,
      `wss://stream.binance.com:9443/stream?streams=${streamsParam}`
    ];
      
    let currentUrlIndex = 0;

    // Set up HTTP poll fallback if WebSocket stays disconnected
    if (wsStatus === 'disconnected' || wsStatus === 'connecting') {
      pollInterval = setInterval(async () => {
        if (ws && ws.readyState === WebSocket.OPEN) return;
        
        try {
          // 1. Try CCXT first
          try {
            const ccxt = await loadCcxt();
            const restExchange = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'future' } });
            
            const tickers = await restExchange.fetchTickers();
            
            const updates: Record<string, { price: number; change24h: number; volume24h: number; volatility24h: number }> = {};
            
            for (const sym in tickers) {
              const item = tickers[sym];
              if (!sym || !sym.endsWith(':USDT')) continue; // CCXT format is usually BTC/USDT:USDT for futures
              
              const cleanSym = sym.replace('/', '').replace(':USDT', '');
              const symbolKey = cleanSym + 'USDT';
              
              const price = item.last || 0;
              const open = item.open || 0;
              const high = item.high || 0;
              const low = item.low || 0;
              const quoteVol = item.quoteVolume || 0;
              const change24h = item.percentage || (open > 0 ? ((price - open) / open) * 100 : 0);
              const volatility24h = low > 0 ? ((high - low) / low) * 100 : 0;

              updates[symbolKey] = {
                price,
                change24h,
                volume24h: quoteVol,
                volatility24h
              };
            }
            
            applyUpdates(updates);
            return; // Success, exit interval block
          } catch (ccxtErr) {
            console.warn('[WS Main] CCXT fallback failed, trying direct Binance API:', ccxtErr);
          }

          // 2. Try Direct Binance API
          const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
          if (!res.ok) throw new Error('Direct API failed');
          const rawTickers = await res.json();
          if (!Array.isArray(rawTickers)) return;

          const updates: Record<string, { price: number; change24h: number; volume24h: number; volatility24h: number }> = {};
          
          for (const item of rawTickers) {
            const sym = item.symbol;
            if (!sym || !sym.endsWith('USDT')) continue;

            const price = parseFloat(item.lastPrice || item.price || '0');
            const open = parseFloat(item.openPrice || '0');
            const high = parseFloat(item.highPrice || '0');
            const low = parseFloat(item.lowPrice || '0');
            const quoteVol = parseFloat(item.quoteVolume || '0');
            const change24h = parseFloat(item.priceChangePercent || '0');
            const volatility24h = low > 0 ? ((high - low) / low) * 100 : 0;

            updates[sym] = {
              price,
              change24h,
              volume24h: quoteVol,
              volatility24h
            };
          }

          applyUpdates(updates);
        } catch(err) {
          console.warn('[WS Main] All fallback methods failed:', err);
        }
      }, 5000);
    }
    
    function applyUpdates(updates: Record<string, { price: number; change24h: number; volume24h: number; volatility24h: number }>) {
      setScannedCoins(prevCoins => {
        let changed = false;
        const updated = prevCoins.map(coin => {
          const u = updates[coin.symbol];
          if (u) {
            if (Math.abs(coin.price - u.price) > 0.00000001) {
              changed = true;
              return {
                ...coin,
                price: u.price,
                change24h: u.change24h,
                volume24h: u.volume24h,
                volatility24h: u.volatility24h
              };
            }
          }
          return coin;
        });
        return changed ? updated : prevCoins;
      });
    }

    function connect() {
      if (isClosed) return;

      const url = urlsToTry[currentUrlIndex];
      console.log(`[WS Main] Connecting to ${url}`);
      setWsStatus('connecting');
      
      try {
        ws = new WebSocket(url);
      } catch (err) {
        console.warn(`[WS Main] Unhandled creation error on ${url}:`, err);
        handleReconnect();
        return;
      }

      ws.onopen = () => {
        console.log(`[WS Main] Connected to ${url}`);
        setWsStatus('connected');
        reconnectAttempts = 0; // reset attempts on successful connection
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          
          if (!payload.data || payload.data.e !== 'aggTrade') {
            return;
          }

          const data = payload.data;
          const sym = data.s;
          if (!sym) return;

          const price = parseFloat(data.p);

          setScannedCoins(prevCoins => {
            const coinIdx = prevCoins.findIndex(c => c.symbol === sym);
            if (coinIdx === -1) return prevCoins;
            
            const coin = prevCoins[coinIdx];
            if (coin.price === price) return prevCoins;
            
            const updatedCoins = [...prevCoins];
            updatedCoins[coinIdx] = { ...coin, price };
            return updatedCoins;
          });
        } catch (err) {
          // fail silent
        }
      };

      ws.onerror = (err) => {
        // Only log if we reach the end of our fallbacks to prevent spam
        if (currentUrlIndex === urlsToTry.length - 1) {
          console.warn(`[WS Main] Error on final fallback url ${url}`, err);
        }
      };

      ws.onclose = () => {
        console.log(`[WS Main] Closed connection to ${url}`);
        handleReconnect();
      };
    }

    function handleReconnect() {
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
      }
      setWsStatus('disconnected');

      if (isClosed) return;

      // Try next fallback URL first
      if (currentUrlIndex < urlsToTry.length - 1) {
        currentUrlIndex++;
        console.log(`[WS Main] Failing over to next URL: ${urlsToTry[currentUrlIndex]}`);
        connect();
        return;
      }

      // If all fallbacks fail, backoff and retry from the beginning
      currentUrlIndex = 0;
      reconnectAttempts++;
      // Exponential backoff: 2s, 4s, 8s, up to 15s max
      const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 15000);
      
      console.log(`[WS Main] All URLs failed. Reconnecting in ${delay}ms...`);
      reconnectTimeout = setTimeout(connect, delay);
    }

    connect();

    return () => {
      isClosed = true;
      if (pollInterval) clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(); } catch (e) {}
      }
    };
  }, [scannedCoins.length === 0, progress.status]);

  // Export functions
  const downloadCSV = () => {
    if (scannedCoins.length === 0) return;
    
    // Header row
    const headers = [
      'Simbolo',
      'Precio Actual',
      'Cambio 24h (%)',
      'Volumen 24h (USDT)',
      'Volatilidad 24h (%)',
      'Cruce 9/18 (' + selectedTimeframe + ')',
      'Cruce 27/36 (' + selectedTimeframe + ')',
      'Cruce 45/56 (' + selectedTimeframe + ')',
      'Evaluacion General (' + selectedTimeframe + ')'
    ];

    // Map each coin to a row
    const rows = filteredAndSortedCoins.map(coin => {
      const tf = coin.timeframes[selectedTimeframe];
      return [
        coin.symbol,
        coin.price,
        coin.change24h.toFixed(2),
        coin.volume24h.toFixed(0),
        coin.volatility24h.toFixed(2),
        tf?.cross9_18.value || 'N/A',
        tf?.cross27_36.value || 'N/A',
        tf?.cross45_56.value || 'N/A',
        tf?.overallRating || 'N/A'
      ];
    });

    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `binance_emas_scan_${selectedTimeframe}_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadJSON = () => {
    if (scannedCoins.length === 0) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(filteredAndSortedCoins, null, 2));
    const link = document.createElement("a");
    link.setAttribute("href", dataStr);
    link.setAttribute("download", `binance_emas_scan_${selectedTimeframe}_${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Main scan runner
  const startScanningProcess = async () => {
    if (progress.status === 'scanning' || progress.status === 'fetching_pairs') return;
    cancelScanRef.current = false;
    
    setProgress({
      status: 'fetching_pairs',
      currentSymbol: 'Anclando Contratos...',
      processedCount: 0,
      totalCount: 100
    });

    try {
      const topTickers = await fetchTop100Symbols();
      const limit = Math.min(topTickers.length, 100);
      const targets = topTickers.slice(0, limit);

      setProgress({
        status: 'scanning',
        currentSymbol: targets[0]?.symbol || '',
        processedCount: 0,
        totalCount: limit
      });

      // Clear list before starting or scan as overlays
      const scannedListAccumulator: CoinScanResult[] = [];
      setScannedCoins([]);

      // Multi-concurrency queue runner
      let index = 0;
      const runWorker = async () => {
        while (index < targets.length && !cancelScanRef.current) {
          const currentIdx = index++;
          const coinData = targets[currentIdx];
          
          setProgress(prev => ({
            ...prev,
            currentSymbol: coinData.symbol,
            processedCount: currentIdx + 1
          }));

          try {
            const scanResult = await scanSingleSymbol(coinData, activeTimeframes);
            if (scanResult && !cancelScanRef.current) {
              scannedListAccumulator.push(scanResult);
              // Real-time progressive append to results
              setScannedCoins([...scannedListAccumulator]);
            }
          } catch (err) {
            console.error(`Error scanning ${coinData.symbol}:`, err);
          }

          // Small delay between tokens to avoid hitting rate limits
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      };

      // Launch worker threads based on user concurrency setting
      const workers = Array.from({ length: concurrency }, () => runWorker());
      await Promise.all(workers);

      if (cancelScanRef.current) {
        setProgress(prev => ({
          ...prev,
          status: 'idle',
          currentSymbol: 'Escaneo Cancelado'
        }));
      } else {
        setProgress(prev => ({
          ...prev,
          status: 'completed',
          currentSymbol: 'Completado con éxito'
        }));
        setLastScanTime(new Date().toLocaleTimeString());
      }

    } catch (err: any) {
      console.error('Core scan flow failed:', err);
      setProgress({
        status: 'error',
        currentSymbol: '',
        processedCount: 0,
        totalCount: 0,
        errorMessage: err?.message || 'Error de conexión con Binance'
      });
    }
  };

  const cancelScanning = () => {
    cancelScanRef.current = true;
    setProgress(prev => ({
      ...prev,
      status: 'idle',
      currentSymbol: 'Cancelando...'
    }));
  };

  // Helper rating ordering value to structure list groups
  // Golden Cross (1) > Bullish (2) > Dead Cross (3) > Bearish (4)
  const getTrendRankValue = (rating: string): number => {
    switch (rating) {
      case 'golden_cross': return 1;
      case 'rose_cross':
      case 'dead_cross': return 3;
      case 'bullish': return 2;
      case 'bearish': return 4;
      default: return 5;
    }
  };

  // List processing (Search, Filter and Sorting)
  const filteredAndSortedCoins = scannedCoins
    .filter(coin => {
      // 1. Search Query Match
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          coin.symbol.toLowerCase().includes(q) || 
          coin.name.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .filter(coin => {
      // 2. Trend Filter Match
      if (selectedTrendFilter === 'all') return true;
      const tfData = coin.timeframes[selectedTimeframe];
      return tfData ? tfData.overallRating === selectedTrendFilter : false;
    })
    .sort((a, b) => {
      // 3. Main Sorting algorithm
      const ratingA = a.timeframes[selectedTimeframe]?.overallRating || 'bearish';
      const ratingB = b.timeframes[selectedTimeframe]?.overallRating || 'bearish';

      if (sortMethod === 'crossover_volatility') {
        const rankA = getTrendRankValue(ratingA);
        const rankB = getTrendRankValue(ratingB);
        if (rankA !== rankB) return rankA - rankB; // First sort by structural trend rating
        return b.volatility24h - a.volatility24h; // Secondary sorting by volatility
      }

      if (sortMethod === 'crossover_volume') {
        const rankA = getTrendRankValue(ratingA);
        const rankB = getTrendRankValue(ratingB);
        if (rankA !== rankB) return rankA - rankB; // First sort by structural trend rating
        return b.volume24h - a.volume24h; // Secondary sorting by volume
      }

      if (sortMethod === 'pure_volatility') {
        return b.volatility24h - a.volatility24h; // Direct volatility sorting
      }

      if (sortMethod === 'pure_volume') {
        return b.volume24h - a.volume24h; // Direct volume sorting
      }

      return 0;
    });

  // Toggle timeframe scan inclusion
  const toggleActiveTimeframe = (tf: Timeframe) => {
    if (activeTimeframes.includes(tf)) {
      if (activeTimeframes.length === 1) return; // Need at least one
      setActiveTimeframes(activeTimeframes.filter(t => t !== tf));
    } else {
      setActiveTimeframes([...activeTimeframes, tf]);
    }
  };

  // Extract totals for bottom analytics informational footers
  let totalBulls = 0;
  let totalBears = 0;
  let totalGolds = 0;
  let totalDeads = 0;
  scannedCoins.forEach(coin => {
    const r = coin.timeframes[selectedTimeframe]?.overallRating;
    if (r === 'bullish') totalBulls++;
    else if (r === 'bearish') totalBears++;
    else if (r === 'golden_cross') totalGolds++;
    else if (r === 'dead_cross') totalDeads++;
  });

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-[#e0e0e0] flex flex-col font-sans selection:bg-yellow-500/30 selection:text-yellow-200 antialiased overflow-x-hidden">
      
      {/* Top Notification / Dynamic Pacing Progress Bar */}
      {progress.status !== 'idle' && progress.status !== 'completed' && progress.status !== 'error' && (
        <div className="bg-[#121418] border-b border-[#2a2d33] py-2 px-6 sticky top-0 z-40 animate-fade-in flex items-center justify-between shadow-xl">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500"></span>
            </span>
            <p className="text-[11px] font-mono text-gray-400">
              {progress.status === 'fetching_pairs' ? 'Anclando Tickers...' : `Sincronizando: ${progress.currentSymbol}`} 
              <span className="text-yellow-500 ml-2">({progress.processedCount}/{progress.totalCount} completados)</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-24 md:w-48 bg-zinc-800 rounded h-1.5 overflow-hidden border border-zinc-700/60">
              <div 
                className="bg-yellow-500 h-full transition-all duration-300"
                style={{ width: `${(progress.processedCount / (progress.totalCount || 1)) * 100}%` }}
              ></div>
            </div>
            <button 
              onClick={cancelScanning}
              className="flex items-center gap-1.5 px-2.5 py-0.5 bg-red-500/15 hover:bg-red-500/25 text-red-400 text-[10px] font-bold rounded border border-red-500/20 transition-all cursor-pointer font-mono"
            >
              ✕ DETENER
            </button>
          </div>
        </div>
      )}

      {/* Primary Header Segment */}
      <header className="h-14 border-b border-[#2a2d33] bg-[#121418] flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-yellow-500 rounded flex items-center justify-center font-bold text-black font-sans text-base">B</div>
          <h1 className="text-sm sm:text-base font-extrabold tracking-tight uppercase text-white font-sans">
            BINANCE <span className="text-yellow-500">FUTURES</span> MULTI-EMA SCANNER
          </h1>
          <div className="hidden lg:flex ml-3 gap-1.5 items-center">
            <span className="px-1.5 py-0.5 rounded border border-[#3a3f4b] bg-[#1c1f26] text-[9px] text-gray-400 font-mono">LIVE MATRIX</span>
            {wsStatus === 'connected' && <span className="px-1.5 py-0.5 rounded border border-green-900/40 bg-green-900/10 text-[9px] text-green-400 font-mono animate-pulse">WS ACTIVE</span>}
            {wsStatus === 'connecting' && <span className="px-1.5 py-0.5 rounded border border-yellow-900/40 bg-yellow-900/10 text-[9px] text-yellow-500 font-mono">WS RECONNECT</span>}
            {wsStatus === 'disconnected' && <span className="px-1.5 py-0.5 rounded border border-red-900/40 bg-red-900/10 text-[9px] text-red-500 font-mono">WS DEAD</span>}
          </div>
        </div>
        
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <div className="hidden sm:flex flex-col items-end leading-tight">
            <span className="text-gray-500 uppercase text-[9px]">VOLATILITY POOL</span>
            <span className="text-white text-xs font-bold">100 CANDIDATOS</span>
          </div>
          <div className="hidden sm:block h-8 w-[1px] bg-[#2a2d33]"></div>
          <div className="flex flex-col items-end leading-tight">
            <span className="text-gray-500 uppercase text-[9px]">COMPLETADO</span>
            <span className="text-yellow-500 text-xs font-bold">{scannedCoins.length} / 100</span>
          </div>
          <div>
            {progress.status === 'scanning' || progress.status === 'fetching_pairs' ? (
              <button
                onClick={cancelScanning}
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 text-white font-bold h-7 px-3 rounded text-[10px] transition-all cursor-pointer font-mono"
              >
                <Square className="w-3 h-3 text-white fill-white" /> PARAR
              </button>
            ) : (
              <button
                onClick={startScanningProcess}
                className="flex items-center gap-1.5 bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-7 px-3 rounded text-[10px] transition-all shadow-md cursor-pointer font-mono"
              >
                <Play className="w-3 h-3 text-black fill-black" /> ESCANEAR
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Control Navigation Menu */}
      <nav className="h-12 border-b border-[#2a2d33] bg-[#0f1115] flex items-center justify-between px-6 shrink-0 gap-4 flex-wrap">
        <div className="flex gap-1 h-full items-center text-[11px] font-mono">
          <button 
            onClick={() => setSelectedTrendFilter('all')}
            className={`font-bold h-full px-3 transition-all ${selectedTrendFilter === 'all' ? 'text-yellow-500 border-b-2 border-yellow-500 bg-[#1c1f26]/20' : 'text-gray-500 hover:text-gray-300'}`}
          >
            ALL COINS
          </button>
          <button 
            onClick={() => setSelectedTrendFilter('golden_cross')}
            className={`font-bold h-full px-3 transition-all ${selectedTrendFilter === 'golden_cross' ? 'text-yellow-500 border-b-2 border-yellow-500 bg-[#1c1f26]/20' : 'text-gray-500 hover:text-gray-300'}`}
          >
            ★ GOLDEN CROSS
          </button>
          <button 
            onClick={() => setSelectedTrendFilter('dead_cross')}
            className={`font-bold h-full px-3 transition-all ${selectedTrendFilter === 'dead_cross' ? 'text-fuchsia-400 border-b-2 border-fuchsia-400 bg-[#1c1f26]/20' : 'text-gray-500 hover:text-gray-300'}`}
          >
            💀 DEAD CROSS
          </button>
          <button 
            onClick={() => setSelectedTrendFilter('bullish')}
            className={`font-bold h-full px-3 transition-all ${selectedTrendFilter === 'bullish' ? 'text-green-400 border-b-2 border-green-400 bg-[#1c1f26]/20' : 'text-gray-500 hover:text-gray-300'}`}
          >
            📈 BULLISH
          </button>
          <button 
            onClick={() => setSelectedTrendFilter('bearish')}
            className={`font-bold h-full px-3 transition-all ${selectedTrendFilter === 'bearish' ? 'text-red-400 border-b-2 border-red-400 bg-[#1c1f26]/20' : 'text-gray-500 hover:text-gray-300'}`}
          >
            📉 BEARISH
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Quick Filter Box */}
          <div className="relative">
            <span className="absolute inset-y-0 left-2.5 flex items-center pointer-events-none text-zinc-500">
              <Search className="w-3.5 h-3.5" />
            </span>
            <input
              type="text"
              placeholder="Buscar símbolo..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-[#1c1f26] border border-[#2a2d33] text-[11px] font-mono rounded px-2.5 py-1 pl-7 text-white focus:outline-none focus:border-yellow-500 w-36 placeholder:text-zinc-600"
            />
          </div>

          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500 animate-pulse"></div>
            <span className="text-[10px] text-gray-400 font-mono hidden md:inline">PACING: 150MS/PAIR</span>
          </div>
        </div>
      </nav>

      {/* Custom Sub-Legend Segment */}
      <section className="bg-[#14161b] px-6 py-2 border-b border-[#2a2d33] flex flex-wrap gap-y-2 items-center justify-between shrink-0">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] items-center">
          <span className="text-gray-500 uppercase font-black tracking-wider text-[9px]">FILA DE CRUCES MATRIZ:</span>
          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#34d399]"></span> EMA 9/18 (Cruce 1)</div>
          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#60a5fa]"></span> EMA 27/36 (Cruce 2)</div>
          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#a78bfa]"></span> EMA 45/56 (Cruce 3)</div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] items-center">
          <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.6)]"></span> BULLISH</div>
          <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500"></span> BEARISH</div>
          <div className="flex items-center gap-1"><span className="text-yellow-500 font-bold">★</span> GOLDEN CROSS</div>
          <div className="flex items-center gap-1"><span className="text-fuchsia-400 font-bold">💀</span> DEAD CROSS</div>
        </div>
      </section>

      {/* Main Container */}
      <main className="flex-1 w-full mx-auto px-6 py-4 space-y-4">
        
        {/* Configurations bar */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 bg-[#121418] border border-[#2a2d33] rounded">
          {/* Active intervals configuration */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <span className="text-[9px] uppercase font-mono tracking-wider text-gray-400 font-black">TEMPORALIDADES ACTIVAS:</span>
            <div className="flex flex-wrap gap-1">
              {(['3m', '5m', '15m', '30m', '1h', '4h'] as Timeframe[]).map((tf) => {
                const isActive = activeTimeframes.includes(tf);
                return (
                  <button
                    key={tf}
                    disabled={progress.status === 'scanning'}
                    onClick={() => toggleActiveTimeframe(tf)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono font-extrabold transition-all border ${
                      isActive 
                        ? 'bg-[#1c1f26] text-yellow-500 border-yellow-500/40' 
                        : 'bg-transparent border-[#2a2d33] text-gray-600 hover:text-gray-400 disabled:opacity-30'
                    }`}
                  >
                    {tf} {isActive ? '✓' : ''}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Sort method & Current selection view */}
          <div className="flex flex-wrap items-center gap-3 md:justify-end">
            <div className="flex items-center gap-1 bg-[#101216] px-2 py-1 rounded border border-[#2a2d33] text-xs font-mono">
              <span className="text-[9px] text-gray-500 uppercase font-bold mr-1">EVALUACIÓN PILOTO:</span>
              <div className="flex gap-0.5">
                {(['3m', '5m', '15m', '30m', '1h', '4h'] as Timeframe[]).map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setSelectedTimeframe(tf)}
                    className={`py-0.5 px-2 rounded font-bold text-[10px] ${
                      selectedTimeframe === tf 
                        ? 'bg-yellow-500 text-black' 
                        : 'text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 bg-[#101216] px-2 py-1.5 rounded border border-[#2a2d33] text-xs font-mono">
              <span className="text-[9px] text-gray-500 uppercase font-bold">ORDEN:</span>
              <select
                value={sortMethod}
                onChange={(e) => setSortMethod(e.target.value as any)}
                className="bg-transparent text-[10px] font-black text-white outline-none cursor-pointer uppercase p-0"
              >
                <option value="crossover_volatility">⚖️ CRUCES + VOLATILIDAD</option>
                <option value="crossover_volume">📊 CRUCES + VOLUMEN</option>
                <option value="pure_volatility">⚡ SOLO VOLATILIDAD</option>
                <option value="pure_volume">💰 SOLO VOLUMEN</option>
              </select>
            </div>

            {scannedCoins.length > 0 && (
              <div className="flex items-center gap-1 bg-[#101216] px-2 py-1 rounded border border-[#2a2d33] text-xs font-mono">
                <span className="text-[9px] text-gray-500 uppercase font-bold mr-1.5">EXPORTAR:</span>
                <button
                  onClick={downloadCSV}
                  className="px-2 py-0.5 rounded text-[10px] font-black bg-[#1a1c21] text-yellow-500 hover:text-black hover:bg-yellow-500 transition-all cursor-pointer border border-yellow-500/20 hover:border-transparent font-mono"
                  title="Descargar tabla en formato CSV (Excel)"
                >
                  📥 CSV
                </button>
                <button
                  onClick={downloadJSON}
                  className="px-2 py-0.5 rounded text-[10px] font-black bg-[#1a1c21] text-blue-400 hover:text-black hover:bg-blue-400 transition-all cursor-pointer border border-blue-400/20 hover:border-transparent font-mono"
                  title="Descargar tabla en formato JSON"
                >
                  📥 JSON
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Metric Cards */}
        <MetricCards scannedList={scannedCoins} selectedTimeframe={selectedTimeframe} />

        {/* Main Grid table card */}
        <div className="bg-[#121418] border border-[#2a2d33] rounded overflow-hidden shadow-2xl">
          
          <div className="overflow-x-auto">
            {scannedCoins.length === 0 ? (
              <div className="py-20 flex flex-col items-center justify-center p-6 text-center space-y-4">
                <div className="p-4 bg-[#0a0b0d] rounded border border-[#2a2d33] text-zinc-600">
                  <Zap className="w-10 h-10 text-yellow-500/30" />
                </div>
                <div>
                  <h4 className="text-zinc-300 font-bold text-sm uppercase">Sin Registros</h4>
                  <p className="text-xs text-zinc-500 mt-1 max-w-sm">Haz clic en "ESCANEAR" para analizar el mercado de futuros de Binance en tiempo real.</p>
                </div>
                <button
                  type="button"
                  onClick={startScanningProcess}
                  className="px-4 py-2 bg-yellow-500 hover:bg-yellow-400 text-xs font-black font-mono text-black rounded transition-all shadow"
                >
                  INICIAR ESCANEO DE MERCADO
                </button>
              </div>
            ) : filteredAndSortedCoins.length === 0 ? (
              <div className="py-20 text-center space-y-2">
                <AlertTriangle className="w-8 h-8 text-amber-500/40 mx-auto" />
                <h4 className="text-zinc-400 font-bold text-sm uppercase">Sin Resultados</h4>
                <p className="text-xs text-gray-500 font-mono">No hay activos que cumplan con el filtro "{selectedTrendFilter}" en este momento.</p>
              </div>
            ) : (
              <table className="w-full border-collapse text-left text-xs text-zinc-400">
                <thead className="sticky top-0 bg-[#0c0d0e] border-b border-[#2a2d33] z-10">
                  <tr className="text-[10px] text-gray-500 font-mono uppercase">
                    <th scope="col" className="py-3 px-6 font-semibold w-48">Activo / Volatilidad</th>
                    {['3m', '5m', '15m', '30m', '1h', '4h'].map(tf => (
                      <th 
                        key={tf} 
                        scope="col" 
                        className={`py-3 px-2 text-center font-bold border-l border-[#1a1c21] ${
                          selectedTimeframe === tf ? 'bg-[#1c1f26]/40 text-yellow-500' : ''
                        }`}
                      >
                        {tf} {selectedTimeframe === tf ? '👁️' : ''}
                      </th>
                    ))}
                    <th scope="col" className="py-3 px-6 text-right font-medium w-48 border-l border-[#1a1c21]">Vol/Volume Ratio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1c21]">
                  {filteredAndSortedCoins.map((coin, index) => {
                    const primaryEval = coin.timeframes[selectedTimeframe];
                    
                    // Ratio math
                    const volRatio = (coin.volatility24h * 1.5) + (coin.change24h < 0 ? -coin.change24h : coin.change24h);
                    const finalRatioPercent = Math.min(Math.round((volRatio / 15) * 100), 100);

                    // Color for ratio progress bar
                    let ratioBarColor = 'bg-yellow-500';
                    if (finalRatioPercent > 70) ratioBarColor = 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.6)]';
                    else if (finalRatioPercent > 40) ratioBarColor = 'bg-orange-500';

                    return (
                      <tr 
                        key={coin.symbol} 
                        className="hover:bg-[#1c1f26] transition-colors cursor-pointer group"
                        onClick={() => setSelectedCoinSymbol(coin.symbol)}
                      >
                        
                        {/* Core Asset details column */}
                        <td className="py-3 px-6">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-600 font-mono text-[10px] font-bold w-5 text-right">{index + 1}</span>
                            <div className="flex items-center gap-2">
                              <span className="group-hover:text-yellow-500 transition-colors font-extrabold text-[#e0e0e0] font-sans text-xs">
                                {coin.name}<span className="text-gray-600 text-[10px]">USDT</span>
                              </span>
                              
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPreviewCoinglassSymbol(coin.symbol);
                                }}
                                className="text-gray-500 hover:text-blue-400 transition-colors cursor-pointer"
                                title="Ver gráfico en Coinglass"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </button>
                              
                              {primaryEval && (
                                <span className={`px-1.5 py-0.5 text-[8px] rounded font-bold uppercase tracking-wider ${
                                  primaryEval.overallRating === 'golden_cross' ? 'bg-yellow-500/10 text-yellow-500' :
                                  primaryEval.overallRating === 'dead_cross' ? 'bg-fuchsia-500/10 text-fuchsia-400' :
                                  primaryEval.overallRating === 'bullish' ? 'bg-green-500/10 text-green-500' :
                                  'bg-red-500/10 text-red-500'
                                }`}>
                                  {primaryEval.overallRating === 'golden_cross' ? 'GOLDEN' :
                                   primaryEval.overallRating === 'dead_cross' ? 'DEAD' :
                                   primaryEval.overallRating}
                                </span>
                              )}
                            </div>
                          </div>
                          
                          <div className="text-[10px] text-gray-500 mt-1 font-mono">
                            Price: <PriceDisplay price={coin.price} /> 
                            <span className={`ml-2 font-bold ${coin.change24h >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                              {coin.change24h >= 0 ? '+' : ''}{coin.change24h.toFixed(2)}%
                            </span>
                          </div>
                        </td>

                        {/* 6 Timeframes evaluation using the ThreeDot structure */}
                        {['3m', '5m', '15m', '30m', '1h', '4h'].map(tf => {
                          const tfData = coin.timeframes[tf];
                          return (
                            <td 
                              key={tf} 
                              className={`py-3 px-2 border-l border-[#1a1c21] transition-all ${
                                selectedTimeframe === tf ? 'bg-yellow-500/5' : ''
                              }`}
                            >
                              <TimeframeCrossDots data={tfData} />
                            </td>
                          );
                        })}

                        {/* Ratio volatility bar */}
                        <td className="py-3 px-6 text-right border-l border-[#1a1c21]">
                          <div className="w-full max-w-[120px] bg-[#1a1c21] h-1 rounded-full overflow-hidden mt-1 ml-auto">
                            <div className={`h-full ${ratioBarColor}`} style={{ width: `${Math.max(8, finalRatioPercent)}%` }}></div>
                          </div>
                          <span className={`text-[10px] font-mono mt-1 block font-bold ${finalRatioPercent > 75 ? 'text-yellow-500' : finalRatioPercent > 45 ? 'text-orange-400' : 'text-gray-500'}`}>
                            {(volRatio / 10).toFixed(3)} Vol/Vol <span className="text-[9px] text-gray-600 font-normal">({coin.volatility24h.toFixed(1)}%)</span>
                          </span>
                        </td>

                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Info bar counts */}
          {scannedCoins.length > 0 && (
            <div className="bg-[#0f1115] font-mono text-[9px] text-[#5c616d] px-6 py-2 border-t border-[#2a2d33] flex justify-between items-center select-none uppercase">
              <span>Mapeado de cruces: EMA (9/18, 27/36, 45/56)</span>
              <span>Filtradas: {filteredAndSortedCoins.length} / total: {scannedCoins.length} contratos</span>
            </div>
          )}

        </div>

      </main>

      {/* Selected Coin full details panel */}
      {selectedCoinSymbol && scannedCoins.find(c => c.symbol === selectedCoinSymbol) && (
        <CoinDetail 
          coin={scannedCoins.find(c => c.symbol === selectedCoinSymbol)!} 
          selectedTimeframe={selectedTimeframe} 
          onClose={() => setSelectedCoinSymbol(null)} 
          onOpenCoinglass={(symbol) => setPreviewCoinglassSymbol(symbol)}
        />
      )}

      {/* Coinglass iframe modal */}
      {previewCoinglassSymbol && (
        <div className="fixed inset-0 bg-[#000]/90 backdrop-blur-sm flex flex-col items-center justify-center p-4 md:p-10 z-[100] animate-fade-in">
          <div className="w-full max-w-6xl h-full bg-[#121418] border border-[#2a2d33] rounded-lg shadow-2xl flex flex-col overflow-hidden animate-scale-up">
            <div className="bg-[#1c1f26] px-5 py-3 border-b border-[#2a2d33] flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black font-sans text-white tracking-tight">Coinglass: {previewCoinglassSymbol}</h2>
              </div>
              <button 
                onClick={() => setPreviewCoinglassSymbol(null)}
                className="text-gray-400 hover:text-white bg-[#121418] hover:bg-rose-600 hover:text-white px-3 py-1.5 rounded border border-[#2a2d33] transition-colors text-xs font-bold cursor-pointer font-mono"
              >
                ✕ Cerrar
              </button>
            </div>
            <div className="flex-1 w-full relative">
              <iframe 
                src={`https://www.coinglass.com/tv/es/Binance_${previewCoinglassSymbol}`} 
                className="absolute inset-0 w-full h-full border-0"
                title={`Coinglass ${previewCoinglassSymbol}`}
                allow="fullscreen"
              ></iframe>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Analytics Bar */}
      <footer className="h-10 bg-[#0f1115] border-t border-[#2a2d33] flex items-center px-6 shrink-0 justify-between select-none font-mono text-[10px]">
        <div className="flex items-center gap-6 text-gray-400">
          <div className="flex items-center gap-1.5">
            <span className="text-gray-600 uppercase">BULLS:</span>
            <span className="text-green-500 font-bold">{totalBulls}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-gray-600 uppercase">BEARS:</span>
            <span className="text-red-500 font-bold">{totalBears}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-gray-600 uppercase">CROSSES:</span>
            <span className="text-yellow-500 font-bold">{totalGolds} Gold</span> / <span className="text-fuchsia-400 font-bold">{totalDeads} Dead</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-gray-400">
          <span className="text-gray-600">Último escaneo completo: <span className="text-gray-400">{lastScanTime}</span></span>
          <button 
            onClick={startScanningProcess}
            className="px-3 h-6 bg-[#2a2d33] rounded text-white font-bold hover:bg-[#3a3f4b] transition-all cursor-pointer text-[9px]"
          >
            FORZAR ESCANEO
          </button>
        </div>
      </footer>

    </div>
  );
}

function TimeframeCrossDots({ data }: { data: any }) {
  if (!data) return <div className="flex justify-center"><span className="text-[10px] text-zinc-700 font-mono">-</span></div>;

  const renderDot = (cross: any, colorClass: string) => {
    switch (cross.value) {
      case 'golden_cross':
        return <span className="text-[11px] leading-none text-yellow-500 px-0.5" title={`Golden Cross! (EMA hace ${cross.barsAgo} velas)`}>★</span>;
      case 'dead_cross':
        return <span className="text-[10px] leading-none text-fuchsia-400 px-0.5" title={`Dead Cross! (EMA hace ${cross.barsAgo} velas)`}>💀</span>;
      case 'bullish':
        return <span className="text-[10px] leading-none px-0.5 text-green-400" title="Bullish Alignment" style={{textShadow: '0 0 4px rgba(74, 222, 128, 0.4)'}}>✔️</span>;
      case 'bearish':
        return <span className="text-[10px] leading-none px-0.5 text-red-500" title="Bearish Alignment" style={{textShadow: '0 0 4px rgba(239, 68, 68, 0.4)'}}>❌</span>;
      default:
        return <div className="w-1.5 h-1.5 rounded-full bg-[#1c1f26]" />;
    }
  };

  return (
    <div className="flex justify-center items-center gap-1.5 py-1">
      {renderDot(data.cross9_18, 'bg-[#34d399]')}
      {renderDot(data.cross27_36, 'bg-[#60a5fa]')}
      {renderDot(data.cross45_56, 'bg-[#a78bfa]')}
    </div>
  );
}

function CompactTrendBadge({ value }: { value: CoinScanResult['timeframes'][string]['overallRating'] }) {
  const stylesObj = {
    golden_cross: 'bg-emerald-500/20 text-emerald-300 font-black tracking-tight text-[10px] border border-emerald-500/20 shadow-md shadow-emerald-500/5',
    bullish: 'bg-green-500/10 text-green-400 font-semibold text-[9px]',
    dead_cross: 'bg-rose-500/20 text-rose-300 font-black tracking-tight text-[10px] border border-rose-500/20 shadow-md shadow-rose-500/5',
    bearish: 'bg-red-500/10 text-red-400 font-semibold text-[9px]',
  };

  const labelObj = {
    golden_cross: '✨ GOLDEN',
    bullish: 'BULL',
    dead_cross: '🥀 DEAD',
    bearish: 'BEAR',
  };

  return (
    <span className={`px-2 py-1 rounded-lg font-mono tracking-wide ${stylesObj[value]}`}>
      {labelObj[value]}
    </span>
  );
}
