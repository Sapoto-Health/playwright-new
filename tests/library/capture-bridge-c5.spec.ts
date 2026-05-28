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
 * Sapoto Tracer #1154 (Unit I) — real-Chromium C5 (window.open focus-steal
 * shim) tests.
 *
 * The shim's contract:
 *   - Download-y URL + electronAPI bridge present → emit `[FocusShim]
 *     background-open <url>` console marker and return null (orchestrator
 *     spawns a hidden CDP target).
 *   - Download-y URL + no electronAPI bridge → native window.open (focus
 *     steals but we have no orchestrator to spawn for).
 *   - Self-targeting (_self / _parent / _top / empty target) → native
 *     window.open (no focus steal to suppress).
 *   - Fake / structurally-invalid electronAPI → treat as no bridge (PRD
 *     user-story #28 — bare `typeof !== 'undefined'` would be a hostile-
 *     page disable vector).
 *
 * Descriptor:
 *   - configurable: true (matches stock Chrome — configurable:false would
 *     itself fingerprint the shim, PRD user-story #29).
 */

import { contextTest as it, expect } from '../config/browserTest';
import { buildCaptureBridgeInitScript } from '../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only — focus-steal lives on chromium');

const BRIDGE_SCRIPT = buildCaptureBridgeInitScript({ captureBridge: true });

it('C5: emits [FocusShim] background-open marker when bridge present and URL looks like a download', async ({ context, server }) => {
  await context.addInitScript({
    content: `(() => {
      window.electronAPI = {
        requestPrintCapture: function() { /* noop — we only need the function presence for the structural check */ }
      };
    })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  const result = await page.evaluate(() => {
    const w = window.open('https://example.com/statement.pdf', '_blank');
    return w === null;
  });
  // window.open returned null (shim swallowed the popup) — primary contract.
  expect(result).toBe(true);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(marker).toBeTruthy();
  expect(marker).toContain('https://example.com/statement.pdf');
});

it('C5: descriptor for window.open matches stock Chrome exactly (no fingerprint divergence)', async ({ contextFactory, server }) => {
  // Adversarial-review fix: an earlier version of this test asserted only
  // `configurable: true`, which masked a fingerprint divergence — the shim
  // was installed with `writable: false` while stock Chrome's `window.open`
  // is `writable: true`. A page reading
  // `Object.getOwnPropertyDescriptor(window, 'open').writable` would see
  // `false` and reliably detect the shim. The fix is to capture the stock
  // descriptor empirically and assert byte-for-byte equality.

  // 1) Capture the stock-Chrome baseline (capture-bridge OFF — no shim).
  const stockContext = await contextFactory();
  const stockPage = await stockContext.newPage();
  await stockPage.goto(server.EMPTY_PAGE);
  const stockDescriptor = await stockPage.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(window, 'open');
    return d ? { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable } : null;
  });
  expect(stockDescriptor).not.toBeNull();
  // Document the captured baseline for the orchestrator: this is what stock
  // Chrome reports for window.open's own-property descriptor.
  console.log('[c5 baseline] stock Chrome window.open descriptor =', JSON.stringify(stockDescriptor));
  await stockContext.close();

  // 2) Capture the shimmed descriptor (capture-bridge ON).
  const shimContext = await contextFactory();
  await shimContext.addInitScript({ content: BRIDGE_SCRIPT });
  const shimPage = await shimContext.newPage();
  await shimPage.goto(server.EMPTY_PAGE);
  const shimmedDescriptor = await shimPage.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(window, 'open');
    return d ? { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable } : null;
  });
  expect(shimmedDescriptor).not.toBeNull();

  // 3) Descriptors must be byte-for-byte equal. Any divergence is a
  // fingerprint vector — PRD user-story #17 / #29.
  expect(shimmedDescriptor).toEqual(stockDescriptor);

  // 4) Sanity — the shim's `value` is still a function (i.e. we didn't
  // replace window.open with a getter or non-function).
  const valueIsFunction = await shimPage.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(window, 'open');
    return d ? typeof d.value === 'function' : false;
  });
  expect(valueIsFunction).toBe(true);
  await shimContext.close();
});

it('C5: _isSapotoElectronBridge rejects fake electronAPI shapes — falls through to native', async ({ context, server }) => {
  // Hostile page-defined electronAPI where requestPrintCapture is a string,
  // not a function. The structural check (typeof === "function") must reject
  // this so the page can't disable the shim by defining a global.
  await context.addInitScript({
    content: `(() => {
      window.electronAPI = { requestPrintCapture: 'not a function' };
    })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  // window.open should fall through to native (which Playwright handles
  // as a popup event) — therefore NOT emit the background-open marker.
  const popupPromise = page.waitForEvent('popup', { timeout: 2000 }).catch(() => null);
  await page.evaluate(() => {
    window.open('https://example.com/statement.pdf', '_blank');
  });
  await popupPromise; // either fired (native) or timed out; both are OK
  await page.waitForTimeout(100);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(marker).toBeFalsy();
});

it('C5: empty-URL window.open(\'\', \'_blank\') — native passthrough (print-receipt proxy case)', async ({ context, server }) => {
  await context.addInitScript({
    content: `(() => {
      window.electronAPI = {
        requestPrintCapture: function() {}
      };
    })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  // _blank empty URL matches SELF_TARGET_RE only with the empty target;
  // _blank target with empty URL passes through to native — the shim does
  // not emit the background-open marker because the URL is empty (not
  // download-y).
  await page.evaluate(() => {
    const w = window.open('', '_blank');
    // Capture for inspection.
    (window as any).__openResult = w === null ? 'null' : (typeof w);
  });
  await page.waitForTimeout(100);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(marker).toBeFalsy();
});

it('C5: self-target window.open(url, \'_self\') — native passthrough, no background-open marker', async ({ context, server }) => {
  await context.addInitScript({
    content: `(() => { window.electronAPI = { requestPrintCapture: function() {} }; })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  // Even with a download-y URL, _self target must NOT route through the
  // background-open marker.
  await page.evaluate(() => {
    try { window.open('https://example.com/statement.pdf', '_self'); } catch (e) { /* navigation aborts in-test */ }
  });
  await page.waitForTimeout(100);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(marker).toBeFalsy();
});

it('C5: non-download URL with _blank target — native passthrough', async ({ context, server }) => {
  await context.addInitScript({
    content: `(() => { window.electronAPI = { requestPrintCapture: function() {} }; })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  const popupPromise = page.waitForEvent('popup', { timeout: 2000 }).catch(() => null);
  await page.evaluate(() => {
    window.open('https://example.com/account', '_blank');
  });
  await popupPromise;
  await page.waitForTimeout(100);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(marker).toBeFalsy();
});

it('C5: path-based download URL (no extension) — emits background-open marker', async ({ context, server }) => {
  await context.addInitScript({
    content: `(() => { window.electronAPI = { requestPrintCapture: function() {} }; })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  await page.evaluate(() => {
    window.open('https://example.com/api/inline/download/12345', '_blank');
  });
  await page.waitForTimeout(100);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(marker).toBeTruthy();
  expect(marker).toContain('https://example.com/api/inline/download/12345');
});
