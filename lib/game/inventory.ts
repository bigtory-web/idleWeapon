import { CHARACTERS, ITEM_DEFINITIONS, WEAPONS, isCharacterId, isWeaponId } from "./data";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  type ConnectionSocket,
  type Direction,
  type EquipmentLink,
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
export interface InventoryState { gridItems: GridItem[]; pendingRewards: PendingReward[] }
export type InventoryFailureReason = "item-not-found" | "target-not-found" | "invalid-position" | "same-item" | "not-characters" | "different-character" | "different-tier" | "max-tier";
export interface InventoryActionResult extends InventoryState {
  success: boolean;
  reason?: InventoryFailureReason;
  action: "none" | "moved" | "swapped" | "merged" | "queued" | "reordered";
  swappedWith?: string;
}
export interface GridMoveResult { items: GridItem[]; moved: boolean; swappedWith?: string; reason?: "item-not-found" | "invalid-position" }
export interface PlaceRewardResult { gridItems: GridItem[]; success: boolean; position?: GridPosition; rotation?: Rotation; reason?: "grid-full" }
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
export interface AutoMergeResult extends InventoryState { merges: MergeRecord[] }
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
    && position.col >= 0 && position.col < GRID_COLUMNS;
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

function rotateDirection(direction: Direction, steps: number): Direction {
  const directions: Direction[] = ["up", "right", "down", "left"];
  return directions[(directions.indexOf(direction) + steps) % 4] as Direction;
}

function rotatePoint(cell: FootprintCell, steps: number): FootprintCell {
  let next = { ...cell };
  for (let index = 0; index < steps; index += 1) next = { row: next.col, col: -next.row };
  return next;
}

export function getRotatedItemGeometry(definitionId: ItemId, rotation: Rotation = 0): {
  cells: FootprintCell[];
  sockets: ConnectionSocket[];
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
  const sockets = (isCharacter ? [] : definition.sockets).map((socket) => {
    const cell = rotatePoint(socket.cell, steps);
    return {
      cell: { row: cell.row - minRow, col: cell.col - minCol },
      direction: rotateDirection(socket.direction, steps),
    };
  });
  return {
    cells,
    sockets,
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
): boolean {
  const cells = getOccupiedCells(item, position, rotation);
  return cells.length > 0
    && cells.every(isValidGridPosition)
    && cells.every((cell) => {
      const occupant = getGridItemAt(items, cell);
      return !occupant || ignoredIds.includes(occupant.id);
    });
}

export function findFirstPlacement(items: readonly GridItem[], definitionId: ItemId, preferredRotation?: Rotation): { position: GridPosition; rotation: Rotation } | null {
  const rotations = isCharacterId(definitionId)
    ? [0 as Rotation]
    : preferredRotation === undefined
      ? ROTATIONS
      : [normalizeRotation(preferredRotation), ...ROTATIONS.filter((value) => value !== normalizeRotation(preferredRotation))];
  const probe: GridItem = { id: "__placement-probe__", definitionId, tier: 1, position: null };
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLUMNS; col += 1) {
      for (const rotation of rotations) {
        const position = { row, col };
        if (canPlaceItem(items, probe, position, rotation, [])) return { position, rotation };
      }
    }
  }
  return null;
}

export function placeRewardInFirstEmptyCell(gridItems: readonly GridItem[], reward: PendingReward): PlaceRewardResult {
  const placement = findFirstPlacement(gridItems, reward.definitionId, reward.rotation);
  if (!placement) return { gridItems: cloneGridItems(gridItems), success: false, reason: "grid-full" };
  return {
    gridItems: [...cloneGridItems(gridItems), { ...reward, ...placement }],
    success: true,
    ...placement,
  };
}

function directionOffset(direction: Direction): { row: number; col: number } {
  const entry = ADJACENT_DIRECTIONS.find((candidate) => candidate.direction === direction)!;
  return { row: entry.rowOffset, col: entry.colOffset };
}

