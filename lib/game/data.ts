import type {
  CharacterDefinition,
  CharacterId,
  EnemyDefinition,
  EnemyId,
  GridItem,
  ItemDefinition,
  ItemId,
  Tier,
  WaveDefinition,
  WeaponDefinition,
  WeaponId,
} from "./types";

export const BASE_HP = 100;
export const DEFAULT_SEED = "prototype-001";
export const MAX_UNITS = 160;
export const MAX_PROJECTILES = 400;

/** Global enemy-only tuning: keep wave composition and behavior unchanged. */
export const ENEMY_HP_MULTIPLIER = 1.2;
export const ENEMY_DAMAGE_MULTIPLIER = 1.1;

function scaleEnemyHp(baseHp: number): number {
  return Math.round(baseHp * ENEMY_HP_MULTIPLIER);
}

function scaleEnemyDamage(baseDamage: number): number {
  return Math.round(baseDamage * ENEMY_DAMAGE_MULTIPLIER);
}

export const CHARACTER_HP_AND_POWER_MULTIPLIER: Record<Tier, number> = {
  1: 1,
  2: 1.6,
  3: 2.4,
};

export const CHARACTER_SPAWN_COOLDOWN_MULTIPLIER: Record<Tier, number> = {
  1: 1,
  2: 0.9,
  3: 0.8,
};

export const WEAPON_DAMAGE_MULTIPLIER: Record<Tier, number> = {
  1: 1,
  2: 1.7,
  3: 2.7,
};

export const UNARMED_ATTACK = {
  damage: 8,
  cooldown: 0.8,
  range: 22,
} as const;

export const CHARACTERS: Record<CharacterId, CharacterDefinition> = {
  shieldbearer: {
    id: "shieldbearer",
    kind: "character",
    name: "방패병",
    icon: "🛡️",
    color: "#f2b84b",
    shopPrice: 9,
    description: "튼튼한 전열. 근접 무기를 특히 잘 다룹니다.",
    hp: 180,
    moveSpeed: 34,
    spawnCooldown: 6,
    meleeDamageMultiplier: 1.25,
    rangedDamageMultiplier: 0.9,
    rangeMultiplier: 1,
    squadCaps: { 1: 2, 2: 3, 3: 5 },
    footprint: [{ row: 0, col: 0 }],
  },
  scout: {
    id: "scout",
    kind: "character",
    name: "척후병",
    icon: "🐾",
    color: "#65c97a",
    shopPrice: 7,
    description: "약하지만 빠르게 증원되는 기동형 일꾼입니다.",
    hp: 80,
    moveSpeed: 52,
    spawnCooldown: 3.8,
    meleeDamageMultiplier: 0.85,
    rangedDamageMultiplier: 0.85,
    rangeMultiplier: 1,
    squadCaps: { 1: 4, 2: 6, 3: 9 },
    footprint: [{ row: 0, col: 0 }],
  },
  sharpshooter: {
    id: "sharpshooter",
    kind: "character",
    name: "명사수",
    icon: "🎯",
    color: "#7dbdff",
    shopPrice: 8,
    description: "원거리 무기의 피해와 사거리를 크게 높입니다.",
    hp: 90,
    moveSpeed: 38,
    spawnCooldown: 5.2,
    meleeDamageMultiplier: 0.8,
    rangedDamageMultiplier: 1.3,
    rangeMultiplier: 1.3,
    squadCaps: { 1: 2, 2: 3, 3: 5 },
    footprint: [{ row: 0, col: 0 }],
  },
};

