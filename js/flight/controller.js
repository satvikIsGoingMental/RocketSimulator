import { BODIES, KARMAN_LINE_M } from "../core/constants.js";
import { camRow, hud, launchBtn, missionLog, resetBtn, resultOverlay, seekBar, setupPanel, transport } from "../core/dom.js";
import { formatMissionClock } from "../core/format.js";
import { rockets } from "../data/handoff.js";
import { setCamMode } from "../scene/controls.js";
import { clearParticles, updateEngineVisuals } from "../scene/effects.js";
import { boosterFlameMeshes, boosterMeshes, coreMeshGroup, flameMeshes } from "../scene/rocket-model.js";
import { rocketGroup, setSpaceRoll, spaceObjects, starField } from "../scene/three-setup.js";
import { setTransferDestinationVisual } from "../scene/transfer-scene.js";
import { makeSim } from "../sim/physics.js";
import { logEvent, simStep } from "../sim/step.js";
import { evaluateLaunchCriteria, weather } from "../sim/weather.js";
import { updateHud } from "../ui/hud.js";
import { renderMissionLog, resetLogAnnouncer } from "../ui/mission-log.js";
import { finishFlight } from "../ui/result-overlay.js";
import { applyHandoffRefresh, pendingHandoffRefresh, selectedRocketId } from "../ui/roster-ui.js";
import { Sound } from "../ui/sound.js";
import { placeRocket, resetTouchdownHold } from "./loop.js";

let sim = null;
let flightActive = false;
// ui/result-overlay.js's finishFlight() ends the flight; an imported binding is read-only at the
// import site, so that write goes through this setter.
function setFlightActive(v){ flightActive = v; }
let flightPaused = false;
// Most-recently-displayed frame (alt/downrange/etc) — unlike `sim`, which stays live-only and
// freezes at its final values once a flight ends, this tracks whatever is actually on screen right
// now, including during review-mode seek-bar scrubbing. Used to drive the space-shell roll/fade so
// they respond to scrubbing instead of being stuck at the flight's last live values.
let currentFrame = null;
// flight/loop.js's placeRocket() publishes each displayed frame through here — an imported binding
// is read-only at the import site, so it cannot assign currentFrame directly.
function setCurrentFrame(f){ currentFrame = f; }
let speedMult = 2;
let reviewMode = false;
let reviewIdx = 0;
const FIXED_DT = 1/60;
// Whether a given sim frame is inside "sensible atmosphere" for whichever body it belongs to —
// Earth (frame.body unset) uses the Kármán line, Mars uses its own arrivalAlt (the modeled edge
// of its CO2 atmosphere), and the Moon has no atmosphere at all so it's never "inside" one. Used
// purely to detect the moment of atmosphere entry/exit so time-warp can be reset around it — see
// autoResetSpeedOnTransition below.
function frameInAtmosphere(frame){
  if(!frame) return false;
  // TRANSFER repurposes frame.alt to mean "interplanetary distance remaining" (hundreds of millions
  // of meters, counting down), not a real altitude above any body — never treat that as atmosphere.
  if(frame.phase === 'TRANSFER') return false;
  const body = frame.body ? BODIES[frame.body] : null;
  if(body) return body.hasAtmosphere && frame.alt < body.arrivalAlt;
  return frame.alt < KARMAN_LINE_M;
}
function setSpeedMult(mult){
  speedMult = mult;
  Array.from(document.getElementById('speedRow').children).forEach(function(c){
    c.classList.toggle('active', parseFloat(c.getAttribute('data-speed')) === mult);
  });
}
let wasInAtmosphere = false;
let wasInLandingBurn = false;
let wasArrivedAtBody = false;
// Snaps time-warp back to 1x at the moments a warped-through flight would otherwise blur past
// something worth actually watching:
//  - crossing into or out of a body's atmosphere (Earth ascent/re-entry, Mars entry)
//  - the SOI handoff into ARRIVAL — a multi-day/month TRANSFER coast is flown at very high warp, and
//    without this reset the entire arrival-to-landing sequence (only ~15-125km of altitude) can
//    resolve in a fraction of a real second at that same warp, blurring straight past a descent
//    that's otherwise rendered continuously (see updateBodyLandingScene). Airless-body case (the
//    Moon): this is the only reset that fires before impact.
//  - the start of the landing burn, for the final seconds of descent specifically
function autoResetSpeedOnTransition(frame){
  const inAtmosphere = frameInAtmosphere(frame);
  const inLandingBurn = frame.phase === 'LANDING-BURN';
  const arrivedAtBody = !!frame.body;
  const crossed = (inAtmosphere !== wasInAtmosphere) || (inLandingBurn && !wasInLandingBurn) || (arrivedAtBody && !wasArrivedAtBody);
  wasInAtmosphere = inAtmosphere;
  wasInLandingBurn = inLandingBurn;
  wasArrivedAtBody = arrivedAtBody;
  if(crossed && speedMult !== 1) setSpeedMult(1);
}
function resetFlightView(){
  sim = null;
  flightActive = false;
  reviewMode = false;
  setupPanel.classList.remove('hidden');
  hud.classList.remove('visible');
  transport.classList.remove('visible');
  camRow.classList.remove('visible');
  resultOverlay.classList.remove('visible');
  missionLog.classList.remove('visible');
  missionLog.innerHTML = '';
  launchBtn.style.display = '';
  resetBtn.style.display = 'none';
  seekBar.disabled = true;
  seekBar.max = 3600;
  seekBar.value = 0;
  updateSeekLabel(0);
  // Each particle owns a cloned material (independent fade-out) but shares one of the two module-
  // level geometries (trailGeo/smokeGeo) — dispose only the material here, never the geometry,
  // since the geometry is reused by every future particle for the rest of the page's lifetime.
  clearParticles();
  if(flameMeshes[0]) flameMeshes[0].children.forEach(function(f){ f.visible = false; });
  boosterFlameMeshes.forEach(function(f){ f.visible = false; });
  boosterMeshes.forEach(function(b){ b.visible = true; b.position.y = 0; });
  if(coreMeshGroup) coreMeshGroup.position.y = 0;
  rocketGroup.position.set(0,3,0);
  rocketGroup.rotation.set(0,0,0);
  rocketGroup.userData.targetTilt = 0;
  setSpaceRoll(0);
  setCurrentFrame(null);
  if(starField) starField.rotation.set(0,0,0);
  if(spaceObjects) spaceObjects.rotation.set(0,0,0);
  setCamMode('chase');
  Array.from(document.getElementById('camChips').children).forEach(function(c){
    c.classList.toggle('active', c.getAttribute('data-cam')==='chase');
  });
  // pick up any calculator edits that arrived while a flight was in progress/under review, now
  // that it's safe to swap the roster and rebuild the 3D model
  if(pendingHandoffRefresh) applyHandoffRefresh();
}