export function getWorldSockets(weapon: GridItem): Array<{ position: GridPosition; direction: Direction }> {
  if (!weapon.position || !isWeaponId(weapon.definitionId)) return [];
  return getRotatedItemGeometry(weapon.definitionId, normalizeRotation(weapon.rotation)).sockets.map((socket) => ({
    position: { row: weapon.position!.row + socket.cell.row, col: weapon.position!.col + socket.cell.col },
    direction: socket.direction,
  }));
}

export function getAdjacentWeaponConnections(character: GridItem, allItems: readonly GridItem[]): AdjacentWeaponConnection[] {
  if (!character.position || !isCharacterId(character.definitionId)) return [];
  const matches: AdjacentWeaponConnection[] = [];
  for (const weapon of allItems) {
    if (!weapon.position || !isWeaponId(weapon.definitionId)) continue;
    for (const socket of getWorldSockets(weapon)) {
      const offset = directionOffset(socket.direction);
      const target = { row: socket.position.row + offset.row, col: socket.position.col + offset.col };
      const relativeCell = getOccupiedCells(character).find((cell) => positionsEqual(target, cell));
      if (!relativeCell) continue;
      matches.push({
        item: weapon,
        direction: rotateDirection(socket.direction, 2),
        characterCell: { row: relativeCell.row - character.position.row, col: relativeCell.col - character.position.col },
      });
      break;
    }
  }
  return matches.sort((left, right) => compareGridPositions(left.item.position, right.item.position));
}

export function getAdjacentWeapons(character: GridItem, allItems: readonly GridItem[]): GridItem[] {
  return getAdjacentWeaponConnections(character, allItems).map(({ item }) => item);
}

function equipmentLinkKey(characterId: string, weaponId: string): string {
  return `${characterId}:${weaponId}`;
}

/**
 * Keeps only contacts that still physically exist and assigns an increasing order
 * to new contacts. That order survives ordinary placement changes until contact is
 * broken, which makes the limited weapon slots predictable to the player.
 */
export function reconcileEquipmentLinks(items: readonly GridItem[], previous: readonly EquipmentLink[]): EquipmentLink[] {
  const physical = items
    .filter((item) => item.position !== null && isCharacterId(item.definitionId))
    .flatMap((character) => getAdjacentWeaponConnections(character, items)
      .map(({ item: weapon }) => ({ characterId: character.id, weaponId: weapon.id })));
  const previousByKey = new Map(previous.map((link) => [equipmentLinkKey(link.characterId, link.weaponId), link]));
  let nextConnectedAt = previous.reduce((latest, link) => Math.max(latest, link.connectedAt), 0);
  return physical.map((link) => {
    const existing = previousByKey.get(equipmentLinkKey(link.characterId, link.weaponId));
    if (existing) return { ...existing };
    nextConnectedAt += 1;
    return { ...link, connectedAt: nextConnectedAt };
  });
}

/** Returns only the weapons that fit this character's current tier slot count. */
export function getActiveWeaponConnections(
  character: GridItem,
  allItems: readonly GridItem[],
  links: readonly EquipmentLink[] = [],
): AdjacentWeaponConnection[] {
  if (!character.position || !isCharacterId(character.definitionId)) return [];
  const linkOrder = new Map(links.map((link) => [equipmentLinkKey(link.characterId, link.weaponId), link.connectedAt]));
  const fallbackLinks = reconcileEquipmentLinks(allItems, links);
  const fallbackOrder = new Map(fallbackLinks.map((link) => [equipmentLinkKey(link.characterId, link.weaponId), link.connectedAt]));
  const slots = CHARACTERS[character.definitionId].weaponSlots[character.tier];
  return getAdjacentWeaponConnections(character, allItems)
    .sort((left, right) => (linkOrder.get(equipmentLinkKey(character.id, left.item.id))
      ?? fallbackOrder.get(equipmentLinkKey(character.id, left.item.id))
      ?? Number.MAX_SAFE_INTEGER)
      - (linkOrder.get(equipmentLinkKey(character.id, right.item.id))
        ?? fallbackOrder.get(equipmentLinkKey(character.id, right.item.id))
        ?? Number.MAX_SAFE_INTEGER)
      || compareGridPositions(left.item.position, right.item.position))
    .slice(0, slots);
}

