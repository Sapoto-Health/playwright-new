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

import fs from 'fs';
import path from 'path';

import { test as it, expect } from '@playwright/test';
import { buildOverlayScript } from '../../../packages/playwright-core/src/tools/backend/agentSessionOverlay';

it('agent-session overlay IIFE carries print hiding and a locked control API', () => {
  const src = buildOverlayScript({ statusText: 'MCP' });
  expect(src).not.toContain('__sapoto_bg=V1:');
  expect(src).toContain('@media print');
  expect(src).toContain('__sapotoMcpAgentSessionOverlayV1');
  expect(src).toContain('Object.freeze(api)');
  expect(src).toContain('configurable: false');
  expect(src.startsWith('(() => {')).toBe(true);
  expect(src.trimEnd().endsWith('})();')).toBe(true);
});

it('agent-session overlay host dispatch avoids page-realm reflective built-ins on the control-token path', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/tab.ts'), 'utf8');
  const helperStart = src.indexOf('private async _evaluateAgentSessionOverlayHelper');
  const helperEnd = src.indexOf('private _dialogShown', helperStart);
  const helperSrc = src.slice(helperStart, helperEnd);

  expect(helperSrc).toContain('switch (method)');
  expect(helperSrc).toContain('helper.hide(controlToken)');
  expect(helperSrc).toContain('helper.show(controlToken)');
  expect(helperSrc).toContain('helper.remove(controlToken)');
  expect(helperSrc).not.toContain('Reflect.get');
  expect(helperSrc).not.toContain('.call(helper');
});
