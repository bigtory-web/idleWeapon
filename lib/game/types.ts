export const GRID_COLUMNS = 6 as const;
export const GRID_ROWS = 4 as const;

export type Tier = 1 | 2 | 3;
export type GamePhase =
  | "preparation"
  | "combat"
  | "shop"
  | "victory"
  | "defeat";

export type CharacterId = "shieldbearer" | "scout" | "sharpshooter";
export type WeaponId = "sword" | "bow" | "hammer" | "wand";
export type EnemyId = "grunt" | "runner" | "armored" | "thrower" | "boss";
export type ItemId = CharacterId | WeaponId;
export type ItemKind = "character" | "weapon";
export type Direction = "up" | "right" | "down" | "left";
export type Rotation = 0 | 90 | 180 | 270;

export interface GridPosition {
  row: number;
  col: number;
}

export interface FootprintCell {
  row: number;
  col: number;
}

export interface ConnectionSocket {
  cell: FootprintCell;
  direction: Direction;
}

interface ItemDefinitionBase {
  id: ItemId;
  kind: ItemKind;
  name: string;
  icon: string;
  color: string;
  description: string;
  shopPrice: number;
}

export interface CharacterDefinition extends ItemDefinitionBase {
  id: CharacterId;
  kind: "character";
  hp: number;
  moveSpeed: number;
  /** Seconds between spawns. */
  spawnCooldown: number;
  meleeDamageMultiplier: number;
  rangedDamageMultiplier: number;
  rangeMultiplier: number;
  squadCaps: Record<Tier, number>;
  /** Number of simultaneously equipped backpack weapons. */
  weaponSlots: Record<Tier, number>;
  /** Fixed backpack footprint. Characters cannot be rotated. */
  footprint: FootprintCell[];
}

export type WeaponAttackKind = "slash" | "projectile" | "smash" | "chain";

export interface EquipPenalty {
  /** Multiplied for every equipped weapon carrying this penalty. */
  hpMultiplier?: number;
  /** Multiplied for every equipped weapon carrying this penalty. */
  moveSpeedMultiplier?: number;
}

export interface WeaponDefinition extends ItemDefinitionBase {
  id: WeaponId;
  kind: "weapon";
  damage: number;
  /** Seconds between attacks. */
  cooldown: number;
  range: number;
  attackKind: WeaponAttackKind;
  maxTargets: number;
  ranged: boolean;
  secondaryDamageMultiplier?: number;
  effectRadius?: number;
  equipPenalty?: EquipPenalty;
  footprint: FootprintCell[];
  sockets: ConnectionSocket[];
}

export type ItemDefinition = CharacterDefinition | WeaponDefinition;

export interface EnemyDefinition {
  id: EnemyId;
  name: string;
  icon: string;
  color: string;
  hp: number;
  moveSpeed: number;
  damage: number;
  /** Seconds between attacks. */
  cooldown: number;
  range: number;
  armor?: number;
  isBoss?: boolean;
}

export interface GridItem {
  id: string;
  definitionId: ItemId;
  tier: Tier;
  /** Null is allowed while a pointer drag is in progress. */
  position: GridPosition | null;
  rotation?: Rotation;
  sourceLevel?: number;
}

/** A physical character-to-weapon contact, ordered by when it was created. */
export interface EquipmentLink {
  characterId: string;
  weaponId: string;
  connectedAt: number;
}

export interface PendingReward {
  id: string;
  definitionId: ItemId;
  tier: Tier;
  rotation?: Rotation;
  sourceLevel?: number;
}

export interface EquippedWeaponSnapshot {
  sourceItemId: string;
  weaponId: WeaponId;
  tier: Tier;
  direction: Direction;
}

export interface SpawnLoadoutSnapshot {
  characterId: CharacterId;
  characterTier: Tier;
  weapons: EquippedWeaponSnapshot[];
}

export interface SpawnerBlueprint {
  id: string;
  characterId: CharacterId;
  tier: Tier;
  row: number;
  col: number;
  maxActive: number;
  weapons: EquippedWeaponSnapshot[];
}

export interface WaveEnemyCount {
  enemyId: EnemyId;
  count: number;
}

export interface WaveGroup {
  /** Seconds from wave start. */
  at: number;
  enemies: WaveEnemyCount[];
}

export interface WaveDefinition {
  index: number;
  name: string;
  /** Seconds before the wave is lost to timeout. */
  timeLimit: number;
  clearGold: number;
  groups: WaveGroup[];
}

