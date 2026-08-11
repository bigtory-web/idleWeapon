import type {
  CombatEffectView,
  CombatSnapshot,
  CombatUnitView,
  ProjectileView,
} from "./types";
import { GRID_COLUMNS, GRID_ROWS } from "./types";
import { CHARACTERS } from "./data";
import { ALLY_DEPLOY_Y_MAX, ALLY_DEPLOY_Y_MIN, getAllyDeployPosition } from "./battle-layout";

export const BATTLEFIELD_WIDTH = 390;
export const BATTLEFIELD_HEIGHT = 360;

export interface BattleRenderOptions {
  width?: number;
  height?: number;
  reducedMotion?: boolean;
  showHealthBars?: boolean;
}

type Direction = "up" | "down" | "left" | "right";

interface WeaponViewLike {
  definitionId: string;
  tier: 1 | 2 | 3;
  direction: Direction;
  cooldownRatio: number;
  attackPulse: number;
}

interface UnitViewLike {
  id: string;
  side: "ally" | "enemy";
  definitionId: string;
  name: string;
  tier: 1 | 2 | 3;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  facing: -1 | 1;
  isBoss?: boolean;
  flash: number;
  spawnGlow: number;
  visualScale?: number;
  weapons?: WeaponViewLike[];
}

interface ProjectileViewLike {
  id: string;
  side: "ally" | "enemy";
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  targetX: number;
  targetY: number;
  kind: "slash" | "projectile" | "smash" | "chain" | "enemy";
}

interface EffectViewLike {
  id: string;
  kind: "spawn" | "hit" | "damage" | "slash" | "smash";
  x: number;
  y: number;
  life: number;
  maxLife: number;
  value?: number;
}

interface SpawnerViewLike {
  id: string;
  characterId: keyof typeof CHARACTERS;
  tier: 1 | 2 | 3;
  row: number;
  col: number;
  progress: number;
  state: "full" | "cooling" | "ready";
  weapons: Array<{
    sourceItemId: string;
    weaponId: string;
    tier: 1 | 2 | 3;
    direction: Direction;
  }>;
}

interface SnapshotLike {
  phase: "idle" | "running" | "paused" | "cleared" | "defeat";
  waveIndex: number;
  elapsed: number;
  timeLimit: number;
  baseHp: number;
  maxBaseHp: number;
  spawners: SpawnerViewLike[];
  allies: UnitViewLike[];
  enemies: UnitViewLike[];
  projectiles: ProjectileViewLike[];
  effects: EffectViewLike[];
}

