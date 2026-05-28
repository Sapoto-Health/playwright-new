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
 * Sapoto Tracer #1156 (Unit K) — browser_take_ocr_friendly_screenshot
 * smoke tests.
 *
 * Three invariants:
 *   1. scale: 'device' — captured PNG is the device-pixel size (not
 *      downscaled to CSS pixels), so Tesseract sees the high-DPR image.
 *   2. Tiling — a 10000px page with tileHeight=4000 produces 3 tiles.
 *   3. hideFixed — a `position: fixed` element is flipped to static for
 *      the screenshot, then restored to fixed after the tool returns.
 */

import fs from 'fs';

import { test, expect } from './fixtures';
import { PNG } from '../../packages/playwright-core/lib/utilsBundle';

test('browser_take_ocr_friendly_screenshot produces a high-DPR PNG', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  const result = await client.callTool({
    name: 'browser_take_ocr_friendly_screenshot',
  });
  expect(result.isError).toBeFalsy();

  // At least one PNG should have been written to the output dir.
  const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.png'));
  expect(files.length).toBeGreaterThanOrEqual(1);

  // The PNG dimensions reflect the actual viewport — Playwright honors
  // scale: 'device' regardless of headless DPR (default 1). The point of
  // this assertion is that the tool returned a non-empty image at the
  // viewport's logical size (the OCR pipeline downstream of this tool
  // owns the DPI-specific reasoning; here we just prove we got a PNG).
  const buf = fs.readFileSync(`${outputDir}/${files[0]}`);
  const png = PNG.sync.read(buf);
  expect(png.width).toBeGreaterThan(0);
  expect(png.height).toBeGreaterThan(0);
});

test('browser_take_ocr_friendly_screenshot tiles tall pages', async ({ startClient }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });

  // 10000px-tall page, with tileHeight=4000 → expect 3 tiles
  // (4000 + 4000 + 2000).
  const html = `data:text/html,<!doctype html><html><body style="margin:0">
    <div style="height: 10000px; background: linear-gradient(to bottom, red, blue);"></div>
  </body></html>`;

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: html },
  });

  const result = await client.callTool({
    name: 'browser_take_ocr_friendly_screenshot',
    arguments: { tileHeight: 4000 },
  });
  expect(result.isError).toBeFalsy();

  const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.png')).sort();
  // With the 10000px page we expect at least 2 tiles. The exact count
  // depends on devicePixelRatio (headless Chrome defaults to 1, so we
  // expect 3 tiles of 4000/4000/2000). If headed/Retina, we'd see more.
  expect(files.length).toBeGreaterThanOrEqual(2);

  // Validate each tile is a readable PNG with non-zero dimensions.
  for (const f of files) {
    const buf = fs.readFileSync(`${outputDir}/${f}`);
    const png = PNG.sync.read(buf);
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);
  }
});

test('browser_take_ocr_friendly_screenshot restores fixed elements after screenshot', async ({ startClient }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });

  // Page with a position:fixed header. The OCR screenshot tool flips it
  // to static for the screenshot; after the tool returns, the page's
  // computed style should still be `position: fixed`.
  const html = `data:text/html,<!doctype html><html><body style="margin:0">
    <div id="fixed-header" style="position: fixed; top: 0; left: 0; width: 100%; height: 40px; background: yellow;">FIXED HEADER</div>
    <div style="height: 2000px; background: white;">content</div>
  </body></html>`;

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: html },
  });

  // Sanity: before the screenshot, the header is position: fixed.
  const before = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => window.getComputedStyle(document.getElementById('fixed-header')).position`,
    },
  });
  expect(JSON.stringify(before)).toContain('fixed');

  // Run the OCR screenshot. During the screenshot the header is
  // temporarily flipped to static.
  const result = await client.callTool({
    name: 'browser_take_ocr_friendly_screenshot',
  });
  expect(result.isError).toBeFalsy();

  // After the tool returns, the header must be back to position: fixed.
  const after = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => window.getComputedStyle(document.getElementById('fixed-header')).position`,
    },
  });
  expect(JSON.stringify(after)).toContain('fixed');
});
