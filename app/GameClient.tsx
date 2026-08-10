"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BASE_HP,
  CHARACTERS,
  DEFAULT_SEED,
  ITEM_DEFINITIONS,
  MAX_PLAYER_LEVEL,
  REWARD_ITEM_IDS,
  STARTING_INVENTORY,
  WAVE_DEFINITIONS,
  WEAPONS,
  getXpRequirementForLevel,
  isCharacterId,
} from "@/lib/game/data";
import { CombatEngine } from "@/lib/game/engine";
import {
  autoMergeWeapons,
  deriveSpawnerBlueprints,
  dropItemOnGrid,
  getAdjacentWeaponConnections,
  getAdjacentWeapons,
  getCharactersSharingWeapon,
  getGridItemAt,
  moveGridItemToPending,
  reorderPendingReward,
  type InventoryState,
} from "@/lib/game/inventory";
import { createSeededRng } from "@/lib/game/rng";
import { renderBattle } from "@/lib/game/render";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  type CombatMetrics,
  type CombatSnapshot,
  type GamePhase,
  type GridItem,
  type GridPosition,
  type ItemDefinition,
  type ItemId,
  type PendingReward,
  type RunReportRewardChoice,
  type RunReportV1,
} from "@/lib/game/types";

type UiPhase = GamePhase | "transition";
type DragOrigin = "grid" | "queue";

