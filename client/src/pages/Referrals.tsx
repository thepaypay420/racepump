import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useWallet } from '@solana/wallet-adapter-react';

export default function Referrals() {
  const { wallet } = useStore();
  const solanaWallet = useWallet();
  const { toast } = useToast();
  const [settings, setSettings] = useState<any>(null);
  const [myCode, setMyCode] = useState<string>('');
  const [desired, setDesired] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const [verified, setVerified] = useState<boolean>(false);
  const [verifying, setVerifying] = useState<boolean>(false);
  const [checkingStatus, setCheckingStatus] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      try { setSettings(await api.getReferralSettings()); } catch {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      if (!wallet.address) return;
      try {
        const r = await api.getReferralCode(wallet.address);
        setMyCode(r?.code || '');
        setDesired(r?.code || '');
        // Load summary
        try {
          const res = await fetch(`/api/referrals/summary/${wallet.address}`);
          const s = await res.json();
          setSummary(s);
        } catch {}
        // Check verification status
        setCheckingStatus(true);
        try {
          const verifyRes = await fetch(`/api/referrals/verify-status/${wallet.address}`);
          const status = await verifyRes.json();
          setVerified(status.verified || false);
        } catch {}
        setCheckingStatus(false);
      } catch {}
    })();
  }, [wallet.address]);

  const shareLink = useMemo(() => {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://racepump.fun';
    const code = myCode || desired || '';
    return `${base}/?ref=${encodeURIComponent(code)}`;
  }, [myCode, desired]);

  const handleSave = async () => {
    if (!wallet.address) return;
    const r = await api.setReferralCode(wallet.address, desired);
    setMyCode(r?.code || desired);
  };

  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(shareLink); setCopied(true); setTimeout(()=>setCopied(false), 1500);} catch {}
  };

  const handleVerifyWallet = async () => {
    if (!wallet.address || !solanaWallet.signMessage) {
      toast({
        title: 'Wallet not connected',
        description: 'Please connect your Solana wallet to verify ownership.',
        variant: 'destructive'
      });
      return;
    }

    setVerifying(true);
    try {
      // Create verification message
      const message = `Verify wallet ownership for racepump.fun referral system\n\nWallet: ${wallet.address}\nTimestamp: ${Date.now()}\n\nSigning this message proves you own this wallet and authorizes it to receive referral rewards.`;
      
      // Request signature from wallet
      const encodedMessage = new TextEncoder().encode(message);
      const signature = await solanaWallet.signMessage(encodedMessage);
      
      // Convert signature to base58
      const bs58 = await import('bs58');
      const signatureBase58 = bs58.default.encode(signature);
      
      // Send to backend for verification
      const response = await fetch('/api/referrals/verify-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: wallet.address,
          message,
          signature: signatureBase58
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        setVerified(true);
        toast({
          title: '✅ Wallet verified!',
          description: 'Your wallet has been verified and is now eligible to receive referral payouts.'
        });
      } else {
        throw new Error(result.error || 'Verification failed');
      }
    } catch (e: any) {
      console.error('Verification error:', e);
      toast({
        title: 'Verification failed',
        description: e?.message || 'Failed to verify wallet. Please try again.',
        variant: 'destructive'
      });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-6">
      {/* Back to Lobby */}
      <div className="mb-4">
        <a href="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <i className="fas fa-arrow-left mr-2"></i>
          Back to Lobby
        </a>
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <i className="fas fa-users text-primary"></i>
              Referrals
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded bg-muted/20 p-4 text-sm">
              <div className="text-lg font-semibold mb-1">Invite your friends</div>
              <div className="text-muted-foreground">
                Invite your friends and both of you receive a 5% discount on fees. Also receive a 60% commission of their trading fees, including anyone else they refer.
              </div>
              {settings && (
                <div className="mt-2 text-xs text-muted-foreground">
                  Current levels: L1 {Number(settings.level1Bps)/100}% · L2 {Number(settings.level2Bps)/100}% · L3 {Number(settings.level3Bps)/100}% of referral pool ({Number(settings.poolBps)/100}% of rake). Rebate: {Number(settings.discountBps)/100}% of rake.
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm">Your referral code</label>
              <div className="flex gap-2">
                <Input value={desired} onChange={(e)=>setDesired(e.target.value)} placeholder="choose-your-name" data-testid="input-referral-code" />
                <Button onClick={handleSave} disabled={!wallet.address} data-testid="button-save-code">Save</Button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm">Share link</label>
              <div className="flex gap-2">
                <Input value={shareLink} readOnly data-testid="input-share-link" />
                <Button variant="secondary" onClick={handleCopy} data-testid="button-copy-link">{copied ? 'Copied' : 'Copy'}</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <i className="fas fa-chart-pie text-accent"></i>
              Your Referrals
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>Users referred: <b>{summary?.referredDirect + summary?.referredIndirect || 0}</b> (direct: {summary?.referredDirect || 0}, indirect: {summary?.referredIndirect || 0})</div>
            <div>Total rewards (RACE): <b>{summary?.totals?.race?.paid || '0'}</b> paid / unclaimed <b>{summary?.totals?.race?.pending || '0'}</b></div>
            <div>Total rewards (SOL): <b>{summary?.totals?.sol?.paid || '0'}</b> paid / unclaimed <b>{summary?.totals?.sol?.pending || '0'}</b></div>
            <div className="text-xs text-muted-foreground mt-2">Payouts occur once per day automatically.</div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <Card className={verified ? 'border-green-500/50' : 'border-yellow-500/50'}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {verified ? (
                <i className="fas fa-shield-check text-green-500"></i>
              ) : (
                <i className="fas fa-shield-exclamation text-yellow-500"></i>
              )}
              Wallet Verification
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {checkingStatus ? (
              <div className="text-sm text-muted-foreground">Checking verification status...</div>
            ) : verified ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                  <i className="fas fa-check-circle"></i>
                  <span className="font-semibold">Your wallet is verified</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Your wallet is verified and eligible to receive referral payouts. Rewards are automatically paid daily.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded bg-yellow-500/10 border border-yellow-500/30 p-4 text-sm">
                  <div className="flex items-start gap-2">
                    <i className="fas fa-exclamation-triangle text-yellow-500 mt-1"></i>
                    <div>
                      <div className="font-semibold mb-1">Verification Required</div>
                      <p className="text-muted-foreground">
                        To receive referral payouts, you must verify wallet ownership by signing a message. This is a one-time process that proves you control this wallet address.
                      </p>
                    </div>
                  </div>
                </div>
                <div className="text-sm space-y-2">
                  <p className="font-medium">Why verify?</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>Protects against unauthorized referral claims</li>
                    <li>Ensures payouts go to the rightful wallet owner</li>
                    <li>One-time verification - takes just a few seconds</li>
                  </ul>
                </div>
                <Button 
                  onClick={handleVerifyWallet} 
                  disabled={!wallet.address || verifying}
                  className="w-full"
                  data-testid="button-verify-wallet"
                >
                  {verifying ? (
                    <>
                      <i className="fas fa-spinner fa-spin mr-2"></i>
                      Verifying...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-signature mr-2"></i>
                      Verify Wallet Ownership
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
