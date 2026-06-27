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
 * Sapoto Tracer #1156 (Unit K) — browser_trigger_print smoke tests.
 *
 * Four scenarios:
 *
 *   1. WITHOUT --capture-bridge: tool fails fast instead of invoking native
 *      print.
 *
 *   2. WITH --capture-bridge: Unit I's init script wraps window.print to
 *      route through electronAPI.requestPrintCapture. We can't inject a
 *      real Electron preload bridge, but we CAN install a stub
 *      `window.electronAPI = { requestPrintCapture: fn }` via a navigation
 *      to a data: URL that pre-defines the global. Then trigger the tool
 *      and verify the page's recorded call count was incremented via
 *      `browser_evaluate`.
 *
 *   3. WITH --capture-bridge and an already-loaded CDP page: startup patches
 *      the current document so trigger-print cannot fall through to native
 *      Chromium print preview.
 *
 *   4. WITH --capture-bridge and an already-loaded CDP iframe: startup also
 *      patches existing child frames so in-frame print affordances route to
 *      the parent bridge.
 */

import { test, expect, parseResponse } from './fixtures';

type PrintTestWindow = Window & {
  __printCalls?: Array<{ scope: string }>;
};

function tabIndexForUrl(tabsText: string, urlPart: string): number {
  const line = tabsText.split('\n').find(line => line.includes(urlPart));
  expect(line).toBeTruthy();
  return Number(line!.match(/^- (\d+):/)![1]);
}

test('browser_trigger_print fails fast without capture-bridge', async ({ startClient, server }) => {
  const { client } = await startClient();
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  const result = await client.callTool({
    name: 'browser_trigger_print',
  });

  expect(result.isError).toBeTruthy();
  expect(JSON.stringify(result)).toContain('Sapoto capture bridge is not installed');
});

test('browser_trigger_print routes through electronAPI.requestPrintCapture when bridge is present', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--capture-bridge'] });

  // Set up a page that installs a fake electronAPI bridge BEFORE the
  // capture-bridge init script runs. We use a data: URL whose <head>
  // script defines the global synchronously; the Unit I init script runs
  // after this (it's installed via addInitScript at context level, but
  // for an inline page-script the order is: addInitScript first, THEN
  // page <head> scripts). To verify the bridge call we instead set up
  // electronAPI from page script and verify the C4 fast-path picks it up
  // via parent-walk.
  //
  // Because Playwright's init scripts run before any page script, we set
  // up the fake electronAPI inside the data: URL's <head> AND we use a
  // counter on `window` we can poll after the call.
  const html = `data:text/html,<!doctype html><html><head><script>
    window.__printCalls = [];
    window.electronAPI = {
      requestPrintCapture: function(payload) {
        window.__printCalls.push(payload);
      }
    };
  </script></head><body><h1>Print bridge test</h1></body></html>`;

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: html },
  });

  const result = await client.callTool({
    name: 'browser_trigger_print',
  });
  expect(result.isError).toBeFalsy();

  // Verify the bridge was actually called. The C4 synchronous fast-path
  // dispatches to electronAPI.requestPrintCapture on every window.print()
  // — even if the bridge installs AFTER the init script wraps print,
  // because C4 walks parents at dispatch time.
  const probe = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => ({ count: window.__printCalls?.length ?? 0, scope: window.__printCalls?.[0]?.scope })`,
    },
  });
  // The eval result is rendered as a "### Result" section containing
  // pretty-printed JSON. Extract the text section and inspect it
  // directly rather than chasing JSON.stringify escape levels.
  const probeText = (probe.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  expect(probeText).toContain('"count": 1');
  expect(probeText).toContain('top-frame');
});

test('browser_trigger_print routes through capture bridge on an already-loaded CDP page', async ({ cdpServer, startClient, server }) => {
  server.setContent('/existing-print', `
    <title>Existing print page</title>
    <script>
      window.__printCalls = [];
      window.electronAPI = {
        requestPrintCapture: function(payload) {
          window.__printCalls.push(payload);
        }
      };
    </script>
    <body><h1>Existing print page</h1></body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const [existingPage] = browserContext.pages();
  await existingPage.goto(`${server.PREFIX}/existing-print`);
  expect(await existingPage.evaluate(() => (window as PrintTestWindow).__printCalls?.length ?? 0)).toBe(0);

  const { client } = await startClient({
    args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--capture-bridge'],
  });
  const tabs = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const pageIndex = tabIndexForUrl(parseResponse(tabs, test.info().outputPath()).result!, '/existing-print');
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: pageIndex, activate: true } });

  const result = await client.callTool({
    name: 'browser_trigger_print',
  });
  expect(result.isError).toBeFalsy();

  await expect.poll(() => existingPage.evaluate(() => (window as PrintTestWindow).__printCalls?.length ?? 0)).toBe(1);
  expect(await existingPage.evaluate(() => (window as PrintTestWindow).__printCalls?.[0]?.scope)).toBe('top-frame');
});

test('capture bridge patches already-loaded CDP child frames', async ({ cdpServer, startClient, server }) => {
  server.setContent('/existing-frame-print-parent', `
    <title>Existing frame parent</title>
    <script>
      window.__printCalls = [];
      window.electronAPI = {
        requestPrintCapture: function(payload) {
          window.__printCalls.push(payload);
        }
      };
    </script>
    <body><iframe id="statement" src="/existing-frame-print-child"></iframe></body>
  `, 'text/html');
  server.setContent('/existing-frame-print-child', `
    <title>Existing frame child</title>
    <body><button onclick="window.print()">Print</button></body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const [existingPage] = browserContext.pages();
  await existingPage.goto(`${server.PREFIX}/existing-frame-print-parent`);
  const childFrame = existingPage.frames().find(frame => frame.url().includes('/existing-frame-print-child'));
  expect(childFrame).toBeTruthy();

  const { client } = await startClient({
    args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--capture-bridge'],
  });
  const tabs = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const pageIndex = tabIndexForUrl(parseResponse(tabs, test.info().outputPath()).result!, '/existing-frame-print-parent');
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: pageIndex, activate: true } });
  await expect.poll(() => childFrame!.evaluate(() => {
    const source = Function.prototype.toString.call(window.print);
    return source.includes('_emitPrintMarker') && source.includes('_c3Deferred');
  })).toBe(true);
  await childFrame!.evaluate(() => window.print());

  await expect.poll(() => existingPage.evaluate(() => (window as PrintTestWindow).__printCalls?.length ?? 0)).toBe(1);
  expect(await existingPage.evaluate(() => (window as PrintTestWindow).__printCalls?.[0]?.scope)).toBe('iframe');
});
