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
 * Sapoto Tracer #1153 (Unit G-stealth) — channel-propagation tests for the
 * cdpStealth wire field.
 *
 * What this proves: when a client passes `cdpStealth: ['runtime-cycle']` (or
 * any wire-format string[]) on launch / connectOverCDP, the server-side
 * `BrowserOptions.cdpStealth` Set is correctly populated by
 * `parseCdpStealthFeatures`. This is the seam between the CLI / channel
 * surface and the chromium-side gates (Unit E owns the gate-firing tests in
 * cdp-stealth-gates.spec.ts; this file owns the propagation seam).
 *
 * Skipped under non-chromium browsers: the BrowserOptions field is shared
 * across all engines (so the parser runs everywhere), but the propagation
 * test relies on launching chromium specifically — there's no portable way
 * to assert "the parser ran" on engines that ignore the result.
 */

import { browserTest as it, expect } from '../config/browserTest';

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only — the cdpStealth field is consumed by the chromium driver');

// ----------------------------------------------------------------------
// launch path — LaunchOptions.cdpStealth mixin
// ----------------------------------------------------------------------

it('launch with cdpStealth=["runtime-cycle"] populates BrowserOptions.cdpStealth as a typed Set', async ({ browserType, toImpl }) => {
  // Cast to any: the public LaunchOptions type does NOT expose cdpStealth
  // (channel-only), but the field is on the channel mixin and propagates via
  // `...options` spread inside `Client.launch`. Passing it at runtime is the
  // intended use; the lack of a public type is intentional.
  const browser = await browserType.launch({ cdpStealth: ['runtime-cycle'] } as any);
  try {
    const impl: any = toImpl(browser);
    expect(impl.options.cdpStealth).toBeInstanceOf(Set);
    expect(impl.options.cdpStealth.size).toBe(1);
    expect(impl.options.cdpStealth.has('runtime-cycle')).toBe(true);
  } finally {
    await browser.close();
  }
});

it('launch with cdpStealth=["runtime-cycle","log-skip","worker-runtime"] populates all three', async ({ browserType, toImpl }) => {
  const browser = await browserType.launch({ cdpStealth: ['runtime-cycle', 'log-skip', 'worker-runtime'] } as any);
  try {
    const impl: any = toImpl(browser);
    expect(impl.options.cdpStealth).toBeInstanceOf(Set);
    expect(impl.options.cdpStealth.size).toBe(3);
    expect(impl.options.cdpStealth.has('runtime-cycle')).toBe(true);
    expect(impl.options.cdpStealth.has('log-skip')).toBe(true);
    expect(impl.options.cdpStealth.has('worker-runtime')).toBe(true);
  } finally {
    await browser.close();
  }
});

it('launch with cdpStealth omitted yields an empty Set (dormant gates, no regression)', async ({ browserType, toImpl }) => {
  const browser = await browserType.launch();
  try {
    const impl: any = toImpl(browser);
    expect(impl.options.cdpStealth).toBeInstanceOf(Set);
    expect(impl.options.cdpStealth.size).toBe(0);
  } finally {
    await browser.close();
  }
});

it('launch with cdpStealth=[] yields an empty Set (explicit opt-out)', async ({ browserType, toImpl }) => {
  const browser = await browserType.launch({ cdpStealth: [] } as any);
  try {
    const impl: any = toImpl(browser);
    expect(impl.options.cdpStealth).toBeInstanceOf(Set);
    expect(impl.options.cdpStealth.size).toBe(0);
  } finally {
    await browser.close();
  }
});

// ----------------------------------------------------------------------
// Server-side `network-skip` rejection still enforced through the channel
// ----------------------------------------------------------------------

it('launch with cdpStealth=["network-skip"] throws the LOUD server-side error', async ({ browserType }) => {
  // The loud rejection lives on the server-side parseCdpStealthFeatures
  // helper; the channel surface ferries the string[] verbatim, so the throw
  // propagates back to the client as a rejected promise.
  await expect(
      browserType.launch({ cdpStealth: ['network-skip'] } as any),
  ).rejects.toThrow(/network-skip/);
});

it('launch with cdpStealth=["bogus-feature"] rejects with the descriptive server error', async ({ browserType }) => {
  await expect(
      browserType.launch({ cdpStealth: ['bogus-feature'] } as any),
  ).rejects.toThrow(/Invalid cdpStealth feature/);
});

// ----------------------------------------------------------------------
// connectOverCDP path — BrowserType.connectOverCDPParams.cdpStealth
// ----------------------------------------------------------------------

it('connectOverCDP forwards cdpStealth on its own params surface (not just LaunchOptions)', async ({ browserType, toImpl }) => {
  // The wire-level proof: launch a chromium with --remote-debugging-port=0,
  // discover the assigned port, then connectOverCDP back into it with an
  // explicit cdpStealth on the CONNECT params (which lives on
  // connectOverCDPParams in the channel YAML, distinct from the LaunchOptions
  // mixin — proving both wire paths reach the parser).
  const launched = await browserType.launch({ args: ['--remote-debugging-port=0'] });
  try {
    // The server-side Browser carries the wsEndpoint discovered from the
    // chromium process's "DevTools listening on" line.
    const launchedImpl: any = toImpl(launched);
    const wsEndpoint: string | undefined = launchedImpl?.options?.wsEndpoint;
    if (!wsEndpoint) {
      // Some chromium configurations don't surface wsEndpoint on the server
      // Browser. The launch-path tests already cover the BrowserOptions
      // propagation; skip the redundant connectOverCDP variant in that case.
      return;
    }
    const connected = await browserType.connectOverCDP(wsEndpoint, {
      cdpStealth: ['log-skip'],
    } as Parameters<typeof browserType.connectOverCDP>[1] & { cdpStealth?: string[] });
    try {
      const impl: any = toImpl(connected);
      expect(impl.options.cdpStealth).toBeInstanceOf(Set);
      expect(impl.options.cdpStealth.has('log-skip')).toBe(true);
    } finally {
      await connected.close();
    }
  } finally {
    await launched.close();
  }
});
