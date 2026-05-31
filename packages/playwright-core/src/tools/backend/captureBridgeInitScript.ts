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
 * Sapoto Tracer #1154 (Unit I) — Capture-bridge init script.
 *
 * Three sections run inside every new document (main world) before any page
 * script via `BrowserContext.addInitScript`. The legacy Red-tier JS stealth
 * patches (C1 navigator.webdriver, C2 Function.prototype.toString masking +
 * chrome.{app,csi,loadTimes} stubs + Notification.permission clamp) were
 * dropped per PRD #1154 — ADF's chromeManager owns webdriver suppression at
 * launch and the JS-level stubs were a detectable attack surface.
 *
 * What remains:
 *
 *   C3 — Deferred window.print() + Path D srcdoc-iframe bridge.
 *        Synchronous page-script window.print() calls would otherwise raise a
 *        blocking native print dialog before the embedder's real override is
 *        installed. The deferred handler waits up to 2 s for the real override
 *        to land; if none arrives AND we're inside an iframe (Electron preload
 *        runs only on the top frame), walk up to 8 parent windows looking for
 *        `window.electronAPI.requestPrintCapture` and route a scope='iframe'
 *        payload there with a precise (CSS-escaped) frameSelector. Otherwise
 *        the call is silently suppressed (better than a blocking dialog).
 *
 *   C4 — Synchronous console-marker fast path for Chrome mode.
 *        Emits `[Print Capture]` markers synchronously on print events (no
 *        setTimeout deferral, unlike C3's eventual-routing semantics). When
 *        `chrome.printing.*` is detectable, also emits a `chrome.printing
 *        path detected` probe marker — no listener is registered, since
 *        attaching to `chrome.printing.onJobStatusChanged` would itself be
 *        an extension-detection fingerprint.
 *
 *        The actual Chrome-side print interception lives in ADF's downstream
 *        capture stack; this section is the console-marker pre-cursor that
 *        ADF's bridge listens for. The "fast-path" is "synchronous dispatch",
 *        not "chrome.printing.submitJob".
 *
 *   C5 — window.open focus-steal shim.
 *        Page-level window.open(url, '_blank') routes through Chromium's
 *        Browser::AddNewContents → NativeWidgetMac::Activate →
 *        [NSApp activateIgnoringOtherApps:YES], stealing focus from the user's
 *        frontmost app on macOS. The shim re-routes download-y URLs through a
 *        background-open marker that ADF's main process catches via
 *        Runtime.consoleAPICalled and uses to spawn a hidden CDP target.
 *
 * THIRD-PARTY-FRAME GUARD: in frames where neither document.head nor
 * document.documentElement exists yet (Akamai bmak, Clicktale, OneTrust,
 * Fidelity dmt analytics), naive appendChild calls throw at document_start.
 * We (a) never touch documentElement here, (b) wrap each section in its own
 * try/catch so a failure in one (e.g. C5 install crashes on a hardened
 * sandbox) cannot abort the remaining sections.
 */

export type CaptureBridgeOptions = {
  /**
   * When true, install C3 (deferred print + Path D bridge), C4 (synchronous
   * print fast-path mirror), and C5 (window.open focus-steal shim). When
   * false, the IIFE is an empty no-op — installed but inert. ADF plumbs this
   * via `--capture-bridge` CLI flag.
   */
  captureBridge: boolean;
};

// ----------------------------------------------------------------------
// Wire-contract regexes (exported for unit tests).
// ----------------------------------------------------------------------
//
// DOWNLOAD_URL_RE matches PDF / spreadsheet / document URLs by extension on
// the URL string itself. C5 additionally constrains suppression to host-
// capturable schemes before using this regex.
//
// DOWNLOAD_PATH_RE matches portal-typical download endpoints by pathname
// segment (./download/, ./statement/, ./invoice/, etc.). Used as a fallback
// for URLs that don't carry the extension in the path (e.g. signed API
// endpoints that hand back PDF bytes via a `/api/inline/download/<id>`
// route).
//
// SELF_TARGET_RE matches the three legitimate self-navigating targets
// (_self / _parent / _top) plus the empty/undefined-string case that
// `window.open(url)` produces. _blank and any named target falls through to
// the download-y / native-passthrough branches below.

export const DOWNLOAD_URL_RE = /\.(pdf|xlsx?|csv|docx?|zip|tsv|ofx|qfx|qif|7z|rtf)(\?|#|$)/i;
export const DOWNLOAD_PATH_RE = /\/(download|statement|statements|export|invoice|invoices|receipt|receipts|PDFStatement|StatementPDF|getstmt|getStmt|stmt)(?:\/|\.|$)/i;
export const BACKGROUND_OPEN_SCHEME_RE = /^(?:https?:|blob:)/i;
export const SELF_TARGET_RE = /^(?:|undefined|_self|_parent|_top)$/i;

// ----------------------------------------------------------------------
// CSS-selector escape helpers (exported for unit tests).
// ----------------------------------------------------------------------
//
// The orchestrator-side regex (FRAME_SELECTOR_RE in printCaptureHandler.ts)
// accepts ids matching /^[A-Za-z][A-Za-z0-9_\-]*$/ and data-attribute values
// matching /^[A-Za-z0-9_\-:.]+$/ ONLY. If a value contains anything outside
// those character classes, the orchestrator drops the selector entirely and
// falls back to the broad iframe[srcdoc] match (bad for multi-srcdoc portals).
//
// safeId / safeDataValue return the input WHEN it is selector-safe, otherwise
// the empty string — letting the caller decide whether to embed an
// escaped-but-validated selector or skip altogether. The caller is
// responsible for the validation gate; these helpers only normalise the
// "what would the page have to look like for the orchestrator to accept it"
// question.

const SAFE_ID_RE = /^[A-Za-z][A-Za-z0-9_\-]*$/;
const SAFE_DATA_VALUE_RE = /^[A-Za-z0-9_\-:.]+$/;

/**
 * Return `id` unchanged if it's safe to interpolate as `[id="…"]` or
 * `iframe#…`; otherwise the empty string. Safe means: starts with a letter,
 * contains only `[A-Za-z0-9_-]`, no length cap (selectors above ~512 chars
 * would themselves fail to parse but the orchestrator's allowlist would
 * already reject them earlier).
 */
export function safeId(id: string): string {
  if (typeof id !== 'string' || id.length === 0)
    return '';
  return SAFE_ID_RE.test(id) ? id : '';
}

/**
 * Return `value` unchanged if it's safe to interpolate as `[data-x="…"]`;
 * otherwise the empty string. Safe means: only `[A-Za-z0-9_\-:.]` — no
 * quotes, no backslashes, no whitespace, no null bytes. Rejects unicode
 * (the orchestrator's regex is ASCII-only by design — random unicode in
 * a frame attribute is a strong heuristic for a hostile or accidental
 * injection vector).
 */
export function safeDataValue(value: string): string {
  if (typeof value !== 'string' || value.length === 0)
    return '';
  return SAFE_DATA_VALUE_RE.test(value) ? value : '';
}

/**
 * Build the operational init script source string for the given options.
 * Returned value is a self-invoking IIFE suitable for
 * `BrowserContext.addInitScript`.
 *
 * The ADF-side build step at scripts/prepare-mcp-assets.js greps the
 * compiled fork output for the `__SAPOTO_PATHD_BRIDGE_V1_STAMP__` literal.
 * If absent, the build fails — guarding against stale fork rebases that
 * would silently regress iframe print capture.
 *
 * Wire contract — these literals MUST appear verbatim in the emitted
 * source. The orchestrator side keys off them and renaming any of them
 * silently breaks the capture bridge:
 *
 *   - `[FocusShim]`                    — C5 console marker prefix
 *   - `[DeferredPrint]`                — C3 console marker prefix
 *   - `[Print Capture]`                — C4 console marker prefix
 *   - `__SAPOTO_PATHD_BRIDGE_V1_STAMP__` — build-step grep target
 *   - `__sapoto_bg=V1:`                — URL marker for background targets
 *
 * The regression test `captureBridgeWireContract.spec.ts` asserts each
 * substring appears in the generated IIFE; bump it deliberately if you
 * intentionally rename anything here.
 */
export function buildCaptureBridgeInitScript(options: CaptureBridgeOptions): string {
  const captureBridge = !!options.captureBridge;

  // Inert form — addInitScript still installs it but it's a no-op IIFE so
  // page-detectable behaviour is identical to no script at all.
  if (!captureBridge)
    return `(() => { /* capture-bridge disabled */ })();`;

  return `(() => {
  // Path D backward-compat detection stamp. The ADF build step greps the
  // compiled fork output for this exact literal — do NOT rename without
  // coordinating with scripts/prepare-mcp-assets.js. No window pollution:
  // a bare void expression keeps the literal in the compiled bundle without
  // leaking onto a global.
  void '__SAPOTO_PATHD_BRIDGE_V1_STAMP__';

  // Helper — redact query string + hash from URL before logging / shipping.
  // window.location.href can carry session tokens in the query string; ADF's
  // redaction rules require source-side sanitisation for agent I/O.
  const sanitizeUrl = function(href) {
    if (typeof href !== 'string') return String(href);
    if (!href) return href;
    try {
      const u = new URL(href, location.href);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch (_) {
      const cut = href.search(/[?#]/);
      return cut === -1 ? href : href.slice(0, cut);
    }
  };

  // CSS-selector validation regexes mirrored from the orchestrator's
  // printCaptureHandler.ts. Anything outside these character classes drops
  // the selector and forces the iframe[srcdoc] fallback.
  const SAFE_ID = /^[A-Za-z][A-Za-z0-9_\\-]*$/;
  const SAFE_DATA_VALUE = /^[A-Za-z0-9_\\-:.]+$/;

  const _buildFrameSelector = function() {
    try {
      const el = window.frameElement;
      if (!el) return null;
      if (el.id && SAFE_ID.test(el.id))
        return 'iframe#' + el.id;
      const dataPrintId = el.getAttribute && el.getAttribute('data-print-id');
      if (dataPrintId && SAFE_DATA_VALUE.test(dataPrintId))
        return 'iframe[data-print-id="' + dataPrintId + '"]';
      return null;
    } catch (_) {
      // Cross-origin frameElement read — fall back to null.
      return null;
    }
  };

  // ============================================================
  // C3 — Deferred window.print() + Path D srcdoc-iframe bridge
  // ============================================================
  try {
    const DEFERRED_TIMEOUT_MS = 2000;
    const deferred = function() {
      try { console.debug('[DeferredPrint] window.print() called — deferring for ' + DEFERRED_TIMEOUT_MS + 'ms at ' + sanitizeUrl(window.location.href)); } catch (_) {}
      setTimeout(() => {
        // Walk up to 8 parents looking for electronAPI, then send a
        // scope='top-frame'|'iframe' bridge call. Decoupled from any
        // "delegate to new window.print()" check — C4 wraps us so the
        // identity check would otherwise infinitely re-enter via C4.
        try { console.debug('[DeferredPrint] no-electronAPI on this frame — walking parents at ' + sanitizeUrl(window.location.href)); } catch (_) {}
        let w = window;
        for (let hops = 0; hops < 8 && w; hops += 1) {
          try {
            const api = (w).electronAPI;
            if (api && typeof api.requestPrintCapture === 'function') {
              const frameSelector = _buildFrameSelector();
              try { console.debug('[DeferredPrint] iframe-parent-walk found bridge at depth=' + hops + ' selector=' + (frameSelector || 'null')); } catch (_) {}
              api.requestPrintCapture({
                url: sanitizeUrl(window.location.href),
                title: document.title,
                timestamp: Date.now(),
                scope: window === window.top ? 'top-frame' : 'iframe',
                frameSelector,
              });
              return;
            }
          } catch (_) {
            // Cross-origin access on w.electronAPI threw — stop the walk.
            break;
          }
          // w === w.parent at the top frame. Comparison itself can throw
          // cross-origin in some engines, so wrap it.
          try {
            if (w === w.parent) break;
            w = w.parent;
          } catch (_) {
            break;
          }
        }
        try { console.debug('[DeferredPrint] bridge unreachable at ' + sanitizeUrl(window.location.href)); } catch (_) {}
      }, DEFERRED_TIMEOUT_MS);
    };
    window.print = deferred;
  } catch (_) { /* C3 install threw — leave window.print untouched */ }

  // ============================================================
  // C4 — Synchronous print fast-path mirror (Chrome mode)
  // ============================================================
  // After C3 sets up the deferred-print path, attach a synchronous handler
  // that mirrors print events through the same bridge but via the
  // synchronous Chrome path. C3 is the canonical handler — its 2s deferral
  // is the right behaviour for Electron-mode runners that wait for the
  // embedder override. C4 is for Chrome-mode runners (Layer 4 in the
  // capture stack) that scrape Runtime.consoleAPICalled and need a
  // SYNCHRONOUS marker on every print event — the 2s deferral would miss
  // a navigate-away race.
  //
  // To avoid the recursion trap (C4 wrapping C3 → after 2s C3 calls
  // window.print() → re-enters C4 → infinite loop), C4 takes over
  // window.print outright and emits the bridge call synchronously. C3's
  // deferred handler is left referenced via _c3Deferred so a
  // no-electronAPI page still gets the deferred-print suppression
  // behaviour via the same codepath.
  try {
    const _c3Deferred = window.print;
    let _lastPrintTime = 0;
    const _emitPrintMarker = function() {
      try { console.debug('[Print Capture] window.print() intercepted at ' + sanitizeUrl(window.location.href)); } catch (_) {}
      let w = window;
      for (let hops = 0; hops < 8 && w; hops += 1) {
        try {
          const api = (w).electronAPI;
          if (api && typeof api.requestPrintCapture === 'function') {
            const frameSelector = _buildFrameSelector();
            try { console.debug('[Print Capture] dispatch depth=' + hops + ' selector=' + (frameSelector || 'null')); } catch (_) {}
            api.requestPrintCapture({
              url: sanitizeUrl(window.location.href),
              title: document.title,
              timestamp: Date.now(),
              scope: window === window.top ? 'top-frame' : 'iframe',
              frameSelector,
            });
            return true;
          }
        } catch (_) {
          return false;
        }
        try {
          if (w === w.parent) break;
          w = w.parent;
        } catch (_) {
          break;
        }
      }
      return false;
    };

    // Probe the chrome.printing path. Presence is informational only — we
    // intentionally do NOT register an onJobStatusChanged listener because
    // that would fingerprint us as an extension. The probe lives here as a
    // marker for runtime introspection during debugging.
    try {
      const chromeApi = (window).chrome;
      if (chromeApi && chromeApi.printing && typeof chromeApi.printing.onJobStatusChanged === 'object') {
        try { console.debug('[Print Capture] chrome.printing path detected'); } catch (_) {}
      }
    } catch (_) { /* chrome.* absent — stock page */ }

    window.print = function print() {
      const _now = Date.now();
      // 1s dedup window — repeated print() calls within 1s collapse to one
      // bridge dispatch.
      if (_now - _lastPrintTime < 1000) return;
      _lastPrintTime = _now;
      // Synchronous bridge dispatch (C4).
      let dispatched = false;
      try { dispatched = _emitPrintMarker(); } catch (_) { /* swallow */ }
      // If C4 couldn't find electronAPI on this frame, fall back to C3's
      // deferred path — it does the 2s wait + parent-walk + iframe-fallback.
      if (!dispatched) {
        try {
          if (typeof _c3Deferred === 'function')
            _c3Deferred.call(window);
        } catch (_) { /* swallow */ }
      }
    };
  } catch (_) { /* C4 install threw — leave the C3 path alone */ }

  // ============================================================
  // C5 — window.open focus-steal shim
  // ============================================================
  // Page-level window.open(url, '_blank') (or any non-_self target) routes
  // through Chromium's Browser::AddNewContents → NativeWidgetMac::Activate →
  // [NSApp activateIgnoringOtherApps:YES], stealing focus from the user's
  // frontmost app on macOS. We re-route download-y URLs through a
  // background-open marker that ADF's main process catches via
  // Runtime.consoleAPICalled.
  try {
    try { console.debug('[FocusShim] C5 entry at ' + sanitizeUrl(location.href) + ' (top=' + (window === window.top) + ')'); } catch (_) {}

    // Regexes are also exported from this module for unit tests — duplicated
    // here as page-local literals because the IIFE can't import from the
    // host.
    const DOWNLOAD_URL_RE = /\\.(pdf|xlsx?|csv|docx?|zip|tsv|ofx|qfx|qif|7z|rtf)(\\?|#|$)/i;
    const DOWNLOAD_PATH_RE = /\\/(download|statement|statements|export|invoice|invoices|receipt|receipts|PDFStatement|StatementPDF|getstmt|getStmt|stmt)(?:\\/|\\.|$)/i;
    const BACKGROUND_OPEN_SCHEME_RE = /^(?:https?:|blob:)/i;
    const SELF_TARGET_RE = /^(?:|undefined|_self|_parent|_top)$/i;

    const _urlLooksLikeDownload = function(href) {
      if (!href) return false;
      try {
        const u = new URL(href, location.href);
        if (!BACKGROUND_OPEN_SCHEME_RE.test(u.protocol)) return false;
        if (u.protocol === 'blob:') return true;
        if (DOWNLOAD_URL_RE.test(u.href)) return true;
        if (DOWNLOAD_PATH_RE.test(u.pathname)) return true;
      } catch (_) { /* unparseable — give up */ }
      return false;
    };

    // Forward to the print capture bridge with the background-target marker
    // suffix. The marker token is the load-bearing wire contract: the
    // orchestrator's backgroundOpenBridge listener (backgroundOpenBridge.ts)
    // scrapes Runtime.consoleAPICalled for the [FocusShim] background-open
    // prefix and uses the URL fragment containing __sapoto_bg=V1: to suppress
    // the new tab from agent-visible browser_tabs listings.
    //
    // SECURITY LIMITATION: a hostile page running JS in the agent's session can
    // \`window.open('about:blank#__sapoto_bg=V1:<arbitrary>', '_blank')\` to hide
    // itself from \`browser_tabs\`. Accepted in this PRD; tracking issue filed for
    // HMAC / target-ID registry replacement.
    const _emitBackgroundOpen = function(href) {
      try { console.debug('[FocusShim] background-open ' + href); } catch (_) {}
      try {
        const api = (window).electronAPI;
        if (api && typeof api.requestPrintCapture === 'function') {
          // The "__sapoto_bg=V1:" token is the URL-fragment marker the
          // orchestrator's _onPageCreated tab filter scans for. The exact
          // token MUST appear in the emitted IIFE source — the regression
          // test in captureBridgeWireContract.spec.ts pins it.
          api.requestPrintCapture({
            url: href,
            backgroundMarker: '__sapoto_bg=V1:' + Date.now(),
            title: document.title || 'background open',
            timestamp: Date.now(),
            scope: 'background-open',
            frameSelector: null,
          });
        }
      } catch (_) { /* swallow — the console marker is the primary signal */ }
    };

    // Build the wrapper. Capture the original via getOwnPropertyDescriptor
    // because Chromium ships window.open as an accessor in some builds.
    const _origDesc = Object.getOwnPropertyDescriptor(window, 'open');
    const _nativeOpen = (function() {
      if (_origDesc && typeof _origDesc.value === 'function')
        return _origDesc.value.bind(window);
      return window.open.bind(window);
    })();

    const _shimOpen = function open(url, target, features) {
      const u = (url == null ? '' : String(url));
      const t = (target == null ? '' : String(target));

      try { console.debug('[FocusShim] window.open called url=' + (u ? sanitizeUrl(u) : '(empty)') + ' target=' + (t || '(empty)')); } catch (_) {}

      // _self / _parent / _top / empty — never steal focus, native passthrough.
      if (SELF_TARGET_RE.test(t)) {
        if (!u) {
          // Empty URL + _blank case is intentionally distinct (synthesized
          // popup, see PRD test plan). When the URL is empty and the target
          // is _self / _parent / _top, native open is also empty.
          try { console.debug('[FocusShim] → native (empty URL, self target=' + t + ')'); } catch (_) {}
        }
        return _nativeOpen(url, target, features);
      }

      // Download-y/blob URL → emit background-open marker and return null.
      // This C5 branch exists only in the captureBridge=true IIFE, so the
      // host-side console marker path is intentionally active even when the
      // Electron preload bridge is absent (Chrome-direct automation).
      if (u && _urlLooksLikeDownload(u)) {
        let absoluteUrl = u;
        try {
          absoluteUrl = new URL(u, location.href).href;
        } catch (_) {
          try { console.debug('[FocusShim] → native (invalid URL)'); } catch (_) {}
          return _nativeOpen(url, target, features);
        }
        _emitBackgroundOpen(absoluteUrl);
        return null;
      }

      // Other URLs — native. Focus steals but this is rare in portal
      // automation.
      try { console.debug('[FocusShim] → native (URL did not match download heuristic)'); } catch (_) {}
      return _nativeOpen(url, target, features);
    };

    // Matches stock Chrome's Object.getOwnPropertyDescriptor(window, 'open').
    // Verified empirically — do NOT change without an empirical re-check.
    // Stock Chrome reports { writable: true, enumerable: true, configurable: true };
    // any deviation (e.g. writable:false) would fingerprint the shim via a simple
    // descriptor probe (PRD user-story #17 / #29). The trade-off: a hostile page
    // CAN reassign window.open and disable us — accepted, because the
    // alternative (writable:false) is itself a stronger fingerprint.
    try {
      Object.defineProperty(window, 'open', {
        value: _shimOpen,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch (_) {
      // Fallback: plain assignment. Some hardened browsers may reject
      // defineProperty on built-ins; accept the override risk.
      try { console.debug('[FocusShim] defineProperty failed, falling back to assignment'); } catch (_) {}
      try { (window).open = _shimOpen; } catch (_) { /* really stuck */ }
    }
  } catch (e) {
    // Diagnostic-only catch. C3 / C4 already ran outside this try.
    try {
      const msg = (e && e.message) ? String(e.message) : String(e);
      try { console.debug('[FocusShim] install crashed: ' + msg + ' | at ' + sanitizeUrl(location.href)); } catch (_) {}
    } catch (_) { /* logger itself threw — give up silently */ }
  }
})();`;
}

/**
 * URL-fragment marker token that the orchestrator-side _onPageCreated tab
 * filter scans for. Pages whose URL hash contains this substring (e.g.
 * `about:blank#__sapoto_bg=V1:1234567890`) are background-target capture
 * tabs and MUST be excluded from agent-visible `browser_tabs` responses.
 *
 * Exported so the wiring code (context.ts) and tests share one source of
 * truth without depending on a literal string scattered across files.
 */
export const BACKGROUND_TARGET_URL_MARKER = '__sapoto_bg=V1:';

/**
 * True iff the URL is a background-target capture marker that should be
 * hidden from agent-visible tab listings.
 */
export function isBackgroundTargetUrl(url: string | undefined | null): boolean {
  if (typeof url !== 'string' || url.length === 0)
    return false;
  return url.includes(BACKGROUND_TARGET_URL_MARKER);
}
