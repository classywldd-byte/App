import { useState, useEffect, useRef } from 'react';

export function PriceDisplay({ price, className }: { price: number; className?: string }) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevPriceRef = useRef(price);

  useEffect(() => {
    if (price > prevPriceRef.current) {
      setFlash('up');
    } else if (price < prevPriceRef.current) {
      setFlash('down');
    }
    prevPriceRef.current = price;

    const timer = setTimeout(() => {
      setFlash(null);
    }, 500); // 500ms flash

    return () => clearTimeout(timer);
  }, [price]);

  return (
    <span 
      className={`${className || ''} transition-colors duration-500 ${
        flash === 'up' ? 'text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 
        flash === 'down' ? 'text-rose-400 drop-shadow-[0_0_8px_rgba(244,63,94,0.8)]' : 
        ''
      }`}
    >
      ${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })}
    </span>
  );
}
