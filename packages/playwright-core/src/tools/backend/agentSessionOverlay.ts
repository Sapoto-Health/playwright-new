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
  documentFetch?: AgentSessionOverlayDocumentFetchOptions;
};

export type AgentSessionOverlayScript = {
  content: string;
  controlToken: string;
};

export type AgentSessionOverlayDocumentFetchOptions = {
  endpoint: string;
  payload: Record<string, unknown>;
  accounts: Array<{ token: string; label: string }>;
  currentAccountToken?: string;
  years?: number[];
  months?: number[];
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

export function buildOverlayScript(_options: AgentSessionOverlayOptions = {}, controlToken = createGuid()): string {
  return `(() => {
  const HOST_TAG = ${JSON.stringify(AGENT_SESSION_OVERLAY_HOST)};
  const GLOBAL_NAME = ${JSON.stringify(AGENT_SESSION_OVERLAY_GLOBAL)};
  const CONTROL_TOKEN = ${JSON.stringify(controlToken)};

  try {
    if (window !== window.top)
      return;
  } catch (_) {
    return;
  }

  let host;
  let shadow;
  let root;
  let cursor;
  let pulseLayer;
  let hidden = false;
  let removed = false;
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

  const installStyles = () => {
    const css = \`
      @media print { :host { display: none !important; } }
      .root, .glow, .pulse-layer {
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
      .cursor {
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        width: 18px !important;
        height: 18px !important;
        margin: -2px 0 0 -2px !important;
        border-radius: 999px !important;
        background: rgba(255, 122, 24, 0.96) !important;
        box-shadow:
          0 0 0 2px rgba(255, 255, 255, 0.92),
          0 0 18px rgba(255, 122, 24, 0.72) !important;
        opacity: 0 !important;
        pointer-events: none !important;
        transform: translate3d(-9999px, -9999px, 0) !important;
        transition: transform 180ms ease-out, opacity 120ms ease-out !important;
      }
      .cursor.visible {
        opacity: 1 !important;
      }
      .pulse {
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        width: 34px !important;
        height: 34px !important;
        margin: -17px 0 0 -17px !important;
        border-radius: 999px !important;
        border: 3px solid rgba(255, 122, 24, 0.92) !important;
        background: rgba(255, 122, 24, 0.14) !important;
        pointer-events: none !important;
        transform: translate3d(-9999px, -9999px, 0) scale(0.7) !important;
        animation: sapoto-click-pulse 520ms ease-out forwards !important;
      }
      @keyframes sapoto-click-pulse {
        0% { opacity: 1; transform: var(--sapoto-pulse-transform) scale(0.65); }
        100% { opacity: 0; transform: var(--sapoto-pulse-transform) scale(1.8); }
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

  const toFiniteCoordinate = value => {
    const number = Number(value);
    if (!Number.isFinite(number))
      return undefined;
    return Math.max(-10000, Math.min(10000, number));
  };

  const setCursorPosition = (x, y) => {
    if (!cursor)
      return false;
    const safeX = toFiniteCoordinate(x);
    const safeY = toFiniteCoordinate(y);
    if (safeX === undefined || safeY === undefined)
      return false;
    try {
      cursor.style.setProperty('transform', 'translate3d(' + safeX + 'px, ' + safeY + 'px, 0)', 'important');
      cursor.classList.add('visible');
      return true;
    } catch (_) {
      return false;
    }
  };

  const pulseClick = (x, y) => {
    if (!pulseLayer)
      return false;
    const safeX = toFiniteCoordinate(x);
    const safeY = toFiniteCoordinate(y);
    if (safeX === undefined || safeY === undefined)
      return false;
    try {
      const pulse = document.createElement('div');
      pulse.className = 'pulse';
      const transform = 'translate3d(' + safeX + 'px, ' + safeY + 'px, 0)';
      pulse.style.setProperty('--sapoto-pulse-transform', transform);
      pulse.style.setProperty('transform', transform + ' scale(0.7)', 'important');
      pulseLayer.appendChild(pulse);
      window.setTimeout(() => {
        try { pulse.remove(); } catch (_) {}
      }, 700);
      return true;
    } catch (_) {
      return false;
    }
  };

  const buildDom = () => {
    host = document.createElement(HOST_TAG);
    restoreHostStyles();
    shadow = host.attachShadow({ mode: 'closed' });
    installStyles();

    root = document.createElement('div');
    root.className = 'root';

    const glow = document.createElement('div');
    glow.className = 'glow';
    root.appendChild(glow);

    pulseLayer = document.createElement('div');
    pulseLayer.className = 'pulse-layer';
    root.appendChild(pulseLayer);

    cursor = document.createElement('div');
    cursor.className = 'cursor';
    root.appendChild(cursor);

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
    moveCursor: (token, x, y) => {
      if (!isAuthorized(token))
        return false;
      appendHost();
      return setCursorPosition(x, y);
    },
    pulseClick: (token, x, y) => {
      if (!isAuthorized(token))
        return false;
      appendHost();
      const moved = setCursorPosition(x, y);
      return pulseClick(x, y) && moved;
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
