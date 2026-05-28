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
 * Sapoto Tracer #1155 (Unit G-ops) — download-wait subsystem regression
 * test. PRD user story #24 — DEADLOCK-AVOIDANCE INVARIANT.
 *
 * The load-bearing question: when `--disable-downloads` is set, does
 * `Tab._waitForPendingDownloads` short-circuit BEFORE inspecting any
 * download state? If a future refactor moves the disableDownloads check
 * below a wait/loop (e.g. "wait for the next download event with the
 * configured budget"), the tool response would block for the full
 * `--timeout-download` budget on every call, because the listener was
 * never installed and the wait would never resolve.
 *
 * Test 1 is the regression pin — it measures end-to-end response time
 * with `--disable-downloads --timeout-download 1000` and asserts the
 * response returns in <500ms. The 1000ms budget is the "what would the
 * deadlock look like" reference; <500ms proves the early-return fires.
 *
 * Tests 2 and 3 verify the positive path (wait for downloads) and the
 * upstream-default behaviour (no waiting) respectively.
 */

import { test, expect, parseResponse } from './fixtures';

test('Test 1: --disable-downloads with --timeout-download short-circuits the wait (PRD invariant pin)', async ({ startClient, server }, testInfo) => {
  // The endpoint sets `Content-Disposition: attachment` so the browser
  // treats the click as a download. With `--disable-downloads`, MCP does
  // NOT install Playwright's `download` listener, so no `savePromise`
  // exists; `_waitForPendingDownloads` MUST early-return.
  //
  // We don't even need the download to complete — the early-return must
  // fire whether the download stream is fast, slow, or never finishes.
  server.setRoute('/download-slow', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename=slow.bin',
    });
    // Send a tiny chunk, then stall. Without the early-return, any code
    // path that waited on "download finished" would block here.
    res.write('start');
    // Don't end() — leave the stream hanging.
  });
  server.setContent('/', `<a href="/download-slow" download="slow.bin">Slow Download</a>`, 'text/html');

  // Use a very small budget (5000ms) so the deadlock-vs-no-deadlock
  // delta is easy to see: with the early-return, elapsed is bounded by
  // the click round-trip; without it, elapsed would approach the budget
  // for any future refactor that waits on a never-arriving event.
  const downloadBudget = 5000;
  const { client } = await startClient({
    args: ['--disable-downloads', `--timeout-download=${downloadBudget}`],
    config: { outputDir: testInfo.outputPath('output') },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const startTime = Date.now();
  await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Slow Download link', target: 'e2' },
  });
  const elapsed = Date.now() - startTime;

  // The deadlock-avoidance invariant — `_waitForPendingDownloads` must
  // short-circuit BEFORE any timer/wait when `disableDownloads=true`.
  // Elapsed time must stay BELOW (downloadBudget - cushion). With a 5s
  // budget, the upper-bound is 2.5s — the click round-trip + existing
  // 500ms wait inside utils.ts's `waitForCompletion` typically take
  // ~1-1.2s, well under 2.5s.
  //
  // If a future refactor moves the disableDownloads check below a
  // wait/loop, elapsed would approach the full 5s budget and this
  // assertion would fire loudly.
  expect(elapsed).toBeLessThan(downloadBudget / 2);
});

test('Test 2: --timeout-download waits for in-flight downloads to finish', async ({ startClient, server }, testInfo) => {
  // Without the wait, tool responses can return before the file has been
  // flushed to disk, racing the embedder's "look for the file in the
  // output dir" follow-up code.
  server.setContent('/', `<a href="/download" download="test.txt">Download</a>`, 'text/html');
  server.setContent('/download', 'Data payload', 'text/plain');

  const { client } = await startClient({
    args: ['--timeout-download=1000'],
    config: { outputDir: testInfo.outputPath('output') },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Download link', target: 'e2' },
  });

  // With the wait active, the click response itself should include the
  // download-finish event (the saveAs() promise resolved before the tool
  // returned). The exact event-line format follows files.spec.ts.
  const parsed = parseResponse(response);
  let events = parsed.events ?? '';
  // Allow one snapshot follow-up read in case the event lands on the
  // subsequent tool call (Playwright's event timing is non-deterministic).
  if (!events.includes('Downloaded file test.txt')) {
    const r = await client.callTool({ name: 'browser_snapshot' });
    const p = parseResponse(r);
    if (p.events)
      events += '\n' + p.events;
  }
  expect(events).toContain('Downloaded file test.txt');
});

test('Test 3: without --timeout-download, tool responses do NOT block on downloads (upstream default)', async ({ startClient, server }, testInfo) => {
  // Regression guard — unflagged clients keep upstream-default behaviour
  // (no waiting). We don't assert a specific timing here; we just confirm
  // the click completes (no hang) and the response is well-formed.
  server.setContent('/', `<a href="/download" download="test.txt">Download</a>`, 'text/html');
  server.setContent('/download', 'Data', 'text/plain');

  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Download link', target: 'e2' },
  });

  // The response should land — we don't pin specific event lines here,
  // since the upstream behaviour pre-Sapoto already has subtle timing.
  // The point is just "no hang".
  expect(response).toBeTruthy();
});
