import type {
  CombatEffectView,
  CombatSnapshot,
  CombatUnitView,
  ProjectileView,
} from "./types";

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

interface SnapshotLike {
  phase: "idle" | "running" | "paused" | "cleared" | "defeat";
  waveIndex: number;
  elapsed: number;
  timeLimit: number;
  baseHp: number;
  maxBaseHp: number;
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
    allies: Array.isArray(value.allies) ? value.allies : [],
    enemies: Array.isArray(value.enemies) ? value.enemies : [],
    projectiles: Array.isArray(value.projectiles) ? value.projectiles : [],
    effects: Array.isArray(value.effects) ? value.effects : [],
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
  const scaleX = context.canvas.width / width;
  const scaleY = context.canvas.height / height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return;

  context.save();
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  context.clearRect(0, 0, width, height);
  drawNightBattlefield(context, snapshot.elapsed, width, height);

  const shake = getCameraShake(snapshot, Boolean(options.reducedMotion));
  context.save();
  context.translate(shake.x, shake.y);
  drawBase(context, snapshot);
  drawSpawnEffects(context, snapshot.effects, height);

  const units = [...snapshot.allies, ...snapshot.enemies]
    .sort((left, right) => left.y - right.y || left.x - right.x);
  for (const unit of units) drawUnitShadow(context, unit);
  for (const unit of units) drawUnit(context, unit, snapshot.elapsed, options.showHealthBars ?? true);
  for (const projectile of snapshot.projectiles) drawProjectile(context, projectile);
  drawForegroundEffects(context, snapshot.effects, snapshot.elapsed);
  context.restore();

  drawBattleHud(context, snapshot, width);
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
  context.moveTo(0, 171);
  context.lineTo(38, 142);
  context.lineTo(74, 149);
  context.lineTo(109, 116);
  context.lineTo(151, 132);
  context.lineTo(186, 102);
  context.lineTo(226, 142);
  context.lineTo(271, 128);
  context.lineTo(310, 148);
  context.lineTo(351, 111);
  context.lineTo(width, 137);
  context.lineTo(width, 226);
  context.lineTo(0, 226);
  context.closePath();
  context.fill();

  context.fillStyle = COLORS.farGround;
  context.beginPath();
  context.moveTo(0, 211);
  context.quadraticCurveTo(59, 180, 119, 205);
  context.quadraticCurveTo(181, 225, 244, 190);
  context.quadraticCurveTo(314, 164, width, 202);
  context.lineTo(width, 314);
  context.lineTo(0, 314);
  context.closePath();
  context.fill();

  drawTree(context, 104, 199, 0.7);
  drawTree(context, 285, 183, 0.9);

  const ground = context.createLinearGradient(0, 219, 0, height);
  ground.addColorStop(0, "#60478e");
  ground.addColorStop(0.72, COLORS.nearGround);
  ground.addColorStop(1, "#261743");
  context.fillStyle = ground;
  context.beginPath();
  context.moveTo(0, 224);
  context.quadraticCurveTo(105, 208, 195, 224);
  context.quadraticCurveTo(292, 240, width, 219);
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  context.fill();

