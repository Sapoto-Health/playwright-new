# Stealth Redo Decisions

Tracking decisions made during the first-principles stealth redo that produced this fork (PRD #1150). The previous-generation fork (`Sapoto-Health/playwright` on `t9-update-docs`) accumulated ~35 commits ahead of `microsoft/playwright`, several of which were detection-grade fingerprints (Red-tier JS patches) or dead plumbing. This document captures the 9 decisions that shaped the port — what was dropped, what was kept, and why each verdict still holds.

Decisions are numbered for cross-reference from code review and future PRDs. The old fork used the same numbering for Decisions 1–9 (skipping 7); the numbering is preserved here for continuity.

---

## Decision 1: Drop `__chromeStealth` idempotency guard

**Status:** Applied (the named global never lands in the new fork).
**Old fork action:** Lines 152–153 of `stealthInitScript.ts` (`if (window.__chromeStealth) return; window.__chromeStealth = true;`).
**Reasoning:** Playwright's `addInitScript` already guarantees single-execution per new document. The guard protected against double-execution that doesn't happen in practice. The named enumerable global on `window` is trivially detectable by any anti-bot script (`'__chromeStealth' in window`).

For the new fork: the `captureBridgeInitScript` (Tracer #1156 / Unit I) **must not** install any named global as an idempotency guard. If a re-injection edge case ever surfaces, fix it via the init-script timing or per-document state — never via a window property.

---

## Decision 2: Drop `__stealthMarkNative` global

**Status:** Applied.
**Old fork action:** Remove `(window).__stealthMarkNative = _markNative;` and all reads of it. Use a shared closure variable instead of a window-keyed handshake.
**Reasoning:** Same class of problem as `__chromeStealth` — named, enumerable, string-keyed global on `window`, trivially detectable. The global handshake only existed because template-literal conditional compilation put C2 (`Function.prototype.toString` masking) and C4/C5 in separate `try` blocks. With C2 dropped (Decision 6) the handshake has no consumers anyway.

For the new fork: the `captureBridgeInitScript` builder uses a single IIFE with closure-scoped helpers. No cross-section handshakes go through `window`.

---

## Decision 3: Drop C1 (`navigator.webdriver` JS patch) and DO NOT re-add `AutomationControlled` in `chromiumSwitches.ts`

**Status:** Applied. The new fork does not patch `navigator.webdriver` and does not modify `chromiumSwitches.ts`.
**Old fork action:** Reverted `chromiumSwitches.ts` to upstream; removed the C1 navigator.webdriver getter patch from the init script.
**Reasoning:** ADF's `chromeManager/effects.ts` passes `--disable-features=AutomationControlled` at the actual Chrome spawn — that's the Green-tier way. The fork's JS-side getter patch was strictly worse: it replaced a native data property (`value: false`) with a JS getter (`get: fn`), creating a net-new fingerprint detectable via `Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get !== undefined`.

For the new fork: this stays out. ADF owns the launch flag; the fork does not redo it inside Playwright.

---

## Decision 4: Drop `chrome.app`, `chrome.csi`, `chrome.loadTimes` stubs

**Status:** Applied. The new fork ships no `chrome.*` stubs.
**Old fork action:** Removed the entire `chrome.app`, `chrome.csi()`, `chrome.loadTimes()` sub-sections of C2.
**Reasoning:** All three APIs are removed from real Chrome — `chrome.csi` and `chrome.loadTimes` in Chrome 117, `chrome.app` in Chrome 128. Target portals run Chrome 128+. The stubs *added back* APIs that real Chrome no longer has — `typeof chrome.csi === 'function'` returned `true` under Sapoto but `false` for real users. Per stealth principle #2 ("prefer fewer patches"), absence is the correct undetectable state.

For the new fork: the `captureBridgeInitScript` does NOT mention `chrome.*`. Any future request to stub a `chrome.*` API must first verify the API still exists in stock Chrome — if it doesn't, stubbing creates a fingerprint.

---

## Decision 5: Drop `Notification.permission` clamp from the fork

**Status:** Applied.
**Old fork action:** Removed the `Notification.permission` clamp; it lived alongside C2 sub-sections under the `chromeRuntimeStubs` gate (which was also removed since Decision 4 emptied its consumers).
**Reasoning:** ADF's own `chromeStealthStubs.ts` already handles this with a more complete implementation that also wraps `navigator.permissions.query` for cross-check consistency. The fork's simpler clamp was redundant and missed the cross-check vector. Sapoto owns the Chrome profile — permission state is ADF's responsibility, not the fork's.

For the new fork: stays out. ADF handles it externally.

---

## Decision 6: Drop C2 (`Function.prototype.toString` masking)

**Status:** Applied. The new fork does not patch `Function.prototype.toString`.
**Old fork action:** Removed the WeakMap-based `Function.prototype.toString` wrapper and the `_markNative` helper.
**Reasoning:** The `toString` patch is itself a known anti-bot detection target — the signature technique of `puppeteer-extra-plugin-stealth`. Anti-bot stacks (Castle, DataDome, Akamai) actively look for it via cross-realm bypass, timing side-channels, and function identity checks. With Decisions 3–5 removing the patches that needed masking (`navigator.webdriver`, `chrome.app/csi/loadTimes`, `Notification.permission`), the only remaining `toString` consumers in the new fork's capture-bridge init script are C4 (`window.print`) and C5 (`window.open`) — both operational shims used only on ADF's print flow. No anti-bot stack inspects those two functions for `toString` fidelity. The cure (a high-profile detection target) is worse than the disease (source visible on two functions that nobody probes).

For the new fork: if any future stealth feature *would* require `toString` masking to be undetectable, the right move is to drop the feature, not add the masking.

---

## Decision 7 (intentionally skipped)

The old fork's numbering jumped from 6 to 8. Preserved here for cross-reference continuity.

---

## Decision 8: Skip UA-CH brand override on `connectOverCDP`

**Status:** Applied. The new fork has no `chromeUaBrands.ts` and no `_updateUserAgentBrands` method.
**Old fork action:** Gated `_updateUserAgentBrands()` so it didn't fire when connected via CDP to an externally-launched Chrome. The follow-through, applied in this fork, is to drop the override entirely.
**Reasoning:** Real Chrome's native UA-CH brands are already correct and internally consistent. The `buildChromeBrands()` override replaced Chrome 136's correct GREASE rotation with a hardcoded value from Chrome 113–115, introducing inconsistency where none existed. The override was theoretically necessary for the `launch()` path where Playwright's bundled Chromium might have missing/mismatched UA-CH metadata, but Sapoto's only production flow is `connectOverCDP` against real Chrome. Per stealth principle #1 ("prefer native state over JS patching"), there's nothing to fix.

For the new fork: no UA-CH override code exists. If a future portal requires a specific UA-CH brand, the right place is ADF's `chromeManager` (which already owns the Chrome version and locale).

---

## Decision 9: Do not carry the list reporter `printFailuresInline` removal

**Status:** Applied. The new fork keeps upstream's list-reporter behavior.
**Old fork action:** Reverted the `printFailuresInline` option removal from `packages/playwright/src/reporters/list.ts`, `packages/playwright/types/test.d.ts`, `utils/generate_types/overrides-test.d.ts`, and `docs/src/test-reporters-js.md`.
**Reasoning:** The old fork's removal was unrelated to stealth — it was a cosmetic reporter change that accumulated into the fork without justification. Carrying it forward increases rebase drift against upstream for zero ADF benefit. New fork stays aligned with upstream on reporters.

For the new fork: any future reporter change must be justified by a concrete ADF need that cannot be met by configuring `@playwright/test`'s public reporter API.

---

## How these decisions inform new-fork code review

Every PORT unit in PRD #1150 implicitly inherits these verdicts. When reviewing a change in the fork, check:

- **Adding a window property as state?** → Decision 1 / 2. Use closure or per-document state instead.
- **Patching `navigator.*` or `chrome.*` in JS?** → Decision 3 / 4. The Green-tier path is a Chrome launch flag or a stock-Chrome-absence; if those don't apply, escalate.
- **Patching `Function.prototype.toString`?** → Decision 6. Drop the feature that needs masking.
- **Overriding UA-CH or other correlated metadata?** → Decision 8. The `connectOverCDP` path inherits real Chrome's native state; don't replace it.
- **Reverting an unrelated upstream change?** → Decision 9. Stay aligned with upstream where Sapoto has no specific reason to diverge.

Decisions 1–9 are kept stable across the fork's life. If a future PRD wants to overturn one of them, it must explicitly cite the decision number and document the new evidence.
