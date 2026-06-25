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

import fs from 'fs';
import path from 'path';

import { test, expect, parseResponse } from './fixtures';
import { PNG } from '../../packages/playwright-core/lib/utilsBundle';
import { buildOverlayScript } from '../../packages/playwright-core/src/tools/backend/agentSessionOverlay';

const HOST_SELECTOR = 'sapoto-mcp-agent-session-overlay';

async function overlayState(client: any) {
  const response = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => {
        const host = document.querySelector('${HOST_SELECTOR}');
        return {
          count: document.querySelectorAll('${HOST_SELECTOR}').length,
          exists: !!host,
          ariaHidden: host?.getAttribute('aria-hidden') ?? null,
          display: host ? getComputedStyle(host).display : null,
          pointerEvents: host ? getComputedStyle(host).pointerEvents : null,
          zIndex: host ? getComputedStyle(host).zIndex : null,
          shadowRootIsClosed: host ? !host.shadowRoot : null,
        };
      }`,
    },
  });
  return JSON.parse(parseResponse(response, test.info().outputPath()).result!);
}

async function pageOverlayState(page: any) {
  return await page.evaluate((hostSelector: string) => {
    const host = document.querySelector(hostSelector);
    return {
      count: document.querySelectorAll(hostSelector).length,
      display: host ? getComputedStyle(host).display : null,
    };
  }, HOST_SELECTOR);
}

function tabIndexForUrl(tabsText: string, urlPart: string): number {
  const line = tabsText.split('\n').find(line => line.includes(urlPart));
  expect(line).toBeTruthy();
  return Number(line!.match(/^- (\d+):/)![1]);
}

function newestPng(outputDir: string): Buffer {
  const files = fs.readdirSync(outputDir).filter(file => file.endsWith('.png')).sort();
  expect(files.length).toBeGreaterThan(0);
  return fs.readFileSync(path.join(outputDir, files[files.length - 1]));
}

function countWarmOverlayPixels(buffer: Buffer): number {
  const png = PNG.sync.read(buffer);
  return countOrangePixelsInRect(png, 0, 0, png.width, png.height);
}

function countOrangePixelsInRect(png: PNG, minX: number, minY: number, maxX: number, maxY: number): number {
  let orange = 0;
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const idx = (png.width * y + x) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      if (r > 200 && g > 60 && g < 180 && b < 90)
        orange += 1;
    }
  }
  return orange;
}

function countOrangeComponentsInRect(png: PNG, minX: number, minY: number, maxX: number, maxY: number): number {
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  const seen = new Uint8Array(width * height);
  const isOrange = (x: number, y: number) => {
    const idx = (png.width * y + x) * 4;
    const r = png.data[idx];
    const g = png.data[idx + 1];
    const b = png.data[idx + 2];
    return r > 200 && g > 60 && g < 180 && b < 90;
  };
  let components = 0;
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const start = (y - minY) * width + (x - minX);
      if (seen[start] || !isOrange(x, y))
        continue;
      components++;
      const queue = [[x, y]];
      seen[start] = 1;
      for (let i = 0; i < queue.length; i++) {
        const [cx, cy] = queue[i];
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < minX || nx >= maxX || ny < minY || ny >= maxY)
            continue;
          const offset = (ny - minY) * width + (nx - minX);
          if (seen[offset] || !isOrange(nx, ny))
            continue;
          seen[offset] = 1;
          queue.push([nx, ny]);
        }
      }
    }
  }
  return components;
}

function warmPixelBoundsAwayFromBorder(png: PNG): { count: number, minX: number, minY: number, maxX: number, maxY: number } {
  let count = 0;
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 24; y < png.height - 24; y++) {
    for (let x = 24; x < png.width - 24; x++) {
      const idx = (png.width * y + x) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      if (r <= 180 || g <= 90 || g >= 220 || b >= 120)
        continue;
      count++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { count, minX, minY, maxX, maxY };
}

test('agent-session overlay is visible to the live page but hidden from browser_snapshot', async ({ startClient, server }) => {
  const { client } = await startClient();
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  expect(await overlayState(client)).toEqual({
    count: 1,
    exists: true,
    ariaHidden: 'true',
    display: 'block',
    pointerEvents: 'none',
    zIndex: '2147483647',
    shadowRootIsClosed: true,
  });

  expect(await client.callTool({ name: 'browser_snapshot' })).toHaveResponse({
    snapshot: expect.not.stringContaining('Stop'),
  });
});

test('agent-session overlay is idempotent across navigation and heals host removal', async ({ startClient, server }) => {
  const { client } = await startClient();
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect((await overlayState(client)).count).toBe(1);

  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => document.querySelector('${HOST_SELECTOR}')?.remove()`,
    },
  });

  await expect.poll(async () => (await overlayState(client)).count).toBe(1);
});

