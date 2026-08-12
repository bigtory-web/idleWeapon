import { CHARACTERS, ITEM_DEFINITIONS, WEAPONS, isCharacterId, isWeaponId } from "./data";
import { getActiveEquipmentCombos } from "./combos";
import {
  INVENTORY_COLUMNS,
  PLAYER_DEPLOY_COLUMNS,
  GRID_ROWS,
  type Direction,
  type EquippedWeaponSnapshot,
  type FootprintCell,
  type GridItem,
  type GridPosition,
  type ItemId,
  type PendingReward,
  type Rotation,
  type SpawnLoadoutSnapshot,
  type SpawnerBlueprint,
  type Tier,
  type WeaponId,
} from "./types";

export const ADJACENT_DIRECTIONS: ReadonlyArray<{
  direction: Direction;
  rowOffset: number;
  colOffset: number;
}> = [
  { direction: "up", rowOffset: -1, colOffset: 0 },
  { direction: "right", rowOffset: 0, colOffset: 1 },
  { direction: "down", rowOffset: 1, colOffset: 0 },
  { direction: "left", rowOffset: 0, colOffset: -1 },
];

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

export interface AdjacentWeaponConnection { item: GridItem; direction: Direction; characterCell: FootprintCell }
export interface InventoryState { gridItems: GridItem[]; pendingRewards: PendingReward[]; unlockedColumns?: number }
export type InventoryFailureReason = "item-not-found" | "target-not-found" | "invalid-position" | "same-item" | "different-item" | "different-tier" | "max-tier";
export interface InventoryActionResult extends InventoryState {
  success: boolean;
  reason?: InventoryFailureReason;
  action: "none" | "moved" | "swapped" | "merged" | "queued" | "reordered";
  swappedWith?: string;
}
export interface GridMoveResult { items: GridItem[]; moved: boolean; swappedWith?: string; reason?: "item-not-found" | "invalid-position" }
export interface PlaceRewardResult { gridItems: GridItem[]; success: boolean; position?: GridPosition; rotation?: Rotation; reason?: "grid-full" }
interface LocatedInventoryItem {
  storage: "grid" | "queue";
  index: number;
  id: string;
  definitionId: ItemId;
  tier: Tier;
  position: GridPosition | null;
}

export function isValidGridPosition(position: GridPosition): boolean {
  return Number.isInteger(position.row) && Number.isInteger(position.col)
    && position.row >= 0 && position.row < GRID_ROWS
    && position.col >= 0 && position.col < INVENTORY_COLUMNS;
}

export function isUsableGridPosition(position: GridPosition, unlockedColumns = PLAYER_DEPLOY_COLUMNS): boolean {
  const usableColumns = Math.max(0, Math.min(PLAYER_DEPLOY_COLUMNS, Math.trunc(unlockedColumns)));
  return isValidGridPosition(position) && position.col < usableColumns;
}

export function positionsEqual(left: GridPosition | null, right: GridPosition | null): boolean {
  return left !== null && right !== null && left.row === right.row && left.col === right.col;
}

export function compareGridPositions(left: GridPosition | null, right: GridPosition | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left.row - right.row || left.col - right.col;
}

export function normalizeRotation(value: number | undefined): Rotation {
  const normalized = ((Math.round(value ?? 0) % 360) + 360) % 360;
  return ROTATIONS.includes(normalized as Rotation) ? normalized as Rotation : 0;
}

function rotatePoint(cell: FootprintCell, steps: number): FootprintCell {
  let next = { ...cell };
  for (let index = 0; index < steps; index += 1) next = { row: next.col, col: -next.row };
  return next;
}

