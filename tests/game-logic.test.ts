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
  autoMergeWeapons,
  deriveSpawnerBlueprints,
  dropItemOnGrid,
  getAdjacentWeaponConnections,
  getAdjacentWeapons,
  getCharactersSharingWeapon,
  mergeCharacters,
  moveGridItem,
  moveGridItemToPending,
  movePendingRewardToGrid,
  placeRewardInFirstEmptyCell,
} from "../lib/game/inventory";
import { createSeededRng, normalizeSeed } from "../lib/game/rng";
import { generateShopOffers, purchaseShopOffer } from "../lib/game/shop";
import type { CombatEvent, GridItem, ItemId, PendingReward, ShopOffer, Tier } from "../lib/game/types";

function item(
  id: string,
  definitionId: ItemId,
  row: number,
  col: number,
  tier: Tier = 1,
): GridItem {
  return { id, definitionId, tier, position: { row, col } };
}

function reward(
  id: string,
  definitionId: ItemId,
  tier: Tier = 1,
): PendingReward {
  return { id, definitionId, tier };
}

test("prototype data keeps combat values and adds fixed gold rewards", () => {
  assert.deepEqual(
    [CHARACTERS.shieldbearer.hp, CHARACTERS.shieldbearer.moveSpeed, CHARACTERS.shieldbearer.spawnCooldown],
    [180, 34, 6],
  );
  assert.deepEqual(
    [CHARACTERS.scout.hp, CHARACTERS.scout.moveSpeed, CHARACTERS.scout.spawnCooldown],
    [80, 52, 3.8],
  );
  assert.deepEqual(
    [CHARACTERS.sharpshooter.hp, CHARACTERS.sharpshooter.moveSpeed, CHARACTERS.sharpshooter.spawnCooldown],
    [90, 38, 5.2],
  );
  assert.deepEqual(CHARACTER_HP_AND_POWER_MULTIPLIER, { 1: 1, 2: 1.6, 3: 2.4 });
  assert.deepEqual(CHARACTER_SPAWN_COOLDOWN_MULTIPLIER, { 1: 1, 2: 0.9, 3: 0.8 });

  assert.deepEqual(
    Object.values(WEAPONS).map(({ damage, cooldown, range }) => [damage, cooldown, range]),
    [
      [13, 0.7, 28],
      [10, 0.9, 180],
      [24, 1.4, 32],
      [8, 1, 150],
    ],
  );
  assert.deepEqual(WEAPON_DAMAGE_MULTIPLIER, { 1: 1, 2: 1.7, 3: 2.7 });
  assert.deepEqual(WAVE_DEFINITIONS.map(getWaveEnemyTotal), [12, 20, 17, 21, 32, 21]);
  assert.deepEqual(WAVE_DEFINITIONS.map(({ timeLimit }) => timeLimit), [60, 60, 90, 90, 90, 120]);
  assert.deepEqual(WAVE_DEFINITIONS.map(({ clearGold }) => clearGold), [8, 10, 12, 14, 16, 0]);
  assert.deepEqual(Object.values(WEAPONS).map(({ shopPrice }) => shopPrice), [5, 5, 6, 6]);
  assert.deepEqual(Object.values(CHARACTERS).map(({ shopPrice }) => shopPrice), [9, 7, 8]);
  assert.equal(ENEMIES.boss.isBoss, true);
});

test("enemy-only difficulty tuning consistently raises durability and damage", () => {
  assert.equal(ENEMY_HP_MULTIPLIER, 1.35);
  assert.equal(ENEMY_DAMAGE_MULTIPLIER, 1.25);
  assert.deepEqual(
    Object.values(ENEMIES).map(({ hp, damage }) => [hp, damage]),
    [
      [61, 9],
      [41, 6],
      [149, 15],
      [74, 10],
      [1215, 28],
    ],
  );
  assert.deepEqual(WAVE_DEFINITIONS.map(getWaveEnemyTotal), [12, 20, 17, 21, 32, 21]);
});

