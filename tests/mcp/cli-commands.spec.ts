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

import { test, expect } from './fixtures';
import { parseCommand } from '../../packages/playwright-core/src/tools/cli-daemon/command';
import { commands } from '../../packages/playwright-core/src/tools/cli-daemon/commands';

const commandArgs = (args: { _: string[], activate?: string }): Parameters<typeof parseCommand>[1] => args as Parameters<typeof parseCommand>[1];

test('tab-select maps to logical selection by default', async () => {
  expect(parseCommand(commands['tab-select'], commandArgs({ _: ['tab-select', '1'] }))).toEqual({
    toolName: 'browser_tabs',
    toolParams: {
      action: 'select',
      index: 1,
      activate: undefined,
    },
  });
});

test('tab-select --activate forwards visual activation request', async () => {
  expect(parseCommand(commands['tab-select'], commandArgs({ _: ['tab-select', '1'], activate: true as unknown as string }))).toEqual({
    toolName: 'browser_tabs',
    toolParams: {
      action: 'select',
      index: 1,
      activate: true,
    },
  });
});
