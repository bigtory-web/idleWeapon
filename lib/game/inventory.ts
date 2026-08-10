import { CHARACTERS, ITEM_DEFINITIONS, WEAPONS, isCharacterId, isWeaponId } from "./data";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  type Direction,
  type EquippedWeaponSnapshot,
  type GridItem,
  type GridPosition,
  type ItemId,
  type PendingReward,
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

export interface AdjacentWeaponConnection {
  item: GridItem;
  direction: Direction;
}

export interface InventoryState {
  gridItems: GridItem[];
  pendingRewards: PendingReward[];
}

export type InventoryFailureReason =
  | "item-not-found"
  | "target-not-found"
  | "invalid-position"
  | "same-item"
  | "not-characters"
  | "different-character"
  | "different-tier"
  | "max-tier";

export interface InventoryActionResult extends InventoryState {
  success: boolean;
  reason?: InventoryFailureReason;
  action: "none" | "moved" | "swapped" | "merged" | "queued" | "reordered";
  swappedWith?: string;
}

export interface GridMoveResult {
  items: GridItem[];
  moved: boolean;
  swappedWith?: string;
  reason?: "item-not-found" | "invalid-position";
}

export interface PlaceRewardResult {
  gridItems: GridItem[];
  success: boolean;
  position?: GridPosition;
  reason?: "grid-full";
}

export interface MergeRecord {
  kind: "weapon" | "character";
  definitionId: ItemId;
  fromTier: 1 | 2;
  toTier: 2 | 3;
  survivorId: string;
  consumedId: string;
  location: "grid" | "queue";
  position: GridPosition | null;
}

export interface AutoMergeResult extends InventoryState {
  merges: MergeRecord[];
}

interface LocatedInventoryItem {
  storage: "grid" | "queue";
  index: number;
  id: string;
  definitionId: ItemId;
  tier: Tier;
  position: GridPosition | null;
}

export function isValidGridPosition(position: GridPosition): boolean {
  return (
    Number.isInteger(position.row) &&
    Number.isInteger(position.col) &&
    position.row >= 0 &&
    position.row < GRID_ROWS &&
    position.col >= 0 &&
    position.col < GRID_COLUMNS
  );
}

export function positionsEqual(
  left: GridPosition | null,
  right: GridPosition | null,
): boolean {
  return left !== null && right !== null && left.row === right.row && left.col === right.col;
}

export function compareGridPositions(
  left: GridPosition | null,
  right: GridPosition | null,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left.row - right.row || left.col - right.col;
}

export function getGridItemAt(
  items: readonly GridItem[],
  position: GridPosition,
): GridItem | undefined {
  return items.find((item) => positionsEqual(item.position, position));
}

/** Places a newly selected reward in the first open cell, scanning row-major. */
export function placeRewardInFirstEmptyCell(
  gridItems: readonly GridItem[],
  reward: PendingReward,
): PlaceRewardResult {
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLUMNS; col += 1) {
      const position: GridPosition = { row, col };
      if (getGridItemAt(gridItems, position)) continue;

      return {
        gridItems: [
          ...cloneGridItems(gridItems),
          { ...reward, position: { ...position } },
        ],
        success: true,
        position,
      };
    }
  }

  return {
    gridItems: cloneGridItems(gridItems),
    success: false,
    reason: "grid-full",
  };
}

export function getAdjacentWeaponConnections(
  character: GridItem,
  allItems: readonly GridItem[],
): AdjacentWeaponConnection[] {
  if (!character.position || !isCharacterId(character.definitionId)) return [];

  return ADJACENT_DIRECTIONS.flatMap(({ direction, rowOffset, colOffset }) => {
    const targetPosition = {
      row: character.position!.row + rowOffset,
      col: character.position!.col + colOffset,
    };
    const item = getGridItemAt(allItems, targetPosition);

    return item && isWeaponId(item.definitionId) ? [{ item, direction }] : [];
  });
}

export function getAdjacentWeapons(
  character: GridItem,
  allItems: readonly GridItem[],
): GridItem[] {
  return getAdjacentWeaponConnections(character, allItems).map(({ item }) => item);
}

export function getCharactersSharingWeapon(
  weapon: GridItem,
  allItems: readonly GridItem[],
): GridItem[] {
  if (!weapon.position || !isWeaponId(weapon.definitionId)) return [];

  return allItems
    .filter((item) => {
      if (!item.position || !isCharacterId(item.definitionId)) return false;
      const rowDistance = Math.abs(item.position.row - weapon.position!.row);
      const colDistance = Math.abs(item.position.col - weapon.position!.col);
      return rowDistance + colDistance === 1;
    })
    .sort((left, right) => compareGridPositions(left.position, right.position));
}