export function getRotatedItemGeometry(definitionId: ItemId, rotation: Rotation = 0): {
  cells: FootprintCell[];
  rows: number;
  cols: number;
} {
  const isCharacter = isCharacterId(definitionId);
  const definition = isCharacter ? CHARACTERS[definitionId] : WEAPONS[definitionId as WeaponId];
  const steps = isCharacter ? 0 : normalizeRotation(rotation) / 90;
  const rawCells = definition.footprint.map((cell) => rotatePoint(cell, steps));
  const minRow = Math.min(...rawCells.map(({ row }) => row));
  const minCol = Math.min(...rawCells.map(({ col }) => col));
  const cells = rawCells.map(({ row, col }) => ({ row: row - minRow, col: col - minCol }));
  return {
    cells,
    rows: Math.max(...cells.map(({ row }) => row)) + 1,
    cols: Math.max(...cells.map(({ col }) => col)) + 1,
  };
}

export function getOccupiedCells(item: Pick<GridItem, "definitionId" | "position" | "rotation">, position = item.position, rotation = normalizeRotation(item.rotation)): GridPosition[] {
  if (!position) return [];
  return getRotatedItemGeometry(item.definitionId, rotation).cells.map((cell) => ({
    row: position.row + cell.row,
    col: position.col + cell.col,
  }));
}

export function getGridItemAt(items: readonly GridItem[], position: GridPosition): GridItem | undefined {
  return items.find((item) => getOccupiedCells(item).some((cell) => positionsEqual(cell, position)));
}

export function canPlaceItem(
  items: readonly GridItem[],
  item: Pick<GridItem, "id" | "definitionId" | "position" | "rotation">,
  position: GridPosition,
  rotation = normalizeRotation(item.rotation),
  ignoredIds: readonly string[] = [item.id],
  unlockedColumns = PLAYER_DEPLOY_COLUMNS,
): boolean {
  const cells = getOccupiedCells(item, position, rotation);
  return cells.length > 0
    && cells.every((cell) => isUsableGridPosition(cell, unlockedColumns))
    && cells.every((cell) => {
      const occupant = getGridItemAt(items, cell);
      return !occupant || ignoredIds.includes(occupant.id);
    });
}

export function findFirstPlacement(items: readonly GridItem[], definitionId: ItemId, preferredRotation?: Rotation, unlockedColumns = PLAYER_DEPLOY_COLUMNS): { position: GridPosition; rotation: Rotation } | null {
  const rotations = [isCharacterId(definitionId) || preferredRotation === undefined
    ? 0 as Rotation
    : normalizeRotation(preferredRotation)];
  const probe: GridItem = { id: "__placement-probe__", definitionId, tier: 1, position: null };
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < unlockedColumns; col += 1) {
      for (const rotation of rotations) {
        const position = { row, col };
        if (canPlaceItem(items, probe, position, rotation, [], unlockedColumns)) return { position, rotation };
      }
    }
  }
  return null;
}

export function placeRewardInFirstEmptyCell(gridItems: readonly GridItem[], reward: PendingReward, unlockedColumns = PLAYER_DEPLOY_COLUMNS): PlaceRewardResult {
  const placement = findFirstPlacement(gridItems, reward.definitionId, reward.rotation, unlockedColumns);
  if (!placement) return { gridItems: cloneGridItems(gridItems), success: false, reason: "grid-full" };
  return {
    gridItems: [...cloneGridItems(gridItems), { ...reward, ...placement }],
    success: true,
    ...placement,
  };
}

export function getAdjacentWeaponConnections(character: GridItem, allItems: readonly GridItem[]): AdjacentWeaponConnection[] {
  if (!character.position || !isCharacterId(character.definitionId)) return [];
  const matches: AdjacentWeaponConnection[] = [];
  for (const weapon of allItems) {
    if (!weapon.position || !isWeaponId(weapon.definitionId)) continue;
    const characterCells = getOccupiedCells(character);
    const weaponCells = getOccupiedCells(weapon);
    let connection: AdjacentWeaponConnection | null = null;
    for (const characterCell of characterCells) {
      for (const candidate of ADJACENT_DIRECTIONS) {
        const touching = weaponCells.some((cell) => cell.row === characterCell.row + candidate.rowOffset && cell.col === characterCell.col + candidate.colOffset);
        if (!touching) continue;
        connection = {
          item: weapon,
          direction: candidate.direction,
          characterCell: { row: characterCell.row - character.position.row, col: characterCell.col - character.position.col },
        };
        break;
      }
      if (connection) break;
    }
    if (connection) matches.push(connection);
  }
  return matches.sort((left, right) => compareGridPositions(left.item.position, right.item.position));
}

