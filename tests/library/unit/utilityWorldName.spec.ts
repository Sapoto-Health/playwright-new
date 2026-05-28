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

import { test as it, expect } from '@playwright/test';
import {
  generateUtilityWorldName,
  UTILITY_WORLD_NAME_PATTERN,
} from '../../../packages/playwright-core/src/server/chromium/crUtilityWorldName';

it('generateUtilityWorldName produces a 16-character lowercase-hex string', () => {
  const name = generateUtilityWorldName();
  expect(name).toHaveLength(16);
  expect(name).toMatch(/^[0-9a-f]{16}$/);
});

it('generateUtilityWorldName never leaks framework-identifying substrings', () => {
  const forbiddenSubstrings = [
    '__chrome_',
    '__playwright_',
    'playwright',
    'utility_world',
    'utility-world',
    'utilityWorld',
  ];
  for (let i = 0; i < 256; i++) {
    const name = generateUtilityWorldName();
    for (const forbidden of forbiddenSubstrings)
      expect(name.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
});

it('generateUtilityWorldName is unique across many invocations', () => {
  const N = 1000;
  const names = new Set<string>();
  for (let i = 0; i < N; i++)
    names.add(generateUtilityWorldName());
  expect(names.size).toBe(N);
});

it('UTILITY_WORLD_NAME_PATTERN accepts generator output and rejects framework-shaped negatives', () => {
  // Positive: generator output always matches.
  for (let i = 0; i < 64; i++)
    expect(generateUtilityWorldName()).toMatch(UTILITY_WORLD_NAME_PATTERN);

  // Negatives: the legacy shape and recognisable framework substrings must be rejected.
  const negatives = [
    '__playwright_utility_world_abc',
    '__playwright_utility_world_page@0123456789abcdef0123456789abcdef',
    '__chrome_devtools_frontend',
    'utility_world_0123456789abcdef',
    'playwright',
    '0123456789ABCDEF', // uppercase hex
    '0123456789abcde',  // 15 chars
    '0123456789abcdef0', // 17 chars
    '',
    '0123456789abcdeg', // non-hex char
  ];
  for (const negative of negatives)
    expect(negative).not.toMatch(UTILITY_WORLD_NAME_PATTERN);
});
