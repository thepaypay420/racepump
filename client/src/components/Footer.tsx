import React from 'react';
import { useStore } from '@/lib/store';

export default function Footer() {
  const { currency } = useStore();
  return (
    <footer className={`relative z-10 border-t border-border backdrop-blur-sm ${currency === 'SOL' ? 'bg-[#0b1226]/30' : 'bg-card/20'}`}>
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-col items-center justify-center gap-4 text-center">
          <div className={`flex items-center gap-2 text-sm ${currency === 'SOL' ? 'text-blue-300' : 'text-muted-foreground'}`}>
            <i className={`fas fa-bolt ${currency === 'SOL' ? 'text-blue-400' : 'text-primary'} neon-glow`}></i>
            <span>RacePump</span>
            <span className="hidden sm:inline">·</span>
            <span className={`text-xs sm:text-sm ${currency === 'SOL' ? 'text-blue-300' : 'text-muted-foreground'}`}>Join the community</span>
          </div>

          <nav aria-label="Social links" className="flex items-center gap-3">
            <a
              href="https://t.me/race_pump"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Telegram"
              className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border/60 text-muted-foreground hover:text-primary hover:border-primary/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <i className="fa-brands fa-telegram"></i>
            </a>
            <a
              href="https://x.com/racepumpfun"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Twitter"
              className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border/60 text-muted-foreground hover:text-primary hover:border-primary/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <i className="fa-brands fa-twitter"></i>
            </a>
            <a
              href="https://pump.fun/coin/t3DyoWzHG7kXkb5VzLnE4ryHgri9KNCv5qZuSsFpump"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Pump.fun"
              className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border/60 text-muted-foreground hover:text-primary hover:border-primary/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <i className="fa-solid fa-pills"></i>
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