export function getAdjacentWeapons(character: GridItem, allItems: readonly GridItem[]): GridItem[] {
  return getAdjacentWeaponConnections(character, allItems).map(({ item }) => item);
}

/** Every physical socket contact is active, independent of character tier. */
export function getActiveWeaponConnections(
  character: GridItem,
  allItems: readonly GridItem[],
): AdjacentWeaponConnection[] {
  if (!character.position || !isCharacterId(character.definitionId)) return [];
  return getAdjacentWeaponConnections(character, allItems);
}

export function getCharactersSharingWeapon(weapon: GridItem, allItems: readonly GridItem[]): GridItem[] {
  if (!weapon.position || !isWeaponId(weapon.definitionId)) return [];
  return allItems.filter((item) => isCharacterId(item.definitionId)
    && getActiveWeaponConnections(item, allItems).some(({ item: candidate }) => candidate.id === weapon.id))
    .sort((left, right) => compareGridPositions(left.position, right.position));
}

export function deriveSpawnerBlueprints(items: readonly GridItem[]): SpawnerBlueprint[] {
  return items.filter((item): item is GridItem & { position: GridPosition } => item.position !== null && isCharacterId(item.definitionId))
    .sort((left, right) => compareGridPositions(left.position, right.position))
    .map((character) => {
      const weapons = getActiveWeaponConnections(character, items).map(({ item, direction }): EquippedWeaponSnapshot => ({
        sourceItemId: item.id,
        weaponId: item.definitionId as WeaponId,
        tier: item.tier,
        direction,
      }));
      const equipmentCost = weapons.reduce((total, weapon) => total + WEAPONS[weapon.weaponId].equipmentCost, 0);
      return {
        id: character.id,
        characterId: character.definitionId as keyof typeof CHARACTERS,
        tier: character.tier,
        row: character.position.row,
        col: character.position.col,
        maxActive: CHARACTERS[character.definitionId as keyof typeof CHARACTERS].squadCaps[character.tier],
        weapons,
        equipmentCost,
        activeCombos: getActiveEquipmentCombos(character.tier, weapons).map(({ id }) => id),
      };
    });
}

export function createSpawnLoadoutSnapshot(blueprint: SpawnerBlueprint): SpawnLoadoutSnapshot {
  return { characterId: blueprint.characterId, characterTier: blueprint.tier, weapons: blueprint.weapons.map((weapon) => ({ ...weapon })) };
}

export function moveGridItem(items: readonly GridItem[], itemId: string, targetPosition: GridPosition, unlockedColumns = PLAYER_DEPLOY_COLUMNS): GridMoveResult {
  const moving = items.find((item) => item.id === itemId);
  if (!moving) return { items: cloneGridItems(items), moved: false, reason: "item-not-found" };
  if (!isUsableGridPosition(targetPosition, unlockedColumns)) return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
  const targetIds = new Set(getOccupiedCells(moving, targetPosition).map((cell) => getGridItemAt(items.filter((item) => item.id !== itemId), cell)?.id).filter(Boolean) as string[]);
  if (targetIds.size === 0) {
    if (!canPlaceItem(items, moving, targetPosition, normalizeRotation(moving.rotation), [moving.id], unlockedColumns)) return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
    return { items: items.map((item) => item.id === itemId ? { ...cloneGridItem(item), position: { ...targetPosition } } : cloneGridItem(item)), moved: true };
  }
  if (targetIds.size !== 1 || !moving.position) return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
  const targetId = [...targetIds][0] as string;
  const target = items.find((item) => item.id === targetId)!;
  const ignored = [moving.id, target.id];
  if (!canPlaceItem(items, moving, targetPosition, normalizeRotation(moving.rotation), ignored, unlockedColumns)
    || !canPlaceItem(items, target, moving.position, normalizeRotation(target.rotation), ignored, unlockedColumns)) {
    return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
  }
  return {
    items: items.map((item) => item.id === moving.id
      ? { ...cloneGridItem(item), position: { ...targetPosition } }
      : item.id === target.id ? { ...cloneGridItem(item), position: { ...moving.position! } } : cloneGridItem(item)),
    moved: true,
    swappedWith: target.id,
  };
}