interface DragState {
  id: string;
  origin: DragOrigin;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
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

function createIdleSnapshot(baseHp = BASE_HP, level = 1, xp = 0): CombatSnapshot {
  return {
    phase: "idle",
    waveIndex: 0,
    elapsed: 0,
    timeLimit: WAVE_DEFINITIONS[0]?.timeLimit ?? 60,
    baseHp,
    maxBaseHp: BASE_HP,
    playerXp: xp,
    playerLevel: level,
    pendingLevelUps: 0,
    pausedReasons: [],
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

function generateRewardOptions(seed: string, level: number): ItemId[] {
  const rng = createSeededRng(`${seed}:reward:${level}`);
  const characters = rng.shuffle(Object.keys(CHARACTERS) as ItemId[]);
  const weapons = rng.shuffle(Object.keys(WEAPONS) as ItemId[]);
  const chosen = [characters[0], weapons[0]].filter(Boolean) as ItemId[];
  const rest = rng.shuffle(REWARD_ITEM_IDS.filter((id) => !chosen.includes(id)));
  if (rest[0]) chosen.push(rest[0]);
  return chosen;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function phaseLabel(phase: UiPhase): string {
  const labels: Record<UiPhase, string> = {
    preparation: "배치 가능",
    combat: "전투 중 · 가방 잠김",
    "level-up": "레벨업 선택",
    transition: "웨이브 정리",
    victory: "원정 성공",
    defeat: "원정 실패",
  };
  return labels[phase];
}

function buildReportText(report: RunReportV1): string {
  const spawns = Object.entries(report.characterSpawns)
    .map(([id, value]) => `- ${ITEM_DEFINITIONS[id as ItemId]?.name ?? id}: ${value}명`)
    .join("\n") || "- 기록 없음";
  const damage = Object.entries(report.weaponDamage)
    .map(([id, value]) => `- ${ITEM_DEFINITIONS[id as ItemId]?.name ?? id}: ${Math.round(value)}`)
    .join("\n") || "- 기록 없음";
  return [
    `일꾼 키우기 전투 결과 — ${report.result === "victory" ? "승리" : "패배"}`,
    `시드: ${report.seed}`,
    `도달 웨이브: ${report.reachedWave}/6`,
    `전투 시간: ${formatTime(report.combatTime)}`,
    `기지 HP: ${Math.round(report.baseHp)}/100`,
    `레벨: ${report.playerLevel}`,
    "",
    "캐릭터 생성",
    spawns,
    "",
    "무기 피해",
    damage,
  ].join("\n");
}

function itemStyle(definition: ItemDefinition): CSSProperties {
  return { "--item-color": definition.color } as CSSProperties;
}

export default function GameClient() {
  const engineRef = useRef<CombatEngine | null>(null);
  if (engineRef.current == null) {
    engineRef.current = new CombatEngine();
  }

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const [phase, setPhase] = useState<UiPhase>("preparation");
  const [waveCursor, setWaveCursor] = useState(0);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [gridItems, setGridItems] = useState<GridItem[]>(cloneStartingInventory);
  const [pendingRewards, setPendingRewards] = useState<PendingReward[]>([]);
  const [snapshot, setSnapshot] = useState<CombatSnapshot>(() => createIdleSnapshot());
  const [selectedId, setSelectedId] = useState<string | null>("start-scout");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [levelQueue, setLevelQueue] = useState<number[]>([]);
  const [rewardChoices, setRewardChoices] = useState<RunReportRewardChoice[]>([]);
  const [manualPaused, setManualPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({ muted: false, reducedMotion: false });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [report, setReport] = useState<RunReportV1 | null>(null);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);

  const phaseRef = useRef(phase);
  const gridRef = useRef(gridItems);
  const pendingRef = useRef(pendingRewards);
  const seedRef = useRef(seed);
  const snapshotRef = useRef(snapshot);
  const rewardChoicesRef = useRef(rewardChoices);
  const levelQueueRef = useRef(levelQueue);
  const totalsRef = useRef<CombatMetrics>(emptyMetrics());
  const settingsRef = useRef(settings);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { gridRef.current = gridItems; }, [gridItems]);
  useEffect(() => { pendingRef.current = pendingRewards; }, [pendingRewards]);
  useEffect(() => { seedRef.current = seed; }, [seed]);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { rewardChoicesRef.current = rewardChoices; }, [rewardChoices]);
  useEffect(() => { levelQueueRef.current = levelQueue; }, [levelQueue]);
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
      const AudioContextClass = window.AudioContext;
      const audio = audioRef.current ?? new AudioContextClass();
      audioRef.current = audio;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.045, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + duration);
    } catch {
      // Audio is decorative; the game remains fully usable when blocked.
    }
  }, []);

  const finishRun = useCallback((result: "victory" | "defeat", reachedWave: number, defeatReason?: RunReportV1["defeatReason"]) => {
    const snap = engineRef.current?.getSnapshot() ?? snapshotRef.current;
    const reportValue: RunReportV1 = {
      version: 1,
      result,
      defeatReason,
      seed: seedRef.current,
      combatTime: totalsRef.current.elapsed,
      reachedWave,
      baseHp: snap.baseHp,
      playerLevel: snap.playerLevel,
      characterSpawns: { ...totalsRef.current.alliesSpawned },
      weaponDamage: { ...totalsRef.current.weaponDamage },
      rewardChoices: rewardChoicesRef.current.map((choice) => ({ ...choice })),
      finalInventory: [
        ...gridRef.current.map((item) => ({
          id: item.id,
          definitionId: item.definitionId,
          tier: item.tier,
          row: item.position?.row ?? null,
          col: item.position?.col ?? null,
          location: "grid" as const,
        })),
        ...pendingRef.current.map((item) => ({
          id: item.id,
          definitionId: item.definitionId,
          tier: item.tier,
          row: null,
          col: null,
          location: "queue" as const,
        })),
      ],
      completedAt: new Date().toISOString(),
    };
    setReport(reportValue);
    changePhase(result);
    try {
      const previous = JSON.parse(localStorage.getItem(REPORTS_KEY) ?? "[]") as RunReportV1[];
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
        if (stored) setSettings((current) => ({ ...current, ...stored }));
        if (querySeed) setSeed(querySeed);
      }, 0);
    } catch {
      // Defaults are already usable.
    }
    return () => {
      if (hydrateTimer) clearTimeout(hydrateTimer);
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* optional */ }
  }, [settings]);

  useEffect(() => {
    const engine = engineRef.current!;
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "snapshot") {
        snapshotRef.current = event.snapshot;
        setSnapshot(event.snapshot);
      } else if (event.type === "level-up") {
        const levels = Array.from({ length: event.pendingLevelUps }, (_, index) => event.level - event.pendingLevelUps + index + 1);
        levelQueueRef.current = levels;
        setLevelQueue(levels);
        changePhase("level-up");
        playTone(740, 0.18);
      } else if (event.type === "wave-cleared") {
        totalsRef.current = addMetrics(totalsRef.current, event.metrics);
        const snap = engine.getSnapshot();
        snapshotRef.current = snap;
        setSnapshot(snap);
        if (event.waveIndex >= WAVE_DEFINITIONS.length) {
          playTone(920, 0.26);
          finishRun("victory", event.waveIndex);
        } else {
          changePhase("transition");
          playTone(620, 0.14);
          transitionTimerRef.current = setTimeout(() => {
            const merged = autoMergeWeapons(gridRef.current, pendingRef.current);
            gridRef.current = merged.gridItems;
            pendingRef.current = merged.pendingRewards;
            setGridItems(merged.gridItems);
            setPendingRewards(merged.pendingRewards);
            setWaveCursor(event.waveIndex);
            if (merged.merges.length) showToast(`무기 ${merged.merges.length}회 자동 합성!`, "success");
            changePhase("preparation");
          }, settingsRef.current.reducedMotion ? 80 : 900);
        }
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
      engine.dispose();
      void audioRef.current?.close();
    };
  }, [changePhase, finishRun, playTone, showToast]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (!canvas || !engine) return;
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
      if (phaseRef.current === "combat") snapshotRef.current = engine.step(Math.min((now - previous) / 1000, 0.1));
      previous = now;
      const context = canvas.getContext("2d");
      if (context) renderBattle(context, snapshotRef.current, { width: 390, height: 360, reducedMotion: settings.reducedMotion });
      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationFrame);
  }, [settings.reducedMotion]);

  const resetRun = useCallback((nextSeed: string) => {
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    engineRef.current?.resume("manual");
    engineRef.current?.resume("level-up");
    const fresh = cloneStartingInventory();
    setSeed(nextSeed);
    seedRef.current = nextSeed;
    setGridItems(fresh);
    gridRef.current = fresh;
    setPendingRewards([]);
    pendingRef.current = [];
    setWaveCursor(0);
    setRewardChoices([]);
    rewardChoicesRef.current = [];
    setLevelQueue([]);
    levelQueueRef.current = [];
    setManualPaused(false);
    setSelectedId("start-scout");
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
    const spawners = deriveSpawnerBlueprints(gridRef.current);
    if (!wave || spawners.length === 0) {
      showToast("가방에 캐릭터를 한 명 이상 배치해 주세요.", "warning");
      return;
    }
    const current = snapshotRef.current;
    changePhase("combat");
    setManualPaused(false);
    playTone(420, 0.08);
    engineRef.current?.startWave({
      waveIndex: wave.index,
      seed: seedRef.current,
      baseHp: current.baseHp,
      playerXp: current.playerXp,
      playerLevel: current.playerLevel,
      spawners,
      wave,
    });
  }, [changePhase, playTone, showToast, waveCursor]);

  const togglePause = useCallback(() => {
    if (phaseRef.current !== "combat") return;
    setManualPaused((paused) => {
      if (paused) engineRef.current?.resume("manual");
      else engineRef.current?.pause("manual");
      return !paused;
    });
  }, []);

  const currentLevel = levelQueue[0] ?? null;
  const rewardOptions = useMemo(() => currentLevel ? generateRewardOptions(seed, currentLevel) : [], [currentLevel, seed]);

  const chooseReward = useCallback((definitionId: ItemId) => {
    const level = levelQueueRef.current[0];
    if (!level) return;
    const reward: PendingReward = { id: `reward-${level}-${definitionId}`, definitionId, tier: 1, sourceLevel: level };
    const nextPending = [...pendingRef.current, reward];
    pendingRef.current = nextPending;
    setPendingRewards(nextPending);
    const choices = [...rewardChoicesRef.current, { level, definitionId, tier: 1 as const }];
    rewardChoicesRef.current = choices;
    setRewardChoices(choices);
    const remaining = levelQueueRef.current.slice(1);
    levelQueueRef.current = remaining;
    setLevelQueue(remaining);
    playTone(660, 0.1);
    if (remaining.length === 0) {
      engineRef.current?.resume("level-up");
      changePhase("combat");
    }
  }, [changePhase, playTone]);

  const applyInventory = useCallback((state: InventoryState, message?: string) => {
    gridRef.current = state.gridItems;
    pendingRef.current = state.pendingRewards;
    setGridItems(state.gridItems);
    setPendingRewards(state.pendingRewards);
    if (message) showToast(message, "success");
  }, [showToast]);

  const completeDrop = useCallback((itemId: string, origin: DragOrigin, target: string | null) => {
    if (!target || phaseRef.current !== "preparation") return;
    const state = { gridItems: gridRef.current, pendingRewards: pendingRef.current };
    if (target.startsWith("grid:")) {
      const [, rowValue, colValue] = target.split(":");
      const position = { row: Number(rowValue), col: Number(colValue) };
      const result = dropItemOnGrid(state, itemId, position);
      if (result.success) applyInventory(result, result.action === "merged" ? "캐릭터 합성 완료!" : undefined);
      else showToast("그 위치에는 놓을 수 없어요.", "warning");
    } else if (target === "queue" && origin === "grid") {
      const result = moveGridItemToPending(state, itemId);
      if (result.success) applyInventory(result);
    }
  }, [applyInventory, showToast]);

  const pointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, id: string, origin: DragOrigin) => {
    if (phaseRef.current !== "preparation") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, origin, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false });
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
    if (drag.moved) completeDrop(drag.id, drag.origin, dropTarget);
    else setSelectedId(drag.id);
    setDrag(null);
    setDropTarget(null);
  }, [completeDrop, drag, dropTarget]);

  const onItemKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, itemId: string, origin: DragOrigin) => {
    if (phaseRef.current !== "preparation") return;
    const state = { gridItems: gridRef.current, pendingRewards: pendingRef.current };
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedId(itemId);
      if (origin === "queue") {
        const empty = Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_, index) => ({ row: Math.floor(index / GRID_COLUMNS), col: index % GRID_COLUMNS }))
          .find((position) => !getGridItemAt(state.gridItems, position));
        if (empty) applyInventory(dropItemOnGrid(state, itemId, empty));
      }
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && origin === "grid") {
      event.preventDefault();
      applyInventory(moveGridItemToPending(state, itemId));
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowDown: [1, 0], ArrowLeft: [0, -1] };
    const delta = arrows[event.key];
    if (!delta) return;
    event.preventDefault();
    if (origin === "grid") {
      const item = state.gridItems.find((entry) => entry.id === itemId);
      if (!item?.position) return;
      const target = { row: item.position.row + delta[0], col: item.position.col + delta[1] };
      const result = dropItemOnGrid(state, itemId, target);
      if (result.success) applyInventory(result, result.action === "merged" ? "캐릭터 합성 완료!" : undefined);
    } else {
      const index = state.pendingRewards.findIndex((item) => item.id === itemId);
      const result = reorderPendingReward(state, itemId, index + (event.key === "ArrowLeft" ? -1 : 1));
      if (result.success) applyInventory(result);
    }
  }, [applyInventory]);

  const selectedItem = useMemo(() => {
    const grid = gridItems.find((item) => item.id === selectedId);
    if (grid) return { item: grid, origin: "grid" as const };
    const queued = pendingRewards.find((item) => item.id === selectedId);
    return queued ? { item: queued, origin: "queue" as const } : null;
  }, [gridItems, pendingRewards, selectedId]);

  const connections = useMemo(() => gridItems.flatMap((item) => isCharacterId(item.definitionId)
    ? getAdjacentWeaponConnections(item, gridItems).map(({ item: weapon }) => ({ character: item, weapon }))
    : []), [gridItems]);

  const currentWave = WAVE_DEFINITIONS[waveCursor] ?? WAVE_DEFINITIONS[WAVE_DEFINITIONS.length - 1];
  const nextXp = getXpRequirementForLevel(snapshot.playerLevel);
  const xpRatio = nextXp ? Math.min(100, (snapshot.playerXp / nextXp) * 100) : 100;
  const timeRemaining = Math.max(0, (currentWave?.timeLimit ?? 0) - snapshot.elapsed);
  const isLocked = phase !== "preparation";

  const renderItem = (item: GridItem | PendingReward, origin: DragOrigin) => {
    const definition = ITEM_DEFINITIONS[item.definitionId];
    const isCharacter = definition.kind === "character";
    const linked = origin === "grid" && (isCharacter
      ? getAdjacentWeapons(item as GridItem, gridItems).length > 0
      : getCharactersSharingWeapon(item as GridItem, gridItems).length > 0);
    const spawnRatio = isCharacter && phase === "combat"
      ? ((snapshot.elapsed % (definition.spawnCooldown * ([1, 0.9, 0.8][item.tier - 1] ?? 1))) / (definition.spawnCooldown * ([1, 0.9, 0.8][item.tier - 1] ?? 1))) * 100
      : 100;
    return (
      <button
        key={item.id}
        type="button"
        className={`${origin === "grid" ? "grid-item" : "queue-item"} item-kind-${definition.kind} ${selectedId === item.id ? "selected" : ""} ${drag?.id === item.id ? "dragging" : ""}`}
        style={itemStyle(definition)}
        aria-label={`${definition.name} ${item.tier}티어${isLocked ? ", 전투 중 이동 잠김" : ", 드래그 또는 방향키로 이동"}`}
        aria-pressed={selectedId === item.id}
        disabled={isLocked}
        onPointerDown={(event) => pointerDown(event, item.id, origin)}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => { setDrag(null); setDropTarget(null); }}
        onKeyDown={(event) => onItemKeyDown(event, item.id, origin)}
      >
        <span className="item-card">
          {linked && <span className="linked-dot" aria-hidden="true" />}
          <span className="tier-badge">T{item.tier}</span>
          <span className="item-icon" aria-hidden="true">{definition.icon}</span>
          <span className="item-name-mini">{definition.name}</span>
          {isCharacter && <span className="spawn-meter" aria-hidden="true"><span className="spawn-fill" style={{ width: `${spawnRatio}%` }} /></span>}
        </span>
      </button>
    );
  };

  const selectedDetail = selectedItem ? ITEM_DEFINITIONS[selectedItem.item.definitionId] : null;
  const selectedGrid = selectedItem?.origin === "grid" ? selectedItem.item as GridItem : null;
  const linkedNames = selectedDetail && selectedGrid
    ? selectedDetail.kind === "character"
      ? getAdjacentWeapons(selectedGrid, gridItems).map((item) => ITEM_DEFINITIONS[item.definitionId].name)
      : getCharactersSharingWeapon(selectedGrid, gridItems).map((item) => ITEM_DEFINITIONS[item.definitionId].name)
    : [];

  const copyReport = async () => {
    if (!report) return;
    const text = buildReportText(report);
    try {
      await navigator.clipboard.writeText(text);
      showToast("결과를 클립보드에 복사했어요.", "success");
    } catch {
      setCopyFallback(text);
    }
  };

  return (
    <main className={`game-stage ${settings.reducedMotion ? "reduced-motion" : ""}`}>
      <section className="game-shell" aria-label="일꾼 키우기 전투 게임">
        <header className="top-chrome">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">🎒</span>
            <div className="brand-copy"><p className="eyebrow">Backpack Battalion</p><h1 className="brand-title">일꾼 키우기</h1></div>
          </div>
          <div className="utility-bar">
            <button type="button" className="pause-button" aria-label={manualPaused ? "전투 계속" : "전투 일시정지"} aria-pressed={manualPaused} disabled={phase !== "combat"} onClick={togglePause}>{manualPaused ? "▶" : "Ⅱ"}</button>
            <button type="button" className="icon-button" aria-label={settings.muted ? "소리 켜기" : "음소거"} aria-pressed={settings.muted} onClick={() => setSettings((current) => ({ ...current, muted: !current.muted }))}>{settings.muted ? "🔇" : "🔊"}</button>
            <button type="button" className="icon-button" aria-label="게임 설정" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>⚙</button>
          </div>
          {settingsOpen && <div className="settings-popover"><h2 className="settings-title">게임 설정</h2><button type="button" className="settings-option" onClick={() => setSettings((current) => ({ ...current, muted: !current.muted }))}><span>효과음</span><span className={`toggle-track ${!settings.muted ? "on" : ""}`} /></button><button type="button" className="settings-option" onClick={() => setSettings((current) => ({ ...current, reducedMotion: !current.reducedMotion }))}><span>모션 줄이기</span><span className={`toggle-track ${settings.reducedMotion ? "on" : ""}`} /></button></div>}
        </header>

        <section className="battle-panel" aria-label="자동 전투 화면">
          <div className="battle-canvas-wrap"><canvas ref={canvasRef} className="battle-canvas" aria-label="아군과 적군의 자동 전투" /><div className="battle-vignette" /></div>
          <div className="hud-layer">
            <div className="hud-row">
              <div className="hud-cluster"><div className="hud-pill"><span className="hud-label">Wave</span><span className="hud-value">{currentWave?.index ?? 6}/6</span></div><div className="hud-pill"><span className="hud-label">남은 시간</span><span className={`hud-value ${timeRemaining < 10 && phase === "combat" ? "danger" : ""}`}>{formatTime(timeRemaining)}</span></div></div>
              <div className="hud-pill base-health"><div className="health-line"><span className="hud-label">기지 HP</span><span className="hud-value">{Math.ceil(snapshot.baseHp)}</span></div><div className="mini-meter"><div className="meter-fill" style={{ width: `${Math.max(0, snapshot.baseHp)}%` }} /></div></div>
            </div>
            <div className="battle-status"><div className="spawn-summary">아군 {snapshot.allies.length} · 적 {snapshot.enemies.length} · {currentWave?.name}</div><span className="speed-badge">×1</span></div>
          </div>
          <div className="xp-strip"><span className="level-orb">{snapshot.playerLevel}</span><div className="xp-meter"><div className="xp-fill" style={{ width: `${xpRatio}%` }} /></div><span className="xp-copy">{snapshot.playerLevel >= MAX_PLAYER_LEVEL ? "MAX" : `${snapshot.playerXp}/${nextXp}`}</span></div>
          {(phase === "preparation" || phase === "transition" || manualPaused) && <div className="battle-overlay"><div className="battle-overlay-card"><strong>{phase === "preparation" ? `${currentWave?.index} 웨이브 준비` : phase === "transition" ? "전선 정리 중…" : "일시정지"}</strong><p>{phase === "preparation" ? "캐릭터 옆에 무기를 붙이면 그 무기를 든 일꾼이 생성돼요." : phase === "transition" ? "살아남은 일꾼이 복귀하고 자동 합성을 확인합니다." : "준비되면 상단의 재생 버튼을 눌러 주세요."}</p></div></div>}
        </section>

        <section className="command-panel" aria-label="가방 편성">
          <div className="panel-heading"><div className="heading-group"><span className="section-kicker">Formation</span><h2 className="section-title">전투 가방 · 6×4</h2></div><span className={isLocked ? "lock-chip" : "phase-chip"}>{isLocked ? "🔒" : "◆"} {phaseLabel(phase)}</span></div>
          <div className="backpack-frame">
            <svg className="inventory-links" viewBox="0 0 6 4" preserveAspectRatio="none" aria-hidden="true">{connections.map(({ character, weapon }) => character.position && weapon.position && <line key={`${character.id}-${weapon.id}`} className="inventory-link" x1={character.position.col + 0.5} y1={character.position.row + 0.5} x2={weapon.position.col + 0.5} y2={weapon.position.row + 0.5} />)}</svg>
            <div className="inventory-grid">
              {Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_, index) => {
                const position: GridPosition = { row: Math.floor(index / GRID_COLUMNS), col: index % GRID_COLUMNS };
                const item = getGridItemAt(gridItems, position);
                const target = `grid:${position.row}:${position.col}`;
                const canPlaceSelected = !item && selectedItem?.origin === "queue" && phase === "preparation";
                const placeSelected = () => {
                  if (canPlaceSelected) completeDrop(selectedItem.item.id, "queue", target);
                };
                return <div key={target} className={`grid-cell ${dropTarget === target ? "drop-target" : ""}`} data-drop-target={target} role={canPlaceSelected ? "button" : undefined} tabIndex={canPlaceSelected ? 0 : undefined} onClick={canPlaceSelected ? placeSelected : undefined} onKeyDown={canPlaceSelected ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); placeSelected(); } } : undefined}>{item && renderItem(item, "grid")}</div>;
              })}
            </div>
          </div>

          <div className="queue-panel" data-drop-target="queue"><div className="queue-heading"><div><span className="section-kicker">Next wave</span><h3 className="section-title">보상 대기열</h3></div><span className="queue-count">{pendingRewards.length}개</span></div><div className="reward-queue">{pendingRewards.length ? pendingRewards.map((item) => renderItem(item, "queue")) : <div className="queue-empty">레벨업 보상이 여기에 쌓여요</div>}</div></div>

          {selectedDetail ? <article className="detail-card" style={itemStyle(selectedDetail)}><div className="detail-icon" aria-hidden="true">{selectedDetail.icon}</div><div className="detail-content"><div className="detail-title-row"><h3 className="detail-title">{selectedDetail.name}</h3><span className="detail-tag">T{selectedItem?.item.tier} · {selectedDetail.kind === "character" ? "캐릭터" : "무기"}</span></div><p className="detail-description">{selectedDetail.description}</p><p className="detail-links">{selectedItem?.origin === "queue" ? "대기 중 · 빈 칸을 누르거나 드래그해 배치" : selectedDetail.kind === "character" ? `다음 생성 무기: ${linkedNames.join(", ") || "맨손"}` : `공유 캐릭터: ${linkedNames.join(", ") || "없음"}`}</p></div></article> : <article className="detail-card"><div className="detail-icon">?</div><div className="detail-content"><h3 className="detail-title">아이템을 선택해 보세요</h3><p className="detail-description">캐릭터의 다음 생성 장비와 무기의 공유 대상을 확인할 수 있어요.</p></div></article>}

          <div className="action-row"><button type="button" className="primary-action" disabled={phase !== "preparation"} onClick={startWave}>{phase === "preparation" ? `${currentWave?.index} 웨이브 출격` : phase === "combat" ? "전투 진행 중" : "정리 중"}</button><button type="button" className="secondary-action" onClick={() => showToast(`현재 시드: ${seed}`)}>#</button></div>
        </section>

        <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.tone === "normal" ? "" : toast.tone}`}>{toast.copy}</div>)}</div>
        {drag?.moved && <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>{renderItem((gridItems.find((item) => item.id === drag.id) ?? pendingRewards.find((item) => item.id === drag.id))!, drag.origin)}</div>}

        {phase === "level-up" && currentLevel && <div className="modal-backdrop"><section className="level-modal" role="dialog" aria-modal="true" aria-labelledby="level-title"><span className="modal-kicker">Level {currentLevel}</span><h2 className="modal-title" id="level-title">레벨 업!</h2><p className="modal-copy">전투가 완전히 멈췄습니다. 다음 웨이브에 쓸 보상 하나를 고르세요.</p><div className="reward-options">{rewardOptions.map((id) => { const definition = ITEM_DEFINITIONS[id]; return <button type="button" className="reward-option" style={itemStyle(definition)} key={id} onClick={() => chooseReward(id)}><span className="reward-icon">{definition.icon}</span><strong className="reward-name">{definition.name}</strong><span className="reward-kind">{definition.kind === "character" ? "캐릭터" : "무기"} · T1</span><p className="reward-description">{definition.description}</p></button>; })}</div></section></div>}

        {report && (phase === "victory" || phase === "defeat") && <div className="modal-backdrop"><section className={`report-modal ${report.result}`} role="dialog" aria-modal="true" aria-labelledby="report-title"><div className="report-hero"><div className="report-emblem">{report.result === "victory" ? "🏆" : "🛡️"}</div><span className="modal-kicker">Run complete</span><h2 className="modal-title" id="report-title">{report.result === "victory" ? "보스를 쓰러뜨렸어요!" : "기지를 지키지 못했어요"}</h2><p className="modal-copy">{report.result === "victory" ? "인접 배치가 훌륭한 부대를 만들었습니다." : "배치를 바꿔 같은 시드에 다시 도전해 보세요."}</p></div><div className="report-grid"><div className="report-stat"><span>웨이브</span><strong>{report.reachedWave}/6</strong></div><div className="report-stat"><span>전투 시간</span><strong>{formatTime(report.combatTime)}</strong></div><div className="report-stat"><span>기지 HP</span><strong>{Math.round(report.baseHp)}</strong></div></div><div className="report-section"><h3 className="report-section-title">캐릭터 생성</h3><ul className="report-list">{Object.entries(report.characterSpawns).map(([id, value]) => <li key={id}><span>{ITEM_DEFINITIONS[id as ItemId]?.name ?? id}</span><strong>{value}명</strong></li>)}</ul></div><div className="report-section"><h3 className="report-section-title">무기별 피해</h3><ul className="report-list">{Object.entries(report.weaponDamage).map(([id, value]) => <li key={id}><span>{ITEM_DEFINITIONS[id as ItemId]?.name ?? id}</span><strong>{Math.round(value)}</strong></li>)}</ul></div><div className="report-actions"><button type="button" className="primary-action" onClick={() => resetRun(report.seed)}>같은 시드로 다시 도전</button><button type="button" className="text-action" onClick={() => resetRun(`run-${Date.now().toString(36)}`)}>새 시드 시작</button><button type="button" className="text-action" onClick={copyReport}>한국어 결과 복사</button></div></section></div>}

        {copyFallback && <div className="modal-backdrop"><section className="copy-modal" role="dialog" aria-modal="true" aria-labelledby="copy-title"><h2 className="modal-title" id="copy-title">결과를 직접 복사해 주세요</h2><p className="modal-copy">브라우저가 클립보드 접근을 막았습니다. 아래 텍스트를 길게 눌러 복사할 수 있어요.</p><textarea className="copy-textarea" readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="primary-action" onClick={() => setCopyFallback(null)}>닫기</button></section></div>}
      </section>
      <div className="landscape-guard"><div className="landscape-card"><span className="landscape-icon">📱</span><strong>세로 화면으로 돌려 주세요</strong><p>가방 배치와 전투를 한눈에 보려면 세로 화면이 가장 편합니다.</p></div></div>
    </main>
  );
}
