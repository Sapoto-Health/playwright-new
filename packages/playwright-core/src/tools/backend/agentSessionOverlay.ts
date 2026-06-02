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

export function buildOverlayScript(options: AgentSessionOverlayOptions = {}, controlToken = createGuid()): string {
  const statusText = options.statusText ?? '';
  const documentFetchConfig = options.documentFetch && options.documentFetch.accounts.length > 0
    ? options.documentFetch
    : null;
  return `(() => {
  const HOST_TAG = ${JSON.stringify(AGENT_SESSION_OVERLAY_HOST)};
  const GLOBAL_NAME = ${JSON.stringify(AGENT_SESSION_OVERLAY_GLOBAL)};
  const CONTROL_TOKEN = ${JSON.stringify(controlToken)};
  const STATUS_TEXT = ${JSON.stringify(statusText)};
  const DOCUMENT_FETCH_CONFIG = ${JSON.stringify(documentFetchConfig)};

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
  let stopHoldTimer;
  let stopHoldCompleted = false;
  let documentPanel;
  let documentPanelStep = 1;
  let documentPanelMode = 'latest';
  let selectedAccountToken;
  let selectedYear;
  let selectedMonth;
  let documentFetchConfig;

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
        z-index: 2147483647 !important;
        min-width: 132px !important;
        height: 34px !important;
        padding: 0 15px !important;
        border: 1px solid rgba(146, 54, 10, 0.38) !important;
        border-radius: 17px !important;
        background: #ff6f1a !important;
        color: #ffffff !important;
        font: 700 12px/32px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        letter-spacing: 0 !important;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22) !important;
        cursor: pointer !important;
        pointer-events: auto !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        overflow: hidden !important;
        touch-action: none !important;
      }
      .stop::before {
        content: "" !important;
        position: absolute !important;
        inset: 0 !important;
        width: 0 !important;
        background: rgba(104, 28, 0, 0.32) !important;
        transition: width 1000ms linear !important;
      }
      .stop.holding::before {
        width: 100% !important;
      }
      .stop span {
        position: relative !important;
        z-index: 1 !important;
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
      .document-panel {
        position: fixed !important;
        right: 16px !important;
        bottom: 64px !important;
        z-index: 2147483646 !important;
        width: 336px !important;
        max-width: calc(100vw - 24px) !important;
        height: 248px !important;
        padding: 14px 16px !important;
        border: 1px solid rgba(15, 23, 42, 0.18) !important;
        border-radius: 8px !important;
        background: rgba(255, 255, 255, 0.98) !important;
        color: #111827 !important;
        box-shadow: 0 16px 44px rgba(15, 23, 42, 0.24) !important;
        box-sizing: border-box !important;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        pointer-events: auto !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        overflow: hidden !important;
      }
      .document-panel * {
        box-sizing: border-box !important;
        letter-spacing: 0 !important;
      }
      .document-topbar {
        display: grid !important;
        grid-template-columns: 48px 1fr 52px !important;
        align-items: center !important;
        gap: 8px !important;
        height: 32px !important;
      }
      .document-back {
        width: 34px !important;
        height: 28px !important;
        border: 1px solid rgba(15, 23, 42, 0.16) !important;
        border-radius: 6px !important;
        background: #f8fafc !important;
        color: #111827 !important;
        cursor: pointer !important;
        font: 700 16px/24px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        padding: 0 !important;
        pointer-events: auto !important;
      }
      .document-step {
        color: #334155 !important;
        font: 700 12px/16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        text-align: center !important;
      }
      .document-progress {
        display: flex !important;
        gap: 4px !important;
        justify-content: flex-end !important;
      }
      .document-progress span {
        width: 20px !important;
        height: 5px !important;
        border-radius: 5px !important;
        background: #cbd5e1 !important;
      }
      .document-progress .active {
        background: #ff6f1a !important;
      }
      .document-body {
        margin-top: 18px !important;
        max-height: 142px !important;
        overflow-y: auto !important;
      }
      .account-list {
        display: grid !important;
        gap: 8px !important;
        padding-right: 2px !important;
      }
      .account-row, .choice {
        width: 100% !important;
        border: 1px solid rgba(15, 23, 42, 0.16) !important;
        border-radius: 7px !important;
        background: #ffffff !important;
        color: #111827 !important;
        cursor: pointer !important;
        text-align: left !important;
        pointer-events: auto !important;
      }
      .account-row {
        height: 42px !important;
        padding: 0 12px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        font: 700 13px/40px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      .account-row.selected, .choice.selected {
        border-color: #ff6f1a !important;
        box-shadow: 0 0 0 2px rgba(255, 111, 26, 0.18) !important;
      }
      .choices {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 10px !important;
      }
      .choice {
        height: 58px !important;
        padding: 0 10px !important;
        text-align: center !important;
        font: 700 13px/16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      .past-fields {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 10px !important;
        margin-top: 12px !important;
      }
      .past-fields select {
        width: 100% !important;
        height: 32px !important;
        border: 1px solid rgba(15, 23, 42, 0.16) !important;
        border-radius: 6px !important;
        background: #ffffff !important;
        color: #111827 !important;
        font: 600 12px/16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        pointer-events: auto !important;
      }
      .fetch {
        position: absolute !important;
        left: 16px !important;
        right: 16px !important;
        bottom: 16px !important;
        height: 42px !important;
        border: 0 !important;
        border-radius: 7px !important;
        background: #111827 !important;
        color: #ffffff !important;
        cursor: pointer !important;
        font: 800 13px/40px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        pointer-events: auto !important;
      }
      @media (max-width: 420px) {
        .document-panel {
          right: 12px !important;
          bottom: 60px !important;
          width: calc(100vw - 24px) !important;
          height: 256px !important;
          padding: 12px !important;
        }
        .fetch {
          left: 12px !important;
          right: 12px !important;
          bottom: 12px !important;
        }
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

  const readDocumentFetchConfig = () => {
    const raw = DOCUMENT_FETCH_CONFIG;
    try {
      try { delete window.__sapotoDocumentFetchOverlayConfig; } catch (_) {}
      try { delete window.__sapotoDocumentFetchRequested; } catch (_) {}
    } catch (_) { return undefined; }
    if (!raw || typeof raw !== 'object')
      return undefined;
    const accounts = Array.isArray(raw.accounts) ? raw.accounts.map(account => {
      if (!account || typeof account !== 'object')
        return undefined;
      const token = typeof account.token === 'string' ? account.token : '';
      const label = typeof account.label === 'string' ? account.label : '';
      if (!token || !label)
        return undefined;
      return { token, label };
    }).filter(Boolean) : [];
    if (!accounts.length)
      return undefined;
    const currentAccountToken = typeof raw.currentAccountToken === 'string' ? raw.currentAccountToken : undefined;
    const years = Array.isArray(raw.years) ? raw.years.map(year => Number(year)).filter(year => Number.isInteger(year) && year >= 1900 && year <= 3000) : [];
    const months = Array.isArray(raw.months) ? raw.months.map(month => Number(month)).filter(month => Number.isInteger(month) && month >= 1 && month <= 12) : [];
    return {
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
      payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
      accounts,
      currentAccountToken,
      years: years.length ? years : [new Date().getFullYear()],
      months: months.length ? months : [new Date().getMonth() + 1],
    };
  };

  const appendText = (parent, tag, className, text) => {
    const element = document.createElement(tag);
    if (className)
      element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  };

  const dispatchStopRequested = () => {
    if (stopRequested)
      return;
    stopRequested = true;
    try {
      if (typeof window.__sapotoStopRequested === 'function')
        window.__sapotoStopRequested();
    } catch (_) {
    }
    try { window.dispatchEvent(new CustomEvent('__sapotoMcpStopRequested')); } catch (_) {}
  };

  const cancelStopHold = stop => {
    try { clearTimeout(stopHoldTimer); } catch (_) {}
    stopHoldTimer = undefined;
    stopHoldCompleted = false;
    try { stop.classList.remove('holding'); } catch (_) {}
  };

  const startStopHold = stop => {
    cancelStopHold(stop);
    stopHoldCompleted = false;
    try { stop.classList.add('holding'); } catch (_) {}
    stopHoldTimer = setTimeout(() => {
      stopHoldCompleted = true;
      try { stop.classList.remove('holding'); } catch (_) {}
      dispatchStopRequested();
    }, 1000);
  };

  const monthLabel = month => {
    const labels = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return labels[month - 1] || String(month);
  };

  const dispatchDocumentFetch = () => {
    if (!selectedAccountToken)
      return;
    const detail = documentPanelMode === 'past' ? {
      accountToken: selectedAccountToken,
      mode: 'since_date',
      sinceYear: selectedYear,
      sinceMonth: selectedMonth,
    } : {
      accountToken: selectedAccountToken,
      mode: 'latest',
    };
    try {
      if (!documentFetchConfig.endpoint)
        return;
      fetch(documentFetchConfig.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({}, detail, documentFetchConfig.payload || {})),
        keepalive: true,
        mode: 'cors',
        credentials: 'omit',
      }).catch(() => {});
    } catch (_) {
    }
  };

  const renderDocumentPanel = () => {
    if (!documentPanel || !documentFetchConfig)
      return;
    while (documentPanel.firstChild)
      documentPanel.removeChild(documentPanel.firstChild);

    const topbar = appendText(documentPanel, 'div', 'document-topbar', '');
    const back = document.createElement('button');
    back.className = 'document-back';
    back.type = 'button';
    back.textContent = '‹';
    if (documentPanelStep === 1)
      back.style.visibility = 'hidden';
    back.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      documentPanelStep = 1;
      renderDocumentPanel();
    }, true);
    topbar.appendChild(back);
    appendText(topbar, 'div', 'document-step', documentPanelStep === 1 ? 'Step 1 of 2' : 'Step 2 of 2');
    const progress = appendText(topbar, 'div', 'document-progress', '');
    appendText(progress, 'span', 'active', '');
    appendText(progress, 'span', documentPanelStep === 2 ? 'active' : '', '');

    const body = appendText(documentPanel, 'div', 'document-body', '');
    if (documentPanelStep === 1) {
      const list = appendText(body, 'div', 'account-list', '');
      for (const account of documentFetchConfig.accounts) {
        const row = document.createElement('button');
        row.className = account.token === selectedAccountToken ? 'account-row selected' : 'account-row';
        row.type = 'button';
        row.textContent = account.label;
        row.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          selectedAccountToken = account.token;
          documentPanelStep = 2;
          renderDocumentPanel();
        }, true);
        list.appendChild(row);
      }
      return;
    }

    const choices = appendText(body, 'div', 'choices', '');
    const latest = document.createElement('button');
    latest.className = documentPanelMode === 'latest' ? 'choice selected' : 'choice';
    latest.type = 'button';
    latest.textContent = 'Latest statement';
    latest.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      documentPanelMode = 'latest';
      renderDocumentPanel();
    }, true);
    choices.appendChild(latest);

    const past = document.createElement('button');
    past.className = documentPanelMode === 'past' ? 'choice selected' : 'choice';
    past.type = 'button';
    past.textContent = 'Past statements';
    past.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      documentPanelMode = 'past';
      renderDocumentPanel();
    }, true);
    choices.appendChild(past);

    if (documentPanelMode === 'past') {
      const fields = appendText(body, 'div', 'past-fields', '');
      const yearSelect = document.createElement('select');
      for (const year of documentFetchConfig.years) {
        const option = document.createElement('option');
        option.value = String(year);
        option.textContent = String(year);
        if (year === selectedYear)
          option.selected = true;
        yearSelect.appendChild(option);
      }
      yearSelect.addEventListener('change', () => selectedYear = Number(yearSelect.value));
      fields.appendChild(yearSelect);

      const monthSelect = document.createElement('select');
      for (const month of documentFetchConfig.months) {
        const option = document.createElement('option');
        option.value = String(month);
        option.textContent = monthLabel(month);
        if (month === selectedMonth)
          option.selected = true;
        monthSelect.appendChild(option);
      }
      monthSelect.addEventListener('change', () => selectedMonth = Number(monthSelect.value));
      fields.appendChild(monthSelect);
    }

    const fetch = document.createElement('button');
    fetch.className = 'fetch';
    fetch.type = 'button';
    fetch.textContent = documentPanelMode === 'past' ? 'Fetch past statements' : 'Fetch latest statement';
    fetch.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.isTrusted)
        return;
      dispatchDocumentFetch();
    }, true);
    documentPanel.appendChild(fetch);
  };

  const maybeBuildDocumentPanel = () => {
    documentFetchConfig = readDocumentFetchConfig();
    if (!documentFetchConfig)
      return;
    const matchingAccount = documentFetchConfig.accounts.find(account => account.token === documentFetchConfig.currentAccountToken);
    selectedAccountToken = (matchingAccount || documentFetchConfig.accounts[0]).token;
    selectedYear = documentFetchConfig.years[0];
    selectedMonth = documentFetchConfig.months[0];
    documentPanel = document.createElement('div');
    documentPanel.className = 'document-panel';
    renderDocumentPanel();
    root.appendChild(documentPanel);
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
    const stopLabel = document.createElement('span');
    stopLabel.textContent = 'Hold to stop';
    stop.appendChild(stopLabel);
    stop.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      startStopHold(stop);
    }, true);
    stop.addEventListener('pointerup', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!stopHoldCompleted)
        cancelStopHold(stop);
    }, true);
    stop.addEventListener('pointercancel', event => {
      event.preventDefault();
      event.stopPropagation();
      cancelStopHold(stop);
    }, true);
    stop.addEventListener('pointerleave', event => {
      event.preventDefault();
      event.stopPropagation();
      cancelStopHold(stop);
    }, true);
    stop.addEventListener('keydown', event => {
      if (event.key !== ' ' && event.key !== 'Enter')
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!stopHoldTimer && !stopHoldCompleted)
        startStopHold(stop);
    }, true);
    stop.addEventListener('keyup', event => {
      if (event.key !== ' ' && event.key !== 'Enter')
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!stopHoldCompleted)
        cancelStopHold(stop);
    }, true);
    stop.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    root.appendChild(stop);

    maybeBuildDocumentPanel();

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
