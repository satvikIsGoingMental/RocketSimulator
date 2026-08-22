import * as THREE from "three";
import { camMode, orbitState, userZoom } from "./controls.js";
import { engineThrustIntensity } from "./effects.js";
import { rocketDims } from "./rocket-model.js";
import { camera, rocketGroup } from "./three-setup.js";

// updateCamera's chase/ground modes smoothly LERP camera.position toward a target derived from
// rocketGroup's world position. PAD/BOOST/CORE/COAST/ORBIT/ESCAPE/TRANSFER/ARRIVAL/DESCENT/
// LANDING-BURN all share one continuous world-space mapping (worldAltitude — see its comment and
// placeRocket) all the way to touchdown, so the lerp just runs continuously across every phase with
// no snap needed anywhere: the rocket never jumps, so neither does the camera. stageJustChanged is
// kept (always false in practice now) rather than removed outright, so a future phase that DOES need
// a real cut has somewhere to plug in without re-deriving this plumbing.
let lastCameraStage = null;
function currentCameraStage(){
  return 'flight';
}
function updateCamera(dt){
  if(!rocketGroup) return;
  const target = new THREE.Vector3();
  rocketGroup.getWorldPosition(target);
  const dims = rocketDims;
  const rocketHeight = dims ? dims.coreLen*dims.displayScale : 20;
  target.y += rocketHeight*0.35;

  const stage = currentCameraStage();
  const stageJustChanged = stage !== lastCameraStage;
  lastCameraStage = stage;

  // Auto-framing keeps the rocket roughly on-screen as it climbs, but must never be the only thing
  // driving distance: it's always composed with userZoom, a free multiplier driven by the mouse
  // wheel / pinch in every camera mode, so the user can zoom in or out at any altitude or speed
  // regardless of what auto-framing is doing.
  //
  // This used to asymptote to a fixed ceiling (1 + 5.5*(1-exp(-worldY/4000))) instead of growing
  // without bound, on the theory that unbounded growth would let camera distance "balloon" at high
  // time-multipliers. But worldY (see worldAltitude()) is ALREADY a heavily log-compressed stand-in
  // for real altitude — by ~100km up its slope has decayed to under 1% of its liftoff value — while
  // the capped autoFrame above only ever reached a max of 6.5x zoom-out. The two compressions don't
  // cancel: camera DISTANCE stayed almost frozen (~57-80 world units, confirmed by direct
  // instrumentation) for the entire climb from ~1km to well past 100km, while worldY itself kept
  // slowly climbing underneath it. In a chase cam that always looks at the target, a camera sitting
  // at a near-fixed distance while the target's height creeps up VERY slowly is exactly what read as
  // the vehicle "hitting an invisible wall" or "flying through friction" mid-ascent, even though the
  // real altitude (and worldY) were still climbing the whole time, at full thrust, with no cap
  // anywhere in the physics — this was purely a camera-framing bug, not a flight/physics one. Also
  // confirmed independent of the gravity-turn tilt bug fixed earlier: it reproduces identically in
  // 'straight-up' flight-profile mode, where no turning happens at all.
  //
  // Fix: let zoomOut grow linearly with worldY, unbounded, so camera distance stays roughly
  // PROPORTIONAL to the rocket's world-space height instead of saturating — the rocket keeps a
  // steady, visible rate of motion in frame at any altitude, all the way to lunar/interplanetary
  // range, the same way the original (pre-ceiling) implementation worked. That original version was
  // reverted over a fear of single-frame "ballooning" at high speedMult, but the actual cause of any
  // such jump was a separate bug in the animate() batch loop (stale isTransfer/stepCap surviving a
  // mid-batch phase change — since fixed) letting many simulated seconds of motion collapse into one
  // rendered frame; it was never inherent to unbounded linear zoomOut. camera.position.lerp() below
  // already smooths camTargetPos every frame regardless, so even a large single-frame change in
  // zoomOut still animates smoothly rather than snapping.
  const baseDist = Math.max(24, (dims ? dims.coreLen*dims.displayScale : 20) * 1.4);
  const worldY = rocketGroup.position.y - 3;
  const AUTO_FRAME_SCALE = 90; // world units of worldY per +1x of zoom-out
  const autoFrame = 1 + Math.max(worldY,0) / AUTO_FRAME_SCALE;
  const zoomOut = autoFrame * userZoom;

  if(camMode === 'chase'){
    const dir = new THREE.Vector3(34, 14, 46).normalize().multiplyScalar(baseDist * zoomOut);
    const camTargetPos = new THREE.Vector3(target.x + dir.x, target.y + dir.y, target.z + dir.z);
    if(stageJustChanged) camera.position.copy(camTargetPos);
    else camera.position.lerp(camTargetPos, 1 - Math.pow(0.001, dt));
    camera.lookAt(target);
  } else if(camMode === 'ground'){
    // A ground/pad camera's whole appeal is watching the vehicle rise up through frame from a fixed
    // vantage near the tower — unlike chase, it should NOT fly outward to keep chasing the target's
    // altitude, or it loses the horizon entirely (the old Math.sqrt(autoFrame)-scaled distance, with
    // a shallow fixed-ratio direction vector, sent the camera far out while barely climbing, forcing
    // lookAt(target) to pitch nearly straight up into empty sky within seconds of liftoff). Position
    // now only eases outward a little (capped growth) to keep a fast-climbing vehicle from filling
    // the frame, and the look-at target's height is capped rather than following the rocket forever,
    // so the camera keeps a grounded, watching-from-the-pad angle instead of craning skyward.
    const groundDist = Math.max(baseDist*1.2, 46) * Math.min(1.6, Math.sqrt(autoFrame)) * userZoom;
    const dir = new THREE.Vector3(38, 6, 44).normalize().multiplyScalar(groundDist);
    const fixed = new THREE.Vector3(dir.x, Math.max(dir.y, 6), dir.z);
    if(stageJustChanged) camera.position.copy(fixed);
    else camera.position.lerp(fixed, 1 - Math.pow(0.0005, dt));
    const lookTarget = target.clone();
    const maxLookHeight = groundDist * 0.55; // bounds the look-up angle regardless of how high the vehicle has climbed
    lookTarget.y = Math.min(lookTarget.y, maxLookHeight);
    camera.lookAt(lookTarget);
  } else if(camMode === 'orbit'){
    const d = orbitState.dist * userZoom;
    const x = target.x + d*Math.cos(orbitState.pitch)*Math.sin(orbitState.yaw);
    const y = target.y + d*Math.sin(orbitState.pitch);
    const z = target.z + d*Math.cos(orbitState.pitch)*Math.cos(orbitState.yaw);
    camera.position.set(x,y,z);
    camera.lookAt(target);
  }
  applyCameraShake(dt, worldY, zoomOut);
}

