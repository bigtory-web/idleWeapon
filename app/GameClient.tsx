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
  getAdjacentWeaponConnections,
  getCharactersSharingWeapon,
  getGridItemAt,
  getOccupiedCells,
  getRotatedItemGeometry,
  getWorldSockets,
  normalizeRotation,
  positionsEqual,
  reconcileEquipmentLinks,
  rotateGridItem,
} from "@/lib/game/inventory";
import { renderBattle } from "@/lib/game/render";
import {
  canPurchaseShopOffer,
  generateShopOffers,
  purchaseShopOffer,
} from "@/lib/game/shop";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  type CombatMetrics,
  type CombatSnapshot,
  type Direction,
  type EquipmentLink,
  type GamePhase,
  type GridItem,
  type GridPosition,
  type ItemDefinition,
  type ItemId,
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
  moved: boolean;
  grabRow: number;
  grabCol: number;
}

interface Settings {
  muted: boolean;
  reducedMotion: boolean;
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

function CharacterGlyph({ id }: { id: ItemId }) {
  return (
    <span className={`character-glyph character-glyph-${id}`} aria-hidden="true">
      <span className="glyph-head" />
      <span className="glyph-body" />
      <span className="glyph-gear" />
    </span>
  );
}

export default function GameClient() {
  const engineRef = useRef<CombatEngine>(new CombatEngine());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const [phase, setPhase] = useState<UiPhase>("preparation");
  const [waveCursor, setWaveCursor] = useState(0);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [gridItems, setGridItems] = useState<GridItem[]>(cloneStartingInventory);
  const [equipmentLinks, setEquipmentLinks] = useState<EquipmentLink[]>(() => reconcileEquipmentLinks(cloneStartingInventory(), []));
  const [snapshot, setSnapshot] = useState<CombatSnapshot>(() => createIdleSnapshot());
  const [gold, setGold] = useState(0);
  const [goldEarned, setGoldEarned] = useState(0);
  const [goldSpent, setGoldSpent] = useState(0);
  const [shopOffers, setShopOffers] = useState<ShopOffer[]>([]);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [purchases, setPurchases] = useState<ShopPurchase[]>([]);
  const [spawnFlashIds, setSpawnFlashIds] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  const [manualPaused, setManualPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({ muted: false, reducedMotion: false });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [report, setReport] = useState<RunReportV2 | null>(null);

  const phaseRef = useRef(phase);
  const gridRef = useRef(gridItems);
  const equipmentLinksRef = useRef(equipmentLinks);
  const seedRef = useRef(seed);
  const snapshotRef = useRef(snapshot);
  const goldRef = useRef(gold);
  const goldEarnedRef = useRef(goldEarned);
  const goldSpentRef = useRef(goldSpent);
  const purchasesRef = useRef(purchases);
  const totalsRef = useRef<CombatMetrics>(emptyMetrics());
  const settingsRef = useRef(settings);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { gridRef.current = gridItems; }, [gridItems]);
  useEffect(() => { equipmentLinksRef.current = equipmentLinks; }, [equipmentLinks]);
  useEffect(() => { seedRef.current = seed; }, [seed]);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { goldRef.current = gold; }, [gold]);
  useEffect(() => { goldEarnedRef.current = goldEarned; }, [goldEarned]);
  useEffect(() => { goldSpentRef.current = goldSpent; }, [goldSpent]);
  useEffect(() => { purchasesRef.current = purchases; }, [purchases]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

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
    const nextLinks = reconcileEquipmentLinks(merged.gridItems, equipmentLinksRef.current);
    gridRef.current = merged.gridItems;
    equipmentLinksRef.current = nextLinks;
    setGridItems(merged.gridItems);
    setEquipmentLinks(nextLinks);
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

  const flashSpawnLinks = useCallback((ids: string[]) => {
    const duration = settingsRef.current.reducedMotion ? 120 : 180;
    setSpawnFlashIds((current) => new Set([...current, ...ids]));
    for (const id of ids) {
      const previous = flashTimersRef.current.get(id);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        setSpawnFlashIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        flashTimersRef.current.delete(id);
      }, duration);
      flashTimersRef.current.set(id, timer);
    }
  }, []);

  useEffect(() => {
    let hydrateTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
      const querySeed = new URLSearchParams(window.location.search).get("seed")?.trim();
      hydrateTimer = setTimeout(() => {
        if (stored) setSettings((current) => ({ ...current, ...stored }));
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
    const flashTimers = flashTimersRef.current;
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "snapshot") {
        snapshotRef.current = event.snapshot;
        setSnapshot(event.snapshot);
      } else if (event.type === "ally-spawned") {
        flashSpawnLinks([event.spawnerId, ...event.weaponItemIds]);
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
          setSelectedOfferId(null);
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
      for (const timer of flashTimers.values()) clearTimeout(timer);
      flashTimers.clear();
      void audioRef.current?.close();
    };
  }, [changePhase, commitInventory, finishRun, flashSpawnLinks, playTone, showToast]);

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
        snapshotRef.current = engine.step(Math.min((now - previous) / 1000, 0.1));
      }
      previous = now;
      const context = canvas.getContext("2d");
      if (context) renderBattle(context, snapshotRef.current, { width: 390, height: 360, reducedMotion: settingsRef.current.reducedMotion });
      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  const currentWave = WAVE_DEFINITIONS[waveCursor] ?? WAVE_DEFINITIONS.at(-1);
  const timeRemaining = phase === "combat"
    ? Math.max(0, snapshot.timeLimit - snapshot.elapsed)
    : currentWave?.timeLimit ?? 0;
  const selectedOffer = shopOffers.find((offer) => offer.id === selectedOfferId) ?? null;
  const inventoryLocked = phase === "combat" || phase === "transition";
  const hpRatio = Math.max(0, Math.min(100, (snapshot.baseHp / Math.max(1, snapshot.maxBaseHp)) * 100));

  const resetRun = useCallback((nextSeed: string) => {
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    engineRef.current.resume("manual");
    const fresh = cloneStartingInventory();
    const freshLinks = reconcileEquipmentLinks(fresh, []);
    setSeed(nextSeed);
    seedRef.current = nextSeed;
    setGridItems(fresh);
    gridRef.current = fresh;
    setEquipmentLinks(freshLinks);
    equipmentLinksRef.current = freshLinks;
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
    setSelectedOfferId(null);
    setPreviewItemId(null);
    setManualPaused(false);
    setReport(null);
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
    const spawners = deriveSpawnerBlueprints(gridRef.current, equipmentLinksRef.current);
    if (!wave || spawners.length === 0) {
      showToast("가방에 캐릭터를 한 명 이상 배치해 주세요.", "warning");
      return;
    }
    setShopOffers([]);
    setSelectedOfferId(null);
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

  const buySelectedOffer = useCallback(() => {
    const offer = shopOffers.find((entry) => entry.id === selectedOfferId);
    if (!offer) return;
    const result = purchaseShopOffer(gridRef.current, goldRef.current, offer);
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
    setSelectedOfferId(null);
    playTone(690, 0.1);
    showToast(`${ITEM_DEFINITIONS[offer.definitionId].name} 구매 완료${result.merges ? ` · ${result.merges}회 합성` : ""}`, "success");
  }, [commitInventory, playTone, selectedOfferId, shopOffers, showToast]);

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
      { gridItems: gridRef.current, pendingRewards: [] },
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
    setDrag({ id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, grabRow, grabCol });
  }, []);

  const pointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    setDrag((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5;
      if (moved) {
        const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-drop-target]");
        setDropTarget(element?.dataset.dropTarget ?? null);
      }
      return { ...current, x: event.clientX, y: event.clientY, moved };
    });
  }, []);

  const pointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      setPreviewItemId(null);
      completeDrop(drag.id, dropTarget, drag.grabRow, drag.grabCol);
    } else if (event.pointerType !== "mouse") {
      setPreviewItemId((current) => current === drag.id ? null : drag.id);
    }
    setDrag(null);
    setDropTarget(null);
  }, [completeDrop, drag, dropTarget]);

  const onItemKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, itemId: string) => {
    if (phaseRef.current !== "preparation" && phaseRef.current !== "shop") return;
    if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      const rotated = rotateGridItem(gridRef.current, itemId);
      if (rotated.moved) applyInventory(rotated.items);
      else showToast("이 위치에서는 회전할 수 없어요.", "warning");
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowDown: [1, 0], ArrowLeft: [0, -1],
    };
    const delta = arrows[event.key];
    if (!delta) return;
    event.preventDefault();
    const item = gridRef.current.find((entry) => entry.id === itemId);
    if (!item?.position) return;
    const result = dropItemOnGrid(
      { gridItems: gridRef.current, pendingRewards: [] },
      itemId,
      { row: item.position.row + delta[0], col: item.position.col + delta[1] },
    );
    if (result.success) applyInventory(result.gridItems, result.action === "merged" ? "캐릭터 합성 완료!" : undefined);
  }, [applyInventory, showToast]);

  const rotateSelectedItem = useCallback(() => {
    if (!previewItemId || inventoryLocked) return;
    const rotated = rotateGridItem(gridRef.current, previewItemId);
    if (rotated.moved) applyInventory(rotated.items);
    else showToast("이 위치에서는 회전할 수 없어요.", "warning");
  }, [applyInventory, inventoryLocked, previewItemId, showToast]);

  const renderItem = (item: GridItem) => {
    const definition = ITEM_DEFINITIONS[item.definitionId];
    const isCharacter = definition.kind === "character";
    const geometry = getRotatedItemGeometry(item.definitionId, normalizeRotation(item.rotation));
    const adjacentConnections = isCharacter ? getAdjacentWeaponConnections(item, gridItems) : [];
    const activeConnections = isCharacter ? getActiveWeaponConnections(item, gridItems, equipmentLinks) : [];
    const sharingCharacters = isCharacter ? [] : getCharactersSharingWeapon(item, gridItems, equipmentLinks);
    const connectionMarks = isCharacter
      ? activeConnections.map(({ direction, item: weapon, characterCell }) => ({ direction, row: characterCell.row, col: characterCell.col, key: `${direction}-${weapon.id}` }))
      : getWorldSockets(item).flatMap((socket, index) => {
          const offsets: Record<Direction, [number, number]> = {
            up: [-1, 0], right: [0, 1], down: [1, 0], left: [0, -1],
          };
          const [rowOffset, colOffset] = offsets[socket.direction];
          const neighbor = getGridItemAt(gridItems, { row: socket.position.row + rowOffset, col: socket.position.col + colOffset });
          if (!neighbor || !isCharacterId(neighbor.definitionId) || !item.position
            || !getActiveWeaponConnections(neighbor, gridItems, equipmentLinks).some(({ item: weapon }) => weapon.id === item.id)) return [];
          return [{
            direction: socket.direction,
            row: socket.position.row - item.position.row,
            col: socket.position.col - item.position.col,
            key: `${socket.direction}-${index}`,
          }];
        });
    const relationDetail = isCharacter
      ? `다음 생성 무기: ${adjacentConnections.length ? adjacentConnections.map(({ item: weapon }) => ITEM_DEFINITIONS[weapon.definitionId].name).join(", ") : "맨손"}`
      : `공유 캐릭터: ${sharingCharacters.length}명`;
    const spawner = snapshot.spawners.find((entry) => entry.id === item.id);
    const progress = phase === "combat" && isCharacter ? spawner?.progress ?? 0 : 0;
    const squadDetail = spawner ? ` · 분대 ${spawner.activeCount}/${spawner.maxActive}` : "";
    const activeRelationDetail = isCharacter
      ? `장착 무기: ${activeConnections.length ? activeConnections.map(({ item: weapon }) => ITEM_DEFINITIONS[weapon.definitionId].name).join(", ") : "맨손"}`
      : `공유 캐릭터 ${sharingCharacters.length}명`;
    const characterStats = isCharacter
      ? `HP ${definition.hp} · 이동 ${definition.moveSpeed} · 생성 ${definition.spawnCooldown.toFixed(1)}초 · 무기 슬롯 ${definition.weaponSlots[item.tier]}개`
      : "";
    const penaltyDetail = !isCharacter && definition.equipPenalty
      ? [
        definition.equipPenalty.hpMultiplier ? `체력 -${Math.round((1 - definition.equipPenalty.hpMultiplier) * 100)}%` : "",
        definition.equipPenalty.moveSpeedMultiplier ? `이동 -${Math.round((1 - definition.equipPenalty.moveSpeedMultiplier) * 100)}%` : "",
      ].filter(Boolean).join(" · ")
      : "";
    const detailId = `item-detail-${item.id}`;
    const layoutStyle = {
      ...itemStyle(definition, progress),
      "--item-cols": geometry.cols,
      "--item-rows": geometry.rows,
      "--item-width": `calc(${geometry.cols * 100}% + ${(geometry.cols - 1) * 5}px - 6px)`,
      "--item-height": `calc(${geometry.rows * 100}% + ${(geometry.rows - 1) * 5}px - 6px)`,
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
          activeConnections.length || sharingCharacters.length ? "linked-active" : "",
          drag?.id === item.id ? "dragging" : "",
          previewItemId === item.id ? "previewing" : "",
          spawnFlashIds.has(item.id) ? "spawn-linked-flash" : "",
        ].filter(Boolean).join(" ")}
        style={layoutStyle}
        aria-label={`${definition.name} 티어 ${item.tier}. ${activeRelationDetail}${squadDetail}`}
        aria-describedby={detailId}
        aria-disabled={inventoryLocked}
        aria-expanded={previewItemId === item.id}
        onPointerDown={(event) => pointerDown(event, item.id)}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => { setDrag(null); setDropTarget(null); setPreviewItemId(null); }}
        onKeyDown={(event) => onItemKeyDown(event, item.id)}
      >
        <span className="item-card">
          {geometry.cells.map((cell) => <span
            key={`${cell.row}:${cell.col}`}
            className="item-segment"
            style={{ gridRow: cell.row + 1, gridColumn: cell.col + 1 }}
            aria-hidden="true"
          >{connectionMarks.filter((mark) => mark.row === cell.row && mark.col === cell.col).map((mark) => <span
            key={mark.key}
            className={`connection-mark connection-${mark.direction}`}
          >○</span>)}{isCharacter && <span className="segment-character-icon"><CharacterGlyph id={item.definitionId} /></span>}</span>)}
          {isCharacter && phase === "combat" && spawner?.state !== "full" && <span className="spawn-cooldown-fill" aria-hidden="true" />}
          {!isCharacter && <span className="item-icon">{definition.icon}</span>}
          <span id={detailId} className="inventory-item-details" role="tooltip">
            <strong>{definition.name} · T{item.tier}</strong>
            <span>{definition.description}</span>
            {isCharacter && <span className="inventory-stat-detail">{characterStats}</span>}
            {penaltyDetail && <span className="inventory-penalty-detail">장착 패널티: {penaltyDetail}</span>}
            <span className="inventory-relation-detail">{activeRelationDetail}{squadDetail}</span>
          </span>
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
    const result = dropItemOnGrid({ gridItems, pendingRewards: [] }, item.id, position);
    return { cells: getOccupiedCells(item, position), valid: result.success };
  })();

  const selectedInventoryItem = previewItemId
    ? gridItems.find((item) => item.id === previewItemId) ?? null
    : null;
  const openSocketTargets = new Set(gridItems.flatMap((item) => getWorldSockets(item).flatMap((socket) => {
    const offsets: Record<Direction, [number, number]> = {
      up: [-1, 0], right: [0, 1], down: [1, 0], left: [0, -1],
    };
    const [rowOffset, colOffset] = offsets[socket.direction];
    const target = { row: socket.position.row + rowOffset, col: socket.position.col + colOffset };
    return target.row >= 0 && target.row < GRID_ROWS && target.col >= 0 && target.col < GRID_COLUMNS
      && !getGridItemAt(gridItems, target)
      ? [`${target.row}:${target.col}`]
      : [];
  })));

  return (
    <main className={`game-stage ${settings.reducedMotion ? "reduced-motion" : ""}`}>
      <section className="game-shell" aria-label="일꾼 키우기 전투 게임">
        <header className="top-chrome">
          <div className="header-combat-info">
            <div><span>웨이브</span><strong>{currentWave?.index ?? 6}/6</strong></div>
            <div><span>{phase === "combat" ? "남은 시간" : "제한 시간"}</span><strong className={timeRemaining < 10 && phase === "combat" ? "danger" : ""}>{formatTime(timeRemaining)}</strong></div>
          </div>
          <button type="button" className="icon-button" aria-label="게임 설정" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>⚙</button>
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
              <p>{phase === "preparation" ? "캐릭터 옆에 무기를 붙이면 그 무기를 든 일꾼이 생성돼요." : phase === "transition" ? "획득한 골드를 정리하고 있어요." : "설정에서 계속하기를 눌러 주세요."}</p>
              {phase === "preparation" && <button type="button" className="primary-action overlay-start-button" onClick={startWave}>웨이브 시작</button>}
            </div>
          </div>}

          {phase === "shop" && <div className="shop-panel" aria-label="웨이브 상점">
            <div className="shop-heading"><div><span>웨이브 상점</span><strong>다음 전투를 준비하세요</strong></div><div className="gold-balance">● {gold}</div></div>
            <div className="shop-offers">
              {shopOffers.map((offer) => {
                const definition = ITEM_DEFINITIONS[offer.definitionId];
                const selected = selectedOfferId === offer.id;
                return <button
                  type="button"
                  key={offer.id}
                  className={`shop-card tier-${offer.tier} ${selected ? "selected" : ""} ${offer.purchased ? "purchased" : ""}`}
                  style={itemStyle(definition)}
                  aria-pressed={selected}
                  disabled={offer.purchased}
                  onClick={() => setSelectedOfferId(offer.id)}
                >
                  <span className="shop-icon">{isCharacterId(offer.definitionId) ? <CharacterGlyph id={offer.definitionId} /> : definition.icon}</span>
                  <strong>{definition.name}</strong>
                  <span className="shop-price">{offer.purchased ? "구매 완료" : `● ${offer.price}`}</span>
                  <span className="shop-card-details" role="tooltip">
                    <span>{definition.description}</span>
                    {definition.kind === "character" && <span className="shop-stat-detail">HP {definition.hp} · 이동 {definition.moveSpeed} · 생성 {definition.spawnCooldown.toFixed(1)}초 · 무기 슬롯 {definition.weaponSlots[offer.tier]}개</span>}
                    {definition.kind === "weapon" && definition.equipPenalty && <span className="shop-penalty-detail">장착 패널티: {definition.equipPenalty.hpMultiplier ? `체력 -${Math.round((1 - definition.equipPenalty.hpMultiplier) * 100)}%` : `이동 -${Math.round((1 - (definition.equipPenalty.moveSpeedMultiplier ?? 1)) * 100)}%`}</span>}
                  </span>
                </button>;
              })}
            </div>
            <div className="shop-selection">
              <span>{selectedOffer ? ITEM_DEFINITIONS[selectedOffer.definitionId].description : "상품을 선택하면 설명과 구매 버튼이 나타나요."}</span>
              <button type="button" className="buy-button" disabled={!selectedOffer || !canPurchaseShopOffer(gridItems, gold, selectedOffer)} onClick={buySelectedOffer}>{selectedOffer ? `${selectedOffer.price}골드 구매` : "상품 선택"}</button>
            </div>
            <button type="button" className="primary-action shop-next-button" onClick={startWave}>다음 웨이브 시작</button>
          </div>}

          <div className="base-hp-strip">
            <div className="base-hp-copy"><span>기지 HP</span><strong>{Math.ceil(snapshot.baseHp)}/{snapshot.maxBaseHp}</strong></div>
            <div className="base-hp-meter"><span className={hpRatio <= 35 ? "danger" : ""} style={{ width: `${hpRatio}%` }} /></div>
          </div>
        </section>

        <section className="command-panel" aria-label="가방 편성">
          <div className="backpack-frame">
            <div className="inventory-grid">
              {Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_, index) => {
                const position: GridPosition = { row: Math.floor(index / GRID_COLUMNS), col: index % GRID_COLUMNS };
                const occupant = getGridItemAt(gridItems, position);
                const item = gridItems.find((entry) => positionsEqual(entry.position, position));
                const target = `grid:${position.row}:${position.col}`;
                const previewed = dropPreview?.cells.some((cell) => positionsEqual(cell, position));
                const socketTarget = openSocketTargets.has(`${position.row}:${position.col}`);
                return <div
                  key={target}
                  className={[
                    "grid-cell",
                    occupant ? "occupied-cell" : "",
                    socketTarget ? "socket-target-cell" : "",
                    previewed ? (dropPreview?.valid ? "drop-valid" : "drop-invalid") : "",
                  ].filter(Boolean).join(" ")}
                  data-drop-target={target}
                >{item && renderItem(item)}{socketTarget && <span className="socket-target-mark" aria-hidden="true">○</span>}</div>;
              })}
            </div>
            {selectedInventoryItem && !isCharacterId(selectedInventoryItem.definitionId) && !inventoryLocked && <button
              type="button"
              className="rotate-item-button"
              onClick={rotateSelectedItem}
              aria-label={`${ITEM_DEFINITIONS[selectedInventoryItem.definitionId].name} 90도 회전`}
            >↻ 회전</button>}
          </div>
        </section>

        <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.tone === "normal" ? "" : toast.tone}`}>{toast.copy}</div>)}</div>
        {drag?.moved && <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>{renderItem(gridItems.find((item) => item.id === drag.id)!)}</div>}

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
