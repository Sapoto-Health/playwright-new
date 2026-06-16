# PRD: Chromium Action Cursor

## Problem Statement

Sapoto agent runs are intended to be watched in headed Chromium. Today, Playwright can perform mouse and pointer actions, but a human watching the browser does not get a clear, natural visual signal of where the automation is moving or clicking. Existing screencast action annotations prove that Playwright already has useful injected overlay primitives, but the product surface is tied to screencast/video concepts instead of live headed automation.

The result is that Sapoto agent runs can look abrupt: clicks appear to happen without an observable cursor path, and observers have less confidence about what the agent is doing.

## Solution

Add a Sapoto-maintained `actionCursor` feature to the Playwright fork.

The feature is Chromium-only in v1, headed-only, opt-in, and focused on pointer actions. When enabled, Playwright renders a synthetic cursor in the live page. The cursor moves smoothly and deterministically between action points, shows a subtle click/tap effect for pointer activation, and does not delay or alter the underlying Playwright action semantics.

The public surface should support both global defaults and local control:

- A browser context option so all pages/popups in a headed Chromium context inherit the behavior.
- A Playwright Test `use` option that maps to the context option.
- Page-level APIs to show or hide the action cursor for a single page.

The implementation should introduce a first-class Action Cursor manager instead of extending the screencast API as the product boundary. The manager may reuse existing injected cursor and highlight primitives where they fit.

## User Stories

1. As a Sapoto operator, I want to see a cursor move around the browser during an agent run, so that I can understand what the agent is doing.
2. As a Sapoto operator, I want clicks to be visually indicated, so that I can tell exactly where the agent clicked.
3. As a Sapoto operator, I want cursor movement to feel smooth and natural, so that agent runs are easier to follow.
4. As a Sapoto operator, I want cursor animation to be deterministic, so that repeated runs are understandable and not visually erratic.
5. As a Sapoto operator, I want the cursor UX to work in headed Chromium, so that it matches Sapoto's agent runtime.
6. As a Sapoto operator, I want the action cursor to apply across pages and popups in the run, so that the UX does not disappear during navigation-heavy workflows.
7. As a Playwright script author, I want to enable the action cursor at the context level, so that every page in my context has the same watchable behavior.
8. As a Playwright script author, I want to enable or disable the action cursor on a single page, so that I can use it only for selected demos or debugging sessions.
9. As a Playwright Test author, I want to enable the action cursor from `use` configuration, so that every headed Chromium test can show the cursor without per-test setup.
10. As a Playwright Test author, I want the feature disabled by default, so that existing tests do not change behavior or visuals.
11. As a Playwright Test author, I want headless mode to remain unaffected, so that CI behavior does not change unexpectedly.
12. As a Playwright maintainer, I want a first-class feature boundary, so that live cursor UX is not coupled to screencast naming.
13. As a Playwright maintainer, I want the implementation to reuse proven injected overlay primitives, so that we avoid duplicating fragile page-overlay code.
14. As a Playwright maintainer, I want real pointer actions to execute immediately, so that the action cursor does not change Playwright timing semantics.
15. As a Playwright maintainer, I want screenshot assertions to avoid cursor overlays by default, so that visual tests remain stable.
16. As a demo author, I want videos and screencasts to include the cursor where appropriate, so that recorded agent runs remain easy to follow.
17. As a Sapoto developer, I want v1 scoped to Chromium only, so that the feature can ship for the actual agent runtime without cross-browser delays.
18. As a Sapoto developer, I want the action cursor to work across navigations, so that normal app flows do not require re-enabling the feature.
19. As a Sapoto developer, I want iframe targets to show one cursor in the top-level visual coordinate system, so that observers do not see multiple cursors or clipped frame-local cursors.
20. As a Sapoto developer, I want the default click effect to be subtle, so that it is visible without obscuring application UI.
21. As a Sapoto developer, I want simple boolean configuration for the common path, so that Sapoto can enable the feature with minimal setup.
22. As an advanced user, I want an options object for animation tuning, so that duration and click effects can be adjusted without API churn.
23. As a maintainer, I want tests around the public API and screenshot behavior, so that future changes do not regress the feature.
24. As a maintainer, I want a manual headed demo path, so that reviewers can judge whether the cursor feels natural enough.
25. As a maintainer, I want this clearly marked as a Sapoto fork feature, so that Chromium-only scope is not confused with upstream Playwright compatibility.

