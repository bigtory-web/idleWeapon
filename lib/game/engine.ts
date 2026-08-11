import {
  CHARACTERS as RAW_CHARACTERS,
  CHARACTER_HP_AND_POWER_MULTIPLIER,
  CHARACTER_SPAWN_COOLDOWN_MULTIPLIER,
  ENEMIES as RAW_ENEMIES,
  MAX_PROJECTILES,
  MAX_UNITS,
  UNARMED_ATTACK,
  WEAPONS as RAW_WEAPONS,
  WEAPON_DAMAGE_MULTIPLIER,
} from "./data";
import { getAllyDeployPosition } from "./battle-layout";
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
const ENEMY_SPAWN_X = 354;
const BASE_X = 29;
const UNIT_CAP = MAX_UNITS;
const PROJECTILE_CAP = MAX_PROJECTILES;
const FIXED_STEP = 1 / 60;
const SNAPSHOT_INTERVAL = 0.1;
export const ENEMY_SPAWN_INTERVAL = 0.15;

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
  maxTargets: number;
  ranged: boolean;
  secondaryDamageMultiplier?: number;
  effectRadius?: number;
  equipPenalty?: {
    hpMultiplier?: number;
    moveSpeedMultiplier?: number;
  };
  armorPierce?: number;
}

interface EnemyDefinitionLike {
  id: string;
  name: string;
  hp: number;
  moveSpeed: number;
  damage: number;
  cooldown: number;
  range: number;
  armor?: number;
  isBoss?: boolean;
  targetPriority?: "nearest" | "lowest-max-hp";
  approachMoveMultiplier?: number;
  baseDamageMultiplier?: number;
}

interface WeaponBlueprintLike {
  sourceItemId: string;
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
  maxActive?: number;
  weapons: WeaponBlueprintLike[];
}

interface SpawnGroupLike {
  at: number;
  enemies: Array<{ enemyId: string; count: number }>;
}

interface WaveDefinitionLike {
  index: number;
  timeLimit: number;
  clearGold: number;
  groups: SpawnGroupLike[];
}

interface WaveStartInputLike {
  waveIndex: number;
  seed: string;
  baseHp: number;
  spawners: SpawnerBlueprintLike[];
  wave: WaveDefinitionLike;
}

interface InternalWeapon {
  definitionId: string;
  tier: Tier;
  direction: Direction;
  cooldown: number;
  cooldownDuration: number;
  attackPulse: number;
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
  spawnerId: string;
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
  armor: number;
  isBoss: boolean;
  targetPriority: "nearest" | "lowest-max-hp";
  approachMoveMultiplier: number;
  baseDamageMultiplier: number;
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
  cooldownDuration: number;
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
  /** Optional deterministic cap override used by simulations and tests. */
  unitCap?: number;
}

export type CombatListener = (event: CombatEvent) => void;

const CHARACTERS = RAW_CHARACTERS as unknown as Record<string, CharacterDefinitionLike>;
const WEAPONS = RAW_WEAPONS as unknown as Record<string, WeaponDefinitionLike>;
const ENEMIES = RAW_ENEMIES as unknown as Record<string, EnemyDefinitionLike>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
  return weapon.ranged;
}

