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
 * Sapoto Tracer #1155 (Unit G-ops) — `--allowed-tools` advertised-tool
 * allowlist.
 *
 * When the embedder needs to give the agent a narrow surface (e.g.
 * "just navigate + click, no eval, no run-code"), the CLI flag filters
 * `tools/list` to the comma-separated allowlist. Unset / empty preserves
 * the upstream default (every capability-selected tool advertised).
 */

import { test, expect } from './fixtures';

test('only the allowlisted tools are advertised via tools/list', async ({ startClient }) => {
  const { client } = await startClient({
    args: ['--allowed-tools=browser_navigate,browser_click'],
  });
  const { tools } = await client.listTools();
  const names = new Set(tools.map(t => t.name));
  expect(names).toEqual(new Set(['browser_navigate', 'browser_click']));
});

test('without --allowed-tools, every capability-selected tool is advertised', async ({ startClient }) => {
  // Regression guard — an empty / unset allowlist must short-circuit the
  // filter and preserve upstream-default behaviour. The exact count is
  // pinned by `capabilities.spec.ts`; here we only confirm that "many
  // more than 2" tools are advertised (sanity-check the no-filter path).
  const { client } = await startClient({});
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(2);
  const names = new Set(tools.map(t => t.name));
  expect(names.has('browser_navigate')).toBe(true);
  expect(names.has('browser_snapshot')).toBe(true);
});

test('allowlist is intersected with capability gates (cannot re-add disabled capability tools)', async ({ startClient }) => {
  // Pinning the layering order: capability filter runs first, allowlist
  // narrows the result. So `--allowed-tools=browser_pdf_save` without
  // `--caps=pdf` advertises ZERO pdf tools — the allowlist cannot
  // re-introduce a gated capability.
  const { client } = await startClient({
    args: ['--allowed-tools=browser_pdf_save,browser_navigate'],
  });
  const { tools } = await client.listTools();
  const names = new Set(tools.map(t => t.name));
  expect(names.has('browser_pdf_save')).toBe(false);
  expect(names.has('browser_navigate')).toBe(true);
});