export interface WaveStartInput {
  waveIndex: number;
  seed: string;
  baseHp: number;
  spawners: SpawnerBlueprint[];
  wave: WaveDefinition;
}

export interface CombatWeaponView {
  definitionId: WeaponId;
  tier: Tier;
  direction: Direction;
  cooldownRatio: number;
  attackPulse: number;
}

export interface SpawnerStatusView {
  id: string;
  cooldownRemaining: number;
  cooldownDuration: number;
  progress: number;
  activeCount: number;
  maxActive: number;
  state: "full" | "cooling" | "ready";
}

export interface CombatUnitView {
  id: string;
  side: "ally" | "enemy";
  definitionId: CharacterId | EnemyId;
  name: string;
  tier: Tier;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  facing: -1 | 1;
  isBoss?: boolean;
  flash: number;
  spawnGlow: number;
  weapons?: CombatWeaponView[];
}

export interface ProjectileView {
  id: string;
  side: "ally" | "enemy";
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  targetX: number;
  targetY: number;
  kind: WeaponAttackKind | "enemy";
}

export interface CombatEffectView {
  id: string;
  kind: "spawn" | "hit" | "damage" | "slash" | "smash";
  x: number;
  y: number;
  life: number;
  maxLife: number;
  value?: number;
}

export interface CombatMetrics {
  elapsed: number;
  alliesSpawned: Record<string, number>;
  weaponDamage: Record<string, number>;
  enemiesDefeated: Record<string, number>;
  totalDamage: number;
  baseDamageTaken: number;
  peakAllies: number;
  peakEnemies: number;
  projectilesCreated: number;
}

export interface CombatHud {
  waveIndex: number;
  elapsed: number;
  timeLimit: number;
  baseHp: number;
  maxBaseHp: number;
  enemiesAlive: number;
  enemiesRemaining: number;
}

export type CombatSimulationPhase =
  | "idle"
  | "running"
  | "paused"
  | "cleared"
  | "defeat";

export interface CombatSnapshot {
  phase: CombatSimulationPhase;
  waveIndex: number;
  elapsed: number;
  timeLimit: number;
  baseHp: number;
  maxBaseHp: number;
  pausedReasons: string[];
  spawners: SpawnerStatusView[];
  allies: CombatUnitView[];
  enemies: CombatUnitView[];
  projectiles: ProjectileView[];
  effects: CombatEffectView[];
  metrics: CombatMetrics;
}

export type DefeatReason = "base-destroyed" | "timeout";

export type CombatEvent =
  | { type: "snapshot"; snapshot: CombatSnapshot }
  | { type: "hud"; hud: CombatHud }
  | { type: "ally-spawned"; spawnerId: string; weaponItemIds: string[] }
  | { type: "wave-cleared"; waveIndex: number; goldEarned: number; metrics: CombatMetrics }
  | {
      type: "defeat";
      reason: DefeatReason;
      waveIndex: number;
      metrics: CombatMetrics;
    };

export interface RunReportInventoryItem {
  id: string;
  definitionId: ItemId;
  tier: Tier;
  row: number | null;
  col: number | null;
  rotation?: Rotation;
  location: "grid" | "queue";
}

export interface RunReportRewardChoice {
  level: number;
  definitionId: ItemId;
  tier: Tier;
}

export interface RunReportV1 {
  version: 1;
  result: "victory" | "defeat";
  defeatReason?: DefeatReason;
  seed: string;
  combatTime: number;
  reachedWave: number;
  baseHp: number;
  playerLevel: number;
  characterSpawns: Record<string, number>;
  weaponDamage: Record<string, number>;
  rewardChoices: RunReportRewardChoice[];
  finalInventory: RunReportInventoryItem[];
  completedAt: string;
}

export interface ShopOffer {
  id: string;
  waveIndex: number;
  definitionId: ItemId;
  tier: 1;
  price: number;
  purchased: boolean;
}

export interface ShopPurchase {
  waveIndex: number;
  definitionId: ItemId;
  tier: Tier;
  price: number;
}

export interface RunReportV2 {
  version: 2;
  result: "victory" | "defeat";
  defeatReason?: DefeatReason;
  seed: string;
  combatTime: number;
  reachedWave: number;
  baseHp: number;
  goldEarned: number;
  goldSpent: number;
  goldRemaining: number;
  characterSpawns: Record<string, number>;
  weaponDamage: Record<string, number>;
  purchases: ShopPurchase[];
  finalInventory: RunReportInventoryItem[];
  completedAt: string;
}

export type RunReport = RunReportV1 | RunReportV2;
