import { BODIES, R_PLANET } from "../core/constants.js";
import { seekBar } from "../core/dom.js";
import { updateCamera } from "../scene/camera.js";
import { setCloudsSpaceMix, setCloudsVisible, updateClouds } from "../scene/clouds.js";
import { engineThrustIntensity, maybeSpawnSmoke, maybeSpawnTrail, resetTrailSpawnBudget, updateEngineVisuals, updateExhaustLight, updateSmoke, updateTrail } from "../scene/effects.js";
import { updateOrbitPathVisual } from "../scene/orbit-path.js";
import { boosterMeshes, rocketDims } from "../scene/rocket-model.js";
import { applySkyColors, camera, clock, contextLost, earthShellMesh, groundMesh, padGroup, renderer, rocketGroup, scene, setSpaceRoll, spaceMixForAltitude, spaceObjects, spaceRoll, starField, updateSpaceTransition } from "../scene/three-setup.js";
import { bodyGroundShells, landedBodyShellMesh, setLandedBodyShellMesh, transferBodyLabel, transferBodyMesh, transferEarthMesh, transferGroup, updateBodyLandingScene, updateTransferScene } from "../scene/transfer-scene.js";
import { altitudeRingMarks, karmanRingLabel, karmanRingMesh, vegetationGroup } from "../scene/world.js";
import { simStep } from "../sim/step.js";
import { updateHud } from "../ui/hud.js";
import { renderMissionLog } from "../ui/mission-log.js";
import { finishFlight } from "../ui/result-overlay.js";
import { Sound } from "../ui/sound.js";
import { autoResetSpeedOnTransition, currentFrame, flightActive, flightPaused, setCurrentFrame, sim, speedMult, stepDtFor, updateSeekLabel } from "./controller.js";

let accumulator = 0;
// Real seconds to hold on the final touchdown/impact frame — camera and scene stay live, nothing
// under time-warp — before the result overlay covers the view. Without this, a landing or crash
// (sim.phase snapping straight to DONE the instant alt<=0) went from "still descending" to "here's
// the result card" within the same rendered frame, however fast or slow speedMult had it moving:
// there was never a moment where the touchdown or impact itself was actually on screen to watch.
const TOUCHDOWN_HOLD_SEC = 1.5;
let touchdownHoldT = 0;
// flight/controller.js clears the hold at ignition; an imported binding is read-only at the import
// site, so that write goes through this setter.
function resetTouchdownHold(){ touchdownHoldT = 0; }
/* ================================================================================
   RENDER LOOP
   ================================================================================ */
// Real ascents run from 0m to hundreds of km — a linear world scale can't show both a satisfying
// liftoff and a sane camera framing at apogee, so world height grows with log(1 + altitude) instead.
// Below ~300m this is close to linear (so liftoff still reads as liftoff); above it, altitude keeps
// climbing in the HUD numbers while the visual climb rate tapers off.
//
// The linear and log regions are blended smoothly across a transition band (ALT_BLEND_WIDTH wide,
// centered on ALT_BLEND_ALT) instead of hard-switching at a single altitude. A hard switch is
// continuous in VALUE but not in SLOPE — the climb rate visibly kinks right at the seam — and
// placeRocket() differentiates this exact function every frame (via worldMapSlope) to get the
// rocket's visual tilt. A slope kink there reads as a sudden jerk in the rocket's orientation
// while ascending, as if it had bumped into something, even though nothing in the physics changed.
// Blending removes the kink so the derivative — and the on-screen motion — stays smooth.
//
// FIX (ascent reads as "stuck" partway up): the log term below used to divide `rest` by 300 —
// i.e. it was already deep in log1p's slow-growth regime by a few km of altitude, so climbing from
// 10km to 100km to 200km barely moved the rocket on screen even though the HUD altitude, velocity,
// and Δv were all advancing normally. That mismatch between "what the HUD reports" and "what the
// screen shows" is exactly the bug: within the first 45 seconds the vehicle could show ~3km of
// visual climb and then appear to stall, long before it was anywhere near its real apogee/MECO
// altitude. ALT_LOG_DIVISOR is pushed out (300 -> 45000) and ALT_LOG_SCALE bumped up to compensate
// (55 -> 900) so growth stays close to linear through the altitudes that matter for a normal ascent
// (tens to a couple hundred km), only easing into heavier compression well past a typical orbital
// insertion altitude. At displayScale~1 this moves 100km (the Karman line) from ~719 world units to
// ~1451, and 200km (a typical target parking orbit) from ~757 to ~1924 — the climb the HUD reports
// now keeps advancing visually all the way through ascent instead of flattening out early. The far
// end (real lunar/Mars distance) was checked too: log1p's own ever-slowing growth still keeps those
// comfortably inside SKY_RADIUS/CAMERA_FAR (see initThree) even with the larger scale/divisor.
const ALT_BLEND_ALT = 300, ALT_BLEND_WIDTH = 220;
const ALT_LOG_DIVISOR = 45000; // m — growth stays near-linear out to roughly this altitude, only easing into log compression well past it (was implicitly 300 via the old `rest/300` term)
const ALT_LOG_SCALE = 900; // world units per e-fold of altitude beyond the linear zone (was 55)
// No teleport, no scene swap: the vehicle stays in ONE continuous Earth-relative world all the way
// from the pad out to the Moon (and beyond), by leaning entirely on log1p's own property of growing
// forever but ever more slowly — log1p(384,400,000/45000) is only ~9.1, so lunar distance maps to a
// few thousand world units past low orbit, not an astronomical one. What used to blow up unboundedly
// was the LINEAR near-pad term (0.12 m/unit * millions of km is enormous) still being added in at
// escape/interplanetary altitudes even though it only exists to make liftoff itself feel linear —
// past ALT_BLEND_ALT it has already fully handed off to logTerm (see the blend below), so capping
// linear on its own here removes the runaway term without capping the (already slow-growing, and
// therefore safe to leave uncapped) log term that does all the work at real distance.
const ALT_LINEAR_CAP = 400; // world units — plenty past ALT_BLEND_ALT's own linear*s*0.12 (~36 units), just a safety ceiling
function worldAltitude(alt){
  const s = rocketDims ? rocketDims.displayScale : 1;
  const linear = smoothCap(alt * s * 0.12, ALT_LINEAR_CAP * s);
  const rest = Math.max(alt - ALT_BLEND_ALT, 0);
  const logTerm = rest > 0 ? ALT_LOG_SCALE * s * Math.log1p(rest / ALT_LOG_DIVISOR) : 0;
  const compressed = linear + logTerm; // uncapped — log1p's own ever-slowing growth is what keeps this sane at any real distance, no matter how far the flight goes
  const lo = ALT_BLEND_ALT - ALT_BLEND_WIDTH/2, hi = ALT_BLEND_ALT + ALT_BLEND_WIDTH/2;
  if(alt <= lo) return linear;
  if(alt >= hi) return compressed;
  const t = (alt - lo) / (hi - lo);
  const smooth = t*t*(3 - 2*t); // smoothstep — matches value AND slope of whichever branch dominates at each end
  return linear * (1 - smooth) + compressed * smooth;
}