function normalizeStartInput(input: WaveStartInput): WaveStartInputLike {
  const value = input as unknown as WaveStartInputLike;
  return {
    waveIndex: Math.max(1, Math.round(finite(value.waveIndex, value.wave?.index ?? 1))),
    seed: String(value.seed || "prototype-001"),
    baseHp: clamp(finite(value.baseHp, 100), 0, 100),
    spawners: Array.isArray(value.spawners) ? value.spawners : [],
    wave: {
      index: Math.max(1, Math.round(finite(value.wave?.index, value.waveIndex || 1))),
      timeLimit: Math.max(1, finite(value.wave?.timeLimit, 60)),
      clearGold: Math.max(0, Math.round(finite(value.wave?.clearGold, 0))),
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
  private readonly unitCap: number;
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
  private clearGold = 0;
  private baseHp = 100;
  private maxBaseHp = 100;
  private groupCursor = 0;
  private enemyOrdinal = 0;
  private waveGroups: SpawnGroupLike[] = [];
  private pendingEnemies: PendingEnemy[] = [];
  private pendingBosses: PendingEnemy[] = [];
  private enemySpawnCooldown = 0;
  private spawners: InternalSpawner[] = [];
  private allies: AllyUnit[] = [];
  private enemies: EnemyUnit[] = [];
  private projectiles: InternalProjectile[] = [];
  private effects: InternalEffect[] = [];
  private metrics: InternalMetrics = this.emptyMetrics();

  constructor(options: CombatEngineOptions = {}) {
    this.maxFrameDelta = clamp(finite(options.maxFrameDelta ?? 0.25, 0.25), FIXED_STEP, 1);
    this.unitCap = Math.max(1, Math.round(finite(options.unitCap ?? UNIT_CAP, UNIT_CAP)));
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
    this.clearGold = normalized.wave.clearGold;
    this.baseHp = normalized.baseHp;
    this.maxBaseHp = 100;
    this.groupCursor = 0;
    this.enemyOrdinal = 0;
    this.waveGroups = [...normalized.wave.groups]
      .map((group) => ({
        at: Math.max(0, finite(group.at, 0)),
        enemies: Array.isArray(group.enemies) ? group.enemies : [],
      }))
      .sort((left, right) => left.at - right.at);
    this.pendingEnemies = [];
    this.pendingBosses = [];
    this.enemySpawnCooldown = 0;
    this.allies = [];
    this.enemies = [];
    this.projectiles = [];
    this.effects = [];
    this.metrics = this.emptyMetrics();
    this.spawners = normalized.spawners
      .filter((blueprint) => Boolean(CHARACTERS[blueprint.characterId]))
      .map((blueprint) => {
        const cooldownDuration = this.getSpawnerCooldown(blueprint);
        return { blueprint, cooldown: cooldownDuration, cooldownDuration };
      });

    this.queueWaveEnemies();
    this.tickEnemySpawns(0);
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
      pausedReasons: [...this.pauseReasons],
      spawners: this.spawners.map((spawner) => {
        const activeCount = this.activeCountForSpawner(spawner.blueprint.id);
        const maxActive = Math.max(1, Math.round(finite(spawner.blueprint.maxActive ?? 1, 1)));
        const full = activeCount >= maxActive;
        const progress = full ? 0 : spawner.cooldownDuration > 0
          ? clamp(1 - spawner.cooldown / spawner.cooldownDuration, 0, 1)
          : 1;
        return {
          id: spawner.blueprint.id,
          characterId: spawner.blueprint.characterId,
          tier: clamp(Math.round(spawner.blueprint.tier), 1, 3) as Tier,
          row: spawner.blueprint.row,
          col: spawner.blueprint.col,
          weapons: (spawner.blueprint.weapons ?? []).map((weapon) => ({ ...weapon })),
          cooldownRemaining: full ? spawner.cooldownDuration : Math.max(0, spawner.cooldown),
          cooldownDuration: spawner.cooldownDuration,
          progress,
          activeCount,
          maxActive,
          state: full ? "full" : progress >= 1 ? "ready" : "cooling",
        };
      }),
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
          attackPulse: weapon.attackPulse,
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
    this.pendingBosses = [];
    this.enemySpawnCooldown = 0;
    this.waveGroups = [];
    this.phase = "idle";
  }

  private simulate(dt: number): void {
    this.elapsed += dt;
    this.tickEffects(dt);
    this.tickEnemySpawns(dt);
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
      && this.pendingBosses.length === 0
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

  private queueWaveEnemies(): void {
    while (this.groupCursor < this.waveGroups.length) {
      const group = this.waveGroups[this.groupCursor];
      for (const entry of group.enemies) {
        const count = Math.max(0, Math.floor(finite(entry.count, 0)));
        for (let ordinal = 0; ordinal < count; ordinal += 1) {
          const pending = { enemyId: entry.enemyId, ordinal: this.enemyOrdinal++ };
          if (ENEMIES[entry.enemyId]?.isBoss) this.pendingBosses.push(pending);
          else this.pendingEnemies.push(pending);
        }
      }
      this.groupCursor += 1;
    }
  }

  private tickEnemySpawns(dt: number): void {
    this.enemySpawnCooldown = Math.max(0, this.enemySpawnCooldown - dt);
    if (this.pendingEnemies.length > 0) {
      if (this.enemySpawnCooldown > Number.EPSILON || this.unitCount() >= this.unitCap) return;
      const pending = this.pendingEnemies.shift();
      if (pending) this.spawnEnemy(pending.enemyId, pending.ordinal);
      this.enemySpawnCooldown = ENEMY_SPAWN_INTERVAL;
      return;
    }

    const livingNormalEnemy = this.enemies.some((enemy) => enemy.hp > 0 && !enemy.isBoss);
    if (livingNormalEnemy || this.pendingBosses.length === 0 || this.unitCount() >= this.unitCap) return;
    const boss = this.pendingBosses.shift();
    if (boss) {
      this.spawnEnemy(boss.enemyId, boss.ordinal);
      this.enemySpawnCooldown = ENEMY_SPAWN_INTERVAL;
    }
  }

  private tickSpawners(dt: number): void {
    for (const spawner of this.spawners) {
      const maxActive = Math.max(1, Math.round(finite(spawner.blueprint.maxActive ?? 1, 1)));
      if (this.activeCountForSpawner(spawner.blueprint.id) >= maxActive) {
        spawner.cooldown = spawner.cooldownDuration;
        continue;
      }
      spawner.cooldown -= dt;
      if (spawner.cooldown > 0) continue;
      if (this.unitCount() >= this.unitCap) {
        spawner.cooldown = 0;
        continue;
      }
      this.spawnAlly(spawner.blueprint);
      spawner.cooldown = spawner.cooldownDuration;
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
          .filter((enemy) => enemy.id !== target.id && enemy.hp > 0 && this.distanceBetween(enemy, target) <= 72)
          .sort((left, right) => this.distanceBetween(left, target) - this.distanceBetween(right, target))[0];
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
      for (const weapon of ally.weapons) {
        weapon.cooldown = Math.max(0, weapon.cooldown - dt);
        weapon.attackPulse = Math.max(0, weapon.attackPulse - dt / 0.12);
      }
      ally.fistCooldown = Math.max(0, ally.fistCooldown - dt);

      const target = this.closestEnemy(ally.x, ally.y);
      if (!target) continue;
      ally.facing = target.x >= ally.x ? 1 : -1;
      const approachRange = this.getApproachRange(ally);
      const distance = this.distanceBetween(ally, target);
      if (distance > approachRange) {
        const travel = Math.min(ally.moveSpeed * dt, Math.max(0, distance - approachRange));
        this.moveUnitToward(ally, target.x, target.y, travel);
      }

      if (ally.weapons.length === 0) {
        if (ally.fistCooldown <= 0 && this.distanceBetween(ally, target) <= UNARMED_ATTACK.range) {
          this.damageUnit(target, UNARMED_ATTACK.damage * CHARACTER_HP_AND_POWER_MULTIPLIER[ally.tier], "fist");
          ally.fistCooldown = UNARMED_ATTACK.cooldown;
          this.addEffect("hit", target.x, target.y - 8, 0.14);
        }
        continue;
      }

      for (const weapon of ally.weapons) {
        if (weapon.cooldown > 0) continue;
        const definition = WEAPONS[weapon.definitionId];
        if (!definition) continue;
        const effectiveRange = definition.range * (isRangedWeapon(definition) ? ally.rangeMultiplier : 1);
        const weaponTarget = this.closestEnemy(ally.x, ally.y, effectiveRange);
        if (!weaponTarget) continue;
        if (!this.attackWithWeapon(ally, weapon, definition, weaponTarget)) continue;
        weapon.cooldown = weapon.cooldownDuration;
        weapon.attackPulse = 1;
      }
    }
  }

  private tickEnemies(dt: number): void {
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0) continue;
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
      const target = enemy.targetPriority === "lowest-max-hp"
        ? this.lowestMaxHpAlly(enemy.x, enemy.y)
        : this.closestAlly(enemy.x, enemy.y);
      const targetX = target?.x ?? BASE_X;
      const targetY = target?.y ?? 269;
      const distance = Math.hypot(targetX - enemy.x, targetY - enemy.y);
      enemy.facing = targetX >= enemy.x ? 1 : -1;
      if (distance > enemy.range) {
        const travel = Math.min(enemy.moveSpeed * enemy.approachMoveMultiplier * dt, Math.max(0, distance - enemy.range));
        this.moveUnitToward(enemy, targetX, targetY, travel);
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
          targetY: target ? target.y - 8 : targetY,
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
        this.damageBase(enemy.damage * enemy.baseDamageMultiplier);
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
      * WEAPON_DAMAGE_MULTIPLIER[weapon.tier]
      * CHARACTER_HP_AND_POWER_MULTIPLIER[ally.tier]
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
        chainRatio: definition.attackKind === "chain" ? definition.secondaryDamageMultiplier ?? 0.65 : 0,
      });
      this.metrics.projectilesCreated += 1;
      return true;
    }

    if (definition.attackKind === "smash") {
      const targets = this.enemies
        .filter((enemy) => enemy.hp > 0 && this.distanceBetween(enemy, target) <= (definition.effectRadius ?? 40))
        .sort((left, right) => this.distanceBetween(left, target) - this.distanceBetween(right, target))
        .slice(0, definition.maxTargets);
      for (const enemy of targets) this.damageUnit(enemy, damage, definition.id, definition.armorPierce);
      this.addEffect("smash", target.x, target.y, 0.32);
      return true;
    }

    const targets = this.enemies
      .filter((enemy) => enemy.hp > 0 && this.distanceBetween(enemy, ally) <= definition.range)
      .sort((left, right) => this.distanceBetween(left, ally) - this.distanceBetween(right, ally))
      .slice(0, definition.maxTargets);
    if (targets.length === 0) return false;
    for (const enemy of targets) this.damageUnit(enemy, damage, definition.id, definition.armorPierce);
    this.addEffect("slash", target.x, target.y - 8, 0.2);
    return true;
  }

  private spawnAlly(blueprint: SpawnerBlueprintLike): void {
    const definition = CHARACTERS[blueprint.characterId];
    if (!definition) return;
    const tier = clamp(Math.round(blueprint.tier), 1, 3) as Tier;
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
          attackPulse: 0,
        } satisfies InternalWeapon;
      });
    const penalty = weapons.reduce((total, equipped) => {
      const weaponPenalty = WEAPONS[equipped.definitionId]?.equipPenalty;
      return {
        hpMultiplier: total.hpMultiplier * (weaponPenalty?.hpMultiplier ?? 1),
        moveSpeedMultiplier: total.moveSpeedMultiplier * (weaponPenalty?.moveSpeedMultiplier ?? 1),
      };
    }, { hpMultiplier: 1, moveSpeedMultiplier: 1 });
    const maxHp = definition.hp * CHARACTER_HP_AND_POWER_MULTIPLIER[tier] * penalty.hpMultiplier;
    const spawn = this.allySpawnPosition(blueprint.row, blueprint.col);
    this.allies.push({
      id: this.nextId("ally"),
      side: "ally",
      spawnerId: blueprint.id,
      definitionId: definition.id,
      name: definition.name,
      tier,
      x: spawn.x,
      y: spawn.y,
      hp: maxHp,
      maxHp,
      moveSpeed: definition.moveSpeed * penalty.moveSpeedMultiplier,
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
    this.addEffect("spawn", spawn.x, spawn.y, 0.45);
    this.emit({
      type: "ally-spawned",
      spawnerId: blueprint.id,
      weaponItemIds: blueprint.weapons.map((weapon) => weapon.sourceItemId),
    });
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
      armor: clamp(definition.armor ?? 0, 0, 0.95),
      isBoss: Boolean(definition.isBoss),
      targetPriority: definition.targetPriority ?? "nearest",
      approachMoveMultiplier: Math.max(1, definition.approachMoveMultiplier ?? 1),
      baseDamageMultiplier: Math.max(1, definition.baseDamageMultiplier ?? 1),
    });
    this.addEffect("spawn", ENEMY_SPAWN_X, y, 0.35);
  }

  private damageUnit(unit: BaseUnit, rawDamage: number, sourceDefinitionId: string, armorPierce = 0): void {
    if (unit.hp <= 0) return;
    const armor = unit.side === "enemy" ? Math.max(0, (unit as EnemyUnit).armor - armorPierce) : 0;
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
        this.addEffect("smash", enemy.x, enemy.y, enemy.isBoss ? 0.7 : 0.36);
      }
    }
    if (this.allies.some((ally) => ally.hp <= 0)) {
      const defeated = this.allies.filter((ally) => ally.hp <= 0);
      this.allies = this.allies.filter((ally) => ally.hp > 0);
      for (const ally of defeated) this.addEffect("smash", ally.x, ally.y, 0.3);
    }
  }

  private getApproachRange(ally: AllyUnit): number {
    if (ally.weapons.length === 0) return UNARMED_ATTACK.range;
    let shortest = Number.POSITIVE_INFINITY;
    for (const equipped of ally.weapons) {
      const definition = WEAPONS[equipped.definitionId];
      if (!definition) continue;
      const range = definition.range * (isRangedWeapon(definition) ? ally.rangeMultiplier : 1);
      shortest = Math.min(shortest, range);
    }
    return Number.isFinite(shortest) ? shortest : UNARMED_ATTACK.range;
  }

  private getSpawnerCooldown(blueprint: SpawnerBlueprintLike): number {
    const definition = CHARACTERS[blueprint.characterId];
    if (!definition) return Number.POSITIVE_INFINITY;
    const tier = clamp(Math.round(blueprint.tier), 1, 3) as Tier;
    return definition.spawnCooldown * CHARACTER_SPAWN_COOLDOWN_MULTIPLIER[tier];
  }

  private activeCountForSpawner(spawnerId: string): number {
    let count = 0;
    for (const ally of this.allies) if (ally.hp > 0 && ally.spawnerId === spawnerId) count += 1;
    return count;
  }

  private closestEnemy(originX: number, originY: number, maximumDistance = Number.POSITIVE_INFINITY): EnemyUnit | null {
    let result: EnemyUnit | null = null;
    let bestDistance = maximumDistance;
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0) continue;
      const distance = Math.hypot(enemy.x - originX, enemy.y - originY);
      if (distance <= bestDistance) {
        bestDistance = distance;
        result = enemy;
      }
    }
    return result;
  }

  private closestAlly(originX: number, originY: number): AllyUnit | null {
    let result: AllyUnit | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const ally of this.allies) {
      if (ally.hp <= 0) continue;
      const distance = Math.hypot(ally.x - originX, ally.y - originY);
      if (distance < bestDistance) {
        bestDistance = distance;
        result = ally;
      }
    }
    return result;
  }

  private lowestMaxHpAlly(originX: number, originY: number): AllyUnit | null {
    const living = this.allies.filter((ally) => ally.hp > 0);
    if (living.length === 0) return null;
    return living.sort((left, right) => left.maxHp - right.maxHp || this.distanceBetween(left, { x: originX, y: originY }) - this.distanceBetween(right, { x: originX, y: originY }))[0] ?? null;
  }

  private distanceBetween(left: Pick<BaseUnit, "x" | "y">, right: Pick<BaseUnit, "x" | "y">): number {
    return Math.hypot(right.x - left.x, right.y - left.y);
  }

  private moveUnitToward(unit: BaseUnit, targetX: number, targetY: number, travel: number): void {
    const dx = targetX - unit.x;
    const dy = targetY - unit.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0 || travel <= 0) return;
    const step = Math.min(travel, distance);
    unit.x += (dx / distance) * step;
    unit.y += (dy / distance) * step;
  }

  private findUnit(id: string): BaseUnit | null {
    return this.allies.find((unit) => unit.id === id)
      ?? this.enemies.find((unit) => unit.id === id)
      ?? null;
  }

  private allySpawnPosition(row: number, col: number): { x: number; y: number } {
    const position = getAllyDeployPosition(row, col);
    return {
      x: position.x + this.random.between(-3, 3),
      y: position.y + this.random.between(-3, 3),
    };
  }

  private enemyLane(ordinal: number): number {
    const lanes = [230, 240, 250, 260, 270, 280, 290];
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
      goldEarned: this.clearGold,
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
