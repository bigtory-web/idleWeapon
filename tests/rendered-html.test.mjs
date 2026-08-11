import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/?seed=prototype-001", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Korean game shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html[^>]*lang="ko"/i);
  assert.match(html, /<span>웨이브<\/span><strong>1/);
  assert.match(html, /제한 시간/);
  assert.match(html, /aria-label="전투 배속"/);
  assert.match(html, /class="inventory-grid"/);
  assert.doesNotMatch(html, /BACKPACK BATTALION|LEVEL|레벨 업|>XP</);
});

test("header speed, canvas base health, and direct-purchase shop replace old HUD controls", async () => {
  const [client, renderer] = await Promise.all([
    readFile(new URL("../app/GameClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/game/render.ts", import.meta.url), "utf8"),
  ]);
  assert.match(client, /className="header-combat-info"/);
  assert.match(client, /className="speed-controls"/);
  assert.match(client, /\(\[0\.5, 1, 2\] as const\)/);
  assert.match(client, /className="shop-panel"/);
  assert.match(client, /className="shop-buy-button"/);
  assert.match(client, /`\$\{offer\.price\}골드 구매`/);
  assert.match(client, /generateShopOffers/);
  assert.match(client, /purchaseShopOffer/);
  assert.match(renderer, /기지 HP \$\{Math\.ceil\(snapshot\.baseHp\)\}\/\$\{snapshot\.maxBaseHp\}/);
  assert.doesNotMatch(client, /className="base-hp-strip"|className="gold-balance"|className="shop-selection"|다음 전투를 준비하세요/);
  assert.doesNotMatch(client, /playerXp|playerLevel|level-up|level-modal|reward-options|selectedOfferId/);
});

test("inventory uses a 38px 7x5 board, continuous footprints, fixed help, and no rotation sheen", async () => {
  const [client, styles] = await Promise.all([
    readFile(new URL("../app/GameClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(client, /snapshot\.spawners\.find\(\(entry\) => entry\.id === item\.id\)/);
  assert.match(client, /className="spawn-cooldown-fill"/);
  assert.match(client, /className={`connection-mark connection-/);
  assert.match(client, /<span className="item-icon">\{definition\.icon\}<\/span>/);
  assert.match(client, /className="character-name-mini"/);
  assert.match(client, /"item-segment",/);
  assert.match(client, /equipped-weapon-mini/);
  assert.match(client, /equipped-weapon-mini-\$\{index\}/);
  assert.match(client, /className="fixed-hover-help"/);
  assert.match(client, /getActiveWeaponConnections/);
  assert.match(client, /className="socket-target-mark"/);
  assert.match(client, /장착 패널티/);
  assert.match(client, /const dragRef = useRef<DragState \| null>/);
  assert.match(client, /const dropTargetRef = useRef<string \| null>/);
  assert.match(client, /const finalTarget = element\?\.dataset\.dropTarget \?\? dropTargetRef\.current/);
  assert.match(client, /renderItem\(gridItems\.find\(\(item\) => item\.id === drag\.id\)!\, \{ dragGhost: true \}\)/);
  assert.match(client, /○가 향한 칸에 캐릭터를 맞대세요/);
  assert.match(client, /티어와 관계없이 모두 장착돼요/);
  assert.doesNotMatch(client, /무기 슬롯|초과는 회색|selected-detail-panel|CharacterGlyph|reconcileEquipmentLinks/);
  assert.doesNotMatch(client, /className="tier-badge"|className="item-name-mini"/);
  assert.match(styles, /\.tier-1[^{}]*\{[^}]*#aeb3bc/s);
  assert.match(styles, /\.tier-2[^{}]*\{[^}]*#5bc9ff/s);
  assert.match(styles, /\.tier-3[^{}]*\{[^}]*#ffd15e/s);
  assert.match(styles, /\.socket-target-cell/);
  assert.match(styles, /\.grid-item\.linked-active/);
  assert.match(styles, /\.grid-item \.item-card\s*\{[^}]*gap:\s*0/s);
  assert.match(styles, /\.item-segment\.edge-top/);
  assert.match(styles, /\.item-segment\.edge-right/);
  assert.match(styles, /\.equipped-weapon-mini-3/);
  assert.match(styles, /--board-cell:\s*min\(38px/);
  assert.match(styles, /grid-template-columns:\s*repeat\(7, var\(--board-cell\)\)/);
  assert.match(styles, /grid-template-rows:\s*repeat\(5, var\(--board-cell\)\)/);
  assert.match(styles, /\.inventory-grid \.grid-cell:nth-child\(odd\)/);
  assert.match(styles, /\.fixed-hover-help/);
  assert.doesNotMatch(client, /rotateGridItem|selectedWeaponId|rotate-item-button|inventory-item-details|spawn-linked-flash/);
  assert.doesNotMatch(styles, /spawn-sheen|spawn-linked-flash|inventory-item-details|rotate-item-button|inventory-action-row|\.grid-item\.rotation-selected/);
  assert.doesNotMatch(styles, /\.selected-detail-panel|\.character-glyph/);
  assert.match(styles, /\.command-panel\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(styles, /\.drag-ghost \.grid-item\s*\{[^}]*inset:\s*0/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("result screen keeps only the fresh-seed restart action", async () => {
  const client = await readFile(new URL("../app/GameClient.tsx", import.meta.url), "utf8");
  const reportMarkup = client.slice(client.indexOf('className={`report-modal'), client.indexOf('className="landscape-guard"'));
  assert.match(reportMarkup, /새 시드 시작/);
  assert.doesNotMatch(reportMarkup, /같은 시드로 다시 도전|한국어 결과 복사|구매 내역|캐릭터 생성/);
});

test("renderer uses a uniform 2.5D projection and density limits", async () => {
  const renderer = await readFile(new URL("../lib/game/render.ts", import.meta.url), "utf8");
  assert.match(renderer, /export function projectBattlePoint/);
  assert.match(renderer, /const scale = Math\.min\(context\.canvas\.width \/ width, context\.canvas\.height \/ height\)/);
  assert.match(renderer, /units\.length > 55/);
  assert.match(renderer, /152 \+ depth \* 174/);
  assert.match(renderer, /0\.55 \+ depth \* 0\.22/);
  assert.match(renderer, /ALLY_DEPLOY_Y_MAX - ALLY_DEPLOY_Y_MIN/);
  assert.match(renderer, /drawSpawnerPlatform/);
  assert.match(renderer, /drawAbsorbingWeapon/);
  assert.match(renderer, /getSpawnArrivalProgress/);
  assert.doesNotMatch(renderer, /createLinearGradient\(effect\.x, 76/);
  assert.match(renderer, /unit\.isBoss \? 1\.45 : 1/);
  assert.match(renderer, /#ff5d63/);
  assert.match(renderer, /#57d9dc/);
  assert.doesNotMatch(renderer, /context\.scale\(scaleX, scaleY\)/);
});

test("keeps Sites metadata and the production build entrypoints", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<GameClient \/>/);
  assert.match(layout, /lang="ko"/);
  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(packageJson, /"name": "worker-backpack-mvp"/);
  await access(new URL("../.openai/hosting.json", import.meta.url));
  await access(root);
});
