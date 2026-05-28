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
 * CDP stealth feature Set + per-feature gates — Sapoto Tracer #1152 (Unit E).
 *
 * The previous-generation API exposed a single boolean `stealthMode` that
 * gated three distinct CDP-domain mitigations as a bundle. This module
 * decomposes that into a typed `Set<CdpStealthFeature>` so each can be
 * toggled independently from the CLI / channel surface (Tracer #1153 /
 * Unit G-stealth, which is not yet shipped — for now the gates here run
 * against an empty Set by default and apply no stealth).
 *
 * Features:
 *
 *   - 'runtime-cycle'  — rapid Runtime.enable → Runtime.disable cycle, used
 *                        to keep the long-lived Runtime domain (the
 *                        `console.debug` Proxy trap is the strongest
 *                        anti-bot fingerprint surface) dark to page scripts
 *                        while still letting Playwright discover
 *                        executionContexts at attach time and on
 *                        cross-document navigation. Drives BOTH the
 *                        page-init site AND the cross-document frame
 *                        navigation site — conceptually one mitigation.
 *   - 'log-skip'       — skip Log.enable. Log only surfaces browser-level
 *                        warnings (deprecation notices, network errors);
 *                        console messages come from Runtime.consoleAPICalled.
 *                        Removing Log shrinks the CDP surface anti-bot
 *                        fingerprinters watch for, with no functional impact.
 *   - 'worker-runtime' — same Runtime.enable → Runtime.disable cycle, but
 *                        applied per worker target (both dedicated page
 *                        workers AND service workers). The §4.7 dedicated
 *                        worker gap the previous-generation fork left open
 *                        — that fork only cycled service workers and left
 *                        `new Worker('x.js')` exposing the long-lived
 *                        Runtime domain. This module's `applyRuntimeCycle`
 *                        helper drives BOTH worker surfaces uniformly.
 *
 * `'network-skip'` is INTENTIONALLY rejected at parse time (LOUD error).
 * The previous-generation fork's Codex P1 review removed Network.enable
 * gating because it broke `page.on('request')` listeners and silently
 * regressed every fetch interception path in production. Re-adding it
 * would silently regress the same surface — we reject the wire value to
 * make any attempt to re-introduce it impossible without an explicit code
 * change here, where reviewers can see the prohibition.
 *
 * No legacy `stealthMode: true` boolean alias. The Set is canonical.
 */

export type CdpStealthFeature = 'runtime-cycle' | 'log-skip' | 'worker-runtime';

export const CDP_STEALTH_FEATURES: readonly CdpStealthFeature[] = [
  'runtime-cycle',
  'log-skip',
  'worker-runtime',
];

// Type-level assertion: BrowserOptions.cdpStealth's element type MUST stay
// in sync with CdpStealthFeature. The literal is duplicated on BrowserOptions
// (not imported) due to DEPS.list constraints (server/ generic cannot import
// server/chromium/). This assertion catches drift in BOTH directions at
// compile time. If you add or remove a feature, update both sides.
type _CdpStealthFeatureBrowserOptions = 'runtime-cycle' | 'log-skip' | 'worker-runtime';
type _CdpStealthFeatureSync =
  Exclude<CdpStealthFeature, _CdpStealthFeatureBrowserOptions> extends never
    ? Exclude<_CdpStealthFeatureBrowserOptions, CdpStealthFeature> extends never
      ? true
      : never
    : never;
const _assertCdpStealthFeatureSync: _CdpStealthFeatureSync = true;
void _assertCdpStealthFeatureSync;  // satisfies eslint no-unused-vars

const CDP_STEALTH_FEATURE_SET: ReadonlySet<string> = new Set<string>(CDP_STEALTH_FEATURES);

/**
 * Parse a wire-format `string[]` into a typed `Set<CdpStealthFeature>`.
 *
 * Unknown values throw a loud, descriptive error — in particular,
 * `'network-skip'` is rejected by name (see module header for the Codex P1
 * lesson). Pass an empty array to get the default empty Set.
 */
