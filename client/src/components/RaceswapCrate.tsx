import { useMemo, useEffect } from "react";
import { motion, useAnimation } from "framer-motion";
import { cn } from "@/lib/utils";

interface CrateToken {
  mint: string;
  symbol: string;
  logoURI?: string;
}

interface RaceswapCrateProps {
  tokens: CrateToken[];
  landingMint?: string;
  spinning: boolean;
  success?: boolean;
  onLand?: () => void;
  triggerKey: number;
}

export function RaceswapCrate({ tokens, landingMint, spinning, success, onLand, triggerKey }: RaceswapCrateProps) {
  const ITEM_WIDTH = 96; // w-24
  const GAP = 16; // gap-4
  const TOTAL_ITEM_WIDTH = ITEM_WIDTH + GAP;
  const controls = useAnimation();

  // Create a massive reel for "infinite" spin simulation
  // The landing token will be at the very end.
  const reel = useMemo(() => {
    const pool = tokens.length > 0 ? tokens : FALLBACK_TOKENS;
    const filler = [];
    // Create enough items for ~60 seconds of spinning at ~2.5 items/sec = ~150 items
    while (filler.length < 150) {
        filler.push(...pool);
    }
    
    const landing = landingMint ? pool.find((t) => t.mint === landingMint) : pool[0];
    
    // Ensure final reel ends with landing token
    const finalReel = filler.slice(0, 149);
    if (landing) {
      finalReel.push(landing);
    }
    // Add buffer tokens so the reel doesn't end abruptly
    if (pool.length > 0) {
        finalReel.push(...pool.slice(0, 10));
    }
    return finalReel;
  }, [tokens, landingMint]);

  useEffect(() => {
    if (spinning && !success) {
        // Start spinning: Move towards the end slowly (linear)
        // We target index 120 (leaving buffer for the final sprint)
        // Duration 60s means it keeps moving for a long time
        controls.start({
            x: -120 * TOTAL_ITEM_WIDTH,
            transition: { duration: 60, ease: "linear" }
        });
    } else if (success) {
        // Success! Sprint to the landing token (index 149)
        // We constructed the reel such that landing is at index 149
        const finalIndex = 149;
        controls.start({
            x: -finalIndex * TOTAL_ITEM_WIDTH,
            transition: { 
                duration: 2.5, 
                ease: [0.15, 0.85, 0.35, 1] // Ease out
            }
        }).then(() => {
            if (onLand) onLand();
        });
    } else if (!spinning && !success) {
        // Reset
        controls.set({ x: 0 });
    }
  }, [spinning, success, controls, reel.length, TOTAL_ITEM_WIDTH, onLand]);

  return (
    <div className="relative h-32 w-full overflow-hidden rounded-xl border border-white/10 bg-[#0a0b10] shadow-inner">
      {/* Center Marker */}
      <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary/50 z-20 shadow-[0_0_10px_rgba(255,255,0,0.5)]" />
      <div className="absolute inset-y-0 left-1/2 w-24 -translate-x-1/2 bg-gradient-to-b from-transparent via-primary/10 to-transparent z-10 pointer-events-none" />

      <motion.div
        key={triggerKey}
        animate={controls}
        className="flex items-center h-full absolute left-0 top-0"
        style={{ 
            paddingLeft: `calc(50% - ${ITEM_WIDTH / 2}px)`, // Center the first item
            gap: GAP 
        }}
      >
        {reel.map((token, idx) => (
          <div
            key={`${token.mint}-${idx}`}
            className={cn(
              "w-24 h-24 flex-shrink-0 rounded-lg border border-white/5 bg-[#13141b] flex flex-col items-center justify-center gap-2 shadow-lg relative overflow-hidden group",
              // Last item highlight
              idx === reel.length - 1 && success ? "ring-2 ring-primary ring-offset-2 ring-offset-black" : ""
            )}
          >
            {/* Background Glow for rarity effect */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            
            {token.logoURI ? (
              <img src={token.logoURI} alt={token.symbol} className="w-10 h-10 rounded-full object-cover z-10" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold z-10">
                {token.symbol.slice(0, 3)}
              </div>
            )}
            <span className="text-[10px] font-bold text-muted-foreground z-10 uppercase tracking-wider">{token.symbol}</span>
          </div>
        ))}
      </motion.div>
      
      {/* Side Gradients for fade effect */}
      <div className="absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-[#0a0b10] to-transparent z-10 pointer-events-none" />
      <div className="absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[#0a0b10] to-transparent z-10 pointer-events-none" />
    </div>
  );
}

const FALLBACK_TOKENS: CrateToken[] = [
  { mint: "fallback-1", symbol: "RACE" },
  { mint: "fallback-2", symbol: "SOL" },
  { mint: "fallback-3", symbol: "JUP" },
  { mint: "fallback-4", symbol: "USDC" },
  { mint: "fallback-5", symbol: "BONK" },
];
