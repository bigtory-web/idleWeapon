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
import { CombatEngine, ENEMY_SPAWN_INTERVAL } from "../lib/game/engine";
import { getAllyDeployPosition, getBattleCellPosition } from "../lib/game/battle-layout";
import {
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
import { EQUIPMENT_COMBOS, getActiveEquipmentCombos } from "../lib/game/combos";
import { createSeededRng, normalizeSeed } from "../lib/game/rng";
import { getSpawnArrivalProgress, projectBattlePoint } from "../lib/game/render";
import { getScaledFrameSteps, normalizeBattleSpeed } from "../lib/game/speed";
import { generateShopOffers, purchaseShopOffer } from "../lib/game/shop";
import { BATTLEFIELD_COLUMNS, INVENTORY_COLUMNS, PLAYER_DEPLOY_COLUMNS, STARTING_UNLOCKED_COLUMNS, type CombatEvent, type GridItem, type ItemId, type PendingReward, type Rotation, type ShopOffer, type Tier } from "../lib/game/types";

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
  assert.deepEqual(Object.values(WEAPONS).map(({ footprint }) => footprint.length), [2, 3, 3, 2, 2, 2]);
  assert.deepEqual(Object.values(WEAPONS).map(({ damage, cooldown, range }) => [damage, cooldown, range]), [
    [13, 0.7, 28], [10, 0.9, 180], [24, 1.4, 32], [8, 1, 150], [5, 1.2, 27], [7, 1.2, 135],
  ]);
  assert.deepEqual(WEAPON_DAMAGE_MULTIPLIER, { 1: 1, 2: 1.7, 3: 2.7 });
  assert.equal(WEAPONS.sword.equipPenalty?.moveSpeedMultiplier, 0.94);
  assert.equal(WEAPONS.bow.equipPenalty?.hpMultiplier, 0.9);
  assert.deepEqual(WAVE_DEFINITIONS.map(getWaveEnemyTotal), [18, 30, 26, 32, 48, 31]);
  assert.deepEqual(WAVE_DEFINITIONS.map(({ timeLimit }) => timeLimit), [60, 60, 90, 90, 90, 120]);
  assert.equal(ENEMY_HP_MULTIPLIER, 1.2);
  assert.equal(ENEMY_DAMAGE_MULTIPLIER, 1.1);
  assert.deepEqual(Object.values(ENEMIES).map(({ hp, damage }) => [hp, damage]), [
    [54, 8], [36, 6], [132, 13], [66, 9], [1080, 24],
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
  assert.equal(canPlaceItem([], sword, { row: 0, col: 3 }), true);
  assert.equal(canPlaceItem([], sword, { row: 0, col: 6 }), false);
  assert.equal(canPlaceItem([], sword, { row: 0, col: 2 }, 0, [], STARTING_UNLOCKED_COLUMNS), true);
  assert.equal(canPlaceItem([item("block", "scout", 0, 1)], sword, { row: 0, col: 0 }), false);
  const hammer = item("hammer", "hammer", 1, 1);
  assert.deepEqual(getOccupiedCells(hammer), [{ row: 1, col: 1 }, { row: 2, col: 1 }, { row: 2, col: 2 }]);
  assert.equal(canPlaceItem([item("l-hole", "scout", 1, 2)], hammer, { row: 1, col: 1 }), true);
});

test("rotation keeps the anchor and reverts when the rotated footprint does not fit", () => {
  const bow = item("bow", "bow", 0, 0);
  const rotated = rotateGridItem([bow], bow.id);
  assert.equal(rotated.moved, true);
  assert.equal(rotated.items[0]?.rotation, 90);
  const edgeBow = item("edge", "bow", 3, 4);
  const rejected = rotateGridItem([edgeBow], edgeBow.id);
  assert.equal(rejected.moved, false);
  assert.equal(rejected.items[0]?.rotation, 0);
});

test("orthogonal footprint contact determines loadouts and sharing without sockets", () => {
  const sword = item("sword", "sword", 1, 1);
  const left = item("left", "shieldbearer", 1, 0);
  const right = item("right", "scout", 1, 3);
  const touchingNoSocket = item("below", "sharpshooter", 2, 1);
  const chained = item("wand", "wand", 1, 3);
  const items = [sword, left, right, touchingNoSocket, chained];
  assert.deepEqual(getCharactersSharingWeapon(sword, items).map(({ id }) => id), ["left", "right", "below"]);
  assert.deepEqual(getAdjacentWeaponConnections(touchingNoSocket, items).map(({ item: weapon }) => weapon.id), ["sword"]);
  assert.deepEqual(getAdjacentWeaponConnections(left, items).map(({ item: weapon, direction }) => [weapon.id, direction]), [["sword", "right"]]);
  const shield = item("shield", "shieldbearer", 1, 0);
  const socketedSword = item("socketed-sword", "sword", 1, 1);
  assert.deepEqual(getAdjacentWeaponConnections(shield, [shield, socketedSword]).map(({ item: weapon, characterCell }) => [weapon.id, characterCell]), [["socketed-sword", { row: 0, col: 0 }]]);
  const diagonal = item("diagonal", "scout", 0, 0);
  assert.deepEqual(getAdjacentWeaponConnections(diagonal, [diagonal, socketedSword]), []);
});

test("starting inventory keeps both character-to-weapon contacts", () => {
  const blueprints = deriveSpawnerBlueprints(STARTING_INVENTORY);
  const shieldbearer = blueprints.find(({ characterId }) => characterId === "shieldbearer")!;
  const scout = blueprints.find(({ characterId }) => characterId === "scout")!;
  assert.equal(shieldbearer.maxActive, 2);
  assert.equal(scout.maxActive, 4);
  assert.deepEqual(shieldbearer.weapons, [{ weaponId: "sword", tier: 1, direction: "left", sourceItemId: "start-sword" }]);
  assert.deepEqual(scout.weapons, [
    { weaponId: "bow", tier: 1, direction: "left", sourceItemId: "start-bow" },
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

test("shop purchases always occupy a separate footprint and reject a full backpack", () => {
  const offer: ShopOffer = { id: "shop-1-sword", waveIndex: 1, definitionId: "sword", tier: 1, price: 5, purchased: false };
  assert.equal(purchaseShopOffer([], 4, offer).reason, "not-enough-gold");
  const full = [item("existing-sword", "sword", 0, 0)];
  for (let index = 2; index < 35; index += 1) {
    full.push(item(`full-${index}`, (["shieldbearer", "scout", "sharpshooter"] as ItemId[])[index % 3]!, Math.floor(index / 7), index % 7, 3));
  }
  const result = purchaseShopOffer(full, 8, offer);
  assert.equal(result.success, false);
  assert.equal(result.reason, "grid-full");
  assert.equal(result.gold, 8);
  assert.equal(result.gridItems.find(({ id }) => id === "existing-sword")?.tier, 1);

  const placed = purchaseShopOffer([item("existing-sword", "sword", 0, 0)], 8, offer);
  assert.equal(placed.success, true);
  assert.equal(placed.gold, 3);
  assert.equal(placed.gridItems.length, 2);
  assert.equal(placed.gridItems.every(({ tier }) => tier === 1), true);
});

test("row-major placement keeps newly acquired weapons in their default direction", () => {
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
  const edgeSword = item("edge-sword", "sword", 0, 5);
  const blocked = moveGridItem([edgeSword, item("edge-bow", "bow", 1, 0)], edgeSword.id, { row: 1, col: 0 });
  assert.equal(blocked.moved, false);
});

test("weapons and characters merge only when directly dropped on an identical tier", () => {
  const weapons = [item("source", "sword", 0, 0), item("target", "sword", 2, 2), item("third", "sword", 4, 0)];
  const mergedWeapon = dropItemOnGrid({ gridItems: weapons, pendingRewards: [] }, "source", { row: 2, col: 2 });
  assert.equal(mergedWeapon.success, true);
  assert.equal(mergedWeapon.action, "merged");
  assert.equal(mergedWeapon.gridItems.length, 2);
  assert.equal(mergedWeapon.gridItems.find(({ id }) => id === "target")?.tier, 2);
  assert.equal(mergedWeapon.gridItems.find(({ id }) => id === "third")?.tier, 1);

  const characters = [item("scout-a", "scout", 0, 0), item("scout-b", "scout", 2, 2)];
  const mergedCharacter = dropItemOnGrid({ gridItems: characters, pendingRewards: [] }, "scout-a", { row: 2, col: 2 });
  assert.equal(mergedCharacter.action, "merged");
  assert.equal(mergedCharacter.gridItems[0]?.tier, 2);
  assert.notEqual(dropItemOnGrid({ gridItems: [item("s", "sword", 0, 0), item("b", "bow", 2, 2)], pendingRewards: [] }, "s", { row: 2, col: 2 }).action, "merged");
});

test("twelve named recipes activate once while duplicate equipment uses its own recipe", () => {
  assert.equal(EQUIPMENT_COMBOS.length, 12);
  const combos = getActiveEquipmentCombos([
    { weaponId: "sword" }, { weaponId: "sword" }, { weaponId: "shield" }, { weaponId: "spellbook" },
  ]).map(({ id }) => id);
  assert.deepEqual(combos, ["dual-blades", "vanguard", "arcane-aegis", "spellblade"]);
  assert.equal(new Set(combos).size, combos.length);
});

test("adjacent equipment writes every active combo into the spawner blueprint", () => {
  const grid = [
    item("hero", "shieldbearer", 2, 3),
    item("sword", "sword", 2, 1),
    item("shield", "shield", 1, 4),
    item("book", "spellbook", 3, 2),
  ];
  const blueprint = deriveSpawnerBlueprints(grid)[0]!;
  assert.deepEqual(blueprint.weapons.map(({ weaponId }) => weaponId), ["shield", "sword", "spellbook"]);
  assert.deepEqual(blueprint.activeCombos, ["vanguard", "arcane-aegis", "spellblade"]);
});

test("arcane aegis creates a visible shield and formation movement preserves the home row", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 1,
    seed: "combo-formation",
    baseHp: 100,
    spawners: [{
      id: "combo-hero", characterId: "shieldbearer", tier: 1, row: 0, col: 1, maxActive: 1,
      weapons: [
        { sourceItemId: "shield", weaponId: "shield", tier: 1, direction: "left" },
        { sourceItemId: "book", weaponId: "spellbook", tier: 1, direction: "right" },
      ],
      activeCombos: ["arcane-aegis"],
    }],
    wave: { index: 1, name: "combo", timeLimit: 30, clearGold: 0, groups: [{ at: 0, enemies: [{ enemyId: "armored", count: 1 }] }] },
  });
  (engine as unknown as { spawners: Array<{ cooldown: number }> }).spawners[0]!.cooldown = 0;
  stepFor(engine, 1.2);
  const ally = engine.getSnapshot().allies[0]!;
  assert.equal(ally.activeCombos?.includes("arcane-aegis"), true);
  assert.equal((ally.shield ?? 0) > 0, true);
  assert.equal(ally.homeRow, 0);
  assert.equal(Math.abs(ally.y - 230) < 14, true);
  engine.dispose();
});

test("spawners wait a full cooldown, report progress, and stop at squad capacity", () => {
  const engine = new CombatEngine();
  const events: CombatEvent[] = [];
  engine.subscribe((event) => events.push(event));
  engine.startWave({
    waveIndex: 2,
    seed: "spawner-test",
    baseHp: 100,
    spawners: deriveSpawnerBlueprints(STARTING_INVENTORY),
    wave: { index: 1, name: "test", timeLimit: 60, clearGold: 8, groups: [{ at: 50, enemies: [{ enemyId: "grunt", count: 1 }] }] },
  });
  const durableEnemy = (engine as unknown as { enemies: Array<{ hp: number; maxHp: number; damage: number; moveSpeed: number }> }).enemies[0]!;
  durableEnemy.hp = durableEnemy.maxHp = 1_000_000;
  durableEnemy.damage = 0;
  durableEnemy.moveSpeed = 0;
  assert.equal(events.some(({ type }) => type === "ally-spawned"), false);
  assert.deepEqual(engine.getSnapshot().spawners.map(({ progress, activeCount, maxActive }) => [progress, activeCount, maxActive]), [[0, 0, 4], [0, 0, 2]]);
  stepFor(engine, 2);
  const progress = engine.getSnapshot().spawners.map(({ progress: value }) => value);
  assert.equal(progress[0]! > 0.52 && progress[0]! < 0.54, true);
  assert.equal(progress[1]! > 0.32 && progress[1]! < 0.34, true);
  engine.pause("test");
  const paused = engine.getSnapshot().spawners.map(({ progress: value }) => value);
  stepFor(engine, 2);
  assert.deepEqual(engine.getSnapshot().spawners.map(({ progress: value }) => value), paused);
  engine.resume("test");
  stepFor(engine, 14);
  const snapshot = engine.getSnapshot();
  assert.deepEqual(snapshot.spawners.map(({ activeCount, maxActive, state }) => [activeCount, maxActive, state]), [[4, 4, "full"], [2, 2, "full"]]);
  assert.equal(events.filter(({ type }) => type === "ally-spawned").length, 6);
  engine.dispose();
});

test("unit cap preserves the pending enemy queue and resumes as soon as capacity opens", () => {
  const engine = new CombatEngine({ unitCap: 2 });
  engine.startWave({
    waveIndex: 2,
    seed: "cap-test",
    baseHp: 100,
    spawners: [],
    wave: { index: 2, name: "cap", timeLimit: 60, clearGold: 8, groups: [{ at: 0, enemies: [{ enemyId: "armored", count: 4 }] }] },
  });
  stepFor(engine, 1);
  assert.equal(engine.getSnapshot().enemies.length, 2);
  (engine as unknown as { enemies: Array<{ hp: number }> }).enemies[0]!.hp = 0;
  stepFor(engine, 0.2);
  assert.equal(engine.getSnapshot().enemies.length, 2);
  engine.dispose();
});

test("all normal wave groups flatten into a deterministic 0.15 second spawn queue", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 2,
    seed: "sequential-wave",
    baseHp: 100,
    spawners: [],
    wave: {
      index: 2,
      name: "sequential",
      timeLimit: 60,
      clearGold: 0,
      groups: [
        { at: 0, enemies: [{ enemyId: "grunt", count: 2 }] },
        { at: 30, enemies: [{ enemyId: "runner", count: 1 }] },
      ],
    },
  });
  assert.equal(ENEMY_SPAWN_INTERVAL, 0.15);
  assert.deepEqual(engine.getSnapshot().enemies.map(({ definitionId }) => definitionId), ["grunt"]);
  stepFor(engine, 0.14);
  assert.equal(engine.getSnapshot().enemies.length, 1);
  stepFor(engine, 0.03);
  assert.deepEqual(engine.getSnapshot().enemies.map(({ definitionId }) => definitionId), ["grunt", "grunt"]);
  stepFor(engine, 0.16);
  assert.deepEqual(engine.getSnapshot().enemies.map(({ definitionId }) => definitionId), ["grunt", "grunt", "runner"]);
  engine.dispose();
});