export function deriveSpawnerBlueprints(items: readonly GridItem[]): SpawnerBlueprint[] {
  return items
    .filter(
      (item): item is GridItem & { position: GridPosition } =>
        item.position !== null && isCharacterId(item.definitionId),
    )
    .sort((left, right) => compareGridPositions(left.position, right.position))
    .map((character) => ({
      id: character.id,
      characterId: character.definitionId as keyof typeof CHARACTERS,
      tier: character.tier,
      row: character.position.row,
      col: character.position.col,
      weapons: getAdjacentWeaponConnections(character, items).map(
        ({ item, direction }): EquippedWeaponSnapshot => ({
          sourceItemId: item.id,
          weaponId: item.definitionId as WeaponId,
          tier: item.tier,
          direction,
        }),
      ),
    }));
}

export function createSpawnLoadoutSnapshot(
  blueprint: SpawnerBlueprint,
): SpawnLoadoutSnapshot {
  return {
    characterId: blueprint.characterId,
    characterTier: blueprint.tier,
    weapons: blueprint.weapons.map((weapon) => ({ ...weapon })),
  };
}

export function moveGridItem(
  items: readonly GridItem[],
  itemId: string,
  targetPosition: GridPosition,
): GridMoveResult {
  if (!isValidGridPosition(targetPosition)) {
    return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
  }

  const movingItem = items.find((item) => item.id === itemId);
  if (!movingItem) {
    return { items: cloneGridItems(items), moved: false, reason: "item-not-found" };
  }

  const occupant = getGridItemAt(items, targetPosition);
  const originalPosition = movingItem.position ? { ...movingItem.position } : null;

  if (occupant?.id === movingItem.id) {
    return { items: cloneGridItems(items), moved: true };
  }

  const nextItems = items.map((item) => {
    if (item.id === movingItem.id) {
      return { ...item, position: { ...targetPosition } };
    }
    if (occupant && item.id === occupant.id) {
      return { ...item, position: originalPosition };
    }
    return cloneGridItem(item);
  });

  return {
    items: nextItems,
    moved: true,
    swappedWith: occupant?.id,
  };
}

export const swapOrMoveGridItem = moveGridItem;

export function movePendingRewardToGrid(
  state: InventoryState,
  rewardId: string,
  targetPosition: GridPosition,
): InventoryActionResult {
  if (!isValidGridPosition(targetPosition)) {
    return failedState(state, "invalid-position");
  }

  const rewardIndex = state.pendingRewards.findIndex((reward) => reward.id === rewardId);
  if (rewardIndex < 0) return failedState(state, "item-not-found");

  const reward = state.pendingRewards[rewardIndex] as PendingReward;
  const occupant = getGridItemAt(state.gridItems, targetPosition);
  const placedItem: GridItem = {
    ...reward,
    position: { ...targetPosition },
  };

  const gridItems = occupant
    ? state.gridItems.map((item) =>
        item.id === occupant.id ? placedItem : cloneGridItem(item),
      )
    : [...cloneGridItems(state.gridItems), placedItem];

  const pendingRewards = state.pendingRewards.map((item) => ({ ...item }));
  if (occupant) {
    pendingRewards[rewardIndex] = {
      id: occupant.id,
      definitionId: occupant.definitionId,
      tier: occupant.tier,
      sourceLevel: occupant.sourceLevel,
    };
  } else {
    pendingRewards.splice(rewardIndex, 1);
  }

  return {
    gridItems,
    pendingRewards,
    success: true,
    action: occupant ? "swapped" : "moved",
    swappedWith: occupant?.id,
  };
}

export function moveGridItemToPending(
  state: InventoryState,
  itemId: string,
  queueIndex: number = state.pendingRewards.length,
): InventoryActionResult {
  const itemIndex = state.gridItems.findIndex((item) => item.id === itemId);
  if (itemIndex < 0) return failedState(state, "item-not-found");

  const item = state.gridItems[itemIndex] as GridItem;
  const insertionIndex = Math.max(0, Math.min(Math.trunc(queueIndex), state.pendingRewards.length));
  const pendingRewards = state.pendingRewards.map((reward) => ({ ...reward }));
  pendingRewards.splice(insertionIndex, 0, {
    id: item.id,
    definitionId: item.definitionId,
    tier: item.tier,
    sourceLevel: item.sourceLevel,
  });

  return {
    gridItems: state.gridItems.filter((entry) => entry.id !== itemId).map(cloneGridItem),
    pendingRewards,
    success: true,
    action: "queued",
  };
}

