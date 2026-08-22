import { BODIES, G0, MU, R_ATMOS, R_PLANET } from "../core/constants.js";
import { destination, flightProfile } from "../core/mission-config.js";
import { noseCd } from "../data/rockets.js";
import { windRadialVelocity, windTangentialVelocity } from "./weather.js";

/* ================================================================================
   PHYSICS — real two-body orbital mechanics.

   Earlier this simulator only integrated straight-up vertical motion under a constant "-g0,
   always down" field. That made a genuine orbit or escape trajectory impossible in principle: a
   purely vertical velocity, however large, always falls back through its own launch point once
   gravity turns it around — there's no way to "keep traveling into space" that way, which is
   exactly what was asked for. The fix is a real restricted two-body model: position and velocity
   are 2D vectors around a spherical planet's center, gravity always points at that center and
   falls off with 1/r² (not a flat downward constant), and the ascent follows a gravity-turn pitch
   program that bends thrust from vertical toward horizontal — because orbital velocity IS
   horizontal velocity. Get that horizontal component fast enough before MECO and the trajectory
   closes into a real ellipse that keeps coasting around the planet indefinitely (an actual orbit,
   propagated every frame via vis-viva / Kepler, not a freeze-in-place fake). Get it faster than
   local escape velocity and the orbit's specific energy goes positive — a genuine hyperbolic
   escape trajectory that never comes back. Falling short of either simply means gravity wins and
   the vehicle comes back down, under the same integrator, no special-casing required.
   ================================================================================ */
function airDensity(h){
  const rho0 = 1.225, H = 8500;
  return rho0 * Math.exp(-Math.max(h,0) / H);
}

function deriveVehicle(r){
  const mstructCore = r.fstruct * r.mprop;
  const mstructBoost = r.fstruct * r.mboost * r.nboost;
  const mBoostProp = r.mboost * r.nboost;
  const mf = r.mpay + mstructCore + mstructBoost;           // gross dry mass at liftoff, boosters included (used only for the pre-flight total-dv estimate below)
  const mfCore = r.mpay + mstructCore;                       // dry mass once booster structure is jettisoned at separation — the real in-flight floor for mass depletion, T/W and dv-remaining after sep
  const m0 = mf + r.mprop + mBoostProp;                      // gross liftoff mass
  const ve = r.isp * G0;
  const dv = (m0 > mf && mf > 0) ? ve * Math.log(m0/mf) : 0;

  const thrustN = r.thrust * 1000;
  const boostThrustN = r.fboost * 1000 * r.nboost;
  const coreThrustTotalN = thrustN;               // core engines alone
  const totalThrustN = thrustN + boostThrustN;     // core + boosters together

  const mdotCore = ve > 0 ? coreThrustTotalN / ve : 0;
  const mdotBoost = ve > 0 ? boostThrustN / ve : 0;
  const mdotTotal = mdotCore + mdotBoost;

  const tbBoost = mdotBoost > 0 ? mBoostProp / mdotBoost : 0;   // boosters burn out first (typ. shorter/denser burn)
  const tbCore = mdotCore > 0 ? r.mprop / mdotCore : 0;
  // boosters assumed to burn out at or before core; clamp booster burn to <= core burn for a believable separation moment
  const boostBurnTime = r.nboost > 0 ? Math.min(tbBoost, tbCore) || tbBoost : 0;

  const cd = noseCd[r.nose] || 0.4;
  const frontalArea = Math.PI * Math.pow(r.diam/2, 2);

  const weight0 = m0 * G0;
  const tw = totalThrustN / weight0;

  // Target parking-orbit altitude, used to size the gravity-turn program (how quickly to pitch over).
  const targetOrbitAlt = 200000;

  return {
    mstructCore, mstructBoost, mBoostProp, mf, mfCore, m0, ve, dv,
    thrustN, boostThrustN, totalThrustN, mdotCore, mdotBoost, mdotTotal,
    tbCore, boostBurnTime, cd, frontalArea, tw, targetOrbitAlt,
  };
}

/* ---------------- gravity-turn pitch program ----------------
   Returns the thrust-pointing angle from local vertical (0 = straight up, PI/2 = straight
   horizontal), as a function of altitude. Modeled on the real-world shape of an ascent profile:
   ride straight up through the thick lower atmosphere until a kickoff altitude (keeps max-Q
   manageable and avoids wasting horizontal thrust while drag is fiercest), then smoothly roll
   the thrust vector over toward horizontal so that by the target orbital altitude the vehicle is
   thrusting almost entirely downrange, the way real gravity-turn ascents fly. A smoothstep is
   used instead of a linear ramp so the pitchover starts and ends gently rather than kinking. */
