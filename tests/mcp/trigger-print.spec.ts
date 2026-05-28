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
 * Sapoto Tracer #1156 (Unit K) — browser_trigger_print smoke tests.
 *
 * Two scenarios:
 *
 *   1. WITHOUT --capture-bridge: tool still succeeds. window.print() runs
 *      natively (the browser's native handler suppresses the dialog under
 *      automation in headless mode).
 *
 *   2. WITH --capture-bridge: Unit I's init script wraps window.print to
 *      route through electronAPI.requestPrintCapture. We can't inject a
 *      real Electron preload bridge, but we CAN install a stub
 *      `window.electronAPI = { requestPrintCapture: fn }` via a navigation
 *      to a data: URL that pre-defines the global. Then trigger the tool
 *      and verify the page's recorded call count was incremented via
 *      `browser_evaluate`.
 */

import { test, expect } from './fixtures';

test('browser_trigger_print succeeds without capture-bridge', async ({ startClient, server }) => {
  const { client } = await startClient();
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  const result = await client.callTool({
    name: 'browser_trigger_print',
  });

  expect(result.isError).toBeFalsy();
  expect(result).toHaveResponse({
    code: expect.stringContaining(`window.print()`),
    result: expect.stringContaining('window.print() triggered'),
  });
});

test('browser_trigger_print routes through electronAPI.requestPrintCapture when bridge is present', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--capture-bridge'] });

  // Set up a page that installs a fake electronAPI bridge BEFORE the
  // capture-bridge init script runs. We use a data: URL whose <head>
  // script defines the global synchronously; the Unit I init script runs
  // after this (it's installed via addInitScript at context level, but
  // for an inline page-script the order is: addInitScript first, THEN
  // page <head> scripts). To verify the bridge call we instead set up
  // electronAPI from page script and verify the C4 fast-path picks it up
  // via parent-walk.
  //
  // Because Playwright's init scripts run before any page script, we set
  // up the fake electronAPI inside the data: URL's <head> AND we use a
  // counter on `window` we can poll after the call.
  const html = `data:text/html,<!doctype html><html><head><script>
    window.__printCalls = [];
    window.electronAPI = {
      requestPrintCapture: function(payload) {
        window.__printCalls.push(payload);
      }
    };
  </script></head><body><h1>Print bridge test</h1></body></html>`;

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: html },
  });

  const result = await client.callTool({
    name: 'browser_trigger_print',
  });
  expect(result.isError).toBeFalsy();

  // Verify the bridge was actually called. The C4 synchronous fast-path
  // dispatches to electronAPI.requestPrintCapture on every window.print()
  // — even if the bridge installs AFTER the init script wraps print,
  // because C4 walks parents at dispatch time.
  const probe = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => ({ count: window.__printCalls?.length ?? 0, scope: window.__printCalls?.[0]?.scope })`,
    },
  });
  // The eval result is rendered as a "### Result" section containing
  // pretty-printed JSON. Extract the text section and inspect it
  // directly rather than chasing JSON.stringify escape levels.
  const probeText = (probe.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  expect(probeText).toContain('"count": 1');
  expect(probeText).toContain('top-frame');
});
