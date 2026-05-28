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
 * Server-side wire-format rehydrator for the CDP stealth feature Set — Sapoto
 * Tracer #1153 (Unit G-stealth).
 *
 * Lives at `server/` (not `server/chromium/`) because the 5 BrowserOptions
 * assembly sites (browserType.ts, chromium/chromium.ts, android/android.ts,
 * electron/electron.ts, webkit/webview/wvBrowser.ts) need to populate
 * `cdpStealth: Set<CdpStealthFeature>` from a channel-supplied `string[]`,
 * and `server/` DEPS rules forbid generic server modules from importing
 * server/chromium/. The chromium-side gates module (`crCdpStealth.ts`) keeps
 * its own canonical declaration + drift guard against BrowserOptions; this
 * module is the wire-format gateway and lives DEPS-clean of chromium.
 *
 * The element-type literal is duplicated rather than imported from
 * crCdpStealth.ts because:
 *
 *   - crCdpStealth.ts cannot import from this file at runtime (the gates
 *     module is consumed by the chromium driver only and the type alias is
 *     a chromium implementation detail).
 *   - The compile-time drift guard on crCdpStealth.ts already catches drift
 *     against BrowserOptions's inline literal. This module's literal is
 *     structurally identical to both of those, so an additional drift guard
 *     would be redundant.
 *
 * `'network-skip'` is INTENTIONALLY rejected at parse time (LOUD error). See
 * `crCdpStealth.ts` header for the Codex P1 rationale — the previous-
 * generation fork removed Network.enable gating because it broke
 * `page.on('request')` listeners. We reject the wire value here so any
 * attempt to silently re-introduce it gets a runtime crash before reaching
 * the chromium driver.
 */

export type CdpStealthFeature = 'runtime-cycle' | 'log-skip' | 'worker-runtime';

export const CDP_STEALTH_FEATURES: readonly CdpStealthFeature[] = [
  'runtime-cycle',
  'log-skip',
  'worker-runtime',
];

const CDP_STEALTH_FEATURE_SET: ReadonlySet<string> = new Set<string>(CDP_STEALTH_FEATURES);

/**
 * Parse a wire-format `string[]` (or `undefined` when the channel param was
 * not set) into a typed `Set<CdpStealthFeature>`. The empty-array path
 * returns an empty Set so the gates in chromium/crCdpStealth.ts stay dormant
 * — matching the "no stealth" default at every assembly site.
 *
 * Unknown values throw a loud, descriptive error. `'network-skip'` is
 * rejected by name (Codex P1 lesson from the previous-generation fork).
 */
export function parseCdpStealthFeatures(features: readonly string[] | undefined): Set<CdpStealthFeature> {
  const set = new Set<CdpStealthFeature>();
  if (!features)
    return set;
  for (const raw of features) {
    if (raw === 'network-skip') {
      throw new Error(
          `Invalid cdpStealth feature: "network-skip" is rejected by design. ` +
          `It was removed during Codex P1 review on the previous-generation fork because ` +
          `it silently broke page.on('request') listeners and every fetch interception path. ` +
          `Allowed values: ${CDP_STEALTH_FEATURES.map(v => JSON.stringify(v)).join(', ')}.`);
    }
    if (!CDP_STEALTH_FEATURE_SET.has(raw)) {
      throw new Error(
          `Invalid cdpStealth feature: ${JSON.stringify(raw)}. ` +
          `Allowed values: ${CDP_STEALTH_FEATURES.map(v => JSON.stringify(v)).join(', ')}.`);
    }
    set.add(raw as CdpStealthFeature);
  }
  return set;
}
