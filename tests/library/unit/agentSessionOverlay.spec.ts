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

it('agent-session overlay can hide its cursor visuals while retaining the host overlay', () => {
  const visibleSrc = buildOverlayScript();
  const hiddenSrc = buildOverlayScript({ cursor: 'hidden' });

  expect(visibleSrc).toContain('const CURSOR_VISIBLE = true;');
  expect(hiddenSrc).toContain('const CURSOR_VISIBLE = false;');
  expect(hiddenSrc).toContain('if (!CURSOR_VISIBLE)');
  expect(hiddenSrc).toContain('if (CURSOR_VISIBLE) {');
  expect(hiddenSrc).toContain("glow.className = 'glow';");
});

it('agent-session overlay exposes a token-gated health probe for watchdog restores', () => {
  const src = buildOverlayScript({ agentRunOverlay: true });

  expect(src).toContain('health: token => {');
  expect(src).toContain('if (!isAuthorized(token))');
  expect(src).toContain('owned: true');
  expect(src).toContain('hostCount: document.querySelectorAll(HOST_TAG).length');
  expect(src).toContain("display: 'none'");
  expect(src).toContain('const hostDisplay = host ? getComputedStyle(host).display : \'none\';');
  expect(src).toContain('const cursorDisplay = cursor ? getComputedStyle(cursor).display : \'none\';');
  expect(src).toContain('const cursorOpacity = cursor ? getComputedStyle(cursor).opacity : \'0\';');
  expect(src).toContain("const cursorIsVisible = !!cursor && CURSOR_VISIBLE && hostDisplay !== 'none' && cursorDisplay !== 'none' && cursorOpacity !== '0';");
  expect(src).toContain('visible: hostDisplay !== \'none\'');
  expect(src).toContain('display: hostDisplay');
  expect(src).toContain('zIndex: host ? getComputedStyle(host).zIndex : null');
  expect(src).toContain('cursorVisible: cursorIsVisible');
  expect(src).toContain('cursorNode: !!cursor');
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

it('agent-session overlay exposes token-gated cursor helpers from Tab', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/tab.ts'), 'utf8');

  expect(src).toContain('async moveAgentSessionCursor');
  expect(src).toContain('async pulseAgentSessionClick');
  expect(src).toContain('async moveAgentSessionCursorToLocator');
  expect(src).toContain('async pulseAgentSessionClickOnLocator');
  expect(src).toContain('await locator.scrollIntoViewIfNeeded({ timeout })');
  expect(src).toContain('helper.moveCursor(controlToken, x, y)');
  expect(src).toContain('helper.pulseClick(controlToken, x, y)');
});

it('agent-run overlay mode starts the cursor idle at viewport center and respects reduced motion', () => {
  const src = buildOverlayScript({ agentRunOverlay: true });

  expect(src).toContain('const AGENT_RUN_OVERLAY = true;');
  expect(src).toContain('setCursorPosition(window.innerWidth / 2, window.innerHeight / 2)');
  expect(src).toContain('sapoto-idle-cursor 1600ms ease-in-out infinite');
  expect(src).toContain('@media (prefers-reduced-motion: reduce)');
  expect(src).toContain('animation: none !important;');
});

it('agent-session overlay unregisters future injection before removing the current host on dispose', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/tab.ts'), 'utf8');
  const disposeStart = src.indexOf('async dispose()');
  const disposeEnd = src.indexOf('static forPage', disposeStart);
  const disposeSrc = src.slice(disposeStart, disposeEnd);

  expect(disposeSrc).toContain('await this._disposeAgentSessionOverlayInitScript()');
  expect(disposeSrc.indexOf('await this._disposeAgentSessionOverlayInitScript()'))
      .toBeLessThan(disposeSrc.indexOf('await this.removeAgentSessionOverlay()'));
});

