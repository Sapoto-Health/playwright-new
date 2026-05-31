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
 *   - Download-y/blob URL + no electronAPI bridge → emit the same console
 *     marker and return null because direct-Chrome mode observes the marker
 *     through CDP Runtime.consoleAPICalled.
 *   - Self-targeting (_self / _parent / _top / empty target) → native
 *     window.open (no focus steal to suppress).
 *   - Fake / structurally-invalid electronAPI → console marker still emits;
 *     requestPrintCapture is simply not called.
 *
 * Descriptor:
 *   - configurable: true (matches stock Chrome — configurable:false would
 *     itself fingerprint the shim, PRD user-story #29).
 */

import { contextTest as it, expect } from '../config/browserTest';
import { buildArmCaptureBridgeInitScript, buildCaptureBridgeInitScript } from '../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only — focus-steal lives on chromium');

const BRIDGE_SCRIPT = buildCaptureBridgeInitScript({ captureBridge: true });
const PASSIVE_WINDOW_OPEN_SCRIPT = buildCaptureBridgeInitScript({
  captureBridge: false,
  windowOpenCaptureMode: 'passive',
});
const ARM_WINDOW_OPEN_SCRIPT = buildArmCaptureBridgeInitScript();

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

it('C5: blob _blank popup emits background-open marker without electronAPI bridge', async ({ context, server }) => {
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  const result = await page.evaluate(() => {
    const blob = new Blob(['statement'], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, '_blank');
    return {
      returnedNull: opened === null,
      url,
    };
  });

  expect(result.returnedNull).toBe(true);
  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(marker).toBeTruthy();
  expect(marker).toContain(result.url);
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

it('C5: fake electronAPI shapes do not block console-marker capture', async ({ context, server }) => {
  // Hostile page-defined electronAPI where requestPrintCapture is a string,
  // not a function. C5 must still emit the console marker in direct-Chrome
  // mode; the fake bridge shape only prevents the optional Electron preload
  // callback from firing.
  await context.addInitScript({
    content: `(() => {
      window.__fakeBridgeCallCount = 0;
      window.electronAPI = { requestPrintCapture: 'not a function' };
    })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  const result = await page.evaluate(() => {
    const opened = window.open('https://example.com/statement.pdf', '_blank');
    return {
      returnedNull: opened === null,
      fakeBridgeCallCount: (window as any).__fakeBridgeCallCount,
    };
  });
  await page.waitForTimeout(100);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(result.returnedNull).toBe(true);
  expect(result.fakeBridgeCallCount).toBe(0);
  expect(marker).toBeTruthy();
  expect(marker).toContain('https://example.com/statement.pdf');
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

it('C5: passive saved reference delegates, then active arming captures through the same reference', async ({ context, server }) => {
  await context.addInitScript({ content: PASSIVE_WINDOW_OPEN_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  const passiveResult = await page.evaluate(() => {
    (window as any).__savedOpen = window.open;
    const opened = (window as any).__savedOpen('about:blank', '_blank');
    try { opened?.close?.(); } catch (_) {}
    return opened === null ? 'null' : typeof opened;
  });
  expect(passiveResult).not.toBe('null');
  expect(consoleMessages.some(t => t.includes('[FocusShim] background-open'))).toBe(false);

  const armed = await page.evaluate(ARM_WINDOW_OPEN_SCRIPT);
  expect(armed).toBe(true);

  const activeResult = await page.evaluate(() => {
    const opened = (window as any).__savedOpen('https://example.com/account', '_blank');
    return opened === null;
  });
  expect(activeResult).toBe(true);
  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open https://example.com/account'));
  expect(marker).toBeTruthy();
});

it('C5: passive mode is window.open-only and delegates ordinary login popups', async ({ context, server }) => {
  await context.addInitScript({ content: PASSIVE_WINDOW_OPEN_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  const result = await page.evaluate(() => {
    const originalPrint = window.print;
    const opened = window.open('https://example.com/oauth', '_blank');
    const openedType = opened === null ? 'null' : typeof opened;
    try { opened?.close?.(); } catch (_) {}
    return {
      openedType,
      printUnchanged: window.print === originalPrint,
    };
  });

  expect(result.openedType).not.toBe('null');
  expect(result.printUnchanged).toBe(true);
  expect(consoleMessages.some(t => t.includes('[FocusShim] background-open'))).toBe(false);
  expect(consoleMessages.some(t => t.includes('[Print Capture]'))).toBe(false);
});

it('C5: active non-self http(s) URL with _blank target emits background-open marker', async ({ context, server }) => {
  await context.addInitScript({
    content: `(() => { window.electronAPI = { requestPrintCapture: function() {} }; })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  const returnedNull = await page.evaluate(() => {
    return window.open('https://example.com/account', '_blank') === null;
  });
  await page.waitForTimeout(100);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(returnedNull).toBe(true);
  expect(marker).toBeTruthy();
  expect(marker).toContain('https://example.com/account');
});

it('C5: non-capturable document-looking schemes stay native', async ({ context, server }) => {
  await context.addInitScript({
    content: `(() => {
      const originalOpen = window.open.bind(window);
      window.__nativeOpenCalls = [];
      window.open = function(url, target, features) {
        window.__nativeOpenCalls.push({ url: String(url), target: String(target), features });
        return { __nativeOpenSentinel: true };
      };
      window.__restoreNativeOpen = () => { window.open = originalOpen; };
    })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  const dataResult = await page.evaluate(() => {
    const w = window.open('data:application/pdf;base64,JVBERi0xLjQK.pdf', '_blank');
    return {
      returnedNativeSentinel: !!(w as any)?.__nativeOpenSentinel,
      nativeOpenCalls: (window as any).__nativeOpenCalls,
    };
  });
  await page.waitForTimeout(100);

  const marker = consoleMessages.find(t => t.includes('[FocusShim]') && t.includes('background-open'));
  expect(dataResult.returnedNativeSentinel).toBe(true);
  expect(dataResult.nativeOpenCalls).toEqual([{
    url: 'data:application/pdf;base64,JVBERi0xLjQK.pdf',
    target: '_blank',
  }]);
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