const COLORS = {
  ink: "#24143f",
  deepSky: "#251850",
  violetSky: "#6747ad",
  lavender: "#ab78da",
  moon: "#ebd8ff",
  farGround: "#4d367f",
  nearGround: "#34215e",
  groundEdge: "#8a68ba",
  ally: "#3b5d8f",
  allyLight: "#7fd4ff",
  allySkin: "#ffd7a7",
  enemy: "#52634b",
  enemyLight: "#9bb879",
  enemySkin: "#b3c18d",
  boss: "#733b73",
  red: "#ff6b7d",
  gold: "#ffd45f",
  white: "#fff8ea",
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getSpawnArrivalProgress(spawnGlow: number): number {
  return clamp(1 - spawnGlow / 0.42, 0, 1);
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash);
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function ellipse(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  fill: string,
): void {
  context.fillStyle = fill;
  context.beginPath();
  context.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
  context.fill();
}

function line(
  context: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
  width: number,
): void {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(fromX, fromY);
  context.lineTo(toX, toY);
  context.stroke();
}

function normalizeSnapshot(snapshot: CombatSnapshot): SnapshotLike {
  const value = snapshot as unknown as SnapshotLike;
  return {
    phase: value.phase ?? "idle",
    waveIndex: value.waveIndex ?? 0,
    elapsed: value.elapsed ?? 0,
    timeLimit: value.timeLimit ?? 60,
    baseHp: value.baseHp ?? 100,
    maxBaseHp: value.maxBaseHp ?? 100,
    spawners: Array.isArray(value.spawners) ? value.spawners : [],
    allies: Array.isArray(value.allies) ? value.allies : [],
    enemies: Array.isArray(value.enemies) ? value.enemies : [],
    projectiles: Array.isArray(value.projectiles) ? value.projectiles : [],
    effects: Array.isArray(value.effects) ? value.effects : [],
  };
}

export interface ProjectedBattlePoint {
  x: number;
  y: number;
  depth: number;
  scale: number;
}

/** Visual-only 2.5D projection. Combat continues to use the original X axis. */
export function projectBattlePoint(x: number, y: number): ProjectedBattlePoint {
  const depth = clamp((y - ALLY_DEPLOY_Y_MIN) / (ALLY_DEPLOY_Y_MAX - ALLY_DEPLOY_Y_MIN), 0, 1);
  const perspective = 0.86 + depth * 0.14;
  return {
    x: BATTLEFIELD_WIDTH / 2 + (x - BATTLEFIELD_WIDTH / 2) * perspective,
    y: 152 + depth * 174,
    depth,
    scale: 0.55 + depth * 0.22,
  };
}

/**
 * Paint a complete combat frame. The renderer is stateless and does not mutate
 * either the canvas element or the simulation snapshot.
 */
export function renderBattle(
  context: CanvasRenderingContext2D,
  combatSnapshot: CombatSnapshot,
  options: BattleRenderOptions = {},
): void {
  const snapshot = normalizeSnapshot(combatSnapshot);
  const width = options.width ?? BATTLEFIELD_WIDTH;
  const height = options.height ?? BATTLEFIELD_HEIGHT;
  const scale = Math.min(context.canvas.width / width, context.canvas.height / height);
  if (!Number.isFinite(scale) || scale <= 0) return;
  const offsetX = (context.canvas.width - width * scale) / 2;
  const offsetY = (context.canvas.height - height * scale) / 2;

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  drawNightBattlefield(context, snapshot.elapsed, width, height);

  context.save();
  drawDeploymentGrid(context);
  for (const spawner of snapshot.spawners) drawSpawnerPlatform(context, spawner);
  drawBase(context, snapshot);
  const projectedEffects = snapshot.effects.map((effect) => {
    const point = projectBattlePoint(effect.x, effect.y);
    return { ...effect, x: point.x, y: point.y };
  });
  drawSpawnEffects(context, projectedEffects, height);

  const units = [...snapshot.allies, ...snapshot.enemies]
    .map((unit) => {
      const point = projectBattlePoint(unit.x, unit.y);
      return { ...unit, x: point.x, y: point.y, visualScale: point.scale };
    })
    .sort((left, right) => left.y - right.y || left.x - right.x);
  for (const unit of units) drawUnitShadow(context, unit);
  for (const unit of units) drawUnit(context, unit, snapshot.elapsed, options.showHealthBars ?? true);
  for (const projectile of snapshot.projectiles) {
    const point = projectBattlePoint(projectile.x, projectile.y);
    const previous = projectBattlePoint(projectile.prevX, projectile.prevY);
    const target = projectBattlePoint(projectile.targetX, projectile.targetY);
    drawProjectile(context, {
      ...projectile,
      x: point.x,
      y: point.y,
      prevX: previous.x,
      prevY: previous.y,
      targetX: target.x,
      targetY: target.y,
    });
  }
  const dense = units.length > 55;
  const visibleEffects = dense
    ? projectedEffects.filter((effect) => effect.kind !== "damage" || hashText(effect.id) % 3 === 0)
    : projectedEffects;
  drawForegroundEffects(context, visibleEffects, snapshot.elapsed);
  context.restore();

  if (snapshot.phase === "paused") drawPauseWash(context, width, height);
  context.restore();
}

export const renderCombat = renderBattle;

function drawNightBattlefield(
  context: CanvasRenderingContext2D,
  elapsed: number,
  width: number,
  height: number,
): void {
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, COLORS.deepSky);
  sky.addColorStop(0.52, COLORS.violetSky);
  sky.addColorStop(1, "#8060b6");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  ellipse(context, 326, 57, 25, 25, "rgba(235,216,255,.16)");
  ellipse(context, 326, 57, 18, 18, COLORS.moon);
  ellipse(context, 319, 51, 4, 3, "rgba(135,102,175,.28)");
  ellipse(context, 333, 62, 3, 4, "rgba(135,102,175,.22)");

  const stars = [
    [31, 48, 1], [67, 83, 0.8], [102, 39, 1.2], [139, 70, 0.7], [182, 27, 0.9],
    [218, 76, 1.1], [258, 35, 0.7], [291, 93, 0.9], [360, 34, 1.1], [374, 102, 0.7],
  ] as const;
  for (let index = 0; index < stars.length; index += 1) {
    const [x, y, size] = stars[index];
    const pulse = 0.55 + Math.sin(elapsed * 1.4 + index * 1.77) * 0.15;
    context.globalAlpha = pulse;
    ellipse(context, x, y, size, size, COLORS.white);
  }
  context.globalAlpha = 1;

  context.fillStyle = "#493578";
  context.beginPath();
  context.moveTo(0, 135);
  context.lineTo(38, 106);
  context.lineTo(74, 113);
  context.lineTo(109, 80);
  context.lineTo(151, 96);
  context.lineTo(186, 66);
  context.lineTo(226, 106);
  context.lineTo(271, 92);
  context.lineTo(310, 112);
  context.lineTo(351, 75);
  context.lineTo(width, 101);
  context.lineTo(width, 184);
  context.lineTo(0, 184);
  context.closePath();
  context.fill();

  context.fillStyle = COLORS.farGround;
  context.beginPath();
  context.moveTo(0, 171);
  context.quadraticCurveTo(59, 140, 119, 165);
  context.quadraticCurveTo(181, 185, 244, 150);
  context.quadraticCurveTo(314, 124, width, 162);
  context.lineTo(width, 314);
  context.lineTo(0, 314);
  context.closePath();
  context.fill();

  drawTree(context, 104, 159, 0.62);
  drawTree(context, 285, 143, 0.78);

  const ground = context.createLinearGradient(0, 165, 0, height);
  ground.addColorStop(0, "#60478e");
  ground.addColorStop(0.68, COLORS.nearGround);
  ground.addColorStop(1, "#21143b");
  context.fillStyle = ground;
  context.beginPath();
  context.moveTo(66, 122);
  context.lineTo(width - 66, 122);
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  context.fill();

  context.strokeStyle = "rgba(205,178,235,.16)";
  context.lineWidth = 1;
  for (let index = 0; index < 7; index += 1) {
    const ratio = index / 6;
    const y = 140 + ratio * 198;
    const halfWidth = 136 + ratio * 59;
    context.beginPath();
    context.moveTo(195 - halfWidth, y);
    context.lineTo(195 + halfWidth, y);
    context.stroke();
  }
  for (let index = -4; index <= 4; index += 1) {
    context.beginPath();
    context.moveTo(195 + index * 28, 122);
    context.lineTo(195 + index * 70, height);
    context.stroke();
  }

  ellipse(context, 172, 235, 8, 3, "rgba(214,185,238,.3)");
  ellipse(context, 315, 302, 12, 4, "rgba(21,12,42,.22)");
  ellipse(context, 89, 322, 9, 3, "rgba(21,12,42,.22)");
}

