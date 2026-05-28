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
 * CLI-surface parser for the `--cdp-stealth=<comma-list>` flag — Sapoto
 * Tracer #1153 (Unit G-stealth).
 *
 * This file lives in `packages/isomorphic/` because it must be reachable from
 * BOTH the client-side CLI option parser AND the server-side channel
 * validation path, without dragging the server import chain into a unit test.
 *
 * Domain semantics are intentionally redundant with the post-validator on the
 * server side:
 *
 *   - `packages/playwright-core/src/server/chromium/crCdpStealth.ts:parseCdpStealthFeatures`
 *     is the post-validator authority. It rehydrates the wire `string[]` to a
 *     typed `Set<CdpStealthFeature>` and throws on unknown values (including
 *     `network-skip`).
 *
 *   - This file is the pre-validator CLI surface. It accepts the textual
 *     comma-list form, expands the `all` sentinel, and produces the wire
 *     `string[]` that the post-validator expects.
 *
 * Both ends reject `network-skip` for the same reason (Codex P1 review on the
 * previous-generation fork removed Network.enable gating because it broke
 * `page.on('request')` listeners and silently regressed every fetch
 * interception path), so a stale invocation script gets a loud failure at the
 * CLI layer instead of a silent no-op deeper in.
 *
 * The canonical feature list is duplicated here rather than imported from the
 * server module because this file lives in the isomorphic leaf set and must
 * not import from server/. The type-level drift guard on `crCdpStealth.ts`
 * already catches drift against `BrowserOptions.cdpStealth`; this third copy
 * is structurally identical to those two.
 */

/**
 * The canonical feature set the `--cdp-stealth=all` sentinel expands to.
 * Mirrors `server/chromium/crCdpStealth.ts:CDP_STEALTH_FEATURES`.
 */
export const CDP_STEALTH_CLI_FEATURES: ReadonlyArray<string> = Object.freeze([
  'runtime-cycle',
  'log-skip',
  'worker-runtime',
]);

const CDP_STEALTH_CLI_FEATURE_SET: ReadonlySet<string> = new Set<string>(CDP_STEALTH_CLI_FEATURES);

/**
 * Parse the textual `--cdp-stealth=<comma-list>` argument into the wire
 * payload (`string[]`).
 *
 * Semantic forms:
 *   - `""`         → flag passed with an empty value → returns `[]`. The CLI
 *                    invocation can deterministically opt out of all stealth
 *                    features.
 *   - `"all"`      → expands to the full feature bundle.
 *   - `"a,b,..."`  → comma-separated list of features. Whitespace around each
 *                    entry is trimmed; unknown values (including
 *                    `network-skip`) throw a loud, descriptive error pointing
 *                    back at the bad token.
 *
 * Unlike the previous-generation fork, this parser does NOT accept the
 * `undefined` sentinel — the CLI / channel layer must call this only when a
 * value is present. Callers that want "flag not supplied" semantics should
 * check that themselves before calling.
 */
export function parseCdpStealthCli(value: string): string[] {
  if (value === '')
    return [];
  if (value === 'all')
    return [...CDP_STEALTH_CLI_FEATURES];
  const parts = value.split(',').map(v => v.trim()).filter(v => v.length > 0);
  if (parts.length === 0)
    return [];
  for (const part of parts) {
    if (part === 'network-skip') {
      throw new Error(
          `Invalid --cdp-stealth value: "network-skip" is rejected by design. ` +
          `It was removed during Codex P1 review on the previous-generation fork because ` +
          `it silently broke page.on('request') listeners and every fetch interception path. ` +
          `Allowed values: ${CDP_STEALTH_CLI_FEATURES.map(v => JSON.stringify(v)).join(', ')}, "all", or empty.`);
    }
    if (!CDP_STEALTH_CLI_FEATURE_SET.has(part)) {
      const allowed = CDP_STEALTH_CLI_FEATURES.map(v => JSON.stringify(v)).join(', ');
      throw new Error(`Invalid --cdp-stealth value: ${JSON.stringify(part)}. Allowed: ${allowed}, "all", or empty.`);
    }
  }
  return parts;
}
