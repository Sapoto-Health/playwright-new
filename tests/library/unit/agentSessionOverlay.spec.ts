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
import { buildOverlayScript } from '../../../packages/playwright-core/src/tools/backend/agentSessionOverlay';

it('agent-session overlay IIFE carries print hiding and background-target guard', () => {
  const src = buildOverlayScript({ statusText: 'MCP' });
  expect(src).toContain('__sapoto_bg=V1:');
  expect(src).toContain('@media print');
  expect(src).toContain('__sapotoMcpAgentSessionOverlayV1');
  expect(src.startsWith('(() => {')).toBe(true);
  expect(src.trimEnd().endsWith('})();')).toBe(true);
});