function drawTree(context: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.strokeStyle = "#2b1b56";
  context.lineWidth = 8;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(0, 19);
  context.lineTo(-1, -20);
  context.lineTo(-15, -34);
  context.moveTo(-1, -12);
  context.lineTo(16, -30);
  context.lineTo(22, -44);
  context.moveTo(-9, -27);
  context.lineTo(-25, -42);
  context.stroke();
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(16, -30);
  context.lineTo(31, -34);
  context.moveTo(-15, -34);
  context.lineTo(-12, -50);
  context.moveTo(-24, -42);
  context.lineTo(-35, -39);
  context.stroke();
  context.restore();
}

function drawDeploymentGrid(context: CanvasRenderingContext2D): void {
  context.save();
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLUMNS; col += 1) {
      const deploy = getAllyDeployPosition(row, col);
      const center = projectBattlePoint(deploy.x, deploy.y);
      const horizontalNeighbor = projectBattlePoint(
        getAllyDeployPosition(row, col < GRID_COLUMNS - 1 ? col + 1 : col - 1).x,
        getAllyDeployPosition(row, col < GRID_COLUMNS - 1 ? col + 1 : col - 1).y,
      );
      const verticalNeighbor = projectBattlePoint(
        getAllyDeployPosition(row < GRID_ROWS - 1 ? row + 1 : row - 1, col).x,
        getAllyDeployPosition(row < GRID_ROWS - 1 ? row + 1 : row - 1, col).y,
      );
      const tileWidth = Math.abs(horizontalNeighbor.x - center.x) * 0.82;
      const tileHeight = Math.abs(verticalNeighbor.y - center.y) * 0.78;
      context.fillStyle = (row + col) % 2 === 0 ? "rgba(99,225,213,.055)" : "rgba(231,215,255,.035)";
      context.strokeStyle = "rgba(116,226,216,.12)";
      context.lineWidth = 0.75;
      roundedRectPath(context, center.x - tileWidth / 2, center.y - tileHeight / 2, tileWidth, tileHeight, 2);
      context.fill();
      context.stroke();
    }
  }
  context.restore();
}

