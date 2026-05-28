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
 * Sapoto Tracer #1154 (Unit I) — pure-logic tests for the capture-bridge
 * URL / target regexes. No Chromium / CDP required.
 *
 * The regexes are duplicated inside the IIFE source (page-local literals)
 * because the IIFE has no module system at runtime; the exported copies
 * here are the source of truth that we test, and the wire-contract test
 * pins the duplicated copies in the IIFE source.
 */

import { test as it, expect } from '@playwright/test';
import {
  DOWNLOAD_URL_RE,
  DOWNLOAD_PATH_RE,
  SELF_TARGET_RE,
} from '../../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

// ----------------------------------------------------------------------
// DOWNLOAD_URL_RE
// ----------------------------------------------------------------------

it('DOWNLOAD_URL_RE matches blob: PDF URLs', () => {
  expect(DOWNLOAD_URL_RE.test('blob:https://example.com/abcd-1234.pdf')).toBe(true);
});

it('DOWNLOAD_URL_RE matches data: PDF URLs', () => {
  expect(DOWNLOAD_URL_RE.test('data:application/pdf;base64,JVBERi0xLjQK.pdf')).toBe(true);
});

it('DOWNLOAD_URL_RE matches file:// PDF URLs', () => {
  expect(DOWNLOAD_URL_RE.test('file:///tmp/statement.pdf')).toBe(true);
});

it('DOWNLOAD_URL_RE matches PDFs with query strings', () => {
  expect(DOWNLOAD_URL_RE.test('https://example.com/x.pdf?token=abc')).toBe(true);
});

it('DOWNLOAD_URL_RE matches PDFs with fragments', () => {
  expect(DOWNLOAD_URL_RE.test('https://example.com/x.pdf#page=2')).toBe(true);
});

it('DOWNLOAD_URL_RE matches XLSX / CSV / DOCX / ZIP / OFX', () => {
  expect(DOWNLOAD_URL_RE.test('https://example.com/transactions.xlsx')).toBe(true);
  expect(DOWNLOAD_URL_RE.test('https://example.com/transactions.csv')).toBe(true);
  expect(DOWNLOAD_URL_RE.test('https://example.com/letter.docx')).toBe(true);
  expect(DOWNLOAD_URL_RE.test('https://example.com/archive.zip')).toBe(true);
  expect(DOWNLOAD_URL_RE.test('https://example.com/transactions.ofx')).toBe(true);
});

it('DOWNLOAD_URL_RE rejects bare HTTPS pages without download extensions', () => {
  expect(DOWNLOAD_URL_RE.test('https://example.com/')).toBe(false);
  expect(DOWNLOAD_URL_RE.test('https://example.com/account')).toBe(false);
  expect(DOWNLOAD_URL_RE.test('https://example.com/pdfviewer')).toBe(false);
});

it('DOWNLOAD_URL_RE is case-insensitive', () => {
  expect(DOWNLOAD_URL_RE.test('https://example.com/STATEMENT.PDF')).toBe(true);
  expect(DOWNLOAD_URL_RE.test('https://example.com/data.CSV')).toBe(true);
});

// ----------------------------------------------------------------------
// DOWNLOAD_PATH_RE
// ----------------------------------------------------------------------

it('DOWNLOAD_PATH_RE matches /download/ paths', () => {
  expect(DOWNLOAD_PATH_RE.test('/download/12345')).toBe(true);
  expect(DOWNLOAD_PATH_RE.test('/api/inline/download/12345')).toBe(true);
});

it('DOWNLOAD_PATH_RE matches /statement/ paths', () => {
  expect(DOWNLOAD_PATH_RE.test('/statements/2024/05')).toBe(true);
  expect(DOWNLOAD_PATH_RE.test('/api/statement/123')).toBe(true);
});

it('DOWNLOAD_PATH_RE matches /invoice/ paths', () => {
  expect(DOWNLOAD_PATH_RE.test('/invoices/abc')).toBe(true);
  expect(DOWNLOAD_PATH_RE.test('/api/invoice/123')).toBe(true);
});

it('DOWNLOAD_PATH_RE matches /receipt/ paths', () => {
  expect(DOWNLOAD_PATH_RE.test('/receipts/2024')).toBe(true);
});

it('DOWNLOAD_PATH_RE matches PDFStatement / getStmt variants', () => {
  expect(DOWNLOAD_PATH_RE.test('/PDFStatement.aspx')).toBe(true);
  expect(DOWNLOAD_PATH_RE.test('/StatementPDF/123')).toBe(true);
  expect(DOWNLOAD_PATH_RE.test('/getStmt')).toBe(true);
});

it('DOWNLOAD_PATH_RE rejects non-download HTML paths', () => {
  expect(DOWNLOAD_PATH_RE.test('/index.html')).toBe(false);
  expect(DOWNLOAD_PATH_RE.test('/account/overview')).toBe(false);
  // Substring inside a longer segment shouldn't match — the segment
  // boundary check (the leading slash) protects against false positives.
  expect(DOWNLOAD_PATH_RE.test('/some-receipts-page')).toBe(false);
});

it('DOWNLOAD_PATH_RE is case-insensitive', () => {
  expect(DOWNLOAD_PATH_RE.test('/DOWNLOAD/123')).toBe(true);
  expect(DOWNLOAD_PATH_RE.test('/Statement/x')).toBe(true);
});

// ----------------------------------------------------------------------
// SELF_TARGET_RE — matches the four self-navigating cases that should
// NEVER be re-routed through the background-open marker (they don't
// pop a popup anyway, so there's no focus-steal to suppress).
// ----------------------------------------------------------------------

it('SELF_TARGET_RE matches _self / _parent / _top', () => {
  expect(SELF_TARGET_RE.test('_self')).toBe(true);
  expect(SELF_TARGET_RE.test('_parent')).toBe(true);
  expect(SELF_TARGET_RE.test('_top')).toBe(true);
});

it('SELF_TARGET_RE matches the empty string', () => {
  expect(SELF_TARGET_RE.test('')).toBe(true);
});

it('SELF_TARGET_RE matches the string "undefined"', () => {
  // window.open(url, undefined) coerces to the string "undefined"
  // depending on how the shim normalises args. Belt-and-braces.
  expect(SELF_TARGET_RE.test('undefined')).toBe(true);
});

it('SELF_TARGET_RE rejects _blank', () => {
  expect(SELF_TARGET_RE.test('_blank')).toBe(false);
});

it('SELF_TARGET_RE rejects named targets', () => {
  expect(SELF_TARGET_RE.test('helpWindow')).toBe(false);
  expect(SELF_TARGET_RE.test('popup1')).toBe(false);
  expect(SELF_TARGET_RE.test('OAuth')).toBe(false);
});

it('SELF_TARGET_RE rejects substrings of self-targets', () => {
  // Make sure the anchors are tight — `_selfish` should NOT match.
  expect(SELF_TARGET_RE.test('_selfish')).toBe(false);
  expect(SELF_TARGET_RE.test('xx_self')).toBe(false);
});

it('SELF_TARGET_RE is case-insensitive', () => {
  expect(SELF_TARGET_RE.test('_SELF')).toBe(true);
  expect(SELF_TARGET_RE.test('_Top')).toBe(true);
});
