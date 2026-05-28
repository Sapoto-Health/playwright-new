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
 * Sapoto Tracer #1153 (Unit G-stealth) — pure-logic tests for the
 * `--cdp-stealth=<comma-list>` CLI parser. No Chromium / CDP required; these
 * exercise the parser in isolation. The channel-propagation tests live
 * alongside in `tests/library/cdp-stealth-options.spec.ts`.
 */

import { test as it, expect } from '@playwright/test';
import {
  CDP_STEALTH_CLI_FEATURES,
  parseCdpStealthCli,
} from '../../../packages/isomorphic/cdpStealthCli';

// ----------------------------------------------------------------------
// Basic accepted shapes
// ----------------------------------------------------------------------

it('parseCdpStealthCli("") returns []', () => {
  expect(parseCdpStealthCli('')).toEqual([]);
});

it('parseCdpStealthCli("runtime-cycle") returns ["runtime-cycle"]', () => {
  expect(parseCdpStealthCli('runtime-cycle')).toEqual(['runtime-cycle']);
});

it('parseCdpStealthCli accepts a comma-list of two features', () => {
  expect(parseCdpStealthCli('runtime-cycle,log-skip')).toEqual(['runtime-cycle', 'log-skip']);
});

it('parseCdpStealthCli accepts the full feature triple via individual names', () => {
  expect(parseCdpStealthCli('runtime-cycle,log-skip,worker-runtime')).toEqual([
    'runtime-cycle', 'log-skip', 'worker-runtime',
  ]);
});

it('parseCdpStealthCli("all") expands to the full feature bundle', () => {
  expect(parseCdpStealthCli('all')).toEqual([...CDP_STEALTH_CLI_FEATURES]);
  // The "all" sentinel must include every feature the server-side
  // post-validator accepts; if it ever drifts, this test fails loudly.
  expect(parseCdpStealthCli('all')).toContain('runtime-cycle');
  expect(parseCdpStealthCli('all')).toContain('log-skip');
  expect(parseCdpStealthCli('all')).toContain('worker-runtime');
});

// ----------------------------------------------------------------------
// Whitespace handling
// ----------------------------------------------------------------------

it('parseCdpStealthCli trims whitespace around each entry', () => {
  expect(parseCdpStealthCli(' runtime-cycle , log-skip ')).toEqual(['runtime-cycle', 'log-skip']);
  expect(parseCdpStealthCli('runtime-cycle  ,  worker-runtime')).toEqual(['runtime-cycle', 'worker-runtime']);
});

it('parseCdpStealthCli drops empty entries from a comma list', () => {
  // Two commas back-to-back produce an empty token after trim. Filtering it
  // out lets a config-file author with a trailing comma succeed instead of
  // failing on a confusing "Invalid --cdp-stealth value: ''" error.
  expect(parseCdpStealthCli('runtime-cycle,,log-skip')).toEqual(['runtime-cycle', 'log-skip']);
  expect(parseCdpStealthCli(',,,')).toEqual([]);
});

// ----------------------------------------------------------------------
// Rejection paths
// ----------------------------------------------------------------------

it('parseCdpStealthCli rejects "network-skip" with a LOUD, descriptive error', () => {
  // Mirrors the server-side parseCdpStealthFeatures rejection. The Codex P1
  // lesson from the previous-generation fork was that `network-skip` broke
  // page.on('request') listeners and silently regressed every fetch
  // interception path — we reject the wire value AT THE CLI so a stale
  // invocation script fails loudly before reaching the server.
  expect(() => parseCdpStealthCli('network-skip')).toThrow(/network-skip/);
  expect(() => parseCdpStealthCli('network-skip')).toThrow(/rejected by design/);
  expect(() => parseCdpStealthCli('network-skip')).toThrow(/page\.on\('request'\)|fetch interception/);
  // Mixed input still rejects on the bad value.
  expect(() => parseCdpStealthCli('runtime-cycle,network-skip')).toThrow(/network-skip/);
});

it('parseCdpStealthCli rejects unknown values with a descriptive error', () => {
  expect(() => parseCdpStealthCli('totally-bogus')).toThrow(/Invalid --cdp-stealth value/);
  expect(() => parseCdpStealthCli('totally-bogus')).toThrow(/runtime-cycle/);
  expect(() => parseCdpStealthCli('totally-bogus')).toThrow(/log-skip/);
  expect(() => parseCdpStealthCli('totally-bogus')).toThrow(/worker-runtime/);
});

it('parseCdpStealthCli rejects an unknown value embedded in a comma list', () => {
  expect(() => parseCdpStealthCli('runtime-cycle,bogus,log-skip')).toThrow(/bogus/);
});
