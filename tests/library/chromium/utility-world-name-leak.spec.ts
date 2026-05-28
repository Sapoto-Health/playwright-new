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

import { browserTest as it, expect } from '../../config/browserTest';
import { UTILITY_WORLD_NAME_PATTERN } from '../../../packages/playwright-core/src/server/chromium/crUtilityWorldName';

// Sapoto Tracer #1151 (Unit A): assert the utility-world name never leaks
// framework-identifying substrings into anti-bot-visible surfaces.
//
// The leak surface this guards against: any code running inside the utility
// world that throws — or constructs an `Error` — surfaces the world's name in
// the V8 source label of that frame. Anti-bot scrapers (Akamai bmak, DataDome,
// PerimeterX) routinely walk `Error.stack` looking for known framework
// substrings. A name like `__playwright_utility_world_page@<guid>` is an
// instant tell; a 16-char hex opaque token is not.

it.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only — utility world is a Chromium-specific concept');

it('utility-world name is opaque and does not leak framework substrings', async ({ page }) => {
  const client = await page.context().newCDPSession(page);

  // Capture every execution context Chromium reports on this session.
  // Runtime.enable replays existing contexts immediately, so contexts created
  // before we subscribed (the utility world among them) come through.
  const contextsByName = new Map<string, number>();
  const contextNames: string[] = [];
  client.on('Runtime.executionContextCreated', event => {
    const name = event.context.name;
    contextNames.push(name);
    if (name)
      contextsByName.set(name, event.context.id);
  });

  await client.send('Runtime.enable');
  // Navigate so the page has at least one non-empty document where the
  // utility world is materialised.
  await page.goto('data:text/html,<title>utility-world-name-leak</title>');

  // Wait for the utility world to be observable on this CDP session. The
  // utility world has an opaque-hex name; it is the only non-default context
  // we expect to see with that shape. Poll briefly because context creation
  // is async relative to the Runtime.enable round-trip.
  let utilityWorldName: string | undefined;
  let utilityContextId: number | undefined;
  await expect.poll(() => {
    for (const [name, id] of contextsByName) {
      if (UTILITY_WORLD_NAME_PATTERN.test(name)) {
        utilityWorldName = name;
        utilityContextId = id;
        return true;
      }
    }
    return false;
  }, { timeout: 5000 }).toBe(true);

  expect(utilityWorldName).toBeDefined();
  expect(utilityContextId).toBeDefined();

  // The world name itself must not match any known framework-identifying
  // substring, regardless of whether it shows up in stacks below.
  const forbiddenSubstrings = ['__chrome_', '__playwright_', 'playwright', 'utility_world', 'utility-world', 'utilityWorld'];
  for (const forbidden of forbiddenSubstrings)
    expect(utilityWorldName!.toLowerCase()).not.toContain(forbidden.toLowerCase());

  // Self-validation step (per PRD): the V8 source label must actually emit
  // the world name into Error.stack — otherwise the "no leaked substrings"
  // assertion below is vacuously satisfied by V8 not labelling the frame at
  // all. We force-label the frame with `//# sourceURL=${worldName}` and
  // then assert the label is visible in the stack.
  const evalResponse = await client.send('Runtime.evaluate', {
    contextId: utilityContextId!,
    expression: `(() => { try { throw new Error('probe'); } catch (e) { return e.stack; } })();\n//# sourceURL=${utilityWorldName}`,
    returnByValue: true,
  });

  expect(evalResponse.exceptionDetails).toBeUndefined();
  const stack = evalResponse.result.value as string;
  expect(stack).toBeTruthy();

  // Self-validation: the explicit sourceURL we attached must be visible in
  // the produced stack. If this fails, the rest of the assertion is
  // meaningless because V8 simply isn't tagging the frame.
  expect(stack).toContain(utilityWorldName!);

  // Real assertion: zero framework-identifying substrings anywhere in the
  // stack, even though we know the (opaque) world name appears.
  for (const forbidden of forbiddenSubstrings)
    expect(stack.toLowerCase()).not.toContain(forbidden.toLowerCase());
});
