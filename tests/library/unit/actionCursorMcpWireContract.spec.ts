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

it('MCP context wires action cursor through the page lifecycle', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'packages/playwright-core/src/tools/backend/context.ts'), 'utf8');

  expect(source).toContain("contextOptions?: Pick<playwrightTypes.BrowserContextOptions, 'actionCursor'>");
  expect(source).toContain("cursor: this.config.browser?.contextOptions?.actionCursor ? 'hidden' : 'visible'");
  expect(source).toContain('this._showActionCursor(page);');
  expect(source).toContain('const actionCursor = this.config.browser?.contextOptions?.actionCursor;');
  expect(source).toContain('const options = actionCursor === true ? {} : actionCursor;');
  expect(source).toContain("page.showActionCursor(options).catch(e => debug('pw:tools:error')(e));");
});

it('MCP command and config expose the action cursor flag', () => {
  const programSource = fs.readFileSync(path.join(process.cwd(), 'packages/playwright-core/src/tools/mcp/program.ts'), 'utf8');
  const configSource = fs.readFileSync(path.join(process.cwd(), 'packages/playwright-core/src/tools/mcp/config.ts'), 'utf8');

  expect(programSource).toContain(".option('--action-cursor'");
  expect(configSource).toContain('actionCursor?: boolean;');
  expect(configSource).toContain("contextOptions.actionCursor = { clickEffect: 'point' };");
  expect(configSource).toContain('PLAYWRIGHT_MCP_ACTION_CURSOR');
});