export const swapOrMoveGridItem = moveGridItem;

export function rotateGridItem(items: readonly GridItem[], itemId: string): GridMoveResult {
  const item = items.find((entry) => entry.id === itemId);
  if (!item || !item.position) return { items: cloneGridItems(items), moved: false, reason: "item-not-found" };
  if (!isWeaponId(item.definitionId)) return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
  const rotation = normalizeRotation(normalizeRotation(item.rotation) + 90);
  if (!canPlaceItem(items, item, item.position, rotation)) return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
  return { items: items.map((entry) => entry.id === itemId ? { ...cloneGridItem(entry), rotation } : cloneGridItem(entry)), moved: true };
}

export function movePendingRewardToGrid(state: InventoryState, rewardId: string, targetPosition: GridPosition): InventoryActionResult {
  const rewardIndex = state.pendingRewards.findIndex((reward) => reward.id === rewardId);
  if (rewardIndex < 0) return failedState(state, "item-not-found");
  const reward = state.pendingRewards[rewardIndex]!;
  const placed: GridItem = { ...reward, position: targetPosition, rotation: normalizeRotation(reward.rotation) };
  if (!canPlaceItem(state.gridItems, placed, targetPosition, normalizeRotation(placed.rotation), [], state.unlockedColumns)) return failedState(state, "invalid-position");
  return {
    gridItems: [...cloneGridItems(state.gridItems), placed],
    pendingRewards: state.pendingRewards.filter((entry) => entry.id !== rewardId).map((entry) => ({ ...entry })),
    success: true,
    action: "moved",
  };
}

export function moveGridItemToPending(state: InventoryState, itemId: string, queueIndex = state.pendingRewards.length): InventoryActionResult {
  const item = state.gridItems.find((entry) => entry.id === itemId);
  if (!item) return failedState(state, "item-not-found");
  const pendingRewards = state.pendingRewards.map((reward) => ({ ...reward }));
  pendingRewards.splice(Math.max(0, Math.min(Math.trunc(queueIndex), pendingRewards.length)), 0, {
    id: item.id, definitionId: item.definitionId, tier: item.tier, sourceLevel: item.sourceLevel, rotation: item.rotation,
  });
  return { gridItems: state.gridItems.filter((entry) => entry.id !== itemId).map(cloneGridItem), pendingRewards, success: true, action: "queued" };
}

export function reorderPendingReward(state: InventoryState, rewardId: string, targetIndex: number): InventoryActionResult {
  const sourceIndex = state.pendingRewards.findIndex((reward) => reward.id === rewardId);
  if (sourceIndex < 0) return failedState(state, "item-not-found");
  const pendingRewards = state.pendingRewards.map((reward) => ({ ...reward }));
  const [reward] = pendingRewards.splice(sourceIndex, 1);
  pendingRewards.splice(Math.max(0, Math.min(Math.trunc(targetIndex), pendingRewards.length)), 0, reward!);
  return { gridItems: cloneGridItems(state.gridItems), pendingRewards, success: true, action: "reordered" };
}

export function mergeInventoryItems(state: InventoryState, sourceId: string, targetId: string): InventoryActionResult {
  const source = findLocatedItem(state, sourceId);
  const target = findLocatedItem(state, targetId);
  if (!source || !target) return failedState(state, !source ? "item-not-found" : "target-not-found");
  if (source.id === target.id) return failedState(state, "same-item");
  if (source.definitionId !== target.definitionId) return failedState(state, "different-item");
  if (source.tier !== target.tier) return failedState(state, "different-tier");
  if (target.tier === 5) return failedState(state, "max-tier");
  const nextTier = (target.tier + 1) as Tier;
  return {
    gridItems: state.gridItems.filter((item) => item.id !== source.id).map((item) => item.id === target.id ? { ...cloneGridItem(item), tier: nextTier } : cloneGridItem(item)),
    pendingRewards: state.pendingRewards.filter((item) => item.id !== source.id).map((item) => item.id === target.id ? { ...item, tier: nextTier } : { ...item }),
    success: true,
    action: "merged",
  };
}