test("the boss waits until every queued and living normal enemy is gone", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 6,
    seed: "boss-gate",
    baseHp: 100,
    spawners: [],
    wave: {
      index: 6,
      name: "boss gate",
      timeLimit: 120,
      clearGold: 0,
      groups: [{ at: 0, enemies: [{ enemyId: "boss", count: 1 }, { enemyId: "grunt", count: 2 }] }],
    },
  });
  stepFor(engine, 0.2);
  assert.equal(engine.getSnapshot().enemies.some(({ isBoss }) => isBoss), false);
  (engine as unknown as { enemies: Array<{ hp: number; isBoss: boolean }> }).enemies.forEach((enemy) => {
    if (!enemy.isBoss) enemy.hp = 0;
  });
  stepFor(engine, 0.04);
  assert.equal(engine.getSnapshot().enemies.some(({ isBoss }) => isBoss), true);
  assert.equal(engine.getSnapshot().phase, "running");
  engine.dispose();
});

test("all seven inventory columns start open and combat waves spawn no structures", () => {
  assert.equal(STARTING_UNLOCKED_COLUMNS, 7);
  for (const waveIndex of [1, 2, 6]) {
    const engine = new CombatEngine();
    engine.startWave({
      waveIndex,
      seed: `no-structures-${waveIndex}`,
      baseHp: 100,
      spawners: [],
      wave: { index: waveIndex, name: "no structures", timeLimit: 60, clearGold: 0, groups: [] },
    });
    assert.equal(engine.getSnapshot().enemies.some(({ isStructure }) => isStructure), false);
    engine.dispose();
  }
});

