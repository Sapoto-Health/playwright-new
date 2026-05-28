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
 * Sapoto Tracer #1152 (Unit E) — real-Chromium wire assertions for the
 * per-feature CDP stealth gates.
 *
 * Strategy: launch a fresh Chromium per test, mutate the server-side
 * `BrowserOptions.cdpStealth` Set (test-only override — Unit G-stealth #1153
 * will wire this from the CLI / channel later, but for now the field is
 * default-empty and the test reaches in directly), then intercept every
 * outbound CDP message via the connection's `_protocolLogger` hook. The
 * captured stream is the ground truth for what Playwright dispatched.
 *
 * Each test asserts a specific subset of the dispatched-method stream:
 *
 *   - default empty Set: Runtime.enable + Log.enable normally; NO Runtime.disable.
 *   - `log-skip`: Log.enable is NOT in the dispatched stream.
 *   - `runtime-cycle` at init: Runtime.enable followed by Runtime.disable.
 *   - `runtime-cycle` at cross-document navigation: same pair repeated.
 *   - `worker-runtime`: page-worker session emits
 *     Runtime.enable → Runtime.disable → Runtime.runIfWaitingForDebugger
 *     in that EXACT order. Reversal exposes the long-lived Runtime domain.
 *
 * Skipped under non-chromium browsers: the gates only exist for chromium.
 */

import { browserTest as it, expect } from '../config/browserTest';

type SendRecord = { method: string; sessionId?: string };

interface CapturedConnection {
  sends: SendRecord[];
  restore: () => void;
}

/**
 * Hook the server-side CRConnection's protocolLogger so we can observe every
 * outbound CDP send. Returns a recorder + a restore() callback.
 */
function captureConnection(serverBrowser: any): CapturedConnection {
  const connection = serverBrowser._connection;
  const sends: SendRecord[] = [];
  const original = connection._protocolLogger;
  connection._protocolLogger = (direction: 'send' | 'receive', message: any) => {
    if (direction === 'send' && message?.method)
      sends.push({ method: message.method, sessionId: message.sessionId });
    original(direction, message);
  };
  return {
    sends,
    restore: () => {
      connection._protocolLogger = original;
    },
  };
}

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only — CDP stealth gates apply only to the chromium driver');

it('default empty cdpStealth: Log.enable and Runtime.enable fire normally, NO Runtime.disable', async ({ browserType, toImpl }) => {
  const browser = await browserType.launch();
  try {
    const impl: any = toImpl(browser);
    // Field is `new Set()` by default; assert that explicitly so the test
    // surfaces a clear failure if the BrowserOptions assembly ever drops it.
    expect(impl.options.cdpStealth).toBeInstanceOf(Set);
    expect(impl.options.cdpStealth.size).toBe(0);

    const capture = captureConnection(impl);
    try {
      const page = await browser.newPage();
      await page.goto('data:text/html,<title>default</title>');
      const methods = capture.sends.map(s => s.method);
      expect(methods).toContain('Log.enable');
      expect(methods).toContain('Runtime.enable');
      expect(methods).not.toContain('Runtime.disable');
    } finally {
      capture.restore();
    }
  } finally {
    await browser.close();
  }
});

it('log-skip: Log.enable is NOT dispatched at page init', async ({ browserType, toImpl }) => {
  const browser = await browserType.launch();
  try {
    const impl: any = toImpl(browser);
    impl.options.cdpStealth = new Set(['log-skip']);

    const capture = captureConnection(impl);
    try {
      const page = await browser.newPage();
      await page.goto('data:text/html,<title>log-skip</title>');
      const methods = capture.sends.map(s => s.method);
      expect(methods).not.toContain('Log.enable');
      // Sanity: Runtime.enable still fires (we only skipped Log).
      expect(methods).toContain('Runtime.enable');
    } finally {
      capture.restore();
    }
  } finally {
    await browser.close();
  }
});

