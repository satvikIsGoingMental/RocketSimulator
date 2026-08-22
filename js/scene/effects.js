import * as THREE from "three";
import { rockets } from "../data/handoff.js";
import { FIXED_DT, sim } from "../flight/controller.js";
import { selectedRocketId } from "../ui/roster-ui.js";
import { boosterFlameMeshes, flameMeshes, rocketDims } from "./rocket-model.js";
import { softParticleTexture } from "./textures.js";
import { clock, exhaustLight, rocketGroup, scene } from "./three-setup.js";

// Live exhaust smoke puffs. Owned here alongside the contrail below — both are particle pools that
// only this module spawns into and ages out.
let smokeParticles = [];

/* ---------------- velocity contrail — a persistent speed cue at every altitude, not just near the pad ---------------- */
// Ground smoke only spawns below 400m, so above that there's nothing in the scene reacting to
// speed. This trail is a fixed-length ribbon of fading markers dropped behind the rocket every
// frame; how far apart consecutive markers land is a direct, visible readout of velocity —
// tightly packed while climbing slowly, stretched into long dashes once the vehicle is moving
// fast. Independent of the exhaust smoke system above.
const TRAIL_MAX = 90;
let trailPoints = []; // { mesh, life }
let trailAccum = 0;
// Called by flight/controller.js's resetFlightView(). Each particle owns a cloned material
// (independent fade-out) but shares one of the module-level geometries — dispose only the material
// here, never the geometry, since the geometry is reused by every future particle for the rest of
// the page's lifetime.
function clearParticles(){
  smokeParticles.forEach(function(p){ scene.remove(p.mesh); p.mesh.material.dispose(); });
  smokeParticles = [];
  trailPoints.forEach(function(p){ scene.remove(p.mesh); p.mesh.material.dispose(); });
  trailPoints = [];
}
// Shared template material for every trail marker — spawning used to build a brand-new
// SphereGeometry+MeshBasicMaterial (a real GPU buffer upload) per marker, up to ~50/sec at high
// speed. Sprites need no geometry at all, and each one still gets its own material.clone() (cheap —
// no GPU upload, just a JS object referencing the same compiled program + texture) since opacity
// fades independently per marker over its lifetime.
let trailMatTemplate = null;
function spawnTrailMarker(worldPos, speedFrac){
  if(!trailMatTemplate){
    trailMatTemplate = new THREE.SpriteMaterial({ map:softParticleTexture(), color:0xf3f1ea, transparent:true, opacity:0.5, depthWrite:false });
  }
  if(trailPoints.length > TRAIL_MAX){
    const old = trailPoints.shift();
    scene.remove(old.mesh);
    old.mesh.material.dispose();
  }
  const r = (0.7 + speedFrac*1.0) * 2;
  const m = new THREE.Sprite(trailMatTemplate.clone());
  m.scale.setScalar(r);
  m.position.copy(worldPos);
  scene.add(m);
  // maxLife shrinks with speed (3s standing still down to ~0.5s near max velocity) so the trail's
  // ON-SCREEN LENGTH stays bounded rather than its time span. A fixed 3s lifetime made sense for the
  // trail's original purpose (a local "just happened" cue during ascent, where speed tops out around
  // a few hundred m/s), but once vehicles routinely coast at 4000+ m/s post-MECO, "the last 3 seconds
  // of history" is several kilometers of real distance — combined with TRAIL_MAX(90) markers spawning
  // fast enough at that speed to all stay under maxLife at once, the trail stopped reading as a short
  // motion cue and instead traced almost the entire visible flight path as one solid streak.
  const maxLife = 3.0 - speedFrac*2.5;
  trailPoints.push({ mesh:m, life:0, maxLife });
}
// dt here is SIMULATED seconds elapsed this frame (dt*speedMult from the caller), not real wall-
// clock time. maybeSpawnTrail's own spawn cadence (trailAccum, gated in FIXED_DT sim-seconds) was
// already sim-time-based, but this aging used to take raw real-world dt — at any real time-warp
// above 1x that mismatch meant markers were being CREATED in proportion to simulated time (many per
// real second once speedMult ramps up) while only FADING in proportion to real time, so the trail's
// on-screen length grew without bound the higher speedMult went: a ballistic coast fast-forwarded at
// 60x could spawn hundreds of markers within a couple of real seconds, and since none of them had
// had a chance to age out yet, they'd all sit at high opacity simultaneously — stringing together
// into what looked like a solid line tracing minutes of flight path instead of the intended "last
// few seconds of motion" cue. Aging by simulated time instead keeps the trail's SIMULATED-time
// length constant (maxLife sim-seconds of history), so it shortens automatically as speedMult rises
// rather than ballooning.
function updateTrail(dt){
  for(let i=trailPoints.length-1;i>=0;i--){
    const p = trailPoints[i];
    p.life += dt;
    const t = p.life/p.maxLife;
    if(t >= 1){
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      trailPoints.splice(i,1);
      continue;
    }
    p.mesh.material.opacity = 0.5*(1-t);
  }
}
// Caps how many NEW trail markers a single rendered frame is allowed to spawn, reset once per
// animate() call (see trailSpawnsThisFrame below). At high time-warp, animate()'s physics loop can
// run up to 400 steps in one rendered frame, and maybeSpawnTrail's own interval (in SIMULATED
// seconds, via trailAccum/FIXED_DT) does nothing to limit that — a fast-moving vehicle can clear its
// spawn interval on many of those 400 steps, dropping dozens of markers that are all still "brand
// new" (life=0) the instant the frame's single updateTrail(dt) call runs afterward. Even with
// updateTrail's fade now correctly scaled to simulated time (see the comment there), a burst that
// large still renders as one solid-looking streak for the first frame or two before fading — capping
// the burst itself, not just how fast it fades afterward, is what actually prevents that flash.
const TRAIL_SPAWNS_PER_FRAME_MAX = 3;
let trailSpawnsThisFrame = 0;
// Zeroed once per rendered frame by flight/loop.js's animate().
function resetTrailSpawnBudget(){ trailSpawnsThisFrame = 0; }
function maybeSpawnTrail(f){
  const speed = Math.abs(f.vel);
  if(speed < 20) return; // slow climb near the pad already has exhaust smoke for reference
  trailAccum += FIXED_DT;
  // spawn cadence scales with speed: fast flight drops markers more often, which combined with
  // their fixed lifetime makes the trail visibly longer at higher velocity
  const interval = Math.max(0.02, 0.5 - speed*0.0006);
  if(trailAccum > interval){
    trailAccum = 0;
    if(trailSpawnsThisFrame >= TRAIL_SPAWNS_PER_FRAME_MAX) return;
    trailSpawnsThisFrame++;
    const worldPos = new THREE.Vector3();
    rocketGroup.getWorldPosition(worldPos);
    const dims = rocketDims;
    worldPos.y -= dims ? dims.coreLen*dims.displayScale*0.5 : 3;
    const speedFrac = Math.min(speed/3000, 1);
    spawnTrailMarker(worldPos, speedFrac);
  }
}