function drawBase(context: CanvasRenderingContext2D, snapshot: SnapshotLike): void {
  const ratio = clamp(snapshot.baseHp / Math.max(1, snapshot.maxBaseHp), 0, 1);
  const point = projectBattlePoint(29, 260);
  context.save();
  context.translate(point.x, point.y);
  context.scale(0.72, 0.72);
  ellipse(context, 0, 23, 26, 7, "rgba(15,8,31,.42)");

  context.fillStyle = "#30254a";
  context.strokeStyle = "#1b122e";
  context.lineWidth = 3;
  roundedRectPath(context, -18, -3, 35, 30, 4);
  context.fill();
  context.stroke();
  context.fillStyle = "#62517e";
  context.fillRect(-13, 4, 7, 10);
  context.fillRect(5, 4, 7, 10);

  context.shadowColor = "#76e8ff";
  context.shadowBlur = ratio > 0 ? 12 : 0;
  context.fillStyle = ratio > 0 ? "#8af0ff" : "#5a5570";
  context.strokeStyle = "#31214f";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, -35);
  context.lineTo(11, -15);
  context.lineTo(4, 2);
  context.lineTo(-8, -2);
  context.lineTo(-11, -20);
  context.closePath();
  context.fill();
  context.stroke();
  context.shadowBlur = 0;

  context.fillStyle = "rgba(21,13,37,.75)";
  roundedRectPath(context, -22, 33, 44, 7, 3.5);
  context.fill();
  if (ratio > 0) {
    context.fillStyle = ratio > 0.35 ? "#5ee3c0" : COLORS.red;
    roundedRectPath(context, -20, 35, 40 * ratio, 3, 1.5);
    context.fill();
  }
  context.restore();
}

function drawSpawnerPlatform(context: CanvasRenderingContext2D, spawner: SpawnerViewLike): void {
  const definition = CHARACTERS[spawner.characterId];
  if (!definition) return;
  const deploy = getAllyDeployPosition(spawner.row, spawner.col);
  const point = projectBattlePoint(deploy.x, deploy.y);
  const scale = point.scale * 1.05;
  context.save();
  context.translate(point.x, point.y);
  context.scale(scale, scale);
  ellipse(context, 0, 5, 18, 5, "rgba(12,7,26,.48)");
  context.fillStyle = "#302444";
  context.strokeStyle = definition.color;
  context.lineWidth = 2;
  roundedRectPath(context, -12, -3, 24, 9, 3);
  context.fill();
  context.stroke();
  context.fillStyle = "#4c3b67";
  roundedRectPath(context, -8, -15, 16, 13, 4);
  context.fill();
  context.stroke();
  context.font = '13px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(definition.icon, 0, -9);
  context.strokeStyle = spawner.state === "ready" ? "#fff0a1" : definition.color;
  context.globalAlpha = 0.8;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(0, 1, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(spawner.progress, 0, 1));
  context.stroke();
  context.restore();
}

function drawUnitShadow(context: CanvasRenderingContext2D, unit: UnitViewLike): void {
  const scale = (unit.isBoss ? 1.65 : 1) * (unit.visualScale ?? 0.6);
  ellipse(context, unit.x, unit.y + 3, 12 * scale, 3.6 * scale, "rgba(16,8,30,.32)");
}

