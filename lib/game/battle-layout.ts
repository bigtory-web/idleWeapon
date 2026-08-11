import { GRID_COLUMNS, GRID_ROWS } from "./types";

export const ALLY_DEPLOY_X_MIN = 58;
export const ALLY_DEPLOY_X_STEP = 16;
export const ALLY_DEPLOY_Y_MIN = 230;
export const ALLY_DEPLOY_Y_STEP = 20;
export const ALLY_DEPLOY_Y_MAX = ALLY_DEPLOY_Y_MIN + (GRID_ROWS - 1) * ALLY_DEPLOY_Y_STEP;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getAllyDeployPosition(row: number, col: number): { x: number; y: number } {
  const boardRow = clamp(Math.round(row), 0, GRID_ROWS - 1);
  const boardCol = clamp(Math.round(col), 0, GRID_COLUMNS - 1);
  return {
    x: ALLY_DEPLOY_X_MIN + boardCol * ALLY_DEPLOY_X_STEP,
    y: ALLY_DEPLOY_Y_MIN + boardRow * ALLY_DEPLOY_Y_STEP,
  };
}
