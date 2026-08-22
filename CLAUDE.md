# Δv Stack — Launch Simulator

A vanilla HTML/CSS/JS browser game: a real-physics rocket launch simulator rendered with three.js.
No framework, no bundler, no build step. The browser loads `index.html` and runs the source as-is;
npm exists here only for Playwright and a static dev server, and none of it ships.

Distributed as an itch.io HTML5 game via `tools/pack-itch.ps1`.

---

## Working agreements

### Ask until you are 95% confident
Before writing code, keep asking clarifying questions until you are at least 95% confident you
understand what is wanted and how to do it. A wrong assumption costs far more than a question.
Ask about: ambiguous scope, which of several plausible behaviours is intended, where new code
should live, and anything that would be expensive to undo. Do not ask about things the codebase
already answers — read it first.

### Model per phase
| Phase | Model | Why |
|---|---|---|
| Planning, architecture, debugging something genuinely hard | **Opus** | The expensive thinking, done once |
| Implementation against an agreed plan | **Sonnet** | Most of the work; fast and cheap enough to iterate |
| Running and triaging the test suite | **Haiku** | Mechanical: run, read output, report |

Switch with `/model opus` / `/model sonnet` / `/model haiku`. Claude cannot switch its own model —
if a phase change is due, say so and let the user switch.

### Versioning
Bump `version` in `package.json` for any change that alters what a player sees or does. Pass the
same value to the packer: `npm run pack -- -Version 1.2.0`.

### Test governance
- Every behavioural change needs a test in `tests/`, tagged with the suite it belongs to.
- Never weaken an assertion to make a test pass. If a test is wrong, fix the test and say why in a
  comment; if the app is wrong, fix the app.
- Expectations must be measured, not assumed. `tests/flight.spec.js` documents which roster
  vehicles are suborbital and which escape because that was checked, not guessed.
- `legacy/rocket-sim.html` is the parity baseline. It is not dead weight: `tests/parity.spec.js`
  diffs against it. Do not delete or edit it.

---

## Layout

```
index.html            doctype/head/body, 11 <link>s, the import map, and js/main.js
css/                  one file per UI region, loaded in a cascade-sensitive order
js/                   ES modules; only main.js does anything at startup
vendor/three/         three.module.js r0.160.0, vendored so the itch build needs no network
tools/                packaging, dev server, and the wiring/import checkers
tests/                Playwright: @smoke, @parity, @flight, @pack
legacy/               the original single-file build, kept as the parity baseline
dist/                 build output (gitignored)
```

### CSS load order (do not reorder)
`base → tokens → layout → header → stage → panels → weather → criteria → hud → transport → overlay`

This is the source order of the original single `<style>` block, and the cascade depends on it:
`tokens.css` defines the custom properties everything else reads, and later component files
deliberately override earlier ones. `tests/parity.spec.js` asserts the `<link>` order matches this
list and that concatenating the files reproduces the original block byte for byte.

### Module map

| Module | Owns |
|---|---|
| `js/main.js` | **Entry point.** Imports every subsystem and calls their `init*()` in a fixed order, then `boot()` |
| `js/core/constants.js` | `G0`, `MU`, `R_PLANET`, `R_ATMOS`, `KARMAN_LINE_M`, `BODIES` (Moon/Mars) |
| `js/core/mission-config.js` | `destination`, `flightProfile` + their setters — the two pre-launch choices physics reads |
| `js/core/dom.js` | The DOM handles more than one module needs |
| `js/core/format.js` | `fmt`, `escapeHtml`, `formatMissionClock`, `formatDuration` |
| `js/data/rockets.js` | The stock roster and nose-cone drag coefficients |
| `js/data/handoff.js` | `rockets`, plus reading a custom vehicle out of the calculator's localStorage |
| `js/sim/weather.js` | The `weather` model, wind profile, and the launch-commit-criteria rules |
| `js/sim/physics.js` | `airDensity`, `deriveVehicle`, `makeSim`, `computeAccel`, `rk4Step`, pitch program |
| `js/sim/orbit.js` | Orbital elements, Kepler propagation, orbit capture |
| `js/sim/landing.js` | Suicide-burn ignition/throttle logic and touchdown resolution |
| `js/sim/transfer.js` | Patched-conic Earth→body coast, SOI handoff, and the per-body physics variants |
| `js/sim/step.js` | `simStep` — the phase state machine that drives all of the above |
| `js/scene/three-setup.js` | `scene`/`camera`/`renderer`/lights, sky, `initThree`, `spaceRoll` |
| `js/scene/textures.js` | Every procedural canvas texture (grass, terrain, cloud, hull, sprites) |
| `js/scene/world.js` | Curved world shell, vegetation, altitude rings, distant space objects |
| `js/scene/clouds.js` | Layered billboard cloud decks |
| `js/scene/rocket-model.js` | The procedural vehicle: hull, fins, engines, RCS pods, flames |
| `js/scene/effects.js` | Contrail, exhaust smoke, plume animation, exhaust light |
| `js/scene/transfer-scene.js` | Earth/destination markers, and re-skinning the target into landable ground |
| `js/scene/orbit-path.js` | The visible orbit ring plus apo/peri markers |
| `js/scene/camera.js` | Chase/ground/orbit camera framing and shake |
| `js/scene/controls.js` | `camMode`, `orbitState`, `userZoom`; drag/wheel/pinch and the zoom UI |
| `js/ui/*` | Theme, sound, roster, weather, profile, criteria, HUD, mission log, result overlay, shortcuts |
| `js/flight/controller.js` | `sim` lifecycle: reset, launch, run-to-time, skip, review, transport wiring |
| `js/flight/loop.js` | `animate()`, world-space mapping (`worldAltitude`/`worldDownrange`), `placeRocket` |

