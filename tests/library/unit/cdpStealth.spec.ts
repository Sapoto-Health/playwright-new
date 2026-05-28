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
 * Sapoto Tracer #1152 (Unit E) — pure-logic tests for the CDP stealth feature
 * Set, parser, and per-feature gates. No Chromium / CDP required; these
 * exercise the functions in isolation. The wire-level integration tests live
 * alongside in `tests/library/cdp-stealth-gates.spec.ts`.
 */

import { test as it, expect } from '@playwright/test';
import type { CdpStealthFeature } from '../../../packages/playwright-core/src/server/chromium/crCdpStealth';
import {
  applyRuntimeCycle,
  parseCdpStealthFeatures,
  shouldCycleRuntimeOnFrameNavigation,
  shouldCycleRuntimeOnInit,
  shouldCycleWorkerRuntime,
  shouldSkipLogEnable,
} from '../../../packages/playwright-core/src/server/chromium/crCdpStealth';

function gates(...features: CdpStealthFeature[]): Set<CdpStealthFeature> {
  return new Set<CdpStealthFeature>(features);
}

// ----------------------------------------------------------------------
// parseCdpStealthFeatures — wire-format → typed Set
// ----------------------------------------------------------------------

it('parseCdpStealthFeatures([]) returns an empty Set', () => {
  const set = parseCdpStealthFeatures([]);
  expect(set.size).toBe(0);
});

it('parseCdpStealthFeatures(["runtime-cycle"]) returns Set with runtime-cycle', () => {
  const set = parseCdpStealthFeatures(['runtime-cycle']);
  expect([...set]).toEqual(['runtime-cycle']);
});

it('parseCdpStealthFeatures accepts the full feature triple', () => {
  const set = parseCdpStealthFeatures(['runtime-cycle', 'log-skip', 'worker-runtime']);
  expect(set.size).toBe(3);
  expect(set.has('runtime-cycle')).toBe(true);
  expect(set.has('log-skip')).toBe(true);
  expect(set.has('worker-runtime')).toBe(true);
});

it('parseCdpStealthFeatures rejects "network-skip" with a LOUD, descriptive error', () => {
  // This is a Codex P1 lesson from the previous-generation fork: `network-skip`
  // broke `page.on('request')` listeners and silently regressed every fetch
  // interception path. Re-adding it as a real feature would silently regress
  // the same surface, so we reject the wire value by name.
  expect(() => parseCdpStealthFeatures(['network-skip'])).toThrow(/network-skip/);
  expect(() => parseCdpStealthFeatures(['network-skip'])).toThrow(/rejected by design/);
  expect(() => parseCdpStealthFeatures(['network-skip'])).toThrow(/page\.on\('request'\)|fetch interception/);
  // Mixed input still rejects on the bad value.
  expect(() => parseCdpStealthFeatures(['runtime-cycle', 'network-skip'])).toThrow(/network-skip/);
});

it('parseCdpStealthFeatures rejects unknown values with a descriptive error', () => {
  expect(() => parseCdpStealthFeatures(['totally-bogus'])).toThrow(/Invalid cdpStealth feature/);
  expect(() => parseCdpStealthFeatures(['totally-bogus'])).toThrow(/runtime-cycle/);
  expect(() => parseCdpStealthFeatures(['totally-bogus'])).toThrow(/log-skip/);
  expect(() => parseCdpStealthFeatures(['totally-bogus'])).toThrow(/worker-runtime/);
});

// ----------------------------------------------------------------------
// Per-feature gates — pure-decision helpers
// ----------------------------------------------------------------------

it('shouldSkipLogEnable returns true iff log-skip is in the set', () => {
  expect(shouldSkipLogEnable(gates())).toBe(false);
  expect(shouldSkipLogEnable(gates('log-skip'))).toBe(true);
  expect(shouldSkipLogEnable(gates('runtime-cycle'))).toBe(false);
  expect(shouldSkipLogEnable(gates('worker-runtime'))).toBe(false);
  expect(shouldSkipLogEnable(gates('log-skip', 'runtime-cycle', 'worker-runtime'))).toBe(true);
});

it('shouldCycleRuntimeOnInit returns true iff runtime-cycle is in the set', () => {
  expect(shouldCycleRuntimeOnInit(gates())).toBe(false);
  expect(shouldCycleRuntimeOnInit(gates('log-skip'))).toBe(false);
  expect(shouldCycleRuntimeOnInit(gates('runtime-cycle'))).toBe(true);
  expect(shouldCycleRuntimeOnInit(gates('worker-runtime'))).toBe(false);
  expect(shouldCycleRuntimeOnInit(gates('runtime-cycle', 'worker-runtime'))).toBe(true);
});

it('shouldCycleRuntimeOnFrameNavigation returns true iff runtime-cycle is in the set', () => {
  // Same flag as init. Splitting the two sites is intentionally out of scope.
  expect(shouldCycleRuntimeOnFrameNavigation(gates())).toBe(false);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('log-skip'))).toBe(false);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('runtime-cycle'))).toBe(true);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('worker-runtime'))).toBe(false);
});

