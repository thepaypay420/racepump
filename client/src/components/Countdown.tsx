import { useState, useEffect, useRef } from 'react';

interface CountdownProps {
  targetTime: number;
  onComplete?: () => void;
  className?: string;
  prefix?: string;
}

export default function Countdown({ 
  targetTime, 
  onComplete, 
  className = "",
  prefix = "",
  ...props 
}: CountdownProps) {
  const [timeRemaining, setTimeRemaining] = useState(0);
  const hasCompletedRef = useRef(false);

  useEffect(() => {
    let timeoutId: number | null = null;

    const tick = () => {
      const now = Date.now();
      const remaining = Math.max(0, targetTime - now);
      setTimeRemaining(remaining);

      if (remaining === 0) {
        if (!hasCompletedRef.current) {
          hasCompletedRef.current = true;
          onComplete?.();
        }
        return; // stop scheduling further ticks
      }

      // Align updates to the next second boundary to avoid jitter
      const delayToNextSecond = 1000 - (now % 1000);
      timeoutId = window.setTimeout(tick, delayToNextSecond);
    };

    tick();

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [targetTime, onComplete]);

  // Reset completion flag whenever targetTime changes (e.g., on status transition)
  useEffect(() => {
    hasCompletedRef.current = false;
  }, [targetTime]);

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    if (minutes > 60) {
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours}:${remainingMinutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const isUrgent = timeRemaining <= 60000; // Less than 1 minute

  return (
    <div 
      className={`font-mono font-bold ${
        isUrgent ? 'text-destructive animate-pulse' : 'text-secondary'
      } ${className}`} 
      {...props}
    >
      {isUrgent && <i className="fas fa-exclamation-triangle mr-2"></i>}
      {prefix && <span className="font-normal">{prefix} </span>}
      {formatTime(timeRemaining)}
    </div>
  );
}
