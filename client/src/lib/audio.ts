// Audio Manager for Pump Racers
// Handles all sound effects and background music

export type SoundEffect = 
  | 'race_start'
  | 'race_countdown'
  | 'race_finish'
  | 'winner_announcement'
  | 'bet_placed'
  | 'button_click'
  | 'notification'
  | 'engines_running'
  | 'crowd_cheer';

export type MusicTrack = 
  | 'lobby_ambient'
  | 'race_tension'
  | 'victory_fanfare';

class AudioManager {
  private context: AudioContext | null = null;
  private masterVolume = 0.7;
  private sfxVolume = 0.8;
  private musicVolume = 0.5;
  private isMuted = false;
  private currentMusic: { stop: () => void } | null = null;
  private soundCache = new Map<string, AudioBuffer>();
  private isInitialized = false;
  // Optional: map logical effect/track names to file URLs under public/audio
  private sfxFileMap: Record<SoundEffect, string | string[] | undefined> = {
    race_start: undefined,
    race_countdown: undefined,
    race_finish: undefined,
    winner_announcement: undefined,
    // Expect a realistic cash register sample here if present (provide multiple formats for compatibility)
    bet_placed: ['/audio/cash-register.ogg', '/audio/cash-register.mp3'],
    button_click: undefined,
    notification: undefined,
    engines_running: undefined,
    crowd_cheer: undefined,
  };
  private musicFileMap: Record<MusicTrack, string | undefined> = {
    // Expect loopable lobby track if present
    lobby_ambient: '/audio/lobby.mp3',
    race_tension: undefined,
    victory_fanfare: undefined,
  };

  constructor() {
    // Audio context will be created on first user interaction
  }

