import { getMutedPreference, setMutedPreference } from './storage';

/**
 * Procedural Web Audio API chiptune/pastel SFX synthesizer.
 * Zero external audio assets; lazily unlocks AudioContext on first user gesture.
 */

type WaveType = OscillatorType;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private muted: boolean;

  // Throttle high-frequency sounds to prevent harsh clipping during dense waves
  private lastHitMs = 0;
  private lastXpMs = 0;
  private xpComboCount = 0;

  constructor(initialMuted?: boolean) {
    this.muted = initialMuted ?? getMutedPreference();
  }

  /**
   * Unlocks/resumes the Web Audio context. Safe to call on any user interaction.
   */
  public unlock(): void {
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        // Browser may still require another direct gesture
      });
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    setMutedPreference(muted);
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.35, this.ctx.currentTime, 0.015);
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    if (!this.muted) {
      this.unlock();
      this.playClick();
    }
    return this.muted;
  }

  /**
   * Soft pastel pop/thwack when an enemy takes damage.
   */
  public playHit(isCrit = false): void {
    if (this.muted) return;
    const nowMs = performance.now();
    if (nowMs - this.lastHitMs < 32) return;
    this.lastHitMs = nowMs;

    const ctx = this.ensureReadyContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    const baseFreq = isCrit ? 420 : 250 + Math.random() * 55;
    this.playTone(ctx, {
      type: isCrit ? 'square' : 'triangle',
      startFreq: baseFreq,
      endFreq: isCrit ? 190 : 110,
      startTime: t,
      duration: isCrit ? 0.085 : 0.055,
      gain: isCrit ? 0.2 : 0.14,
    });

    if (isCrit) {
      this.playTone(ctx, {
        type: 'sine',
        startFreq: 880,
        endFreq: 1320,
        startTime: t + 0.015,
        duration: 0.07,
        gain: 0.12,
      });
    }
  }

  /**
   * Low soft thud when the player takes damage.
   */
  public playPlayerHit(): void {
    if (this.muted) return;
    const ctx = this.ensureReadyContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    this.playTone(ctx, {
      type: 'sawtooth',
      startFreq: 170,
      endFreq: 68,
      startTime: t,
      duration: 0.16,
      gain: 0.22,
    });
    this.playTone(ctx, {
      type: 'triangle',
      startFreq: 115,
      endFreq: 52,
      startTime: t + 0.02,
      duration: 0.18,
      gain: 0.18,
    });
  }

  /**
   * Bright chiptune chime when collecting an XP gem, pitching up gently on streaks.
   */
  public playXp(tier: 1 | 2 | 3 = 1): void {
    if (this.muted) return;
    const nowMs = performance.now();
    if (nowMs - this.lastXpMs < 38) return;

    if (nowMs - this.lastXpMs < 420) {
      this.xpComboCount = Math.min(this.xpComboCount + 1, 10);
    } else {
      this.xpComboCount = 0;
    }
    this.lastXpMs = nowMs;

    const ctx = this.ensureReadyContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    const pentatonic = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];
    const index = Math.min(this.xpComboCount + (tier - 1), pentatonic.length - 1);
    const freq = pentatonic[index];

    this.playTone(ctx, {
      type: 'sine',
      startFreq: freq,
      endFreq: freq * 1.12,
      startTime: t,
      duration: 0.09,
      gain: 0.14,
    });
    this.playTone(ctx, {
      type: 'triangle',
      startFreq: freq * 1.5,
      endFreq: freq * 1.5,
      startTime: t + 0.02,
      duration: 0.06,
      gain: 0.07,
    });
  }

  /**
   * Uplifting 4-note pastel arpeggio on Level-Up.
   */
  public playLevelUp(): void {
    if (this.muted) return;
    const ctx = this.ensureReadyContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    for (let i = 0; i < notes.length; i++) {
      const start = t + i * 0.075;
      const isLast = i === notes.length - 1;
      this.playTone(ctx, {
        type: 'triangle',
        startFreq: notes[i],
        endFreq: notes[i],
        startTime: start,
        duration: isLast ? 0.28 : 0.11,
        gain: 0.2,
      });
      this.playTone(ctx, {
        type: 'square',
        startFreq: notes[i] * 0.5,
        endFreq: notes[i] * 0.5,
        startTime: start,
        duration: isLast ? 0.24 : 0.09,
        gain: 0.06,
      });
    }
  }

  /**
   * Rich celebratory fanfare for Synergy Evolution or Boss Artifact unlock.
   */
  public playSynergy(): void {
    if (this.muted) return;
    const ctx = this.ensureReadyContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    // Sparkling ascending major-9th arpeggio + warm chord resolve
    const arp = [523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98];
    for (let i = 0; i < arp.length; i++) {
      const start = t + i * 0.065;
      this.playTone(ctx, {
        type: 'square',
        startFreq: arp[i],
        endFreq: arp[i],
        startTime: start,
        duration: 0.14,
        gain: 0.09,
      });
      this.playTone(ctx, {
        type: 'triangle',
        startFreq: arp[i],
        endFreq: arp[i],
        startTime: start,
        duration: 0.18,
        gain: 0.16,
      });
    }

    // Final shimmering pastel chord
    const chordStart = t + arp.length * 0.065;
    const chord = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < chord.length; i++) {
      this.playTone(ctx, {
        type: 'sine',
        startFreq: chord[i],
        endFreq: chord[i] * 1.005,
        startTime: chordStart,
        duration: 0.48,
        gain: 0.12,
      });
    }
  }

  /**
   * Dramatic chiptune warning siren when a Boss spawns.
   */
  public playBossAlert(): void {
    if (this.muted) return;
    const ctx = this.ensureReadyContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    for (let pulse = 0; pulse < 3; pulse++) {
      const start = t + pulse * 0.22;
      this.playTone(ctx, {
        type: 'sawtooth',
        startFreq: 330,
        endFreq: 220,
        startTime: start,
        duration: 0.18,
        gain: 0.17,
      });
      this.playTone(ctx, {
        type: 'square',
        startFreq: 165,
        endFreq: 110,
        startTime: start,
        duration: 0.18,
        gain: 0.12,
      });
    }
  }

  /**
   * Warm chime for collecting Pastel Hearts, Magnet Orbs, or Boss Chests.
   */
  public playPickup(): void {
    if (this.muted) return;
    const ctx = this.ensureReadyContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    this.playTone(ctx, {
      type: 'sine',
      startFreq: 587.33,
      endFreq: 880,
      startTime: t,
      duration: 0.11,
      gain: 0.16,
    });
    this.playTone(ctx, {
      type: 'triangle',
      startFreq: 880,
      endFreq: 1174.66,
      startTime: t + 0.07,
      duration: 0.14,
      gain: 0.14,
    });
  }

  /**
   * Subtle UI click tick.
   */
  public playClick(): void {
    if (this.muted) return;
    const ctx = this.ensureReadyContext();
    if (!ctx) return;

    const t = ctx.currentTime;
    this.playTone(ctx, {
      type: 'triangle',
      startFreq: 640,
      endFreq: 480,
      startTime: t,
      duration: 0.04,
      gain: 0.1,
    });
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return null;

    try {
      const ctx = new AudioCtx();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.35;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.masterGain = master;
      return ctx;
    } catch {
      return null;
    }
  }

  private ensureReadyContext(): AudioContext | null {
    const ctx = this.ensureContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    return ctx;
  }

  private playTone(
    ctx: AudioContext,
    opts: {
      type: WaveType;
      startFreq: number;
      endFreq: number;
      startTime: number;
      duration: number;
      gain: number;
    }
  ): void {
    if (!this.masterGain) return;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = opts.type;
    osc.frequency.setValueAtTime(Math.max(20, opts.startFreq), opts.startTime);
    if (opts.endFreq !== opts.startFreq) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, opts.endFreq),
        opts.startTime + opts.duration
      );
    }

    env.gain.setValueAtTime(0.0001, opts.startTime);
    env.gain.linearRampToValueAtTime(opts.gain, opts.startTime + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, opts.startTime + opts.duration);

    osc.connect(env);
    env.connect(this.masterGain);

    osc.start(opts.startTime);
    osc.stop(opts.startTime + opts.duration + 0.01);
  }
}
