import { useEffect, useMemo, useRef, useState } from 'react';

type RaceGifOverlayProps = {
  // When true, overlay remains hidden and timers are paused (e.g., during settle.gif window)
  disabled?: boolean;
};

// Desktop-only overlay of randomized race GIFs, styled identically to settle.gif
export default function RaceGifOverlay({ disabled = false }: RaceGifOverlayProps) {
  const GIF_FILES = useMemo(() => Array.from({ length: 9 }, (_, i) => `/race${i + 1}.gif`), []);

  // Visibility and selection state
  const [isVisible, setIsVisible] = useState(false);
  const [gifIndex, setGifIndex] = useState<number | null>(null);
  const lastGifIndexRef = useRef<number | null>(null);
  const cacheBustRef = useRef<number>(Date.now());

  // Timers
  const playTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  // Config: approximate each GIF loop as ~1s; keep GIFs visible longer
  const PLAY_LOOPS = 16; // ~16s visible
  const ESTIMATED_LOOP_MS = 1000; // If actual GIFs differ, this still yields a reasonable duration
  const PLAY_DURATION_MS = PLAY_LOOPS * ESTIMATED_LOOP_MS; // ~16s of visible time

  // Idle (downtime) between GIF plays
  const IDLE_MIN_MS = 8000;
  const IDLE_MAX_MS = 16000;

  const clearTimers = () => {
    if (playTimerRef.current) {
      window.clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  const pickNextGifIndex = (prev: number | null): number => {
    if (GIF_FILES.length <= 1) return 0;
    let idx = Math.floor(Math.random() * GIF_FILES.length);
    if (prev !== null && GIF_FILES.length > 1) {
      // Ensure we do not repeat the same GIF twice in a row
      while (idx === prev) {
        idx = Math.floor(Math.random() * GIF_FILES.length);
      }
    }
    return idx;
  };

  const scheduleIdleThenPlay = () => {
    // Schedule downtime before next play window
    const idleMs = IDLE_MIN_MS + Math.floor(Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS));
    idleTimerRef.current = window.setTimeout(() => {
      const nextIdx = pickNextGifIndex(lastGifIndexRef.current);
      lastGifIndexRef.current = nextIdx;
      setGifIndex(nextIdx);
      cacheBustRef.current = Date.now(); // force reload to restart GIF
      setIsVisible(true);

      // After play duration, hide and schedule next idle period
      playTimerRef.current = window.setTimeout(() => {
        setIsVisible(false);
        scheduleIdleThenPlay();
      }, PLAY_DURATION_MS) as unknown as number;
    }, idleMs) as unknown as number;
  };

  useEffect(() => {
    if (disabled) {
      setIsVisible(false);
      clearTimers();
      return;
    }
    // Start cycle if not already scheduled
    if (!idleTimerRef.current && !playTimerRef.current) {
      scheduleIdleThenPlay();
    }
    return () => clearTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  if (!isVisible || gifIndex === null || disabled) {
    return null;
  }

  const src = `${GIF_FILES[gifIndex]}?t=${cacheBustRef.current}`;

  return (
    <div className="relative aspect-square overflow-hidden rounded-lg ring-4 ring-green-500/70 animate-pulse shadow-[0_0_30px_rgba(34,197,94,0.6)]" aria-hidden>
      <img
        src={src}
        alt="Race animation"
        className="w-full h-full object-contain"
      />
      <div className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-green-400/60" />
    </div>
  );
}