  // Initialize audio context (must be called after user interaction)
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    try {
      this.context = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.isInitialized = true;
      console.log('Audio system initialized');
    } catch (error) {
      console.warn('Audio context not supported:', error);
    }
  }

  // Generate synthetic sound effects using Web Audio API
  private generateSoundEffect(type: SoundEffect): AudioBuffer | null {
    if (!this.context) return null;

    const sampleRate = this.context.sampleRate;
    let duration: number;
    let frequency: number;
    let waveType: OscillatorType = 'sine';
    
    switch (type) {
      case 'race_start':
        duration = 1.5;
        frequency = 800;
        waveType = 'sawtooth';
        break;
      case 'race_countdown':
        duration = 0.3;
        frequency = 600;
        waveType = 'square';
        break;
      case 'race_finish':
        duration = 2.0;
        frequency = 1000;
        waveType = 'triangle';
        break;
      case 'winner_announcement':
        duration = 3.0;
        frequency = 523; // C5 note
        waveType = 'sine';
        break;
      case 'bet_placed':
        duration = 0.2;
        frequency = 800;
        waveType = 'sine';
        break;
      case 'button_click':
        duration = 0.1;
        frequency = 1200;
        waveType = 'square';
        break;
      case 'notification':
        duration = 0.5;
        frequency = 800;
        waveType = 'sine';
        break;
      case 'engines_running':
        duration = 2.0;
        frequency = 120;
        waveType = 'sawtooth';
        break;
      case 'crowd_cheer':
        duration = 3.0;
        frequency = 400;
        waveType = 'sine';
        break;
      default:
        return null;
    }

    const buffer = this.context.createBuffer(1, sampleRate * duration, sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      let sample = 0;
      
      if (type === 'race_start') {
        // Rising tone with vibrato
        const vibrato = Math.sin(t * 10) * 0.1;
        sample = Math.sin(2 * Math.PI * (frequency + frequency * t * 0.5 + vibrato) * t) * Math.pow(1 - t / duration, 2);
      } else if (type === 'race_finish') {
        // Victory fanfare - multiple harmonics
        sample = (
          Math.sin(2 * Math.PI * frequency * t) * 0.5 +
          Math.sin(2 * Math.PI * frequency * 1.5 * t) * 0.3 +
          Math.sin(2 * Math.PI * frequency * 2 * t) * 0.2
        ) * Math.pow(1 - t / duration, 1.5);
      } else if (type === 'winner_announcement') {
        // Triumphant chord progression
        const chord = [
          Math.sin(2 * Math.PI * frequency * t),        // Root
          Math.sin(2 * Math.PI * frequency * 1.25 * t), // Major third
          Math.sin(2 * Math.PI * frequency * 1.5 * t),  // Perfect fifth
        ];
        sample = chord.reduce((sum, note) => sum + note, 0) / chord.length * Math.pow(1 - t / duration, 2);
      } else if (type === 'engines_running') {
        // Low rumbling engine sound without random noise
        const engine = Math.sin(2 * Math.PI * frequency * t) + Math.sin(2 * Math.PI * frequency * 2.1 * t) * 0.5;
        sample = engine * (0.5 + 0.5 * Math.sin(t * 3));
      } else if (type === 'crowd_cheer') {
        // Simulated crowd cheer without random noise
        const cheer = Math.sin(2 * Math.PI * frequency * t) + Math.sin(2 * Math.PI * (frequency + 100) * t);
        sample = cheer * Math.pow(1 - t / duration, 1.5);
      } else {
        // Simple tone with envelope
        const envelope = t < duration * 0.1 ? t / (duration * 0.1) : 
                        t > duration * 0.9 ? (duration - t) / (duration * 0.1) : 1;
        sample = Math.sin(2 * Math.PI * frequency * t) * envelope;
      }
      
      data[i] = Math.max(-1, Math.min(1, sample)); // Clamp to prevent distortion
    }
    
    return buffer;
  }

  private async loadAudioBuffer(url: string): Promise<AudioBuffer | null> {
    try {
      if (!this.context) return null;
      const cacheKey = `file:${url}`;
      const cached = this.soundCache.get(cacheKey);
      if (cached) return cached;
      const response = await fetch(url);
      if (!response.ok) return null;
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
      this.soundCache.set(cacheKey, audioBuffer);
      return audioBuffer;
    } catch {
      return null;
    }
  }

  // Order candidate URLs by what the browser reports as supported
  private prioritizeSupportedAudioUrls(urls: string[]): string[] {
    try {
      const audio = new Audio();
      const score = (url: string): number => {
        const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
        if (!ext) return 0;
        const mime = ext === 'ogg' ? 'audio/ogg; codecs="vorbis"'
                  : ext === 'mp3' ? 'audio/mpeg'
                  : ext === 'wav' ? 'audio/wav'
                  : `audio/${ext}`;
        const support = audio.canPlayType(mime);
        return support === 'probably' ? 2 : support === 'maybe' ? 1 : 0;
      };
      return [...urls].sort((a, b) => score(b) - score(a));
    } catch {
      return urls;
    }
  }

  // Play a sound effect
  async playSoundEffect(type: SoundEffect, volume: number = 1): Promise<void> {
    await this.initialize();
    if (!this.context || this.isMuted) return;
    
    try {
      if (this.context.state === 'suspended') {
        try { await this.context.resume(); } catch {}
      }
      let buffer = this.soundCache.get(type);
      if (!buffer) {
        // Try file-backed SFX first (support multiple formats)
        const fileEntry = this.sfxFileMap[type];
        const candidates = (Array.isArray(fileEntry) ? fileEntry : (fileEntry ? [fileEntry] : []));
        const ordered = this.prioritizeSupportedAudioUrls(candidates);
        for (const url of ordered) {
          const loaded = await this.loadAudioBuffer(url);
          if (loaded) {
            buffer = loaded;
            this.soundCache.set(type, buffer);
            break;
          }
        }
      }
      if (!buffer) {
        // Fallback to generated tone
        const generatedBuffer = this.generateSoundEffect(type);
        if (generatedBuffer) {
          buffer = generatedBuffer;
          this.soundCache.set(type, buffer);
        }
      }
      
      if (!buffer) return;
      
      const source = this.context.createBufferSource();
      const gainNode = this.context.createGain();
      
      source.buffer = buffer;
      source.connect(gainNode);
      gainNode.connect(this.context.destination);
      
      gainNode.gain.value = this.masterVolume * this.sfxVolume * volume;
      source.start();
      
    } catch (error) {
      console.warn('Failed to play sound effect:', type, error);
    }
  }

  // Play background music (simulated with ambient tones)
  async playMusic(track: MusicTrack): Promise<void> {
    await this.initialize();
    if (!this.context || this.isMuted) return;
    
    this.stopMusic();
    
    if (this.context.state === 'suspended') {
      try { await this.context.resume(); } catch {}
    }
    
    try {
      const gainNode = this.context.createGain();
      gainNode.connect(this.context.destination);
      const targetGain = this.masterVolume * this.musicVolume * 0.5;
      gainNode.gain.setValueAtTime(0, this.context.currentTime);

      // Prefer file-backed music if available
      const fileUrl = this.musicFileMap[track];
      const fileBuffer = fileUrl ? await this.loadAudioBuffer(fileUrl) : null;

      if (fileBuffer) {
        const source = this.context.createBufferSource();
        source.buffer = fileBuffer;
        source.loop = true;
        source.connect(gainNode);
        source.start(0);
        // Fade in
        gainNode.gain.linearRampToValueAtTime(targetGain, this.context.currentTime + 1.0);
        this.currentMusic = { stop: () => { try { source.stop(); } catch {} } };
        return;
      }

      // Fallback: synthesized ambient tones
      const oscillator1 = this.context.createOscillator();
      const oscillator2 = this.context.createOscillator();
      const filter = this.context.createBiquadFilter();
      oscillator1.connect(gainNode);
      oscillator2.connect(gainNode);
      gainNode.connect(filter);
      filter.connect(this.context.destination);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800, this.context.currentTime);
      filter.Q.setValueAtTime(1, this.context.currentTime);

      switch (track) {
        case 'lobby_ambient':
          oscillator1.frequency.setValueAtTime(220, this.context.currentTime);
          oscillator2.frequency.setValueAtTime(330, this.context.currentTime);
          oscillator1.type = 'sine';
          oscillator2.type = 'triangle';
          break;
        case 'race_tension':
          oscillator1.frequency.setValueAtTime(110, this.context.currentTime);
          oscillator2.frequency.setValueAtTime(165, this.context.currentTime);
          oscillator1.type = 'sawtooth';
          oscillator2.type = 'square';
          break;
        case 'victory_fanfare':
          oscillator1.frequency.setValueAtTime(523, this.context.currentTime);
          oscillator2.frequency.setValueAtTime(659, this.context.currentTime);
          oscillator1.type = 'sine';
          oscillator2.type = 'triangle';
          break;
      }

      gainNode.gain.setValueAtTime(0, this.context.currentTime);
      oscillator1.start();
      oscillator2.start();
      gainNode.gain.linearRampToValueAtTime(targetGain * 0.6, this.context.currentTime + 0.8);
      this.currentMusic = { stop: () => { try { oscillator1.stop(); oscillator2.stop(); } catch {} } };
      
    } catch (error) {
      console.warn('Failed to play music:', track, error);
    }
  }

  // Stop current background music
  stopMusic(): void {
    if (this.currentMusic) {
      try {
        this.currentMusic.stop();
      } catch (error) {
        // Ignore errors when stopping
      }
      this.currentMusic = null;
    }
  }

  // Volume controls
  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
  }

  setSfxVolume(volume: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, volume));
  }

  setMusicVolume(volume: number): void {
    this.musicVolume = Math.max(0, Math.min(1, volume));
  }

  // Mute/unmute
  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted) {
      this.stopMusic();
    }
  }

  // Getters
  getMasterVolume(): number { return this.masterVolume; }
  getSfxVolume(): number { return this.sfxVolume; }
  getMusicVolume(): number { return this.musicVolume; }
  isMutedState(): boolean { return this.isMuted; }
}

// Global audio manager instance
export const audioManager = new AudioManager();

// Convenience functions
export const playSound = (effect: SoundEffect, volume?: number) => audioManager.playSoundEffect(effect, volume);
export const playMusic = (track: MusicTrack) => audioManager.playMusic(track);
export const stopMusic = () => audioManager.stopMusic();
export const setVolume = (master: number, sfx: number, music: number) => {
  audioManager.setMasterVolume(master);
  audioManager.setSfxVolume(sfx);
  audioManager.setMusicVolume(music);
};
export const setMuted = (muted: boolean) => audioManager.setMuted(muted);