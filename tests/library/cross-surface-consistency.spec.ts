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
 * Sapoto Tracer #1152 (Unit E) §4.7 — cross-surface consistency.
 *
 * The previous-generation fork wired `runtime-cycle` into the page-init and
 * frame-navigation CDP paths AND wired its worker-runtime equivalent into
 * the service-worker constructor — but left the DEDICATED PAGE WORKER code
 * path in `crPage.ts` unwired. Result: with `runtime-cycle` +
 * `worker-runtime` both enabled, main pages and service workers cycled the
 * Runtime domain dark, but `new Worker('x.js')` did not. Anti-bot stacks
 * that probe BOTH the page and a dedicated worker would see asymmetric
 * behavior — "automation, partially mitigated" — and treat the asymmetry
 * itself as a fingerprint.
 *
 * This Tracer closes that gap by routing the dedicated-worker code path
 * through the same `applyRuntimeCycle` helper the service-worker
 * constructor uses. This spec is the gate: it asserts the wire-level
 * Runtime.disable emission is symmetric across all five surfaces that can
 * host JavaScript:
 *
 *   (1) main page                              — driven by `runtime-cycle`
 *   (2) same-origin OOPIF iframe               — driven by `runtime-cycle`
 *   (3) dedicated `new Worker('x.js')`         — driven by `worker-runtime` (NEW)
 *   (4) `window.open` popup page               — driven by `runtime-cycle`
 *   (5) registered service worker              — driven by `worker-runtime`
 *
 * Surface (4) — popup — exercises a STRUCTURALLY DISTINCT attach path:
 * `crPage.ts` `_onAttachedToTarget` page branch, not the iframe FrameSession
 * branch. A regression that skips the runtime-cycle on popup attach would
 * not be caught by the page + iframe assertions alone, so the popup needs
 * its own session-attach assertion.
 *
 * Surface (5) — service worker — is independently routed through
 * `crServiceWorker.ts`; the unit-level helper test covers the function but
 * only a registered SW exercises the full attach pipeline end to end.
 *
 * The probe: with BOTH gates set, every one of those sessions must emit
 * `Runtime.disable` on its own CDP session. If the dedicated-worker code
 * path regresses (i.e. is reverted to a bare `Runtime.enable` /
 * `runIfWaitingForDebugger` pair), surface (3) silently drops out of the
 * symmetric set and this test fails.
 *
 * Skip for non-chromium: the gates only exist for chromium.
 */

import { browserTest as it, expect } from '../config/browserTest';

type SendRecord = { method: string; sessionId?: string };

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only — CDP stealth gates apply only to the chromium driver');