test('browser_take_screenshot hides the agent-session overlay during capture', async ({ startClient }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<!doctype html><html><body style="margin:0;background:#000"><main style="height:100vh"></main></body></html>',
    },
  });
  expect((await overlayState(client)).exists).toBe(true);

  await client.callTool({ name: 'browser_take_screenshot' });

  expect(countWarmOverlayPixels(newestPng(outputDir))).toBe(0);
  expect((await overlayState(client)).display).toBe('block');
});

test('agent-session overlay host controls do not expose the control token to monkeypatched page built-ins', async ({ startClient }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<!doctype html><html><body style="margin:0;background:#000"><main style="height:100vh"></main></body></html>',
    },
  });
  expect((await overlayState(client)).exists).toBe(true);

  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => {
        const stolenTokens = [];
        const wrappedHostControls = new WeakSet();
        window.__stolenOverlayControlTokens = stolenTokens;

        const reflectGet = Reflect.get;
        Reflect.get = function(target, propertyKey, receiver) {
          const value = reflectGet.apply(this, [target, propertyKey, receiver]);
          if ((propertyKey === 'hide' || propertyKey === 'show' || propertyKey === 'remove') && typeof value === 'function') {
            const wrapped = function(...args) {
              for (const arg of args) {
                if (typeof arg === 'string')
                  stolenTokens.push(arg);
              }
              return value.apply(this, args);
            };
            wrappedHostControls.add(wrapped);
            return wrapped;
          }
          return value;
        };

        const functionCall = Function.prototype.call;
        Function.prototype.call = function(thisArg, ...args) {
          if (wrappedHostControls.has(this)) {
            for (const arg of args) {
              if (typeof arg === 'string')
                stolenTokens.push(arg);
            }
          }
          return functionCall.apply(this, [thisArg, ...args]);
        };

        window.__restoreOverlayBuiltins = () => {
          Reflect.get = reflectGet;
          Function.prototype.call = functionCall;
        };
      }`,
    },
  });

  await client.callTool({ name: 'browser_take_screenshot' });

  const stolenTokensResponse = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => {
        const stolenTokens = window.__stolenOverlayControlTokens;
        window.__restoreOverlayBuiltins?.();
        return stolenTokens;
      }`,
    },
  });
  expect(JSON.parse(parseResponse(stolenTokensResponse, test.info().outputPath()).result!)).toEqual([]);
  expect(countWarmOverlayPixels(newestPng(outputDir))).toBe(0);
  expect((await overlayState(client)).display).toBe('block');
});

test('browser_take_screenshot first operation on a fresh tab does not capture the agent-session overlay', async ({ startClient }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });

  expect(await client.callTool({ name: 'browser_take_screenshot' })).toHaveResponse({
    code: expect.stringContaining(`await page.screenshot(`),
    result: expect.stringMatching(/\[Screenshot of viewport\]\(.*page-[^:]+.png\)/),
  });

  expect(countWarmOverlayPixels(newestPng(outputDir))).toBe(0);
  expect((await overlayState(client)).display).toBe('block');
});