it('runtime-cycle at init: Runtime.enable followed by Runtime.disable on the same session', async ({ browserType, toImpl }) => {
  const browser = await browserType.launch();
  try {
    const impl: any = toImpl(browser);
    impl.options.cdpStealth = new Set(['runtime-cycle']);

    const capture = captureConnection(impl);
    try {
      const page = await browser.newPage();
      await page.goto('data:text/html,<title>runtime-cycle-init</title>');

      // Find the FrameSession's sessionId (the first non-empty session that
      // received Runtime.enable). We assert ordering relative to that session.
      const runtimeEnable = capture.sends.find(s => s.method === 'Runtime.enable');
      expect(runtimeEnable, 'Runtime.enable was never dispatched').toBeDefined();
      const sessionId = runtimeEnable!.sessionId;

      const onSession = capture.sends.filter(s => s.sessionId === sessionId);
      const enableIndex = onSession.findIndex(s => s.method === 'Runtime.enable');
      const disableIndex = onSession.findIndex(s => s.method === 'Runtime.disable');
      expect(disableIndex, 'Runtime.disable must be dispatched on the same session as Runtime.enable').toBeGreaterThan(-1);
      expect(disableIndex).toBeGreaterThan(enableIndex);
    } finally {
      capture.restore();
    }
  } finally {
    await browser.close();
  }
});

it('runtime-cycle at frame navigation: cycle repeats on cross-document navigation', async ({ browserType, toImpl, server }) => {
  const browser = await browserType.launch();
  try {
    const impl: any = toImpl(browser);
    impl.options.cdpStealth = new Set(['runtime-cycle']);

    const page = await browser.newPage();
    // First navigate (this is the initial commit; gate fires only on
    // non-initial navigation, so we'll re-navigate below).
    await page.goto(server.EMPTY_PAGE);

    // Now start capturing — we want the post-init nav, not the init nav.
    const capture = captureConnection(impl);
    try {
      // Same-origin cross-document navigation. We deliberately avoid
      // `CROSS_PROCESS_PREFIX` here — under modern site isolation a cross-
      // process navigation swaps to a new target with its own session, which
      // would route through `_onAttachedToTarget` (a different code path that
      // runs the full init-time cycle via the Runtime.enable promise chain)
      // rather than through `_onFrameNavigated` (the path this gate covers).
      await page.goto(server.PREFIX + '/title.html');
      // The Runtime cycle is fire-and-forget inside _onFrameNavigated, so
      // poll until both messages have been observed on the page session.
      await expect.poll(() => {
        const methods = capture.sends.map(s => s.method);
        return methods.includes('Runtime.enable') && methods.includes('Runtime.disable');
      }, { timeout: 5_000 }).toBe(true);

      // The captured stream can contain a tail Runtime.disable from the
      // init-time cycle (that one fires fire-and-forget and may land AFTER
      // we attached the capture). Anchor the post-navigation cycle by
      // finding the pair AFTER `Page.navigate`.
      const methods = capture.sends.map(s => s.method);
      const navIndex = methods.indexOf('Page.navigate');
      expect(navIndex, `methods=${methods.join(',')}`).toBeGreaterThanOrEqual(0);
      const postNav = methods.slice(navIndex);
      const postEnable = postNav.indexOf('Runtime.enable');
      const postDisable = postNav.indexOf('Runtime.disable');
      expect(postEnable, `post-nav methods=${postNav.join(',')}`).toBeGreaterThanOrEqual(0);
      expect(postDisable, `post-nav methods=${postNav.join(',')}`).toBeGreaterThan(postEnable);
    } finally {
      capture.restore();
    }
  } finally {
    await browser.close();
  }
});