// Downrange distance (how far the vehicle has traveled horizontally along the surface track since
// liftoff) needs the same log compression, for the same reason: a gravity-turn ascent covers tens
// of km horizontally by MECO and a full orbit covers ~40,000km, which would otherwise either make
// the pad-relative liftoff motion invisible or fling the camera to an ummanageable distance. Downrange
// (sim.downrange, from syncScalars) is itself UNWRAPPED — it keeps growing every orbit rather than
// snapping across a +-pi seam — but composing it through sin()/cos() here instead of a hard modulo
// turns that monotonic growth into smooth, continuous periodic motion in world space: the rocket
// visibly circles back past the launch site each orbit with no jump, instead of either flying off to
// infinity (if left uncompressed) or teleporting (if wrapped with % / a discontinuous fmod).
//
// DOWNRANGE_LOG_SCALE/DOWNRANGE_LOG_DIVISOR/the linear coefficient below are tuned so the CAPPED
// value keeps visibly climbing all the way through a realistic gravity-turn ascent — real downrange
// at MECO is typically tens to ~100km, not the few km these constants were originally tuned for.
// The old, much smaller divisor (3000) combined with a 0.1 linear coefficient meant the tanh cap in
// smoothCap was already fully saturated by roughly 15-30km of real downrange: the vehicle's visual
// X position froze solid for the rest of the flight (MECO, coast, orbit insertion — everything from
// there on covers hundreds of km or more) even though altitude and the HUD kept climbing normally,
// which is exactly what read as the rocket "hitting an invisible barrier" partway up. Verified via a
// live headless-browser run: rocketGroup.position.x was pinned to within 0.1 world units across a
// 90,000m real-altitude gain once downrange passed ~20km. The values below keep the capped output
// under ~700/900 through 100km of downrange (safely past a typical MECO) and don't fully saturate
// until several hundred km — by which point the vehicle is genuinely coasting in orbit and loopMix
// (below) is what takes over supplying visible motion, not this base term.
const DOWNRANGE_LOG_SCALE = 200;
const DOWNRANGE_LOG_DIVISOR = 350000;
const DOWNRANGE_ORBIT_PERIOD_M = 2 * Math.PI * R_PLANET; // one full lap, in meters of arc
const DOWNRANGE_ORBIT_RADIUS = 900; // world units — visual radius of a "lap" once compression saturates
const DOWNRANGE_BLEND_M = 50, DOWNRANGE_BLEND_WIDTH = 35;
// Smooth saturation toward DOWNRANGE_ORBIT_RADIUS instead of a hard Math.min() clamp — a hard clamp
// is continuous in value but has a slope kink at the exact meter it starts clamping, which is the
// same class of bug as the altitude blend above (see the note on ALT_BLEND_ALT): differentiating
// through the kink in placeRocket()'s worldMapSlope() produces a sudden, spurious jerk in the
// rocket's on-screen tilt mid-ascent. tanh saturates smoothly to the same asymptote with no kink.
function smoothCap(x, cap){
  return cap * Math.tanh(x / cap);
}
function worldDownrange(downrangeMeters){
  const s = rocketDims ? rocketDims.displayScale : 1;
  const sign = downrangeMeters < 0 ? -1 : 1;
  const mag = Math.abs(downrangeMeters);
  const linear = mag * s * 0.015;
  const rest = Math.max(mag - DOWNRANGE_BLEND_M, 0);
  // compressed distance-along-track, saturating toward one full lap's worth of world units as
  // downrange grows without bound — this is what lets a lap "close" visually instead of the log
  // term growing forever
  const lapFrac = (mag % DOWNRANGE_ORBIT_PERIOD_M) / DOWNRANGE_ORBIT_PERIOD_M; // 0..1 around the lap
  const logTerm = rest > 0 ? DOWNRANGE_LOG_SCALE * s * Math.log1p(rest / DOWNRANGE_LOG_DIVISOR) : 0;
  // Cap linear+logTerm TOGETHER (not just logTerm on top of an uncapped linear) — otherwise, in the
  // window between roughly half a lap and one full lap of downrange (well within reach of a fast
  // escape trajectory, which racks up downrange quickly), `straight` below blows up to hundreds of
  // thousands of world units before loopMix ramps in to rein it back in, flinging the vehicle way
  // outside the sky sphere for that stretch. Capping here means `straight` itself never exceeds the
  // cap, so there's nothing left for loopMix to have to rescue.
  const compressedValue = smoothCap(linear + logTerm, DOWNRANGE_ORBIT_RADIUS * s);
  const lo = DOWNRANGE_BLEND_M - DOWNRANGE_BLEND_WIDTH/2, hi = DOWNRANGE_BLEND_M + DOWNRANGE_BLEND_WIDTH/2;
  let straight;
  if(mag <= lo) straight = linear;
  else if(mag >= hi) straight = compressedValue;
  else {
    const t = (mag - lo) / (hi - lo);
    const smooth = t*t*(3 - 2*t);
    straight = linear * (1 - smooth) + compressedValue * smooth;
  }
  const compressed = straight - linear >= 0 ? straight - linear : 0;
  // Below one lap, behave exactly as before (monotonic log growth away from the pad). Once a lap's
  // worth of ground has been covered, ease into tracing a closed loop (via lapFrac) so repeated
  // orbits read as the vehicle circling back past the pad, not sliding further off-camera forever.
  const loopMix = Math.min(1, rest / (DOWNRANGE_ORBIT_PERIOD_M * 0.5));
  const looped = compressed * Math.sin(lapFrac * Math.PI * 2);
  return sign * (straight * (1-loopMix) + looped * loopMix);
}

