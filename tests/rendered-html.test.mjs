import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/?seed=prototype-001", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Korean game shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="ko"/i);
  assert.match(html, /<title>일꾼 키우기 \| 백팩 자동전투<\/title>/i);
  assert.match(html, /일꾼 키우기/);
  assert.match(html, /가방|준비|전투/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});

test("keeps the inventory UI still and direct", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /class="linked-mark"[^>]*>○</);
  assert.match(html, /웨이브 1/);
  assert.match(html, />웨이브 시작</);
  assert.doesNotMatch(html, /inventory-links|inventory-link|linked-dot/);
  assert.doesNotMatch(html, /보상 대기열|레벨업 보상이 여기에 쌓여요/);
  assert.doesNotMatch(html, /웨이브 출격|class="action-row"|전투 가방 · 6×4|class="detail-card"|>\s*#\s*<\/button>/);
});

test("keeps compact overlays readable on narrow screens", async () => {
  const [client, styles] = await Promise.all([
    readFile(new URL("../app/GameClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(client, /className="action-row"|전투가 완전히 멈췄습니다/);
  assert.match(client, /className="primary-action overlay-start-button"/);
  assert.match(client, /aria-label={`\$\{definition\.name\}, \$\{kind\} 티어 1\./);
  assert.match(client, /className="reward-details" role="tooltip"/);
  assert.match(client, /matchMedia\("\(hover: none\) and \(pointer: coarse\)"\)/);
  assert.match(styles, /\.battle-overlay-card\s*{[^}]*width: min\(350px, 100%\)/s);
  assert.match(styles, /\.hud-row\s*{[^}]*grid-template-columns:/s);
  assert.match(styles, /\.reward-option:focus-visible \.reward-details/);
  assert.match(styles, /\.reward-option\.previewing \.reward-details/);
});

test("keeps the battlefield zoomed out without camera shake or duplicate HUD", async () => {
  const renderer = await readFile(new URL("../lib/game/render.ts", import.meta.url), "utf8");

  assert.match(renderer, /const UNIT_VISUAL_SCALE = 2 \/ 3/);
  assert.doesNotMatch(renderer, /getCameraShake|drawBattleHud|context\.translate\(shake\.x/);
});

test("removes starter preview and keeps product metadata", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<GameClient \/>/);
  assert.match(layout, /lang="ko"/);
  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(packageJson, /"name": "worker-backpack-mvp"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
  await access(new URL("../.openai/hosting.json", import.meta.url));
  await access(root);
});
