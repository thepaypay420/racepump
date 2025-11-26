import { useEffect, useRef, useState } from 'react';
import { useParams, useLocation, Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type Race, type ProgressData, type RaceHistoryResponse, type RaceTotals, type UserBets } from '@/lib/api';
import { getRaceDisplayName } from '@shared/race-name';
import { useStore } from '@/lib/store';
import { formatLargeNumber, calculatePayout } from '@/lib/math';
import { playSound, stopMusic, audioManager } from '@/lib/audio';
// Removed crypto import for browser compatibility

interface TimedPricePoint { t: number; v: number }
interface TokenPrice {
  runnerIndex: number;
  priceHistory: TimedPricePoint[];
  currentPrice: number;
  percentageChange: number;
  volatility: number;
}

export default function LiveRace() {
  const { raceId } = useParams();
  const [, setLocation] = useLocation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const startTimeRef = useRef<number>();
  const lastPointSecondRef = useRef<number>(-1);
  
  const [raceProgress, setRaceProgress] = useState(0);
  const [tokenPrices, setTokenPrices] = useState<TokenPrice[]>([]);
  const [raceStarted, setRaceStarted] = useState(false);
  const [raceFinished, setRaceFinished] = useState(false);
  const [winnerIndex, setWinnerIndex] = useState<number | null>(null);
  const [animationComplete, setAnimationComplete] = useState(false);
  // Keep a ref of latest tokenPrices so the canvas animation never reads a stale closure
  const tokenPricesRef = useRef<TokenPrice[]>([]);
  const updateTokenPrices = (
    update: TokenPrice[] | ((prev: TokenPrice[]) => TokenPrice[])
  ) => {
    setTokenPrices((prev) => {
      const next = typeof update === 'function' ? (update as (p: TokenPrice[]) => TokenPrice[])(prev) : update;
      tokenPricesRef.current = next;
      return next;
    });
  };

  const { race, setRace, wallet, currency } = useStore();
  const connected = wallet.connected;

  // Fetch race data
  const { data: raceData, isLoading } = useQuery<Race>({
    queryKey: ['/api/races', raceId],
    enabled: !!raceId,
    refetchInterval: 5000, // backstop in case SSE missed
  });

  // Fetch real-time race progress from GeckoTerminal API with aggressive caching
  const status = raceData?.computedStatus ?? raceData?.status;
  const { data: progressData } = useQuery<ProgressData>({
    queryKey: ['/api/races', raceId, 'progress'],
    enabled: !!raceId && (status === 'LOCKED' || status === 'IN_PROGRESS'),
    refetchInterval: 5000, // backstop in case SSE missed  
    staleTime: 15000, // Consider data fresh for 15 seconds
    gcTime: 120000, // Keep in cache for 2 minutes for better fallback
  });

  // Preload historical series so late viewers see full chart instantly
  const { data: historyData } = useQuery<RaceHistoryResponse>({
    queryKey: ['/api/races', raceId, 'history'],
    enabled: !!raceId && !!raceData,
    refetchOnWindowFocus: false,
    staleTime: 60000,
  });
  
  const { data: totals } = useQuery<RaceTotals | null>({
    queryKey: ['/api/races', raceId, 'totals', currency],
    enabled: !!raceId,
    refetchInterval: 3000,
    queryFn: async () => {
      if (!raceId) return null;
      const response = await fetch(`/api/races/${raceId}/totals?currency=${currency}`);
      const data = await response.json();
      return data as RaceTotals;
    }
  });

  const { data: userBets, isLoading: userBetsLoading } = useQuery<UserBets | null>({
    queryKey: ['/api/races', raceId, 'bets', currency, wallet.address],
    enabled: !!wallet.address && !!raceId && connected,
    refetchInterval: 5000,
    queryFn: async () => {
      if (!wallet.address || !raceId || !connected) return null;
      const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
      const url = new URL(`/api/races/${raceId}/bets`, baseUrl);
      url.searchParams.set('wallet', wallet.address);
      url.searchParams.set('currency', currency);
      const resp = await fetch(url.pathname + url.search);
      if (!resp.ok) {
        throw new Error('Failed to fetch user bets');
      }
      const data = await resp.json();
      return data as UserBets;
    }
  });

  // Initialize token prices when race data loads and merge in history whenever it arrives
  useEffect(() => {
    if (!raceData?.runners) return;
    // Prefer server-provided history; fallback to baseline-only
    const initialPrices = raceData.runners.map((runner, index) => {
      const hist = historyData?.runners?.find(r => r.runnerIndex === index)?.points || [{ t: 0, v: 1 }];
      const last = hist[hist.length - 1] || { t: 0, v: 1 };
      const pct = (last.v - 1) * 100;
      return {
        runnerIndex: index,
        priceHistory: hist,
        currentPrice: last.v,
        percentageChange: Number.isFinite(pct) ? pct : (runner.priceChange || 0),
        volatility: 0,
      };
    });

    updateTokenPrices((prev) => {
      // First time: set from history immediately
      if (!prev || prev.length === 0) {
        return initialPrices;
      }
      // Merge later-arriving history with any live-updated points
      const merged = prev.map((prevTp, index) => {
        const hist = historyData?.runners?.find(r => r.runnerIndex === index)?.points;
        if (!hist || hist.length === 0) return prevTp;
        const lastHistT = hist[hist.length - 1]?.t ?? -1;
        // Append any points that occurred after the historical series endpoint
        const tail = prevTp.priceHistory.filter(p => p.t > lastHistT);
        const combined = [...hist, ...tail];
        const lastPoint = combined[combined.length - 1] || { t: 0, v: 1 };
        return {
          ...prevTp,
          priceHistory: combined,
          currentPrice: lastPoint.v,
          percentageChange: (lastPoint.v - 1) * 100,
        };
      });
      return merged;
    });

    setRace({ currentRace: raceData });
    console.log('Initialized/merged chart history for', raceData.runners.length, 'tokens');
  }, [raceData, setRace, historyData]);
  
  useEffect(() => {
    if (totals !== undefined) {
      setRace({ raceTotals: totals ?? null });
    }
  }, [totals, setRace]);

  useEffect(() => {
    if (!connected) {
      setRace({ userBets: null });
      return;
    }
    if (userBets !== undefined) {
      setRace({ userBets: userBets ?? null });
    }
  }, [connected, userBets, setRace]);

  // Update token prices with real GeckoTerminal API data during live race
  useEffect(() => {
    if (progressData?.priceChanges && (raceData?.status === 'LOCKED' || raceData?.status === 'IN_PROGRESS')) {
      console.log('Updating chart with GeckoTerminal API data - SSE leader:', progressData.currentLeader?.symbol, progressData.currentLeader?.priceChange + '%');
      
      const updatedPrices = tokenPricesRef.current.map((price, index) => {
        const runner = raceData.runners[index];
        const priceChange = progressData.priceChanges?.find((pc: any) => 
          runner?.mint === pc.mint
        );
        
        if (priceChange) {
          const newPrice = 1 + (priceChange.priceChange / 100);
          const serverLockedTs = raceData.lockedTs || raceData.startTs;
          const elapsedSec = Math.max(0, Math.floor((Date.now() - serverLockedTs) / 1000));
          const lastPoint = price.priceHistory[price.priceHistory.length - 1];
          const lastPrice = lastPoint?.v ?? 1;
          const shouldRecord = Math.abs(newPrice - lastPrice) > 0.0001 || (lastPoint?.t ?? -1) < elapsedSec;
          let newHistory = price.priceHistory.slice();
          if (shouldRecord) {
            if (lastPoint && lastPoint.t === elapsedSec) {
              newHistory[newHistory.length - 1] = { t: elapsedSec, v: newPrice };
            } else {
              newHistory = [...newHistory, { t: elapsedSec, v: newPrice }];
            }
            newHistory = newHistory.slice(-2000); // Keep up to ~33 minutes of per-second points
          }
            
          return {
            ...price,
            priceHistory: newHistory,
            currentPrice: newPrice,
            percentageChange: priceChange.priceChange
          };
        }
        return price;
      });
      
      updateTokenPrices(updatedPrices);
    } else if (!progressData?.priceChanges && (raceData?.status === 'LOCKED' || raceData?.status === 'IN_PROGRESS')) {
      // Fallback: Use SSE race data when GeckoTerminal API is unavailable
      console.log('GeckoTerminal API unavailable - using SSE data for chart');
      if (race.currentRace?.runners) {
        const fallbackPrices = tokenPricesRef.current.map((price, index) => {
          const runner = race.currentRace?.runners[index];
          if (runner) {
            const realPriceChange = runner.priceChange || 0;
            const priceValue = 1 + (realPriceChange / 100);
            
            const serverLockedTs = raceData?.lockedTs || raceData?.startTs || Date.now();
            const elapsedSec = Math.max(0, Math.floor((Date.now() - serverLockedTs) / 1000));
            const lastPoint = price.priceHistory[price.priceHistory.length - 1];
            const lastPrice = lastPoint?.v ?? 1;
            let newHistory = price.priceHistory.slice();
            if (Math.abs(priceValue - lastPrice) > 0.0001 || (lastPoint?.t ?? -1) < elapsedSec) {
              if (lastPoint && lastPoint.t === elapsedSec) {
                newHistory[newHistory.length - 1] = { t: elapsedSec, v: priceValue };
              } else {
                newHistory = [...newHistory, { t: elapsedSec, v: priceValue }];
              }
              newHistory = newHistory.slice(-2000);
            }
              
            return {
              ...price,
              priceHistory: newHistory,
              currentPrice: priceValue,
              percentageChange: realPriceChange
            };
          }
          return {
            ...price,
            priceHistory: price.priceHistory.length > 0 ? price.priceHistory : [{ t: 0, v: 1 }]
          };
        });
        updateTokenPrices(fallbackPrices);
      }
    }
  }, [progressData, raceData?.status, raceData?.runners, race.currentRace?.runners]);

  // Append a point each second so the x position reflects elapsed time, even if price unchanged
  useEffect(() => {
    if (!(raceData?.status === 'LOCKED' || raceData?.status === 'IN_PROGRESS')) return;
    const interval = setInterval(() => {
      if (tokenPricesRef.current.length === 0) return;
      const serverLockedTs = raceData.lockedTs || raceData.startTs || Date.now();
      const seconds = Math.floor((Date.now() - serverLockedTs) / 1000);
      if (seconds <= lastPointSecondRef.current) return;
      lastPointSecondRef.current = seconds;
      updateTokenPrices(prev => prev.map(tp => {
        const lastPoint = tp.priceHistory[tp.priceHistory.length - 1];
        const lastValue = lastPoint?.v ?? 1;
        let history = tp.priceHistory.slice();
        if (lastPoint && lastPoint.t === seconds) {
          history[history.length - 1] = { t: seconds, v: lastValue };
        } else {
          history = [...history, { t: seconds, v: lastValue }];
        }
        return {
          ...tp,
          priceHistory: history.slice(-2000)
        };
      }));
    }, 500);
    return () => clearInterval(interval);
  }, [raceData?.status, tokenPrices.length]);

  // Handle race settlement from both API and SSE store updates
  useEffect(() => {
    // Check for race settlement from API data
    if (raceData?.status === 'SETTLED' && raceData.winnerIndex !== undefined && !raceFinished) {
      console.log('Race settled via API, winner determined:', raceData.runners?.[raceData.winnerIndex]?.symbol);
      setWinnerIndex(raceData.winnerIndex);
      // Don't end animation yet - let it complete naturally
      // setRaceFinished(true); - commented out to allow animation to finish
    }
    // Also check for winner from SSE store updates
    else if (race.winnerIndex !== undefined && race.winnerIndex !== null && !raceFinished) {
      console.log('Race settled via SSE, winner determined:', raceData?.runners?.[race.winnerIndex]?.symbol);
      setWinnerIndex(race.winnerIndex);
      // Don't end animation yet - let it complete naturally
      // setRaceFinished(true); - commented out to allow animation to finish
    }
  }, [raceData?.status, raceData?.winnerIndex, race.winnerIndex, raceId, setLocation, raceFinished]);


  // Canvas animation for price chart
  const animate = (timestamp: number) => {
    if (!canvasRef.current || !raceData || tokenPricesRef.current.length === 0) {
      // Animation setup not ready
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {

    if (!startTimeRef.current) {
      // Align animation clock with actual race elapsed time
      const serverLockedTs = raceData.lockedTs || raceData.startTs;
      const alreadyElapsedMs = Math.max(0, Date.now() - serverLockedTs);
      startTimeRef.current = timestamp - alreadyElapsedMs;
      setRaceStarted(true);
      // Sound removed per user request
    }

    const elapsed = (timestamp - startTimeRef.current) / 1000; // seconds
    // Sync to server timing if available; fallback to 10s testing window
    const serverLockedTs = raceData.lockedTs || raceData.startTs;
    const serverEndTs = raceData.timing?.targetTs || (serverLockedTs + 20 * 60 * 1000);
    const raceDuration = Math.max(10, Math.round((serverEndTs - serverLockedTs) / 1000));
    const progress = Math.min(elapsed / raceDuration, 1);
    setRaceProgress(progress * 100);
    

    // Determine viewport for mobile-only tweaks
    const isMobile = (typeof window !== 'undefined') ? window.innerWidth < 640 : (canvas.width < 640);

    // Clear canvas with dark gradient background for chart
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#0a0a0a');
    gradient.addColorStop(0.5, '#1a1a2e');
    gradient.addColorStop(1, '#0a0a0a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw price chart grid
    const chartPadding = isMobile
      ? { left: 60, right: 24, top: 32, bottom: 80 }
      : { left: 80, right: 40, top: 40, bottom: 60 };
    const chartWidth = canvas.width - chartPadding.left - chartPadding.right;
    const chartHeight = canvas.height - chartPadding.top - chartPadding.bottom;
    
    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    
    // Establish a dynamic Y range on mobile for better separation of close series
    let yRange = 50; // default symmetric range ±50%
    if (isMobile) {
      let minPct = 0;
      let maxPct = 0;
      const seriesForRange = tokenPricesRef.current;
      for (let s = 0; s < seriesForRange.length; s++) {
        const ser = seriesForRange[s];
        const points = ser.priceHistory.length > 240 ? ser.priceHistory.slice(-240) : ser.priceHistory;
        for (let p = 0; p < points.length; p++) {
          const v = points[p].v;
          const pct = (v - 1) * 100;
          if (pct < minPct) minPct = pct;
          if (pct > maxPct) maxPct = pct;
        }
      }
      const maxAbs = Math.max(15, Math.min(50, Math.ceil(Math.max(Math.abs(minPct), Math.abs(maxPct)) + 5)));
      yRange = maxAbs;
    }

    // Horizontal grid lines (price levels)
    for (let i = 0; i <= 10; i++) {
      const y = chartPadding.top + (i / 10) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(chartPadding.left, y);
      ctx.lineTo(chartPadding.left + chartWidth, y);
      ctx.stroke();
      
      // Price labels
      const priceLevel = yRange - (i * (2 * yRange) / 10); // +yRange to -yRange
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = (isMobile ? '10px Inter' : '12px Inter');
      ctx.textAlign = 'right';
      ctx.fillText(`${priceLevel > 0 ? '+' : ''}${priceLevel}%`, chartPadding.left - 10, y + 4);
    }
    
    // Vertical grid lines (time)
    const timeSteps = isMobile ? Math.max(3, Math.min(6, Math.floor(chartWidth / 80))) : 10;
    for (let i = 0; i <= timeSteps; i++) {
      const x = chartPadding.left + (i / timeSteps) * chartWidth;
      ctx.beginPath();
      ctx.moveTo(x, chartPadding.top);
      ctx.lineTo(x, chartPadding.top + chartHeight);
      ctx.stroke();
      
      // Time labels
      const timeLabel = Math.round((i / timeSteps) * raceDuration);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = (isMobile ? '10px Inter' : '12px Inter');
      if (isMobile) {
        ctx.save();
        ctx.translate(x, canvas.height - chartPadding.bottom + 24);
        ctx.rotate(-Math.PI / 5);
        ctx.textAlign = 'center';
        ctx.fillText(`${timeLabel}s`, 0, 0);
        ctx.restore();
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(`${timeLabel}s`, x, canvas.height - chartPadding.bottom + 20);
      }
    }
    
    // Chart border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(chartPadding.left, chartPadding.top, chartWidth, chartHeight);
    
    // Zero line (baseline)
    const zeroY = chartPadding.top + chartHeight / 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(chartPadding.left, zeroY);
    ctx.lineTo(chartPadding.left + chartWidth, zeroY);
    ctx.stroke();
    ctx.setLineDash([]); // Reset dash

    // Use real market price data from race runners instead of simulated data
    
    // Use real GeckoTerminal API data for chart animation (no more mock price updates)
    // Token prices are already updated by the GeckoTerminal API useEffect hook above
    
    // Draw price lines for each token
    const series = tokenPricesRef.current;
    const labelInfos: {
      runnerIndex: number;
      runnerSymbol: string;
      hue: number;
      isWinner: boolean;
      percentChange: number;
      x: number;
      y: number;
    }[] = [];
    series.forEach((tokenPrice, index) => {
      const runner = raceData?.runners?.[index];
      if (!runner || tokenPrice.priceHistory.length < 1) return; // Allow even single point to show baseline
      
      const hue = (index * 137.5) % 360;
      const isWinner = index === winnerIndex;
      
      // Draw price line
      ctx.strokeStyle = isWinner ? `hsl(45, 100%, 60%)` : `hsl(${hue}, 70%, 60%)`;
      ctx.lineWidth = isWinner ? 4 : 2;
      ctx.shadowColor = isWinner ? 'rgba(255, 215, 0, 0.5)' : `hsl(${hue}, 70%, 60%)`;
      ctx.shadowBlur = isWinner ? 10 : 5;
      
      ctx.beginPath();
      
      // Map each point to its absolute elapsed time across the full race duration
      const points = tokenPrice.priceHistory
        .filter(p => p.t >= 0 && p.t <= raceDuration)
        .sort((a, b) => a.t - b.t);

      for (let i = 0; i < points.length; i++) {
        const x = chartPadding.left + (points[i].t / raceDuration) * chartWidth;
        const priceValue = points[i].v;
        const percentChange = (priceValue - 1) * 100;
        
        // Convert percentage to Y coordinate (±yRange)
        const normalizedPercent = Math.max(-yRange, Math.min(yRange, percentChange));
        const y = chartPadding.top + chartHeight - ((normalizedPercent + yRange) / (2 * yRange)) * chartHeight;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      
      ctx.stroke();
      ctx.shadowBlur = 0;
      
      // Draw current price point and collect label placement data
      if (points.length > 0) {
        const lastPoint = points[points.length - 1];
        const x = chartPadding.left + (lastPoint.t / raceDuration) * chartWidth;
        const priceValue = lastPoint.v;
        const percentChange = (priceValue - 1) * 100;
        const normalizedPercent = Math.max(-yRange, Math.min(yRange, percentChange));
        const y = chartPadding.top + chartHeight - ((normalizedPercent + yRange) / (2 * yRange)) * chartHeight;
        
        // Draw price point
        ctx.fillStyle = isWinner ? `hsl(45, 100%, 60%)` : `hsl(${hue}, 70%, 60%)`;
        ctx.shadowColor = isWinner ? 'rgba(255, 215, 0, 0.8)' : `hsl(${hue}, 70%, 60%)`;
        ctx.shadowBlur = isWinner ? 15 : 8;
        ctx.beginPath();
        ctx.arc(x, y, isWinner ? 8 : 5, 0, Math.PI * 2);
        ctx.fill();
        
        // Collect label info for sorted rendering after all series are drawn
        labelInfos.push({
          runnerIndex: index,
          runnerSymbol: runner.symbol ?? 'N/A',
          hue,
          isWinner,
          percentChange,
          x,
          y
        });
        
        // Winner crown effect
        if (isWinner && raceFinished) {
          ctx.fillStyle = '#FFD700';
          ctx.font = '20px Inter';
          ctx.textAlign = 'center';
          ctx.fillText('👑', x, y - 25);
        }
      }
    });

    // Render labels sorted by percent change (highest gain on top)
    labelInfos.sort((a, b) => b.percentChange - a.percentChange);
    const minGap = isMobile ? 14 : 16;
    const topLimit = chartPadding.top + 10;
    const bottomLimit = chartPadding.top + chartHeight - 10;
    // Start stacking labels centered around the zero baseline instead of the very top
    const totalStackHeight = Math.max(0, (labelInfos.length - 1) * minGap);
    let nextY = Math.min(Math.max(zeroY - totalStackHeight / 2, topLimit), bottomLimit - totalStackHeight);
    for (let i = 0; i < labelInfos.length; i++) {
      const li = labelInfos[i];
      const labelX = Math.min(li.x + 15, canvas.width - (isMobile ? 120 : 140));
      const placedY = Math.min(Math.max(nextY, topLimit), bottomLimit);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.font = li.isWinner ? (isMobile ? 'bold 13px Inter' : 'bold 14px Inter') : (isMobile ? 'bold 11px Inter' : 'bold 12px Inter');
      ctx.textAlign = 'left';
      const sign = li.percentChange >= 0 || Object.is(li.percentChange, 0) ? '+' : '';
      ctx.fillText(
        `${li.runnerSymbol.substring(0, 4)}: ${sign}${li.percentChange.toFixed(1)}%`,
        labelX,
        placedY
      );
      nextY = placedY + minGap;
      // Clamp to chart bounds; avoid wrapping back to top to keep centered cluster
      if (nextY > bottomLimit) nextY = bottomLimit;
    }

    // Continue animation if race is still in progress (check actual race status)
    if ((raceData?.status === 'LOCKED' || raceData?.status === 'IN_PROGRESS') && !raceFinished) {
      animationRef.current = requestAnimationFrame(animate);
    } else if (raceData?.status === 'SETTLED' && winnerIndex !== null && !animationComplete) {
      // Animation complete
      console.log('Race animation completed at 100%');
      setAnimationComplete(true);
      setRaceProgress(100);
      
      // Sound removed per user request
      
      // Wait a moment for server to determine winner if not yet available
      if (winnerIndex !== null && winnerIndex !== undefined) {
        console.log('Animation complete with winner:', winnerIndex, 'redirecting to results...');
        setRaceFinished(true);
        
        // Sounds removed per user request
        stopMusic(); // Ensure any background music is stopped
        // Navigate to results after showing winner crossing finish line
        setTimeout(() => {
          console.log('Executing redirect to results page');
          setLocation(`/race/${raceId}/results`);
        }, 2000); // Shorter delay since race is already settled
      } else {
        // Winner not yet determined, keep checking
        console.log('Animation complete but no winner yet, waiting for settlement...');
        setTimeout(() => {
          // Continue animation to wait for winner
          if (!raceFinished && (winnerIndex === null || winnerIndex === undefined)) {
            animationRef.current = requestAnimationFrame(animate);
          }
        }, 100);
      }
    }
    
    } catch (error) {
      console.error('Chart animation error:', error);
      // Continue animation even if chart fails
      if ((raceData?.status === 'LOCKED' || raceData?.status === 'IN_PROGRESS') && !raceFinished) {
        animationRef.current = requestAnimationFrame(animate);
      }
    }
  };

  // Initialize audio on component mount
  useEffect(() => {
    // Ensure no background music carries over into live view
    stopMusic();
    // Initialize audio context on first user interaction
    const initAudio = () => {
      audioManager.initialize();
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
    };
    
    document.addEventListener('click', initAudio);
    document.addEventListener('keydown', initAudio);
    
    return () => {
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
    };
  }, []);
  
  // Cleanup audio on component unmount
  useEffect(() => {
    return () => {
      stopMusic();
    };
  }, []);

  // Start animation when race data is available
  useEffect(() => {
    // Clean up any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = undefined;
    }
    
    if ((raceData?.status === 'LOCKED' || raceData?.status === 'IN_PROGRESS') && canvasRef.current && tokenPrices.length > 0 && !raceFinished) {
      const canvas = canvasRef.current;
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      
      // Reset animation state
      setAnimationComplete(false);
      setRaceProgress(0);
      startTimeRef.current = undefined;
      lastPointSecondRef.current = -1;
      
      // Start animation
      animationRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = undefined;
      }
    };
  }, [raceData?.status, tokenPrices.length, raceFinished]);

  // Keep canvas sized to container on resize/orientation change
  useEffect(() => {
    const resizeCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width && height) {
        canvas.width = width;
        canvas.height = height;
      }
    };

    resizeCanvas();

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resizeCanvas) : null;
    if (ro && canvasRef.current) ro.observe(canvasRef.current);
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', resizeCanvas);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', resizeCanvas);
      window.removeEventListener('orientationchange', resizeCanvas);
    };
  }, []);

  const raceTotalsData = totals !== undefined ? totals : race.raceTotals;
  const userBetsData = userBets !== undefined ? userBets : race.userBets;
  const currencyLabel = currency === 'SOL' ? 'SOL' : '$RACE';
  const hasUserBets = !!userBetsData && userBetsData.bets.length > 0;
  const showBetsSkeleton = connected && userBetsLoading && (!userBetsData || userBetsData.bets.length === 0);

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Card>
          <CardContent className="py-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading race...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!raceData) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Card>
          <CardContent className="py-12 text-center">
            <i className="fas fa-exclamation-triangle text-4xl text-destructive mb-4"></i>
            <h2 className="text-lg font-semibold mb-2">Race Not Found</h2>
            <Link href="/">
              <Button>Back to Lobby</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (
    raceData?.status !== 'LOCKED' &&
    raceData?.status !== 'IN_PROGRESS' &&
    raceData?.status !== 'SETTLED'
  ) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Card>
          <CardContent className="py-12 text-center">
            <i className="fas fa-clock text-4xl text-muted-foreground mb-4"></i>
            <h2 className="text-lg font-semibold mb-2">Race Not Started</h2>
            <p className="text-muted-foreground mb-4">
              This race has not started yet or is not available for viewing.
            </p>
            <Link href={`/race/${raceId}`}>
              <Button data-testid="back-to-race">Back to Race</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="space-y-6">
        {/* Race Header */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3 sm:justify-start justify-between">
                <Link href="/">
                  <Button variant="outline" size="sm" data-testid="back-home-button">
                    ← Back to Home
                  </Button>
                </Link>
                <div className="text-center sm:text-left">
                  <CardTitle className="text-xl text-primary flex items-center gap-2 justify-center sm:justify-start">
                    <i className="fas fa-flag-checkered"></i>
                    {raceData ? `${getRaceDisplayName(raceData.id)} - LIVE` : 'LIVE'}
                  {raceFinished && (
                    <Badge variant="secondary" className="ml-2 animate-pulse">
                      FINISHED
                    </Badge>
                  )}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {raceData?.runners?.length || 0} runners competing
                  </p>
                </div>
              </div>
              <div className="text-right sm:self-auto self-center">
                <div className="text-2xl font-bold font-mono text-secondary" data-testid="race-progress">
                  {raceProgress.toFixed(0)}%
                </div>
                <div className="text-xs text-muted-foreground">Complete</div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Progress value={raceProgress} className="mb-4" />
            
            {(winnerIndex !== null && raceFinished) || (animationComplete && raceProgress >= 100) ? (
              <div className="bg-gradient-to-r from-accent/20 to-primary/20 border border-accent/50 rounded-lg p-4 text-center">
                <div className="text-lg font-bold text-accent mb-2 animate-winner-glow" data-testid="winner-announcement">
                  {winnerIndex !== null ? (
                    <>🏆 {raceData?.runners?.[winnerIndex]?.symbol || 'Winner'} WINS! 🏆</>
                  ) : (
                    <>🏁 Race Completed! Determining winner...</>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {winnerIndex !== null ? 'Redirecting to results in a few seconds...' : 'Please wait while we determine the winner...'}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Live Race Canvas */}
        <Card className="racing-track">
          <CardContent className="p-0">
            <canvas 
              ref={canvasRef}
              className="w-full h-80 sm:h-80 md:h-96 lg:h-[32rem] rounded-lg"
              style={{ backgroundColor: '#0a0a0a' }}
              data-testid="race-canvas"
            />
          </CardContent>
        </Card>

        {/* Race Stats */}
        <div className="grid md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-lg font-bold text-primary" data-testid="total-pot-live">
                {formatLargeNumber(raceData?.totalPot || '0')}
              </div>
              <div className="text-xs text-muted-foreground">Total Pot ($RACE)</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-lg font-bold text-secondary" data-testid="total-bets-live">
                {raceData?.betCount || 0}
              </div>
              <div className="text-xs text-muted-foreground">Total Bets</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-lg font-bold text-accent">
                {raceData?.jackpotFlag ? 'JACKPOT' : 'STANDARD'}
              </div>
              <div className="text-xs text-muted-foreground">Race Type</div>
            </CardContent>
            </Card>
          </div>

          {/* User Bets & Live Price Changes */}
          <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
            <Card className="h-full border border-border/60 bg-muted/10">
              <CardHeader className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                  <i className="fas fa-ticket-alt text-accent"></i>
                  Your Bets
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Track your tickets as the race unfolds.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {!connected || !wallet.address ? (
                  <div className="rounded-md border border-dashed border-border/60 p-4 text-center text-sm text-muted-foreground">
                    Connect your wallet to view your live bets.
                  </div>
                ) : showBetsSkeleton ? (
                  <div className="space-y-3">
                    {[...Array(3)].map((_, idx) => (
                      <Skeleton key={idx} className="h-16 w-full rounded-md" />
                    ))}
                  </div>
                ) : hasUserBets && userBetsData ? (
                  <>
                    <div className="max-h-[22rem] space-y-3 overflow-y-auto pr-1">
                      {userBetsData.bets.map((bet) => {
                        const fallbackRunner = raceData?.runners?.[bet.runnerIdx];
                        const runnerInfo = bet.runner ?? fallbackRunner;
                        const runnerSymbol = runnerInfo?.symbol ?? `Runner ${bet.runnerIdx + 1}`;
                        const runnerInitials = (runnerSymbol || '?').substring(0, 2).toUpperCase();
                        const placedAt = new Date(bet.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        const odds = raceTotalsData?.impliedOdds?.[bet.runnerIdx];
                        let potentialDisplay: string | null = null;
                        if (odds && odds !== '∞' && odds !== 'Infinity') {
                          try {
                            potentialDisplay = formatLargeNumber(calculatePayout(bet.amount, odds));
                          } catch (error) {
                            console.warn('Failed to calculate potential payout for bet', bet.id, error);
                          }
                        }
                        return (
                          <div
                            key={bet.id}
                            className="flex items-center gap-4 rounded-lg border border-border/40 bg-background/30 p-3 shadow-sm"
                            data-testid={`live-user-bet-${bet.id}`}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="relative flex h-10 w-10 items-center justify-center">
                                {runnerInfo?.logoURI ? (
                                  <img
                                    src={runnerInfo.logoURI}
                                    alt={runnerSymbol}
                                    className="h-10 w-10 rounded-full border border-border/60 object-cover"
                                    onError={(e) => {
                                      e.currentTarget.style.display = 'none';
                                      const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
                                      if (fallback) fallback.style.display = 'flex';
                                    }}
                                  />
                                ) : null}
                                <div
                                  className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary/80 to-secondary/80 text-xs font-semibold text-primary-foreground"
                                  style={{ display: runnerInfo?.logoURI ? 'none' : 'flex' }}
                                >
                                  {runnerInitials}
                                </div>
                              </div>
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-foreground">
                                  {runnerSymbol}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  Placed {placedAt}
                                </div>
                              </div>
                            </div>
                            <div className="ml-auto text-right">
                              <div className="text-sm font-mono font-semibold text-primary">
                                {formatLargeNumber(bet.amount)} {currencyLabel}
                              </div>
                              {potentialDisplay ? (
                                <div className="text-xs text-muted-foreground">
                                  Potential: {potentialDisplay} {currencyLabel}
                                </div>
                              ) : (
                                <div className="text-xs text-muted-foreground">
                                  Potential updating...
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm">
                      <span className="text-muted-foreground">Total wagered</span>
                      <span className="font-semibold font-mono text-foreground">
                        {formatLargeNumber(userBetsData.totalWagered)} {currencyLabel}
                      </span>
                    </div>
                  </>
                  ) : (
                    <div className="rounded-md border border-dashed border-border/60 p-4 text-center text-sm text-muted-foreground">
                      You don't have any bets for this race.
                    </div>
                  )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <i className="fas fa-chart-line text-secondary"></i>
                  Live Price Changes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {raceData?.runners?.map((runner, index) => (
                    <div 
                      key={runner.mint} 
                      className={`flex items-center justify-between rounded-lg p-3 ${
                        index === winnerIndex ? 'winner-lane animate-neon-pulse' : 'runner-lane'
                      }`}
                      data-testid={`token-price-${index}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`h-8 w-8 rounded-full bg-gradient-to-r ${
                          index === winnerIndex ? 'from-accent to-primary animate-pulse' :
                          'from-primary to-secondary'
                        } flex items-center justify-center text-xs font-bold`}>
                          {index + 1}
                        </div>
                        {runner.logoURI ? (
                          <img 
                            src={runner.logoURI} 
                            alt={runner.symbol}
                            className={`h-8 w-8 rounded-full border ${
                              index === winnerIndex ? 'border-accent border-2' : 'border-primary/30'
                            }`}
                            onError={(e) => {
                              const target = e.currentTarget as HTMLImageElement;
                              target.style.display = 'none';
                              const nextElement = target.nextElementSibling as HTMLElement;
                              if (nextElement) nextElement.style.display = 'flex';
                            }}
                          />
                        ) : null}
                        <div 
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-r from-primary to-secondary text-xs font-bold"
                          style={{ display: runner.logoURI ? 'none' : 'flex' }}
                        >
                          {runner.symbol.substring(0, 2)}
                        </div>
                        <div>
                          <div className={`text-sm font-semibold ${
                            index === winnerIndex ? 'text-accent animate-winner-glow' : 'text-foreground'
                          }`}>
                            {runner.symbol}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            ${formatLargeNumber(runner.marketCap)}
                          </div>
                        </div>
                      </div>
                      
                      <div className="text-right">
                        {(() => {
                          const value = Number(
                            progressData?.priceChanges?.find((pc: any) => pc.mint === runner.mint)?.priceChange ??
                            tokenPrices[index]?.percentageChange ??
                            0
                          );
                          const isNegative = value < 0 || Object.is(value, -0);
                          const colorClass = isNegative ? 'text-red-400' : 'text-green-400';
                          const sign = isNegative ? '' : '+';
                          return (
                            <div className={`text-sm font-mono font-bold ${colorClass}`}>
                              {`${sign}${value.toFixed(2)}%`}
                            </div>
                          );
                        })()}
                        <div className="text-xs text-muted-foreground">
                          Price Change
                        </div>
                      </div>
                      
                      {index === winnerIndex && raceFinished && (
                        <Badge variant="secondary" className="border-accent bg-accent/20 text-accent animate-pulse">
                          <i className="fas fa-crown mr-1"></i>
                          WINNER
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

        {/* Action Buttons */}
        <div className="flex justify-center gap-4">
          <Link href={`/race/${raceId}`}>
            <Button variant="outline" data-testid="back-to-race-detail">
              <i className="fas fa-arrow-left mr-2"></i>
              Race Details
            </Button>
          </Link>
          
          {raceFinished && (
            <Link href={`/race/${raceId}/results`}>
              <Button data-testid="view-results-live">
                <i className="fas fa-trophy mr-2"></i>
                View Results
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
