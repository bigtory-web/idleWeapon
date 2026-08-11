import assert from "node:assert/strict";
import test from "node:test";

import {
  CHARACTERS,
  CHARACTER_HP_AND_POWER_MULTIPLIER,
  CHARACTER_SPAWN_COOLDOWN_MULTIPLIER,
  ENEMY_DAMAGE_MULTIPLIER,
  ENEMY_HP_MULTIPLIER,
  ENEMIES,
  STARTING_INVENTORY,
  WAVE_DEFINITIONS,
  WEAPONS,
  WEAPON_DAMAGE_MULTIPLIER,
  getWaveEnemyTotal,
} from "../lib/game/data";
import { CombatEngine } from "../lib/game/engine";
import {
  autoMergeInventory,
  canPlaceItem,
  deriveSpawnerBlueprints,
  dropItemOnGrid,
  findFirstPlacement,
  getActiveWeaponConnections,
  getAdjacentWeaponConnections,
  getCharactersSharingWeapon,
  getOccupiedCells,
  getRotatedItemGeometry,
  moveGridItem,
  placeRewardInFirstEmptyCell,
  rotateGridItem,
} from "../lib/game/inventory";
import { createSeededRng, normalizeSeed } from "../lib/game/rng";
import { generateShopOffers, purchaseShopOffer } from "../lib/game/shop";
import type { CombatEvent, GridItem, ItemId, PendingReward, Rotation, ShopOffer, Tier } from "../lib/game/types";

function item(id: string, definitionId: ItemId, row: number, col: number, tier: Tier = 1, rotation: Rotation = 0): GridItem {
  return { id, definitionId, tier, position: { row, col }, rotation };
}

function reward(id: string, definitionId: ItemId, tier: Tier = 1): PendingReward {
  return { id, definitionId, tier };
}

function stepFor(engine: CombatEngine, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.25) engine.step(Math.min(0.25, seconds - elapsed));
}

test("data keeps combat stats while characters use one cell and enemies keep their tuning", () => {
  assert.deepEqual([CHARACTERS.shieldbearer.hp, CHARACTERS.shieldbearer.moveSpeed, CHARACTERS.shieldbearer.spawnCooldown], [180, 34, 6]);
  assert.deepEqual([CHARACTERS.scout.hp, CHARACTERS.scout.moveSpeed, CHARACTERS.scout.spawnCooldown], [80, 52, 3.8]);
  assert.deepEqual([CHARACTERS.sharpshooter.hp, CHARACTERS.sharpshooter.moveSpeed, CHARACTERS.sharpshooter.spawnCooldown], [90, 38, 5.2]);
  assert.deepEqual(CHARACTER_HP_AND_POWER_MULTIPLIER, { 1: 1, 2: 1.6, 3: 2.4 });
  assert.deepEqual(CHARACTER_SPAWN_COOLDOWN_MULTIPLIER, { 1: 1, 2: 0.9, 3: 0.8 });
  assert.deepEqual(CHARACTERS.shieldbearer.squadCaps, { 1: 2, 2: 3, 3: 5 });
  assert.deepEqual(CHARACTERS.shieldbearer.footprint, [{ row: 0, col: 0 }]);
  assert.deepEqual(CHARACTERS.scout.footprint, [{ row: 0, col: 0 }]);
  assert.deepEqual(CHARACTERS.sharpshooter.footprint, [{ row: 0, col: 0 }]);
  assert.deepEqual(CHARACTERS.scout.squadCaps, { 1: 4, 2: 6, 3: 9 });
  assert.deepEqual(CHARACTERS.sharpshooter.squadCaps, { 1: 2, 2: 3, 3: 5 });
  assert.deepEqual(Object.values(WEAPONS).map(({ footprint }) => footprint.length), [2, 3, 3, 2]);
  assert.deepEqual(Object.values(WEAPONS).map(({ damage, cooldown, range }) => [damage, cooldown, range]), [
    [13, 0.7, 28], [10, 0.9, 180], [24, 1.4, 32], [8, 1, 150],
  ]);
  assert.deepEqual(WEAPON_DAMAGE_MULTIPLIER, { 1: 1, 2: 1.7, 3: 2.7 });
  assert.equal(WEAPONS.sword.equipPenalty?.moveSpeedMultiplier, 0.94);
  assert.equal(WEAPONS.bow.equipPenalty?.hpMultiplier, 0.9);
  assert.deepEqual(WAVE_DEFINITIONS.map(getWaveEnemyTotal), [18, 30, 26, 32, 48, 31]);
  assert.deepEqual(WAVE_DEFINITIONS.map(({ timeLimit }) => timeLimit), [60, 60, 90, 90, 90, 120]);
  assert.equal(ENEMY_HP_MULTIPLIER, 1.35);
  assert.equal(ENEMY_DAMAGE_MULTIPLIER, 1.25);
  assert.deepEqual(Object.values(ENEMIES).map(({ hp, damage }) => [hp, damage]), [
    [61, 9], [41, 6], [149, 15], [74, 10], [1215, 28],
  ]);
});