function pitchAngleForAltitude(alt, targetAlt){
  if(flightProfile === 'straight-up') return 0; // thrust stays dead vertical for the whole flight
  const KICKOFF_ALT = 1200;              // m — straight up below this
  const PITCH_END_ALT = Math.max(targetAlt * 0.85, KICKOFF_ALT + 5000); // mostly horizontal by here
  if(alt <= KICKOFF_ALT) return 0;
  if(alt >= PITCH_END_ALT) return Math.PI/2 * 0.97; // never fully flatten to exactly horizontal — keeps a slight lofting margin
  const t = (alt - KICKOFF_ALT) / (PITCH_END_ALT - KICKOFF_ALT);
  const smooth = t*t*(3 - 2*t); // smoothstep
  return smooth * (Math.PI/2 * 0.97);
}

/* Simulation state machine: integrates position/velocity vectors under thrust, gravity, drag. */
function makeSim(r){
  const v = deriveVehicle(r);
  return {
    rocket:r, v,
    t:0,
    // position vector, planet center at origin; pad sits on the +y axis at the surface
    x: 0, y: R_PLANET,
    vx: 0, vy: 0,
    alt:0,          // scalar height above surface, kept in sync every step for the HUD/3D scene
    vel:0,           // scalar speed, ditto
    downrange:0,      // m, UNWRAPPED arc length traveled along the surface since liftoff — keeps
                      // growing (or shrinking) monotonically with orbit direction, never wrapping,
                      // so the 3D scene never has to jump the vehicle across the screen when the
                      // underlying angle from the planet's center crosses +-pi radians (see
                      // syncScalars below for why a raw atan2() here would do exactly that)
    lastTheta:0,      // rad, previous frame's raw (wrapped) angle from +y — used only to detect
                      // and unwrap atan2's +-pi seam frame to frame
    downrangeAngle:0, // rad, cumulative unwrapped angle traveled — downrange = R_PLANET * this
    accel:0,
    mass:v.m0,
    boosterAttached: r.nboost > 0,
    boosterSeparated:false,
    coreBurnout:false,
    earlyMECO:false,          // destination flights only — true once core cuts off early on confirmed escape, banking leftover propellant for the landing burn (see simStep)
    apogeeLogged:false,
    reachedOrbit:false,       // stable closed orbit achieved (periapsis clears the ground)
    reachedEscape:false,      // hyperbolic escape achieved (specific energy >= 0)
    orbitCoast:false,         // now propagating a closed (periapsis-clears-ground) orbit analytically each frame, forever
    escapeCoast:false,        // now integrating outward on an escape trajectory
    ballisticCoast:false,     // now propagating a BOUND-but-suborbital ellipse analytically while above the atmosphere interface
    orbit:null,               // { a, e, apoapsis, periapsis, period, theta0 } once a bound orbit (stable or suborbital-ballistic) is captured
    maxAlt:0, maxVel:0, maxQ:0, maxAcc:0,
    q:0,
    phase:'PAD', // PAD -> BOOST -> CORE -> COAST -> (ORBIT | ESCAPE | TRANSFER | ARRIVAL | DESCENT | LANDING-BURN) -> DONE
    landingBurnStarted:false, // true once a landing burn has been attempted, so the suicide-burn
                               // ignition trigger only ever fires once per flight (a real guidance
                               // computer doesn't stutter the engine on and off hunting for the
                               // "right" altitude — it commits once it ignites)
    landingOutcome:null,      // null while airborne/undecided; 'soft' | 'crash' once touchdown occurs
    log:[],
    history:[], // recorded frames for scrubbing after completion

    // ---------------- interplanetary transfer state (see BODIES / TRANSFER phase in simStep) ----------------
    destination: destination,           // snapshot at launch — mid-flight destination changes don't retarget an already-flying vehicle
    body: destination !== 'earth-orbit' ? BODIES[destination] : null,
    transferDistance: 0,     // m, remaining distance to target body center, only meaningful during TRANSFER
    transferSpeed: 0,        // m/s, closing speed along the transfer line
    transferTotalDistance: 0,// m, initial Earth-departure-to-target distance, for progress-bar purposes
    transferStartR: 0,       // m, real Earth-centered radius at the moment TRANSFER began (see captureTransfer) — anchors the continuous ascent-to-transfer world mapping in placeRocket/updateTransferScene
    arrivedAtBody: false,    // true once the SOI handoff to target-centric coordinates has happened
    landedBody: null,        // 'moon' | 'mars' | null — which body landingOutcome actually refers to
  };
}

