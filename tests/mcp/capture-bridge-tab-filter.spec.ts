/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Sapoto Tracer #1154 (Unit I) — MCP-level background-target URL filter.
 *
 * When ADF's orchestrator-side `backgroundOpenBridge` spawns a hidden CDP
 * target via `Target.createTarget({ url: 'about:blank#__sapoto_bg=V1:...' })`,
 * that target is an implementation detail of the capture stack and MUST NOT
 * surface in the agent-visible `browser_tabs` listing.
 *
 * Strategy: launch a real chromium CDP server, attach MCP via
 * `--cdp-endpoint` with `--capture-bridge`, then use a SEPARATE CDP
 * connection to spawn a hidden target whose URL carries the marker
 * fragment (mirroring the production ADF flow). MCP's `browser_tabs` must
 * not show that target.
 *
 * The filter lives in `_onPageCreated` in
 * `packages/playwright-core/src/tools/backend/context.ts` and reads the
 * URL at page-construction time — that's the moment when the
 * `Target.createTarget`-supplied URL is still in place before the
 * orchestrator's Phase 3 `Page.navigate` replaces it with the real
 * download URL.
 */

import { test, expect } from './fixtures';

test('background-target URLs are excluded from browser_tabs when --capture-bridge is set', async ({ cdpServer, startClient }) => {
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--capture-bridge'] });

  // Spawn a hidden CDP target through the underlying browser, matching the
  // real ADF backgroundOpenBridge.ts flow: Target.createTarget with the
  // marker URL fragment. MCP's _onPageCreated must observe the marker
  // and skip pushing the page into _tabs.
  const cdpSession = await browserContext.newCDPSession(browserContext.pages()[0]);
  const markerUrl = `about:blank#__sapoto_bg=V1:test-${Date.now()}`;
  await cdpSession.send('Target.createTarget', { url: markerUrl });

  // Give Playwright's page event listener a moment to fire.
  await new Promise(resolve => setTimeout(resolve, 200));

  const listResult = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  const text = JSON.stringify(listResult);
  // The marker URL must NOT appear in the agent-visible tab listing.
  expect(text).not.toContain('__sapoto_bg=V1:');
});

test('background-target hidden status survives navigation away from the marker URL', async ({ cdpServer, startClient }) => {
  // Adversarial-review fix: the filter reads page.url() ONCE at creation
  // time. In production, the orchestrator does
  // `Target.createTarget({ url: 'about:blank#__sapoto_bg=V1:N' })` followed
  // by `Page.navigate(realUrl)` — once the navigation lands, the marker URL
  // is gone. A future "live URL lookup" refactor would let the target
  // resurface in `browser_tabs`. This test pins the invariant: marker URL
  // at creation → permanently hidden, regardless of subsequent navigation.
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--capture-bridge'] });

  const cdpSession = await browserContext.newCDPSession(browserContext.pages()[0]);
  const markerUrl = `about:blank#__sapoto_bg=V1:persist-${Date.now()}`;
  await cdpSession.send('Target.createTarget', { url: markerUrl });

  await new Promise(resolve => setTimeout(resolve, 200));

  // Confirm initial hide.
  let listResult = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  expect(JSON.stringify(listResult)).not.toContain('__sapoto_bg=V1:');

  // Navigate the spawned target away from the marker URL — mirroring ADF's
  // Phase 3 `Page.navigate` flow. After this, page.url() no longer contains
  // the marker; the hide invariant must STILL hold via the per-page flag.
  const spawnedPage = browserContext.pages().find(p => p.url().includes('__sapoto_bg=V1:'));
  expect(spawnedPage).toBeTruthy();
  await spawnedPage!.goto('data:text/html,<title>navigated</title><body>real</body>').catch(() => {});

  await new Promise(resolve => setTimeout(resolve, 200));

  // After navigation, the marker URL is gone from page.url() — the target
  // must STILL be hidden. This is the invariant under test.
  listResult = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  const text = JSON.stringify(listResult);
  expect(text).not.toContain('__sapoto_bg=V1:');
  expect(text).not.toContain('navigated');
  expect(text).not.toContain('data:text/html');
});

test('without --capture-bridge, background-target URLs are visible (filter is opt-in)', async ({ cdpServer, startClient }) => {
  // Sanity check: the filter MUST be gated on the CLI flag, so older
  // unflagged clients see the marker URL like any other tab. This prevents
  // a stealth-by-default leak in stock MCP configurations.
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  const cdpSession = await browserContext.newCDPSession(browserContext.pages()[0]);
  const markerUrl = `about:blank#__sapoto_bg=V1:visible-${Date.now()}`;
  await cdpSession.send('Target.createTarget', { url: markerUrl });

  await new Promise(resolve => setTimeout(resolve, 200));

  const listResult = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  const text = JSON.stringify(listResult);
  expect(text).toContain('__sapoto_bg=V1:');
});