it('worker-runtime: page-worker session emits Runtime.enable → Runtime.disable → runIfWaitingForDebugger in that EXACT order', async ({ browserType, toImpl, server }) => {
  // §4.7 — this is the canonical test for the dedicated-worker gap the
  // previous-generation fork left open. If `applyRuntimeCycle` is NOT wired
  // into the page-worker code path in crPage.ts, this test fails because
  // Runtime.disable never lands on the worker session.
  server.setRoute('/worker-host.html', (req, res) => {
    res.end(`<!doctype html>
      <html><body>
      <script>
        const blob = new Blob(['self.postMessage("worker-up");'], { type: 'application/javascript' });
        window.__worker = new Worker(URL.createObjectURL(blob));
      </script>
      </body></html>`);
  });

  const browser = await browserType.launch();
  try {
    const impl: any = toImpl(browser);
    impl.options.cdpStealth = new Set(['worker-runtime']);

    const capture = captureConnection(impl);
    try {
      const page = await browser.newPage();
      const workerPromise = page.waitForEvent('worker', { timeout: 10_000 });
      await page.goto(server.PREFIX + '/worker-host.html');
      await workerPromise;

      // Worker startup is fire-and-forget on the server: `applyRuntimeCycle`
      // is dispatched async after `Worker.workerScriptLoaded()` raises the
      // client-side 'worker' event. So at the moment `workerPromise` resolves,
      // `Runtime.disable` / `runIfWaitingForDebugger` may still be in flight.
      // Poll until the worker session emits the full triple.
      const findWorkerSession = () => {
        const ids = new Set(capture.sends.map(s => s.sessionId).filter(Boolean) as string[]);
        for (const sid of ids) {
          const methods = capture.sends.filter(s => s.sessionId === sid).map(s => s.method);
          if (methods.includes('Runtime.enable') &&
              methods.includes('Runtime.disable') &&
              methods.includes('Runtime.runIfWaitingForDebugger'))
            return sid;
        }
        return undefined;
      };
      await expect.poll(() => findWorkerSession() !== undefined, { timeout: 10_000 }).toBe(true);
      const sessionIds = new Set(capture.sends.map(s => s.sessionId).filter(Boolean) as string[]);
      const workerSessionId = findWorkerSession();
      // Diagnostic: dump per-session method lists so a failure tells us
      // which surface actually fired.
      const sessionSummary = [...sessionIds].map(sid => {
        const m = capture.sends.filter(s => s.sessionId === sid).map(s => s.method);
        return `${sid}: [${m.join(',')}]`;
      }).join('\n');
      const rootSummary = capture.sends.filter(s => !s.sessionId).map(s => s.method).join(',');
      expect(workerSessionId, `expected a worker session emitting Runtime.enable, Runtime.disable, AND Runtime.runIfWaitingForDebugger.\nRoot session: [${rootSummary}]\nChild sessions:\n${sessionSummary}`).toBeDefined();

      const onWorker = capture.sends.filter(s => s.sessionId === workerSessionId).map(s => s.method);
      const enableIndex = onWorker.indexOf('Runtime.enable');
      const disableIndex = onWorker.indexOf('Runtime.disable');
      const resumeIndex = onWorker.indexOf('Runtime.runIfWaitingForDebugger');

      // The load-bearing ordering invariant:
      //   Runtime.enable < Runtime.disable < Runtime.runIfWaitingForDebugger
      // If runIfWaitingForDebugger lands before Runtime.disable, the worker
      // resumes with the Runtime domain still exposed and `worker-runtime`
      // is defeated.
      expect(enableIndex, `worker stream: ${onWorker.join(',')}`).toBeGreaterThanOrEqual(0);
      expect(disableIndex).toBeGreaterThan(enableIndex);
      expect(resumeIndex).toBeGreaterThan(disableIndex);
    } finally {
      capture.restore();
    }
  } finally {
    await browser.close();
  }
});

it('worker-runtime absent: worker session emits Runtime.enable + runIfWaitingForDebugger but NO Runtime.disable', async ({ browserType, toImpl, server }) => {
  // Mirror of the previous test with the gate off: confirms the helper's
  // behavior is gated by the flag, not always-on.
  server.setRoute('/worker-host.html', (req, res) => {
    res.end(`<!doctype html>
      <html><body>
      <script>
        const blob = new Blob(['self.postMessage("worker-up");'], { type: 'application/javascript' });
        window.__worker = new Worker(URL.createObjectURL(blob));
      </script>
      </body></html>`);
  });

  const browser = await browserType.launch();
  try {
    const impl: any = toImpl(browser);
    // Default empty Set — no stealth.
    expect(impl.options.cdpStealth.size).toBe(0);

    const capture = captureConnection(impl);
    try {
      const page = await browser.newPage();
      const workerPromise = page.waitForEvent('worker', { timeout: 10_000 });
      await page.goto(server.PREFIX + '/worker-host.html');
      await workerPromise;

      // Worker startup is fire-and-forget; poll until the worker session
      // surfaces with the gateless pair (enable + runIfWaitingForDebugger).
      const findWorkerSession = () => {
        const ids = new Set(capture.sends.map(s => s.sessionId).filter(Boolean) as string[]);
        for (const sid of ids) {
          const methods = capture.sends.filter(s => s.sessionId === sid).map(s => s.method);
          if (methods.includes('Runtime.enable') &&
              methods.includes('Runtime.runIfWaitingForDebugger') &&
              !methods.includes('Runtime.disable'))
            return sid;
        }
        return undefined;
      };
      await expect.poll(() => findWorkerSession() !== undefined, { timeout: 10_000 }).toBe(true);
      const workerSessionId = findWorkerSession();
      const sessionIds = new Set(capture.sends.map(s => s.sessionId).filter(Boolean) as string[]);
      expect(workerSessionId, `expected a worker session with Runtime.enable + runIfWaitingForDebugger and NO Runtime.disable; sessions seen: ${[...sessionIds].join(',')}`).toBeDefined();
    } finally {
      capture.restore();
    }
  } finally {
    await browser.close();
  }
});
