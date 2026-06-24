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

test('agent-run overlay animates locator clicks before action with one click effect', async ({ cdpServer, startClient, server }) => {
  server.setContent('/', `
    <title>Agent Run Overlay Click</title>
    <body style="margin:0;background:#050505;min-height:400px">
      <button
        style="position:fixed;left:320px;top:220px;width:80px;height:60px"
        onclick="window.clickedAt = performance.now()"
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
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  const png = PNG.sync.read(await page.screenshot());
  expect(countOrangePixelsInRect(png, 240, 190, 264, 214)).toBeLessThan(20);
  expect(countOrangePixelsInRect(png, 340, 240, 380, 280)).toBeGreaterThan(20);
  expect(countOrangePixelsInRect(png, 330, 230, 390, 290)).toBeLessThan(700);
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
  const png = PNG.sync.read(await page.screenshot());
  expect(countOrangePixelsInRect(png, 240, 190, 264, 214)).toBeLessThan(20);
  expect(countOrangePixelsInRect(png, 100, 130, 140, 170)).toBeGreaterThan(20);
  expect(countOrangePixelsInRect(png, 90, 120, 150, 180)).toBeLessThan(700);
});
