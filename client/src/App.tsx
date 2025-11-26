import { Switch, Route, Link } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
// Simple connection without wallet adapters
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AudioControls from "@/components/AudioControls";
import { useEffect } from "react";
import { connectSSEWithRetry } from "@/lib/api";
import { handleSSEMessage } from "@/lib/store";
import WalletBar from "./components/WalletBar";
import { useStore } from "@/lib/store";
import Footer from "./components/Footer";
import Referrals from "./pages/Referrals";
import RaceSwap from "./pages/RaceSwap";
import TestV2 from "./pages/TestV2";
import TestJupiterFrontend from "./pages/TestJupiterFrontend";
import Lobby from "./pages/Lobby";
import RaceDetail from "./pages/RaceDetail";
import LiveRace from "./pages/LiveRace";
import Results from "./pages/Results";
import Admin from "./pages/Admin";
import NotFound from "@/pages/not-found";
import { useWalletConnected } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function Router() {
  return (
      <div className="min-h-screen flex flex-col">
        {/* Grain overlay */}
        <div className="grain-overlay"></div>
        
        {/* Header with wallet bar */}
        <header className="relative z-20 md:z-10 border-border bg-card/50 backdrop-blur-sm border-b-0 md:border-b">
          <HeaderInner />
        </header>

        {/* Main content */}
        <main className="relative z-10 flex-1 flex flex-col">
          <Switch>
            <Route path="/" component={Lobby} />
            <Route path="/race/:raceId" component={RaceDetail} />
            <Route path="/race/:raceId/live" component={LiveRace} />
            <Route path="/race/:raceId/results" component={Results} />
            <Route path="/referrals" component={Referrals} />
            <Route path="/raceswap" component={RaceSwap} />
            <Route path="/test-v2" component={TestV2} />
            <Route path="/test-jupiter" component={TestJupiterFrontend} />
            <Route path="/admin" component={Admin} />
            <Route component={NotFound} />
          </Switch>
        </main>

        {/* Footer */}
        <Footer />
      </div>
  );
}

function HeaderInner() {
  const isConnected = useWalletConnected();
  const { currency } = useStore();

  return (
    <div className={`relative ${currency === 'SOL' ? 'theme-sol' : 'theme-race'}`}>
      {/* Expose currency globally for API helpers */}
      {(() => { try { (window as any).__APP_CURRENCY__ = currency; } catch {} return null; })()}
        <div className={cn("container mx-auto px-4 md:py-4", isConnected ? "py-2" : "py-1")}> 
            <div className="flex items-center justify-end md:justify-between gap-4">
            <div className="hidden md:flex items-center gap-4">
              <Link href="/">
                <div className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity">
                  <i className={`fas fa-bolt text-2xl ${currency === 'SOL' ? 'text-blue-400' : 'text-primary'} neon-glow`}></i>
                  <h1 className={`text-2xl font-bold ${currency === 'SOL' ? 'text-blue-400' : 'text-primary'}`}>Pump Racers</h1>
                </div>
              </Link>
              <div className="hidden md:flex items-center gap-1 text-xs text-muted-foreground bg-muted/30 px-2 py-1 rounded">
                <i className="fas fa-signal text-secondary"></i>
                <span>MAINNET</span>
              </div>
            </div>
              <div className="flex items-center gap-3">
                <Link href="/raceswap">
                  <Button
                    variant="secondary"
                    className="hidden md:inline-flex bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30"
                  >
                    <i className="fas fa-rocket mr-2" />
                    RACESwap
                  </Button>
                </Link>
                <div className="flex flex-col items-end gap-1">
                  <WalletBar />
                </div>
              </div>
          </div>
        </div>
      {/* Mobile-only: subtle divider with minimal dead space */}
      <div className={cn("md:hidden pointer-events-none absolute inset-x-0 border-b border-border", "bottom-0")} />
    </div>
  );
}

function App() {
  // Global error handler for unhandled promise rejections
  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      // Filter out wallet rejection errors (code 4001) - these are user actions, not errors
      if (event.reason?.code === 4001 || event.reason?.message?.includes('User rejected')) {
        console.log('User cancelled wallet operation');
        event.preventDefault();
        return;
      }
      
      console.error('Unhandled promise rejection:', event.reason);
      event.preventDefault(); // Prevent the error from being shown in the console
    };
    
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    
    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  // Initialize resilient SSE connection on app start
  useEffect(() => {
    const conn = connectSSEWithRetry('/api/events', (payload) => {
      handleSSEMessage(payload);
    });
    console.log('SSE connection initialized');
    return () => conn.close();
  }, []);
  
  return (
    <QueryClientProvider client={queryClient}>
      <div className="solana-app">
        <TooltipProvider>
          <div className="dark">
            <Toaster />
            <Router />
            <AudioControls />
          </div>
        </TooltipProvider>
      </div>
    </QueryClientProvider>
  );
}

export default App;