test('browser_take_ocr_friendly_screenshot hides the agent-session overlay during capture', async ({ startClient }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<!doctype html><html><body style="margin:0;background:#000"><main style="height:100vh"></main></body></html>',
    },
  });
  expect((await overlayState(client)).exists).toBe(true);

  await client.callTool({
    name: 'browser_take_ocr_friendly_screenshot',
    arguments: { tileHeight: 2000 },
  });

  expect(countWarmOverlayPixels(newestPng(outputDir))).toBe(0);
  expect((await overlayState(client)).display).toBe('block');
});

test('browser_pdf_save restores the agent-session overlay after capture', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'Save as PDF is only supported in Chromium.');
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({
    config: { outputDir, capabilities: ['pdf'] },
  });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });
  expect((await overlayState(client)).exists).toBe(true);

  const result = await client.callTool({ name: 'browser_pdf_save' });
  expect(result.isError).toBeFalsy();
  expect((await overlayState(client)).display).toBe('block');
});

test('agent-session overlay skips hidden background marker targets', async ({ cdpServer, startClient }) => {
  const browserContext = await cdpServer.start();
  await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  const cdpSession = await browserContext.newCDPSession(browserContext.pages()[0]);
  const markerUrl = `data:text/html,<body>background</body>#__sapoto_bg=V1:overlay-${Date.now()}`;
  await cdpSession.send('Target.createTarget', { url: markerUrl });

  await expect.poll(() => browserContext.pages().some(page => page.url().includes('__sapoto_bg=V1:'))).toBe(true);

  const backgroundPage = browserContext.pages().find(page => page.url().includes('__sapoto_bg=V1:'))!;
  expect(await backgroundPage.locator(HOST_SELECTOR).count()).toBe(0);
});

test('agent-run overlay flag is accepted by the MCP runtime', async ({ startClient }) => {
  const { client } = await startClient({ args: ['--agent-run-overlay'] });

  const result = await client.callTool({ name: 'browser_snapshot' });
  expect(result.isError).toBeFalsy();
});

test('agent-run overlay paints one host with glow and a centered idle cursor before input', async ({ cdpServer, startClient }) => {
  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('data:text/html,<!doctype html><html><body style="margin:0;background:#050505"></body></html>');

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay'] });
  await client.callTool({ name: 'browser_snapshot' });

  await expect.poll(() => page.locator(HOST_SELECTOR).count()).toBe(1);
  const buffer = await page.screenshot();
  const png = PNG.sync.read(buffer);
  const centerOrangePixels = countOrangePixelsInRect(png, 190, 140, 214, 164);
  const edgeOrangePixels = countOrangePixelsInRect(png, 0, 0, png.width, 24) +
    countOrangePixelsInRect(png, 0, png.height - 24, png.width, png.height) +
    countOrangePixelsInRect(png, 0, 0, 24, png.height) +
    countOrangePixelsInRect(png, png.width - 24, 0, png.width, png.height);

  expect(centerOrangePixels).toBeGreaterThan(20);
  expect(edgeOrangePixels).toBeGreaterThan(200);
});

test('agent-run overlay emits a positive heartbeat while healthy', async ({ cdpServer, startClient, server }, testInfo) => {
  server.setContent('/heartbeat', `
    <title>Agent Run Overlay Heartbeat</title>
    <body style="margin:0;background:#050505"></body>
  `, 'text/html');
  const outputDir = testInfo.outputPath('output');
  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.goto(server.PREFIX + '/heartbeat');

  const { client } = await startClient({
    args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay'],
    config: { outputDir: 'output' },
  });
  const tabs = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const pageIndex = tabIndexForUrl(parseResponse(tabs, test.info().outputPath()).result!, '/heartbeat');
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: pageIndex, activate: true } });
  await client.callTool({ name: 'browser_snapshot' });
  await page.waitForTimeout(2000);
  await client.callTool({ name: 'browser_snapshot' });

  const logFiles = fs.readdirSync(outputDir).filter(file => file.startsWith('console-') && file.endsWith('.log'));
  expect(logFiles.length).toBeGreaterThan(0);
  const logContent = logFiles.map(file => fs.readFileSync(path.join(outputDir, file), 'utf8')).join('\n');
  expect(logContent).toContain('[SapotoAgentRunOverlay] heartbeat reason=activate');
  expect(logContent).toContain('authorized=true owned=true hostCount=1 visible=true');
  expect(logContent).toContain('cursorVisible=true cursorNode=true');
  expect(logContent).toContain('captureHidden=false currentTab=true');
});

