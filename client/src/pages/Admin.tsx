import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
// Removed wallet adapter import for browser compatibility
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { formatLargeNumber } from '@/lib/math';
import { getShortRaceTag } from '@shared/race-name';

export default function Admin() {
  const publicKey = null; // Mock for development
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { admin, setAdmin } = useStore();
  
  const [loginToken, setLoginToken] = useState('');
  const [showLogin, setShowLogin] = useState(!admin.authenticated);

  // Create race form state
  const [createForm, setCreateForm] = useState({
    startMinutes: '5',
    rakeBps: '300',
    jackpotFlag: false,
    limit: '8'
  });

  // Faucet form state
  const [faucetForm, setFaucetForm] = useState({
    address: '',
    amount: '100000'
  });

  // Force reset faucet form to ensure 100k default
  useEffect(() => {
    setFaucetForm(prev => ({ ...prev, amount: '100000' }));
  }, []);

  // Admin stats query
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['/api/admin/stats'],
    queryFn: () => api.admin.getStats(admin.token),
    enabled: admin.authenticated,
    refetchInterval: 10000,
  });

  // Maintenance form state
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');

  useEffect(() => {
    if (stats?.maintenance) {
      setMaintenanceMode(!!stats.maintenance.mode);
      setMaintenanceMessage(stats.maintenance.message || '');
    }
  }, [stats?.maintenance?.mode, stats?.maintenance?.message]);

  const setMaintenanceMutation = useMutation({
    mutationFn: async () => api.admin.setMaintenance(maintenanceMode, maintenanceMessage, admin.token),
    onSuccess: () => {
      toast({ title: maintenanceMode ? 'Maintenance Enabled' : 'Maintenance Disabled', description: maintenanceMessage || '' });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/stats'] });
      queryClient.invalidateQueries({ queryKey: ['/api/races'] });
    },
    onError: (error: any) => {
      toast({ title: 'Failed to update maintenance', description: error.message, variant: 'destructive' });
    }
  });

  const restartRacesMutation = useMutation({
    mutationFn: async () => api.admin.restartRaces(admin.token),
    onSuccess: (data) => {
      toast({ title: 'Restart Complete', description: `Cancelled ${data.cancelled} future races` });
      queryClient.invalidateQueries({ queryKey: ['/api/races'] });
    },
    onError: (error: any) => {
      toast({ title: 'Failed to restart races', description: error.message, variant: 'destructive' });
    }
  });

  // Reset jackpots mutation
  const resetJackpotsMutation = useMutation({
    mutationFn: async () => api.admin.resetJackpots(admin.token),
    onSuccess: () => {
      toast({ title: 'Jackpots Reset', description: 'RACE and SOL jackpot balances set to 0' });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/stats'] });
      queryClient.invalidateQueries({ queryKey: ['/api/treasury'] });
    },
    onError: (error: any) => {
      toast({ title: 'Failed to reset jackpots', description: error.message, variant: 'destructive' });
    }
  });

  // Treasury info (escrow/treasury/jackpot pubkeys)
  const { data: treasuryInfo } = useQuery({
    queryKey: ['/api/treasury'],
    queryFn: () => api.getTreasury(),
    enabled: admin.authenticated,
    refetchInterval: 15000,
  });

  // Recent races query
  const { data: races, isLoading: racesLoading } = useQuery({
    queryKey: ['/api/races'],
    enabled: admin.authenticated,
    refetchInterval: 5000,
  });

  // Admin login
  const loginMutation = useMutation({
    mutationFn: async (token: string) => {
      // Test token by calling stats endpoint
      await api.admin.getStats(token);
      return token;
    },
    onSuccess: (token) => {
      setAdmin({ authenticated: true, token });
      setShowLogin(false);
      toast({
        title: "Admin Access Granted",
        description: "You are now authenticated as an administrator",
      });
    },
    onError: (error) => {
      toast({
        title: "Authentication Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Create race mutation
  const createRaceMutation = useMutation({
    mutationFn: async () => {
      const startTs = Date.now() + parseInt(createForm.startMinutes) * 60 * 1000;
      return api.admin.createRace({
        startTs,
        rakeBps: parseInt(createForm.rakeBps),
        jackpotFlag: createForm.jackpotFlag,
        limit: parseInt(createForm.limit)
      }, admin.token);
    },
    onSuccess: () => {
      toast({
        title: "Race Created",
        description: "New race has been created successfully",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/races'] });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/stats'] });
      // Reset form
      setCreateForm({
        startMinutes: '5',
        rakeBps: '300',
        jackpotFlag: false,
        limit: '8'
      });
    },
    onError: (error) => {
      toast({
        title: "Failed to Create Race",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Lock race mutation
  const lockRaceMutation = useMutation({
    mutationFn: async (raceId: string) => {
      return api.admin.lockRace(raceId, admin.token);
    },
    onSuccess: (data) => {
      toast({
        title: "Race Locked",
        description: `Race locked and winner selected: ${data.winner?.symbol}`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/races'] });
    },
    onError: (error) => {
      toast({
        title: "Failed to Lock Race",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Cancel race mutation
  const cancelRaceMutation = useMutation({
    mutationFn: async (raceId: string) => {
      return api.admin.cancelRace(raceId, admin.token);
    },
    onSuccess: () => {
      toast({
        title: "Race Cancelled",
        description: "Race has been cancelled and bets refunded",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/races'] });
    },
    onError: (error) => {
      toast({
        title: "Failed to Cancel Race",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Faucet mutation
  const faucetMutation = useMutation({
    mutationFn: async () => {
      return api.admin.faucet({
        toPubkey: faucetForm.address,
        amount: faucetForm.amount
      }, admin.token);
    },
    onSuccess: (data) => {
      toast({
        title: "Faucet Success",
        description: `${faucetForm.amount} $RACE sent to ${faucetForm.address.slice(0, 8)}...`,
      });
      setFaucetForm({ address: '', amount: '1000' });
    },
    onError: (error) => {
      toast({
        title: "Faucet Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleLogin = () => {
    if (!loginToken.trim()) {
      toast({
        title: "Token Required",
        description: "Please enter an admin token",
        variant: "destructive",
      });
      return;
    }
    loginMutation.mutate(loginToken);
  };

  const handleLogout = () => {
    setAdmin({ authenticated: false, token: '' });
    setShowLogin(true);
    toast({
      title: "Logged Out",
      description: "Admin session ended",
    });
  };

  const fillWalletAddress = () => {
    if (publicKey) {
      setFaucetForm(prev => ({ ...prev, address: publicKey.toString() }));
    }
  };

  if (showLogin) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="max-w-md mx-auto">
          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="text-destructive flex items-center gap-2">
                <i className="fas fa-shield-alt"></i>
                Admin Access Required
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="admin-token">Admin Token</Label>
                <Input
                  id="admin-token"
                  type="password"
                  placeholder="Enter admin token"
                  value={loginToken}
                  onChange={(e) => setLoginToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  className="font-mono"
                  data-testid="admin-token-input"
                />
              </div>
              <div className="flex gap-2">
                <Button 
                  onClick={handleLogin}
                  disabled={loginMutation.isPending}
                  className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="admin-login-btn"
                >
                  {loginMutation.isPending ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
                      Authenticating...
                    </>
                  ) : (
                    'Login'
                  )}
                </Button>
                <Button variant="outline" onClick={() => window.history.back()} data-testid="admin-cancel-btn">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <Card className="border-destructive/30">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-destructive flex items-center gap-2">
                <i className="fas fa-cog"></i>
                Admin Dashboard
              </CardTitle>
              <Button variant="outline" onClick={handleLogout} data-testid="admin-logout-btn">
                <i className="fas fa-sign-out-alt mr-2"></i>
                Logout
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground">
              <i className="fas fa-info-circle mr-2"></i>
              You have administrator access to manage races and system functions.
            </div>
          </CardContent>
        </Card>

        {/* Stats Overview */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <i className="fas fa-chart-bar text-primary"></i>
              System Statistics
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="grid grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="bg-muted/20 rounded p-4 text-center">
                    <div className="text-lg font-bold">...</div>
                    <div className="text-xs text-muted-foreground">Loading</div>
                  </div>
                ))}
              </div>
            ) : stats ? (
              <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                <div className="bg-muted/20 rounded p-4 text-center" data-testid="stat-total-races">
                  <div className="text-lg font-bold text-primary">{stats.stats.totalRaces}</div>
                  <div className="text-xs text-muted-foreground">Total Races</div>
                </div>
                <div className="bg-muted/20 rounded p-4 text-center" data-testid="stat-open-races">
                  <div className="text-lg font-bold text-secondary">{stats.stats.openRaces}</div>
                  <div className="text-xs text-muted-foreground">Open Races</div>
                </div>
                <div className="bg-muted/20 rounded p-4 text-center" data-testid="stat-total-volume">
                  <div className="text-lg font-bold text-accent">{formatLargeNumber(stats.stats.totalVolume)}</div>
                  <div className="text-xs text-muted-foreground">Total Volume ($RACE)</div>
                </div>
                <div className="bg-muted/20 rounded p-4 text-center" data-testid="stat-jackpot-balance">
                  <div className="text-lg font-bold text-accent">{formatLargeNumber(stats.stats.jackpotBalance)}</div>
                  <div className="text-xs text-muted-foreground">Jackpot Balance</div>
                </div>
                <div className="bg-muted/20 rounded p-4 text-center" data-testid="stat-treasury-balance">
                  <div className="text-lg font-bold text-primary">{formatLargeNumber(stats.stats.treasuryTokenBalance || '0')}</div>
                  <div className="text-xs text-muted-foreground">Treasury Balance</div>
                </div>
                {/* Wallet addresses */}
                <div className="col-span-2 md:col-span-5 grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                  <div className="bg-muted/20 rounded p-3" data-testid="escrow-address">
                    <div className="text-xs text-muted-foreground mb-1">Escrow Wallet</div>
                    <div className="text-xs font-mono break-all">{treasuryInfo?.escrowPubkey || '...'}</div>
                  </div>
                  <div className="bg-muted/20 rounded p-3" data-testid="treasury-address">
                    <div className="text-xs text-muted-foreground mb-1">Treasury Wallet</div>
                    <div className="text-xs font-mono break-all">{treasuryInfo?.treasuryPubkey || '...'}</div>
                  </div>
                  <div className="bg-muted/20 rounded p-3" data-testid="jackpot-address">
                    <div className="text-xs text-muted-foreground mb-1">Jackpot Wallet</div>
                    <div className="text-xs font-mono break-all">{treasuryInfo?.jackpotPubkey || '...'}</div>
                  </div>
                </div>
                <div className="bg-muted/20 rounded p-4 text-center" data-testid="stat-maintenance">
                  <div className={`text-lg font-bold ${maintenanceMode ? 'text-destructive' : 'text-secondary'}`}>{maintenanceMode ? 'ON' : 'OFF'}</div>
                  <div className="text-xs text-muted-foreground">Maintenance</div>
                </div>
              </div>
            ) : (
              <div className="text-center text-muted-foreground">
                Failed to load statistics
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Maintenance Controls */}
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive flex items-center gap-2">
                <i className="fas fa-tools"></i>
                Maintenance Controls
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Checkbox id="maintenance-mode" checked={maintenanceMode} onCheckedChange={(v) => setMaintenanceMode(!!v)} />
                <Label htmlFor="maintenance-mode">Enable maintenance (freeze upcoming races)</Label>
              </div>
              <div>
                <Label htmlFor="maintenance-message">Message (shown on next race card)</Label>
                <Input id="maintenance-message" placeholder="We are upgrading the system..." value={maintenanceMessage} onChange={(e) => setMaintenanceMessage(e.target.value)} />
              </div>
              <div className="flex gap-2 flex-wrap">
                <Button onClick={() => setMaintenanceMutation.mutate()} disabled={setMaintenanceMutation.isPending} className="flex-1">
                  {setMaintenanceMutation.isPending ? 'Updating…' : 'Save Maintenance Settings'}
                </Button>
                <Button variant="secondary" onClick={() => restartRacesMutation.mutate()} disabled={restartRacesMutation.isPending}>
                  {restartRacesMutation.isPending ? 'Restarting…' : 'Clear & Restart Races'}
                </Button>
                <Button variant="outline" onClick={() => resetJackpotsMutation.mutate()} disabled={resetJackpotsMutation.isPending}>
                  {resetJackpotsMutation.isPending ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
                      Resetting…
                    </>
                  ) : (
                    <>
                      <i className="fas fa-undo mr-2"></i>
                      Reset Jackpots to 0
                    </>
                  )}
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                - Current LOCKED/IN_PROGRESS continue unaffected. Upcoming OPEN races will be paused from advancing.
              </div>
            </CardContent>
          </Card>
          {/* Create Race */}
          <Card>
            <CardHeader>
              <CardTitle className="text-primary flex items-center gap-2">
                <i className="fas fa-plus-circle"></i>
                Create New Race
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="start-minutes">Start Time (minutes from now)</Label>
                <Input
                  id="start-minutes"
                  type="number"
                  min="1"
                  max="60"
                  value={createForm.startMinutes}
                  onChange={(e) => setCreateForm(prev => ({ ...prev, startMinutes: e.target.value }))}
                  data-testid="create-start-minutes"
                />
              </div>
              
              <div>
                <Label htmlFor="rake-bps">Rake (basis points, max 500)</Label>
                <Input
                  id="rake-bps"
                  type="number"
                  min="0"
                  max="500"
                  value={createForm.rakeBps}
                  onChange={(e) => setCreateForm(prev => ({ ...prev, rakeBps: e.target.value }))}
                  data-testid="create-rake-bps"
                />
                <div className="text-xs text-muted-foreground mt-1">
                  Current: {(parseInt(createForm.rakeBps) / 100).toFixed(1)}%
                </div>
              </div>
              
              <div>
                <Label htmlFor="runner-limit">Number of Runners</Label>
                <Input
                  id="runner-limit"
                  type="number"
                  min="4"
                  max="12"
                  value={createForm.limit}
                  onChange={(e) => setCreateForm(prev => ({ ...prev, limit: e.target.value }))}
                  data-testid="create-runner-limit"
                />
              </div>
              
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id="jackpot-flag"
                  checked={createForm.jackpotFlag}
                  onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, jackpotFlag: !!checked }))}
                  data-testid="create-jackpot-flag"
                />
                <Label htmlFor="jackpot-flag" className="text-sm">
                  Add Jackpot to this race
                </Label>
              </div>
              
              <Button 
                onClick={() => createRaceMutation.mutate()}
                disabled={createRaceMutation.isPending}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
                data-testid="create-race-btn"
              >
                {createRaceMutation.isPending ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
                    Creating Race...
                  </>
                ) : (
                  <>
                    <i className="fas fa-rocket mr-2"></i>
                    Create Race
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Race Management & Faucet */}
          <Card>
            <CardHeader>
              <CardTitle className="text-secondary flex items-center gap-2">
                <i className="fas fa-tools"></i>
                Race Management & Tools
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Faucet */}
              <div>
                <h4 className="font-semibold mb-3 text-accent flex items-center gap-2">
                  <i className="fas fa-faucet"></i>
                  $RACE Token Faucet
                </h4>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="faucet-address">Wallet Address</Label>
                    <div className="flex gap-2">
                      <Input
                        id="faucet-address"
                        placeholder="Wallet address"
                        value={faucetForm.address}
                        onChange={(e) => setFaucetForm(prev => ({ ...prev, address: e.target.value }))}
                        className="font-mono text-xs"
                        data-testid="faucet-address"
                      />
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={fillWalletAddress}
                        disabled={!publicKey}
                        data-testid="fill-wallet-btn"
                      >
                        Mine
                      </Button>
                    </div>
                  </div>
                  
                  <div>
                    <Label htmlFor="faucet-amount">Amount ($RACE)</Label>
                    <Input
                      id="faucet-amount"
                      type="number"
                      min="1"
                      max="100000"
                      value={faucetForm.amount}
                      onChange={(e) => setFaucetForm(prev => ({ ...prev, amount: e.target.value }))}
                      data-testid="faucet-amount"
                      key="faucet-100k"
                    />
                  </div>
                  
                  <Button 
                    onClick={() => faucetMutation.mutate()}
                    disabled={faucetMutation.isPending || !faucetForm.address}
                    className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                    data-testid="faucet-send-btn"
                  >
                    {faucetMutation.isPending ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
                        Sending...
                      </>
                    ) : (
                      <>
                        <i className="fas fa-coins mr-2"></i>
                        Send $RACE
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Active Races Management */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <i className="fas fa-flag-checkered text-secondary"></i>
              Race Management
            </CardTitle>
          </CardHeader>
          <CardContent>
            {racesLoading ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-16 bg-muted/20 rounded animate-pulse"></div>
                ))}
              </div>
            ) : races && races.length > 0 ? (
              <div className="space-y-2">
                {races.slice(0, 10).map((race: any) => (
                  <div key={race.id} className="flex items-center justify-between p-3 bg-muted/20 rounded" data-testid={`race-management-${race.id}`}>
                    <div className="flex items-center gap-3">
                      <Badge variant={
                        (race.computedStatus ?? race.status) === 'OPEN' ? 'default' :
                        (race.computedStatus ?? race.status) === 'LOCKED' ? 'destructive' :
                        (race.computedStatus ?? race.status) === 'SETTLED' ? 'secondary' : 'outline'
                      }>
                        {race.status}
                      </Badge>
                      <div>
                        <div className="text-sm font-semibold">{getShortRaceTag(race.id)}</div>
                        <div className="text-xs text-muted-foreground">
                          {race.runners?.length || 0} runners • {formatLargeNumber(race.totalPot || '0')} $RACE pot
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex gap-2">
                      {(race.computedStatus ?? race.status) === 'OPEN' && (
                        <>
                          <Button 
                            size="sm"
                            onClick={() => lockRaceMutation.mutate(race.id)}
                            disabled={lockRaceMutation.isPending}
                            className="bg-secondary text-secondary-foreground hover:bg-secondary/90"
                            data-testid={`lock-race-${race.id}`}
                          >
                            <i className="fas fa-lock mr-1"></i>
                            Lock
                          </Button>
                          <Button 
                            size="sm"
                            variant="destructive"
                            onClick={() => cancelRaceMutation.mutate(race.id)}
                            disabled={cancelRaceMutation.isPending}
                            data-testid={`cancel-race-${race.id}`}
                          >
                            <i className="fas fa-times mr-1"></i>
                            Cancel
                          </Button>
                        </>
                      )}
                      
                      {(race.computedStatus ?? race.status) === 'LOCKED' && (
                        <Badge variant="destructive" className="animate-pulse">
                          <i className="fas fa-spinner fa-spin mr-1"></i>
                          LIVE
                        </Badge>
                      )}
                      
                      {(race.computedStatus ?? race.status) === 'SETTLED' && race.winnerIndex !== undefined && (
                        <Badge variant="secondary">
                          <i className="fas fa-trophy mr-1"></i>
                          {race.runners?.[race.winnerIndex]?.symbol || 'Winner'}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                No races found. Create your first race above.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
