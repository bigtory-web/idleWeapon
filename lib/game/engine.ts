import { CHARACTERS as RAW_CHARACTERS, ENEMIES as RAW_ENEMIES, WEAPONS as RAW_WEAPONS } from "./data";
import type {
  CombatEvent,
  CombatSnapshot,
  SpawnerBlueprint,
  WaveStartInput,
} from "./types";

/**
 * Engine-side structural expectations for data.ts/types.ts.
 *
 * The public API deliberately returns the canonical types from `types.ts`, while
 * the simulation normalizes the data records at this boundary. This keeps the
 * real-time core independent from React, Canvas, storage and deployment code.
 */

const LOGICAL_WIDTH = 390;
const ALLY_SPAWN_X = 62;
const ENEMY_SPAWN_X = 354;
const BASE_X = 29;
const UNIT_CAP = 160;
const PROJECTILE_CAP = 400;
const FIXED_STEP = 1 / 60;
const SNAPSHOT_INTERVAL = 0.1;
const XP_THRESHOLDS = [40, 55, 70, 90, 115, 150] as const;
const CHARACTER_TIER_MULTIPLIER = [1, 1.6, 2.4] as const;
const CHARACTER_COOLDOWN_MULTIPLIER = [1, 0.9, 0.8] as const;
const WEAPON_TIER_MULTIPLIER = [1, 1.7, 2.7] as const;

type Tier = 1 | 2 | 3;
type Direction = "up" | "down" | "left" | "right";
type Side = "ally" | "enemy";
type AttackKind = "slash" | "projectile" | "smash" | "chain";
type EnginePhase = "idle" | "running" | "paused" | "cleared" | "defeat";
type DefeatReason = "base-destroyed" | "timeout";

interface CharacterDefinitionLike {
  id: string;
  name: string;
  hp: number;
  moveSpeed: number;
  spawnCooldown: number;
  meleeDamageMultiplier?: number;
  rangedDamageMultiplier?: number;
  rangeMultiplier?: number;
}

interface WeaponDefinitionLike {
  id: string;
  name: string;
  damage: number;
  cooldown: number;
  range: number;
  attackKind: AttackKind;
}

interface EnemyDefinitionLike {
  id: string;
  name: string;
  hp: number;
  moveSpeed: number;
  damage: number;
  cooldown: number;
  range: number;
  xp: number;
  armor?: number;
  isBoss?: boolean;
}

interface WeaponBlueprintLike {
  weaponId: string;
  tier: Tier;
  direction: Direction;
}

interface SpawnerBlueprintLike {
  id: string;
  characterId: string;
  tier: Tier;
  row: number;
  col: number;
  weapons: WeaponBlueprintLike[];
}

interface SpawnGroupLike {
  at: number;
  enemies: Array<{ enemyId: string; count: number }>;
}

interface WaveDefinitionLike {
  index: number;
  timeLimit: number;
  groups: SpawnGroupLike[];
}

interface WaveStartInputLike {
  waveIndex: number;
  seed: string;
  baseHp: number;
  playerXp: number;
  playerLevel: number;
  spawners: SpawnerBlueprintLike[];
  wave: WaveDefinitionLike;
}

interface InternalWeapon {
  definitionId: string;
  tier: Tier;
  direction: Direction;
  cooldown: number;
  cooldownDuration: number;
}

interface BaseUnit {
  id: string;
  side: Side;
  definitionId: string;
  name: string;
  tier: Tier;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  moveSpeed: number;
  facing: -1 | 1;
  flash: number;
  spawnGlow: number;
}

interface AllyUnit extends BaseUnit {
  side: "ally";
  weapons: InternalWeapon[];
  fistCooldown: number;
  meleeDamageMultiplier: number;
  rangedDamageMultiplier: number;
  rangeMultiplier: number;
}

interface EnemyUnit extends BaseUnit {
  side: "enemy";
  damage: number;
  attackCooldown: number;
  cooldownDuration: number;
  range: number;
  xp: number;
  armor: number;
  isBoss: boolean;
}

interface InternalProjectile {
  id: string;
  side: Side;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  targetX: number;
  targetY: number;
  targetId: string | null;
  damage: number;
  speed: number;
  kind: "projectile" | "chain" | "enemy";
  sourceDefinitionId: string;
  chainRatio: number;
}

interface InternalEffect {
  id: string;
  kind: "spawn" | "hit" | "damage" | "slash" | "smash";
  x: number;
  y: number;
  life: number;
  maxLife: number;
  value?: number;
}

interface InternalSpawner {
  blueprint: SpawnerBlueprintLike;
  cooldown: number;
}

interface PendingEnemy {
  enemyId: string;
  ordinal: number;
}