test('agent-run overlay reinstall keeps one host and one idle cursor visual', async ({ cdpServer, startClient }) => {
  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('data:text/html,<!doctype html><html><body style="margin:0;background:#050505"></body></html>');

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay'] });
  await client.callTool({ name: 'browser_snapshot' });
  await expect.poll(() => page.locator(HOST_SELECTOR).count()).toBe(1);

  await page.evaluate(buildOverlayScript({ agentRunOverlay: true }));

  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  const png = PNG.sync.read(await page.screenshot());
  expect(countOrangePixelsInRect(png, 190, 140, 214, 164)).toBeGreaterThan(20);
  expect(countOrangePixelsInRect(png, 180, 130, 224, 174)).toBeLessThan(700);
});

test('agent-run overlay hides inactive controlled tabs', async ({ cdpServer, startClient, server }) => {
  server.setContent('/first', `
    <title>First</title>
    <body style="margin:0;background:#050505"></body>
  `, 'text/html');
  server.setContent('/second', `
    <title>Second</title>
    <body style="margin:0;background:#050505"></body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const firstPage = browserContext.pages()[0];
  await firstPage.goto(server.PREFIX + '/first');
  const secondPage = await browserContext.newPage();
  await secondPage.goto(server.PREFIX + '/second');

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay'] });
  const tabs = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const firstIndex = tabIndexForUrl(parseResponse(tabs, test.info().outputPath()).result!, '/first');
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: firstIndex, activate: true } });

  await expect.poll(async () => pageOverlayState(firstPage)).toEqual({ count: 1, display: 'block' });
  await expect.poll(async () => pageOverlayState(secondPage)).toEqual({ count: 1, display: 'none' });
});

test('agent-run overlay restores a clamped cursor after reload without duplicate hosts', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay Reload</title>
    <body style="margin:0;background:#050505;height:1600px">
      <script>
        document.addEventListener("wheel", event => {
          window.wheelPoint = [event.clientX, event.clientY];
        }, { passive: true });
      </script>
    </body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto(server.PREFIX);

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay', '--caps=vision'] });
  const tabs = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const pageIndex = tabIndexForUrl(parseResponse(tabs, test.info().outputPath()).result!, server.PREFIX);
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: pageIndex, activate: true } });
  expect(await client.callTool({
    name: 'browser_mouse_move_xy',
    arguments: { x: 480, y: 380 },
  })).toHaveResponse({
    code: expect.stringContaining('await page.mouse.move(480, 380);'),
  });

  await page.setViewportSize({ width: 320, height: 220 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.locator(HOST_SELECTOR).count()).toBe(1);

  expect(await client.callTool({
    name: 'browser_mouse_wheel',
    arguments: { deltaX: 0, deltaY: 120 },
  })).toHaveResponse({
    code: expect.stringContaining('await page.mouse.wheel(0, 120);'),
  });

  await expect.poll(() => page.evaluate(() => (window as any).wheelPoint)).toEqual([300, 200]);
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
});

test('agent-run overlay restores cursor visuals after top-level navigation without duplicate hosts', async ({ cdpServer, startClient, server }) => {
  server.setContent('/first-navigation', `
    <title>First Navigation</title>
    <body style="margin:0;background:#050505;height:800px"></body>
  `, 'text/html');
  server.setContent('/second-navigation', `
    <title>Second Navigation</title>
    <body style="margin:0;background:#050505;height:800px"></body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto(server.PREFIX + '/first-navigation');

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay', '--caps=vision'] });
  await client.callTool({ name: 'browser_snapshot' });
  await client.callTool({ name: 'browser_mouse_move_xy', arguments: { x: 120, y: 150 } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/second-navigation' } });
  await expect.poll(() => page.locator(HOST_SELECTOR).count()).toBe(1);

  await expect.poll(async () => countOrangePixelsInRect(PNG.sync.read(await page.screenshot()), 100, 130, 140, 170)).toBeGreaterThan(20);
  const png = PNG.sync.read(await page.screenshot());
  expect(countOrangePixelsInRect(png, 230, 180, 270, 220)).toBeLessThan(20);
});

test('agent-run overlay restores each tab cursor point when returning to a tab', async ({ cdpServer, startClient, server }) => {
  server.setContent('/first-tab', `
    <title>First Tab</title>
    <body style="margin:0;background:#050505;height:1600px">
      <script>
        document.addEventListener("wheel", event => {
          window.wheelPoint = [event.clientX, event.clientY];
        }, { passive: true });
      </script>
    </body>
  `, 'text/html');
  server.setContent('/second-tab', `
    <title>Second Tab</title>
    <body style="margin:0;background:#050505;height:1600px">
      <script>
        document.addEventListener("wheel", event => {
          window.wheelPoint = [event.clientX, event.clientY];
        }, { passive: true });
      </script>
    </body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const firstPage = browserContext.pages()[0];
  await firstPage.setViewportSize({ width: 500, height: 400 });
  await firstPage.goto(server.PREFIX + '/first-tab');
  const secondPage = await browserContext.newPage();
  await secondPage.setViewportSize({ width: 500, height: 400 });
  await secondPage.goto(server.PREFIX + '/second-tab');

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay', '--caps=vision'] });
  const tabs = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  const tabsText = parseResponse(tabs, test.info().outputPath()).result!;
  const firstIndex = tabIndexForUrl(tabsText, '/first-tab');
  const secondIndex = tabIndexForUrl(tabsText, '/second-tab');

  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: firstIndex, activate: true } });
  expect(await client.callTool({ name: 'browser_mouse_move_xy', arguments: { x: 120, y: 150 } })).toHaveResponse({
    code: expect.stringContaining('await page.mouse.move(120, 150);'),
  });
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: secondIndex, activate: true } });
  expect(await client.callTool({ name: 'browser_mouse_move_xy', arguments: { x: 360, y: 300 } })).toHaveResponse({
    code: expect.stringContaining('await page.mouse.move(360, 300);'),
  });
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: firstIndex, activate: true } });
  expect(await client.callTool({ name: 'browser_mouse_wheel', arguments: { deltaX: 0, deltaY: 120 } })).toHaveResponse({
    code: expect.stringContaining('await page.mouse.wheel(0, 120);'),
  });

  await expect.poll(() => firstPage.evaluate(() => (window as any).wheelPoint)).toEqual([120, 150]);
  expect(await secondPage.evaluate(() => (window as any).wheelPoint)).toBeUndefined();
  await expect.poll(async () => pageOverlayState(firstPage)).toEqual({ count: 1, display: 'block' });
  await expect.poll(async () => pageOverlayState(secondPage)).toEqual({ count: 1, display: 'none' });
});

test('agent-run overlay run teardown disposes overlays on every controlled tab', async ({ cdpServer, startClient, server }) => {
  server.setContent('/first-dispose', `
    <title>First Dispose</title>
    <body style="margin:0;background:#050505"></body>
  `, 'text/html');
  server.setContent('/second-dispose', `
    <title>Second Dispose</title>
    <body style="margin:0;background:#050505"></body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const firstPage = browserContext.pages()[0];
  await firstPage.goto(server.PREFIX + '/first-dispose');
  const secondPage = await browserContext.newPage();
  await secondPage.goto(server.PREFIX + '/second-dispose');

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay'] });
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  await expect.poll(() => firstPage.locator(HOST_SELECTOR).count()).toBe(1);
  await expect.poll(() => secondPage.locator(HOST_SELECTOR).count()).toBe(1);

  await client.close();

  await expect.poll(() => firstPage.locator(HOST_SELECTOR).count()).toBe(0);
  await expect.poll(() => secondPage.locator(HOST_SELECTOR).count()).toBe(0);
});

test('agent-run overlay animates locator clicks before action with one click effect', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay Click</title>
    <body style="margin:0;background:#050505;min-height:400px">
      <button
        style="position:fixed;left:100px;top:220px;width:500px;height:60px"
        onclick="window.clickedAt = performance.now(); window.clickedPoint = [event.clientX, event.clientY]"
      >Submit</button>
    </body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto(server.PREFIX);

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay'] });
  await client.callTool({ name: 'browser_snapshot' });
  await page.evaluate(() => (window as any).clickStartedAt = performance.now());

  await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Submit button', target: 'e2' },
  });

  const clickElapsed = await page.evaluate(() => (window as any).clickedAt - (window as any).clickStartedAt);
  expect(clickElapsed).toBeGreaterThanOrEqual(120);
  expect(await page.evaluate(() => (window as any).clickedPoint)).toEqual([300, 250]);
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  expect(await page.evaluate(() => ({
    actionCursorCount: document.querySelectorAll('x-pw-action-cursor').length,
    actionPointCount: document.querySelectorAll('x-pw-action-point').length,
  }))).toEqual({ actionCursorCount: 0, actionPointCount: 0 });
  const png = PNG.sync.read(await page.screenshot());
  expect(countOrangePixelsInRect(png, 240, 190, 264, 214)).toBeLessThan(20);
  expect(countOrangePixelsInRect(png, 280, 230, 320, 270)).toBeGreaterThan(20);
  expect(countOrangePixelsInRect(png, 340, 230, 360, 270)).toBeLessThan(20);
  expect(countOrangeComponentsInRect(png, 260, 220, 380, 290)).toBe(1);
});

test('agent-run overlay locator click point probing does not leave input intercepted', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay Probe Cleanup</title>
    <body style="margin:0;background:#050505;min-height:400px">
      <button
        style="position:fixed;left:100px;top:220px;width:500px;height:60px"
        onclick="window.clickedPoint = [event.clientX, event.clientY]"
      >Submit</button>
    </body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto(server.PREFIX);

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay'] });
  await client.callTool({ name: 'browser_snapshot' });

  const locator = page.locator('button') as ReturnType<typeof page.locator> & {
    _resolveClickPoint?: (options?: { timeout?: number }) => Promise<{ x: number, y: number } | undefined>;
  };
  const point = await locator._resolveClickPoint?.({ timeout: 5000 });
  expect(point).toEqual({ x: 300, y: 250 });

  await page.mouse.click(300, 250);

  expect(await page.evaluate(() => (window as any).clickedPoint)).toEqual([300, 250]);
});