test("seven player columns and five rows map to distinct allied deployment positions and spawner views", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 1,
    seed: "formation-map",
    baseHp: 100,
    spawners: [
      { id: "back-top", characterId: "shieldbearer", tier: 1, row: 0, col: 0, maxActive: 1, weapons: [] },
      { id: "front-bottom", characterId: "scout", tier: 1, row: 4, col: 6, maxActive: 1, weapons: [] },
    ],
    wave: { index: 1, name: "formation", timeLimit: 60, clearGold: 8, groups: [{ at: 50, enemies: [{ enemyId: "grunt", count: 1 }] }] },
  });
  (engine as unknown as { spawners: Array<{ cooldown: number }> }).spawners.forEach((spawner) => { spawner.cooldown = 0; });
  stepFor(engine, 0.02);
  const snapshot = engine.getSnapshot();
  const backTop = snapshot.allies.find(({ definitionId }) => definitionId === "shieldbearer")!;
  const frontBottom = snapshot.allies.find(({ definitionId }) => definitionId === "scout")!;
  assert.equal(backTop.x >= 57 && backTop.x <= 63, true);
  assert.equal(backTop.y >= 227 && backTop.y <= 233, true);
  assert.equal(frontBottom.x >= 327 && frontBottom.x <= 333, true);
  assert.equal(frontBottom.y >= 300 && frontBottom.y <= 313, true);
  assert.equal(frontBottom.x - backTop.x > 260, true);
  assert.equal(frontBottom.y - backTop.y > 70, true);
  assert.deepEqual(snapshot.spawners.map(({ characterId, tier, row, col, weapons }) => ({ characterId, tier, row, col, weapons })), [
    { characterId: "shieldbearer", tier: 1, row: 0, col: 0, weapons: [] },
    { characterId: "scout", tier: 1, row: 4, col: 6, weapons: [] },
  ]);
  engine.dispose();
});