export function getCharactersSharingWeapon(weapon: GridItem, allItems: readonly GridItem[], links: readonly EquipmentLink[] = []): GridItem[] {
  if (!weapon.position || !isWeaponId(weapon.definitionId)) return [];
  return allItems.filter((item) => isCharacterId(item.definitionId)
    && getActiveWeaponConnections(item, allItems, links).some(({ item: candidate }) => candidate.id === weapon.id))
    .sort((left, right) => compareGridPositions(left.position, right.position));
}

export function deriveSpawnerBlueprints(items: readonly GridItem[], links: readonly EquipmentLink[] = []): SpawnerBlueprint[] {
  return items.filter((item): item is GridItem & { position: GridPosition } => item.position !== null && isCharacterId(item.definitionId))
    .sort((left, right) => compareGridPositions(left.position, right.position))
    .map((character) => ({
      id: character.id,
      characterId: character.definitionId as keyof typeof CHARACTERS,
      tier: character.tier,
      row: character.position.row,
      col: character.position.col,
      maxActive: CHARACTERS[character.definitionId as keyof typeof CHARACTERS].squadCaps[character.tier],
      weapons: getActiveWeaponConnections(character, items, links).map(({ item, direction }): EquippedWeaponSnapshot => ({
        sourceItemId: item.id,
        weaponId: item.definitionId as WeaponId,
        tier: item.tier,
        direction,
      })),
    }));
}

export function createSpawnLoadoutSnapshot(blueprint: SpawnerBlueprint): SpawnLoadoutSnapshot {
  return { characterId: blueprint.characterId, characterTier: blueprint.tier, weapons: blueprint.weapons.map((weapon) => ({ ...weapon })) };
}