function drawUnit(
  context: CanvasRenderingContext2D,
  unit: UnitViewLike,
  elapsed: number,
  showHealthBars: boolean,
): void {
  const seed = hashText(unit.id) % 1000;
  const visualScale = unit.visualScale ?? 0.6;
  const bob = Math.sin(elapsed * 7 + seed * 0.03) * 0.8 * visualScale;
  const scale = (unit.isBoss ? 1.45 : 1) * visualScale;
  const spawning = unit.side === "ally" && unit.spawnGlow > 0;
  const spawnProgress = spawning ? getSpawnArrivalProgress(unit.spawnGlow) : 1;
  context.save();
  context.translate(unit.x, unit.y + bob);
  const arrivalScale = spawning ? 0.68 + spawnProgress * 0.32 : 1;
  context.scale(unit.facing * scale * arrivalScale, scale * arrivalScale);
  context.globalAlpha = spawning ? 0.25 + spawnProgress * 0.75 : 1;
  const id = unit.definitionId.toLowerCase();
  if (/scout/.test(id)) {
    context.rotate(-0.06 * unit.facing);
    context.scale(0.92, 0.9);
  } else if (/sharpshooter|marksman|archer/.test(id)) {
    context.scale(0.9, 1.08);
  } else if (/shield|guardian|armored|boss/.test(id)) {
    context.scale(1.08, 1);
  }

  drawFactionOutline(context, unit);
  if (unit.side === "ally") drawAllyBody(context, unit);
  else drawEnemyBody(context, unit);

  if (unit.flash > 0) {
    context.globalCompositeOperation = "screen";
    context.globalAlpha = clamp(unit.flash / 0.09, 0, 0.78);
    ellipse(context, 0, -10, 13, 17, COLORS.white);
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
  }
  context.restore();

  if (unit.side === "ally" && unit.weapons) {
    for (let index = 0; index < unit.weapons.length; index += 1) {
      if (spawning) drawAbsorbingWeapon(context, unit, unit.weapons[index], index, spawnProgress);
      else drawFloatingWeapon(context, unit, unit.weapons[index], elapsed, index);
    }
  }

  if (showHealthBars && (unit.hp < unit.maxHp || unit.isBoss)) drawUnitHealth(context, unit);
}

function drawAbsorbingWeapon(
  context: CanvasRenderingContext2D,
  unit: UnitViewLike,
  weapon: WeaponViewLike,
  index: number,
  progress: number,
): void {
  const angle = (index / Math.max(1, unit.weapons?.length ?? 1)) * Math.PI * 2 - Math.PI / 2;
  const radius = (28 - progress * 24) * (unit.visualScale ?? 0.6) / 0.6;
  const x = unit.x + Math.cos(angle) * radius;
  const y = unit.y - 13 + Math.sin(angle) * radius * 0.55;
  const scale = (0.58 - progress * 0.3) * ((unit.visualScale ?? 0.6) / 0.6);
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.globalAlpha = 1 - progress * 0.72;
  context.shadowColor = weapon.tier === 3 ? "#ffd65c" : weapon.tier === 2 ? "#b78cff" : "#7ce5e2";
  context.shadowBlur = 8;
  drawWeaponGlyph(context, weapon.definitionId, unit.facing);
  context.restore();
}

function drawFactionOutline(context: CanvasRenderingContext2D, unit: UnitViewLike): void {
  context.save();
  context.strokeStyle = unit.side === "enemy" ? "#ff5d63" : "#57d9dc";
  context.lineWidth = unit.isBoss ? 7 : 5.5;
  context.lineJoin = "round";
  context.lineCap = "round";
  roundedRectPath(context, -9, -18, 18, 19, unit.isBoss ? 3 : 5);
  context.stroke();
  context.beginPath();
  context.ellipse(0, -22, 9, unit.isBoss ? 10 : 9, 0, 0, Math.PI * 2);
  context.stroke();
  const id = unit.definitionId.toLowerCase();
  if (/shield|guardian/.test(id)) {
    roundedRectPath(context, -18, -17, 11, 19, 4);
    context.stroke();
  }
  if (/throw|ranged/.test(id)) {
    context.beginPath();
    context.moveTo(-8, -13);
    context.lineTo(-15, -23);
    context.stroke();
  }
  context.restore();
}

