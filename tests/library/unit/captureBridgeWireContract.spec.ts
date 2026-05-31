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
 * Sapoto Tracer #1154 (Unit I) — wire-contract regression test.
 *
 * The orchestrator-side ADF code (backgroundOpenBridge.ts) scrapes
 * Runtime.consoleAPICalled for specific marker prefixes and pattern-matches
 * URL fragments. Renaming any of these substrings silently breaks the
 * capture bridge — there is no deeper integration test that would catch
 * the regression (the ADF side compiles independently of this fork), so
 * this test is the pin.
 *
 * If you intentionally rename a marker, also update:
 *   - automatic-document-fetcher/src/main/downloads/backgroundOpenBridge.ts
 *   - automatic-document-fetcher/scripts/prepare-mcp-assets.js (grep target)
 *   - automatic-document-fetcher/src/main/utils/cdpConfig.ts (URL filter)
 */

import { test as it, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  buildCaptureBridgeInitScript,
  BACKGROUND_TARGET_URL_MARKER,
  isBackgroundTargetUrl,
} from '../../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

const WIRE_CONTRACT_SUBSTRINGS = [
  '[FocusShim]',
  '[DeferredPrint]',
  '[Print Capture]',
  '__SAPOTO_PATHD_BRIDGE_V1_STAMP__',
  '__sapoto_bg=V1:',
];

it('IIFE source contains all five wire-contract substrings verbatim', () => {
  const src = buildCaptureBridgeInitScript({ captureBridge: true });
  for (const needle of WIRE_CONTRACT_SUBSTRINGS)
    expect(src).toContain(needle);
});

it('captureBridge=false returns an inert IIFE that omits the markers', () => {
  // Disabled form should NOT carry the markers — otherwise a page could
  // detect us simply by reading our own marker strings from a leaked
  // source dump.
  const src = buildCaptureBridgeInitScript({ captureBridge: false });
  for (const needle of WIRE_CONTRACT_SUBSTRINGS)
    expect(src).not.toContain(needle);
});

it('captureBridge=true with windowOpenCaptureMode=off keeps print bridge markers', () => {
  const src = buildCaptureBridgeInitScript({
    captureBridge: true,
    windowOpenCaptureMode: 'off',
  });
  expect(src).toContain('[DeferredPrint]');
  expect(src).toContain('[Print Capture]');
  expect(src).toContain('const __sapotoInstallWindowOpenBridge = false;');
});

it('MCP command registers windowOpenCaptureMode parser lazily', () => {
  const programSource = fs.readFileSync(path.join(process.cwd(), 'packages/playwright-core/src/tools/mcp/program.ts'), 'utf8');
  expect(programSource).toContain(".option('--window-open-capture-mode <mode>'");
  expect(programSource).toContain("enumParser.bind(null, '--window-open-capture-mode', ['off', 'passive', 'active'])");
  expect(programSource).not.toContain("enumParser<'off' | 'passive' | 'active'>('--window-open-capture-mode'");
});

it('IIFE is a self-invoking function expression', () => {
  const src = buildCaptureBridgeInitScript({ captureBridge: true });
  expect(src.startsWith('(() => {')).toBe(true);
  expect(src.trimEnd().endsWith('})();')).toBe(true);
});

it('background-target URL marker token matches what _onPageCreated scans for', () => {
  expect(BACKGROUND_TARGET_URL_MARKER).toBe('__sapoto_bg=V1:');
});

it('isBackgroundTargetUrl() catches the canonical marker URL', () => {
  expect(isBackgroundTargetUrl('about:blank#__sapoto_bg=V1:1234567890')).toBe(true);
  expect(isBackgroundTargetUrl('https://example.com/x?__sapoto_bg=V1:x')).toBe(true);
});

it('isBackgroundTargetUrl() rejects normal portal URLs', () => {
  expect(isBackgroundTargetUrl('https://example.com/account')).toBe(false);
  expect(isBackgroundTargetUrl('about:blank')).toBe(false);
  expect(isBackgroundTargetUrl('')).toBe(false);
  expect(isBackgroundTargetUrl(null)).toBe(false);
  expect(isBackgroundTargetUrl(undefined)).toBe(false);
});

it('IIFE contains the inline SECURITY LIMITATION marker comment verbatim', () => {
  // The PRD pins this comment block verbatim as a maintenance signal so a
  // future renamer of the marker token can find every callsite by grep.
  const src = buildCaptureBridgeInitScript({ captureBridge: true });
  expect(src).toContain('SECURITY LIMITATION:');
  expect(src).toContain('hostile page');
  expect(src).toContain('HMAC');
});