  context.strokeStyle = "rgba(190,155,224,.18)";
  context.lineWidth = 1;
  for (let index = 0; index < 5; index += 1) {
    const y = 247 + index * 22;
    context.beginPath();
    context.moveTo(0, y);
    context.quadraticCurveTo(95, y - 8, 195, y + 1);
    context.quadraticCurveTo(292, y + 8, width, y - 2);
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

function drawBase(context: CanvasRenderingContext2D, snapshot: SnapshotLike): void {
  const ratio = clamp(snapshot.baseHp / Math.max(1, snapshot.maxBaseHp), 0, 1);
  context.save();
  context.translate(27, 270);
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

function drawUnitShadow(context: CanvasRenderingContext2D, unit: UnitViewLike): void {
  const scale = unit.isBoss ? 1.65 : 1;
  ellipse(context, unit.x, unit.y + 3, 12 * scale, 3.6 * scale, "rgba(16,8,30,.32)");
}

function drawUnit(
  context: CanvasRenderingContext2D,
  unit: UnitViewLike,
  elapsed: number,
  showHealthBars: boolean,
): void {
  const seed = hashText(unit.id) % 1000;
  const bob = Math.sin(elapsed * 7 + seed * 0.03) * 0.8;
  const scale = unit.isBoss ? 1.55 : 1;
  context.save();
  context.translate(unit.x, unit.y + bob);
  context.scale(unit.facing * scale, scale);

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
      drawFloatingWeapon(context, unit, unit.weapons[index], elapsed, index);
    }
  }

  if (showHealthBars && (unit.hp < unit.maxHp || unit.isBoss)) drawUnitHealth(context, unit);
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

  drawTierPips(context, unit.tier, 0, -40);
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

function drawTierPips(
  context: CanvasRenderingContext2D,
  tier: number,
  x: number,
  y: number,
): void {
  if (tier <= 1) return;
  context.save();
  context.fillStyle = COLORS.gold;
  context.strokeStyle = COLORS.ink;
  context.lineWidth = 1;
  for (let index = 0; index < tier; index += 1) {
    context.beginPath();
    context.arc(x + (index - (tier - 1) / 2) * 5, y, 2, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
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
  const pulse = Math.sin(elapsed * 4.5 + hashText(unit.id) * 0.02 + index) * 2;
  const x = unit.x + offset.x;
  const y = unit.y + offset.y + pulse;

  context.save();
  context.translate(x, y);
  context.globalAlpha = 0.62 + (1 - clamp(weapon.cooldownRatio, 0, 1)) * 0.38;
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
  const width = unit.isBoss ? 38 : 22;
  const y = unit.y - (unit.isBoss ? 58 : 47);
  const ratio = clamp(unit.hp / Math.max(1, unit.maxHp), 0, 1);
  context.fillStyle = "rgba(22,11,37,.78)";
  roundedRectPath(context, unit.x - width / 2, y, width, 4, 2);
  context.fill();
  if (ratio > 0) {
    context.fillStyle = ratio > 0.45 ? "#6ee0a1" : COLORS.red;
    roundedRectPath(context, unit.x - width / 2 + 1, y + 1, (width - 2) * ratio, 2, 1);
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
    const alpha = Math.sin(progress * Math.PI) * 0.5;
    const gradient = context.createLinearGradient(effect.x, 76, effect.x, effect.y + 6);
    gradient.addColorStop(0, "rgba(132,239,255,0)");
    gradient.addColorStop(0.35, `rgba(132,239,255,${alpha * 0.45})`);
    gradient.addColorStop(1, `rgba(218,252,255,${alpha})`);
    context.fillStyle = gradient;
    context.beginPath();
    context.moveTo(effect.x - 4 - progress * 3, 74);
    context.lineTo(effect.x + 4 + progress * 3, 74);
    context.lineTo(effect.x + 10, Math.min(height, effect.y + 5));
    context.lineTo(effect.x - 10, Math.min(height, effect.y + 5));
    context.closePath();
    context.fill();
    context.strokeStyle = `rgba(181,248,255,${alpha})`;
    context.lineWidth = 1.5;
    context.beginPath();
    context.ellipse(effect.x, effect.y + 2, 12 + progress * 6, 4, 0, 0, Math.PI * 2);
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

function drawBattleHud(context: CanvasRenderingContext2D, snapshot: SnapshotLike, width: number): void {
  context.save();
  context.fillStyle = "rgba(25,14,49,.68)";
  roundedRectPath(context, 10, 10, 85, 27, 10);
  context.fill();
  roundedRectPath(context, width - 103, 10, 93, 27, 10);
  context.fill();

  context.fillStyle = COLORS.white;
  context.font = "800 12px ui-rounded, system-ui, sans-serif";
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.fillText(`WAVE ${Math.max(1, snapshot.waveIndex)}/6`, 20, 23.5);

  const seconds = Math.max(0, Math.ceil(snapshot.timeLimit - snapshot.elapsed));
  context.textAlign = "right";
  context.fillText(`${seconds}초`, width - 20, 23.5);

  const progress = clamp(snapshot.elapsed / Math.max(1, snapshot.timeLimit), 0, 1);
  context.fillStyle = "rgba(20,11,36,.7)";
  roundedRectPath(context, 105, 17, width - 218, 12, 6);
  context.fill();
  if (progress > 0) {
    const gradient = context.createLinearGradient(107, 0, width - 115, 0);
    gradient.addColorStop(0, "#68d6ff");
    gradient.addColorStop(1, progress > 0.82 ? COLORS.red : "#b990ff");
    context.fillStyle = gradient;
    roundedRectPath(context, 107, 19, (width - 222) * progress, 8, 4);
    context.fill();
  }
  context.restore();
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

function getCameraShake(snapshot: SnapshotLike, reducedMotion: boolean): { x: number; y: number } {
  if (reducedMotion) return { x: 0, y: 0 };
  const impact = snapshot.effects.reduce((strongest, effect) => {
    if (effect.kind !== "smash" && effect.kind !== "hit") return strongest;
    return Math.max(strongest, clamp(effect.life / Math.max(effect.maxLife, 0.001), 0, 1));
  }, 0);
  if (impact <= 0) return { x: 0, y: 0 };
  return {
    x: Math.sin(snapshot.elapsed * 113) * 1.7 * impact,
    y: Math.cos(snapshot.elapsed * 149) * 1.1 * impact,
  };
}

// Preserve canonical view types as part of the renderer's type surface.
export type { CombatEffectView, CombatUnitView, ProjectileView };
