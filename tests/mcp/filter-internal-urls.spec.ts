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
 * Sapoto Tracer #1155 (Unit G-ops) — MCP-level internal-URL tab filter.
 *
 * Sapoto's Electron host renders local UI panes via `file://` and
 * `data:` URLs that MUST NOT show up in `browser_tabs` — they are
 * embedder implementation detail, not pages the agent should drive.
 *
 * Mirrors the Unit I `capture-bridge-tab-filter.spec.ts` pattern:
 * launch a real chromium CDP server, attach MCP via `--cdp-endpoint`
 * with `--filter-internal-urls`, then use a SEPARATE CDP connection to
 * spawn a `data:` target. `browser_tabs` must not surface it.
 *
 * Also pins the "navigate-survives" invariant — once flagged as internal
 * at creation, a tab stays hidden even if it later navigates to a real
 * URL. This matches the WeakSet persistent-hide pattern Unit I introduced.
 */

import { test, expect } from './fixtures';

test('data: URLs are excluded from browser_tabs when --filter-internal-urls is set', async ({ cdpServer, startClient }) => {
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--filter-internal-urls'] });

  // Spawn a `data:` target through the underlying browser. MCP's
  // `_onPageCreated` must observe the data: prefix and skip pushing the
  // page into `_tabs`.
  const cdpSession = await browserContext.newCDPSession(browserContext.pages()[0]);
  const dataUrl = `data:text/html,<title>internal-${Date.now()}</title><body>internal</body>`;
  await cdpSession.send('Target.createTarget', { url: dataUrl });

  // Give Playwright's page event listener a moment to fire.
  await new Promise(resolve => setTimeout(resolve, 200));

  const listResult = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  const text = JSON.stringify(listResult);
  expect(text).not.toContain('data:text/html');
  expect(text).not.toContain('internal');
});

test('internal-tab hidden status survives navigation to a real URL', async ({ cdpServer, startClient, server }) => {
  // Invariant — the filter reads `page.url()` ONCE at creation time. If
  // the embedder later navigates an internal tab to a real URL, the tab
  // must STILL be hidden. WeakSet pin (`_hiddenBackgroundPages`) carries
  // the flag forward, symmetric with Unit I's background-target filter.
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--filter-internal-urls'] });

  const cdpSession = await browserContext.newCDPSession(browserContext.pages()[0]);
  const dataUrl = `data:text/html,<title>persist-${Date.now()}</title><body>data-marker</body>`;
  await cdpSession.send('Target.createTarget', { url: dataUrl });

  await new Promise(resolve => setTimeout(resolve, 200));

  // Confirm initial hide.
  let listResult = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  expect(JSON.stringify(listResult)).not.toContain('data-marker');

  // Navigate the data: target to a real http:// URL.
  const spawnedPage = browserContext.pages().find(p => p.url().startsWith('data:'));
  expect(spawnedPage).toBeTruthy();
  await spawnedPage!.goto(server.PREFIX + '/hello-world').catch(() => {});

  await new Promise(resolve => setTimeout(resolve, 200));

  // After navigation, the URL no longer matches the internal predicate —
  // but the WeakSet pin must keep the tab hidden.
  listResult = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  const text = JSON.stringify(listResult);
  expect(text).not.toContain('data-marker');
  expect(text).not.toContain('hello-world');
  expect(text).not.toContain('Hello, world!');
});

test('without --filter-internal-urls, data: URLs are visible (filter is opt-in)', async ({ cdpServer, startClient }) => {
  // Sanity check — the filter MUST be gated on the CLI flag, so older
  // unflagged clients see internal URLs like any other tab. Prevents a
  // visibility regression in stock MCP configurations.
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  const cdpSession = await browserContext.newCDPSession(browserContext.pages()[0]);
  const dataUrl = `data:text/html,<title>visible-${Date.now()}</title><body>data-visible</body>`;
  await cdpSession.send('Target.createTarget', { url: dataUrl });

  await new Promise(resolve => setTimeout(resolve, 200));

  const listResult = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  const text = JSON.stringify(listResult);
  expect(text).toContain('data:text/html');
});
