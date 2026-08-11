"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BASE_HP,
  DEFAULT_SEED,
  ITEM_DEFINITIONS,
  STARTING_INVENTORY,
  WAVE_DEFINITIONS,
  isCharacterId,
} from "@/lib/game/data";
import { CombatEngine } from "@/lib/game/engine";
import {
  autoMergeInventory,
  deriveSpawnerBlueprints,
  dropItemOnGrid,
  getActiveWeaponConnections,
  getCharactersSharingWeapon,
  getGridItemAt,
  getOccupiedCells,
  getRotatedItemGeometry,
  normalizeRotation,
  positionsEqual,
} from "@/lib/game/inventory";
import { renderBattle } from "@/lib/game/render";
import { getScaledFrameSteps, normalizeBattleSpeed } from "@/lib/game/speed";
import {
  canPurchaseShopOffer,
  generateShopOffers,
  purchaseShopOffer,
} from "@/lib/game/shop";
import {
  INVENTORY_COLUMNS,
  PLAYER_DEPLOY_COLUMNS,
  STARTING_UNLOCKED_COLUMNS,
  GRID_ROWS,
  type BattleSpeed,
  type CombatMetrics,
  type CombatSnapshot,
  type GamePhase,
  type GridItem,
  type GridPosition,
  type ItemDefinition,
  type RunReport,
  type RunReportV2,
  type ShopOffer,
  type ShopPurchase,
} from "@/lib/game/types";

type UiPhase = GamePhase | "transition";

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  sourceWidth: number;
  sourceHeight: number;
  moved: boolean;
  grabRow: number;
  grabCol: number;
}

interface Settings {
  muted: boolean;
  reducedMotion: boolean;
  battleSpeed: BattleSpeed;
}

interface HoverHelp {
  key: string;
  icon: string;
  title: string;
  description: string;
  detail?: string;
  sharingCount?: number;
}

interface ToastMessage {
  id: number;
  copy: string;
  tone: "success" | "warning" | "normal";
}

const SETTINGS_KEY = "worker-grower:settings:v1";
const REPORTS_KEY = "worker-grower:reports:v1";
const MAX_REPORTS = 10;

function cloneStartingInventory(): GridItem[] {
  return STARTING_INVENTORY.map((item) => ({
    ...item,
    position: item.position ? { ...item.position } : null,
  }));
}