/* ---------------- smoke / exhaust particles ---------------- */
// Soft billboarded sprites (see softParticleTexture) instead of low-poly spheres — the same fix as
// the velocity trail above, and doubly so here since smoke is the thing the camera sits closest to
// during every liftoff. Each puff also cools from a warm near-flame tint to neutral gray-white as it
// ages, standing in for hot exhaust gas mixing with and diluting into cooler ambient air as it rises
// and disperses, rather than every particle holding one flat color for its whole life.
let smokeMatTemplate = null;
const SMOKE_HOT_COLOR = new THREE.Color(0xffcf9e);
const SMOKE_COOL_COLOR = new THREE.Color(0xdddad2);
function spawnSmoke(worldPos, scale){
  if(smokeParticles.length > 260) return;
  if(!smokeMatTemplate){
    smokeMatTemplate = new THREE.SpriteMaterial({ map:softParticleTexture(), color:0xdddad2, transparent:true, opacity:0.55, depthWrite:false });
  }
  const m = new THREE.Sprite(smokeMatTemplate.clone());
  m.material.color.copy(SMOKE_HOT_COLOR);
  m.position.copy(worldPos);
  m.position.x += (Math.random()-0.5)*2*scale;
  m.position.z += (Math.random()-0.5)*2*scale;
  m.scale.setScalar((1.1*scale + Math.random()*0.7*scale) * 1.8);
  scene.add(m);
  smokeParticles.push({ mesh:m, life:0, maxLife: 2.2+Math.random()*1.2, vy: 2+Math.random()*1.5, vx:(Math.random()-0.5)*1.2, vz:(Math.random()-0.5)*1.2 });
}

