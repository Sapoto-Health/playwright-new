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
 * Sapoto Tracer #1154 (Unit I) — pure-logic tests for the frame-selector
 * escape helpers. No Chromium / CDP required.
 *
 * These helpers mirror the orchestrator-side regex (FRAME_SELECTOR_RE in
 * printCaptureHandler.ts). The orchestrator rejects anything outside the
 * allowlist, so the helpers' job is to return the empty string for
 * unsafe input (forcing the bridge walk to drop the frameSelector and
 * fall back to iframe[srcdoc]) rather than to escape-and-include — that
 * would just produce orchestrator-side validation failures with a
 * confusing error trail.
 */

import { test as it, expect } from '@playwright/test';
import {
  safeId,
  safeDataValue,
} from '../../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

// ----------------------------------------------------------------------
// safeId — passes a string through iff it can interpolate into `iframe#…`.
// ----------------------------------------------------------------------

it('safeId() accepts plain alphanumeric ids', () => {
  expect(safeId('foo')).toBe('foo');
  expect(safeId('foo123')).toBe('foo123');
});

it('safeId() accepts ids with hyphens and underscores', () => {
  expect(safeId('foo-bar')).toBe('foo-bar');
  expect(safeId('foo_bar')).toBe('foo_bar');
  expect(safeId('foo-bar_baz-123')).toBe('foo-bar_baz-123');
});

it('safeId() rejects ids with brackets (quote-injection vector)', () => {
  expect(safeId('foo[bar]')).toBe('');
  expect(safeId('foo]bar')).toBe('');
});

it('safeId() rejects ids with quote characters', () => {
  expect(safeId('foo"; window.x=1;//')).toBe('');
  expect(safeId('a"b')).toBe('');
  expect(safeId("a'b")).toBe('');
});

it('safeId() rejects ids that start with a digit', () => {
  // Stock CSS rejects id selectors that start with a digit unless escaped.
  // The orchestrator-side regex disallows leading digits, so we treat them
  // as unsafe rather than emitting a CSS.escape() form that the
  // orchestrator would reject anyway.
  expect(safeId('1foo')).toBe('');
  expect(safeId('123')).toBe('');
});

it('safeId() rejects empty / null / undefined / non-string input', () => {
  expect(safeId('')).toBe('');
  expect(safeId(undefined as unknown as string)).toBe('');
  expect(safeId(null as unknown as string)).toBe('');
  expect(safeId(123 as unknown as string)).toBe('');
});

it('safeId() rejects whitespace', () => {
  expect(safeId('foo bar')).toBe('');
  expect(safeId(' foo')).toBe('');
  expect(safeId('foo ')).toBe('');
  expect(safeId('\tfoo')).toBe('');
});

it('safeId() rejects null bytes and control chars', () => {
  expect(safeId('foo\0bar')).toBe('');
  expect(safeId('foo\nbar')).toBe('');
});

it('safeId() rejects non-ASCII unicode (deliberately ASCII-only by design)', () => {
  expect(safeId('café')).toBe('');
  expect(safeId('日本語')).toBe('');
  expect(safeId('foo​')).toBe('');
});

it('safeId() preserves long-but-safe identifiers', () => {
  const long = 'a'.repeat(256);
  expect(safeId(long)).toBe(long);
});

// ----------------------------------------------------------------------
// safeDataValue — passes a string through iff it can interpolate into
// `[data-print-id="…"]`. Wider character class than safeId because data
// attributes legitimately contain `:` and `.` (e.g. namespaced ids).
// ----------------------------------------------------------------------

it('safeDataValue() accepts alphanumeric + dot + colon + dash + underscore', () => {
  expect(safeDataValue('foo')).toBe('foo');
  expect(safeDataValue('foo.bar')).toBe('foo.bar');
  expect(safeDataValue('ns:foo-bar.123_baz')).toBe('ns:foo-bar.123_baz');
});

it('safeDataValue() accepts leading digits', () => {
  // Data attributes legitimately start with digits (unlike ids).
  expect(safeDataValue('1foo')).toBe('1foo');
  expect(safeDataValue('123-456')).toBe('123-456');
});

it('safeDataValue() rejects quote injection', () => {
  expect(safeDataValue('"; window.x=1;//')).toBe('');
  expect(safeDataValue('a"b')).toBe('');
  expect(safeDataValue("a'b")).toBe('');
});

it('safeDataValue() rejects spaces / tabs / newlines', () => {
  expect(safeDataValue('foo bar')).toBe('');
  expect(safeDataValue('foo\tbar')).toBe('');
  expect(safeDataValue('foo\nbar')).toBe('');
});

it('safeDataValue() rejects backslashes and brackets', () => {
  expect(safeDataValue('foo\\bar')).toBe('');
  expect(safeDataValue('foo[bar]')).toBe('');
  expect(safeDataValue('foo{bar}')).toBe('');
});

it('safeDataValue() rejects null bytes', () => {
  expect(safeDataValue('foo\0bar')).toBe('');
});

it('safeDataValue() rejects empty / null / undefined / non-string input', () => {
  expect(safeDataValue('')).toBe('');
  expect(safeDataValue(undefined as unknown as string)).toBe('');
  expect(safeDataValue(null as unknown as string)).toBe('');
  expect(safeDataValue(42 as unknown as string)).toBe('');
});

it('safeDataValue() rejects non-ASCII unicode', () => {
  expect(safeDataValue('café')).toBe('');
  expect(safeDataValue('日本')).toBe('');
});