function syncScalars(s){
  const r = Math.hypot(s.x, s.y);
  s.alt = r - R_PLANET;
  s.vel = Math.hypot(s.vx, s.vy);
  // Downrange arc length from the pad's longitude, UNWRAPPED. atan2(x,y) is only defined mod 2*pi,
  // so used directly it snaps from +pi to -pi (or back) the instant the vehicle's angle from the
  // planet's center crosses that seam — which a real orbit does every single revolution. Fed into
  // worldDownrange(), that wrap used to teleport the rocket clear across the screen once per orbit,
  // which is exactly the "bouncing in the air" / snapping-sideways look this fixes: track the
  // total signed angle traveled instead of the wrapped instantaneous one, by adding the smallest
  // equivalent delta from the previous frame's angle every step (a standard angle-unwrap).
  const theta = Math.atan2(s.x, s.y);
  let dTheta = theta - s.lastTheta;
  if(dTheta > Math.PI) dTheta -= 2*Math.PI;
  else if(dTheta < -Math.PI) dTheta += 2*Math.PI;
  s.downrangeAngle = (s.downrangeAngle||0) + dTheta;
  s.lastTheta = theta;
  s.downrange = R_PLANET * s.downrangeAngle;
  // Angle of the velocity vector from local vertical (radially outward) — 0 = climbing straight up,
  // PI/2 = flying level. Computed directly from the state rather than differenced frame-to-frame, so
  // it stays correct even when the seek bar jumps discontinuously between arbitrary history frames
  // during review-mode scrubbing (a finite-difference approach would flash a wrong tilt for one
  // frame every time the scrub target isn't adjacent to the previously displayed frame).
  if(s.vel > 0.05){
    const radialX = s.x/r, radialY = s.y/r;
    const tangentX = radialY, tangentY = -radialX;
    const vRadial = s.vx*radialX + s.vy*radialY;
    const vTangent = s.vx*tangentX + s.vy*tangentY;
    s.flightPathAngle = Math.atan2(vTangent, vRadial);
  } else {
    s.flightPathAngle = 0;
  }
}

/* Acceleration felt by the vehicle at a given state — gravity (always toward planet center) plus
   thrust (along the gravity-turn pitch direction) plus drag (opposing velocity). Used by the RK4
   integrator below, which evaluates this at several sub-steps per frame rather than just once —
   Euler integration accumulates enough energy error over a multi-orbit coast that a "stable" orbit
   would visibly drift in radius over time; RK4 keeps a coasted orbit's shape correct for as long as
   the user leaves it running or scrubs it forward. */
function computeAccel(state, thrustN, pitchAngle, mass, cd, frontalArea){
  const r = Math.hypot(state.x, state.y);
  const gMag = MU / (r*r);
  // gravity points from the vehicle straight back at the origin
  const gx = -gMag * (state.x/r), gy = -gMag * (state.y/r);

  // thrust direction: pitchAngle measured from local vertical (radial-outward), rotated toward
  // the direction of travel's horizontal sense so the gravity turn consistently pitches the same
  // way instead of flipping direction depending on floating-point noise in velocity
  const radialX = state.x/r, radialY = state.y/r;                 // local "up"
  const tangentX = radialY, tangentY = -radialX;                   // local "east" (90° clockwise from up)
  const sinP = Math.sin(pitchAngle), cosP = Math.cos(pitchAngle);
  const thrustDirX = radialX*cosP + tangentX*sinP;
  const thrustDirY = radialY*cosP + tangentY*sinP;
  const tAccel = mass > 0 ? thrustN/mass : 0;
  const tax = thrustDirX * tAccel, tay = thrustDirY * tAccel;

  // drag opposes AIRSPEED (velocity relative to the moving air mass), not ground-relative
  // velocity — wind is subtracted from the vehicle's velocity before computing dynamic pressure,
  // exactly like it would need to be for a real aerodynamic force calculation. Below the modeled
  // atmosphere's edge only; wind has no meaning in vacuum.
  const alt = r - R_PLANET;
  const rho = airDensity(alt);
  let relVX = state.vx, relVY = state.vy;
  if(alt < R_ATMOS - R_PLANET){
    const windTang = windTangentialVelocity(alt), windRad = windRadialVelocity(alt);
    relVX -= windTang*tangentX + windRad*radialX;
    relVY -= windTang*tangentY + windRad*radialY;
  }
  const airspeed = Math.hypot(relVX, relVY);
  const q = 0.5 * rho * airspeed * airspeed;
  let dax = 0, day = 0;
  if(airspeed > 0.01){
    const dragAccel = (q * cd * frontalArea) / Math.max(mass, 1);
    dax = -dragAccel * (relVX/airspeed);
    day = -dragAccel * (relVY/airspeed);
  }

  return { ax: gx+tax+dax, ay: gy+tay+day, q };
}