---

## Rules the modules follow

**No work at import time.** A module may declare things; it may not attach a listener or paint a
panel just because it was imported. Anything with an effect goes in an exported `init*()` that
`js/main.js` calls in a deliberate order. The only exceptions are `js/core/dom.js` (element lookups)
and `js/data/handoff.js` (its one roster refresh). `tests/parity.spec.js` enforces this — it is what
keeps the cyclic imports between `flight/`, `scene/` and `ui/` safe.

**Never assign to an imported binding.** `import { flightActive }` gives you a read-only view;
`flightActive = false` throws `Assignment to constant variable` at runtime, on that code path only.
Add a setter next to the declaration in the owning module and call that:

```js
// owning module
let flightActive = false;
function setFlightActive(v){ flightActive = v; }

// consumer
setFlightActive(false);
```

Existing setters: `setCurrentFrame`, `setFlightActive`, `setSpaceRoll`, `setCamMode`, `setUserZoom`,
`setLandedBodyShellMesh`, `setDestination`, `setFlightProfile`, `resetTouchdownHold`,
`resetTrailSpawnBudget`, `resetLogAnnouncer`, `clearParticles`.

Run `npm run lint:imports` to catch a violation before the browser does.

**Imports and exports are generated, not hand-written.** After moving a function between modules,
run `npm run rewire` — `tools/rewire.mjs` recomputes every `import` header and `export {...}` footer
from what the code actually uses. `npm run lint:wiring` fails if they are stale. Do not hand-edit
the generated header/footer lines; edit the code and re-run.

**Cyclic imports are fine, but only for functions.** `flight/loop.js` ↔ `flight/controller.js` and
`scene/three-setup.js` ↔ `flight/loop.js` are real cycles. Hoisted `function` declarations survive
them; a top-level `const` whose initializer reads across a cycle does not. Never write one.

---

## Commands

```
npm install                 # once; also: npx playwright install chromium
npm run serve               # http://127.0.0.1:4173  (ES modules need http://, not file://)
npm test                    # everything
npm run test:smoke          # boot + setup panel + chrome, fast
npm run test:parity         # byte/DOM/computed-style diff against legacy/rocket-sim.html
npm run test:flight         # full launches, interplanetary coasts, physics parity vs legacy
npm run test:pack           # builds the zip, unpacks it, runs it with the network blocked
npm run check               # lint:imports + lint:wiring + smoke + parity
npm run pack                # -> dist/rocket-sim-itch.zip
npm run pack -- -Version 1.2.0
```

`PW_JSON=1` swaps Playwright to a file-only reporter (`test-results/results.json`) — needed when
running from a non-interactive shell, since the default live reporter throws EPIPE there. Summarise
with `node tools/summarize-tests.mjs`.

### Testing notes
Headless Chromium needs SwiftShader flags for WebGL; they are already in `playwright.config.js`.
Software rendering is slow — keep `--workers` at 3 or below for the `@flight` suite.

Flights are fast-forwarded with `runToResult()` (fills the seek bar, which calls `runSimTo()` in one
pass) rather than by waiting in real time. Interplanetary coasts run past the seek bar's range and
use `skipUntilResult()` with the +30d chip instead.

The sim is **not** bit-deterministic: it advances in real animation frames before a fast-forward, so
peak altitude varies by ~0.1% between runs of the *same* build. Physics assertions use tolerances
wide enough to absorb that and narrow enough to catch a real change.

---

## itch.io

`tools/pack-itch.ps1` stages `index.html`, `css/`, `js/`, `vendor/` and zips the staged **contents**
so `index.html` sits at the archive root — itch requires that. It refuses to build if a referenced
asset or a module import is missing, and verifies the finished archive before reporting success.

Upload `dist/rocket-sim-itch.zip`, tick *"This file will be played in the browser"*, and set the
viewport to 1280×720 with the fullscreen button enabled.

The header links to three sibling apps (`rocket-calc.html`, `rocket-designer.html`,
`mission-log.html`) that live in other projects. They 404 in this build; the packer warns about
them rather than failing. Drop those files in the project root to make them resolve.
