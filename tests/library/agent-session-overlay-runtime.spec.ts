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
import { AGENT_SESSION_OVERLAY_GLOBAL, buildOverlayScript, createAgentSessionOverlayScript } from '../../packages/playwright-core/src/tools/backend/agentSessionOverlay';

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

it('agent-session overlay installs on visible urls containing the background marker text', async ({ context }) => {
  await context.addInitScript({ content: OVERLAY_SCRIPT });
  const page = await context.newPage();
  await page.goto('data:text/html,<body>background</body>#__sapoto_bg=V1:test');

  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
});

it('agent-session overlay rejects hostile page control attempts', async ({ context, server }) => {
  await context.addInitScript({ content: OVERLAY_SCRIPT });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  const result = await page.evaluate(globalName => {
    const helper = (window as any)[globalName];
    const descriptorBefore = Object.getOwnPropertyDescriptor(window, globalName);
    const hideResult = helper.hide();
    const removeResult = helper.remove();
    const consumeResult = helper.consumeStopRequested();
    let redefineError = false;
    try {
      Object.defineProperty(window, globalName, { value: { removed: true } });
    } catch (_) {
      redefineError = true;
    }
    try {
      (window as any)[globalName] = { removed: true };
    } catch (_) {
    }
    return {
      configurable: descriptorBefore?.configurable,
      enumerable: descriptorBefore?.enumerable,
      writable: descriptorBefore?.writable,
      frozen: Object.isFrozen(helper),
      hideResult,
      removeResult,
      consumeResult,
      redefineError,
      globalStillInstalled: (window as any)[globalName] === helper,
    };
  }, AGENT_SESSION_OVERLAY_GLOBAL);

  expect(result).toEqual({
    configurable: false,
    enumerable: false,
    writable: false,
    frozen: true,
    hideResult: false,
    removeResult: false,
    consumeResult: false,
    redefineError: true,
    globalStillInstalled: true,
  });
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).display)).toBe('block');
});

it('agent-session overlay overwrites configurable page-owned helper without leaking token', async ({ context, server }) => {
  const { content, controlToken } = createAgentSessionOverlayScript({ statusText: 'MCP' });
  await context.addInitScript({ content: `
    (() => {
      const stolenTokens = [];
      const helper = {
        ensure: token => stolenTokens.push(token),
        show: token => stolenTokens.push(token),
      };
      window.__stolenOverlayTokens = stolenTokens;
      window.__pageOwnedOverlayHelper = helper;
      Object.defineProperty(window, ${JSON.stringify(AGENT_SESSION_OVERLAY_GLOBAL)}, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: helper,
      });
    })();
  ${content}` });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  const result = await page.evaluate(({ globalName, controlToken }) => {
    const descriptor = Object.getOwnPropertyDescriptor(window, globalName);
    return {
      stolenTokens: (window as any).__stolenOverlayTokens,
      leakedKnownToken: (window as any).__stolenOverlayTokens.includes(controlToken),
      overwritten: (window as any)[globalName] !== (window as any).__pageOwnedOverlayHelper,
      descriptor: {
        configurable: descriptor?.configurable,
        enumerable: descriptor?.enumerable,
        writable: descriptor?.writable,
      },
    };
  }, { globalName: AGENT_SESSION_OVERLAY_GLOBAL, controlToken });

  expect(result.stolenTokens).toEqual([]);
  expect(result.leakedKnownToken).toBe(false);
  expect(result.overwritten).toBe(true);
  expect(result.descriptor).toEqual(expect.objectContaining({
    configurable: false,
    enumerable: false,
    writable: false,
  }));
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
});