test('agent-run overlay animates coordinate clicks before action with one click effect', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay Coordinate Click</title>
    <body style="margin:0;background:#050505;min-height:400px">
      <button style="position:fixed;left:80px;top:120px;width:80px;height:60px">Submit</button>
      <script>
        document.addEventListener("click", event => {
          window.clickedAt = performance.now();
          window.clickedPoint = [event.clientX, event.clientY];
        }, true);
      </script>
    </body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay', '--caps=vision'] });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const page = browserContext.pages().find(page => page.url().startsWith(server.PREFIX))!;
  await page.setViewportSize({ width: 500, height: 400 });
  await page.evaluate(() => (window as any).clickStartedAt = performance.now());

  expect(await client.callTool({
    name: 'browser_mouse_click_xy',
    arguments: { x: 120, y: 150 },
  })).toHaveResponse({
    code: expect.stringContaining('await page.mouse.click(120, 150);'),
  });

  const clickElapsed = await page.evaluate(() => (window as any).clickedAt - (window as any).clickStartedAt);
  expect(clickElapsed).toBeGreaterThanOrEqual(120);
  expect(await page.evaluate(() => (window as any).clickedPoint)).toEqual([120, 150]);
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  expect(await page.evaluate(() => ({
    actionCursorCount: document.querySelectorAll('x-pw-action-cursor').length,
    actionPointCount: document.querySelectorAll('x-pw-action-point').length,
  }))).toEqual({ actionCursorCount: 0, actionPointCount: 0 });
  const png = PNG.sync.read(await page.screenshot());
  expect(countOrangePixelsInRect(png, 240, 190, 264, 214)).toBeLessThan(20);
  expect(countOrangePixelsInRect(png, 100, 130, 140, 170)).toBeGreaterThan(20);
  expect(countOrangeComponentsInRect(png, 90, 120, 150, 180)).toBe(2);
});