// Numeric derivative helper: local slope of a 1D world-space mapping fn(m) at m0, in world units
// per meter. Used below so the rocket's visual tilt is derived from the SAME compressed/looped
// mapping that its position uses, instead of the raw physics angle — see the note in placeRocket.
function worldMapSlope(fn, m0){
  const h = Math.max(1, Math.abs(m0) * 1e-4);
  return (fn(m0+h) - fn(m0-h)) / (2*h);
}

function placeRocket(alt, boosterAttached, downrangeMeters, flightPathAngle, throttle, phase, bodyId){
  if(phase === 'TRANSFER'){
    // No teleport, no separate "deep space stage": the vehicle stays in the SAME continuous
    // Earth-relative world the whole way to the target body, just like every earlier phase. alt here
    // is repurposed to mean "distance remaining to target" (see stepTransfer), so convert it back to
    // an honest distance from Earth's center and feed that through the exact same worldAltitude()
    // every other phase uses. Must start from sim.transferStartR (the REAL radius at the moment
    // TRANSFER began, captured by captureTransfer), not R_PLANET — ESCAPE can carry the vehicle
    // hundreds of thousands of km out before TRANSFER even begins, and re-basing to R_PLANET here
    // would erase all of that, snapping the vehicle visually back toward Earth the instant TRANSFER
    // starts even though its real position didn't move. worldAltitude is uncapped log growth, so it
    // keeps receding continuously no matter how far the coast goes, all the way to real lunar/Mars
    // distance, with no hand-off.
    const total = sim ? sim.transferTotalDistance : 1;
    const remaining = sim ? sim.transferDistance : alt;
    const startR = sim && sim.transferStartR ? sim.transferStartR : R_PLANET;
    const trueAltFromEarth = startR + Math.max(0, total - remaining);
    setCurrentFrame({ alt: trueAltFromEarth, downrange: downrangeMeters || 0,
      transferDistance: remaining, transferTotalDistance: total });
    const newY = 3 + worldAltitude(trueAltFromEarth);
    const newX = worldDownrange(downrangeMeters || 0);
    rocketGroup.position.set(newX, newY, 0);
    rocketGroup.rotation.set(0, Math.PI/2, 0); // nose toward the destination, coasting attitude
    if(transferGroup) updateTransferScene(currentFrame);
    return;
  }
  if(bodyId){
    // ARRIVAL/DESCENT/LANDING-BURN after the SOI handoff. The underlying physics is still target-
    // centric (stepArrival integrates against the Moon/Mars' own gravity — see computeAccelForBody),
    // but the vehicle's DISPLAY position keeps using the exact same continuous Earth-relative
    // worldAltitude/worldDownrange mapping as every earlier phase, converting "alt above the target
    // body's surface" back to "distance from Earth's center" (body.distanceFromEarth - alt, which
    // approaches body.distanceFromEarth — the same anchor updateTransferScene already parks
    // transferBodyMesh at — as alt shrinks to 0 at touchdown). That keeps the rocket's world position
    // sliding continuously into the Moon/Mars marker it's been visibly approaching the whole transfer,
    // instead of cutting to a separate re-centered scene at the SOI handoff. updateBodyLandingScene
    // grows/re-skins that same marker into landable ground in place, rather than swapping to a
    // different mesh/coordinate system.
    const body = sim && sim.body ? sim.body : (BODIES[bodyId] || null);
    const trueAltFromEarth = body ? Math.max(0, body.distanceFromEarth - alt) : alt;
    const newY = 3 + worldAltitude(trueAltFromEarth);
    const newX = worldDownrange(downrangeMeters || 0);
    setCurrentFrame({ alt: trueAltFromEarth, downrange: downrangeMeters || 0, arrivedAtBody:true, bodyId: bodyId, bodyAlt: alt, downrangeWorldX: newX });
    rocketGroup.position.set(newX, newY, 0);
    // Tilt from flightPathAngle directly rather than through worldMapSlope's chain rule: that trick
    // exists to correct for worldAltitude/worldDownrange's log compression distorting the visual
    // direction of travel, but ARRIVAL/DESCENT/LANDING-BURN only ever spans 15-125km of body-relative
    // alt against a ~384,400km (Moon) or ~225M km (Mars) log-compressed distance from Earth — at that
    // scale the compression is locally flat enough that the raw physical angle IS the visual one.
    const fpa = flightPathAngle || 0;
    let targetTilt = fpa;
    if(phase === 'LANDING-BURN') targetTilt += Math.PI; // engines-first, retrograde
    const cur = rocketGroup.rotation.z;
    const target = -targetTilt;
    let delta = target - cur;
    delta -= Math.round(delta / (2*Math.PI)) * 2*Math.PI;
    rocketGroup.rotation.z = cur + delta * 0.15;
    if(sim && sim.body) updateBodyLandingScene(currentFrame, sim.body);
    return;
  }
  setCurrentFrame({ alt: alt, downrange: downrangeMeters || 0 });
  const dr = downrangeMeters || 0;
  const newY = 3 + worldAltitude(alt);
  const newX = worldDownrange(dr);
  rocketGroup.position.y = newY;
  rocketGroup.position.x = newX;

  // Bank the vehicle to track its actual direction of travel. Previously this used flightPathAngle
  // (the real physics angle from local vertical) directly as the visual tilt, while POSITION was
  // driven through worldDownrange/worldAltitude's heavy log compression (and, once orbiting, the
  // periodic wraparound above) — two different mappings of the same motion. Near the pad they
  // roughly agreed, but as compression/looping kicked in the angle the rocket visibly traveled
  // along on screen diverged further and further from flightPathAngle, so the nose pointed one way
  // while the vehicle visibly slid/curved/snapped another. That mismatch is what read as "flying
  // sideways" and "bouncing in the air." Fix: convert the physical velocity direction into a VISUAL
  // velocity direction by pushing it through the local derivative (slope) of the same two mapping
  // functions position uses, via the chain rule — d(world)/dt = d(world)/d(meters) * d(meters)/dt.
  // This is a pure function of the current state (alt, downrange, flightPathAngle), so it stays
  // exactly correct for an arbitrary instantaneous scrub-bar jump too, with no history dependency.
  //
  // EXCEPT while coasting with the engine off in a genuinely closed ORBIT or on a confirmed ESCAPE
  // trajectory (throttle 0 there too): with no thrust and no atmosphere, the vehicle isn't actively
  // steering, so in reality it just keeps pointing the way it was last pointed (no torque, no
  // gyroscopic pitch-over) while gravity curves the PATH under it. flightPathAngle is measured from
  // local vertical, and local vertical itself sweeps around as the vehicle travels relative to the
  // (comparatively tiny, nearby) planet — so recomputing tilt from it every frame made a coasting
  // vehicle appear to visibly pitch/bank even under zero thrust and zero rotational force, which is
  // exactly the "still pitched like gravity is grabbing it" look reported in deep space. Fix: freeze
  // rotation.z at whatever it was when thrust cut out, instead of chasing the rotating local frame —
  // the nose direction stays fixed in world space, exactly like an unpowered body coasting through
  // vacuum should.
  //
  // DESCENT and BALLISTIC are DIFFERENT: a suborbital arc is headed back down, and although BALLISTIC
  // is (like ORBIT/ESCAPE) a vacuum coast with no real aerodynamic torque above the atmosphere, this
  // sim deliberately keeps tracking its velocity-direction tilt anyway rather than freezing it at
  // whatever the ascent attitude happened to be at MECO/apogee. Reason: this is a browser sim that
  // runs at up to 200x time compression, where the reorientation lerp below can only "smoothly" turn
  // the vehicle over real SIMULATED seconds — at high speedMult, many of those simulated seconds
  // collapse into a single rendered frame, so ANY reorientation that starts from a stale frozen
  // attitude finishes within one visible frame regardless of the lerp factor, which is exactly what
  // reads as an instant snap (confirmed: a Saturn V flying straight-up froze at ~0deg through its
  // entire ~20-minute ballistic coast, then visibly teleported to ~180deg the instant DESCENT began,
  // because atan2 of a straight-down fall is legitimately near +-PI and there was no gradual run-up
  // to it). Fix: keep the SAME velocity-tracking tilt active through BALLISTIC too, so the vehicle is
  // already correctly oriented by the time it reaches DESCENT — no frozen-then-teleport discontinuity
  // survives, because there's no freeze in the first place for this phase. (ORBIT/ESCAPE keep the
  // freeze: those coasts can run indefinitely and never transition into a phase that needs the
  // "already pointing the right way" property BALLISTIC needs before DESCENT.)
  //
  // DESCENT itself used to be (incorrectly) swept into the same "throttle 0 -> freeze" bucket: a
  // stage falling back through the atmosphere aerodynamically weathervanes to track its velocity
  // vector, it doesn't hold whatever attitude it had at MECO/apogee forever. That was the literal
  // cause of "pitches to 90 degrees, then just falls, frozen" — DESCENT never had thrust, so the
  // tilt-update block below never ran again after apogee. Recompute tilt during DESCENT exactly like
  // a powered phase (nose/tail continues tracking the velocity vector), and during LANDING-BURN
  // specifically flip it 180 degrees so the ENGINES (not the nose) point along the velocity vector —
  // the suicide-burn retrograde flip.
  //
  // ORBIT also tracks velocity now (it used to freeze along with ESCAPE): a stable orbit visibly
  // loops back past the pad every lap via worldDownrange's periodic wraparound, so a frozen nose
  // attitude looked wrong for exactly the same reason DESCENT's did — the vehicle visibly slid along
  // a curved path while pointing one fixed direction the whole time. Real orbital mechanics doesn't
  // torque a coasting vehicle to track its own velocity like this (that's what DESCENT's aerodynamic-
  // weathervane comment above is about), but here it buys the "banking into the curve" look that
  // reads as an orbit rather than a static loop, which is worth the small physical liberty. ESCAPE
  // (and TRANSFER, which now continues the same worldAltitude mapping — see placeRocket) stays
  // frozen/excluded here: an unpowered hyperbolic coast has no torque acting on it either, so the
  // nose legitimately keeps pointing wherever it was last aimed instead of banking to track velocity.
  const activelyOriented = throttle > 0 || phase === 'DESCENT' || phase === 'LANDING-BURN' || phase === 'BALLISTIC' || phase === 'ORBIT';
  if(activelyOriented){
    const fpa = flightPathAngle || 0;
    const vDownrange = Math.sin(fpa); // unit physical velocity, downrange component
    const vAlt = Math.cos(fpa);       // unit physical velocity, altitude component
    const dWorldDownrange = worldMapSlope(worldDownrange, dr) * vDownrange;
    const dWorldAlt = worldMapSlope(worldAltitude, Math.max(alt,0)) * vAlt;
    if(Math.hypot(dWorldDownrange, dWorldAlt) > 1e-6){
      const visualTilt = Math.atan2(dWorldDownrange, dWorldAlt);
      // The +-1.5rad (~86 deg) clamp below only makes sense while CLIMBING (vAlt>0): it exists to
      // keep ascent-noise from ever visually over-rotating the vehicle past horizontal, and during
      // ascent visualTilt is mathematically guaranteed to stay inside +-90 deg anyway (vAlt is always
      // positive), so the clamp is a no-op safety net there. During DESCENT (vAlt<0, falling) the
      // SAME atan2 legitimately returns angles out to +-180 deg for a vehicle plunging straight down
      // — clamping that to 86 deg was the bug: a perfectly vertical fall (visualTilt == PI) got
      // clamped down to 1.5rad, i.e. rendered as nearly horizontal, which is exactly the "snaps to
      // sideways" glitch. Falling straight down must render as straight down, so only apply the
      // clamp while genuinely climbing; a falling vehicle's tilt is used un-clamped.
      let targetTilt = vAlt >= 0 ? Math.max(-1.5, Math.min(1.5, visualTilt)) : visualTilt;
      if(phase === 'LANDING-BURN') targetTilt += Math.PI; // flip: engines-first, retrograde
      // Keep the lerp taking the SHORT way around the circle — lerping raw angles across the +-PI
      // seam (e.g. current rotation.z just past -PI, target just past +PI) would otherwise spin the
      // model the long way around for one frame, another possible source of a visible "snap."
      const cur = rocketGroup.rotation.z;
      const target = -targetTilt;
      let delta = target - cur;
      delta -= Math.round(delta / (2*Math.PI)) * 2*Math.PI;
      rocketGroup.rotation.z = cur + delta * 0.15;
    }
  }
  boosterMeshes.forEach(function(b){ b.visible = boosterAttached; });
}

