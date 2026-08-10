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
  assert.match(html, /기지 HP<\/span><strong>100/);
  assert.doesNotMatch(html, /BACKPACK BATTALION|LEVEL|레벨 업|>XP</);
});

test("header, base health, and shop replace the old combat HUD and rewards", async () => {
  const client = await readFile(new URL("../app/GameClient.tsx", import.meta.url), "utf8");
  assert.match(client, /className="header-combat-info"/);
  assert.match(client, /className="base-hp-strip"/);
  assert.match(client, /className="shop-panel"/);
  assert.match(client, /generateShopOffers/);
  assert.match(client, /purchaseShopOffer/);
  assert.doesNotMatch(client, /playerXp|playerLevel|level-up|level-modal|reward-options/);
});

test("inventory uses tier borders, connection marks, actual cooldown, and spawn flashes", async () => {
  const [client, styles] = await Promise.all([
    readFile(new URL("../app/GameClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(client, /snapshot\.spawners\.find\(\(entry\) => entry\.id === item\.id\)/);
  assert.match(client, /className="spawn-cooldown-fill"/);
  assert.match(client, /className={`connection-mark connection-/);
  assert.match(client, /character-glyph character-glyph-\$\{id\}/);
  assert.match(client, /className="item-segment"/);
  assert.match(client, /className="segment-character-icon"/);
  assert.match(client, /className="rotate-item-button"/);
  assert.match(client, /reconcileEquipmentLinks/);
  assert.match(client, /getActiveWeaponConnections/);
  assert.match(client, /className="socket-target-mark"/);
  assert.match(client, /무기 슬롯/);
  assert.match(client, /장착 패널티/);
  assert.doesNotMatch(client, /className="tier-badge"|className="item-name-mini"/);
  assert.match(styles, /\.tier-1[^{}]*\{[^}]*#aeb3bc/s);
  assert.match(styles, /\.tier-2[^{}]*\{[^}]*#5bc9ff/s);
  assert.match(styles, /\.tier-3[^{}]*\{[^}]*#ffd15e/s);
  assert.match(styles, /@keyframes spawn-sheen/);
  assert.match(styles, /\.socket-target-cell/);
  assert.match(styles, /\.grid-item\.linked-active/);
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
  assert.match(renderer, /0\.624 \+ depth \* 0\.168/);
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