test("adjacency only follows direct orthogonal cells and ignores weapon chains", () => {
  const character = item("character", "scout", 0, 0);
  const rightSword = item("right", "sword", 0, 1);
  const downBow = item("down", "bow", 1, 0);
  const diagonalHammer = item("diagonal", "hammer", 1, 1);
  const chainedWand = item("chained", "wand", 0, 2);
  const items = [character, rightSword, downBow, diagonalHammer, chainedWand];

  assert.deepEqual(
    getAdjacentWeapons(character, items).map(({ id }) => id),
    ["right", "down"],
  );
  assert.deepEqual(
    getAdjacentWeaponConnections(character, items).map(({ item: weapon, direction }) => [weapon.id, direction]),
    [
      ["right", "right"],
      ["down", "down"],
    ],
  );
});

test("one weapon is fully shared by every directly adjacent character", () => {
  const sword = item("weapon", "sword", 1, 1);
  const left = item("left", "shieldbearer", 1, 0);
  const right = item("right", "scout", 1, 2);
  const diagonal = item("diagonal", "sharpshooter", 0, 0);

  assert.deepEqual(
    getCharactersSharingWeapon(sword, [sword, left, right, diagonal]).map(({ id }) => id),
    ["left", "right"],
  );
});

test("starting inventory derives shared sword and the scout's two-weapon snapshot", () => {
  const blueprints = deriveSpawnerBlueprints(STARTING_INVENTORY);
  const shieldbearer = blueprints.find(({ characterId }) => characterId === "shieldbearer");
  const scout = blueprints.find(({ characterId }) => characterId === "scout");

  assert.deepEqual(shieldbearer?.weapons, [
    { weaponId: "sword", tier: 1, direction: "right", sourceItemId: "start-sword" },
  ]);
  assert.deepEqual(scout?.weapons, [
    { weaponId: "bow", tier: 1, direction: "up", sourceItemId: "start-bow" },
    { weaponId: "sword", tier: 1, direction: "left", sourceItemId: "start-sword" },
  ]);
});

test("shop offers are deterministic, unique, and always mix characters and weapons", () => {
  const first = generateShopOffers("prototype-001", 2);
  const second = generateShopOffers("prototype-001", 2);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map(({ definitionId }) => definitionId)).size, 3);
  assert.equal(first.some(({ definitionId }) => definitionId in CHARACTERS), true);
  assert.equal(first.some(({ definitionId }) => definitionId in WEAPONS), true);
  for (const offer of first) {
    assert.equal(offer.price, [...Object.values(CHARACTERS), ...Object.values(WEAPONS)]
      .find(({ id }) => id === offer.definitionId)?.shopPrice);
  }
});

test("shop blocks insufficient gold and permits a full-grid weapon merge", () => {
  const swordOffer: ShopOffer = {
    id: "shop-1-sword",
    waveIndex: 1,
    definitionId: "sword",
    tier: 1,
    price: 5,
    purchased: false,
  };
  assert.equal(purchaseShopOffer([], 4, swordOffer).reason, "not-enough-gold");

  const fullGrid = Array.from({ length: 24 }, (_, index) =>
    item(`occupied-${index}`, index === 0 ? "sword" : "shieldbearer", Math.floor(index / 6), index % 6),
  );
  const result = purchaseShopOffer(fullGrid, 8, swordOffer);
  assert.equal(result.success, true);
  assert.equal(result.gold, 3);
  assert.equal(result.gridItems.length, 24);
  assert.equal(result.gridItems.find(({ id }) => id === "occupied-0")?.tier, 2);
});

test("engine exposes real spawner progress and exact connected weapon ids", () => {
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

  const spawnEvents = events.filter((event): event is Extract<CombatEvent, { type: "ally-spawned" }> => event.type === "ally-spawned");
  assert.deepEqual(spawnEvents.map(({ spawnerId, weaponItemIds }) => [spawnerId, weaponItemIds]), [
    ["start-shieldbearer", ["start-sword"]],
    ["start-scout", ["start-bow", "start-sword"]],
  ]);
  assert.deepEqual(engine.getSnapshot().spawners.map(({ progress }) => progress), [0, 0]);
  for (let index = 0; index < 8; index += 1) engine.step(0.25);
  const progress = engine.getSnapshot().spawners.map(({ progress }) => progress);
  assert.equal(progress[0]! > 0.32 && progress[0]! < 0.34, true);
  assert.equal(progress[1]! > 0.52 && progress[1]! < 0.54, true);
  engine.pause("test");
  const paused = engine.getSnapshot().spawners.map(({ progress: value }) => value);
  engine.step(2);
  assert.deepEqual(engine.getSnapshot().spawners.map(({ progress: value }) => value), paused);
  engine.dispose();
});

