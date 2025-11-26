import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { audioManager } from '@/lib/audio';

export default function AudioControls() {
  const [masterVolume, setMasterVolume] = useState(70);
  const [sfxVolume, setSfxVolume] = useState(80);
  const [musicVolume, setMusicVolume] = useState(50);
  const [isMuted, setIsMuted] = useState(false);
  const [isMinimized, setIsMinimized] = useState(true);

  // Update audio manager when values change
  useEffect(() => {
    audioManager.setMasterVolume(masterVolume / 100);
  }, [masterVolume]);

  useEffect(() => {
    audioManager.setSfxVolume(sfxVolume / 100);
  }, [sfxVolume]);

  useEffect(() => {
    audioManager.setMusicVolume(musicVolume / 100);
  }, [musicVolume]);

  useEffect(() => {
    audioManager.setMuted(isMuted);
  }, [isMuted]);

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const toggleMinimized = () => {
    setIsMinimized(!isMinimized);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <Card className={`bg-background/95 backdrop-blur-sm border-primary/20 transition-all duration-300 ${
        isMinimized ? 'w-16' : 'w-80'
      }`}>
        {isMinimized ? (
          <CardContent className="p-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleMinimized}
              className="w-full h-8 p-0"
              data-testid="expand-audio-controls"
            >
              <i className={`fas ${isMuted ? 'fa-volume-mute text-destructive' : 'fa-volume-up text-primary'} text-lg`}></i>
            </Button>
          </CardContent>
        ) : (
          <>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <i className="fas fa-music text-primary"></i>
                  Audio Controls
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant={isMuted ? 'destructive' : 'secondary'} className="text-xs">
                    {isMuted ? 'MUTED' : 'ON'}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleMinimized}
                    className="h-6 w-6 p-0"
                    data-testid="minimize-audio-controls"
                  >
                    <i className="fas fa-minus text-xs"></i>
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Master Volume */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium flex items-center gap-1">
                    <i className="fas fa-volume-up text-primary"></i>
                    Master
                  </label>
                  <span className="text-xs text-muted-foreground">{masterVolume}%</span>
                </div>
                <Slider
                  value={[masterVolume]}
                  onValueChange={(value) => setMasterVolume(value[0])}
                  max={100}
                  step={1}
                  className="w-full"
                  disabled={isMuted}
                  data-testid="master-volume-slider"
                />
              </div>

              {/* Sound Effects Volume */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium flex items-center gap-1">
                    <i className="fas fa-magic text-secondary"></i>
                    SFX
                  </label>
                  <span className="text-xs text-muted-foreground">{sfxVolume}%</span>
                </div>
                <Slider
                  value={[sfxVolume]}
                  onValueChange={(value) => setSfxVolume(value[0])}
                  max={100}
                  step={1}
                  className="w-full"
                  disabled={isMuted}
                  data-testid="sfx-volume-slider"
                />
              </div>

              {/* Music Volume */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium flex items-center gap-1">
                    <i className="fas fa-music text-accent"></i>
                    Music
                  </label>
                  <span className="text-xs text-muted-foreground">{musicVolume}%</span>
                </div>
                <Slider
                  value={[musicVolume]}
                  onValueChange={(value) => setMusicVolume(value[0])}
                  max={100}
                  step={1}
                  className="w-full"
                  disabled={isMuted}
                  data-testid="music-volume-slider"
                />
              </div>

              {/* Mute Toggle */}
              <Button
                variant={isMuted ? 'destructive' : 'outline'}
                size="sm"
                onClick={toggleMute}
                className="w-full"
                data-testid="mute-toggle-button"
              >
                <i className={`fas ${isMuted ? 'fa-volume-mute' : 'fa-volume-up'} mr-2`}></i>
                {isMuted ? 'Unmute Audio' : 'Mute Audio'}
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}