let launchWeatherSnapshot = null, launchCriteriaSnapshot = null;
function startLaunch(){
  resetLogAnnouncer();
  Sound.resetLogCursor();
  const r = rockets.find(function(x){ return x.id === selectedRocketId; });
  sim = makeSim(r);
  wasInAtmosphere = true; // launch always starts on the pad, inside Earth's atmosphere
  wasInLandingBurn = false;
  wasArrivedAtBody = false;
  resetTouchdownHold();
  if(sim.body) setTransferDestinationVisual(sim.body.id);
  // snapshot weather/launch-criteria at the moment of ignition, not at flight-finish time, so the
  // mission log records the conditions actually launched into even if weather sliders are somehow
  // touched later (they're hidden during flight, but this keeps the record correct regardless)
  launchWeatherSnapshot = Object.assign({}, weather);
  launchCriteriaSnapshot = evaluateLaunchCriteria(r);
  logEvent(sim, 'Ignition sequence start', 'mark');
  flightActive = true;
  flightPaused = false;
  reviewMode = false;
  seekBar.disabled = false;
  seekBar.min = 0;
  seekBar.max = 3600;
  seekBar.value = 0;
  updateSeekLabel(0);
  setupPanel.classList.add('hidden');
  hud.classList.add('visible');
  transport.classList.add('visible');
  camRow.classList.add('visible');
  missionLog.classList.add('visible');
  launchBtn.style.display = 'none';
  resetBtn.style.display = '';
  renderMissionLog();
}