function drawAllyBody(context: CanvasRenderingContext2D, unit: UnitViewLike): void {
  const id = unit.definitionId.toLowerCase();
  const isGuardian = /guardian|shield|tank|방패/.test(id);
  const isSharpshooter = /sharpshooter|marksman|archer|명사수/.test(id);

  line(context, -5, -1, -6, 4, COLORS.ink, 4);
  line(context, 5, -1, 6, 4, COLORS.ink, 4);
  context.fillStyle = isGuardian ? "#3e526e" : isSharpshooter ? "#72574a" : "#3e695d";
  context.strokeStyle = COLORS.ink;
  context.lineWidth = 2;
  roundedRectPath(context, -9, -18, 18, 19, 5);
  context.fill();
  context.stroke();

  ellipse(context, 0, -23, 9, 9, COLORS.allySkin);
  context.strokeStyle = COLORS.ink;
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = isSharpshooter ? "#584336" : "#303b58";
  context.beginPath();
  context.arc(0, -25, 9.5, Math.PI, Math.PI * 2);
  context.lineTo(8, -23);
  context.lineTo(-8, -23);
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = COLORS.ink;
  ellipse(context, 3.2, -22.5, 1.2, 1.5, COLORS.ink);
  line(context, -4, -12, 5, -12, isGuardian ? "#83a9ca" : "#8bd2ac", 2);

  if (isGuardian) {
    context.fillStyle = "#7194b6";
    context.strokeStyle = COLORS.ink;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(-13, -17);
    context.lineTo(-6, -14);
    context.lineTo(-7, -2);
    context.lineTo(-13, 2);
    context.lineTo(-18, -3);
    context.lineTo(-18, -13);
    context.closePath();
    context.fill();
    context.stroke();
  } else if (isSharpshooter) {
    context.fillStyle = "#d2a55a";
    context.beginPath();
    context.moveTo(-7, -32);
    context.lineTo(0, -39);
    context.lineTo(7, -32);
    context.closePath();
    context.fill();
    context.stroke();
  }

}

function drawEnemyBody(context: CanvasRenderingContext2D, unit: UnitViewLike): void {
  const id = unit.definitionId.toLowerCase();
  const armored = /armor|armoured|갑옷/.test(id);
  const runner = /runner|rush|질주/.test(id);
  const thrower = /throw|ranged|투척/.test(id);
  const boss = Boolean(unit.isBoss) || /boss|보스/.test(id);

  line(context, -4, 0, -6 - (runner ? 2 : 0), 4, COLORS.ink, boss ? 5 : 3.5);
  line(context, 4, 0, 6 + (runner ? 2 : 0), 4, COLORS.ink, boss ? 5 : 3.5);
  context.fillStyle = boss ? COLORS.boss : armored ? "#5e6670" : thrower ? "#645446" : COLORS.enemy;
  context.strokeStyle = COLORS.ink;
  context.lineWidth = 2;
  roundedRectPath(context, -9, -17, 18, 18, boss ? 3 : 5);
  context.fill();
  context.stroke();

  ellipse(context, 0, -22, 9, boss ? 10 : 8.5, boss ? "#b476a9" : COLORS.enemySkin);
  context.strokeStyle = COLORS.ink;
  context.stroke();
  ellipse(context, 3.4, -22, boss ? 1.8 : 1.3, boss ? 2 : 1.6, boss ? "#fff0a7" : COLORS.ink);

  if (armored || boss) {
    context.fillStyle = boss ? "#4a294f" : "#4c5360";
    context.beginPath();
    context.arc(0, -25, 9.5, Math.PI, Math.PI * 2);
    context.lineTo(9, -22);
    context.lineTo(-9, -22);
    context.closePath();
    context.fill();
    context.stroke();
  }
  if (thrower) {
    ellipse(context, -8, -13, 4, 4, "#a58661");
    line(context, -8, -14, -15, -23, "#695039", 2);
  }
  if (runner) {
    line(context, -6, -8, -13, -4, "#d6c684", 2);
  }
}

