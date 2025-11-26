import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { WalletContextProvider } from "@/lib/solana";

// Recover from stale chunk loads after deploys by forcing a one-time hard reload
function attemptRecoverFromChunkError(_reason: unknown) {
  try {
    const markerKey = "__chunk_reload_once__";
    if (sessionStorage.getItem(markerKey) === "1") {
      return;
    }
    sessionStorage.setItem(markerKey, "1");
    const url = new URL(window.location.href);
    url.searchParams.set("v", String(Date.now()));
    window.location.replace(url.toString());
  } catch (_e) {
    // Fallback to a regular reload if URL manipulation is restricted
    window.location.reload();
  }
}

// Handle unhandled promise rejections globally
window.addEventListener('unhandledrejection', (event) => {
  // Suppress wallet rejection errors (user cancelled transaction)
  if (event.reason?.code === 4001 || 
      event.reason?.message?.includes('User rejected') ||
      event.reason?.message?.includes('user rejected')) {
    // Silently suppress wallet cancellations - this is normal user behavior
    event.preventDefault(); // Prevent the error from being logged as unhandled
    return;
  }
  // Auto-recover from dynamic import/chunk load failures (e.g., after hot deploy)
  try {
    const msg = String(event.reason?.message || event.reason || "");
    if (
      msg.includes('Failed to fetch dynamically imported module') ||
      msg.includes('ChunkLoadError') ||
      msg.includes('Loading chunk')
    ) {
      event.preventDefault();
      attemptRecoverFromChunkError(event.reason);
      return;
    }
  } catch {}
  
  // Log other unhandled rejections for debugging
  console.error('Unhandled promise rejection:', event.reason);
});

// Also handle regular errors
window.addEventListener('error', (event) => {
  // Suppress wallet rejection errors
  if (event.error?.code === 4001 || 
      event.error?.message?.includes('User rejected') ||
      event.error?.message?.includes('user rejected')) {
    // Silently suppress wallet cancellations - this is normal user behavior
    event.preventDefault();
    return;
  }
  // Handle resource/script chunk load failures
  try {
    const isScriptTarget = (event as any)?.target && (event as any).target.tagName === 'SCRIPT';
    const msg = String((event as any)?.error?.message || (event as any)?.message || "");
    if (isScriptTarget || msg.includes('ChunkLoadError') || msg.includes('Loading chunk')) {
      event.preventDefault();
      attemptRecoverFromChunkError((event as any)?.error || event);
      return;
    }
  } catch {}
});

createRoot(document.getElementById("root")!).render(
  <WalletContextProvider>
    <App />
  </WalletContextProvider>
);