test("combat uses battlefield depth for targeting and moves units diagonally into range", () => {
  const engine = new CombatEngine();
  engine.startWave({
    waveIndex: 1,
    seed: "depth-movement",
    baseHp: 100,
    spawners: [{
      id: "deep-ally",
      characterId: "shieldbearer",
      tier: 1,
      row: 3,
      col: 5,
      weapons: [],
    }],
    wave: {
      index: 1,
      name: "depth test",
      timeLimit: 60,
      clearGold: 8,
      groups: [{ at: 0, enemies: [{ enemyId: "grunt", count: 1 }] }],
    },
  });

  const before = engine.getSnapshot();
  const allyBefore = before.allies[0]!;
  const enemyBefore = before.enemies[0]!;
  const depthGapBefore = Math.abs(enemyBefore.y - allyBefore.y);
  for (let index = 0; index < 4; index += 1) engine.step(0.25);
  const after = engine.getSnapshot();
  const allyAfter = after.allies[0]!;
  const enemyAfter = after.enemies[0]!;

  assert.equal(allyAfter.x > allyBefore.x, true);
  assert.equal(allyAfter.y < allyBefore.y, true);
  assert.equal(enemyAfter.x < enemyBefore.x, true);
  assert.equal(enemyAfter.y > enemyBefore.y, true);
  assert.equal(Math.abs(enemyAfter.y - allyAfter.y) < depthGapBefore, true);
  engine.dispose();
});

test("weapon auto-merge chains and keeps the row-major grid survivor", () => {
  const gridItems = [
    item("later-grid", "sword", 2, 4),
    item("first-grid", "sword", 0, 2),
    item("max-tier", "sword", 3, 5, 3),
  ];
  const pendingRewards = [reward("queue-a", "sword"), reward("queue-b", "sword")];
  const result = autoMergeWeapons(gridItems, pendingRewards);

  assert.deepEqual(
    result.gridItems.map(({ id, tier, position }) => ({ id, tier, position })),
    [
      { id: "first-grid", tier: 3, position: { row: 0, col: 2 } },
      { id: "max-tier", tier: 3, position: { row: 3, col: 5 } },
    ],
  );
  assert.deepEqual(result.pendingRewards, []);
  assert.equal(result.merges.length, 3);
  assert.equal(result.merges.at(-1)?.survivorId, "first-grid");

  // Inputs remain suitable for React state history/undo.
  assert.equal(gridItems[0]?.tier, 1);
  assert.equal(pendingRewards.length, 2);
});

test("weapon merge prefers a grid result over a queued duplicate", () => {
  const gridItems = [item("grid-bow", "bow", 3, 3)];
  const result = autoMergeWeapons(gridItems, [reward("queued-bow", "bow")]);

  assert.equal(result.gridItems[0]?.id, "grid-bow");
  assert.equal(result.gridItems[0]?.tier, 2);
  assert.deepEqual(result.gridItems[0]?.position, { row: 3, col: 3 });
  assert.deepEqual(result.pendingRewards, []);
});

test("characters merge only by an explicit matching drop and target survives", () => {
  const state = {
    gridItems: [item("target", "scout", 2, 2)],
    pendingRewards: [reward("source", "scout")],
  };
  const merged = mergeCharacters(state, "source", "target");

  assert.equal(merged.success, true);
  assert.equal(merged.action, "merged");
  assert.deepEqual(merged.gridItems[0], item("target", "scout", 2, 2, 2));
  assert.deepEqual(merged.pendingRewards, []);
  assert.equal(state.gridItems[0]?.tier, 1);

  const mismatch = mergeCharacters(
    { gridItems: [item("a", "scout", 0, 0), item("b", "shieldbearer", 0, 1)], pendingRewards: [] },
    "a",
    "b",
  );
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.reason, "different-character");
});

test("grid drops swap occupied cells and reject out-of-bounds positions", () => {
  const items = [item("a", "sword", 0, 0), item("b", "bow", 0, 1)];
  const moved = moveGridItem(items, "a", { row: 0, col: 1 });

  assert.equal(moved.moved, true);
  assert.equal(moved.swappedWith, "b");
  assert.deepEqual(moved.items.find(({ id }) => id === "a")?.position, { row: 0, col: 1 });
  assert.deepEqual(moved.items.find(({ id }) => id === "b")?.position, { row: 0, col: 0 });
  assert.deepEqual(items[0]?.position, { row: 0, col: 0 });

  const invalid = moveGridItem(items, "a", { row: 0, col: 6 });
  assert.equal(invalid.moved, false);
  assert.equal(invalid.reason, "invalid-position");
});

