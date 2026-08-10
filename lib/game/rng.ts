export interface RandomSource {
  /** A floating-point number in the half-open range [0, 1). */
  next(): number;
  /** An unsigned 32-bit integer. */
  uint32(): number;
  /** An integer in the half-open range [min, maxExclusive). */
  int(min: number, maxExclusive: number): number;
  /** A floating-point number in the half-open range [min, max). */
  between(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(values: readonly T[]): T;
  shuffle<T>(values: readonly T[]): T[];
}

export function normalizeSeed(seed: string | null | undefined): string {
  const normalized = seed?.trim();
  return normalized ? normalized : "prototype-001";
}

/** xmur3 turns a string into a stable unsigned 32-bit seed. */
export function hashSeed(seed: string): number {
  let hash = 1779033703 ^ seed.length;

  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Small deterministic PRNG using mulberry32. Its state is deliberately exposed
 * only through methods so callers cannot accidentally mix in Math.random().
 */
export class SeededRng implements RandomSource {
  readonly seed: string;
  private state: number;

  constructor(seed: string) {
    this.seed = normalizeSeed(seed);
    this.state = hashSeed(this.seed);
  }

  uint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  next(): number {
    return this.uint32() / 4294967296;
  }

  int(min: number, maxExclusive: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(maxExclusive) || maxExclusive <= min) {
      throw new RangeError("int 범위는 정수여야 하며 maxExclusive가 min보다 커야 합니다.");
    }

    return Math.floor(this.next() * (maxExclusive - min)) + min;
  }

  between(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
      throw new RangeError("between 범위는 유한해야 하며 max가 min 이상이어야 합니다.");
    }

    return min + this.next() * (max - min);
  }

  chance(probability: number): boolean {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError("확률은 0 이상 1 이하여야 합니다.");
    }

    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new RangeError("빈 목록에서는 항목을 뽑을 수 없습니다.");
    }

    return values[this.int(0, values.length)] as T;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const shuffled = [...values];

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = this.int(0, index + 1);
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex] as T, shuffled[index] as T];
    }

    return shuffled;
  }

  fork(label: string): SeededRng {
    return new SeededRng(`${this.seed}:${label}`);
  }
}

export function createSeededRng(seed: string | null | undefined): SeededRng {
  return new SeededRng(normalizeSeed(seed));
}

export function createDeterministicId(prefix: string, rng: RandomSource): string {
  return `${prefix}-${rng.uint32().toString(36).padStart(7, "0")}`;
}