test('agent-run overlay shows wheel mode at the last cursor point before scrolling', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay Wheel</title>
    <body style="margin:0;background:#050505;height:1600px">
      <script>
        document.addEventListener("wheel", event => {
          window.wheelAt = performance.now();
          window.wheelPoint = [event.clientX, event.clientY];
        }, { passive: true });
      </script>
    </body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto(server.PREFIX);

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay', '--caps=vision'] });
  await client.callTool({ name: 'browser_snapshot' });
  await client.callTool({
    name: 'browser_mouse_move_xy',
    arguments: { x: 120, y: 150 },
  });
  await page.evaluate(() => (window as any).wheelStartedAt = performance.now());

  expect(await client.callTool({
    name: 'browser_mouse_wheel',
    arguments: { deltaX: 0, deltaY: 240 },
  })).toHaveResponse({
    code: expect.stringContaining('await page.mouse.wheel(0, 240);'),
  });

  await expect.poll(() => page.evaluate(() => (window as any).wheelAt)).toBeTruthy();
  const wheelElapsed = await page.evaluate(() => (window as any).wheelAt - (window as any).wheelStartedAt);
  expect(wheelElapsed).toBeGreaterThanOrEqual(120);
  expect(await page.evaluate(() => (window as any).wheelPoint)).toEqual([120, 150]);
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  expect(await page.evaluate(() => ({
    actionCursorCount: document.querySelectorAll('x-pw-action-cursor').length,
    actionPointCount: document.querySelectorAll('x-pw-action-point').length,
  }))).toEqual({ actionCursorCount: 0, actionPointCount: 0 });
  const png = PNG.sync.read(await page.screenshot());
  expect(countOrangePixelsInRect(png, 100, 130, 140, 170)).toBeGreaterThan(20);
  expect(countOrangePixelsInRect(png, 240, 190, 264, 214)).toBeLessThan(20);
});

