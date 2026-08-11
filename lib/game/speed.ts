import type { BattleSpeed } from "./types";

export function normalizeBattleSpeed(value: unknown): BattleSpeed {
  return value === 0.5 || value === 2 ? value : 1;
}

export function getScaledFrameSteps(realSeconds: number, speed: BattleSpeed): number[] {
  let remaining = Math.max(0, Math.min(Number.isFinite(realSeconds) ? realSeconds : 0, 0.1)) * speed;
  const steps: number[] = [];
  while (remaining > 0.000001) {
    const step = Math.min(remaining, 0.05);
    steps.push(step);
    remaining -= step;
  }
  return steps;
}