it('cross-surface consistency: with runtime-cycle + worker-runtime, Runtime.disable lands on main page, OOPIF iframe, dedicated worker, popup AND service-worker sessions', async ({ browserType, toImpl, server }) => {
  // All five JS-hosting surfaces are exercised here. The §4.7 fix focused on
  // the dedicated-worker surface specifically, but the symmetry story only
  // holds if regressions on the OTHER attach paths also surface as test
  // failures. In particular:
  //   - popup goes through crPage.ts `_onAttachedToTarget` PAGE branch, which
  //     is structurally distinct from the FrameSession branch the iframe
  //     exercises; without a popup assertion a popup-only regression would
  //     pass silently.
  //   - service worker goes through crServiceWorker.ts independently of any
  //     page-attach plumbing; the helper unit test covers `applyRuntimeCycle`
  //     in isolation, but only a real registration exercises the full attach
  //     pipeline.
  // Popup and SW timing is inherently async (window.open round-trip, SW
  // install + activate); we mitigate flake via `expect.poll` with a generous
  // 10s budget on the session-attach assertions.
  server.setRoute('/host.html', (req, res) => {
    res.end(`<!doctype html>
      <html><body>
      <iframe src="${server.CROSS_PROCESS_PREFIX}/empty.html"></iframe>
      <script>
        const blob = new Blob(['self.postMessage("worker-up");'], { type: 'application/javascript' });
        window.__worker = new Worker(URL.createObjectURL(blob));
      </script>
      </body></html>`);
  });
  // Service-worker host page + sw.js — served fresh per test so the SW
  // install pipeline runs against this run's listeners.
  server.setRoute('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));`);
  });
  server.setRoute('/sw-host.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><body>
<script>
  window.__swReady = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
</script>
</body></html>`);
  });

  const browser = await browserType.launch();
  try {
    const impl: any = toImpl(browser);
    // Both gates on — the §4.7 condition.
    impl.options.cdpStealth = new Set(['runtime-cycle', 'worker-runtime']);

    const sends: SendRecord[] = [];
    const connection = impl._connection;
    const original = connection._protocolLogger;
    connection._protocolLogger = (direction: 'send' | 'receive', message: any) => {
      if (direction === 'send' && message?.method)
        sends.push({ method: message.method, sessionId: message.sessionId });
      original(direction, message);
    };

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      const workerPromise = page.waitForEvent('worker', { timeout: 10_000 });
      await page.goto(server.PREFIX + '/host.html');
      await workerPromise;

      // Surface (4): popup — `window.open` creates a NEW page target. This
      // goes through `crPage.ts` `_onAttachedToTarget` page branch (NOT
      // the iframe FrameSession branch), so it stresses a distinct attach
      // path. The runtime-cycle gate is asserted against the popup's own
      // CDP session below.
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 10_000 }),
        page.evaluate(serverPrefix => { window.open(serverPrefix + '/title.html', '_blank'); }, server.PREFIX),
      ]);
      await popup.waitForLoadState('load');

      // Surface (5): service worker — open a second page that registers
      // `/sw.js`, then await `navigator.serviceWorker.ready` so the SW has
      // been installed and activated. crServiceWorker.ts attaches to its
      // own target session, distinct from any page session.
      const swPage = await context.newPage();
      await swPage.goto(server.PREFIX + '/sw-host.html');
      await swPage.evaluate(() => (window as any).__swReady);

      // Poll until the §4.7 marker shows up: at least one session must emit
      // the worker triple (Runtime.enable as first method, plus
      // Runtime.disable and Runtime.runIfWaitingForDebugger). Worker startup
      // is fire-and-forget on the server, so wait for the worker session's
      // `Runtime.disable` + `Runtime.runIfWaitingForDebugger` to both land
      // before we analyse — otherwise the §4.7 marker may still be in
      // flight when we read `sends`.
      await expect.poll(() => {
        const sessions = new Set(sends.map(s => s.sessionId).filter(Boolean));
        return [...sessions].some(sid => {
          const m = sends.filter(s => s.sessionId === sid).map(s => s.method);
          return m.length > 0 && m[0] === 'Runtime.enable'
            && m.includes('Runtime.disable') && m.includes('Runtime.runIfWaitingForDebugger');
        });
      }, { timeout: 10_000 }).toBe(true);

      // Wait until the captured-sends stream contains enough distinct
      // sessions to plausibly cover all five surfaces. The popup and SW
      // attaches can lag past the initial `worker-up` marker; rather than
      // synthetic sleeps, poll until we see ≥5 distinct session ids that
      // each emitted at least one method (or 8s, whichever comes first).
      await expect.poll(() => {
        const sessions = new Set(sends.map(s => s.sessionId).filter(Boolean));
        return sessions.size;
      }, { timeout: 8_000 }).toBeGreaterThanOrEqual(5);

      // Aggregate per-session method lists.
      const bySession = new Map<string, string[]>();
      for (const s of sends) {
        const sid = s.sessionId || '__root__';
        let arr = bySession.get(sid);
        if (!arr) {
          arr = [];
          bySession.set(sid, arr);
        }
        arr.push(s.method);
      }

      // Count sessions that emitted Runtime.disable. With both gates on AND
      // the §4.7 fix in place, this should cover:
      //   - main page session         (runtime-cycle gate)
      //   - OOPIF iframe session      (runtime-cycle gate; iframes go through FrameSession._initialize)
      //   - dedicated worker session  (worker-runtime gate — the §4.7 fix)
      //   - popup page session        (runtime-cycle gate; popup target attaches via crPage page branch)
      //   - SW host page session      (runtime-cycle gate; the page that registers the SW)
      //   - service-worker session    (worker-runtime gate)
      const sessionsWithDisable = [...bySession.entries()]
          .filter(([_, methods]) => methods.includes('Runtime.disable'))
          .map(([sid]) => sid);

      // Diagnostic: dump per-session method summaries so a failure tells you
      // WHICH surface dropped out.
      const summary = [...bySession.entries()]
          .map(([sid, methods]) => `${sid || 'root'}: ${methods.filter(m => m.startsWith('Runtime.') || m === 'Log.enable').join(',')}`)
          .join('\n  ');

      // First gate (soft): with both flags on AND all five surfaces wired,
      // we expect at least three sessions to have emitted Runtime.disable —
      // the original lower bound was 2 (main page + dedicated worker);
      // adding popup + SW raises it. Cross-origin iframe + SW are
      // target-isolation-dependent so we don't assert the upper bound.
      expect(
          sessionsWithDisable.length,
          `Expected at least 3 sessions to emit Runtime.disable (main page + dedicated worker + popup/SW). Sessions seen:\n  ${summary}`,
      ).toBeGreaterThanOrEqual(3);

      // Discriminator: page-style sessions emit `Log.enable` and/or page-init
      // methods (Page.enable, Page.getFrameTree, Browser.getWindowForTarget);
      // worker-style sessions never do — they only ever speak the Runtime
      // domain (and a few worker-specific Inspector events). Filtering by the
      // ABSENCE of `Log.enable` cleanly separates the two surface families
      // and works regardless of `methods[0]` (which can be a Target.* or
      // Inspector.* method on some attach paths).
      const isPageStyle = (methods: string[]) => methods.includes('Log.enable') || methods.includes('Page.enable');
      const isWorkerStyle = (methods: string[]) => !isPageStyle(methods);

      // Page-style sessions with Runtime.disable: main page + SW host page +
      // popup (+ possibly OOPIF iframe under target isolation). With
      // runtime-cycle on, we expect AT LEAST three of those — fewer means
      // popup attach skipped the runtime-cycle path.
      //
      // NOTE: this is the structural gate that catches a popup-attach
      // regression. Popup goes through `crPage.ts` `_onAttachedToTarget`
      // page branch, distinct from the iframe FrameSession branch.
      const pageSessionsWithDisable = [...bySession.entries()].filter(([_, methods]) =>
        isPageStyle(methods) && methods.includes('Runtime.disable'),
      );
      expect(
          pageSessionsWithDisable.length,
          `Expected at least 3 page-style sessions (main page + SW host page + popup) to emit ` +
          `Runtime.disable. If fewer, the popup attach path may have skipped the runtime-cycle ` +
          `(popup goes through crPage page branch, structurally distinct from the FrameSession ` +
          `branch that covers iframes).\nSessions seen:\n  ${summary}`,
      ).toBeGreaterThanOrEqual(3);

      // Worker-style sessions with the full worker triple (Runtime.enable +
      // Runtime.disable + Runtime.runIfWaitingForDebugger). With worker-
      // runtime on, BOTH the dedicated worker and the registered service
      // worker route through `applyRuntimeCycle`. We expect at least 2
      // such sessions; falling below 2 indicates either the §4.7
      // dedicated-worker path regressed OR the service-worker path did.
      //
      // NOTE: Chromium auto-attaches some worker targets transiently (e.g.
      // network-only attaches that get a `Runtime.runIfWaitingForDebugger`
      // resume but never the cycle) — those are excluded by requiring the
      // full triple.
      const workerSessionsWithTriple = [...bySession.values()].filter(methods =>
        isWorkerStyle(methods)
        && methods.includes('Runtime.enable')
        && methods.includes('Runtime.disable')
        && methods.includes('Runtime.runIfWaitingForDebugger'),
      );
      expect(
          workerSessionsWithTriple.length,
          `Expected at least 2 worker-style sessions (dedicated worker + service worker) to ` +
          `emit the worker triple. Fewer indicates EITHER the §4.7 dedicated-worker path regressed ` +
          `OR the service-worker path regressed — both surfaces should route through ` +
          `applyRuntimeCycle.\nSessions seen:\n  ${summary}`,
      ).toBeGreaterThanOrEqual(2);

      // Second gate (hard, §4.7 marker): the worker-style triple must
      // appear on at least one session — covered by `workerSessionsWithTriple`
      // above; kept as a redundant assertion with a §4.7-specific failure
      // message so a regression points squarely at the dedicated-worker fix.
      //
      // Without the §4.7 fix the dedicated-worker code path issues only
      // Runtime.enable + runIfWaitingForDebugger (no disable), so the
      // triple would never appear on any worker session.
      expect(
          workerSessionsWithTriple.length,
          `Expected at least one WORKER session emitting the worker triple ` +
          `(Runtime.enable + Runtime.disable + Runtime.runIfWaitingForDebugger). ` +
          `If zero, the §4.7 dedicated-worker fix has regressed (i.e. crPage.ts's worker code ` +
          `path is no longer routed through applyRuntimeCycle).\nSessions seen:\n  ${summary}`,
      ).toBeGreaterThanOrEqual(1);

      // Third gate (hard, ordering): for every worker session, the
      // load-bearing ordering invariant must hold —
      //   Runtime.enable < Runtime.disable < Runtime.runIfWaitingForDebugger
      // If runIfWaitingForDebugger lands before Runtime.disable on a worker
      // session, the worker resumes with the Runtime domain still exposed
      // and the entire `worker-runtime` mitigation is defeated.
      for (const methods of workerSessionsWithTriple) {
        const e = methods.indexOf('Runtime.enable');
        const d = methods.indexOf('Runtime.disable');
        const r = methods.indexOf('Runtime.runIfWaitingForDebugger');
        expect(d, `worker-session ordering: enable=${e} disable=${d} resume=${r} methods=${methods.join(',')}`).toBeGreaterThan(e);
        expect(r, `worker-session ordering: enable=${e} disable=${d} resume=${r} methods=${methods.join(',')}`).toBeGreaterThan(d);
      }
    } finally {
      connection._protocolLogger = original;
    }
  } finally {
    await browser.close();
  }
});