/* Toggles which of the two scene "stages" is visible — normal Earth ascent/orbit/coast (which now
   covers ESCAPE and TRANSFER too, since both fly continuously through the same world — see
   placeRocket/worldAltitude) or a landing on the target body (transferBodyMesh grown/re-skinned into
   ground in place by updateBodyLandingScene, in the SAME continuous world, not a separate scene) —
   based on the live sim's phase. Centralized here (rather than scattered visibility toggles at each
   phase-transition callsite) so there's exactly one place that decides "what's on screen right now,"
   matching how currentFrame is already the one source of truth for "what's the vehicle's displayed
   state right now." transferGroup now stays visible for both TRANSFER and a landed body, since the
   same marker mesh serves as the destination dot during the coast and the ground after arrival. */
function applySceneMode(){
  const inTransfer = !!(sim && sim.phase === 'TRANSFER');
  const landed = !!(sim && sim.arrivedAtBody);
  if(transferGroup) transferGroup.visible = inTransfer || landed; // landed keeps using transferBodyMesh as the ground — see updateBodyLandingScene
  if(rocketGroup) rocketGroup.visible = true;
  if(padGroup) padGroup.visible = !inTransfer && !landed;
  if(vegetationGroup) vegetationGroup.visible = !inTransfer && !landed;
  if(groundMesh) groundMesh.visible = !inTransfer && !landed && groundMesh.material.opacity > 0.001;
  if(earthShellMesh) earthShellMesh.visible = !inTransfer && !landed;
  // Only force clouds fully OFF here for transfer/landed; otherwise leave their visibility/opacity to
  // setCloudsSpaceMix (driven every frame by altitude — see its comment) rather than snapping them back
  // to fully visible, which would fight the altitude-based fade the instant this runs after a phase change.
  if(inTransfer || landed) setCloudsVisible(false);
  if(karmanRingMesh) karmanRingMesh.visible = !inTransfer && !landed;
  if(karmanRingLabel) karmanRingLabel.visible = !inTransfer && !landed;
  // Non-Karman altitude rings: only show the ring(s) reasonably close (within one log-decade) to the
  // vehicle's CURRENT altitude, rather than all 8 simultaneously — see the comment on
  // altitudeRingMarks in buildAltitudeRings for why leaving every ring on all the time produced a
  // stray-looking vertical line at any zoomed-out or shallow viewing angle. A decade-wide window
  // keeps 1-2 rings visible near the vehicle at any given altitude (useful "how high am I relative
  // to this milestone" context) without ever having enough of them on screen at once to chain
  // together, and fades each one in/out smoothly by log-distance instead of a hard cutoff so a ring
  // doesn't just pop in/out as the vehicle crosses the window edge.
  const curAlt = !inTransfer && !landed && currentFrame ? Math.max(currentFrame.alt, 1) : null;
  altitudeRingMarks.forEach(function(mark){
    const show = curAlt !== null;
    mark.mesh.visible = show;
    mark.label.visible = show;
    if(show){
      const logDist = Math.abs(Math.log10(mark.alt) - Math.log10(curAlt));
      const fade = Math.max(0, 1 - logDist); // 1 at the same decade, 0 a full decade away
      mark.mesh.material.opacity = 0.18 * fade;
      mark.label.material.opacity = fade;
      if(fade <= 0.01){ mark.mesh.visible = false; mark.label.visible = false; }
    }
  });
  // spaceObjects (the distant decorative planets/satellite) belongs to the near-Earth space view —
  // TRANSFER has its own dedicated destination/Earth markers (transferGroup) and a landed body has
  // its own sky treatment (updateBodyLandingScene), so hide the generic ones in both cases rather
  // than leaving them visible at whatever opacity updateSpaceTransition last left them at.
  if(spaceObjects) spaceObjects.visible = !inTransfer && !landed;
  if(!landed && !inTransfer && landedBodyShellMesh){
    // returning to Earth scenery (e.g. after a reset) following a flight that grew transferBodyMesh
    // toward landed ground — reset it back to its small "distant destination marker" state so the
    // next flight's TRANSFER starts from the same look this one did, rather than picking up mid-landing.
    if(transferBodyMesh){
      transferBodyMesh.scale.setScalar(1);
      transferBodyMesh.position.set(0, transferBodyMesh.position.y, -40);
      transferBodyMesh.visible = true;
      transferBodyMesh.material.opacity = 1;
      transferBodyMesh.material.transparent = false;
    }
    if(transferEarthMesh) transferEarthMesh.visible = true;
    if(transferBodyLabel) transferBodyLabel.visible = true;
    Object.keys(bodyGroundShells).forEach(function(id){ bodyGroundShells[id].visible = false; });
    setLandedBodyShellMesh(null);
    if(scene.userData.skyMesh) scene.userData.skyMesh.visible = true;
    applySkyColors();
  }
}

