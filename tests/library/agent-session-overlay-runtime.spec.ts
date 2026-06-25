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
import { PNG } from '../../packages/playwright-core/lib/utilsBundle';

const OVERLAY_SCRIPT = buildOverlayScript({
  statusText: 'MCP',
  documentFetch: {
    endpoint: 'https://example.invalid/sapoto-document-fetch',
    payload: { runId: 'ignored' },
    accounts: [{ token: 'ignored-token', label: 'Ignored account' }],
  },
});
const HOST_SELECTOR = 'sapoto-mcp-agent-session-overlay';

function countWarmOverlayPixels(buffer: Buffer): number {
  const png = PNG.sync.read(buffer);
  let warm = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      if (r > 200 && g > 60 && g < 180 && b < 90)
        warm += 1;
    }
  }
  return warm;
}

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
    const moveResult = helper.moveCursor('wrong-token', 25, 30);
    const pulseResult = helper.pulseClick('wrong-token', 25, 30);
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
      moveResult,
      pulseResult,
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
    moveResult: false,
    pulseResult: false,
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

it('agent-session overlay remains single-instance if the same document evaluates it twice', async ({ context, server }) => {
  const { content, controlToken } = createAgentSessionOverlayScript({ statusText: 'MCP' });
  await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  await page.evaluate(content).catch(() => {});

  expect(await page.locator(HOST_SELECTOR).count()).toBe(1);
  const result = await page.evaluate(({ globalName, controlToken }) => {
    const helper = (window as any)[globalName];
    return {
      hideResult: helper.hide(controlToken),
      hostDisplays: [...document.querySelectorAll('sapoto-mcp-agent-session-overlay')]
          .map(host => getComputedStyle(host).display),
    };
  }, { globalName: AGENT_SESSION_OVERLAY_GLOBAL, controlToken });
  expect(result).toEqual({
    hideResult: true,
    hostDisplays: ['none'],
  });
});

it('agent-session overlay is passive and does not dispatch page-side stop or document fetch actions', async ({ context, server }) => {
  const documentFetchRequests: unknown[] = [];
  await context.route('**/sapoto-document-fetch', async route => {
    documentFetchRequests.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, body: '' });
  });
  await context.addInitScript({ content: OVERLAY_SCRIPT });
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 620 });
  await page.goto(server.EMPTY_PAGE);

  await page.evaluate(() => {
    (window as any).__stopCallbackCount = 0;
    (window as any).__stopEventCount = 0;
    (window as any).__sapotoStopRequested = () => (window as any).__stopCallbackCount++;
    window.addEventListener('__sapotoMcpStopRequested', () => (window as any).__stopEventCount++);
  });

  for (const point of [
    { x: 450, y: 593 },
    { x: 740, y: 380 },
    { x: 662, y: 388 },
    { x: 739, y: 519 },
  ])
    await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(1100);

  expect(await page.evaluate(() => ({
    callbackCount: (window as any).__stopCallbackCount,
    eventCount: (window as any).__stopEventCount,
  }))).toEqual({
    callbackCount: 0,
    eventCount: 0,
  });
  expect(documentFetchRequests).toEqual([]);
  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).pointerEvents)).toBe('none');
});

it('agent-session overlay cursor visuals are token gated', async ({ context, server }) => {
  const { content, controlToken } = createAgentSessionOverlayScript();
  await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  expect(await page.evaluate(({ globalName, controlToken }) => {
    const helper = (window as any)[globalName];
    return {
      invalidMove: helper.moveCursor('wrong-token', 10, 20),
      invalidPulse: helper.pulseClick('wrong-token', 10, 20),
      validMove: helper.moveCursor(controlToken, 123, 234),
      validPulse: helper.pulseClick(controlToken, 123, 234),
    };
  }, { globalName: AGENT_SESSION_OVERLAY_GLOBAL, controlToken })).toEqual({
    invalidMove: false,
    invalidPulse: false,
    validMove: true,
    validPulse: true,
  });
  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).pointerEvents)).toBe('none');
});

it('agent-session overlay health probe is token gated and reports owned host state', async ({ context, server }) => {
  const { content, controlToken } = createAgentSessionOverlayScript({ agentRunOverlay: true });
  await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  expect(await page.evaluate(({ globalName, controlToken }) => {
    const helper = (window as any)[globalName];
    return {
      invalid: helper.health('wrong-token'),
      valid: helper.health(controlToken),
    };
  }, { globalName: AGENT_SESSION_OVERLAY_GLOBAL, controlToken })).toEqual({
    invalid: {
      authorized: false,
      owned: true,
      hostCount: 0,
      visible: false,
    },
    valid: {
      authorized: true,
      owned: true,
      hostCount: 1,
      visible: true,
    },
  });
});

it('agent-session overlay hidden cursor mode retains active glow without cursor helper failures', async ({ context, server }) => {
  const { content, controlToken } = createAgentSessionOverlayScript({ cursor: 'hidden' });
  await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  expect(await page.evaluate(({ globalName, controlToken }) => {
    const helper = (window as any)[globalName];
    return {
      move: helper.moveCursor(controlToken, 123, 234),
      pulse: helper.pulseClick(controlToken, 123, 234),
    };
  }, { globalName: AGENT_SESSION_OVERLAY_GLOBAL, controlToken })).toEqual({
    move: true,
    pulse: true,
  });

  expect(countWarmOverlayPixels(await page.screenshot())).toBeGreaterThan(0);
  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).pointerEvents)).toBe('none');
});

it('agent-session overlay hides for capture with token-gated host controls', async ({ context, server }) => {
  const { content, controlToken } = createAgentSessionOverlayScript();
  await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto(server.EMPTY_PAGE);

  expect(await page.evaluate(({ globalName, controlToken }) => {
    const helper = (window as any)[globalName];
    return {
      invalidHide: helper.hide('wrong-token'),
      displayAfterInvalidHide: getComputedStyle(document.querySelector('sapoto-mcp-agent-session-overlay')!).display,
      validHide: helper.hide(controlToken),
      displayAfterValidHide: getComputedStyle(document.querySelector('sapoto-mcp-agent-session-overlay')!).display,
      invalidShow: helper.show('wrong-token'),
      displayAfterInvalidShow: getComputedStyle(document.querySelector('sapoto-mcp-agent-session-overlay')!).display,
      validShow: helper.show(controlToken),
      displayAfterValidShow: getComputedStyle(document.querySelector('sapoto-mcp-agent-session-overlay')!).display,
    };
  }, { globalName: AGENT_SESSION_OVERLAY_GLOBAL, controlToken })).toEqual({
    invalidHide: false,
    displayAfterInvalidHide: 'block',
    validHide: true,
    displayAfterValidHide: 'none',
    invalidShow: false,
    displayAfterInvalidShow: 'none',
    validShow: true,
    displayAfterValidShow: 'block',
  });
  expect(await page.locator(HOST_SELECTOR).evaluate(host => getComputedStyle(host).pointerEvents)).toBe('none');
});
