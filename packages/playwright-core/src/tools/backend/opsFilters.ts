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
 * Sapoto Tracer #1155 (Unit G-ops) — pure helpers backing the four
 * embedder-ops CLI flags:
 *
 *   --filter-internal-urls   → `isInternalUrl()`
 *   --disable-downloads      → (no helper; consumed inline in tab.ts)
 *   --timeout-download <ms>  → (no helper; consumed inline in tab.ts)
 *   --allowed-tools <list>   → `parseAllowedTools()`
 *
 * Kept in a stand-alone module so the unit suite can exercise them
 * without spinning up a Chromium / CDP fixture.
 */

/**
 * Internal-URL predicate for `--filter-internal-urls`.
 *
 * Returns true for embedder-side pages that should be hidden from
 * `browser_tabs` because they are implementation detail (Electron host
 * panes, devtools, extension popups, local dev servers) rather than
 * pages the agent should drive.
 *
 * Matching prefixes / hostnames:
 *   - file://          (any path)
 *   - data:            (any payload)
 *   - chrome-extension://  (any extension)
 *   - hostname === 'localhost'   (http://, https://, any port, any path)
 *
 * NOTE: hostname check is strict-equal — `https://localhost.example.com/`
 * is a real internet domain and must NOT match. Substring matching here
 * would silently swallow legitimate sites. `127.0.0.1` is also NOT
 * matched: the PRD pins this to `localhost` exactly.
 *
 * Malformed URLs return false so the caller falls through to the
 * no-filter path.
 */
export function isInternalUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0)
    return false;
  if (url.startsWith('file://'))
    return true;
  if (url.startsWith('data:'))
    return true;
  if (url.startsWith('chrome-extension://'))
    return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost')
      return true;
  } catch {
    // Not a parseable URL — treat as not-internal so we don't accidentally
    // hide tabs on malformed inputs.
  }
  return false;
}

/**
 * Parse the comma-separated `--allowed-tools` / PLAYWRIGHT_MCP_ALLOWED_TOOLS
 * value into a Set-shaped lookup object, or `undefined` if no allowlist
 * was configured.
 *
 * `undefined` is a sentinel meaning "no filter, advertise every tool";
 * the consumer in `tools.ts` short-circuits the filter when the lookup
 * is undefined to preserve the upstream-default behaviour.
 */
export function parseAllowedTools(value: string | undefined): Record<string, true> | undefined {
  if (value === undefined || value === null)
    return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0)
    return undefined;
  const names = trimmed.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (names.length === 0)
    return undefined;
  const lookup: Record<string, true> = {};
  for (const name of names)
    lookup[name] = true;
  return lookup;
}