function animate(){
  requestAnimationFrame(animate);
  if(contextLost) return; // GL context is dead and a reload is already scheduled — stop touching it
  const dt = Math.min(clock.getDelta(), 0.05);
  resetTrailSpawnBudget();

  if(flightActive && !flightPaused && sim){
    accumulator += dt * speedMult;
    let steps = 0;
    // Previously only the LAST of up to 400 physics steps run this frame got drawn — fine at low
    // speed multipliers (1-2 steps/frame), but at higher speedMult, or whenever a slow/stuttering
    // render frame lets the accumulator build up, many simulated seconds of travel could collapse
    // into a single visual placeRocket()/trail-marker call. The rocket's underlying path stayed
    // physically smooth (confirmed by direct simulation testing — every individual simStep moves
    // it a small, continuous distance), but SKIPPING the intermediate frames on screen is exactly
    // what would show up as an occasional visible "hop": one rendered frame silently covering a
    // much bigger jump in world position than its neighboring frames, purely due to a stutter in
    // real wall-clock time, not a physics bug. Fix: draw (and drop a trail marker for) every
    // intermediate step too, not just the final one, so what's on screen always matches the
    // continuous path the physics actually computed, regardless of how frame timing happens to land.
    //
    // TRANSFER is the one exception: a Moon coast is ~260,000 simulated seconds and a Mars coast is
    // ~18,000,000 — stepping those at FIXED_DT(1/60s) with only 400 steps/frame would take real
    // hours (or days) to resolve even at max speedMult, since 400 steps/frame * 60fps * FIXED_DT
    // hard-caps sim-throughput at 24,000 sim-seconds/real-second no matter how high speedMult goes.
    // stepDtFor() gives TRANSFER a much coarser 600s-per-step size (justified in its own comment —
    // it's a smooth, non-stiff closure, not RK4 physics needing fine resolution), and the step
    // count cap is relaxed too, so high time-warp actually delivers on "fast-forward through a
    // multi-day/month coast in seconds to minutes" instead of being silently throttled here.
    // isTransfer/stepCap used to be captured ONCE before this loop started, on the assumption that
    // a single batch never crosses a phase boundary. That's false right at ESCAPE->TRANSFER
    // (captureTransfer() flips sim.phase mid-simStep): the batch would keep running under the OLD
    // (pre-transition, fine-grained) isTransfer/stepCap for its remaining iterations, so the
    // now-600-seconds-per-step TRANSFER coast kept getting stepped AND drawn every single step for
    // the rest of that one rendered frame — hundreds of 600s jumps (up to the leftover 400-step
    // budget) collapsing into whatever WebGL actually painted, which is exactly what read as the
    // vehicle instantly teleporting to interplanetary range and its rotation snapping to the
    // TRANSFER branch's fixed (0, PI/2, 0) coasting attitude — one visible frame, no smooth run-up.
    // Fix: track the phase before each simStep and break the instant it changes, so a phase
    // transition always ends its batch immediately — the transitioning step is drawn once, and the
    // next animate() call starts a fresh batch with isTransfer/stepCap recomputed for the new phase.
    const isTransfer = sim.phase === 'TRANSFER';
    const stepCap = isTransfer ? 4000 : 400;
    while(accumulator > 0 && steps < stepCap){
      const stepDt = Math.min(stepDtFor(sim), accumulator);
      if(stepDt <= 0) break;
      const phaseBefore = sim.phase;
      simStep(sim, stepDt);
      accumulator -= stepDt;
      steps++;
      const frame = sim.history[sim.history.length-1];
      if(frame){
        autoResetSpeedOnTransition(frame);
        if(!isTransfer || steps % 20 === 0 || sim.phase !== 'TRANSFER'){
          // TRANSFER redraws only periodically (every 20th step) — thousands of coast steps can run
          // in a single rendered frame at high warp, and placeRocket()/smoke/trail per-step there
          // would both be visually meaningless (the vehicle isn't near Earth to place against the
          // ascent scene) and needlessly expensive; the transfer view (built in updateTransferScene)
          // is driven once per rendered frame from currentFrame instead, same as any other phase.
          placeRocket(frame.alt, frame.boosterAttached, frame.downrange, frame.flightPathAngle, frame.throttle, frame.phase, frame.body);
        }
        if(!isTransfer){
          maybeSpawnSmoke(frame);
          maybeSpawnTrail(frame);
        }
      }
      if(sim.phase === 'DONE') break;
      if(sim.phase !== phaseBefore) break; // phase just changed mid-batch (e.g. ESCAPE->TRANSFER, or TRANSFER->ARRIVAL) — stop so the next animate() call re-derives isTransfer/stepCap instead of finishing this batch under stale ones
    }
    if(accumulator > 2 * stepDtFor(sim)) accumulator = 0; // drop a runaway backlog (e.g. tab was backgrounded) instead of burning through it over many future frames
    const last = sim.history[sim.history.length-1];
    if(last){
      updateHud(last);
      updateEngineVisuals(last);
      renderMissionLog();
      if(document.visibilityState === 'visible'){
        Sound.updateEngineBed(engineThrustIntensity, last.alt, last.vel || 0);
      } else {
        Sound.silenceEngineBed();
      }
    }
    if(sim.phase === 'DONE'){
      // Only a landing/crash has an actual touchdown moment worth lingering on — pad failure,
      // escape, orbit-reached, and the 60-minute timeout all end without one, so they still cut to
      // the result card immediately.
      if(sim.landingOutcome && touchdownHoldT < TOUCHDOWN_HOLD_SEC){
        touchdownHoldT += dt; // real time, deliberately NOT dt*speedMult — the hold is a fixed real-world pause regardless of what warp the descent was flown at
      } else {
        finishFlight();
      }
    } else {
      if(sim.t > seekBar.max) seekBar.max = sim.t;
      seekBar.value = sim.t;
      updateSeekLabel(sim.t);
    }
  }

  applySceneMode();
  updateSmoke(dt);
  // Trail markers are spawned at a cadence gated in SIMULATED seconds (maybeSpawnTrail's trailAccum,
  // advanced by FIXED_DT once per physics step above) — aging them by real dt here mismatches that
  // basis at any time-warp above 1x. See the comment on updateTrail for the full explanation; the
  // short version is that flightActive-and-running is exactly when time-warp can be in effect, so
  // that's exactly when trail aging needs the same dt*speedMult scaling the physics loop itself uses.
  updateTrail((flightActive && !flightPaused && sim) ? dt*speedMult : dt);
  updateClouds(dt, sim ? sim.vel : 0);
  updateCamera(dt);
  updateExhaustLight();
  // audio bed while nothing is actively flying (paused, setup screen, reviewing a finished
  // flight) — the live-flight case is driven right next to updateEngineVisuals(last) above,
  // where the actual sim frame (with .vel) is in scope; this just makes sure the bed can't
  // keep ringing once that branch stops running.
  if(!(flightActive && !flightPaused)){
    Sound.silenceEngineBed();
  }
  // keep the sky dome (and starfield, which uses the same skybox trick) centered on the camera —
  // otherwise, as the camera pulls back and climbs with the rocket, the dome's own curvature shows
  // through as a false "hill" silhouette where its lower rim dips below the flat ground plane's horizon
  if(scene.userData.skyMesh){
    scene.userData.skyMesh.position.set(camera.position.x, 0, camera.position.z);
  }
  if(starField){
    starField.position.set(camera.position.x, 0, camera.position.z);
  }
  if(spaceObjects){
    spaceObjects.position.set(camera.position.x, 0, camera.position.z);
  }
  // Roll the star/planet shell around the camera as a function of downrange distance travelled, so
  // a long unpowered coast (escape/orbit) still visibly drifts landmarks past instead of looking
  // frozen — stars alone are so far away that real parallax from the ship's own motion would be
  // imperceptible, so this stands in for that parallax. Driven off currentFrame (whatever is actually
  // on screen right now — live flight, skip-ahead, or a review-mode scrub target) rather than `sim`
  // itself, which freezes at its final live values once a flight ends and does NOT track the seek
  // bar during review, and rather than accumulated real-world dt, so this stays exactly in sync no
  // matter how time advanced — scrubbing the seek bar backward rolls the sky back too, instead of it
  // only ever winding forward or (as it did before this fix) not moving in review mode at all.
  if(currentFrame){
    const spaceMixNow = spaceMixForAltitude(currentFrame.alt);
    // sqrt compresses very large downrange distances (an escape trajectory racks up a lot of it) so
    // the shell keeps rolling visibly slowly instead of spinning many full turns; sign preserved so
    // scrubbing backward reverses the roll direction too.
    const dr = currentFrame.downrange || 0;
    const rollTarget = Math.sign(dr) * Math.sqrt(Math.abs(dr)) * 0.00031 * spaceMixNow;
    setSpaceRoll(rollTarget);
    if(starField) starField.rotation.y = spaceRoll;
    if(spaceObjects){
      spaceObjects.rotation.y = spaceRoll;
      spaceObjects.rotation.x = spaceRoll * 0.18;
    }
  }
  // Earth's atmosphere-transition (sky darkening, fog falloff, shell tint) only means something
  // for an Earth-relative altitude — skip it entirely once the vehicle has left on an interplanetary
  // transfer or arrived at the target body (updateBodyLandingScene/buildTransferScene own the sky/
  // fog/shell look for those phases instead; letting this run too would fight their settings every
  // single frame, since it unconditionally overwrites scene.fog.near/far and earthShellMesh's tint).
  const onEarthScene = !(sim && (sim.phase === 'TRANSFER' || sim.arrivedAtBody));
  if(onEarthScene){
    const spaceMix = updateSpaceTransition(currentFrame ? currentFrame.alt : 0);
    setCloudsSpaceMix(spaceMix);
    // A flat, fogged ground plane viewed from any real elevation hits the fog's far distance almost
    // immediately along the grazing horizon ray (ground distance along that ray grows toward infinity
    // as the view angle approaches horizontal), which reads as a false "hill" of haze cutting across
    // the view well before the true horizon. Scaling both the fog distance and its near/far spread
    // with camera height pushes that transition band out past what's visible at typical viewing
    // angles, and widening the band as it goes keeps the falloff a soft haze instead of a hard edge.
    // Above the Karman line there is no atmosphere to haze the view at all, so fog is faded out
    // entirely as spaceMix rises rather than just pushed further away.
    if(scene.fog){
      const camHeight = Math.max(camera.position.y, 6);
      const fogScale = (1 + camHeight * 40) / Math.max(1 - spaceMix, 0.02);
      scene.fog.near = 1500 * fogScale;
      scene.fog.far = 9000 * fogScale;
    }
  }
  updateOrbitPathVisual();
  renderer.render(scene, camera);
}

export { animate, placeRocket, resetTouchdownHold, worldAltitude, worldDownrange };
