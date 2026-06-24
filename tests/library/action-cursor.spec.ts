/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, browserTest as test } from '../config/browserTest';

test.skip(({ mode }) => mode !== 'default', 'Action cursor uses an open shadow root only in default mode');
test.skip(({ browserName }) => browserName !== 'chromium', 'Action cursor v1 is Chromium-only');

test('context option should show the pointer cursor and Sapoto gold pulse on pointer actions by default', async ({ browser, server }) => {
  const context = await browser.newContext({ actionCursor: true });
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/input/button.html');

  await expect(page.locator('x-pw-action-cursor')).toBeHidden();
  await page.click('button');

  await expect(page.locator('x-pw-action-cursor')).toBeVisible();
  await expect(page.locator('x-pw-action-point')).toBeVisible();
  await expect(page.locator('x-pw-title')).toBeHidden();

  await context.close();
});

test('page API should not show an idle cursor before pointer actions', async ({ browser, server }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/input/button.html');

  await page.showActionCursor({ duration: 5000 });

  await expect(page.locator('x-pw-action-cursor')).toBeHidden();

  await context.close();
});

test('context option should not show idle cursor on a new page before pointer actions', async ({ browser }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000 }, viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent('<button>Target</button>');

  await expect(page.locator('x-pw-action-cursor')).toBeHidden();

  await context.close();
});

test('idle cursor should not reappear at viewport center after navigation', async ({ browser, server }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/input/button.html');
  await page.showActionCursor({ duration: 5000 });

  await page.goto(server.PREFIX + '/input/button.html?again=1');

  await expect(page.locator('x-pw-action-cursor')).toBeHidden();

  await context.close();
});

test('click effect can be enabled as a Sapoto gold pulse instead of a filled orange or red circle', async ({ browser, server }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000, clickEffect: 'point' } });
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/input/button.html');

  await page.click('button');

  const ring = page.locator('x-pw-action-point');
  await expect(ring).toBeVisible();
  const style = await ring.evaluate((el: HTMLElement) => {
    const style = getComputedStyle(el);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderStyle: style.borderStyle,
      borderWidth: style.borderWidth,
      borderRadius: style.borderRadius,
    };
  });
  expect(style).toEqual({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderColor: 'rgba(212, 160, 23, 0.98)',
    borderStyle: 'solid',
    borderWidth: '2px',
    borderRadius: '999px',
  });

  await context.close();
});

test('click ring appears at the cursor destination after movement completes', async ({ browser }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000, clickEffect: 'point' }, viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent(`
    <div style="position: fixed; top: 20px; left: 20px; width: 60px; height: 60px;" id="a">A</div>
    <div style="position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px;" id="b">B</div>
  `);

  await page.click('#a', { force: true });
  await expect(page.locator('x-pw-action-point')).toBeVisible();

  await page.click('#b', { force: true });
  const ringStateAfterClick = await page.locator('x-pw-action-point').evaluate((el: HTMLElement) => ({
    delay: el.getAttribute('data-click-delay'),
    hidden: el.hidden,
  }));
  expect(ringStateAfterClick).toEqual({ delay: 'false', hidden: false });

  await context.close();
});

test('subsequent pointer action waits for the visible cursor to arrive before clicking', async ({ browser }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000 }, viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent(`
    <button
      id="origin"
      style="position: fixed; top: 20px; left: 20px; width: 80px; height: 80px;"
    >Origin</button>
    <button
      id="target"
      onclick="window.clickedAt = performance.now()"
      style="position: fixed; bottom: 20px; right: 20px; width: 80px; height: 80px;"
    >Target</button>
  `);
  await page.showActionCursor({ duration: 5000 });
  await expect(page.locator('x-pw-action-cursor')).toBeHidden();
  await page.click('#origin', { force: true });

  const clickPromise = page.click('#target', { force: true });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).clickedAt)).toBeUndefined();
  await clickPromise;
  expect(await page.evaluate(() => typeof (window as any).clickedAt)).toBe('number');

  await context.close();
});

test('first pointer action does not animate from viewport center when idle cursor was not already installed', async ({ browser }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000 }, viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent(`
    <button
      id="target"
      onclick="window.clickedAt = performance.now()"
      style="position: fixed; bottom: 20px; right: 20px; width: 80px; height: 80px;"
    >Target</button>
  `);

  await page.click('#target', { force: true });

  expect(await page.evaluate(() => typeof (window as any).clickedAt)).toBe('number');
  await expect(page.locator('x-pw-action-cursor')).not.toHaveAttribute('data-motion-path', 'curved');

  await context.close();
});

