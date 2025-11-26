import { useWallet } from '@solana/wallet-adapter-react';

export default function DebugWalletStatus() {
  const { connected, connecting, disconnecting, publicKey, wallet } = useWallet();
  return (
    <div className="text-xs text-muted-foreground">
      <div>connected: {String(connected)}</div>
      <div>connecting: {String(connecting)}</div>
      <div>disconnecting: {String(disconnecting)}</div>
      <div>wallet: {wallet?.adapter?.name || 'none'}</div>
      <div>pubkey: {publicKey?.toBase58?.() || '-'}</div>
    </div>
  );
}