function emptyMetrics(): CombatMetrics {
  return {
    elapsed: 0,
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

function createIdleSnapshot(baseHp = BASE_HP): CombatSnapshot {
  return {
    phase: "idle",
    waveIndex: 0,
    elapsed: 0,
    timeLimit: WAVE_DEFINITIONS[0]?.timeLimit ?? 60,
    baseHp,
    maxBaseHp: BASE_HP,
    pausedReasons: [],
    spawners: [],
    allies: [],
    enemies: [],
    projectiles: [],
    effects: [],
    metrics: emptyMetrics(),
  };
}

function addRecord(target: Record<string, number>, source: Record<string, number>) {
  const next = { ...target };
  for (const [key, value] of Object.entries(source)) next[key] = (next[key] ?? 0) + value;
  return next;
}

function addMetrics(total: CombatMetrics, wave: CombatMetrics): CombatMetrics {
  return {
    elapsed: total.elapsed + wave.elapsed,
    alliesSpawned: addRecord(total.alliesSpawned, wave.alliesSpawned),
    weaponDamage: addRecord(total.weaponDamage, wave.weaponDamage),
    enemiesDefeated: addRecord(total.enemiesDefeated, wave.enemiesDefeated),
    totalDamage: total.totalDamage + wave.totalDamage,
    baseDamageTaken: total.baseDamageTaken + wave.baseDamageTaken,
    peakAllies: Math.max(total.peakAllies, wave.peakAllies),
    peakEnemies: Math.max(total.peakEnemies, wave.peakEnemies),
    projectilesCreated: total.projectilesCreated + wave.projectilesCreated,
  };
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function itemStyle(definition: ItemDefinition, progress = 0): CSSProperties {
  return {
    "--item-color": definition.color,
    "--spawn-progress": `${Math.round(progress * 100)}%`,
  } as CSSProperties;
}

export default function GameClient() {
  const engineRef = useRef<CombatEngine>(new CombatEngine());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dropTargetRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<UiPhase>("preparation");
  const [waveCursor, setWaveCursor] = useState(0);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [gridItems, setGridItems] = useState<GridItem[]>(cloneStartingInventory);
  const [snapshot, setSnapshot] = useState<CombatSnapshot>(() => createIdleSnapshot());
  const [gold, setGold] = useState(0);
  const [goldEarned, setGoldEarned] = useState(0);
  const [goldSpent, setGoldSpent] = useState(0);
  const [shopOffers, setShopOffers] = useState<ShopOffer[]>([]);
  const [purchases, setPurchases] = useState<ShopPurchase[]>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  const [hoverHelp, setHoverHelp] = useState<HoverHelp | null>(null);
  const [manualPaused, setManualPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({ muted: false, reducedMotion: false, battleSpeed: 1 });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [report, setReport] = useState<RunReportV2 | null>(null);
  const [unlockedColumns, setUnlockedColumns] = useState<number>(STARTING_UNLOCKED_COLUMNS);

  const phaseRef = useRef(phase);
  const gridRef = useRef(gridItems);
  const seedRef = useRef(seed);
  const snapshotRef = useRef(snapshot);
  const goldRef = useRef(gold);
  const goldEarnedRef = useRef(goldEarned);
  const goldSpentRef = useRef(goldSpent);
  const purchasesRef = useRef(purchases);
  const totalsRef = useRef<CombatMetrics>(emptyMetrics());
  const settingsRef = useRef(settings);
  const unlockedColumnsRef = useRef<number>(STARTING_UNLOCKED_COLUMNS);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { gridRef.current = gridItems; }, [gridItems]);
  useEffect(() => { seedRef.current = seed; }, [seed]);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { goldRef.current = gold; }, [gold]);
  useEffect(() => { goldEarnedRef.current = goldEarned; }, [goldEarned]);
  useEffect(() => { goldSpentRef.current = goldSpent; }, [goldSpent]);
  useEffect(() => { purchasesRef.current = purchases; }, [purchases]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { unlockedColumnsRef.current = unlockedColumns; }, [unlockedColumns]);

  const changePhase = useCallback((next: UiPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const showToast = useCallback((copy: string, tone: ToastMessage["tone"] = "normal") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current.slice(-2), { id, copy, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 1900);
  }, []);

  const playTone = useCallback((frequency: number, duration = 0.09) => {
    if (settingsRef.current.muted || typeof window === "undefined") return;
    try {
      const audio = audioRef.current ?? new window.AudioContext();
      audioRef.current = audio;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.04, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + duration);
    } catch {
      // Sound is optional.
    }
  }, []);

  const commitInventory = useCallback((nextGridItems: GridItem[], autoMerge = true) => {
    const merged = autoMerge ? autoMergeInventory(nextGridItems, []) : { gridItems: nextGridItems, pendingRewards: [], merges: [] };
    gridRef.current = merged.gridItems;
    setGridItems(merged.gridItems);
    return merged;
  }, []);

  const finishRun = useCallback((result: "victory" | "defeat", reachedWave: number, defeatReason?: RunReportV2["defeatReason"]) => {
    const snap = engineRef.current.getSnapshot();
    const reportValue: RunReportV2 = {
      version: 2,
      result,
      defeatReason,
      seed: seedRef.current,
      combatTime: totalsRef.current.elapsed,
      reachedWave,
      baseHp: snap.baseHp,
      goldEarned: goldEarnedRef.current,
      goldSpent: goldSpentRef.current,
      goldRemaining: goldRef.current,
      characterSpawns: { ...totalsRef.current.alliesSpawned },
      weaponDamage: { ...totalsRef.current.weaponDamage },
      purchases: purchasesRef.current.map((purchase) => ({ ...purchase })),
      finalInventory: gridRef.current.map((item) => ({
        id: item.id,
        definitionId: item.definitionId,
        tier: item.tier,
        row: item.position?.row ?? null,
        col: item.position?.col ?? null,
        rotation: normalizeRotation(item.rotation),
        location: "grid" as const,
      })),
      completedAt: new Date().toISOString(),
    };
    setReport(reportValue);
    changePhase(result);
    try {
      const previous = JSON.parse(localStorage.getItem(REPORTS_KEY) ?? "[]") as RunReport[];
      localStorage.setItem(REPORTS_KEY, JSON.stringify([reportValue, ...previous].slice(0, MAX_REPORTS)));
    } catch {
      // Device-local history is optional.
    }
  }, [changePhase]);

  useEffect(() => {
    let hydrateTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
      const querySeed = new URLSearchParams(window.location.search).get("seed")?.trim();
      hydrateTimer = setTimeout(() => {
        if (stored) setSettings((current) => ({
          ...current,
          ...stored,
          battleSpeed: normalizeBattleSpeed(stored.battleSpeed),
        }));
        if (querySeed) {
          seedRef.current = querySeed;
          setSeed(querySeed);
        }
      }, 0);
    } catch {
      // Defaults are usable.
    }
    return () => { if (hydrateTimer) clearTimeout(hydrateTimer); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* optional */ }
  }, [settings]);

  useEffect(() => {
    const engine = engineRef.current;
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "snapshot") {
        snapshotRef.current = event.snapshot;
        setSnapshot(event.snapshot);
      } else if (event.type === "board-column-unlocked") {
        const nextColumns = Math.max(unlockedColumnsRef.current, event.column + 1);
        unlockedColumnsRef.current = nextColumns;
        setUnlockedColumns(nextColumns);
        showToast(`${event.column + 1}열이 해금됐어요!`, "success");
      } else if (event.type === "wave-cleared") {
        totalsRef.current = addMetrics(totalsRef.current, event.metrics);
        const snap = engine.getSnapshot();
        snapshotRef.current = snap;
        setSnapshot(snap);
        if (event.waveIndex >= WAVE_DEFINITIONS.length) {
          playTone(920, 0.26);
          finishRun("victory", event.waveIndex);
          return;
        }
        const nextGold = goldRef.current + event.goldEarned;
        goldRef.current = nextGold;
        goldEarnedRef.current += event.goldEarned;
        setGold(nextGold);
        setGoldEarned(goldEarnedRef.current);
        changePhase("transition");
        playTone(620, 0.14);
        transitionTimerRef.current = setTimeout(() => {
          commitInventory(gridRef.current);
          setWaveCursor(event.waveIndex);
          setShopOffers(generateShopOffers(seedRef.current, event.waveIndex));
          changePhase("shop");
          showToast(`웨이브 완료 · +${event.goldEarned} 골드`, "success");
        }, settingsRef.current.reducedMotion ? 0 : 600);
      } else if (event.type === "defeat") {
        totalsRef.current = addMetrics(totalsRef.current, event.metrics);
        playTone(160, 0.28);
        finishRun("defeat", event.waveIndex, event.reason);
      }
    });

    const onVisibility = () => {
      if (document.hidden) engine.pause("visibility");
      else engine.resume("visibility");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      const audio = audioRef.current;
      audioRef.current = null;
      if (audio && audio.state !== "closed") void audio.close().catch(() => undefined);
    };
  }, [changePhase, commitInventory, finishRun, playTone, showToast]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (!canvas) return;
    let animationFrame = 0;
    let previous = performance.now();
    const frame = (now: number) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      if (phaseRef.current === "combat") {
        for (const step of getScaledFrameSteps((now - previous) / 1000, settingsRef.current.battleSpeed)) {
          snapshotRef.current = engine.step(step);
        }
      }
      previous = now;
      const context = canvas.getContext("2d");
      if (context) {
        const liveSnapshot = snapshotRef.current;
        const renderSnapshot = phaseRef.current === "combat" ? liveSnapshot : {
          ...liveSnapshot,
          spawners: deriveSpawnerBlueprints(gridRef.current).map((blueprint) => ({
            id: blueprint.id,
            characterId: blueprint.characterId,
            tier: blueprint.tier,
            row: blueprint.row,
            col: blueprint.col,
            weapons: blueprint.weapons,
            cooldownRemaining: 0,
            cooldownDuration: 1,
            progress: 1,
            activeCount: 0,
            maxActive: blueprint.maxActive,
            state: "ready" as const,
          })),
        };
        renderBattle(context, renderSnapshot, { width: 390, height: 360, reducedMotion: settingsRef.current.reducedMotion });
      }
      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  const currentWave = WAVE_DEFINITIONS[waveCursor] ?? WAVE_DEFINITIONS.at(-1);
  const timeRemaining = phase === "combat"
    ? Math.max(0, snapshot.timeLimit - snapshot.elapsed)
    : currentWave?.timeLimit ?? 0;
  const inventoryLocked = phase === "combat" || phase === "transition";

  const resetRun = useCallback((nextSeed: string) => {
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    engineRef.current.resume("manual");
    const fresh = cloneStartingInventory();
    setSeed(nextSeed);
    seedRef.current = nextSeed;
    setGridItems(fresh);
    gridRef.current = fresh;
    setWaveCursor(0);
    setGold(0);
    goldRef.current = 0;
    setGoldEarned(0);
    goldEarnedRef.current = 0;
    setGoldSpent(0);
    goldSpentRef.current = 0;
    setPurchases([]);
    purchasesRef.current = [];
    setShopOffers([]);
    setPreviewItemId(null);
    setHoverHelp(null);
    setManualPaused(false);
    setReport(null);
    setUnlockedColumns(STARTING_UNLOCKED_COLUMNS);
    unlockedColumnsRef.current = STARTING_UNLOCKED_COLUMNS;
    totalsRef.current = emptyMetrics();
    const idle = createIdleSnapshot();
    setSnapshot(idle);
    snapshotRef.current = idle;
    changePhase("preparation");
    const url = new URL(window.location.href);
    url.searchParams.set("seed", nextSeed);
    window.history.replaceState({}, "", url);
  }, [changePhase]);

  const startWave = useCallback(() => {
    const wave = WAVE_DEFINITIONS[waveCursor];
    const spawners = deriveSpawnerBlueprints(gridRef.current);
    if (!wave || spawners.length === 0) {
      showToast("가방에 캐릭터를 한 명 이상 배치해 주세요.", "warning");
      return;
    }
    setShopOffers([]);
    setHoverHelp(null);
    changePhase("combat");
    setManualPaused(false);
    playTone(420, 0.08);
    engineRef.current.startWave({
      waveIndex: wave.index,
      seed: seedRef.current,
      baseHp: snapshotRef.current.baseHp,
      spawners,
      wave,
    });
  }, [changePhase, playTone, showToast, waveCursor]);

  const buyOffer = useCallback((offerId: string) => {
    const offer = shopOffers.find((entry) => entry.id === offerId);
    if (!offer) return;
    const result = purchaseShopOffer(gridRef.current, goldRef.current, offer, unlockedColumnsRef.current);
    if (!result.success) {
      showToast(result.reason === "not-enough-gold" ? "골드가 부족해요." : "가방에 넣을 자리가 없어요.", "warning");
      return;
    }
    commitInventory(result.gridItems, false);
    goldRef.current = result.gold;
    setGold(result.gold);
    goldSpentRef.current += offer.price;
    setGoldSpent(goldSpentRef.current);
    const purchase: ShopPurchase = {
      waveIndex: offer.waveIndex,
      definitionId: offer.definitionId,
      tier: offer.tier,
      price: offer.price,
    };
    purchasesRef.current = [...purchasesRef.current, purchase];
    setPurchases(purchasesRef.current);
    setShopOffers((current) => current.map((entry) => entry.id === offer.id ? { ...entry, purchased: true } : entry));
    playTone(690, 0.1);
    showToast(`${ITEM_DEFINITIONS[offer.definitionId].name} 구매 완료${result.merges ? ` · ${result.merges}회 합성` : ""}`, "success");
  }, [commitInventory, playTone, shopOffers, showToast]);

  const togglePause = useCallback(() => {
    if (phaseRef.current !== "combat") return;
    setManualPaused((paused) => {
      if (paused) engineRef.current.resume("manual");
      else engineRef.current.pause("manual");
      return !paused;
    });
  }, []);

  const applyInventory = useCallback((nextGridItems: GridItem[], message?: string) => {
    const merged = commitInventory(nextGridItems);
    if (message || merged.merges.length) showToast(message ?? `${merged.merges.length}회 자동 합성 완료!`, "success");
  }, [commitInventory, showToast]);

  const completeDrop = useCallback((itemId: string, target: string | null, grabRow = 0, grabCol = 0) => {
    if (!target || (phaseRef.current !== "preparation" && phaseRef.current !== "shop")) return;
    if (!target.startsWith("grid:")) return;
    const [, rowValue, colValue] = target.split(":");
    const result = dropItemOnGrid(
      { gridItems: gridRef.current, pendingRewards: [], unlockedColumns: unlockedColumnsRef.current },
      itemId,
      { row: Number(rowValue) - grabRow, col: Number(colValue) - grabCol },
    );
    if (result.success) {
      applyInventory(result.gridItems, result.action === "merged" ? "캐릭터 합성 완료!" : undefined);
    } else {
      showToast("그 위치에는 놓을 수 없어요.", "warning");
    }
  }, [applyInventory, showToast]);

  const pointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (phaseRef.current !== "preparation" && phaseRef.current !== "shop") {
      if (event.pointerType !== "mouse") setPreviewItemId((current) => current === id ? null : id);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const item = gridRef.current.find((entry) => entry.id === id);
    const geometry = item ? getRotatedItemGeometry(item.definitionId, normalizeRotation(item.rotation)) : { rows: 1, cols: 1 };
    const rect = event.currentTarget.getBoundingClientRect();
    const grabRow = Math.max(0, Math.min(geometry.rows - 1, Math.floor(((event.clientY - rect.top) / Math.max(1, rect.height)) * geometry.rows)));
    const grabCol = Math.max(0, Math.min(geometry.cols - 1, Math.floor(((event.clientX - rect.left) / Math.max(1, rect.width)) * geometry.cols)));
    const nextDrag = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      sourceWidth: rect.width,
      sourceHeight: rect.height,
      moved: false,
      grabRow,
      grabCol,
    };
    dragRef.current = nextDrag;
    dropTargetRef.current = null;
    setDrag(nextDrag);
    setDropTarget(null);
  }, []);

  const pointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5;
    const nextDrag = { ...current, x: event.clientX, y: event.clientY, moved };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
    if (moved) {
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-drop-target]");
      const nextTarget = element?.dataset.dropTarget ?? null;
      if (dropTargetRef.current !== nextTarget) {
        dropTargetRef.current = nextTarget;
        setDropTarget(nextTarget);
      }
    }
  }, []);

  const pointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.moved) {
      setPreviewItemId(null);
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-drop-target]");
      const finalTarget = element?.dataset.dropTarget ?? dropTargetRef.current;
      completeDrop(current.id, finalTarget, current.grabRow, current.grabCol);
    } else if (event.pointerType !== "mouse") {
      setPreviewItemId((selected) => selected === current.id ? null : current.id);
    }
    dragRef.current = null;
    dropTargetRef.current = null;
    setDrag(null);
    setDropTarget(null);
  }, [completeDrop]);

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    dropTargetRef.current = null;
    setDrag(null);
    setDropTarget(null);
    setPreviewItemId(null);
  }, []);

  const onItemKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, itemId: string) => {
    if (phaseRef.current !== "preparation" && phaseRef.current !== "shop") return;
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowDown: [1, 0], ArrowLeft: [0, -1],
    };
    const delta = arrows[event.key];
    if (!delta) return;
    event.preventDefault();
    const item = gridRef.current.find((entry) => entry.id === itemId);
    if (!item?.position) return;
    const result = dropItemOnGrid(
      { gridItems: gridRef.current, pendingRewards: [], unlockedColumns: unlockedColumnsRef.current },
      itemId,
      { row: item.position.row + delta[0], col: item.position.col + delta[1] },
    );
    if (result.success) applyInventory(result.gridItems, result.action === "merged" ? "캐릭터 합성 완료!" : undefined);
  }, [applyInventory]);

  const renderItem = (item: GridItem, options: { dragGhost?: boolean } = {}) => {
    const dragGhost = options.dragGhost ?? false;
    const definition = ITEM_DEFINITIONS[item.definitionId];
    const isCharacter = definition.kind === "character";
    const geometry = getRotatedItemGeometry(item.definitionId, normalizeRotation(item.rotation));
    const activeConnections = isCharacter ? getActiveWeaponConnections(item, gridItems) : [];
    const sharingCharacters = isCharacter ? [] : getCharactersSharingWeapon(item, gridItems);
    const spawner = snapshot.spawners.find((entry) => entry.id === item.id);
    const progress = phase === "combat" && isCharacter ? spawner?.progress ?? 0 : 0;
    const squadDetail = spawner ? ` · 분대 ${spawner.activeCount}/${spawner.maxActive}` : "";
    const activeRelationDetail = isCharacter
      ? `장착 무기: ${activeConnections.length ? activeConnections.map(({ item: weapon }) => ITEM_DEFINITIONS[weapon.definitionId].name).join(", ") : "맨손"}`
      : "인접 장착";
    const characterStats = isCharacter
      ? `HP ${definition.hp} · 이동 ${definition.moveSpeed} · 생성 ${definition.spawnCooldown.toFixed(1)}초`
      : "";
    const penaltyDetail = !isCharacter && definition.equipPenalty
      ? [
        definition.equipPenalty.hpMultiplier ? `체력 -${Math.round((1 - definition.equipPenalty.hpMultiplier) * 100)}%` : "",
        definition.equipPenalty.moveSpeedMultiplier ? `이동 -${Math.round((1 - definition.equipPenalty.moveSpeedMultiplier) * 100)}%` : "",
      ].filter(Boolean).join(" · ")
      : "";
    const itemHelp: HoverHelp = {
      key: `item:${item.id}`,
      icon: definition.icon,
      title: `${definition.name} · T${item.tier}`,
      description: definition.description,
      detail: [characterStats, penaltyDetail ? `장착 패널티: ${penaltyDetail}` : "", `${activeRelationDetail}${squadDetail}`].filter(Boolean).join(" · "),
      sharingCount: isCharacter ? undefined : sharingCharacters.length,
    };
    const showItemHelp = () => {
      setPreviewItemId(item.id);
      setHoverHelp(itemHelp);
    };
    const hideItemHelp = () => {
      setPreviewItemId((current) => current === item.id ? null : current);
      setHoverHelp((current) => current?.key === itemHelp.key ? null : current);
    };
    const layoutStyle = {
      ...itemStyle(definition, progress),
      "--item-cols": geometry.cols,
      "--item-rows": geometry.rows,
      "--item-width": `calc(var(--board-cell) * ${geometry.cols} + ${(geometry.cols - 1) * 4}px)`,
      "--item-height": `calc(var(--board-cell) * ${geometry.rows} + ${(geometry.rows - 1) * 4}px)`,
    } as CSSProperties;
    return (
      <button
        key={item.id}
        type="button"
        className={[
          "grid-item",
          `item-kind-${definition.kind}`,
          `shape-${item.definitionId}`,
          `rotation-${normalizeRotation(item.rotation)}`,
          `tier-${item.tier}`,
          !dragGhost && drag?.id === item.id ? "dragging" : "",
          !dragGhost && previewItemId === item.id ? "previewing" : "",
        ].filter(Boolean).join(" ")}
        style={layoutStyle}
        aria-label={`${definition.name} 티어 ${item.tier}. ${activeRelationDetail}${squadDetail}`}
        aria-describedby="fixed-hover-help"
        aria-disabled={inventoryLocked}
        aria-expanded={!dragGhost && previewItemId === item.id}
        aria-hidden={dragGhost || undefined}
        tabIndex={dragGhost ? -1 : undefined}
        onPointerDown={dragGhost ? undefined : (event) => pointerDown(event, item.id)}
        onPointerMove={dragGhost ? undefined : pointerMove}
        onPointerUp={dragGhost ? undefined : pointerUp}
        onPointerCancel={dragGhost ? undefined : cancelDrag}
        onMouseEnter={dragGhost ? undefined : showItemHelp}
        onMouseLeave={dragGhost ? undefined : hideItemHelp}
        onFocus={dragGhost ? undefined : showItemHelp}
        onBlur={dragGhost ? undefined : hideItemHelp}
        onKeyDown={dragGhost ? undefined : (event) => onItemKeyDown(event, item.id)}
      >
        <span className="item-card">
          <span className="footprint-surface" aria-hidden="true" />
          {geometry.cells.map((cell) => {
            const hasTop = geometry.cells.some((other) => other.row === cell.row - 1 && other.col === cell.col);
            const hasBottom = geometry.cells.some((other) => other.row === cell.row + 1 && other.col === cell.col);
            const hasLeft = geometry.cells.some((other) => other.row === cell.row && other.col === cell.col - 1);
            const hasRight = geometry.cells.some((other) => other.row === cell.row && other.col === cell.col + 1);
            return <span
              key={`${cell.row}:${cell.col}`}
              className={[
                "item-segment",
                !hasTop ? "edge-top" : "",
                !hasBottom ? "edge-bottom" : "",
                !hasLeft ? "edge-left" : "",
                !hasRight ? "edge-right" : "",
              ].filter(Boolean).join(" ")}
              style={{ gridRow: cell.row + 1, gridColumn: cell.col + 1 }}
              aria-hidden="true"
            >
              {hasRight && <span className={`segment-bridge bridge-right ${!hasTop ? "bridge-edge-top" : ""} ${!hasBottom ? "bridge-edge-bottom" : ""}`} />}
              {hasBottom && <span className={`segment-bridge bridge-down ${!hasLeft ? "bridge-edge-left" : ""} ${!hasRight ? "bridge-edge-right" : ""}`} />}
            </span>;
          })}
          {isCharacter && phase === "combat" && spawner?.state !== "full" && <span className="spawn-cooldown-fill" aria-hidden="true" />}
          <span className="item-icon">{definition.icon}</span>
          {isCharacter && <span className="character-name-mini" aria-hidden="true">{definition.name}</span>}
          {isCharacter && activeConnections.map(({ item: weapon }, index) => <span key={weapon.id} className={`equipped-weapon-mini equipped-weapon-mini-${index}`} aria-hidden="true">{ITEM_DEFINITIONS[weapon.definitionId].icon}</span>)}
        </span>
      </button>
    );
  };

  const copyReport = async () => {
    if (!report) return;
    const text = "";
    try {
      await navigator.clipboard.writeText(text);
      showToast("결과를 클립보드에 복사했어요.", "success");
    } catch {
      void text;
    }
  };

  const dropPreview = (() => {
    if (!drag?.moved || !dropTarget?.startsWith("grid:")) return null;
    const [, rowValue, colValue] = dropTarget.split(":");
    const position = { row: Number(rowValue) - drag.grabRow, col: Number(colValue) - drag.grabCol };
    const item = gridItems.find((entry) => entry.id === drag.id);
    if (!item) return null;
    const result = dropItemOnGrid({ gridItems, pendingRewards: [], unlockedColumns }, item.id, position);
    return { cells: getOccupiedCells(item, position), valid: result.success };
  })();

  return (
    <main className={`game-stage ${settings.reducedMotion ? "reduced-motion" : ""}`}>
      <section className="game-shell" aria-label="일꾼 키우기 전투 게임">
        <header className="top-chrome">
          <div className="header-combat-info">
            <div><span>웨이브</span><strong>{currentWave?.index ?? 6}/6</strong></div>
            <div><span>{phase === "combat" ? "남은 시간" : "제한 시간"}</span><strong className={timeRemaining < 10 && phase === "combat" ? "danger" : ""}>{formatTime(timeRemaining)}</strong></div>
          </div>
          <div className="top-actions">
            <div className="speed-controls" role="group" aria-label="전투 배속">
              {([0.5, 1, 2] as const).map((speed) => <button
                key={speed}
                type="button"
                className={settings.battleSpeed === speed ? "active" : ""}
                aria-pressed={settings.battleSpeed === speed}
                onClick={() => setSettings((current) => ({ ...current, battleSpeed: speed }))}
              >{speed}×</button>)}
            </div>
            <button type="button" className="icon-button" aria-label="게임 설정" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>⚙</button>
          </div>
          {settingsOpen && <div className="settings-popover">
            <h2 className="settings-title">게임 설정</h2>
            <button type="button" className="settings-option" aria-pressed={!settings.muted} onClick={() => setSettings((current) => ({ ...current, muted: !current.muted }))}><span>효과음</span><span className={`toggle-track ${!settings.muted ? "on" : ""}`} /></button>
            <button type="button" className="settings-option" aria-pressed={manualPaused} disabled={phase !== "combat"} onClick={togglePause}><span>{manualPaused ? "계속하기" : "일시 정지"}</span><span className={`toggle-track ${manualPaused ? "on" : ""}`} /></button>
            <button type="button" className="settings-option" aria-pressed={settings.reducedMotion} onClick={() => setSettings((current) => ({ ...current, reducedMotion: !current.reducedMotion }))}><span>모션 줄이기</span><span className={`toggle-track ${settings.reducedMotion ? "on" : ""}`} /></button>
          </div>}
        </header>

        <section className="battle-panel" aria-label="자동 전투 화면">
          <div className="battle-canvas-wrap"><canvas ref={canvasRef} className="battle-canvas" aria-label="아군과 적군의 자동 전투" /><div className="battle-vignette" /></div>

          {(phase === "preparation" || phase === "transition" || manualPaused) && <div className="battle-overlay">
            <div className="battle-overlay-card">
              <strong>{phase === "preparation" ? `웨이브 ${currentWave?.index ?? 1}` : phase === "transition" ? "웨이브 완료" : "일시정지"}</strong>
              {phase !== "preparation" && <p>{phase === "transition" ? "획득한 골드를 정리하고 있어요." : "설정에서 계속하기를 눌러 주세요."}</p>}
              {phase === "preparation" && <button type="button" className="primary-action overlay-start-button" onClick={startWave}>전투 시작</button>}
            </div>
          </div>}

          {phase === "shop" && <div className="shop-panel" aria-label="웨이브 상점">
            <div className="shop-heading"><strong>웨이브 상점</strong></div>
            <div className="shop-offers">
              {shopOffers.map((offer) => {
                const definition = ITEM_DEFINITIONS[offer.definitionId];
                const purchasable = canPurchaseShopOffer(gridItems, gold, offer, unlockedColumns);
                const shopDetail = definition.kind === "character"
                  ? `HP ${definition.hp} · 이동 ${definition.moveSpeed} · 생성 ${definition.spawnCooldown.toFixed(1)}초`
                  : definition.equipPenalty
                    ? `장착 패널티: ${definition.equipPenalty.hpMultiplier ? `체력 -${Math.round((1 - definition.equipPenalty.hpMultiplier) * 100)}%` : `이동 -${Math.round((1 - (definition.equipPenalty.moveSpeedMultiplier ?? 1)) * 100)}%`}`
                    : undefined;
                const shopHelp: HoverHelp = {
                  key: `shop:${offer.id}`,
                  icon: definition.icon,
                  title: `${definition.name} · T${offer.tier}`,
                  description: definition.description,
                  detail: shopDetail,
                };
                const showShopHelp = () => setHoverHelp(shopHelp);
                const hideShopHelp = () => setHoverHelp((current) => current?.key === shopHelp.key ? null : current);
                return <article
                  key={offer.id}
                  className={`shop-card tier-${offer.tier} ${offer.purchased ? "purchased" : ""} ${!purchasable ? "unavailable" : ""}`}
                  style={itemStyle(definition)}
                  onMouseEnter={showShopHelp}
                  onMouseLeave={hideShopHelp}
                  onFocus={showShopHelp}
                  onBlur={hideShopHelp}
                >
                  <span className="shop-icon">{definition.icon}</span>
                  <strong>{definition.name}</strong>
                  <button
                    type="button"
                    className="shop-buy-button"
                    disabled={offer.purchased}
                    aria-disabled={!purchasable}
                    aria-describedby="fixed-hover-help"
                    onClick={() => buyOffer(offer.id)}
                  >{offer.purchased ? "완료" : `${offer.price}골드`}</button>
                </article>;
              })}
            </div>
            <button type="button" className="primary-action shop-next-button" onClick={startWave}>전투 시작</button>
          </div>}

          {hoverHelp && <div id="fixed-hover-help" className="fixed-hover-help" role="tooltip">
            {hoverHelp.sharingCount !== undefined && <span className="fixed-hover-sharing">공유 캐릭터 {hoverHelp.sharingCount}명</span>}
            <span className="fixed-hover-icon" aria-hidden="true">{hoverHelp.icon}</span>
            <span className="fixed-hover-copy">
              <strong>{hoverHelp.title}</strong>
              <span>{hoverHelp.description}</span>
              {hoverHelp.detail && <span className="fixed-hover-detail">{hoverHelp.detail}</span>}
            </span>
          </div>}
        </section>

        <section className="command-panel" aria-label="가방 편성">
          <div className="backpack-frame">
            <div className="inventory-grid">
              {Array.from({ length: GRID_ROWS * INVENTORY_COLUMNS }, (_, index) => {
                const position: GridPosition = { row: Math.floor(index / INVENTORY_COLUMNS), col: index % INVENTORY_COLUMNS };
                const occupant = getGridItemAt(gridItems, position);
                const item = gridItems.find((entry) => positionsEqual(entry.position, position));
                const target = `grid:${position.row}:${position.col}`;
                const previewed = dropPreview?.cells.some((cell) => positionsEqual(cell, position));
                const locked = position.col >= unlockedColumns && position.col < PLAYER_DEPLOY_COLUMNS;
                const permanentLocked = position.col >= PLAYER_DEPLOY_COLUMNS;
                const outpostCell = locked && (position.row === 1 || position.row === 3);
                return <div
                  key={target}
                  className={[
                    "grid-cell",
                    occupant ? "occupied-cell" : "",
                    locked ? "locked-cell" : "",
                    permanentLocked ? "locked-cell permanent-locked-cell" : "",
                    outpostCell ? "locked-outpost-cell" : "",
                    previewed ? (dropPreview?.valid ? "drop-valid" : "drop-invalid") : "",
                  ].filter(Boolean).join(" ")}
                  data-drop-target={!locked && !permanentLocked ? target : undefined}
                >{item && renderItem(item)}{outpostCell
                    ? <span className="locked-outpost" aria-hidden="true">🏰</span>
                    : (locked || permanentLocked) && <span className="cell-lock" aria-hidden="true">🔒</span>}</div>;
              })}
            </div>
          </div>
        </section>

        <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.tone === "normal" ? "" : toast.tone}`}>{toast.copy}</div>)}</div>
        {drag?.moved && <div className="drag-ghost" aria-hidden="true" style={{ left: drag.x, top: drag.y, width: drag.sourceWidth, height: drag.sourceHeight }}>{renderItem(gridItems.find((item) => item.id === drag.id)!, { dragGhost: true })}</div>}

        {report && (phase === "victory" || phase === "defeat") && <div className="modal-backdrop"><section className={`report-modal ${report.result}`} role="dialog" aria-modal="true" aria-labelledby="report-title">
          <div className="report-hero"><div className="report-emblem">{report.result === "victory" ? "🏆" : "🛡️"}</div><span className="modal-kicker">Run complete</span><h2 className="modal-title" id="report-title">{report.result === "victory" ? "보스를 쓰러뜨렸어요!" : "기지를 지키지 못했어요"}</h2></div>
          <div className="report-grid"><div className="report-stat"><span>웨이브</span><strong>{report.reachedWave}/6</strong></div><div className="report-stat"><span>전투 시간</span><strong>{formatTime(report.combatTime)}</strong></div><div className="report-stat"><span>남은 골드</span><strong>{report.goldRemaining}</strong></div></div>
          <div className="report-actions"><button type="button" className="primary-action" onClick={() => resetRun(`run-${Date.now().toString(36)}`)}>새 시드 시작</button></div>
        </section></div>}
      </section>
      <div className="landscape-guard"><div className="landscape-card"><span className="landscape-icon">↻</span><strong>세로 화면으로 돌려 주세요</strong><p>가방과 전투를 함께 보려면 세로 화면이 가장 편합니다.</p></div></div>
    </main>
  );
}