interface InternalMetrics {
  alliesSpawned: Record<string, number>;
  weaponDamage: Record<string, number>;
  enemiesDefeated: Record<string, number>;
  totalDamage: number;
  baseDamageTaken: number;
  peakAllies: number;
  peakEnemies: number;
  projectilesCreated: number;
}

export interface CombatEngineOptions {
  /** Maximum amount of wall-clock time accepted by a single step call. */
  maxFrameDelta?: number;
}

export type CombatListener = (event: CombatEvent) => void;

const CHARACTERS = RAW_CHARACTERS as unknown as Record<string, CharacterDefinitionLike>;
const WEAPONS = RAW_WEAPONS as unknown as Record<string, WeaponDefinitionLike>;
const ENEMIES = RAW_ENEMIES as unknown as Record<string, EnemyDefinitionLike>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tierIndex(tier: Tier): 0 | 1 | 2 {
  return (clamp(Math.round(tier), 1, 3) - 1) as 0 | 1 | 2;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 0x6d2b79f5;
}

/** Tiny deterministic PRNG suitable for reproducible combat, not cryptography. */
class SeededRandom {
  private state: number;

  constructor(seed: string) {
    this.state = hashSeed(seed);
  }

  next(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

function isRangedWeapon(weapon: WeaponDefinitionLike): boolean {
  return weapon.attackKind === "projectile" || weapon.attackKind === "chain" || weapon.range > 70;
}

function normalizeStartInput(input: WaveStartInput): WaveStartInputLike {
  const value = input as unknown as WaveStartInputLike;
  return {
    waveIndex: Math.max(1, Math.round(finite(value.waveIndex, value.wave?.index ?? 1))),
    seed: String(value.seed || "prototype-001"),
    baseHp: clamp(finite(value.baseHp, 100), 0, 100),
    playerXp: Math.max(0, finite(value.playerXp, 0)),
    playerLevel: clamp(Math.round(finite(value.playerLevel, 1)), 1, 7),
    spawners: Array.isArray(value.spawners) ? value.spawners : [],
    wave: {
      index: Math.max(1, Math.round(finite(value.wave?.index, value.waveIndex || 1))),
      timeLimit: Math.max(1, finite(value.wave?.timeLimit, 60)),
      groups: Array.isArray(value.wave?.groups) ? value.wave.groups : [],
    },
  };
}

/**
 * Deterministic, DOM-free backpack auto-battle simulation.
 *
 * Call `step(dtSeconds)` from any scheduler. The engine internally advances at
 * 60 Hz, so rendering cadence does not alter outcomes.
 */
export class CombatEngine {
  private readonly listeners = new Set<CombatListener>();
  private readonly maxFrameDelta: number;
  private random = new SeededRandom("prototype-001");
  private disposed = false;
  private accumulator = 0;
  private snapshotClock = 0;
  private idCounter = 0;
  private phase: EnginePhase = "idle";
  private pauseReasons = new Set<string>();
  private defeatReason: DefeatReason | null = null;
  private waveIndex = 0;
  private elapsed = 0;
  private timeLimit = 60;
  private baseHp = 100;
  private maxBaseHp = 100;
  private playerXp = 0;
  private playerLevel = 1;
  private pendingLevelUps = 0;
  private groupCursor = 0;
  private enemyOrdinal = 0;
  private waveGroups: SpawnGroupLike[] = [];
  private pendingEnemies: PendingEnemy[] = [];
  private spawners: InternalSpawner[] = [];
  private allies: AllyUnit[] = [];
  private enemies: EnemyUnit[] = [];
  private projectiles: InternalProjectile[] = [];
  private effects: InternalEffect[] = [];
  private metrics: InternalMetrics = this.emptyMetrics();

  constructor(options: CombatEngineOptions = {}) {
    this.maxFrameDelta = clamp(finite(options.maxFrameDelta ?? 0.25, 0.25), FIXED_STEP, 1);
  }

  startWave(input: WaveStartInput): void {
    if (this.disposed) return;

    const normalized = normalizeStartInput(input);
    this.random = new SeededRandom(`${normalized.seed}:wave-${normalized.waveIndex}`);
    this.accumulator = 0;
    this.snapshotClock = 0;
    this.idCounter = 0;
    this.phase = "running";
    this.pauseReasons.clear();
    this.defeatReason = null;
    this.waveIndex = normalized.waveIndex;
    this.elapsed = 0;
    this.timeLimit = normalized.wave.timeLimit;
    this.baseHp = normalized.baseHp;
    this.maxBaseHp = 100;
    this.playerXp = normalized.playerXp;
    this.playerLevel = normalized.playerLevel;
    this.pendingLevelUps = 0;
    this.groupCursor = 0;
    this.enemyOrdinal = 0;
    this.waveGroups = [...normalized.wave.groups]
      .map((group) => ({
        at: Math.max(0, finite(group.at, 0)),
        enemies: Array.isArray(group.enemies) ? group.enemies : [],
      }))
      .sort((left, right) => left.at - right.at);
    this.pendingEnemies = [];
    this.allies = [];
    this.enemies = [];
    this.projectiles = [];
    this.effects = [];
    this.metrics = this.emptyMetrics();
    this.spawners = normalized.spawners
      .filter((blueprint) => Boolean(CHARACTERS[blueprint.characterId]))
      .map((blueprint) => ({ blueprint, cooldown: 0 }));

    // Every tile produces one unit immediately at wave start.
    for (const spawner of this.spawners) {
      if (this.unitCount() >= UNIT_CAP) break;
      this.spawnAlly(spawner.blueprint);
      spawner.cooldown = this.getSpawnerCooldown(spawner.blueprint);
    }

    this.scheduleEnemyGroups();
    this.flushPendingEnemies();
    this.updatePeaks();
    this.emitSnapshot(true);
  }

  step(dtSeconds: number): CombatSnapshot {
    if (this.disposed || this.phase !== "running" || this.pauseReasons.size > 0) {
      return this.getSnapshot();
    }

    const frameDelta = clamp(finite(dtSeconds, 0), 0, this.maxFrameDelta);
    this.accumulator += frameDelta;

    while (this.accumulator + Number.EPSILON >= FIXED_STEP && this.phase === "running") {
      this.simulate(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      this.snapshotClock += FIXED_STEP;
    }

    this.emitSnapshot(false);
    return this.getSnapshot();
  }

  pause(reason: string): void {
    if (this.disposed || this.phase === "idle" || this.phase === "cleared" || this.phase === "defeat") return;
    const normalizedReason = reason.trim() || "manual";
    this.pauseReasons.add(normalizedReason);
    this.phase = "paused";
    this.accumulator = 0;
    this.emitSnapshot(true);
  }

  resume(reason: string): void {
    if (this.disposed || this.phase !== "paused") return;
    const normalizedReason = reason.trim() || "manual";
    this.pauseReasons.delete(normalizedReason);
    if (normalizedReason === "level-up") this.pendingLevelUps = 0;
    if (this.pauseReasons.size === 0) {
      this.phase = "running";
      this.accumulator = 0;
    }
    this.emitSnapshot(true);
  }

  subscribe(listener: CombatListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener({ type: "snapshot", snapshot: this.getSnapshot() } as CombatEvent);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): CombatSnapshot {
    const snapshot = {
      phase: this.phase,
      waveIndex: this.waveIndex,
      elapsed: this.elapsed,
      timeLimit: this.timeLimit,
      baseHp: this.baseHp,
      maxBaseHp: this.maxBaseHp,
      playerXp: this.playerXp,
      playerLevel: this.playerLevel,
      pendingLevelUps: this.pendingLevelUps,
      pausedReasons: [...this.pauseReasons],
      allies: this.allies.map((unit) => ({
        id: unit.id,
        side: unit.side,
        definitionId: unit.definitionId,
        name: unit.name,
        tier: unit.tier,
        x: unit.x,
        y: unit.y,
        hp: Math.max(0, unit.hp),
        maxHp: unit.maxHp,
        facing: unit.facing,
        flash: unit.flash,
        spawnGlow: unit.spawnGlow,
        weapons: unit.weapons.map((weapon) => ({
          definitionId: weapon.definitionId,
          tier: weapon.tier,
          direction: weapon.direction,
          cooldownRatio: weapon.cooldownDuration > 0
            ? clamp(weapon.cooldown / weapon.cooldownDuration, 0, 1)
            : 0,
        })),
      })),
      enemies: this.enemies.map((unit) => ({
        id: unit.id,
        side: unit.side,
        definitionId: unit.definitionId,
        name: unit.name,
        tier: unit.tier,
        x: unit.x,
        y: unit.y,
        hp: Math.max(0, unit.hp),
        maxHp: unit.maxHp,
        facing: unit.facing,
        isBoss: unit.isBoss,
        flash: unit.flash,
        spawnGlow: unit.spawnGlow,
      })),
      projectiles: this.projectiles.map((projectile) => ({
        id: projectile.id,
        side: projectile.side,
        x: projectile.x,
        y: projectile.y,
        prevX: projectile.prevX,
        prevY: projectile.prevY,
        targetX: projectile.targetX,
        targetY: projectile.targetY,
        kind: projectile.kind,
      })),
      effects: this.effects.map((effect) => ({ ...effect })),
      metrics: this.getMetrics(),
    };

    return snapshot as unknown as CombatSnapshot;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.pauseReasons.clear();
    this.allies = [];
    this.enemies = [];
    this.projectiles = [];
    this.effects = [];
    this.spawners = [];
    this.pendingEnemies = [];
    this.waveGroups = [];
    this.phase = "idle";
  }

  private simulate(dt: number): void {
    this.elapsed += dt;
    this.tickEffects(dt);
    this.scheduleEnemyGroups();
    this.flushPendingEnemies();
    this.tickSpawners(dt);
    this.tickProjectiles(dt);
    this.removeDefeatedUnits();
    if (this.baseHp <= 0) {
      this.finishDefeat("base-destroyed");
      return;
    }
    if (this.phase !== "running") {
      this.updatePeaks();
      return;
    }
    this.tickAllies(dt);
    this.tickEnemies(dt);
    this.removeDefeatedUnits();
    this.updatePeaks();

    // Base destruction wins every terminal-state tie by being checked first.
    if (this.baseHp <= 0) {
      this.finishDefeat("base-destroyed");
      return;
    }
    if (this.elapsed >= this.timeLimit) {
      this.finishDefeat("timeout");
      return;
    }
    if (
      this.groupCursor >= this.waveGroups.length
      && this.pendingEnemies.length === 0
      && this.enemies.length === 0
    ) {
      this.finishClear();
    }
  }

  private tickEffects(dt: number): void {
    for (const ally of this.allies) {
      ally.flash = Math.max(0, ally.flash - dt);
      ally.spawnGlow = Math.max(0, ally.spawnGlow - dt);
    }
    for (const enemy of this.enemies) {
      enemy.flash = Math.max(0, enemy.flash - dt);
      enemy.spawnGlow = Math.max(0, enemy.spawnGlow - dt);
    }
    for (const effect of this.effects) effect.life -= dt;
    this.effects = this.effects.filter((effect) => effect.life > 0);
  }

  private scheduleEnemyGroups(): void {
    while (
      this.groupCursor < this.waveGroups.length
      && this.waveGroups[this.groupCursor].at <= this.elapsed + Number.EPSILON
    ) {
      const group = this.waveGroups[this.groupCursor];
      for (const entry of group.enemies) {
        const count = Math.max(0, Math.floor(finite(entry.count, 0)));
        for (let ordinal = 0; ordinal < count; ordinal += 1) {
          this.pendingEnemies.push({ enemyId: entry.enemyId, ordinal: this.enemyOrdinal++ });
        }
      }
      this.groupCursor += 1;
    }
  }

  private flushPendingEnemies(): void {
    while (this.pendingEnemies.length > 0 && this.unitCount() < UNIT_CAP) {
      const pending = this.pendingEnemies.shift();
      if (!pending) break;
      this.spawnEnemy(pending.enemyId, pending.ordinal);
    }
  }

  private tickSpawners(dt: number): void {
    for (const spawner of this.spawners) {
      spawner.cooldown -= dt;
      if (spawner.cooldown > 0) continue;
      if (this.unitCount() >= UNIT_CAP) {
        spawner.cooldown = 0;
        continue;
      }
      this.spawnAlly(spawner.blueprint);
      spawner.cooldown += this.getSpawnerCooldown(spawner.blueprint);
    }
  }

  private tickProjectiles(dt: number): void {
    const survivors: InternalProjectile[] = [];
    for (const projectile of this.projectiles) {
      projectile.prevX = projectile.x;
      projectile.prevY = projectile.y;
      const target = projectile.targetId ? this.findUnit(projectile.targetId) : null;
      if (target && target.hp > 0) {
        projectile.targetX = target.x;
        projectile.targetY = target.y - 9;
      } else if (projectile.side === "enemy" && projectile.targetId === null) {
        projectile.targetX = BASE_X;
        projectile.targetY = 269;
      }

      const dx = projectile.targetX - projectile.x;
      const dy = projectile.targetY - projectile.y;
      const distance = Math.hypot(dx, dy);
      const travel = projectile.speed * dt;
      if (distance <= travel + 3) {
        projectile.x = projectile.targetX;
        projectile.y = projectile.targetY;
        this.resolveProjectileHit(projectile, target);
        continue;
      }
      if (distance > 0) {
        projectile.x += (dx / distance) * travel;
        projectile.y += (dy / distance) * travel;
      }
      survivors.push(projectile);
    }
    this.projectiles = survivors;
  }

  private resolveProjectileHit(projectile: InternalProjectile, target: BaseUnit | null): void {
    if (target && target.hp > 0) {
      this.damageUnit(target, projectile.damage, projectile.sourceDefinitionId);
      if (projectile.chainRatio > 0 && target.side === "enemy") {
        const second = this.enemies
          .filter((enemy) => enemy.id !== target.id && enemy.hp > 0 && Math.abs(enemy.x - target.x) <= 72)
          .sort((left, right) => Math.abs(left.x - target.x) - Math.abs(right.x - target.x))[0];
        if (second) {
          this.damageUnit(second, projectile.damage * projectile.chainRatio, projectile.sourceDefinitionId);
          this.addEffect("hit", second.x, second.y - 12, 0.18);
        }
      }
    } else if (projectile.side === "enemy" && projectile.targetId === null) {
      this.damageBase(projectile.damage);
    }
    this.addEffect("hit", projectile.x, projectile.y, 0.2);
  }

  private tickAllies(dt: number): void {
    for (const ally of this.allies) {
      if (ally.hp <= 0) continue;
      for (const weapon of ally.weapons) weapon.cooldown = Math.max(0, weapon.cooldown - dt);
      ally.fistCooldown = Math.max(0, ally.fistCooldown - dt);

      const target = this.closestEnemy(ally.x);
      if (!target) continue;
      ally.facing = target.x >= ally.x ? 1 : -1;
      const approachRange = this.getApproachRange(ally);
      const distance = Math.abs(target.x - ally.x);
      if (distance > approachRange) {
        const travel = Math.min(ally.moveSpeed * dt, Math.max(0, distance - approachRange));
        ally.x += ally.facing * travel;
      }

      if (ally.weapons.length === 0) {
        if (ally.fistCooldown <= 0 && Math.abs(target.x - ally.x) <= 22) {
          this.damageUnit(target, 8 * CHARACTER_TIER_MULTIPLIER[tierIndex(ally.tier)], "fist");
          ally.fistCooldown = 0.8;
          this.addEffect("hit", target.x, target.y - 8, 0.14);
        }
        continue;
      }

      for (const weapon of ally.weapons) {
        if (weapon.cooldown > 0) continue;
        const definition = WEAPONS[weapon.definitionId];
        if (!definition) continue;
        const effectiveRange = definition.range * (isRangedWeapon(definition) ? ally.rangeMultiplier : 1);
        const weaponTarget = this.closestEnemy(ally.x, effectiveRange);
        if (!weaponTarget) continue;
        if (!this.attackWithWeapon(ally, weapon, definition, weaponTarget)) continue;
        weapon.cooldown = weapon.cooldownDuration;
      }
    }
  }

  private tickEnemies(dt: number): void {
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0) continue;
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
      const target = this.closestAlly(enemy.x);
      const targetX = target?.x ?? BASE_X;
      const distance = Math.abs(targetX - enemy.x);
      enemy.facing = targetX >= enemy.x ? 1 : -1;
      if (distance > enemy.range) {
        const travel = Math.min(enemy.moveSpeed * dt, Math.max(0, distance - enemy.range));
        enemy.x += enemy.facing * travel;
        continue;
      }
      if (enemy.attackCooldown > 0) continue;

      if (enemy.range > 65) {
        if (this.projectiles.length >= PROJECTILE_CAP) {
          enemy.attackCooldown = 0;
          continue;
        }
        this.projectiles.push({
          id: this.nextId("projectile"),
          side: "enemy",
          x: enemy.x + enemy.facing * 8,
          y: enemy.y - 12,
          prevX: enemy.x,
          prevY: enemy.y - 12,
          targetX,
          targetY: target ? target.y - 8 : 269,
          targetId: target?.id ?? null,
          damage: enemy.damage,
          speed: 210,
          kind: "enemy",
          sourceDefinitionId: enemy.definitionId,
          chainRatio: 0,
        });
        this.metrics.projectilesCreated += 1;
      } else if (target) {
        this.damageUnit(target, enemy.damage, enemy.definitionId);
        this.addEffect("hit", target.x, target.y - 8, 0.16);
      } else {
        this.damageBase(enemy.damage);
      }
      enemy.attackCooldown = enemy.cooldownDuration;
    }
  }

  private attackWithWeapon(
    ally: AllyUnit,
    weapon: InternalWeapon,
    definition: WeaponDefinitionLike,
    target: EnemyUnit,
  ): boolean {
    const ranged = isRangedWeapon(definition);
    const characterMultiplier = ranged ? ally.rangedDamageMultiplier : ally.meleeDamageMultiplier;
    const damage = definition.damage
      * WEAPON_TIER_MULTIPLIER[tierIndex(weapon.tier)]
      * CHARACTER_TIER_MULTIPLIER[tierIndex(ally.tier)]
      * characterMultiplier;

    if (definition.attackKind === "projectile" || definition.attackKind === "chain") {
      if (this.projectiles.length >= PROJECTILE_CAP) return false;
      this.projectiles.push({
        id: this.nextId("projectile"),
        side: "ally",
        x: ally.x + ally.facing * 10,
        y: ally.y - 13,
        prevX: ally.x,
        prevY: ally.y - 13,
        targetX: target.x,
        targetY: target.y - 9,
        targetId: target.id,
        damage,
        speed: definition.attackKind === "chain" ? 260 : 320,
        kind: definition.attackKind === "chain" ? "chain" : "projectile",
        sourceDefinitionId: definition.id,
        chainRatio: definition.attackKind === "chain" ? 0.65 : 0,
      });
      this.metrics.projectilesCreated += 1;
      return true;
    }

    if (definition.attackKind === "smash") {
      const targets = this.enemies
        .filter((enemy) => enemy.hp > 0 && Math.abs(enemy.x - target.x) <= 40)
        .sort((left, right) => Math.abs(left.x - target.x) - Math.abs(right.x - target.x))
        .slice(0, 4);
      for (const enemy of targets) this.damageUnit(enemy, damage, definition.id);
      this.addEffect("smash", target.x, target.y, 0.32);
      return true;
    }

    const targets = this.enemies
      .filter((enemy) => enemy.hp > 0 && Math.abs(enemy.x - ally.x) <= definition.range)
      .sort((left, right) => Math.abs(left.x - ally.x) - Math.abs(right.x - ally.x))
      .slice(0, 2);
    if (targets.length === 0) return false;
    for (const enemy of targets) this.damageUnit(enemy, damage, definition.id);
    this.addEffect("slash", target.x, target.y - 8, 0.2);
    return true;
  }

  private spawnAlly(blueprint: SpawnerBlueprintLike): void {
    const definition = CHARACTERS[blueprint.characterId];
    if (!definition) return;
    const tier = clamp(Math.round(blueprint.tier), 1, 3) as Tier;
    const maxHp = definition.hp * CHARACTER_TIER_MULTIPLIER[tierIndex(tier)];
    const weapons = (blueprint.weapons ?? [])
      .filter((entry) => Boolean(WEAPONS[entry.weaponId]))
      .map((entry) => {
        const weapon = WEAPONS[entry.weaponId];
        return {
          definitionId: entry.weaponId,
          tier: clamp(Math.round(entry.tier), 1, 3) as Tier,
          direction: entry.direction,
          cooldown: this.random.between(0, Math.min(0.15, weapon.cooldown * 0.2)),
          cooldownDuration: weapon.cooldown,
        } satisfies InternalWeapon;
      });
    const y = this.allyLane(blueprint.row, blueprint.col);
    this.allies.push({
      id: this.nextId("ally"),
      side: "ally",
      definitionId: definition.id,
      name: definition.name,
      tier,
      x: ALLY_SPAWN_X + this.random.between(-3, 3),
      y,
      hp: maxHp,
      maxHp,
      moveSpeed: definition.moveSpeed,
      facing: 1,
      flash: 0,
      spawnGlow: 0.42,
      weapons,
      fistCooldown: 0,
      meleeDamageMultiplier: definition.meleeDamageMultiplier ?? 1,
      rangedDamageMultiplier: definition.rangedDamageMultiplier ?? 1,
      rangeMultiplier: definition.rangeMultiplier ?? 1,
    });
    this.metrics.alliesSpawned[definition.id] = (this.metrics.alliesSpawned[definition.id] ?? 0) + 1;
    this.addEffect("spawn", ALLY_SPAWN_X, y, 0.45);
  }

  private spawnEnemy(enemyId: string, ordinal: number): void {
    const definition = ENEMIES[enemyId];
    if (!definition) return;
    const hpScale = 1 + Math.max(0, this.waveIndex - 1) * 0.035;
    const maxHp = definition.hp * hpScale;
    const y = this.enemyLane(ordinal);
    this.enemies.push({
      id: this.nextId("enemy"),
      side: "enemy",
      definitionId: definition.id,
      name: definition.name,
      tier: 1,
      x: ENEMY_SPAWN_X + this.random.between(-5, 5),
      y,
      hp: maxHp,
      maxHp,
      moveSpeed: definition.moveSpeed,
      facing: -1,
      flash: 0,
      spawnGlow: 0.3,
      damage: definition.damage,
      attackCooldown: this.random.between(0, Math.min(0.2, definition.cooldown * 0.2)),
      cooldownDuration: definition.cooldown,
      range: definition.range,
      xp: definition.xp,
      armor: clamp(definition.armor ?? 0, 0, 0.95),
      isBoss: Boolean(definition.isBoss),
    });
    this.addEffect("spawn", ENEMY_SPAWN_X, y, 0.35);
  }

  private damageUnit(unit: BaseUnit, rawDamage: number, sourceDefinitionId: string): void {
    if (unit.hp <= 0) return;
    const armor = unit.side === "enemy" ? (unit as EnemyUnit).armor : 0;
    const damage = Math.max(0, finite(rawDamage, 0)) * (1 - armor);
    unit.hp -= damage;
    unit.flash = 0.09;
    this.addEffect("damage", unit.x, unit.y - 20, 0.58, Math.max(1, Math.round(damage)));
    if (unit.side === "enemy") {
      this.metrics.weaponDamage[sourceDefinitionId] = (this.metrics.weaponDamage[sourceDefinitionId] ?? 0) + damage;
      this.metrics.totalDamage += damage;
    }
  }

  private damageBase(rawDamage: number): void {
    const damage = Math.max(0, finite(rawDamage, 0));
    this.baseHp = Math.max(0, this.baseHp - damage);
    this.metrics.baseDamageTaken += damage;
    this.addEffect("hit", BASE_X, 269, 0.24);
  }

  private removeDefeatedUnits(): void {
    if (this.enemies.some((enemy) => enemy.hp <= 0)) {
      const defeated = this.enemies.filter((enemy) => enemy.hp <= 0);
      this.enemies = this.enemies.filter((enemy) => enemy.hp > 0);
      for (const enemy of defeated) {
        this.metrics.enemiesDefeated[enemy.definitionId] = (this.metrics.enemiesDefeated[enemy.definitionId] ?? 0) + 1;
        this.gainXp(enemy.xp);
        this.addEffect("smash", enemy.x, enemy.y, enemy.isBoss ? 0.7 : 0.36);
      }
    }
    if (this.allies.some((ally) => ally.hp <= 0)) {
      const defeated = this.allies.filter((ally) => ally.hp <= 0);
      this.allies = this.allies.filter((ally) => ally.hp > 0);
      for (const ally of defeated) this.addEffect("smash", ally.x, ally.y, 0.3);
    }
  }

  private gainXp(amount: number): void {
    const gained = Math.max(0, Math.round(finite(amount, 0)));
    if (gained === 0) return;
    this.playerXp += gained;
    this.emit({ type: "xp-gained", amount: gained, total: this.playerXp });

    // The final wave intentionally locks the build and suppresses new choices.
    if (this.waveIndex >= 6) return;
    while (this.playerLevel < 7) {
      const threshold = XP_THRESHOLDS[this.playerLevel - 1];
      if (threshold === undefined || this.playerXp < threshold) break;
      this.playerXp -= threshold;
      this.playerLevel += 1;
      this.pendingLevelUps += 1;
      this.emit({
        type: "level-up",
        level: this.playerLevel,
        pendingLevelUps: this.pendingLevelUps,
      });
    }
    if (this.pendingLevelUps > 0) {
      this.pauseReasons.add("level-up");
      this.phase = "paused";
      this.accumulator = 0;
    }
  }

  private getApproachRange(ally: AllyUnit): number {
    if (ally.weapons.length === 0) return 22;
    let shortest = Number.POSITIVE_INFINITY;
    for (const equipped of ally.weapons) {
      const definition = WEAPONS[equipped.definitionId];
      if (!definition) continue;
      const range = definition.range * (isRangedWeapon(definition) ? ally.rangeMultiplier : 1);
      shortest = Math.min(shortest, range);
    }
    return Number.isFinite(shortest) ? shortest : 22;
  }

  private getSpawnerCooldown(blueprint: SpawnerBlueprintLike): number {
    const definition = CHARACTERS[blueprint.characterId];
    if (!definition) return Number.POSITIVE_INFINITY;
    const tier = clamp(Math.round(blueprint.tier), 1, 3) as Tier;
    return definition.spawnCooldown * CHARACTER_COOLDOWN_MULTIPLIER[tierIndex(tier)];
  }

  private closestEnemy(originX: number, maximumDistance = Number.POSITIVE_INFINITY): EnemyUnit | null {
    let result: EnemyUnit | null = null;
    let bestDistance = maximumDistance;
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0) continue;
      const distance = Math.abs(enemy.x - originX);
      if (distance <= bestDistance) {
        bestDistance = distance;
        result = enemy;
      }
    }
    return result;
  }

  private closestAlly(originX: number): AllyUnit | null {
    let result: AllyUnit | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const ally of this.allies) {
      if (ally.hp <= 0) continue;
      const distance = Math.abs(ally.x - originX);
      if (distance < bestDistance) {
        bestDistance = distance;
        result = ally;
      }
    }
    return result;
  }

  private findUnit(id: string): BaseUnit | null {
    return this.allies.find((unit) => unit.id === id)
      ?? this.enemies.find((unit) => unit.id === id)
      ?? null;
  }

  private allyLane(row: number, col: number): number {
    const deterministicOffset = ((Math.round(row) * 7 + Math.round(col) * 11) % 5) - 2;
    return 260 + deterministicOffset * 9 + this.random.between(-2.5, 2.5);
  }

  private enemyLane(ordinal: number): number {
    const lanes = [236, 249, 262, 275, 288];
    return lanes[ordinal % lanes.length] + this.random.between(-3, 3);
  }

  private addEffect(
    kind: InternalEffect["kind"],
    x: number,
    y: number,
    duration: number,
    value?: number,
  ): void {
    if (this.effects.length >= 220) this.effects.shift();
    this.effects.push({
      id: this.nextId("effect"),
      kind,
      x,
      y,
      life: duration,
      maxLife: duration,
      value,
    });
  }

  private finishClear(): void {
    if (this.phase === "cleared") return;
    this.phase = "cleared";
    this.pauseReasons.clear();
    this.projectiles = [];
    this.emit({
      type: "wave-cleared",
      waveIndex: this.waveIndex,
      metrics: this.getMetrics(),
    });
    this.emitSnapshot(true);
  }

  private finishDefeat(reason: DefeatReason): void {
    if (this.phase === "defeat") return;
    this.phase = "defeat";
    this.defeatReason = reason;
    this.pauseReasons.clear();
    this.emit({
      type: "defeat",
      reason,
      waveIndex: this.waveIndex,
      metrics: this.getMetrics(),
    });
    this.emitSnapshot(true);
  }

  private emitSnapshot(force: boolean): void {
    if (!force && this.snapshotClock < SNAPSHOT_INTERVAL) return;
    this.snapshotClock = 0;
    const snapshot = this.getSnapshot();
    this.emit({ type: "snapshot", snapshot });
    this.emit({
      type: "hud",
      hud: {
        waveIndex: this.waveIndex,
        elapsed: this.elapsed,
        timeLimit: this.timeLimit,
        baseHp: this.baseHp,
        maxBaseHp: this.maxBaseHp,
        playerXp: this.playerXp,
        playerLevel: this.playerLevel,
        nextLevelXp: XP_THRESHOLDS[this.playerLevel - 1] ?? null,
        pendingLevelUps: this.pendingLevelUps,
        enemiesAlive: this.enemies.length,
        enemiesRemaining: this.enemies.length + this.pendingEnemies.length + this.unscheduledEnemyCount(),
      },
    });
  }

  private emit(event: object): void {
    const canonicalEvent = event as CombatEvent;
    for (const listener of [...this.listeners]) listener(canonicalEvent);
  }

  private updatePeaks(): void {
    this.metrics.peakAllies = Math.max(this.metrics.peakAllies, this.allies.length);
    this.metrics.peakEnemies = Math.max(this.metrics.peakEnemies, this.enemies.length);
  }

  private getMetrics() {
    return {
      elapsed: this.elapsed,
      alliesSpawned: { ...this.metrics.alliesSpawned },
      weaponDamage: { ...this.metrics.weaponDamage },
      enemiesDefeated: { ...this.metrics.enemiesDefeated },
      totalDamage: this.metrics.totalDamage,
      baseDamageTaken: this.metrics.baseDamageTaken,
      peakAllies: this.metrics.peakAllies,
      peakEnemies: this.metrics.peakEnemies,
      projectilesCreated: this.metrics.projectilesCreated,
    };
  }

  private unscheduledEnemyCount(): number {
    let count = 0;
    for (let index = this.groupCursor; index < this.waveGroups.length; index += 1) {
      for (const entry of this.waveGroups[index].enemies) {
        count += Math.max(0, Math.floor(finite(entry.count, 0)));
      }
    }
    return count;
  }

  private unitCount(): number {
    return this.allies.length + this.enemies.length;
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.waveIndex}-${this.idCounter}`;
  }

  private emptyMetrics(): InternalMetrics {
    return {
      alliesSpawned: {},
      weaponDamage: {},
      enemiesDefeated: {},
      totalDamage: 0,
      baseDamageTaken: 0,
      peakAllies: 0,
      peakEnemies: 0,
      projectilesCreated: 0,
    };
  }
}

export function createCombatEngine(options?: CombatEngineOptions): CombatEngine {
  return new CombatEngine(options);
}

export const COMBAT_LIMITS = Object.freeze({
  logicalWidth: LOGICAL_WIDTH,
  fixedStep: FIXED_STEP,
  unitCap: UNIT_CAP,
  projectileCap: PROJECTILE_CAP,
});

// Keep the imported blueprint type reachable from generated API docs.
export type { SpawnerBlueprint };