test("footprints rotate into normalized bounds and reject edges or overlap", () => {
  assert.deepEqual(getRotatedItemGeometry("shieldbearer", 90).cells, [{ row: 0, col: 0 }]);
  assert.deepEqual(getRotatedItemGeometry("sharpshooter", 90).cells, [{ row: 0, col: 0 }]);
  assert.deepEqual(getRotatedItemGeometry("bow", 0).cells, [
    { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 },
  ]);
  assert.deepEqual(getRotatedItemGeometry("bow", 90).cells, [
    { row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 },
  ]);
  assert.deepEqual(getRotatedItemGeometry("hammer", 180).cells, [
    { row: 1, col: 1 }, { row: 0, col: 1 }, { row: 0, col: 0 },
  ]);
  const sword = item("sword", "sword", 0, 0);
  assert.deepEqual(getOccupiedCells(sword), [{ row: 0, col: 0 }, { row: 0, col: 1 }]);
  assert.equal(canPlaceItem([], sword, { row: 0, col: 5 }), false);
  assert.equal(canPlaceItem([item("block", "scout", 0, 1)], sword, { row: 0, col: 0 }), false);
});

test("rotation keeps the anchor and reverts when the rotated footprint does not fit", () => {
  const bow = item("bow", "bow", 0, 0);
  const rotated = rotateGridItem([bow], bow.id);
  assert.equal(rotated.moved, true);
  assert.equal(rotated.items[0]?.rotation, 90);
  const edgeBow = item("edge", "bow", 2, 4);
  const rejected = rotateGridItem([edgeBow], edgeBow.id);
  assert.equal(rejected.moved, false);
  assert.equal(rejected.items[0]?.rotation, 0);
});

test("sockets, not touching perimeter, determine loadouts and sharing", () => {
  const sword = item("sword", "sword", 1, 1);
  const left = item("left", "shieldbearer", 1, 0);
  const right = item("right", "scout", 1, 3);
  const touchingNoSocket = item("below", "sharpshooter", 2, 1);
  const chained = item("wand", "wand", 1, 3);
  const items = [sword, left, right, touchingNoSocket, chained];
  assert.deepEqual(getCharactersSharingWeapon(sword, items).map(({ id }) => id), ["left", "right"]);
  assert.deepEqual(getAdjacentWeaponConnections(touchingNoSocket, items), []);
  assert.deepEqual(getAdjacentWeaponConnections(left, items).map(({ item: weapon, direction }) => [weapon.id, direction]), [["sword", "right"]]);
  const shield = item("shield", "shieldbearer", 1, 0);
  const socketedSword = item("socketed-sword", "sword", 1, 1);
  assert.deepEqual(getAdjacentWeaponConnections(shield, [shield, socketedSword]).map(({ item: weapon, characterCell }) => [weapon.id, characterCell]), [["socketed-sword", { row: 0, col: 0 }]]);
});

test("starting inventory keeps both character-to-weapon contacts", () => {
  const blueprints = deriveSpawnerBlueprints(STARTING_INVENTORY);
  const shieldbearer = blueprints.find(({ characterId }) => characterId === "shieldbearer")!;
  const scout = blueprints.find(({ characterId }) => characterId === "scout")!;
  assert.equal(shieldbearer.maxActive, 2);
  assert.equal(scout.maxActive, 4);
  assert.deepEqual(shieldbearer.weapons, [
    { weaponId: "sword", tier: 1, direction: "right", sourceItemId: "start-sword" },
  ]);
  assert.deepEqual(scout.weapons, [
    { weaponId: "bow", tier: 1, direction: "right", sourceItemId: "start-bow" },
    { weaponId: "sword", tier: 1, direction: "left", sourceItemId: "start-sword" },
  ]);
});

test("tier-one characters equip every physical socket contact", () => {
  const character = item("center", "scout", 1, 2, 1);
  const items = [
    item("bow", "bow", 0, 1),
    item("sword", "sword", 1, 0),
    character,
    item("wand", "wand", 1, 3),
    item("hammer", "hammer", 2, 2),
  ];
  assert.deepEqual(getActiveWeaponConnections(character, items).map(({ item: weapon }) => weapon.id), ["bow", "sword", "wand", "hammer"]);
  assert.deepEqual(deriveSpawnerBlueprints(items)[0]?.weapons.map(({ sourceItemId }) => sourceItemId), ["bow", "sword", "wand", "hammer"]);
});