test("queue-to-grid occupied drops swap, while grid items can return to queue", () => {
  const state = {
    gridItems: [item("grid-item", "hammer", 1, 1)],
    pendingRewards: [reward("reward-item", "wand")],
  };
  const swapped = movePendingRewardToGrid(state, "reward-item", { row: 1, col: 1 });

  assert.equal(swapped.action, "swapped");
  assert.equal(swapped.gridItems[0]?.id, "reward-item");
  assert.deepEqual(swapped.pendingRewards.map(({ id }) => id), ["grid-item"]);

  const queued = moveGridItemToPending(swapped, "reward-item", 0);
  assert.deepEqual(queued.gridItems, []);
  assert.deepEqual(queued.pendingRewards.map(({ id }) => id), ["reward-item", "grid-item"]);
});

test("selected rewards enter the first row-major empty grid cell without mutation", () => {
  const gridItems = [
    item("first", "sword", 0, 0),
    item("third", "scout", 0, 2),
  ];
  const selectedReward: PendingReward = {
    id: "selected-reward",
    definitionId: "wand",
    tier: 2,
    sourceLevel: 4,
  };
  const result = placeRewardInFirstEmptyCell(gridItems, selectedReward);

  assert.equal(result.success, true);
  assert.deepEqual(result.position, { row: 0, col: 1 });
  assert.deepEqual(result.gridItems.at(-1), {
    ...selectedReward,
    position: { row: 0, col: 1 },
  });
  assert.deepEqual(gridItems, [
    item("first", "sword", 0, 0),
    item("third", "scout", 0, 2),
  ]);
  assert.notEqual(result.gridItems, gridItems);
  assert.notEqual(result.gridItems[0], gridItems[0]);
});

test("reward placement reports grid-full and leaves a full grid unchanged", () => {
  const gridItems = Array.from({ length: 24 }, (_, index) =>
    item(`occupied-${index}`, "sword", Math.floor(index / 6), index % 6),
  );
  const before = structuredClone(gridItems);
  const result = placeRewardInFirstEmptyCell(
    gridItems,
    reward("unplaced-reward", "bow", 3),
  );

  assert.equal(result.success, false);
  assert.equal(result.reason, "grid-full");
  assert.equal(result.position, undefined);
  assert.deepEqual(result.gridItems, before);
  assert.deepEqual(gridItems, before);
  assert.notEqual(result.gridItems, gridItems);
});

test("dropItemOnGrid merges matching characters but swaps other item pairs", () => {
  const merged = dropItemOnGrid(
    {
      gridItems: [item("source", "shieldbearer", 0, 0), item("target", "shieldbearer", 0, 1)],
      pendingRewards: [],
    },
    "source",
    { row: 0, col: 1 },
  );
  assert.equal(merged.action, "merged");
  assert.equal(merged.gridItems[0]?.id, "target");
  assert.equal(merged.gridItems[0]?.tier, 2);

  const swapped = dropItemOnGrid(
    {
      gridItems: [item("sword", "sword", 0, 0), item("bow", "bow", 0, 1)],
      pendingRewards: [],
    },
    "sword",
    { row: 0, col: 1 },
  );
  assert.equal(swapped.action, "swapped");
});

test("seeded RNG reproduces sequences, stays in range, and shuffles immutably", () => {
  const first = createSeededRng("same-seed");
  const second = createSeededRng("same-seed");
  const different = createSeededRng("other-seed");
  const firstSequence = Array.from({ length: 8 }, () => first.next());

  assert.deepEqual(firstSequence, Array.from({ length: 8 }, () => second.next()));
  assert.notDeepEqual(firstSequence, Array.from({ length: 8 }, () => different.next()));
  assert.equal(firstSequence.every((value) => value >= 0 && value < 1), true);

  const source = [1, 2, 3, 4, 5];
  const shuffledA = createSeededRng("shuffle").shuffle(source);
  const shuffledB = createSeededRng("shuffle").shuffle(source);
  assert.deepEqual(shuffledA, shuffledB);
  assert.deepEqual(source, [1, 2, 3, 4, 5]);
  assert.equal(normalizeSeed("  "), "prototype-001");
});
