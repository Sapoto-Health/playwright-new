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

import jpegjs from 'jpeg-js';
import { PNG } from 'pngjs';
import * as z from 'zod';
import { formatObject } from '@isomorphic/stringUtils';

import { scaleImageToSize } from '@isomorphic/imageUtils';
import { defineTabTool } from './tool';
import { optionalElementSchema } from './snapshot';

import type * as playwright from '../../..';

const screenshotSchema = optionalElementSchema.extend({
  type: z.enum(['png', 'jpeg']).default('png').describe('Image format for the screenshot. Default is png.'),
  filename: z.string().optional().describe('File name to save the screenshot to. Defaults to `page-{timestamp}.{png|jpeg}` if not specified. Prefer relative file names to stay within the output directory.'),
  fullPage: z.boolean().optional().describe('When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.'),
});

const screenshot = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_take_screenshot',
    title: 'Take a screenshot',
    description: `Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.`,
    inputSchema: screenshotSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (params.fullPage && params.target)
      throw new Error('fullPage cannot be used with element screenshots.');

    const fileType = params.type || 'png';
    const options: playwright.PageScreenshotOptions = {
      type: fileType,
      quality: fileType === 'png' ? undefined : 90,
      scale: 'css',
      ...tab.actionTimeoutOptions,
      ...(params.fullPage !== undefined && { fullPage: params.fullPage })
    };

    const screenshotTargetLabel = params.target ? params.element || 'element' : (params.fullPage ? 'full page' : 'viewport');
    const target = params.target ? await tab.targetLocator({ element: params.element, target: params.target }) : null;
    const data = target ? await target.locator.screenshot(options) : await tab.page.screenshot(options);

    const resolvedFile = await response.resolveClientFile({ prefix: target ? 'element' : 'page', ext: fileType, suggestedFilename: params.filename }, `Screenshot of ${screenshotTargetLabel}`);

    response.addCode(`// Screenshot ${screenshotTargetLabel} and save it as ${resolvedFile.relativeName}`);
    if (target)
      response.addCode(`await page.${target.resolved}.screenshot(${formatObject({ ...options, path: resolvedFile.relativeName })});`);
    else
      response.addCode(`await page.screenshot(${formatObject({ ...options, path: resolvedFile.relativeName })});`);

    await response.addFileResult(resolvedFile, data);
    if (!params.filename)
      await response.registerImageResult(data, fileType);
  }
});

export function scaleImageToFitMessage(buffer: Buffer, imageType: 'png' | 'jpeg'): Buffer {
  // https://docs.claude.com/en/docs/build-with-claude/vision#evaluate-image-size
  // Not more than 1.15 megapixel, linear size not more than 1568.

  const image = imageType === 'png' ? PNG.sync.read(buffer) : jpegjs.decode(buffer, { maxMemoryUsageInMB: 512 });
  const pixels = image.width * image.height;

  const shrink = Math.min(1568 / image.width, 1568 / image.height, Math.sqrt(1.15 * 1024 * 1024 / pixels));
  if (shrink > 1)
    return buffer;

  const width = image.width * shrink | 0;
  const height = image.height * shrink | 0;
  const scaledImage = scaleImageToSize(image, { width, height });
  // eslint-disable-next-line no-restricted-syntax
  return imageType === 'png' ? PNG.sync.write(scaledImage as any) : jpegjs.encode(scaledImage, 80).data;
}

// Sapoto Tracer #1156 (Unit K) — browser_take_ocr_friendly_screenshot.
//
// Produces a high-DPR PNG suitable for ADF's Tesseract OCR pipeline. Three
// differences from `browser_take_screenshot`:
//
//   1. scale: 'device' — Tesseract needs the high-DPR pixels. The default
//      browser_take_screenshot uses 'css' which downscales on Retina.
//
//   2. Tiling — tall pages are split into vertical tiles of `tileHeight`
//      device pixels (default 4000). A single 10000px page screenshot can
//      hit the MCP per-attachment byte limit; tiling lets the agent OCR a
//      long bank statement without truncation.
//
//   3. hideFixed — before screenshotting we walk all elements and flip
//      computed `position: fixed | sticky` to `position: static`,
//      remembering the original positions. After the screenshot completes
//      (or fails) we restore the originals in a `finally`. Fixed
//      headers/footers would otherwise repeat in every tile and confuse
//      OCR.

const OCR_DEFAULT_TILE_HEIGHT = 4000;

const ocrScreenshotSchema = z.object({
  filename: z.string().optional().describe('File name to save the screenshot to. Defaults to `page-ocr-{timestamp}.png` if not specified. Tiled screenshots append `-tile-N` to the base name.'),
  tileHeight: z.number().int().positive().optional().describe(`Maximum tile height in device pixels. Pages taller than this are split into vertical tiles. Default ${OCR_DEFAULT_TILE_HEIGHT}.`),
  hideFixed: z.boolean().optional().describe('When true (default), elements with `position: fixed | sticky` are flipped to `position: static` for the duration of the screenshot. Restores afterwards. Prevents repeating headers/footers across tiles.'),
});

type FixedElementSnapshot = {
  index: number;
  prevPosition: string;
  prevPriority: string;
};

