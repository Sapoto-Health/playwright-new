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
 * Sapoto Tracer #1155 (Unit G-ops) — pure-logic tests for the 4 ops CLI
 * flags. No Chromium / CDP required.
 *
 * Covers:
 *   - `isInternalUrl()` — the predicate used by `--filter-internal-urls`
 *     to exclude embedder-internal pages from `browser_tabs`.
 *   - `parseAllowedTools()` — the parser used by `--allowed-tools` /
 *     PLAYWRIGHT_MCP_ALLOWED_TOOLS to whitelist exposed MCP tools.
 */

import { test as it, expect } from '@playwright/test';
import {
  isInternalUrl,
  parseAllowedTools,
} from '../../../packages/playwright-core/src/tools/backend/opsFilters';

// ----------------------------------------------------------------------
// isInternalUrl — used by --filter-internal-urls
// ----------------------------------------------------------------------

it('isInternalUrl matches file:// URLs', () => {
  expect(isInternalUrl('file:///tmp/x.html')).toBe(true);
  expect(isInternalUrl('file://x.html')).toBe(true);
});

it('isInternalUrl matches data: URLs', () => {
  expect(isInternalUrl('data:text/html,foo')).toBe(true);
  expect(isInternalUrl('data:application/pdf;base64,JVBERi0xLjQK')).toBe(true);
});

it('isInternalUrl matches chrome-extension:// URLs', () => {
  expect(isInternalUrl('chrome-extension://abcdefg/page.html')).toBe(true);
});

it('isInternalUrl matches http://localhost:* URLs', () => {
  expect(isInternalUrl('http://localhost:3000/x')).toBe(true);
  expect(isInternalUrl('http://localhost/')).toBe(true);
});

it('isInternalUrl matches https://localhost URLs', () => {
  expect(isInternalUrl('https://localhost/')).toBe(true);
  expect(isInternalUrl('https://localhost:8443/admin')).toBe(true);
});

it('isInternalUrl does NOT match arbitrary HTTPS origins', () => {
  expect(isInternalUrl('https://example.com/')).toBe(false);
  expect(isInternalUrl('https://example.com/path?q=1')).toBe(false);
  expect(isInternalUrl('http://example.com:8080/')).toBe(false);
});

it('isInternalUrl does NOT match localhost.example.com (substring of hostname)', () => {
  // The spec requires EXACT hostname match — `localhost.example.com` is a
  // real internet domain, not an embedder-internal URL.
  expect(isInternalUrl('https://localhost.example.com/')).toBe(false);
  expect(isInternalUrl('http://my-localhost.org/')).toBe(false);
});

it('isInternalUrl does NOT match unrelated schemes', () => {
  expect(isInternalUrl('about:blank')).toBe(false);
  expect(isInternalUrl('javascript:void(0)')).toBe(false);
  expect(isInternalUrl('mailto:user@example.com')).toBe(false);
});

it('isInternalUrl tolerates malformed URLs (returns false)', () => {
  // The predicate must NOT throw on malformed inputs — it gracefully
  // returns false so the tab filter falls through to the no-filter path.
  expect(isInternalUrl('not a url')).toBe(false);
  expect(isInternalUrl('')).toBe(false);
});

// ----------------------------------------------------------------------
// parseAllowedTools — used by --allowed-tools
// ----------------------------------------------------------------------

it('parseAllowedTools parses a basic comma-separated list', () => {
  expect(parseAllowedTools('browser_navigate,browser_click')).toEqual({
    browser_navigate: true,
    browser_click: true,
  });
});

it('parseAllowedTools tolerates whitespace around names', () => {
  expect(parseAllowedTools('browser_navigate , browser_click ,browser_snapshot')).toEqual({
    browser_navigate: true,
    browser_click: true,
    browser_snapshot: true,
  });
});

it('parseAllowedTools handles a single tool name', () => {
  expect(parseAllowedTools('browser_navigate')).toEqual({
    browser_navigate: true,
  });
});

it('parseAllowedTools returns undefined for empty input', () => {
  // Empty / undefined means "no filter, advertise all tools" — the
  // consumer in tools.ts treats undefined as a sentinel for the
  // no-filter pass-through.
  expect(parseAllowedTools(undefined)).toBeUndefined();
  expect(parseAllowedTools('')).toBeUndefined();
  expect(parseAllowedTools('   ')).toBeUndefined();
});

it('parseAllowedTools drops empty entries from trailing commas', () => {
  expect(parseAllowedTools('browser_navigate,,browser_click,')).toEqual({
    browser_navigate: true,
    browser_click: true,
  });
});