## Implementation Decisions

- The feature name is `actionCursor`.
- V1 is a Sapoto-maintained fork feature, not an upstream-ready Playwright feature.
- V1 supports Chromium only.
- V1 is headed-only and opt-in.
- The default value is disabled.
- `actionCursor: true` enables default behavior.
- `actionCursor: { ... }` enables behavior with options.
- The initial options object should remain small:
  - Movement duration tuning.
  - Click/tap effect toggle.
- The feature covers pointer actions only.
- Keyboard, fill, select, upload, screenshot, and non-pointer narration are out of v1 scope.
- The real Playwright action must not wait for cursor animation by default.
- Cursor movement should be deterministic and eased.
- Cursor duration should scale by movement distance with min/max caps.
- The synthetic cursor should move to the final action point for `page.mouse.move(..., { steps })`; the underlying mouse behavior still preserves Playwright's existing step semantics.
- The click/tap effect should render at pointer activation points.
- No action labels are shown by default.
- The overlay should be rendered in the page via injected overlay primitives.
- Iframe actions should render the cursor from the top-level page overlay using top-level viewport coordinates.
- The action cursor should survive navigations by reinstalling or reinitializing the overlay as needed.
- Context-level configuration applies to new pages and popups in that context.
- Page-level API affects only that page.
- Page-level API can override the context default for a page.
- The feature should hide around screenshots by default to avoid polluting visual assertions.
- Videos and screencasts may include the cursor because they are watchability artifacts.
- The implementation should introduce an Action Cursor manager as the product boundary.
- The Action Cursor manager should listen to Playwright input instrumentation and drive overlay rendering.
- Existing screencast action code can be reused or refactored only where it naturally shares overlay primitives.
- The screencast API should not remain the user-facing product boundary for live cursor UX.
- Generated protocol, validator, type, and documentation artifacts must be updated through the repo's normal generation flow.

## Testing Decisions

- Tests should assert externally observable behavior and public contracts, not private implementation details.
- API tests should verify that the context option enables action cursor behavior for pages and popups.
- API tests should verify that page-level show/hide controls affect only the target page.
- Configuration tests should verify that Playwright Test `use.actionCursor` maps to the context behavior.
- Screenshot tests should verify that the cursor overlay is absent from screenshots by default.
- Pointer behavior tests should cover mouse move/click and locator click.
- Navigation tests should verify that enabling survives reloads or navigations.
- Chromium is the required test target for v1.
- WebKit and Firefox are out of scope for required test coverage.
- A manual headed demo should exist or be documented so a reviewer can watch cursor movement and click effects.
- The manual demo should exercise several pointer targets at different distances to validate distance-scaled animation.
- The automated tests should avoid relying on exact animation timing or pixel-perfect cursor position during transitions.
- Existing Playwright library/page tests are the closest prior art for pointer actions and context/page behavior.
- Existing screenshot tests are the closest prior art for ensuring visual output is not polluted.
- Existing generated type and protocol checks must pass as part of the repo's normal `flint` gate.

## Out of Scope

- Sapoto integration in `automatic-document-fetcher`.
- Enabling the feature by default for Sapoto agent runs.
- WebKit support.
- Firefox support.
- Headless rendering guarantees.
- Randomized or human-simulation cursor paths.
- Waiting for cursor animation before executing real Playwright actions.
- Keyboard/fill/select narration.
- Action text labels.
- Full visual regression coverage for cursor animation.
- Upstream Playwright contribution readiness.
- Browser chrome or OS-level cursor overlays.

## Further Notes

The product goal is watchability, not stealth. The cursor should make automation easier for humans to follow without changing Playwright's action timing or reliability guarantees.

The likely implementation shape is a page-owned Action Cursor manager that uses the existing input instrumentation stream and shared injected overlay primitives. The manager should provide the stable feature boundary, while lower-level overlay code can remain implementation detail.

The next step after this PRD is an implementation plan that maps the conceptual modules to concrete files, generation steps, tests, and a Chromium headed demo.