function updateSmoke(dt){
  for(let i=smokeParticles.length-1;i>=0;i--){
    const p = smokeParticles[i];
    p.life += dt;
    const t = p.life/p.maxLife;
    if(t >= 1){
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      smokeParticles.splice(i,1);
      continue;
    }
    p.mesh.position.y += p.vy*dt;
    p.mesh.position.x += p.vx*dt;
    p.mesh.position.z += p.vz*dt;
    p.mesh.scale.multiplyScalar(1 + dt*0.6);
    p.mesh.material.opacity = 0.55 * (1-t);
    p.mesh.material.color.copy(SMOKE_HOT_COLOR).lerp(SMOKE_COOL_COLOR, Math.min(1, t*2.2));
  }
}
// Drives one layered flame group (see makeFlame): throttle sets overall plume length/brightness,
// a fast per-engine-seeded sine+noise flicker keeps a cluster of engines from pulsing in lockstep,
// and vacuum expansion (thinner air -> plume flares wider and longer, same physical effect that
// gives real upper-stage engines their long, wide bells-of-fire look) is approximated directly from
// altitude rather than modeling actual back-pressure.
const FLAME_EXPANSION_REF_ALT = 30000; // m — altitude by which the plume is essentially fully expanded
function driveFlame(flGroup, throttle, expansion, tNow){
  const plume = flGroup.userData.plume;
  flGroup.visible = throttle > 0.001;
  if(!flGroup.visible || !plume) return;
  const seed = plume.seed;
  const flicker = 1 + Math.sin(tNow*37 + seed)*0.05 + Math.sin(tNow*91 + seed*3)*0.03 + (Math.random()-0.5)*0.05;
  const lenMul = (0.82 + throttle*0.28) * flicker;
  const widthMul = (0.9 + throttle*0.18) * (1 + expansion*0.9) * (1 + (Math.random()-0.5)*0.03);
  const lengthExpand = 1 + expansion*1.6;
  const coreLenScale = plume.radius*3.1*lenMul;
  const glowLenScale = plume.radius*4.6*lenMul*lengthExpand;
  plume.core.scale.set(plume.radius*widthMul*0.75, coreLenScale, plume.radius*widthMul*0.75);
  plume.glow.scale.set(plume.radius*widthMul*(1+expansion*0.6), glowLenScale, plume.radius*widthMul*(1+expansion*0.6));
  // keep the cone's wide base (at local y=+2 pre-scale after the 180 deg flip) pinned to the nozzle
  // exit as length scale changes, instead of letting the recentered cone drift upward into the hull
  // at high throttle/expansion the way a fixed creation-time offset alone would.
  plume.core.position.y = -coreLenScale*2;
  plume.glow.position.y = -glowLenScale*2;
  plume.glow.material.opacity = (0.4 + throttle*0.25) * flicker;
  plume.core.material.opacity = (0.75 + throttle*0.2) * flicker;
  plume.diamonds.forEach(function(d, i){
    d.visible = expansion < 0.7; // shock diamonds wash out once the plume is fully vacuum-expanded
    d.material.opacity = 0.5 * (1-expansion) * flicker;
    d.position.y = -plume.radius*(1.4 + i*1.35)*lenMul*lengthExpand;
  });
}

let engineThrustIntensity = 0; // 0..1, smoothed — read by the exhaust light and ground-rumble camera shake
function updateEngineVisuals(f){
  const tNow = clock ? clock.elapsedTime : 0;
  const expansion = Math.max(0, Math.min(1, (f.alt||0) / FLAME_EXPANSION_REF_ALT));
  const coreOn = f.throttle > 0 && (sim.t < sim.v.tbCore);
  if(flameMeshes[0]){
    flameMeshes[0].children.forEach(function(fl){ driveFlame(fl, coreOn ? f.throttle : 0, expansion, tNow); });
  }
  const boosterOn = f.boosterAttached && sim.t < sim.v.boostBurnTime;
  boosterFlameMeshes.forEach(function(fl){ driveFlame(fl, boosterOn ? f.throttle : 0, expansion, tNow); });

  const targetIntensity = (coreOn || boosterOn) ? Math.max(f.throttle, 0.15) : 0;
  engineThrustIntensity += (targetIntensity - engineThrustIntensity) * 0.35;
}

// Positions the shared exhaust point light (see initThree) at the rocket's engine base each frame
// and fades its intensity with engineThrustIntensity, so throttle now has a visible lighting effect
// on the vehicle/pad/ground rather than only the flame mesh itself changing. Skipped during TRANSFER
// and while landed at another body — those scenes are staged far from the pad/ground geometry this
// light is meant to rake across, and updateBodyLandingScene/buildTransferScene own their own lighting.
function updateExhaustLight(){
  if(!exhaustLight || !rocketGroup) return;
  const inTransfer = !!(sim && sim.phase === 'TRANSFER');
  const landed = !!(sim && sim.arrivedAtBody);
  if(inTransfer || landed || engineThrustIntensity < 0.01){
    exhaustLight.intensity = 0;
    return;
  }
  const base = new THREE.Vector3();
  rocketGroup.getWorldPosition(base);
  const dims = rocketDims;
  base.y -= dims ? dims.coreLen*dims.displayScale*0.5 : 3;
  exhaustLight.position.copy(base);
  // 4.5 is a bright-but-not-blown-out ceiling tuned against the pad's MeshStandardMaterial albedo;
  // a small flicker term riding on the same intensity keeps the ground/pad glow alive in sync with
  // the flame mesh's own flicker instead of looking like a flat, static wash of light.
  const flicker = 1 + (Math.random()-0.5)*0.08;
  exhaustLight.intensity = engineThrustIntensity * 4.5 * flicker;
}

let smokeAccum = 0;
function maybeSpawnSmoke(f){
  if(f.throttle <= 0 || f.alt > 400) { return; }
  smokeAccum += FIXED_DT;
  if(smokeAccum > 0.05){
    smokeAccum = 0;
    const worldPos = new THREE.Vector3();
    rocketGroup.getWorldPosition(worldPos);
    worldPos.y = Math.max(worldPos.y - (rocketDims.coreLen*rocketDims.displayScale*0.5), 1);
    const sc = rocketDims.displayScale * (rockets.find(x=>x.id===selectedRocketId).diam/3 + 0.5);
    spawnSmoke(worldPos, sc);
  }
}

export { clearParticles, engineThrustIntensity, maybeSpawnSmoke, maybeSpawnTrail, resetTrailSpawnBudget, updateEngineVisuals, updateExhaustLight, updateSmoke, updateTrail };
