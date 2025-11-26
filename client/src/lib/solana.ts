import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { clusterApiUrl } from '@solana/web3.js';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork, type WalletAdapter } from '@solana/wallet-adapter-base';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';

// Include Wallet Adapter UI styles
import '@solana/wallet-adapter-react-ui/styles.css';

interface WalletContextProviderProps {
  children: ReactNode;
}

export function WalletContextProvider({ children }: WalletContextProviderProps) {
  const network: WalletAdapterNetwork =
    (import.meta.env.VITE_CLUSTER as WalletAdapterNetwork | undefined) ?? WalletAdapterNetwork.Mainnet;

  const endpoint = useMemo(() => {
    const customRpc = import.meta.env.VITE_RPC_URL as string | undefined;
    return customRpc || clusterApiUrl(network);
  }, [network]);

  // Build wallet adapters, adding Backpack only if available at runtime
  const [wallets, setWallets] = useState<WalletAdapter[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const baseWallets: WalletAdapter[] = [
        new PhantomWalletAdapter(),
        new SolflareWalletAdapter({ network }),
      ];
      try {
        // Avoid Vite pre-bundling by computing the specifier
        const moduleName = '@solana/wallet-adapter-' + 'backpack';
        const mod: any = await import(/* @vite-ignore */ moduleName);
        if (mod?.BackpackWalletAdapter) {
          baseWallets.push(new mod.BackpackWalletAdapter());
        }
      } catch {
        // Backpack adapter not installed; proceed without it
      }
      if (!cancelled) setWallets(baseWallets);
    })();
    return () => {
      cancelled = true;
    };
  }, [network]);

  return React.createElement(
    ConnectionProvider,
    { endpoint },
    React.createElement(
      WalletProvider,
      {
        wallets,
        autoConnect: true,
        onError: (error) => {
          const err = error as any;
          const cause: any = err?.cause;
          const details = {
            name: err?.name,
            message: String(err?.message || ''),
            code: err?.code,
            stack: err?.stack,
            causeMessage: String(cause?.message || cause?.toString?.() || ''),
          };
          console.error('Wallet error:', details);
        },
      },
      React.createElement(WalletModalProvider, null, children)
    )
  );
}

// Export necessary Solana types and functions
export { PublicKey, Connection, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
export { createTransferInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