const SKIP_STEP_CAP = 250000; // hard ceiling so a runaway target can't lock up the tab
// TRANSFER is a smooth, non-stiff 1D distance closure (see stepTransfer) — nothing like the RK4
// ascent/orbital physics that genuinely needs 1/60s resolution to stay numerically accurate. A
// multi-day (Moon) or multi-month (Mars) coast at a fixed 1/60s step would need tens of millions
// of steps to simulate at all, which is exactly what SKIP_STEP_CAP exists to prevent — so while in
// TRANSFER, take much coarser steps (still fine enough that the distance/speed numbers converge;
// verified by comparing against 1/60s-step results for the same coast, agreement within <0.1%
// because closing speed changes smoothly and slowly compared to a single step here).
function stepDtFor(s){
  return s.phase === 'TRANSFER' ? 600 : FIXED_DT; // 10 simulated minutes per step during transfer
}
function runSimTo(targetT){
  if(!sim) return;
  let steps = 0;
  const wasArrivedAtBody = sim.arrivedAtBody;
  while(sim.phase !== 'DONE' && sim.t < targetT && steps < SKIP_STEP_CAP){
    const dt = Math.min(stepDtFor(sim), targetT - sim.t);
    simStep(sim, dt > 0 ? dt : stepDtFor(sim));
    steps++;
    // A skip-ahead spanning many simulated days (e.g. "+30d" clicked mid-TRANSFER) would otherwise
    // run straight through the SOI handoff and the entire ARRIVAL/DESCENT/LANDING-BURN sequence in
    // this same loop, landing (or crashing) the vehicle with zero frames ever drawn in between —
    // exactly the "skip skips the landing" behavior this guards against. Stop the instant arrival
    // begins so a skip-ahead during the coast can only ever advance you TO the start of the landing
    // sequence, never past it; further skip-ahead clicks after that land you deeper into the (now
    // much shorter, minutes-long) descent normally.
    if(sim.arrivedAtBody && !wasArrivedAtBody) break;
  }
}
function skipAhead(seconds){
  if(!sim) return;
  flightPaused = false;
  document.getElementById('pauseIcon').innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
  runSimTo(sim.t + seconds);
  const last = sim.history[sim.history.length-1];
  if(last){
    placeRocket(last.alt, last.boosterAttached, last.downrange, last.flightPathAngle, last.throttle, last.phase, last.body);
    updateHud(last);
    updateEngineVisuals(last);
    renderMissionLog();
  }
  seekBar.max = Math.max(sim.t, 3600);
  seekBar.value = sim.t;
  updateSeekLabel(sim.t);
  if(sim.phase === 'DONE') finishFlight();
}
function updateSeekLabel(t){
  document.getElementById('seekTime').textContent = formatMissionClock(t);
}
function findFrameByTime(t){
  const h = sim.history;
  if(!h.length) return null;
  let lo = 0, hi = h.length-1;
  while(lo < hi){
    const mid = (lo+hi) >> 1;
    if(h[mid].t < t) lo = mid+1; else hi = mid;
  }
  return h[lo];
}
function applyReviewTime(t){
  const f = findFrameByTime(t);
  if(!f) return;
  placeRocket(f.alt, f.boosterAttached, f.downrange, f.flightPathAngle, f.throttle, f.phase, f.body);
  updateHud(f);
  updateSeekLabel(f.t);
}

/* ---------------- wiring ----------------
   Every transport/launch control that drives the sim lifecycle, attached once from js/main.js.
   Kept in one function (rather than run at module-evaluation time) so main.js decides the order
   the UI comes up in, instead of it falling out of the import graph. */
function initFlightControls(){
  launchBtn.addEventListener('click', function(){
    Sound.unlock(); // must happen synchronously inside the click handler — browsers only allow AudioContext creation/resume off a real user gesture
    startLaunch();
  });
  resetBtn.addEventListener('click', function(){
    Sound.uiClick();
    resetFlightView();
  });

  document.getElementById('pauseBtn').addEventListener('click', function(){
    if(!flightActive) return;
    flightPaused = !flightPaused;
    document.getElementById('pauseIcon').innerHTML = flightPaused
      ? '<path d="M8 5l12 7-12 7V5z"/>'
      : '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
  });

  Array.from(document.getElementById('speedRow').children).forEach(function(chip){
    chip.addEventListener('click', function(){
      setSpeedMult(parseFloat(chip.getAttribute('data-speed')));
    });
  });

  /* ---- skip-ahead: instantly resolve the sim to a future time, bypassing real-time animation ---- */

  Array.from(document.getElementById('skipRow').children).forEach(function(chip){
    chip.addEventListener('click', function(){
      skipAhead(parseFloat(chip.getAttribute('data-skip')));
    });
  });

  document.getElementById('againBtn').addEventListener('click', function(){
    resetFlightView();
  });
  document.getElementById('reviewBtn').addEventListener('click', function(){
    reviewMode = true;
    flightActive = false;
    resultOverlay.classList.remove('visible');
    hud.classList.add('visible');
    transport.classList.add('visible');
    camRow.classList.add('visible');
    seekBar.disabled = false;
    const endT = sim.history.length ? sim.history[sim.history.length-1].t : 0;
    seekBar.max = endT;
    seekBar.value = endT;
    applyReviewTime(endT);
  });
  seekBar.addEventListener('input', function(){
    if(!sim) return;
    const targetT = parseFloat(seekBar.value);
    updateSeekLabel(targetT);
    if(reviewMode){
      applyReviewTime(targetT);
    } else if(flightActive){
      // scrubbing forward mid-flight fast-forwards the live sim; scrubbing backward isn't possible
      // without re-simulating from t=0 (state isn't reversible), so treat it as a forward-only skip
      if(targetT > sim.t) runSimTo(targetT);
      const last = sim.history[sim.history.length-1];
      if(last){
        placeRocket(last.alt, last.boosterAttached, last.downrange, last.flightPathAngle, last.throttle, last.phase, last.body);
        updateHud(last);
        updateEngineVisuals(last);
        renderMissionLog();
      }
      seekBar.max = Math.max(sim.t, 3600);
      if(sim.phase === 'DONE') finishFlight();
    }
  });

  // binary-search history for the frame nearest a given mission time, used by the review scrub bar
}

export { FIXED_DT, autoResetSpeedOnTransition, currentFrame, flightActive, flightPaused, initFlightControls, launchCriteriaSnapshot, launchWeatherSnapshot, resetFlightView, reviewMode, setCurrentFrame, setFlightActive, setSpeedMult, sim, speedMult, stepDtFor, updateSeekLabel };