it('agent-session overlay does not leak token when non-configurable page-owned helper blocks overwrite', async ({ context, server }) => {
  const { content, controlToken } = createAgentSessionOverlayScript({ statusText: 'MCP' });
  await context.addInitScript({ content: `
    (() => {
      const stolenTokens = [];
      const helper = {
        ensure: token => stolenTokens.push(token),
        show: token => stolenTokens.push(token),
      };
      window.__stolenOverlayTokens = stolenTokens;
      window.__pageOwnedOverlayHelper = helper;
      Object.defineProperty(window, ${JSON.stringify(AGENT_SESSION_OVERLAY_GLOBAL)}, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: helper,
      });
    })();
  ${content}` });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  const result = await page.evaluate(({ globalName, controlToken }) => ({
    stolenTokens: (window as any).__stolenOverlayTokens,
    leakedKnownToken: (window as any).__stolenOverlayTokens.includes(controlToken),
    stillPageOwned: (window as any)[globalName] === (window as any).__pageOwnedOverlayHelper,
  }), { globalName: AGENT_SESSION_OVERLAY_GLOBAL, controlToken });

  expect(result).toEqual({
    stolenTokens: [],
    leakedKnownToken: false,
    stillPageOwned: true,
  });
  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
});

it('agent-session overlay stop affordance requires a one-second hold while host pointer-events stays none', async ({ context, server }) => {
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
  await page.waitForTimeout(1100);

  expect(await page.evaluate(() => ({
    callbackCount: (window as any).__stopCallbackCount,
    eventCount: (window as any).__stopEventCount,
  }))).toEqual({
    callbackCount: 0,
    eventCount: 0,
  });

  await page.mouse.move(stopButtonPoint.x, stopButtonPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(1100);
  await page.mouse.up();

  expect(await page.evaluate(() => ({
    callbackCount: (window as any).__stopCallbackCount,
    eventCount: (window as any).__stopEventCount,
  }))).toEqual({
    callbackCount: 1,
    eventCount: 1,
  });
  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).pointerEvents)).toBe('none');
});

it('agent-session overlay document panel dispatches latest and past fetch requests from configured accounts', async ({ context, server }) => {
  const documentFetchRequests: unknown[] = [];
  await context.route('**/sapoto-document-fetch', async route => {
    documentFetchRequests.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, body: '' });
  });
  await context.addInitScript({ content: buildOverlayScript({
    documentFetch: {
      endpoint: `${server.PREFIX}/sapoto-document-fetch`,
      payload: { runId: 'run-document-fetch' },
      accounts: [
        { token: 'checking-token', label: 'Everyday checking' },
        { token: 'savings-token', label: 'Savings' },
      ],
      currentAccountToken: 'checking-token',
      years: [2026, 2025],
      months: [5, 4],
    },
  }) });
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 620 });
  await page.goto(server.EMPTY_PAGE);

  await page.mouse.click(740, 380);
  await page.mouse.click(662, 388);
  await page.mouse.click(739, 519);

  await expect.poll(() => documentFetchRequests).toEqual([
    { accountToken: 'checking-token', mode: 'latest', runId: 'run-document-fetch' },
  ]);
  expect(await page.evaluate(() => ({
    configExposed: Object.prototype.hasOwnProperty.call(window, '__sapotoDocumentFetchOverlayConfig'),
    callbackExposed: Object.prototype.hasOwnProperty.call(window, '__sapotoDocumentFetchRequested'),
  }))).toEqual({ configExposed: false, callbackExposed: false });

  await page.mouse.click(565, 324);
  await page.mouse.click(740, 380);
  await page.mouse.click(819, 388);
  await page.mouse.click(739, 519);

  await expect.poll(() => documentFetchRequests).toEqual([
    { accountToken: 'checking-token', mode: 'latest', runId: 'run-document-fetch' },
    { accountToken: 'checking-token', mode: 'since_date', sinceYear: 2026, sinceMonth: 5, runId: 'run-document-fetch' },
  ]);

  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).pointerEvents)).toBe('none');
});

it('agent-session overlay document panel is absent without configured accounts', async ({ context, server }) => {
  await context.addInitScript({ content: OVERLAY_SCRIPT });
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 620 });
  await page.goto(server.EMPTY_PAGE);

  await page.evaluate(() => {
    (window as any).__documentFetchEventDetails = [];
    window.addEventListener('__sapotoMcpDocumentFetchRequested', event => {
      (window as any).__documentFetchEventDetails.push((event as CustomEvent).detail);
    });
  });

  await page.mouse.click(740, 438);
  await page.mouse.click(662, 438);
  await page.mouse.click(739, 563);

  expect(await page.evaluate(() => (window as any).__documentFetchEventDetails)).toEqual([]);
});