test('wheel action updates the cursor at the current mouse point', async ({ browser }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000 }, viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent('<div style="height: 2000px;"></div>');
  await page.showActionCursor({ duration: 5000 });
  await expect(page.locator('x-pw-action-cursor')).toBeHidden();

  await page.mouse.move(200, 220);
  await page.hideActionCursor();
  await page.showActionCursor({ duration: 5000 });
  await expect(page.locator('x-pw-action-cursor')).toBeHidden();
  await page.mouse.wheel(0, 240);

  await expect(page.locator('x-pw-action-cursor')).toBeVisible();
  const state = await page.locator('x-pw-action-cursor').evaluate((el: HTMLElement) => ({
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    idle: el.getAttribute('data-idle'),
    mode: el.getAttribute('data-mode'),
    curved: el.getAttribute('data-motion-path'),
  }));
  expect(state).toEqual({ left: 200, top: 220, idle: 'false', mode: 'scroll', curved: null });

  await page.click('div', { force: true, position: { x: 40, y: 40 } });
  await expect(page.locator('x-pw-action-cursor')).toHaveAttribute('data-mode', 'pointer');

  await context.close();
});

test('first wheel action does not render cursor at the mouse constructor default', async ({ browser }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000 }, viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.setContent('<div style="height: 2000px;"></div>');
  await expect(page.locator('x-pw-action-cursor')).toBeHidden();

  await page.mouse.wheel(0, 240);

  await expect(page.locator('x-pw-action-cursor')).toBeHidden();

  await context.close();
});

test('cursor movement records a curved human path between pointer actions', async ({ browser, server }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000 } });
  const page = await context.newPage();
  await page.setContent(`
    <div style="position: fixed; top: 20px; left: 20px; width: 60px; height: 60px;" id="a">A</div>
    <div style="position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px;" id="b">B</div>
  `);

  await page.click('#a', { force: true });
  await page.click('#b', { force: true });

  const cursor = page.locator('x-pw-action-cursor');
  await expect(cursor).toHaveAttribute('data-motion-path', 'curved');

  await context.close();
});

test('cursor visual uses an arrow pointer instead of a circular puck', async ({ browser, server }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000 } });
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/input/button.html');

  await page.click('button');

  const cursor = page.locator('x-pw-action-cursor');
  await expect(cursor).toBeVisible();
  const state = await cursor.evaluate((cursor: HTMLElement) => {
    const svg = cursor.querySelector('svg');
    const pointer = svg?.querySelector('[data-cursor-shape="pointer"]');
    const paths = pointer ? [...pointer.querySelectorAll('path')] : [];
    return {
      viewBox: svg?.getAttribute('viewBox'),
      pathCount: paths.length,
      circleCount: pointer?.querySelectorAll('circle').length,
      bodyFill: paths[0]?.getAttribute('fill'),
      bodyStroke: paths[0]?.getAttribute('stroke'),
      accentStroke: paths[1]?.getAttribute('stroke'),
    };
  });
  expect(state).toEqual({
    viewBox: '0 0 22 26',
    pathCount: 2,
    circleCount: 0,
    bodyFill: 'rgb(17, 24, 39)',
    bodyStroke: 'rgb(212, 160, 23)',
    accentStroke: 'rgba(240, 192, 64, 0.96)',
  });

  await context.close();
});

test('page API should enable and disable action cursor', async ({ browser, server }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/input/button.html');

  await page.showActionCursor({ duration: 5000, clickEffect: 'point' });
  await page.click('button');

  await expect(page.locator('x-pw-action-cursor')).toBeVisible();
  await expect(page.locator('x-pw-action-point')).toBeVisible();
  await expect(page.locator('x-pw-title')).toBeHidden();

  await page.hideActionCursor();
  await page.goto(server.PREFIX + '/input/button.html');
  await page.click('button');

  await expect(page.locator('x-pw-action-cursor')).toBeHidden();
  await expect(page.locator('x-pw-action-point')).toBeHidden();

  await context.close();
});

test('should keep action cursor out of screenshots by default', async ({ browser, server }) => {
  const context = await browser.newContext({ actionCursor: { duration: 5000 } });
  const page = await context.newPage();
  await page.goto(server.PREFIX + '/input/button.html');
  await page.click('button');

  await expect(page.locator('x-pw-action-cursor')).toBeVisible();
  await page.screenshot();
  await expect(page.locator('x-pw-action-cursor')).toBeHidden();
  await expect(page.locator('x-pw-action-point')).toBeHidden();

  await context.close();
});
