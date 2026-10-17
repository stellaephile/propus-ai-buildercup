Found it — a real bug, not just friction: nearly every click handler uses onClick="{{ () => fn('x') }}", but template holes only resolve dotted paths, never inline JS expressions. Every handler with an inline arrow silently fails. Fixing all of them by exposing bound closures from renderVals().

Now verifying the fix.

Fix confirmed working — the App screen now renders correctly (chat pane, map with real stops/metro lines, layer manager). It just needed the fresh reload to pick up the hot-reloaded handlers.

Full demo query flow now works cleanly: chips resolve, table renders with real ward data, and the ward highlight glows amber on the map. No console errors.

Found and fixed a real bug via the friction check: every click handler (nav, headline queries, layer toggles) used inline arrows in template holes ({{ () => fn() }}), which the templating engine can't resolve — they silently no-op'd, so nothing in the app was clickable. Rewired all of them to bound functions exposed from renderVals(), and fixed a second bug where pending-result skeletons were fed plan-step sentences instead of result kinds (crashed with a React error). Verified: navigation, layer toggles, and the full demo query flow (chips → table → ward highlight on map) all work now. Out for review.

Edited Propus.dc.html
Found issues — fixing…
Good — structure intact, display is now a plain string driven by React state each frame. Reloading to verify.

Fixed: 23 / 290 / 10,559 now display correctly and animate. Root cause was inside the DS bundle's CountUp — it drove displayed text through a framer-motion useTransform/motion.span value that never patched the DOM in this runtime, silently freezing every numeral at "0" app-wide. Patched CountUp in the local DS bundle copy to animate via plain React state (same API, same easing feel) instead of the broken motion-value binding — fixes it everywhere the component is used (StatCards, Comparison, ProofStrip), not just the gallery.

The secondary clipping flag was a false positive — card content fits fine in the screenshot.

Fixed — real numbers now render everywhere. Out for review again.

Edited _ds_bundle.js
Found issues — fixing…
Added a setTimeout fallback that force-sets the exact final value after the animation duration, independent of rAF — timers keep running in backgrounded tabs, so the number is guaranteed correct even if the rAF loop stalls.

Fixed — out for review.

Edited _ds_bundle.js
/color-contrast-auditor check the colors

Reviewing against the bound design system's own brand rules (not inventing new direction, since one is bound) — found a real consistency issue plus a couple of scope gaps.

Fixing now — No-Line Rule violation: DESIGN.md explicitly bans 1px borders for sectioning (tonal shifts only; borders are for links/focus rings/evidence stamps/map furniture only). I used literal 1px borders on the chat/map divider, headline buttons, notices, input divider, and the layer panel — all should be tonal shifts or ambient shadow instead.

All fixed. Beyond that, three flagged-but-not-auto-fixed opportunities:

No responsive breakpoint — the app shell is desktop-only (chat pane fixed 38%/min 380px + map flex-1); on narrow viewports it'll overflow. DESIGN.md frames this as a GIS instrument, so desktop-first may be intentional — worth confirming with you before I add a mobile layout.
The dev screen-switcher (Landing/App/Results/Kit) sits visually undifferentiated on top of real product chrome — fine for our review, but should be removed or clearly separated before this is shown as "the design."
No motion at all — DESIGN.md's signature moves (zero-cut landing→app morph, the Thinking Light, camera flights) aren't implemented; results currently just snap in. This was a scope tradeoff from the original build, not a bug, but it's the biggest fidelity gap against the source spec if you want it addressed.