it('agent-run overlay restore probes, reinstalls, and logs watchdog repairs', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/tab.ts'), 'utf8');
  const contextSrc = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/context.ts'), 'utf8');

  expect(src).toContain("type AgentRunOverlayRestoreReason = 'activate' | 'navigation' | 'watchdog' | 'capture'");
  expect(src).toContain('private _agentRunOverlayWatchdogTimer');
  expect(src).toContain('private _lastAgentRunOverlayHeartbeatAt');
  expect(src).toContain('private async _ensureAgentRunOverlayInstalled');
  expect(src).toContain('private async _agentRunOverlayHealth');
  expect(src).toContain("this._maybeLogAgentRunOverlayHeartbeat(reason, before)");
  expect(src).toContain("this._logAgentRunOverlayDiagnostic('heartbeat'");
  expect(src).toContain('await this.page.evaluate(this._agentSessionOverlayScript)');
  expect(src).toContain("this._logAgentRunOverlayDiagnostic('repair'");
  expect(src).toContain("this._logAgentRunOverlayDiagnostic('unhealthy'");
  expect(src).toContain('cursorVisible=${health.cursorVisible === true}');
  expect(src).toContain('captureHidden=${this._agentRunOverlayCaptureHidden}');
  expect(src).toContain('async hideAgentSessionOverlayForCapture()');
  expect(src).toContain('this._stopAgentRunOverlayWatchdog()');
  expect(contextSrc).toContain('if (tab === currentTab)');
  expect(contextSrc).toContain('return tab.setAgentRunOverlayActive(true)');
  expect(contextSrc).toContain('tab.setAgentRunOverlayActive(false).catch');
});

it('agent-run overlay watchdog stops when the tab closes', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/tab.ts'), 'utf8');
  const closeStart = src.indexOf('private _onClose()');
  const closeEnd = src.indexOf('private _clearCollectedArtifacts', closeStart);
  const closeSrc = src.slice(closeStart, closeEnd);

  expect(closeSrc).toContain('this._stopAgentRunOverlayWatchdog()');
});

it('agent-run overlay repair does not re-show while capture hide is active', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/tab.ts'), 'utf8');
  const hideStart = src.indexOf('async hideAgentSessionOverlayForCapture()');
  const hideEnd = src.indexOf('async showAgentSessionOverlayAfterCapture()', hideStart);
  const hideSrc = src.slice(hideStart, hideEnd);
  const ensureStart = src.indexOf('private async _ensureAgentRunOverlayInstalled');
  const ensureEnd = src.indexOf('private _isAgentRunOverlayHealthy', ensureStart);
  const ensureSrc = src.slice(ensureStart, ensureEnd);

  expect(src).toContain('private _agentRunOverlayCaptureHidden');
  expect(hideSrc).toContain('this._agentRunOverlayCaptureHidden = true');
  expect(ensureSrc).toContain('if (this._agentRunOverlayCaptureHidden)');
  expect(ensureSrc.indexOf('if (this._agentRunOverlayCaptureHidden)'))
      .toBeGreaterThan(ensureSrc.indexOf('await this.page.evaluate(this._agentSessionOverlayScript)'));
  expect(ensureSrc.indexOf('if (this._agentRunOverlayCaptureHidden)'))
      .toBeLessThan(ensureSrc.indexOf('await this.setAgentSessionOverlayVisible(true)'));
  expect(ensureSrc).toContain('if (this._agentRunOverlayCaptureHidden || !this.isCurrentTab())');
  expect(ensureSrc.indexOf('if (this._agentRunOverlayCaptureHidden || !this.isCurrentTab())'))
      .toBeGreaterThan(ensureSrc.indexOf('await this.setAgentSessionOverlayVisible(true)'));
  expect(ensureSrc).toContain('await this.setAgentSessionOverlayVisible(false).catch');
});

