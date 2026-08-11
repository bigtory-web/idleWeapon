import { BATTLEFIELD_COLUMNS, GRID_ROWS, PLAYER_DEPLOY_COLUMNS, type BoardUnlockColumn } from "./types";

export const BATTLE_CELL_X_MIN = 60;
export const BATTLE_CELL_X_STEP = 45;
export const ALLY_DEPLOY_Y_MIN = 230;
export const ALLY_DEPLOY_Y_STEP = 20;
export const ALLY_DEPLOY_Y_MAX = ALLY_DEPLOY_Y_MIN + (GRID_ROWS - 1) * ALLY_DEPLOY_Y_STEP;

export interface OutpostObjective {
  battleColumn: 3 | 5;
  unlockColumn: BoardUnlockColumn;
  rows: readonly [1, 3];
  hp: number;
}

export const FIRST_WAVE_OUTPOST_OBJECTIVES: readonly OutpostObjective[] = [
  { battleColumn: 3, unlockColumn: 4, rows: [1, 3], hp: 90 },
  { battleColumn: 5, unlockColumn: 6, rows: [1, 3], hp: 90 },
] as const;

export function getWaveOutpostObjectives(waveIndex: number): readonly OutpostObjective[] {
  return waveIndex === 1 ? FIRST_WAVE_OUTPOST_OBJECTIVES : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getAllyDeployPosition(row: number, col: number): { x: number; y: number } {
  const boardRow = clamp(Math.round(row), 0, GRID_ROWS - 1);
  const boardCol = clamp(Math.round(col), 0, PLAYER_DEPLOY_COLUMNS - 1);
  return {
    x: BATTLE_CELL_X_MIN + boardCol * BATTLE_CELL_X_STEP,
    y: ALLY_DEPLOY_Y_MIN + boardRow * ALLY_DEPLOY_Y_STEP,
  };
}

export function getBattleCellPosition(row: number, col: number): { x: number; y: number } {
  return {
    x: BATTLE_CELL_X_MIN + clamp(Math.round(col), 0, BATTLEFIELD_COLUMNS - 1) * BATTLE_CELL_X_STEP,
    y: ALLY_DEPLOY_Y_MIN + clamp(Math.round(row), 0, GRID_ROWS - 1) * ALLY_DEPLOY_Y_STEP,
  };
}
