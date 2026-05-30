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

import { createGuid } from '@utils/crypto';

export type AgentSessionOverlayOptions = {
  statusText?: string;
};

export type AgentSessionOverlayScript = {
  content: string;
  controlToken: string;
};

export const AGENT_SESSION_OVERLAY_HOST = 'sapoto-mcp-agent-session-overlay';
export const AGENT_SESSION_OVERLAY_GLOBAL = '__sapotoMcpAgentSessionOverlayV1';

export function createAgentSessionOverlayScript(options: AgentSessionOverlayOptions = {}): AgentSessionOverlayScript {
  const controlToken = createGuid();
  return {
    content: buildOverlayScript(options, controlToken),
    controlToken,
  };
}

export function buildOverlayScript(options: AgentSessionOverlayOptions = {}, controlToken = createGuid()): string {
  const statusText = options.statusText ?? '';
  return `(() => {
  const HOST_TAG = ${JSON.stringify(AGENT_SESSION_OVERLAY_HOST)};
  const GLOBAL_NAME = ${JSON.stringify(AGENT_SESSION_OVERLAY_GLOBAL)};
  const CONTROL_TOKEN = ${JSON.stringify(controlToken)};
  const STATUS_TEXT = ${JSON.stringify(statusText)};

  try {
    if (window !== window.top)
      return;
  } catch (_) {
    return;
  }

  let host;
  let shadow;
  let root;
  let glow;
  let hidden = false;
  let removed = false;
  let stopRequested = false;
  let treeObserver;
  let hostObserver;

  const setImportant = (element, name, value) => {
    try {
      if (element.style.getPropertyValue(name) === value && element.style.getPropertyPriority(name) === 'important')
        return;
      element.style.setProperty(name, value, 'important');
    } catch (_) {}
  };

  const setStyle = (element, name, value) => {
    try {
      if (element.style.getPropertyValue(name) === value && !element.style.getPropertyPriority(name))
        return;
      element.style.setProperty(name, value);
    } catch (_) {}
  };

  const restoreHostStyles = () => {
    if (!host)
      return;
    try {
      if (host.getAttribute('aria-hidden') !== 'true')
        host.setAttribute('aria-hidden', 'true');
    } catch (_) {}
    setImportant(host, 'position', 'fixed');
    setImportant(host, 'inset', '0');
    if (hidden)
      setImportant(host, 'display', 'none');
    else
      setStyle(host, 'display', 'block');
    setImportant(host, 'width', '100vw');
    setImportant(host, 'height', '100vh');
    setImportant(host, 'pointer-events', 'none');
    setImportant(host, 'z-index', '2147483647');
    setImportant(host, 'contain', 'layout style paint');
  };

  const appendHost = () => {
    if (!host || removed)
      return;
    const parent = document.documentElement || document.body;
    if (!parent)
      return;
    if (host.parentNode !== parent)
      parent.appendChild(host);
    restoreHostStyles();
  };

  const installPrintStyles = () => {
    const css = \`
      @media print { :host { display: none !important; } }
      .root, .glow {
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        pointer-events: none !important;
        box-sizing: border-box !important;
      }
      .glow {
        box-shadow:
          inset 0 0 0 3px rgba(255, 122, 24, 0.98),
          inset 0 0 22px rgba(255, 122, 24, 0.62) !important;
      }
      .stop {
        position: fixed !important;
        left: 50% !important;
        bottom: 12px !important;
        transform: translateX(-50%) !important;
        min-width: 64px !important;
        height: 30px !important;
        padding: 0 13px !important;
        border: 1px solid rgba(146, 54, 10, 0.38) !important;
        border-radius: 15px !important;
        background: #ff6f1a !important;
        color: #ffffff !important;
        font: 600 13px/28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        letter-spacing: 0 !important;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22) !important;
        cursor: pointer !important;
        pointer-events: auto !important;
        user-select: none !important;
        -webkit-user-select: none !important;
      }
      .badge {
        position: fixed !important;
        left: 12px !important;
        bottom: 12px !important;
        padding: 4px 8px !important;
        border-radius: 12px !important;
        background: rgba(28, 30, 33, 0.86) !important;
        color: #fff !important;
        font: 600 11px/14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        letter-spacing: 0 !important;
        pointer-events: none !important;
      }
    \`;
    try {
      if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
        return;
      }
    } catch (_) {
    }
    try {
      const style = document.createElement('style');
      style.textContent = css;
      shadow.appendChild(style);
    } catch (_) {
    }
  };

  const buildDom = () => {
    host = document.createElement(HOST_TAG);
    restoreHostStyles();
    shadow = host.attachShadow({ mode: 'closed' });
    installPrintStyles();

    root = document.createElement('div');
    root.className = 'root';
    glow = document.createElement('div');
    glow.className = 'glow';
    root.appendChild(glow);

    const stop = document.createElement('button');
    stop.className = 'stop';
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      stopRequested = true;
      try {
        if (typeof window.__sapotoStopRequested === 'function')
          window.__sapotoStopRequested();
      } catch (_) {
      }
      try { window.dispatchEvent(new CustomEvent('__sapotoMcpStopRequested')); } catch (_) {}
    }, true);
    root.appendChild(stop);

    if (STATUS_TEXT) {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = STATUS_TEXT;
      root.appendChild(badge);
    }

    shadow.appendChild(root);
    try {
      glow.animate([
        { boxShadow: 'inset 0 0 0 3px rgba(255, 122, 24, 0.98), inset 0 0 18px rgba(255, 122, 24, 0.48)' },
        { boxShadow: 'inset 0 0 0 5px rgba(255, 122, 24, 0.98), inset 0 0 30px rgba(255, 122, 24, 0.78)' },
        { boxShadow: 'inset 0 0 0 3px rgba(255, 122, 24, 0.98), inset 0 0 18px rgba(255, 122, 24, 0.48)' },
      ], { duration: 2000, iterations: Infinity, easing: 'ease-in-out' });
    } catch (_) {
    }
  };

  const observe = () => {
    try {
      treeObserver = new MutationObserver(() => appendHost());
      treeObserver.observe(document, { childList: true, subtree: true });
    } catch (_) {
    }
    try {
      hostObserver = new MutationObserver(() => restoreHostStyles());
      hostObserver.observe(host, { attributes: true, attributeFilter: ['style', 'aria-hidden'] });
    } catch (_) {
    }
  };

  const isAuthorized = token => token === CONTROL_TOKEN;

  const api = {
    ensure: () => appendHost(),
    hide: token => {
      if (!isAuthorized(token))
        return false;
      hidden = true;
      restoreHostStyles();
      return true;
    },
    show: token => {
      if (!isAuthorized(token))
        return false;
      hidden = false;
      appendHost();
      return true;
    },
    remove: token => {
      if (!isAuthorized(token))
        return false;
      removed = true;
      try { treeObserver && treeObserver.disconnect(); } catch (_) {}
      try { hostObserver && hostObserver.disconnect(); } catch (_) {}
      try { host && host.remove(); } catch (_) {}
      return true;
    },
    stopRequested: () => stopRequested,
    consumeStopRequested: token => {
      if (!isAuthorized(token))
        return false;
      const value = stopRequested;
      stopRequested = false;
      return value;
    },
  };

  try { Object.freeze(api); } catch (_) {}

  try {
    Object.defineProperty(window, GLOBAL_NAME, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: api,
    });
  } catch (_) {
    window[GLOBAL_NAME] = api;
  }

  buildDom();
  if (document.documentElement || document.body)
    appendHost();
  else
    window.addEventListener('DOMContentLoaded', appendHost, { once: true });
  observe();
})();`;
}