export const WEAPONS: Record<WeaponId, WeaponDefinition> = {
  sword: {
    id: "sword",
    kind: "weapon",
    name: "검",
    icon: "⚔️",
    color: "#87d9ff",
    shopPrice: 5,
    description: "가까운 적 둘을 한 번에 베어냅니다.",
    damage: 13,
    cooldown: 0.7,
    range: 28,
    attackKind: "slash",
    maxTargets: 2,
    ranged: false,
    equipPenalty: { moveSpeedMultiplier: 0.94 },
    footprint: [{ row: 0, col: 0 }, { row: 0, col: 1 }],
  },
  bow: {
    id: "bow",
    kind: "weapon",
    name: "활",
    icon: "🏹",
    color: "#f4c96b",
    shopPrice: 5,
    description: "멀리 있는 적 하나를 빠르게 저격합니다.",
    damage: 10,
    cooldown: 0.9,
    range: 180,
    attackKind: "projectile",
    maxTargets: 1,
    ranged: true,
    equipPenalty: { hpMultiplier: 0.9 },
    footprint: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }],
  },
  hammer: {
    id: "hammer",
    kind: "weapon",
    name: "망치",
    icon: "🔨",
    color: "#ff936f",
    shopPrice: 6,
    description: "좁은 범위의 적 넷을 강하게 내려칩니다.",
    damage: 24,
    cooldown: 1.4,
    range: 32,
    attackKind: "smash",
    maxTargets: 4,
    ranged: false,
    effectRadius: 40,
    armorPierce: 1,
    equipPenalty: { moveSpeedMultiplier: 0.86 },
    footprint: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 1, col: 1 }],
  },
  wand: {
    id: "wand",
    kind: "weapon",
    name: "마법봉",
    icon: "✨",
    color: "#d6a0ff",
    shopPrice: 6,
    description: "두 번째 적에게 65% 피해가 연쇄됩니다.",
    damage: 8,
    cooldown: 1,
    range: 150,
    attackKind: "chain",
    maxTargets: 2,
    ranged: true,
    secondaryDamageMultiplier: 0.65,
    equipPenalty: { hpMultiplier: 0.92 },
    footprint: [{ row: 0, col: 0 }, { row: 0, col: 1 }],
  },
};

export const ITEM_DEFINITIONS: Record<ItemId, ItemDefinition> = {
  ...CHARACTERS,
  ...WEAPONS,
};

/** Enemy stats are prototype tuning values; the requested compositions are fixed below. */
export const ENEMIES: Record<EnemyId, EnemyDefinition> = {
  grunt: {
    id: "grunt",
    name: "졸개",
    icon: "👺",
    color: "#90c46b",
    hp: scaleEnemyHp(45),
    moveSpeed: 22,
    damage: scaleEnemyDamage(7),
    cooldown: 1,
    range: 24,
  },
  runner: {
    id: "runner",
    name: "질주병",
    icon: "🦎",
    color: "#d9e36c",
    hp: scaleEnemyHp(30),
    moveSpeed: 42,
    damage: scaleEnemyDamage(5),
    cooldown: 0.7,
    range: 22,
    approachMoveMultiplier: 1.35,
  },
  armored: {
    id: "armored",
    name: "갑옷병",
    icon: "🪖",
    color: "#78988e",
    hp: scaleEnemyHp(110),
    moveSpeed: 16,
    damage: scaleEnemyDamage(12),
    cooldown: 1.3,
    range: 26,
    armor: 0.2,
  },
  thrower: {
    id: "thrower",
    name: "투척병",
    icon: "💀",
    color: "#b6a2dd",
    hp: scaleEnemyHp(55),
    moveSpeed: 19,
    damage: scaleEnemyDamage(8),
    cooldown: 1.4,
    range: 145,
    targetPriority: "lowest-max-hp",
  },
  boss: {
    id: "boss",
    name: "황혼의 대장",
    icon: "👹",
    color: "#e45a7a",
    hp: scaleEnemyHp(900),
    moveSpeed: 12,
    damage: scaleEnemyDamage(22),
    cooldown: 1.2,
    range: 38,
    armor: 0.1,
    isBoss: true,
    baseDamageMultiplier: 1.5,
  },
};