async function hideFixedElements(page: playwright.Page): Promise<FixedElementSnapshot[]> {
  // Inline a marker attribute on each affected element so we can find them
  // back deterministically even if the DOM is reflowed by the position
  // change. The marker is removed during restore.
  return page.evaluate(() => {
    const marker = '__sapoto_ocr_hide_fixed__';
    const snapshots: { index: number; prevPosition: string; prevPriority: string }[] = [];
    const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
    let idx = 0;
    for (const el of all) {
      const cs = window.getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'sticky') {
        const prevPosition = el.style.getPropertyValue('position');
        const prevPriority = el.style.getPropertyPriority('position');
        el.setAttribute(marker, String(idx));
        snapshots.push({ index: idx, prevPosition, prevPriority });
        el.style.setProperty('position', 'static', 'important');
        idx += 1;
      }
    }
    return snapshots;
  });
}

async function restoreFixedElements(page: playwright.Page, snapshots: FixedElementSnapshot[]): Promise<void> {
  if (!snapshots.length)
    return;
  try {
    await page.evaluate(snaps => {
      const marker = '__sapoto_ocr_hide_fixed__';
      for (const snap of snaps) {
        const el = document.querySelector(`[${marker}="${snap.index}"]`) as HTMLElement | null;
        if (!el)
          continue;
        if (snap.prevPosition)
          el.style.setProperty('position', snap.prevPosition, snap.prevPriority || '');
        else
          el.style.removeProperty('position');
        el.removeAttribute(marker);
      }
    }, snapshots);
  } catch {
    // Page may have navigated/crashed during the screenshot. The marker
    // attribute remains but is otherwise inert; nothing else relies on it.
  }
}

async function getDevicePixelDimensions(page: playwright.Page): Promise<{ widthPx: number; heightPx: number; dpr: number }> {
  return page.evaluate(() => {
    const dpr = window.devicePixelRatio || 1;
    const doc = document.documentElement;
    const widthCss = Math.max(doc.scrollWidth, doc.clientWidth, document.body?.scrollWidth ?? 0);
    const heightCss = Math.max(doc.scrollHeight, doc.clientHeight, document.body?.scrollHeight ?? 0);
    return {
      widthPx: Math.ceil(widthCss * dpr),
      heightPx: Math.ceil(heightCss * dpr),
      dpr,
    };
  });
}

const ocrScreenshot = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_take_ocr_friendly_screenshot',
    title: 'Take an OCR-friendly screenshot',
    description: 'Take a high-DPR (scale: device) PNG screenshot suitable for OCR. Tall pages are split into vertical tiles of `tileHeight` device pixels. Fixed/sticky elements are temporarily flipped to static so headers/footers do not repeat across tiles.',
    inputSchema: ocrScreenshotSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const tileHeight = params.tileHeight ?? OCR_DEFAULT_TILE_HEIGHT;
    const hideFixed = params.hideFixed !== false;

    let fixedSnapshots: FixedElementSnapshot[] = [];
    try {
      if (hideFixed)
        fixedSnapshots = await hideFixedElements(tab.page);

      const { heightPx, widthPx, dpr } = await getDevicePixelDimensions(tab.page);

      const tiles: { y: number; height: number }[] = [];
      if (heightPx <= tileHeight) {
        tiles.push({ y: 0, height: heightPx });
      } else {
        for (let y = 0; y < heightPx; y += tileHeight) {
          const remaining = heightPx - y;
          const h = Math.min(tileHeight, remaining);
          tiles.push({ y, height: h });
        }
      }

      response.addCode(`// OCR-friendly screenshot: dpr=${dpr}, ${tiles.length} tile(s) of up to ${tileHeight}px each`);

      // CSS-pixel conversion for the clip rectangle. Playwright's clip
      // option is in CSS pixels regardless of scale; scale: 'device' then
      // captures at the device pixel ratio.
      const cssWidth = Math.ceil(widthPx / dpr);

      for (let i = 0; i < tiles.length; i += 1) {
        const tile = tiles[i];
        const cssY = Math.floor(tile.y / dpr);
        const cssH = Math.ceil(tile.height / dpr);
        const options: playwright.PageScreenshotOptions = {
          type: 'png',
          scale: 'device',
          fullPage: tiles.length === 1 ? true : false,
          ...tab.actionTimeoutOptions,
          ...(tiles.length > 1 ? {
            fullPage: true,
            clip: { x: 0, y: cssY, width: cssWidth, height: cssH },
          } : {}),
        };

        const data = await tab.page.screenshot(options);

        const baseName = params.filename ?? undefined;
        const suggestedFilename = baseName && tiles.length > 1
          ? baseName.replace(/(\.[a-z]+)?$/i, m => `-tile-${i + 1}${m || '.png'}`)
          : baseName;

        const resolvedFile = await response.resolveClientFile(
            { prefix: 'page-ocr', ext: 'png', suggestedFilename },
            `OCR screenshot tile ${i + 1}/${tiles.length}`,
        );
        await response.addFileResult(resolvedFile, data);
        await response.registerImageResult(data, 'png');
        response.addCode(`await page.screenshot(${formatObject({ ...options, path: resolvedFile.relativeName })});`);
      }
    } finally {
      if (hideFixed)
        await restoreFixedElements(tab.page, fixedSnapshots);
    }
  },
});

export default [
  screenshot,
  ocrScreenshot,
];
