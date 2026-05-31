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
 * Sapoto capture bridge behavior tests.
 *
 * These tests exercise the operational init script in a real browser context.
 * The Ally statements flow fetches PDF bytes in page JavaScript, creates a
 * blob: URL, then calls window.open(blobUrl, '_blank'). Without the bridge,
 * that popup is the macOS focus-steal source. With the bridge, the page must
 * emit a background-open marker and return null from window.open instead of
 * creating a foreground popup.
 */

import { browserTest as it, expect } from '../config/browserTest';
import { buildCaptureBridgeInitScript } from '../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

function pdfBuffer(): Buffer {
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
    'xref',
    '0 4',
    '0000000000 65535 f',
    '0000000009 00000 n',
    '0000000056 00000 n',
    '0000000103 00000 n',
    'trailer<</Size 4/Root 1 0 R>>',
    'startxref',
    '165',
    '%%EOF',
  ].join('\n'));
}

it('capture bridge suppresses Ally-style fetch -> blob -> window.open(_blank)', async ({ browser, server, browserName }) => {
  it.skip(browserName !== 'chromium', 'capture bridge is a Chromium/Sapoto MCP concern');

  server.setRoute('/acs/v1/bank-statements/latest', (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename=ally-latest-statement.pdf',
      'content-length': String(pdfBuffer().length),
    });
    res.end(pdfBuffer());
  });

  const context = await browser.newContext();
  await context.addInitScript({
    content: buildCaptureBridgeInitScript({ captureBridge: true }),
  });

  const page = await context.newPage();
  const consoleMessages: string[] = [];
  page.on('console', message => consoleMessages.push(message.text()));

  await page.goto(server.EMPTY_PAGE);
  await page.setContent(`
    <button id="statement">Statement</button>
    <script>
      window.__allyFlow = { openResult: 'pending', blobUrl: null };
      document.getElementById('statement').addEventListener('click', async () => {
        const response = await fetch('/acs/v1/bank-statements/latest', {
          headers: {
            authorization: 'Bearer synthetic-token',
            cif: 'synthetic-cif',
            'content-type': 'application/json'
          }
        });
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const opened = window.open(blobUrl, '_blank');
        window.__allyFlow = {
          openResult: opened === null ? 'null' : 'window',
          blobUrl
        };
      });
    </script>
  `);

  const popupPromise = page.waitForEvent('popup', { timeout: 1000 }).catch(() => null);
  await page.click('#statement');

  await expect.poll(async () => page.evaluate(() => window['__allyFlow'].openResult)).toBe('null');
  const popup = await popupPromise;
  expect(popup).toBe(null);

  const blobUrl = await page.evaluate(() => window['__allyFlow'].blobUrl);
  expect(blobUrl).toContain(`blob:${server.PREFIX}`);
  expect(consoleMessages.some(message => (
    message.startsWith('[FocusShim] health label=installed ') &&
    message.includes('valueIsShim=true')
  ))).toBe(true);
  expect(consoleMessages).toContain(`[FocusShim] suppressing background-open url=${blobUrl} target=_blank reason=broad_document_phase`);
  expect(consoleMessages).toContain(`[FocusShim] background-open ${blobUrl}`);

  await context.close();
});