// Low-frequency rumble standing in for the acoustic/structural shaking a full-thrust engine at close
// range actually produces — real launch footage always has this, and its total absence read as an
// oddly "floaty" liftoff despite the flame/light/smoke work above. Strongest right at the pad, fading
// out with altitude (by ~4x the pad tower height) since there's nothing left nearby to couple the
// vibration through once the vehicle has cleared the tower, and scaled down by zoomOut so it doesn't
// read as an exaggerated wobble once the camera has pulled back far during a high-altitude ascent.
let shakeSeed = Math.random()*1000;
function applyCameraShake(dt, worldY, zoomOut){
  shakeSeed += dt;
  const altFade = Math.max(0, 1 - worldY/90);
  const mag = engineThrustIntensity * altFade * 0.55 / Math.max(zoomOut, 1);
  if(mag < 0.001) return;
  const ox = (Math.sin(shakeSeed*47.3) + Math.sin(shakeSeed*113.7)*0.5) * mag;
  const oy = (Math.sin(shakeSeed*61.1 + 1.7) + Math.sin(shakeSeed*97.0)*0.5) * mag * 0.6;
  const oz = (Math.sin(shakeSeed*53.9 + 3.1) + Math.sin(shakeSeed*88.4)*0.5) * mag;
  camera.position.x += ox;
  camera.position.y += oy;
  camera.position.z += oz;
}

export { updateCamera };