export function reorderPendingReward(
  state: InventoryState,
  rewardId: string,
  targetIndex: number,
): InventoryActionResult {
  const sourceIndex = state.pendingRewards.findIndex((reward) => reward.id === rewardId);
  if (sourceIndex < 0) return failedState(state, "item-not-found");

  const pendingRewards = state.pendingRewards.map((reward) => ({ ...reward }));
  const [reward] = pendingRewards.splice(sourceIndex, 1);
  const insertionIndex = Math.max(0, Math.min(Math.trunc(targetIndex), pendingRewards.length));
  pendingRewards.splice(insertionIndex, 0, reward as PendingReward);

  return {
    gridItems: cloneGridItems(state.gridItems),
    pendingRewards,
    success: true,
    action: "reordered",
  };
}

export function mergeCharacters(
  state: InventoryState,
  sourceId: string,
  targetId: string,
): InventoryActionResult {
  if (sourceId === targetId) return failedState(state, "same-item");

  const source = findLocatedItem(state, sourceId);
  const target = findLocatedItem(state, targetId);
  if (!source) return failedState(state, "item-not-found");
  if (!target) return failedState(state, "target-not-found");
  if (!isCharacterId(source.definitionId) || !isCharacterId(target.definitionId)) {
    return failedState(state, "not-characters");
  }
  if (source.definitionId !== target.definitionId) {
    return failedState(state, "different-character");
  }
  if (source.tier !== target.tier) return failedState(state, "different-tier");
  if (target.tier === 3) return failedState(state, "max-tier");

  const nextTier = (target.tier + 1) as 2 | 3;
  const gridItems = state.gridItems
    .filter((item) => item.id !== source.id)
    .map((item) =>
      item.id === target.id ? { ...item, tier: nextTier } : cloneGridItem(item),
    );
  const pendingRewards = state.pendingRewards
    .filter((item) => item.id !== source.id)
    .map((item) =>
      item.id === target.id ? { ...item, tier: nextTier } : { ...item },
    );

  return {
    gridItems,
    pendingRewards,
    success: true,
    action: "merged",
  };
}

/**
 * Applies preparation-time weapon merging without mutating either collection.
 * Grid entries sort before queue entries; grid ties use row-major order and
 * queue ties preserve queue order. The first member of each pair survives.
 */
export function autoMergeWeapons(
  gridItemsInput: readonly GridItem[],
  pendingRewardsInput: readonly PendingReward[],
): AutoMergeResult {
  const gridItems = cloneGridItems(gridItemsInput);
  const pendingRewards = pendingRewardsInput.map((reward) => ({ ...reward }));
  const merges: MergeRecord[] = [];

  for (const weaponId of Object.keys(WEAPONS) as WeaponId[]) {
    for (const tier of [1, 2] as const) {
      let candidates = collectMergeCandidates(gridItems, pendingRewards, weaponId, tier);

      while (candidates.length >= 2) {
        const survivor = candidates[0] as LocatedInventoryItem;
        const consumed = candidates[1] as LocatedInventoryItem;
        const nextTier = (tier + 1) as 2 | 3;

        updateLocatedTier(gridItems, pendingRewards, survivor, nextTier);
        removeLocatedItem(gridItems, pendingRewards, consumed);
        merges.push({
          kind: "weapon",
          definitionId: weaponId,
          fromTier: tier,
          toTier: nextTier,
          survivorId: survivor.id,
          consumedId: consumed.id,
          location: survivor.storage,
          position: survivor.position ? { ...survivor.position } : null,
        });

        candidates = collectMergeCandidates(gridItems, pendingRewards, weaponId, tier);
      }
    }
  }

  return { gridItems, pendingRewards, merges };
}

export const mergeWeaponsForPreparation = autoMergeWeapons;

/**
 * Convenience operation for pointer/keyboard drops. A matching character drop
 * merges; every other occupied grid drop swaps.
 */
