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
 * Sapoto Tracer #1154 (Unit I) — real-Chromium C3/C4 tests for the
 * deferred-print + synchronous bridge path.
 *
 * The IIFE installs C3 first (sets `window.print = deferred`) then C4
 * (wraps it). After install, calling `window.print()` from a page:
 *   - C4 synchronously walks parents looking for electronAPI; if found,
 *     fires `[Print Capture]` marker + bridge call, returns immediately.
 *   - If C4 didn't find it, falls through to C3's deferred — fires
 *     `[DeferredPrint]` marker + 2s timer; after 2s the timer does its own
 *     parent walk (a second chance for asynchronously-installed bridges)
 *     and emits a bridge-unreachable marker if still nothing.
 *
 * Skipped on non-chromium browsers — the bridge consumer doesn't exist
 * outside the chromium agent-runner path.
 */

import { contextTest as it, expect } from '../config/browserTest';
import { buildCaptureBridgeInitScript } from '../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only — capture-bridge lives on the chromium agent-runner path');

const BRIDGE_SCRIPT = buildCaptureBridgeInitScript({ captureBridge: true });

it('C3/C4: no electronAPI present — print is silently suppressed (no dialog, no bridge call)', async ({ context, server }) => {
  await context.addInitScript({ content: BRIDGE_SCRIPT });
  const page = await context.newPage();

  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  await page.evaluate(() => {
    (window as any).__bridgeCallCount = 0;
    window.print();
  });
  // Wait past the C3 deferral so the second-chance walk fires.
  await page.waitForTimeout(2300);
  // C4 saw no bridge → fell through to C3 → C3 saw none → bridge unreachable.
  expect(consoleMessages.some(t => t.includes('[Print Capture]') && t.includes('intercepted'))).toBe(true);
  expect(consoleMessages.some(t => t.includes('[DeferredPrint]') && t.includes('deferring for 2000ms'))).toBe(true);
  expect(consoleMessages.some(t => t.includes('[DeferredPrint]') && t.includes('bridge unreachable'))).toBe(true);
});

it('C3/C4: top-frame routed — fake electronAPI.requestPrintCapture receives the call synchronously', async ({ context, server }) => {
  // The fake bridge is installed BEFORE the capture-bridge IIFE so C4's
  // synchronous walk finds it on the first try. Chaining addInitScript calls
  // preserves order.
  // electronAPI is intentionally installed only on the TOP frame (mirroring
  // the real Electron preload — preload runs only on the top frame for
  // Electron embedders). The IIFE's parent walk is what brings the bridge
  // within reach of iframe-originated print calls.
  await context.addInitScript({
    content: `(() => {
      if (window !== window.top) return;
      window.__bridgeCalls = [];
      window.electronAPI = {
        requestPrintCapture: function(payload) { window.__bridgeCalls.push(payload); }
      };
    })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(msg.text()));

  await page.goto(server.EMPTY_PAGE);
  await page.evaluate(() => window.print());
  // No need to wait for the deferral — C4 fires synchronously.
  await page.waitForTimeout(50);

  const calls = await page.evaluate(() => (window as any).__bridgeCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].scope).toBe('top-frame');
  expect(calls[0].frameSelector).toBeNull();
  expect(typeof calls[0].url).toBe('string');
  expect(calls[0].url).toContain(server.EMPTY_PAGE.replace(/[?#].*$/, ''));
  expect(consoleMessages.some(t => t.includes('[Print Capture]') && t.includes('intercepted'))).toBe(true);
  // C3's deferred should NOT have fired — C4 dispatched synchronously and
  // skipped the fallback.
  expect(consoleMessages.some(t => t.includes('[DeferredPrint]') && t.includes('deferring'))).toBe(false);
});

it('C3/C4: iframe parent-walk — bridge found on top frame, scope=iframe with safe id selector', async ({ context, server }) => {
  // electronAPI is intentionally installed only on the TOP frame (mirroring
  // the real Electron preload — preload runs only on the top frame for
  // Electron embedders). The IIFE's parent walk is what brings the bridge
  // within reach of iframe-originated print calls.
  await context.addInitScript({
    content: `(() => {
      if (window !== window.top) return;
      window.__bridgeCalls = [];
      window.electronAPI = {
        requestPrintCapture: function(payload) { window.__bridgeCalls.push(payload); }
      };
    })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();

  // Build a same-origin nested-iframe page so the bridge walk can read
  // .parent without cross-origin SecurityErrors. The deepest iframe has
  // a safe id ("print-target") and a synthesized printing trigger.
  server.setRoute('/c3-iframe.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><body><iframe id="outer" src="/c3-iframe-mid.html"></iframe></body>`);
  });
  server.setRoute('/c3-iframe-mid.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><body><iframe id="print-target" src="/c3-iframe-deep.html"></iframe></body>`);
  });
  server.setRoute('/c3-iframe-deep.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><body>print me<script>window.__triggerPrint = () => window.print();</script></body>`);
  });

  await page.goto(server.PREFIX + '/c3-iframe.html');
  // Wait for all three frames to settle.
  await page.waitForFunction(() => {
    const outer = (document.querySelector('iframe#outer') as HTMLIFrameElement | null);
    const mid = outer?.contentDocument?.querySelector('iframe#print-target') as HTMLIFrameElement | null;
    return !!mid?.contentWindow?.document?.body;
  });

  // Trigger window.print() from the deepest iframe.
  await page.evaluate(() => {
    const outer = document.querySelector('iframe#outer') as HTMLIFrameElement;
    const mid = outer.contentDocument!.querySelector('iframe#print-target') as HTMLIFrameElement;
    (mid.contentWindow as any).__triggerPrint();
  });
  await page.waitForTimeout(100);

  const calls = await page.evaluate(() => (window as any).__bridgeCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].scope).toBe('iframe');
  expect(calls[0].frameSelector).toBe('iframe#print-target');
});

it('C3/C4: iframe with quote-injection id — frameSelector drops to null (orchestrator falls back to iframe[srcdoc])', async ({ context, server }) => {
  // electronAPI is intentionally installed only on the TOP frame (mirroring
  // the real Electron preload — preload runs only on the top frame for
  // Electron embedders). The IIFE's parent walk is what brings the bridge
  // within reach of iframe-originated print calls.
  await context.addInitScript({
    content: `(() => {
      if (window !== window.top) return;
      window.__bridgeCalls = [];
      window.electronAPI = {
        requestPrintCapture: function(payload) { window.__bridgeCalls.push(payload); }
      };
    })();`,
  });
  await context.addInitScript({ content: BRIDGE_SCRIPT });

  const page = await context.newPage();

  // Hostile-ish id that the safeId() regex rejects. The bridge should
  // emit frameSelector=null rather than embedding the raw id.
  server.setRoute('/c3-injection.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><body><iframe id="evil&quot;injection" src="/c3-deep.html"></iframe></body>`);
  });
  server.setRoute('/c3-deep.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><body><script>window.__doPrint = () => window.print();</script></body>`);
  });

  await page.goto(server.PREFIX + '/c3-injection.html');
  await page.waitForFunction(() => {
    const f = document.querySelector('iframe') as HTMLIFrameElement | null;
    return !!f?.contentDocument?.body;
  });
  await page.evaluate(() => {
    const f = document.querySelector('iframe') as HTMLIFrameElement;
    (f.contentWindow as any).__doPrint();
  });
  await page.waitForTimeout(100);

  const calls = await page.evaluate(() => (window as any).__bridgeCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].scope).toBe('iframe');
  // Unsafe id rejected — selector must be null, never the embedded raw id.
  expect(calls[0].frameSelector).toBeNull();
});
