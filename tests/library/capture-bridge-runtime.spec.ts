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
 * Sapoto Tracer #1154 (Unit I) — runtime invariants for the capture-bridge
 * IIFE that must be asserted against a real page (not against the source
 * string).
 *
 * The wire-contract test in `unit/captureBridgeWireContract.spec.ts` asserts
 * that `__SAPOTO_PATHD_BRIDGE_V1_STAMP__` appears verbatim in the IIFE
 * SOURCE — that catches a rename. It does NOT catch a regression where the
 * stamp is accidentally lifted to a window global (e.g. someone changes
 * `void 'STAMP'` to `window.STAMP = '...'`). PRD user-story #18 codifies the
 * "no window pollution, just a `void` expression" invariant. This test pins
 * the runtime behaviour.
 */

import { contextTest as it, expect } from '../config/browserTest';
import { buildCaptureBridgeInitScript } from '../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only — capture-bridge lives on the chromium agent-runner path');

const BRIDGE_SCRIPT = buildCaptureBridgeInitScript({ captureBridge: true });

it('__SAPOTO_PATHD_BRIDGE_V1_STAMP__ does not pollute the window global', async ({ context, server }) => {
  await context.addInitScript({ content: BRIDGE_SCRIPT });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  // 1) No `SAPOTO`-prefixed window globals should exist after the IIFE runs.
  const sapotoGlobals = await page.evaluate(() => {
    return Object.getOwnPropertyNames(window).filter(k => k.includes('SAPOTO'));
  });
  expect(sapotoGlobals).toEqual([]);

  // 2) Defence in depth — the stamp itself must read as `undefined`, not
  // accidentally exposed via a property descriptor with an accessor.
  const stampOnWindow = await page.evaluate(() => {
    return typeof (window as any).__SAPOTO_PATHD_BRIDGE_V1_STAMP__;
  });
  expect(stampOnWindow).toBe('undefined');
});