export const mergeCharacters = mergeInventoryItems;

export function getMergeReadyItemIds(items: readonly GridItem[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    if (item.tier >= 5) continue;
    const key = `${item.definitionId}:${item.tier}`;
    groups.set(key, [...(groups.get(key) ?? []), item.id]);
  }
  return new Set([...groups.values()].filter((ids) => ids.length >= 2).flat());
}

export function dropItemOnGrid(state: InventoryState, sourceId: string, targetPosition: GridPosition): InventoryActionResult {
  const source = findLocatedItem(state, sourceId);
  if (!source) return failedState(state, "item-not-found");
  const target = getGridItemAt(state.gridItems, targetPosition);
  if (target && source.id !== target.id && source.definitionId === target.definitionId && source.tier === target.tier) {
    return mergeInventoryItems(state, source.id, target.id);
  }
  if (source.storage === "queue") return movePendingRewardToGrid(state, source.id, targetPosition);
  const result = moveGridItem(state.gridItems, source.id, targetPosition, state.unlockedColumns);
  return {
    gridItems: result.items,
    pendingRewards: state.pendingRewards.map((reward) => ({ ...reward })),
    success: result.moved,
    action: result.moved ? (result.swappedWith ? "swapped" : "moved") : "none",
    swappedWith: result.swappedWith,
    reason: result.reason,
  };
}

/**
 * Pointer drops keep the grabbed cell aligned for normal movement, but a
 * matching item under the pointer always wins as the merge target. This keeps
 * multi-cell items mergeable even when they are grabbed away from the anchor.
 */
export function dropItemOnGridAtPointer(
  state: InventoryState,
  sourceId: string,
  pointerPosition: GridPosition,
  alignedPosition: GridPosition,
): InventoryActionResult {
  const source = findLocatedItem(state, sourceId);
  const target = getGridItemAt(state.gridItems, pointerPosition);
  if (source && target && source.id !== target.id && source.definitionId === target.definitionId && source.tier === target.tier) {
    return mergeInventoryItems(state, source.id, target.id);
  }
  return dropItemOnGrid(state, sourceId, alignedPosition);
}

export function cloneInventoryState(state: InventoryState): InventoryState {
  return { gridItems: cloneGridItems(state.gridItems), pendingRewards: state.pendingRewards.map((reward) => ({ ...reward })), unlockedColumns: state.unlockedColumns };
}

function cloneGridItem(item: GridItem): GridItem {
  return { ...item, rotation: normalizeRotation(item.rotation), position: item.position ? { ...item.position } : null };
}
function cloneGridItems(items: readonly GridItem[]): GridItem[] { return items.map(cloneGridItem); }
function failedState(state: InventoryState, reason: InventoryFailureReason): InventoryActionResult {
  return { ...cloneInventoryState(state), success: false, reason, action: "none" };
}
function findLocatedItem(state: InventoryState, id: string): LocatedInventoryItem | undefined {
  const gridIndex = state.gridItems.findIndex((item) => item.id === id);
  if (gridIndex >= 0) {
    const item = state.gridItems[gridIndex]!;
    return { storage: "grid", index: gridIndex, id: item.id, definitionId: item.definitionId, tier: item.tier, position: item.position ? { ...item.position } : null };
  }
  const queueIndex = state.pendingRewards.findIndex((item) => item.id === id);
  if (queueIndex >= 0) {
    const item = state.pendingRewards[queueIndex]!;
    return { storage: "queue", index: queueIndex, id: item.id, definitionId: item.definitionId, tier: item.tier, position: null };
  }
  return undefined;
}
export function isKnownItemId(value: string): value is ItemId { return value in ITEM_DEFINITIONS; }