test("shop offers are deterministic and mix character and weapon items", () => {
  const first = generateShopOffers("prototype-001", 2);
  assert.deepEqual(first, generateShopOffers("prototype-001", 2));
  assert.equal(new Set(first.map(({ definitionId }) => definitionId)).size, 3);
  assert.equal(first.some(({ definitionId }) => definitionId in CHARACTERS), true);
  assert.equal(first.some(({ definitionId }) => definitionId in WEAPONS), true);
});

test("shop merges before footprint placement and supports a full backpack merge", () => {
  const offer: ShopOffer = { id: "shop-1-sword", waveIndex: 1, definitionId: "sword", tier: 1, price: 5, purchased: false };
  assert.equal(purchaseShopOffer([], 4, offer).reason, "not-enough-gold");
  const full = [item("existing-sword", "sword", 0, 0)];
  for (let index = 2; index < 24; index += 1) {
    full.push(item(`full-${index}`, (["shieldbearer", "scout", "sharpshooter"] as ItemId[])[index % 3]!, Math.floor(index / 6), index % 6, 3));
  }
  const result = purchaseShopOffer(full, 8, offer);
  assert.equal(result.success, true);
  assert.equal(result.gold, 3);
  assert.equal(result.gridItems.find(({ id }) => id === "existing-sword")?.tier, 2);
});

test("row-major placement checks every footprint and rotation", () => {
  const grid = [item("sword", "sword", 0, 0), item("scout", "scout", 0, 2)];
  const placement = findFirstPlacement(grid, "wand");
  assert.deepEqual(placement, { position: { row: 0, col: 3 }, rotation: 0 });
  const placed = placeRewardInFirstEmptyCell(grid, reward("wand", "wand"));
  assert.equal(placed.success, true);
  assert.deepEqual(placed.position, { row: 0, col: 3 });
  assert.deepEqual(placed.gridItems.at(-1)?.position, { row: 0, col: 3 });
  assert.equal(grid.length, 2);
});

test("different footprints swap only when both anchors remain valid", () => {
  const sword = item("sword", "sword", 0, 0);
  const bow = item("bow", "bow", 1, 0);
  const swapped = moveGridItem([sword, bow], sword.id, { row: 1, col: 0 });
  assert.equal(swapped.moved, true);
  assert.equal(swapped.swappedWith, bow.id);
  assert.deepEqual(swapped.items.find(({ id }) => id === bow.id)?.position, { row: 0, col: 0 });
  const edgeSword = item("edge-sword", "sword", 0, 4);
  const blocked = moveGridItem([edgeSword, item("edge-bow", "bow", 1, 0)], edgeSword.id, { row: 1, col: 0 });
  assert.equal(blocked.moved, false);
});

test("all item kinds auto-chain merge and keep row-major position and rotation", () => {
  const grid = [
    item("later", "scout", 2, 4), item("first", "scout", 0, 2),
    item("bow-a", "bow", 3, 0, 1, 0), item("bow-b", "bow", 0, 3, 1, 90),
  ];
  const merged = autoMergeInventory(grid, [reward("queue-a", "scout"), reward("queue-b", "scout")]);
  assert.equal(merged.gridItems.find(({ id }) => id === "first")?.tier, 3);
  assert.deepEqual(merged.gridItems.find(({ id }) => id === "first")?.position, { row: 0, col: 2 });
  assert.equal(merged.gridItems.find(({ id }) => id === "bow-b")?.tier, 2);
  assert.equal(merged.gridItems.find(({ id }) => id === "bow-b")?.rotation, 90);
  assert.equal(merged.pendingRewards.length, 0);
  assert.equal(merged.merges.filter(({ kind }) => kind === "character").length, 3);
});

test("spawners wait a full cooldown, report progress, and stop at squad capacity", () => {
  const engine = new CombatEngine();
  const events: CombatEvent[] = [];
  engine.subscribe((event) => events.push(event));
  engine.startWave({
    waveIndex: 1,
    seed: "spawner-test",
    baseHp: 100,
    spawners: deriveSpawnerBlueprints(STARTING_INVENTORY),
    wave: { index: 1, name: "test", timeLimit: 60, clearGold: 8, groups: [{ at: 50, enemies: [] }] },
  });
  assert.equal(events.some(({ type }) => type === "ally-spawned"), false);
  assert.deepEqual(engine.getSnapshot().spawners.map(({ progress, activeCount, maxActive }) => [progress, activeCount, maxActive]), [[0, 0, 2], [0, 0, 4]]);
  stepFor(engine, 2);
  const progress = engine.getSnapshot().spawners.map(({ progress: value }) => value);
  assert.equal(progress[0]! > 0.32 && progress[0]! < 0.34, true);
  assert.equal(progress[1]! > 0.52 && progress[1]! < 0.54, true);
  engine.pause("test");
  const paused = engine.getSnapshot().spawners.map(({ progress: value }) => value);
  stepFor(engine, 2);
  assert.deepEqual(engine.getSnapshot().spawners.map(({ progress: value }) => value), paused);
  engine.resume("test");
  stepFor(engine, 14);
  const snapshot = engine.getSnapshot();
  assert.deepEqual(snapshot.spawners.map(({ activeCount, maxActive, state }) => [activeCount, maxActive, state]), [[2, 2, "full"], [4, 4, "full"]]);
  assert.equal(events.filter(({ type }) => type === "ally-spawned").length, 6);
  engine.dispose();
});

