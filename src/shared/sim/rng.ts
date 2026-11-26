/**
 * Deterministic PRNG (Mulberry32) and RNG helpers for reproducible simulation
 * ticks, wave spawns, crit rolls, and level-up card shuffles.
 */

export interface RngSource {
  /** Returns a float in [0, 1). */
  next(): number;
  /** Returns a float in [min, max). */
  range(min: number, max: number): number;
  /** Returns an integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Returns true with probability `p` (0..1). */
  chance(p: number): boolean;
  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(arr: T[]): T[];
}

export class SeededRng implements RngSource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) {
      this.state = 0x6d2b79f5;
    }
  }

  public getState(): number {
    return this.state;
  }

  public next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  public range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  public int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  public chance(p: number): boolean {
    return this.next() < p;
  }

  public shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}

export class MathRandomRng implements RngSource {
  public next(): number {
    return Math.random();
  }

  public range(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  public int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  public chance(p: number): boolean {
    return Math.random() < p;
  }

  public shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}

export function createRng(seed?: number): RngSource {
  return seed !== undefined ? new SeededRng(seed) : new MathRandomRng();
}