test("depth movement still uses both battlefield axes after the ally's delayed first spawn", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 2,
    seed: "depth-movement",
    baseHp: 100,
    spawners: [{ id: "deep-ally", characterId: "shieldbearer", tier: 1, row: 3, col: 4, maxActive: 2, weapons: [] }],
    wave: { index: 2, name: "depth", timeLimit: 60, clearGold: 8, groups: [{ at: 0, enemies: [{ enemyId: "armored", count: 1 }] }] },
  });
  (engine as unknown as { spawners: Array<{ cooldown: number }> }).spawners[0]!.cooldown = 0;
  stepFor(engine, 0.02);
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
  assert.equal(dropItemOnGrid(state, "sword", { row: 0, col: 3 }).success, true);
  assert.equal(dropItemOnGrid(state, "sword", { row: 0, col: 5 }).success, true);
  assert.equal(dropItemOnGrid(state, "sword", { row: 0, col: 6 }).success, false);
  assert.equal(dropItemOnGrid({ ...state, unlockedColumns: 3 }, "sword", { row: 0, col: 2 }).success, false);
});

test("battle speed normalization and substeps scale elapsed time without oversized steps", () => {
  assert.equal(normalizeBattleSpeed(0.5), 0.5);
  assert.equal(normalizeBattleSpeed(2), 2);
  assert.equal(normalizeBattleSpeed(7), 1);
  assert.deepEqual(getScaledFrameSteps(0.1, 0.5), [0.05]);
  assert.deepEqual(getScaledFrameSteps(0.1, 1), [0.05, 0.05]);
  const doubleSteps = getScaledFrameSteps(0.1, 2);
  assert.equal(doubleSteps.length, 4);
  assert.equal(Math.abs(doubleSteps.reduce((sum, step) => sum + step, 0) - 0.2) < 0.000001, true);
  assert.equal(doubleSteps.every((step) => step <= 0.05), true);
});