function drawFloatingWeapon(
  context: CanvasRenderingContext2D,
  unit: UnitViewLike,
  weapon: WeaponViewLike,
  elapsed: number,
  index: number,
): void {
  const offsets: Record<Direction, { x: number; y: number }> = {
    up: { x: 0, y: -49 },
    down: { x: 0, y: 12 },
    left: { x: -21, y: -16 },
    right: { x: 21, y: -16 },
  };
  const direction = offsets[weapon.direction] ? weapon.direction : "right";
  const offset = offsets[direction];
  const unitScale = unit.visualScale ?? 0.6;
  const bob = Math.sin(elapsed * 4.5 + hashText(unit.id) * 0.02 + index) * 2 * unitScale;
  const x = unit.x + offset.x * unitScale;
  const y = unit.y + offset.y * unitScale + bob;
  const attackPulse = clamp(weapon.attackPulse ?? 0, 0, 1);
  const glyphScale = (0.45 + attackPulse * 0.4) * (unitScale / 0.6);

  context.save();
  context.translate(x, y);
  context.scale(glyphScale, glyphScale);
  context.globalAlpha = 0.7 + attackPulse * 0.3;
  context.shadowColor = weapon.tier === 3 ? "#ffd65c" : weapon.tier === 2 ? "#b78cff" : "#7ce5e2";
  context.shadowBlur = weapon.tier * 2;
  drawWeaponGlyph(context, weapon.definitionId, unit.facing);
  context.shadowBlur = 0;
  context.globalAlpha = 1;
  context.restore();
}

function drawWeaponGlyph(context: CanvasRenderingContext2D, definitionId: string, facing: -1 | 1): void {
  const id = definitionId.toLowerCase();
  context.strokeStyle = COLORS.ink;
  context.fillStyle = "#d8e8ee";
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (/bow|활/.test(id)) {
    context.strokeStyle = "#d49b58";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(0, 0, 7, -Math.PI / 2, Math.PI / 2);
    context.stroke();
    line(context, 0, -7, 0, 7, "#f1ddbb", 1);
    line(context, -5 * facing, 0, 6 * facing, 0, COLORS.ink, 1.5);
    return;
  }
  if (/hammer|망치/.test(id)) {
    line(context, -4, 6, 3, -4, "#9c7151", 3);
    context.fillStyle = "#a9bac1";
    roundedRectPath(context, -2, -8, 11, 7, 2);
    context.fill();
    context.stroke();
    return;
  }
  if (/wand|magic|staff|마법/.test(id)) {
    line(context, -4, 7, 3, -4, "#c2955a", 2.5);
    context.fillStyle = "#cf89ff";
    context.beginPath();
    context.moveTo(3, -9);
    context.lineTo(7, -4);
    context.lineTo(3, 1);
    context.lineTo(-1, -4);
    context.closePath();
    context.fill();
    context.stroke();
    return;
  }

  context.save();
  context.rotate(facing > 0 ? Math.PI / 4 : -Math.PI / 4);
  context.fillStyle = "#d9f1f4";
  context.beginPath();
  context.moveTo(-2, 7);
  context.lineTo(-2, -7);
  context.lineTo(0, -11);
  context.lineTo(2, -7);
  context.lineTo(2, 7);
  context.closePath();
  context.fill();
  context.stroke();
  line(context, -5, 5, 5, 5, "#e6bc53", 2.5);
  line(context, 0, 6, 0, 10, "#9c6a48", 3);
  context.restore();
}

function drawUnitHealth(context: CanvasRenderingContext2D, unit: UnitViewLike): void {
  const scale = unit.visualScale ?? 0.6;
  const width = (unit.isBoss ? 38 : 22) * scale;
  const height = 4 * scale;
  const y = unit.y - (unit.isBoss ? 58 : 47) * scale;
  const ratio = clamp(unit.hp / Math.max(1, unit.maxHp), 0, 1);
  context.fillStyle = "rgba(22,11,37,.78)";
  roundedRectPath(context, unit.x - width / 2, y, width, height, height / 2);
  context.fill();
  if (ratio > 0) {
    context.fillStyle = ratio > 0.45 ? "#6ee0a1" : COLORS.red;
    const inset = scale;
    roundedRectPath(
      context,
      unit.x - width / 2 + inset,
      y + inset,
      Math.max(0, width - inset * 2) * ratio,
      Math.max(0, height - inset * 2),
      scale,
    );
    context.fill();
  }
}