export function parseCdpStealthFeatures(features: readonly string[]): Set<CdpStealthFeature> {
  const set = new Set<CdpStealthFeature>();
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

// ----------------------------------------------------------------------
// Per-feature pure-decision gates
// ----------------------------------------------------------------------

/**
 * Should the page initializer skip `Log.enable`?
 *
 * When stealth gate `log-skip` is present, we do not enable the Log domain.
 * Otherwise we keep the default upstream behavior (enable it).
 */
export function shouldSkipLogEnable(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('log-skip');
}

/**
 * Should the page initializer issue the rapid Runtime.enable → Runtime.disable
 * cycle right after the initial `Runtime.enable` at page attach?
 */
export function shouldCycleRuntimeOnInit(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('runtime-cycle');
}

/**
 * Should the page initializer issue a Runtime.enable → Runtime.disable cycle
 * on a main-frame cross-document navigation? Driven by the same flag as the
 * init-time cycle — splitting them is intentionally out of scope.
 */
export function shouldCycleRuntimeOnFrameNavigation(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('runtime-cycle');
}

/**
 * Should both page workers (dedicated `new Worker('x.js')`) and service
 * workers issue a Runtime.enable → Runtime.disable cycle on session startup?
 *
 * The previous-generation fork wired this for service workers ONLY, leaving
 * the §4.7 dedicated-worker surface inconsistent — that fork's pages cycled
 * Runtime but their dedicated workers did not, producing observable behavior
 * differences between surfaces that anti-bot stacks can fingerprint as
 * "automation, with a partial mitigation". Both surfaces now run through
 * `applyRuntimeCycle` below; the same gate drives both.
 */
export function shouldCycleWorkerRuntime(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('worker-runtime');
}

// ----------------------------------------------------------------------
// Worker-startup ordering chain
// ----------------------------------------------------------------------

/**
 * Minimal structural surface of a CDP session that `applyRuntimeCycle`
 * needs. Mirrors the two methods `CRSession` exposes (`send` for the
 * load-bearing first message and `_sendMayFail` for the follow-ups) without
 * dragging in the full Protocol typing — keeps the helper trivially
 * testable with a stub session in unit tests.
 *
 * Real-Chromium tests pass a `CRSession` directly; the structural typing
 * just means we don't have to import the full protocol types here.
 */
export interface RuntimeCycleSession {
  send(method: string, params?: any): Promise<any>;
  _sendMayFail(method: string, params?: any): Promise<any>;
}

/**
 * Apply the worker-startup CDP stealth sequence on a freshly-attached
 * worker session. Used by BOTH `CRServiceWorker` (service workers) AND the
 * page-worker code path in `crPage.ts` (dedicated workers spawned via
 * `new Worker('x.js')`) — wiring both surfaces through this helper is what
 * closes the §4.7 dedicated-worker gap the previous-generation fork had.
 *
 * The order is LOAD-BEARING:
 *
 *     Runtime.enable
 *       → (if worker-runtime gate set) Runtime.disable
 *       → Runtime.runIfWaitingForDebugger
 *
 * CRITICAL: `Runtime.runIfWaitingForDebugger` MUST land AFTER
 * `Runtime.disable`. If the worker resumes before the disable lands, the
 * long-lived Runtime domain is exposed to worker scripts and the entire
 * `worker-runtime` mitigation is defeated. The chain below enforces that
 * ordering by chaining `.then(...)` rather than firing in parallel.
 *
 * See https://github.com/ChromeDevTools/devtools-protocol/issues/72 for the
 * upstream ordering caveat: `runIfWaitingForDebugger` resumes the target
 * synchronously on the renderer side, so any state mutation that needs to
 * happen "before scripts run" must complete (round-tripped to the renderer)
 * before that call lands.
 *
 * Both `send`s individually swallow rejection (matching the prior
 * `.catch(e => {})` behavior at the call sites we replaced) so
 * Runtime.enable failing or the session disposing mid-cycle never crashes
 * the worker constructor.
 */
export function applyRuntimeCycle(
  session: RuntimeCycleSession,
  cdpStealth: ReadonlySet<CdpStealthFeature>,
): Promise<void> {
  const runtimeReady = session.send('Runtime.enable', {}).then(() => {
    if (shouldCycleWorkerRuntime(cdpStealth)) {
      // Microtask boundary lets `executionContextCreated` events queued by
      // Runtime.enable drain into Playwright's listeners before we disable.
      return Promise.resolve().then(() => session._sendMayFail('Runtime.disable'));
    }
    return undefined;
  }).catch(() => {});

  return runtimeReady.then(() => {
    return session._sendMayFail('Runtime.runIfWaitingForDebugger').then(() => {});
  });
}