it('shouldCycleWorkerRuntime returns true iff worker-runtime is in the set', () => {
  expect(shouldCycleWorkerRuntime(gates())).toBe(false);
  expect(shouldCycleWorkerRuntime(gates('log-skip'))).toBe(false);
  expect(shouldCycleWorkerRuntime(gates('runtime-cycle'))).toBe(false);
  expect(shouldCycleWorkerRuntime(gates('worker-runtime'))).toBe(true);
  expect(shouldCycleWorkerRuntime(gates('runtime-cycle', 'worker-runtime'))).toBe(true);
});

it('gates are independent: each flag toggles only its own gate', () => {
  expect(shouldSkipLogEnable(gates('log-skip'))).toBe(true);
  expect(shouldCycleRuntimeOnInit(gates('log-skip'))).toBe(false);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('log-skip'))).toBe(false);
  expect(shouldCycleWorkerRuntime(gates('log-skip'))).toBe(false);

  expect(shouldSkipLogEnable(gates('runtime-cycle'))).toBe(false);
  expect(shouldCycleRuntimeOnInit(gates('runtime-cycle'))).toBe(true);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('runtime-cycle'))).toBe(true);
  expect(shouldCycleWorkerRuntime(gates('runtime-cycle'))).toBe(false);

  expect(shouldSkipLogEnable(gates('worker-runtime'))).toBe(false);
  expect(shouldCycleRuntimeOnInit(gates('worker-runtime'))).toBe(false);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('worker-runtime'))).toBe(false);
  expect(shouldCycleWorkerRuntime(gates('worker-runtime'))).toBe(true);
});

// ----------------------------------------------------------------------
// applyRuntimeCycle — load-bearing ordering chain
// ----------------------------------------------------------------------

type SendCall = { method: string; params?: any };
function createStubSession(): {
  calls: SendCall[];
  send: (method: string, params?: any) => Promise<any>;
  _sendMayFail: (method: string, params?: any) => Promise<any>;
} {
  const calls: SendCall[] = [];
  return {
    calls,
    send: async (method, params) => {
      calls.push({ method, params });
      return {};
    },
    _sendMayFail: async (method, params) => {
      calls.push({ method, params });
      return undefined;
    },
  };
}

it('applyRuntimeCycle without worker-runtime: Runtime.enable + runIfWaitingForDebugger, NO Runtime.disable', async () => {
  for (const features of [gates(), gates('log-skip'), gates('runtime-cycle')]) {
    const stub = createStubSession();
    await applyRuntimeCycle(stub, features);
    expect(stub.calls.map(c => c.method), `features=${[...features].join(',')}`).toEqual([
      'Runtime.enable',
      'Runtime.runIfWaitingForDebugger',
    ]);
  }
});

it('applyRuntimeCycle WITH worker-runtime: Runtime.enable → Runtime.disable → runIfWaitingForDebugger in that exact order', async () => {
  // This is the load-bearing ordering invariant. If runIfWaitingForDebugger
  // landed before Runtime.disable, the worker would resume with the Runtime
  // domain still exposed and the mitigation would be defeated.
  for (const features of [
    gates('worker-runtime'),
    gates('worker-runtime', 'log-skip'),
    gates('worker-runtime', 'runtime-cycle'),
    gates('worker-runtime', 'log-skip', 'runtime-cycle'),
  ]) {
    const stub = createStubSession();
    await applyRuntimeCycle(stub, features);
    const methods = stub.calls.map(c => c.method);
    expect(methods, `features=${[...features].join(',')}`).toEqual([
      'Runtime.enable',
      'Runtime.disable',
      'Runtime.runIfWaitingForDebugger',
    ]);
    expect(
        methods.indexOf('Runtime.runIfWaitingForDebugger'),
        `runIfWaitingForDebugger must follow Runtime.disable (features=${[...features].join(',')})`,
    ).toBeGreaterThan(methods.indexOf('Runtime.disable'));
  }
});

it('applyRuntimeCycle resolves even if Runtime.enable rejects (matches prior _sendMayFail semantics)', async () => {
  // The worker constructor used to fire-and-forget `_sendMayFail('Runtime.enable')`
  // with no catch. The helper must preserve that "never crash the constructor"
  // behavior so a target closing mid-cycle does not throw out of the call site.
  const session: {
    send: (m: string, p?: any) => Promise<any>;
    _sendMayFail: (m: string, p?: any) => Promise<any>;
    calls: string[];
  } = {
    calls: [],
    send: async (method: string) => {
      if (method === 'Runtime.enable')
        throw new Error('target closed mid-cycle');
      return {};
    },
    _sendMayFail: async (method: string) => {
      session.calls.push(method);
      return undefined;
    },
  };
  await expect(applyRuntimeCycle(session, gates('worker-runtime'))).resolves.toBeUndefined();
  // Runtime.disable is gated on Runtime.enable succeeding, so we should NOT
  // see it when enable failed. We should still attempt runIfWaitingForDebugger
  // — the worker resume call survives the cycle failing.
  expect(session.calls).toEqual(['Runtime.runIfWaitingForDebugger']);
});