function drawProjectile(context: CanvasRenderingContext2D, projectile: ProjectileViewLike): void {
  context.save();
  if (projectile.kind === "chain") {
    context.shadowColor = "#df8cff";
    context.shadowBlur = 9;
    ellipse(context, projectile.x, projectile.y, 3.5, 3.5, "#f0bdff");
    context.globalAlpha = 0.45;
    line(context, projectile.prevX, projectile.prevY, projectile.x, projectile.y, "#c36cf1", 3);
  } else if (projectile.kind === "enemy") {
    ellipse(context, projectile.x, projectile.y, 3.5, 3, "#baa27f");
    context.strokeStyle = COLORS.ink;
    context.lineWidth = 1.5;
    context.stroke();
  } else {
    const angle = Math.atan2(projectile.y - projectile.prevY, projectile.x - projectile.prevX);
    context.translate(projectile.x, projectile.y);
    context.rotate(angle);
    line(context, -7, 0, 5, 0, "#eed8ae", 1.7);
    context.fillStyle = "#d8eef1";
    context.beginPath();
    context.moveTo(7, 0);
    context.lineTo(3, -2.5);
    context.lineTo(3, 2.5);
    context.closePath();
    context.fill();
  }
  context.restore();
}

function drawSpawnEffects(
  context: CanvasRenderingContext2D,
  effects: EffectViewLike[],
  height: number,
): void {
  for (const effect of effects) {
    if (effect.kind !== "spawn") continue;
    const progress = 1 - clamp(effect.life / Math.max(effect.maxLife, 0.001), 0, 1);
    const alpha = Math.sin(progress * Math.PI) * 0.72;
    context.strokeStyle = `rgba(181,248,255,${alpha})`;
    context.lineWidth = 1.5;
    context.beginPath();
    context.ellipse(effect.x, Math.min(height, effect.y + 2), 8 + progress * 15, 3 + progress * 3, 0, 0, Math.PI * 2);
    context.stroke();
  }
}

function drawForegroundEffects(
  context: CanvasRenderingContext2D,
  effects: EffectViewLike[],
  elapsed: number,
): void {
  for (const effect of effects) {
    if (effect.kind === "spawn") continue;
    const ratio = clamp(effect.life / Math.max(effect.maxLife, 0.001), 0, 1);
    const progress = 1 - ratio;
    context.save();
    context.globalAlpha = ratio;

    if (effect.kind === "damage") {
      context.translate(effect.x, effect.y - progress * 15);
      context.font = "700 11px ui-rounded, system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.lineWidth = 3;
      context.strokeStyle = COLORS.ink;
      context.fillStyle = effect.value && effect.value >= 30 ? COLORS.gold : COLORS.white;
      const text = String(effect.value ?? 0);
      context.strokeText(text, 0, 0);
      context.fillText(text, 0, 0);
    } else if (effect.kind === "slash") {
      context.strokeStyle = "#e9fbff";
      context.lineWidth = 3;
      context.beginPath();
      context.arc(effect.x, effect.y, 14 + progress * 6, -1.4, 1.2);
      context.stroke();
    } else if (effect.kind === "smash") {
      context.strokeStyle = `rgba(255,213,111,${ratio})`;
      context.lineWidth = 2.5;
      context.beginPath();
      context.ellipse(effect.x, effect.y + 2, 8 + progress * 23, 3 + progress * 8, 0, 0, Math.PI * 2);
      context.stroke();
      for (let index = 0; index < 5; index += 1) {
        const angle = index * 1.26 + elapsed;
        ellipse(
          context,
          effect.x + Math.cos(angle) * progress * 18,
          effect.y + Math.sin(angle) * progress * 8,
          1.5,
          1.5,
          COLORS.gold,
        );
      }
    } else {
      context.translate(effect.x, effect.y);
      context.strokeStyle = COLORS.white;
      context.lineWidth = 2;
      for (let index = 0; index < 5; index += 1) {
        const angle = index * (Math.PI * 2 / 5) + hashText(effect.id) * 0.01;
        const inner = 3 + progress * 4;
        const outer = 8 + progress * 9;
        line(
          context,
          Math.cos(angle) * inner,
          Math.sin(angle) * inner,
          Math.cos(angle) * outer,
          Math.sin(angle) * outer,
          COLORS.white,
          2,
        );
      }
    }
    context.restore();
  }
}

function drawPauseWash(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.fillStyle = "rgba(30,16,56,.12)";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(255,255,255,.7)";
  roundedRectPath(context, width / 2 - 13, 46, 26, 22, 8);
  context.fill();
  context.fillStyle = COLORS.ink;
  context.fillRect(width / 2 - 5, 51, 3, 12);
  context.fillRect(width / 2 + 2, 51, 3, 12);
}

// Preserve canonical view types as part of the renderer's type surface.
export type { CombatEffectView, CombatUnitView, ProjectileView };
