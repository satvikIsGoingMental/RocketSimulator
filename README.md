# Δv Stack — Launch Simulator

A real-physics rocket launch simulator in the browser: two-body orbital mechanics, a rule-based
launch-commit-criteria weather model, procedurally built vehicles, and patched-conic transfers to
the Moon and Mars — rendered with three.js.

Vanilla HTML/CSS/JS. No framework, no bundler, no build step.

## Run it

ES modules do not load over `file://`, so it needs a server:

```
npm install                 # optional; only needed for the test suite
npm run serve               # http://127.0.0.1:4173
```

or with no npm at all:

```
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

## Build for itch.io

```
npm run pack                       # -> dist/rocket-sim-itch.zip
npm run pack -- -Version 1.2.0     # versioned filename
```

Upload the zip, tick *"This file will be played in the browser"*, viewport 1280×720.

## Test

```
npm test                # everything
npm run test:smoke      # fast: boot, panels, chrome
npm run test:parity     # diffs the split build against legacy/rocket-sim.html
npm run test:flight     # full launches + interplanetary coasts
npm run test:pack       # builds the zip and runs it offline
npm run check           # lint + smoke + parity
```

## Structure

`index.html` · `css/` (11 files, cascade-ordered) · `js/` (ES modules) · `vendor/three/` ·
`tools/` · `tests/` · `legacy/` (the original single-file build, kept as the parity baseline)

See [CLAUDE.md](CLAUDE.md) for the module map and the rules the code follows.