test("advance avoids per-call render snapshots while step keeps the compatibility snapshot", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 2,
    seed: "snapshot-allocation",
    baseHp: 1_000_000,
    spawners: [],
    wave: { index: 2, name: "snapshot", timeLimit: 60, clearGold: 0, groups: [{ at: 0, enemies: [{ enemyId: "grunt", count: 1 }] }] },
  });
  const tracked = engine as CombatEngine & { getSnapshot: () => ReturnType<CombatEngine["getSnapshot"]> };
  const originalGetSnapshot = tracked.getSnapshot.bind(engine);
  let snapshotCalls = 0;
  tracked.getSnapshot = () => {
    snapshotCalls += 1;
    return originalGetSnapshot();
  };
  engine.advance(0.1);
  assert.equal(snapshotCalls, 0);
  engine.advance(0.12);
  assert.equal(snapshotCalls, 1);
  engine.step(0.01);
  assert.equal(snapshotCalls, 2);
  engine.dispose();
});

test("deployment projection preserves all five rows and spawn arrival has start, middle, and end states", () => {
  const first = getAllyDeployPosition(0, 0);
  const last = getAllyDeployPosition(4, 6);
  assert.deepEqual(first, { x: 60, y: 230 });
  assert.deepEqual(last, { x: 330, y: 310 });
  assert.equal(INVENTORY_COLUMNS, 7);
  assert.equal(PLAYER_DEPLOY_COLUMNS, 7);
  assert.equal(BATTLEFIELD_COLUMNS, 7);
  assert.deepEqual(getBattleCellPosition(4, 6), { x: 330, y: 310 });
  assert.deepEqual(projectBattlePoint(first.x, first.y), { x: 60, y: 100, depth: 0, scale: 0.68 });
  assert.deepEqual(projectBattlePoint(last.x, last.y), { x: 330, y: 280, depth: 1, scale: 0.68 });
  assert.equal(getSpawnArrivalProgress(0.42), 0);
  assert.equal(getSpawnArrivalProgress(0.21), 0.5);
  assert.equal(getSpawnArrivalProgress(0), 1);
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