/* Converts a desired WORLD-frame thrust direction (unit vector dirX,dirY) into the "pitch angle
   from local vertical" convention computeAccel expects, using the exact same radial/tangent local
   basis computeAccel builds inline above. Used for landing-burn (and, later, booster RTLS) thrust,
   which needs to point retrograde (opposite the current velocity vector) rather than following the
   ascent gravity-turn program — this is the shared conversion between "I want thrust to point THIS
   way in world space" and the radial-outward-relative angle the rest of the physics pipeline uses. */
function pitchAngleForWorldDirection(state, dirX, dirY){
  const r = Math.hypot(state.x, state.y);
  const radialX = state.x/r, radialY = state.y/r;
  const tangentX = radialY, tangentY = -radialX;
  const radialComp = dirX*radialX + dirY*radialY;
  const tangentComp = dirX*tangentX + dirY*tangentY;
  return Math.atan2(tangentComp, radialComp);
}

/* Retrograde pitch angle for a landing/boostback burn: thrust points opposite the vehicle's CURRENT
   velocity vector, so it decelerates along its direction of travel rather than following the ascent
   pitch program. Falls back to pointing straight up (pitch 0) at effectively zero velocity, where
   "opposite velocity" is undefined — this only matters for an instant right at the apex of a
   vertical bounce, if ever, and straight-up thrust is a harmless default there. */
function retrogradePitchAngle(state){
  const speed = Math.hypot(state.vx, state.vy);
  if(speed < 0.05) return 0;
  return pitchAngleForWorldDirection(state, -state.vx/speed, -state.vy/speed);
}

/* Classical RK4 step for the [x,y,vx,vy] system. thrustFn(t) returns {thrustN, pitchAngle, mass,
   cd, frontalArea} for a given offset into this step, so mass depletion and the pitch program stay
   consistent across the four RK4 stages instead of being frozen at the step's start. */
function rk4Step(s, dt, thrustFn){
  function deriv(state, tOffset){
    const p = thrustFn(tOffset);
    const acc = computeAccel(state, p.thrustN, p.pitchAngle, p.mass, p.cd, p.frontalArea);
    return { dx: state.vx, dy: state.vy, dvx: acc.ax, dvy: acc.ay, q: acc.q };
  }
  const state0 = { x:s.x, y:s.y, vx:s.vx, vy:s.vy };
  const k1 = deriv(state0, 0);
  const state1 = { x:state0.x+k1.dx*dt/2, y:state0.y+k1.dy*dt/2, vx:state0.vx+k1.dvx*dt/2, vy:state0.vy+k1.dvy*dt/2 };
  const k2 = deriv(state1, dt/2);
  const state2 = { x:state0.x+k2.dx*dt/2, y:state0.y+k2.dy*dt/2, vx:state0.vx+k2.dvx*dt/2, vy:state0.vy+k2.dvy*dt/2 };
  const k3 = deriv(state2, dt/2);
  const state3 = { x:state0.x+k3.dx*dt, y:state0.y+k3.dy*dt, vx:state0.vx+k3.dvx*dt, vy:state0.vy+k3.dvy*dt };
  const k4 = deriv(state3, dt);

  s.x  += (dt/6) * (k1.dx  + 2*k2.dx  + 2*k3.dx  + k4.dx);
  s.y  += (dt/6) * (k1.dy  + 2*k2.dy  + 2*k3.dy  + k4.dy);
  s.vx += (dt/6) * (k1.dvx + 2*k2.dvx + 2*k3.dvx + k4.dvx);
  s.vy += (dt/6) * (k1.dvy + 2*k2.dvy + 2*k3.dvy + k4.dvy);
  return k1.q; // report drag/dynamic-pressure at the start of the step for HUD/maxQ purposes
}

export { airDensity, computeAccel, deriveVehicle, makeSim, pitchAngleForAltitude, pitchAngleForWorldDirection, retrogradePitchAngle, rk4Step, syncScalars };
