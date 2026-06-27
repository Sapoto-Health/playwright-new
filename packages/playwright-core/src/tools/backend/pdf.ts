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

import * as z from 'zod';
import { formatObject } from '@isomorphic/stringUtils';

import { defineTabTool } from './tool';

const pdfSchema = z.object({
  filename: z.string().optional().describe('File name to save the pdf to. Defaults to `page-{timestamp}.pdf` if not specified. Prefer relative file names to stay within the output directory.'),
});

const pdf = defineTabTool({
  capability: 'pdf',

  schema: {
    name: 'browser_pdf_save',
    title: 'Save as PDF',
    description: 'Save page as PDF',
    inputSchema: pdfSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    let data: Buffer | undefined;
    await tab.hideAgentSessionOverlayForCapture();
    try {
      data = await tab.page.pdf();
    } finally {
      await tab.showAgentSessionOverlayAfterCapture();
    }
    if (!data)
      throw new Error('PDF generation failed.');
    const result = await response.resolveClientFile({ prefix: 'page', ext: 'pdf', suggestedFilename: params.filename }, 'Page as pdf');
    await response.addFileResult(result, data);
    response.addCode(`await page.pdf(${formatObject({ path: result.relativeName })});`);
  },
});

// Sapoto Tracer #1156 (Unit K) — browser_trigger_print.
//
// Calls `window.print()` on the current page. The Unit I capture-bridge init
// script wraps the global `window.print` to route through the embedder's
// `electronAPI.requestPrintCapture` bridge (or up the parent frame chain).
// If the bridge is not installed on the current page, fail fast rather than
// opening Chromium's native print preview.
//
// Focused affordance: agents need exactly one knob ("trigger print") for
// portals that only expose statement downloads behind the browser's Print
// menu (Chase inline-PDF viewer, Citi statement preview, Fidelity report
// iframe). The dedicated tool keeps the agent from conflating "trigger
// print" with arbitrary script evaluation.
const triggerPrint = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_trigger_print',
    title: 'Trigger window.print()',
    description: 'Triggers `window.print()` on the current page. Used to invoke the print bridge installed by `--capture-bridge` when no download affordance exists on the portal.',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (tab, _params, response) => {
    const result = await tab.page.evaluate(() => {
      const source = Function.prototype.toString.call(window.print);
      if (!source.includes('_emitPrintMarker') || !source.includes('_c3Deferred'))
        return { ok: false };
      window.print();
      return { ok: true };
    });
    if (!result.ok)
      throw new Error('Sapoto capture bridge is not installed on the current page; refusing to open native print.');
    response.addCode(`await page.evaluate(() => window.print());`);
    response.addTextResult('window.print() triggered on current page.');
  },
});

export default [
  pdf,
  triggerPrint,
];