test("unit cap leaves a ready spawner at 100 percent instead of discarding it", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 1,
    seed: "cap-test",
    baseHp: 100,
    spawners: [{ id: "scout", characterId: "scout", tier: 1, row: 0, col: 0, maxActive: 4, weapons: [] }],
    wave: { index: 1, name: "cap", timeLimit: 60, clearGold: 8, groups: [{ at: 0, enemies: [{ enemyId: "armored", count: 160 }] }] },
  });
  stepFor(engine, 4);
  const spawner = engine.getSnapshot().spawners[0]!;
  assert.equal(spawner.activeCount, 0);
  assert.equal(spawner.progress, 1);
  assert.equal(spawner.state, "ready");
  engine.dispose();
});

test("board rows and columns map to distinct allied deployment positions", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 1,
    seed: "formation-map",
    baseHp: 100,
    spawners: [
      { id: "back-top", characterId: "shieldbearer", tier: 1, row: 0, col: 0, maxActive: 1, weapons: [] },
      { id: "front-bottom", characterId: "scout", tier: 1, row: 3, col: 5, maxActive: 1, weapons: [] },
    ],
    wave: { index: 1, name: "formation", timeLimit: 60, clearGold: 8, groups: [{ at: 50, enemies: [] }] },
  });
  stepFor(engine, 6.25);
  const snapshot = engine.getSnapshot();
  const backTop = snapshot.allies.find(({ definitionId }) => definitionId === "shieldbearer")!;
  const frontBottom = snapshot.allies.find(({ definitionId }) => definitionId === "scout")!;
  assert.equal(backTop.x >= 55 && backTop.x <= 61, true);
  assert.equal(backTop.y >= 227 && backTop.y <= 233, true);
  assert.equal(frontBottom.x >= 135 && frontBottom.x <= 141, true);
  assert.equal(frontBottom.y >= 287 && frontBottom.y <= 293, true);
  assert.equal(frontBottom.x - backTop.x > 70, true);
  assert.equal(frontBottom.y - backTop.y > 50, true);
  engine.dispose();
});

test("depth movement still uses both battlefield axes after delayed first spawn", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 1,
    seed: "depth-movement",
    baseHp: 100,
    spawners: [{ id: "deep-ally", characterId: "shieldbearer", tier: 1, row: 3, col: 5, maxActive: 2, weapons: [] }],
    wave: { index: 1, name: "depth", timeLimit: 60, clearGold: 8, groups: [{ at: 6, enemies: [{ enemyId: "grunt", count: 1 }] }] },
  });
  stepFor(engine, 6.25);
  const before = engine.getSnapshot();
  const allyBefore = before.allies[0]!;
  const enemyBefore = before.enemies[0]!;
  const depthGap = Math.abs(enemyBefore.y - allyBefore.y);
  stepFor(engine, 1);
  const after = engine.getSnapshot();
  assert.equal(after.allies[0]!.x > allyBefore.x, true);
  assert.equal(after.enemies[0]!.x < enemyBefore.x, true);
  assert.equal(Math.abs(after.enemies[0]!.y - after.allies[0]!.y) < depthGap, true);
  engine.dispose();
});

test("drop helper moves multi-cell items and rejects invalid anchors", () => {
  const state = { gridItems: [item("sword", "sword", 0, 0)], pendingRewards: [] };
  const moved = dropItemOnGrid(state, "sword", { row: 2, col: 2 });
  assert.equal(moved.success, true);
  assert.deepEqual(moved.gridItems[0]?.position, { row: 2, col: 2 });
  assert.equal(dropItemOnGrid(state, "sword", { row: 0, col: 5 }).success, false);
});

test("seeded RNG remains deterministic and immutable", () => {
  const first = createSeededRng("same-seed");
  const second = createSeededRng("same-seed");
  const firstSequence = Array.from({ length: 8 }, () => first.next());
  assert.deepEqual(firstSequence, Array.from({ length: 8 }, () => second.next()));
  const source = [1, 2, 3, 4, 5];
  assert.deepEqual(createSeededRng("shuffle").shuffle(source), createSeededRng("shuffle").shuffle(source));
  assert.deepEqual(source, [1, 2, 3, 4, 5]);
  assert.equal(normalizeSeed("  "), "prototype-001");
});
