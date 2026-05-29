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

import { contextTest as it, expect } from '../config/browserTest';
import { buildOverlayScript } from '../../packages/playwright-core/src/tools/backend/agentSessionOverlay';

const OVERLAY_SCRIPT = buildOverlayScript({ statusText: 'MCP' });
const HOST_SELECTOR = 'sapoto-mcp-agent-session-overlay';

it('agent-session overlay installs one aria-hidden host and hides in print media', async ({ context, server }) => {
  await context.addInitScript({ content: OVERLAY_SCRIPT });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  expect(await page.locator(HOST_SELECTOR).evaluate(host => ({
    ariaHidden: host.getAttribute('aria-hidden'),
    pointerEvents: getComputedStyle(host).pointerEvents,
    zIndex: getComputedStyle(host).zIndex,
    shadowRootIsClosed: !(host as HTMLElement).shadowRoot,
  }))).toEqual({
    ariaHidden: 'true',
    pointerEvents: 'none',
    zIndex: '2147483647',
    shadowRootIsClosed: true,
  });

  await page.emulateMedia({ media: 'print' });
  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).display)).toBe('none');
});

it('agent-session overlay skips background marker targets', async ({ context }) => {
  await context.addInitScript({ content: OVERLAY_SCRIPT });
  const page = await context.newPage();
  await page.goto('data:text/html,<body>background</body>#__sapoto_bg=V1:test');

  expect(await page.locator(HOST_SELECTOR).count()).toBe(0);
});

it('agent-session overlay stop affordance fires while host pointer-events stays none', async ({ context, server }) => {
  await context.addInitScript({ content: OVERLAY_SCRIPT });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  await page.evaluate(() => {
    (window as any).__stopCallbackCount = 0;
    (window as any).__stopEventCount = 0;
    (window as any).__sapotoStopRequested = () => (window as any).__stopCallbackCount++;
    window.addEventListener('__sapotoMcpStopRequested', () => (window as any).__stopEventCount++);
  });

  const hostState = await page.locator(HOST_SELECTOR).evaluate(host => ({
    pointerEvents: getComputedStyle(host).pointerEvents,
    display: getComputedStyle(host).display,
  }));
  expect(hostState).toEqual({
    pointerEvents: 'none',
    display: 'block',
  });

  const stopButtonPoint = await page.evaluate(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight - 27,
  }));
  await page.mouse.click(stopButtonPoint.x, stopButtonPoint.y);
  await page.mouse.click(stopButtonPoint.x, stopButtonPoint.y);

  expect(await page.evaluate(() => ({
    callbackCount: (window as any).__stopCallbackCount,
    eventCount: (window as any).__stopEventCount,
  }))).toEqual({
    callbackCount: 2,
    eventCount: 2,
  });
  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).pointerEvents)).toBe('none');
});
