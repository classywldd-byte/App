import { useEffect, useRef } from 'react';
import { createChart, ColorType, CandlestickSeries, LineSeries, IChartApi } from 'lightweight-charts';
import { Kline } from '../types';

interface ChartProps {
  klines: Kline[];
  emas: { values: number[], color: string, label: string }[];
  symbol: string;
  timeframe: string;
  height?: number;
}

export function LightweightChart({ klines, emas, symbol, timeframe, height = 300 }: ChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<any>(null);
  const emaSeriesRefs = useRef<any[]>([]);

  // 1. Initialize the chart, layout & series only when symbol/timeframe changes
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Clean up any old chart instance
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(chartContainerRef.current, {
      layout: { 
        background: { type: ColorType.Solid, color: '#0c0d0e' }, 
        textColor: '#cbd5e1' 
      },
      width: chartContainerRef.current.clientWidth,
      height: height,
      grid: { 
        vertLines: { color: '#1a1c22' }, 
        horzLines: { color: '#1a1c22' } 
      },
      timeScale: {
        borderColor: '#2a2d33',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#2a2d33',
        autoScale: true,
      }
    });

    chartRef.current = chart;

    // Calculate precision dynamically based on latest price to prevent rounding errors
    const latestPrice = klines.length > 0 ? klines[klines.length - 1].c : 1;
    let precision = 2;
    if (latestPrice < 0.00001) precision = 8;
    else if (latestPrice < 0.0001) precision = 7;
    else if (latestPrice < 0.001) precision = 6;
    else if (latestPrice < 0.01) precision = 5;
    else if (latestPrice < 0.1) precision = 4;
    else if (latestPrice < 1) precision = 3;
    else precision = 2;

    const minMove = 1 / Math.pow(10, precision);

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', 
      downColor: '#f43f5e', 
      borderVisible: false, 
      wickUpColor: '#10b981', 
      wickDownColor: '#f43f5e',
      priceFormat: {
        type: 'price',
        precision: precision,
        minMove: minMove,
      }
    });
    
    candleSeriesRef.current = candleSeries;

    // Create EMA line series
    emaSeriesRefs.current = emas.map(ema => {
      const series = chart.addSeries(LineSeries, { 
        color: ema.color, 
        lineWidth: 2, 
        title: ema.label,
        priceFormat: {
          type: 'price',
          precision: precision,
          minMove: minMove,
        }
      });
      return series;
    });

    // Populate initial data on mount
    candleSeries.setData(klines.map(k => ({ 
      time: k.time as any, 
      open: k.o, 
      high: k.h, 
      low: k.l, 
      close: k.c 
    })));

    emas.forEach((ema, idx) => {
      const mappedData = ema.values.map((v, i) => ({ 
        time: klines[i]?.time as any, 
        value: v 
      })).filter(item => item.time !== undefined && typeof item.value === 'number' && !isNaN(item.value));
      emaSeriesRefs.current[idx].setData(mappedData);
    });

    chart.timeScale().fitContent();

    // Resize Observer for auto-fitting width inside flex/grid container changes
    const resizeObserver = new ResizeObserver(entries => {
      if (entries.length === 0 || !chartRef.current) return;
      const { width } = entries[0].contentRect;
      chartRef.current.resize(width, height);
    });

    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      emaSeriesRefs.current = [];
    };
  }, [symbol, timeframe, height]);

  // 2. Real-time updates without destroying/freezing the chart canvas
  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;
    console.log(`[Chart] Updating with ${klines.length} klines`);

    candleSeriesRef.current.setData(klines.map(k => ({ 
      time: k.time as any, 
      open: k.o, 
      high: k.h, 
      low: k.l, 
      close: k.c 
    })));

    emas.forEach((ema, idx) => {
      if (emaSeriesRefs.current[idx]) {
        const mappedData = ema.values.map((v, i) => ({ 
          time: klines[i]?.time as any, 
          value: v 
        })).filter(item => item.time !== undefined && typeof item.value === 'number' && !isNaN(item.value));
        emaSeriesRefs.current[idx].setData(mappedData);
      }
    });
  }, [klines, emas]);

  return <div ref={chartContainerRef} className="w-full h-full relative" style={{ minHeight: `${height}px` }} />;
}