export const WAVE_DEFINITIONS: WaveDefinition[] = [
  {
    index: 1,
    name: "먼지바람의 전조",
    timeLimit: 60,
    clearGold: 8,
    groups: [
      { at: 0, enemies: [{ enemyId: "grunt", count: 5 }] },
      { at: 6, enemies: [{ enemyId: "grunt", count: 5 }] },
      { at: 12, enemies: [{ enemyId: "grunt", count: 4 }] },
      { at: 18, enemies: [{ enemyId: "grunt", count: 4 }] },
    ],
  },
  {
    index: 2,
    name: "빠른 발소리",
    timeLimit: 60,
    clearGold: 10,
    groups: [0, 7, 14, 21, 28].map((at) => ({
      at,
      enemies: [
        { enemyId: "grunt", count: 3 },
        { enemyId: "runner", count: 3 },
      ],
    })),
  },
  {
    index: 3,
    name: "철갑 행렬",
    timeLimit: 90,
    clearGold: 12,
    groups: [
      { at: 0, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "armored", count: 2 }] },
      { at: 8, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "armored", count: 2 }] },
      { at: 16, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "armored", count: 3 }] },
      { at: 24, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "armored", count: 2 }] },
      { at: 32, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "armored", count: 2 }] },
    ],
  },
  {
    index: 4,
    name: "쏟아지는 돌비",
    timeLimit: 90,
    clearGold: 14,
    groups: [
      { at: 0, enemies: [{ enemyId: "grunt", count: 4 }, { enemyId: "thrower", count: 1 }] },
      { at: 8, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "thrower", count: 3 }] },
      { at: 16, enemies: [{ enemyId: "grunt", count: 5 }, { enemyId: "thrower", count: 3 }] },
      { at: 24, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "thrower", count: 3 }] },
      { at: 32, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "thrower", count: 4 }] },
    ],
  },
  {
    index: 5,
    name: "황혼의 총공세",
    timeLimit: 90,
    clearGold: 16,
    groups: [
      { at: 0, enemies: [{ enemyId: "grunt", count: 6 }, { enemyId: "runner", count: 3 }] },
      { at: 7, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "runner", count: 3 }, { enemyId: "armored", count: 2 }] },
      { at: 14, enemies: [{ enemyId: "armored", count: 3 }, { enemyId: "thrower", count: 5 }] },
      { at: 21, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "runner", count: 3 }, { enemyId: "armored", count: 3 }] },
      { at: 28, enemies: [{ enemyId: "runner", count: 3 }, { enemyId: "armored", count: 3 }, { enemyId: "thrower", count: 3 }] },
      { at: 35, enemies: [{ enemyId: "armored", count: 1 }, { enemyId: "thrower", count: 4 }] },
    ],
  },
  {
    index: 6,
    name: "황혼의 대장",
    timeLimit: 120,
    clearGold: 0,
    groups: [
      { at: 0, enemies: [{ enemyId: "boss", count: 1 }, { enemyId: "grunt", count: 6 }] },
      { at: 8, enemies: [{ enemyId: "runner", count: 6 }] },
      { at: 16, enemies: [{ enemyId: "armored", count: 5 }] },
      { at: 24, enemies: [{ enemyId: "thrower", count: 5 }] },
      { at: 32, enemies: [{ enemyId: "grunt", count: 3 }, { enemyId: "runner", count: 3 }, { enemyId: "armored", count: 1 }, { enemyId: "thrower", count: 1 }] },
    ],
  },
];

/** Row/column values are zero-based. */
export const STARTING_INVENTORY: GridItem[] = [
  {
    id: "start-shieldbearer",
    definitionId: "shieldbearer",
    tier: 1,
    position: { row: 3, col: 2 },
  },
  {
    id: "start-sword",
    definitionId: "sword",
    tier: 1,
    position: { row: 3, col: 0 },
    rotation: 0,
  },
  {
    id: "start-scout",
    definitionId: "scout",
    tier: 1,
    position: { row: 1, col: 1 },
  },
  {
    id: "start-bow",
    definitionId: "bow",
    tier: 1,
    position: { row: 0, col: 0 },
    rotation: 90,
  },
];

export const REWARD_ITEM_IDS = Object.keys(ITEM_DEFINITIONS) as ItemId[];

export function isCharacterId(id: ItemId | string): id is CharacterId {
  return id in CHARACTERS;
}

export function isWeaponId(id: ItemId | string): id is WeaponId {
  return id in WEAPONS;
}

export function getItemDefinition(id: ItemId): ItemDefinition {
  return ITEM_DEFINITIONS[id];
}

export function getWaveDefinition(index: number): WaveDefinition | undefined {
  return WAVE_DEFINITIONS.find((wave) => wave.index === index);
}

export function getWaveEnemyTotal(wave: WaveDefinition): number {
  return wave.groups.reduce(
    (waveTotal, group) =>
      waveTotal + group.enemies.reduce((groupTotal, entry) => groupTotal + entry.count, 0),
    0,
  );
}
