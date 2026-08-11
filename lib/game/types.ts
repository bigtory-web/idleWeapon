export const INVENTORY_COLUMNS = 7 as const;
export const PLAYER_DEPLOY_COLUMNS = 7 as const;
export const BATTLEFIELD_COLUMNS = 7 as const;
export const STARTING_UNLOCKED_COLUMNS = 7 as const;
export const GRID_ROWS = 5 as const;

export type Tier = 1 | 2 | 3 | 4 | 5;
export type BattleSpeed = 0.5 | 1 | 2;
export type GamePhase =
  | "preparation"
  | "combat"
  | "shop"
  | "victory"
  | "defeat";

export type CharacterId = "shieldbearer" | "scout" | "sharpshooter";
export type WeaponId = "sword" | "bow" | "hammer" | "wand" | "shield" | "spellbook";
export type CombatRole = "guard" | "flanker" | "marksman";
export type EquipmentComboId =
  | "dual-blades" | "rapid-bow" | "earthshaker" | "overcharge" | "fortress" | "grand-grimoire"
  | "vanguard" | "arcane-aegis" | "spellblade" | "arcane-arrow" | "ironbreaker" | "archmage";
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
  combatRole: CombatRole;
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
  /** Tier-independent burden added to an attached character's spawn time. */
  equipmentCost: number;
  targetPolicy?: "nearest" | "lowest-hp" | "densest" | "best-chain";
  secondaryDamageMultiplier?: number;
  effectRadius?: number;
  equipPenalty?: EquipPenalty;
  /** Portion of enemy armour ignored by this weapon (0–1). */
  armorPierce?: number;
  footprint: FootprintCell[];
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
  /** Lets a ranged threat seek vulnerable workers instead of the front-most one. */
  targetPriority?: "nearest" | "lowest-max-hp";
  /** Pressure units accelerate only while closing the distance. */
  approachMoveMultiplier?: number;
  /** Siege enemies deal this multiplier when no worker is blocking the base. */
  baseDamageMultiplier?: number;
  isBoss?: boolean;
  isStructure?: boolean;
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
  equipmentCost: number;
  activeCombos?: EquipmentComboId[];
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
  characterId: CharacterId;
  tier: Tier;
  row: number;
  col: number;
  weapons: EquippedWeaponSnapshot[];
  equipmentCost: number;
  activeCombos: EquipmentComboId[];
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
  isStructure?: boolean;
  flash: number;
  spawnGlow: number;
  homeRow?: number;
  shield?: number;
  maxShield?: number;
  activeCombos?: EquipmentComboId[];
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
  kind: "spawn" | "hit" | "damage" | "slash" | "smash" | "barrier" | "combo";
  x: number;
  y: number;
  life: number;
  maxLife: number;
  value?: number;
  label?: string;
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