test('agent-run overlay initializes first wheel action at viewport center', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay First Wheel</title>
    <body style="margin:0;background:#050505;height:1600px">
      <script>
        document.addEventListener("wheel", event => {
          window.wheelAt = performance.now();
          window.wheelPoint = [event.clientX, event.clientY];
        }, { passive: true });
      </script>
    </body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto(server.PREFIX);

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay', '--caps=vision'] });
  await client.callTool({ name: 'browser_snapshot' });
  await page.evaluate(() => (window as any).wheelStartedAt = performance.now());

  await client.callTool({
    name: 'browser_mouse_wheel',
    arguments: { deltaX: 0, deltaY: 240 },
  });

  await expect.poll(() => page.evaluate(() => (window as any).wheelAt)).toBeTruthy();
  const wheelElapsed = await page.evaluate(() => (window as any).wheelAt - (window as any).wheelStartedAt);
  expect(wheelElapsed).toBeGreaterThanOrEqual(120);
  expect(await page.evaluate(() => (window as any).wheelPoint)).toEqual([250, 200]);
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  expect(await page.evaluate(() => ({
    actionCursorCount: document.querySelectorAll('x-pw-action-cursor').length,
    actionPointCount: document.querySelectorAll('x-pw-action-point').length,
  }))).toEqual({ actionCursorCount: 0, actionPointCount: 0 });
  const png = PNG.sync.read(await page.screenshot());
  expect(countOrangePixelsInRect(png, 230, 180, 270, 220)).toBeGreaterThan(20);
  expect(countOrangePixelsInRect(png, 100, 130, 140, 170)).toBeLessThan(20);
});

