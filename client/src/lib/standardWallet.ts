import { clusterApiUrl, Connection, PublicKey } from '@solana/web3.js';

export const endpoint = import.meta.env.VITE_RPC_URL ?? clusterApiUrl('mainnet-beta');
export const connection = new Connection(endpoint);

// Standard wallet interface types
interface StandardWallet {
  standard: boolean;
  name: string;
  icon: string;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: any): Promise<any>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  on(event: string, handler: Function): void;
  off(event: string, handler: Function): void;
}

class StandardWalletManager {
  private wallet: StandardWallet | null = null;
  private connected = false;
  private publicKey: PublicKey | null = null;
  private listeners: Map<string, Function[]> = new Map();

  async getWallets(): Promise<StandardWallet[]> {
    // Check for standard wallets in window.solana
    const wallets: StandardWallet[] = [];
    
    if (typeof window !== 'undefined') {
      // Check for Phantom
      if (window.phantom?.solana?.isPhantom) {
        wallets.push({
          standard: true,
          name: 'Phantom',
          icon: 'https://phantom.app/img/phantom-logo.svg',
          connect: () => window.phantom.solana.connect(),
          disconnect: () => window.phantom.solana.disconnect(),
          signTransaction: (tx) => window.phantom.solana.signTransaction(tx),
          signMessage: (msg) => window.phantom.solana.signMessage(msg),
          on: (event, handler) => window.phantom.solana.on(event, handler),
          off: (event, handler) => window.phantom.solana.off(event, handler)
        });
      }
      
      // Check for Solflare
      if (window.solflare?.isSolflare) {
        wallets.push({
          standard: true,
          name: 'Solflare',
          icon: 'https://solflare.com/img/logo.svg',
          connect: () => window.solflare.connect(),
          disconnect: () => window.solflare.disconnect(),
          signTransaction: (tx) => window.solflare.signTransaction(tx),
          signMessage: (msg) => window.solflare.signMessage(msg),
          on: (event, handler) => window.solflare.on(event, handler),
          off: (event, handler) => window.solflare.off(event, handler)
        });
      }
    }
    
    return wallets;
  }

  async connect(walletName?: string): Promise<{ publicKey: PublicKey }> {
    try {
      const wallets = await this.getWallets();
      const selectedWallet = walletName 
        ? wallets.find(w => w.name === walletName)
        : wallets[0]; // Default to first available

      if (!selectedWallet) {
        throw new Error('No wallet found. Please install Phantom or Solflare.');
      }

      const result = await selectedWallet.connect();
      this.wallet = selectedWallet;
      this.connected = true;
      this.publicKey = result.publicKey;

      // Set up event listeners
      selectedWallet.on('disconnect', () => {
        this.connected = false;
        this.publicKey = null;
        this.wallet = null;
        this.emit('disconnect');
      });

      selectedWallet.on('accountChanged', (publicKey: PublicKey) => {
        this.publicKey = publicKey;
        this.emit('accountChanged', publicKey);
      });

      this.emit('connect', result.publicKey);
      return result;
    } catch (error) {
      console.error('Wallet connection failed:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.wallet) {
      await this.wallet.disconnect();
      this.wallet = null;
      this.connected = false;
      this.publicKey = null;
      this.emit('disconnect');
    }
  }

  async signTransaction(transaction: any): Promise<any> {
    if (!this.wallet || !this.connected) {
      throw new Error('Wallet not connected');
    }
    return this.wallet.signTransaction(transaction);
  }

  async signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }> {
    if (!this.wallet || !this.connected) {
      throw new Error('Wallet not connected');
    }
    return this.wallet.signMessage(message);
  }

  // Event system
  on(event: string, handler: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }

  off(event: string, handler: Function): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  private emit(event: string, ...args: any[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach(handler => handler(...args));
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get publicKey(): PublicKey | null {
    return this.publicKey;
  }

  get walletName(): string | null {
    return this.wallet?.name || null;
  }
}

// Global wallet manager instance
export const walletManager = new StandardWalletManager();

// Type declarations for window objects
declare global {
  interface Window {
    phantom?: {
      solana?: {
        isPhantom: boolean;
        connect(): Promise<{ publicKey: PublicKey }>;
        disconnect(): Promise<void>;
        signTransaction(transaction: any): Promise<any>;
        signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
        on(event: string, handler: Function): void;
        off(event: string, handler: Function): void;
      };
    };
    solflare?: {
      isSolflare: boolean;
      connect(): Promise<{ publicKey: PublicKey }>;
      disconnect(): Promise<void>;
      signTransaction(transaction: any): Promise<any>;
      signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
      on(event: string, handler: Function): void;
      off(event: string, handler: Function): void;
    };
  }
}