export function moveGridItem(items: readonly GridItem[], itemId: string, targetPosition: GridPosition): GridMoveResult {
  const moving = items.find((item) => item.id === itemId);
  if (!moving) return { items: cloneGridItems(items), moved: false, reason: "item-not-found" };
  if (!isValidGridPosition(targetPosition)) return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
  const targetIds = new Set(getOccupiedCells(moving, targetPosition).map((cell) => getGridItemAt(items.filter((item) => item.id !== itemId), cell)?.id).filter(Boolean) as string[]);
  if (targetIds.size === 0) {
    if (!canPlaceItem(items, moving, targetPosition)) return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
    return { items: items.map((item) => item.id === itemId ? { ...cloneGridItem(item), position: { ...targetPosition } } : cloneGridItem(item)), moved: true };
  }
  if (targetIds.size !== 1 || !moving.position) return { items: cloneGridItems(items), moved: false, reason: "invalid-position" };
  const targetId = [...targetIds][0] as string;
  const target = items.find((item) => item.id === targetId)!;
  const ignored = [moving.id, target.id];
  if (!canPlaceItem(items, moving, targetPosition, normalizeRotation(moving.rotation), ignored)
    || !canPlaceItem(items, target, moving.position, normalizeRotation(target.rotation), ignored)) {
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
  if (!canPlaceItem(state.gridItems, placed, targetPosition, normalizeRotation(placed.rotation), [])) return failedState(state, "invalid-position");
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

export function mergeCharacters(state: InventoryState, sourceId: string, targetId: string): InventoryActionResult {
  const source = findLocatedItem(state, sourceId);
  const target = findLocatedItem(state, targetId);
  if (!source || !target) return failedState(state, !source ? "item-not-found" : "target-not-found");
  if (source.id === target.id) return failedState(state, "same-item");
  if (!isCharacterId(source.definitionId) || !isCharacterId(target.definitionId)) return failedState(state, "not-characters");
  if (source.definitionId !== target.definitionId) return failedState(state, "different-character");
  if (source.tier !== target.tier) return failedState(state, "different-tier");
  if (target.tier === 3) return failedState(state, "max-tier");
  const nextTier = (target.tier + 1) as 2 | 3;
  return {
    gridItems: state.gridItems.filter((item) => item.id !== source.id).map((item) => item.id === target.id ? { ...cloneGridItem(item), tier: nextTier } : cloneGridItem(item)),
    pendingRewards: state.pendingRewards.filter((item) => item.id !== source.id).map((item) => item.id === target.id ? { ...item, tier: nextTier } : { ...item }),
    success: true,
    action: "merged",
  };
}

export function autoMergeInventory(gridItemsInput: readonly GridItem[], pendingRewardsInput: readonly PendingReward[]): AutoMergeResult {
  const gridItems = cloneGridItems(gridItemsInput);
  const pendingRewards = pendingRewardsInput.map((reward) => ({ ...reward }));
  const merges: MergeRecord[] = [];
  for (const definitionId of Object.keys(ITEM_DEFINITIONS) as ItemId[]) {
    for (const tier of [1, 2] as const) {
      let candidates = collectMergeCandidates(gridItems, pendingRewards, definitionId, tier);
      while (candidates.length >= 2) {
        const survivor = candidates[0]!;
        const consumed = candidates[1]!;
        const nextTier = (tier + 1) as 2 | 3;
        updateLocatedTier(gridItems, pendingRewards, survivor, nextTier);
        removeLocatedItem(gridItems, pendingRewards, consumed);
        merges.push({
          kind: isWeaponId(definitionId) ? "weapon" : "character",
          definitionId,
          fromTier: tier,
          toTier: nextTier,
          survivorId: survivor.id,
          consumedId: consumed.id,
          location: survivor.storage,
          position: survivor.position ? { ...survivor.position } : null,
        });
        candidates = collectMergeCandidates(gridItems, pendingRewards, definitionId, tier);
      }
    }
  }
  return { gridItems, pendingRewards, merges };
}

export function autoMergeWeapons(gridItemsInput: readonly GridItem[], pendingRewardsInput: readonly PendingReward[]): AutoMergeResult {
  const merged = autoMergeInventory(gridItemsInput, pendingRewardsInput);
  // Compatibility export: callers now receive all automatic merges by design.
  return merged;
}
export const mergeWeaponsForPreparation = autoMergeWeapons;

export function dropItemOnGrid(state: InventoryState, sourceId: string, targetPosition: GridPosition): InventoryActionResult {
  const source = findLocatedItem(state, sourceId);
  if (!source) return failedState(state, "item-not-found");
  const target = getGridItemAt(state.gridItems, targetPosition);
  if (target && source.id !== target.id && isCharacterId(source.definitionId)
    && source.definitionId === target.definitionId && source.tier === target.tier) return mergeCharacters(state, source.id, target.id);
  if (source.storage === "queue") return movePendingRewardToGrid(state, source.id, targetPosition);
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
  return { gridItems: cloneGridItems(state.gridItems), pendingRewards: state.pendingRewards.map((reward) => ({ ...reward })) };
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
function collectMergeCandidates(gridItems: readonly GridItem[], pendingRewards: readonly PendingReward[], definitionId: ItemId, tier: 1 | 2): LocatedInventoryItem[] {
  const grid = gridItems.flatMap((item, index) => item.definitionId === definitionId && item.tier === tier
    ? [{ storage: "grid" as const, index, id: item.id, definitionId: item.definitionId, tier: item.tier, position: item.position ? { ...item.position } : null }]
    : []);
  grid.sort((left, right) => compareGridPositions(left.position, right.position) || left.index - right.index);
  const queue = pendingRewards.flatMap((item, index) => item.definitionId === definitionId && item.tier === tier
    ? [{ storage: "queue" as const, index, id: item.id, definitionId: item.definitionId, tier: item.tier, position: null }]
    : []);
  return [...grid, ...queue];
}
function updateLocatedTier(gridItems: GridItem[], pendingRewards: PendingReward[], located: LocatedInventoryItem, tier: Tier): void {
  const item = (located.storage === "grid" ? gridItems : pendingRewards).find((entry) => entry.id === located.id);
  if (item) item.tier = tier;
}
function removeLocatedItem(gridItems: GridItem[], pendingRewards: PendingReward[], located: LocatedInventoryItem): void {
  const collection = located.storage === "grid" ? gridItems : pendingRewards;
  const index = collection.findIndex((entry) => entry.id === located.id);
  if (index >= 0) collection.splice(index, 1);
}
export function isKnownItemId(value: string): value is ItemId { return value in ITEM_DEFINITIONS; }