test('agent-run overlay switches one cursor into wheel mode and back to pointer', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay Wheel Mode</title>
    <body style="margin:0;background:#050505;height:1600px"></body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto(server.PREFIX);

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay', '--caps=vision'] });
  await client.callTool({ name: 'browser_snapshot' });
  await client.callTool({
    name: 'browser_mouse_move_xy',
    arguments: { x: 120, y: 150 },
  });

  const wheelCall = client.callTool({
    name: 'browser_mouse_wheel',
    arguments: { deltaX: 0, deltaY: 240 },
  });
  await page.waitForTimeout(60);
  const during = PNG.sync.read(await page.screenshot());
  await wheelCall;
  const afterBuffer = await page.screenshot();
  const after = PNG.sync.read(afterBuffer);

  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  expect(await page.evaluate(() => ({
    actionCursorCount: document.querySelectorAll('x-pw-action-cursor').length,
    actionPointCount: document.querySelectorAll('x-pw-action-point').length,
  }))).toEqual({ actionCursorCount: 0, actionPointCount: 0 });
  const duringBounds = warmPixelBoundsAwayFromBorder(during);
  const afterBounds = warmPixelBoundsAwayFromBorder(after);
  expect(duringBounds.count).toBeGreaterThan(afterBounds.count + 20);
  expect(afterBounds.count).toBeGreaterThan(20);
  expect(countOrangePixelsInRect(after, 240, 190, 264, 214)).toBeLessThan(20);
});

test('agent-run overlay respects reduced motion for wheel mode', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay Reduced Motion Wheel</title>
    <body style="margin:0;background:#050505;height:1600px">
      <script>
        document.addEventListener("wheel", event => {
          window.wheelAt = performance.now();
          window.wheelPoint = [event.clientX, event.clientY];
        }, { passive: true });
      </script>
    </body>
  `, 'text/html');

  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  await page.setViewportSize({ width: 500, height: 400 });
  await page.addInitScript(() => {
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query === '(prefers-reduced-motion: reduce)')
        return { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false };
      return originalMatchMedia(query);
    };
  });
  await page.goto(server.PREFIX);

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`, '--agent-run-overlay', '--caps=vision'] });
  await client.callTool({ name: 'browser_snapshot' });
  await client.callTool({
    name: 'browser_mouse_move_xy',
    arguments: { x: 120, y: 150 },
  });
  await page.evaluate(() => (window as any).wheelStartedAt = performance.now());

  await client.callTool({
    name: 'browser_mouse_wheel',
    arguments: { deltaX: 0, deltaY: 240 },
  });

  await expect.poll(() => page.evaluate(() => (window as any).wheelAt)).toBeTruthy();
  const wheelElapsed = await page.evaluate(() => (window as any).wheelAt - (window as any).wheelStartedAt);
  expect(wheelElapsed).toBeLessThan(120);
  expect(await page.evaluate(() => (window as any).wheelPoint)).toEqual([120, 150]);
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  expect(await page.evaluate(() => ({
    actionCursorCount: document.querySelectorAll('x-pw-action-cursor').length,
    actionPointCount: document.querySelectorAll('x-pw-action-point').length,
  }))).toEqual({ actionCursorCount: 0, actionPointCount: 0 });
});