export function dropItemOnGrid(
  state: InventoryState,
  sourceId: string,
  targetPosition: GridPosition,
): InventoryActionResult {
  if (!isValidGridPosition(targetPosition)) return failedState(state, "invalid-position");

  const source = findLocatedItem(state, sourceId);
  if (!source) return failedState(state, "item-not-found");
  const target = getGridItemAt(state.gridItems, targetPosition);

  if (
    target &&
    source.id !== target.id &&
    isCharacterId(source.definitionId) &&
    source.definitionId === target.definitionId &&
    source.tier === target.tier
  ) {
    return mergeCharacters(state, source.id, target.id);
  }

  if (source.storage === "queue") {
    return movePendingRewardToGrid(state, source.id, targetPosition);
  }

  const result = moveGridItem(state.gridItems, source.id, targetPosition);
  return {
    gridItems: result.items,
    pendingRewards: state.pendingRewards.map((reward) => ({ ...reward })),
    success: result.moved,
    action: result.moved ? (result.swappedWith ? "swapped" : "moved") : "none",
    swappedWith: result.swappedWith,
    reason: result.reason,
  };
}

export function cloneInventoryState(state: InventoryState): InventoryState {
  return {
    gridItems: cloneGridItems(state.gridItems),
    pendingRewards: state.pendingRewards.map((reward) => ({ ...reward })),
  };
}

function cloneGridItem(item: GridItem): GridItem {
  return {
    ...item,
    position: item.position ? { ...item.position } : null,
  };
}

function cloneGridItems(items: readonly GridItem[]): GridItem[] {
  return items.map(cloneGridItem);
}

function failedState(
  state: InventoryState,
  reason: InventoryFailureReason,
): InventoryActionResult {
  return {
    ...cloneInventoryState(state),
    success: false,
    reason,
    action: "none",
  };
}

function findLocatedItem(
  state: InventoryState,
  id: string,
): LocatedInventoryItem | undefined {
  const gridIndex = state.gridItems.findIndex((item) => item.id === id);
  if (gridIndex >= 0) {
    const item = state.gridItems[gridIndex] as GridItem;
    return {
      storage: "grid",
      index: gridIndex,
      id: item.id,
      definitionId: item.definitionId,
      tier: item.tier,
      position: item.position ? { ...item.position } : null,
    };
  }

  const queueIndex = state.pendingRewards.findIndex((item) => item.id === id);
  if (queueIndex >= 0) {
    const item = state.pendingRewards[queueIndex] as PendingReward;
    return {
      storage: "queue",
      index: queueIndex,
      id: item.id,
      definitionId: item.definitionId,
      tier: item.tier,
      position: null,
    };
  }

  return undefined;
}

function collectMergeCandidates(
  gridItems: readonly GridItem[],
  pendingRewards: readonly PendingReward[],
  weaponId: WeaponId,
  tier: 1 | 2,
): LocatedInventoryItem[] {
  const gridCandidates: LocatedInventoryItem[] = gridItems.flatMap((item, index) =>
    item.definitionId === weaponId && item.tier === tier
      ? [
          {
            storage: "grid" as const,
            index,
            id: item.id,
            definitionId: item.definitionId,
            tier: item.tier,
            position: item.position ? { ...item.position } : null,
          },
        ]
      : [],
  );
  gridCandidates.sort(
    (left, right) => compareGridPositions(left.position, right.position) || left.index - right.index,
  );

  const queueCandidates: LocatedInventoryItem[] = pendingRewards.flatMap((item, index) =>
    item.definitionId === weaponId && item.tier === tier
      ? [
          {
            storage: "queue" as const,
            index,
            id: item.id,
            definitionId: item.definitionId,
            tier: item.tier,
            position: null,
          },
        ]
      : [],
  );

  return [...gridCandidates, ...queueCandidates];
}

function updateLocatedTier(
  gridItems: GridItem[],
  pendingRewards: PendingReward[],
  located: LocatedInventoryItem,
  tier: Tier,
): void {
  const collection = located.storage === "grid" ? gridItems : pendingRewards;
  const item = collection.find((entry) => entry.id === located.id);
  if (item) item.tier = tier;
}

function removeLocatedItem(
  gridItems: GridItem[],
  pendingRewards: PendingReward[],
  located: LocatedInventoryItem,
): void {
  const collection = located.storage === "grid" ? gridItems : pendingRewards;
  const index = collection.findIndex((entry) => entry.id === located.id);
  if (index >= 0) collection.splice(index, 1);
}

/** Runtime guard useful when loading a locally stored inventory. */
export function isKnownItemId(value: string): value is ItemId {
  return value in ITEM_DEFINITIONS;
}