it('mcp watchdog disposes Playwright backends before process shutdown', () => {
  const watchdogSrc = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/mcp/watchdog.ts'), 'utf8');
  const exitHandlerStart = watchdogSrc.indexOf('const handleExit = async');
  const exitHandlerEnd = watchdogSrc.indexOf('process.stdin.on', exitHandlerStart);
  const exitHandlerSrc = watchdogSrc.slice(exitHandlerStart, exitHandlerEnd);

  expect(watchdogSrc).toContain("import { disposeAllBackends } from '../utils/mcp/server';");
  expect(exitHandlerSrc).toContain('await disposeAllBackends()');
  expect(exitHandlerSrc.indexOf('await disposeAllBackends()'))
      .toBeLessThan(exitHandlerSrc.indexOf('await gracefullyCloseAll()'));
});

it('agent-session overlay cursor hooks are called by high-level and coordinate mouse tools', () => {
  const snapshotSrc = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/snapshot.ts'), 'utf8');
  const mouseSrc = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/mouse.ts'), 'utf8');

  expect(snapshotSrc).toContain('await tab.pulseAgentSessionClickOnLocator(locator');
  expect(snapshotSrc).toContain('await tab.moveAgentSessionCursorToLocator(locator');
  expect(snapshotSrc).toContain('await tab.moveAgentSessionCursorToLocator(start.locator');
  expect(snapshotSrc).toContain('await tab.moveAgentSessionCursorToLocator(end.locator');
  expect(mouseSrc).toContain('await tab.moveAgentSessionCursor(params.x, params.y)');
  expect(mouseSrc).toContain('await tab.pulseAgentSessionClick(params.x, params.y)');
  expect(mouseSrc).toContain('await tab.moveAgentSessionCursor(params.startX, params.startY)');
  expect(mouseSrc).toContain('await tab.moveAgentSessionCursor(params.endX, params.endY)');
});

it('hidden agent-session overlay cursor helpers return before locator pre-scroll', () => {
  const tabSrc = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/tab.ts'), 'utf8');

  const moveStart = tabSrc.indexOf('async moveAgentSessionCursorToLocator');
  const moveEnd = tabSrc.indexOf('async pulseAgentSessionClickOnLocator', moveStart);
  const moveSrc = tabSrc.slice(moveStart, moveEnd);
  expect(moveSrc).toContain('if (!this._isAgentSessionOverlayCursorVisible())');
  expect(moveSrc.indexOf('if (!this._isAgentSessionOverlayCursorVisible())'))
      .toBeLessThan(moveSrc.indexOf('this._agentSessionLocatorCenter(locator)'));

  const pulseStart = tabSrc.indexOf('async pulseAgentSessionClickOnLocator');
  const pulseEnd = tabSrc.indexOf('private async _evaluateAgentSessionOverlayHelper', pulseStart);
  const pulseSrc = tabSrc.slice(pulseStart, pulseEnd);
  expect(pulseSrc).toContain('if (!this._isAgentSessionOverlayCursorVisible())');
  expect(pulseSrc.indexOf('if (!this._isAgentSessionOverlayCursorVisible())'))
      .toBeLessThan(pulseSrc.indexOf('this._agentSessionLocatorCenter(locator)'));
});

it('agent-session overlay init script detection no longer depends on document-fetch markers', () => {
  const contextSrc = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/context.ts'), 'utf8');
  const overlaySrc = fs.readFileSync(path.join(__dirname, '../../../packages/playwright-core/src/tools/backend/agentSessionOverlay.ts'), 'utf8');

  expect(contextSrc).toContain('isAgentSessionOverlayBoundInitScriptContent(content)');
  expect(overlaySrc).toContain('__sapotoMcpStopRequested');
  expect(overlaySrc).toContain('AGENT_SESSION_OVERLAY_GLOBAL');
  expect(overlaySrc).toContain('AGENT_SESSION_OVERLAY_OWNED_MARKER');
  expect(contextSrc).not.toContain('__sapotoAgentSessionDocumentFetchOverlayConfigV1__');
  expect(overlaySrc).not.toContain('__sapotoAgentSessionDocumentFetchOverlayConfigV1__');
});
