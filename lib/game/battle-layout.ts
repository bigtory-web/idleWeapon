import { BATTLEFIELD_COLUMNS, GRID_ROWS, PLAYER_DEPLOY_COLUMNS } from "./types";

export const BATTLE_CELL_X_MIN = 42;
export const BATTLE_CELL_X_STEP = 34;
export const ALLY_DEPLOY_Y_MIN = 230;
export const ALLY_DEPLOY_Y_STEP = 20;
export const ALLY_DEPLOY_Y_MAX = ALLY_DEPLOY_Y_MIN + (GRID_ROWS - 1) * ALLY_DEPLOY_Y_STEP;

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
