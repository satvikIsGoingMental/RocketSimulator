import { G0, MU, R_PLANET } from "../core/constants.js";
import { setSpeedMult } from "../flight/controller.js";
import { LANDING_DV_MARGIN, LANDING_MIN_THROTTLE, LANDING_SAFETY_MARGIN, SOFT_LANDING_VEL_MAX } from "./landing.js";
import { orbitalElementsFor } from "./orbit.js";
import { pitchAngleForWorldDirection } from "./physics.js";
import { logEvent } from "./step.js";

/* ================================================================================
   INTERPLANETARY TRANSFER — patched-conic coast from Earth departure to arrival at the target
   body's sphere of influence (SOI). See the BODIES comment above for why this is a 1D radial
   closure model rather than a full 3D vector integration: over a multi-day/month, many-million-km
   coast, this sim's existing Earth-centric (x,y) position vector stops being a meaningful thing to
   render or reason about anyway (worldAltitude/worldDownrange already compress and cap it purely
   for on-screen sanity) — what actually matters for "does this flight get there, and when" is the
   real distance-closing physics: Earth's gravity still decelerating the departure speed, the
   target's gravity accelerating the final approach, and the real numbers in between, all doing
   real work on a real timeline the user fast-forwards through with the existing time-warp system.
   ================================================================================ */

// Sets up the TRANSFER phase from the current (post-escape) Earth-centric state: reads off the
// hyperbolic excess velocity (v-infinity, the speed the vehicle keeps once "infinitely" far from
// Earth — here, clear of the near-field where computeAccel's 1/r^2 term still dominates) and uses
// it as the starting closing speed for the 1D radial coast toward the target body.
function captureTransfer(s){
  const el = orbitalElementsFor(s.x, s.y, s.vx, s.vy);
  const vInf = Math.sqrt(Math.max(el.specificEnergy, 0) * 2);
  const r = Math.hypot(s.x, s.y);
  s.escapeCoast = false;
  s.phase = 'TRANSFER';
  s.transferStartR = r; // real Earth-centered radius at the moment TRANSFER begins — placeRocket needs
                         // this to reconstruct a continuous true distance-from-Earth as the coast
                         // proceeds (R_PLANET alone would ignore however far ESCAPE had already
                         // carried the vehicle, which reads as the vehicle snapping back toward Earth
                         // the instant TRANSFER starts)
  s.transferTotalDistance = s.body.distanceFromEarth - r;
  s.transferDistance = s.transferTotalDistance;
  // vInf alone would make an already-slow departure (a vehicle that barely cleared escape
  // velocity) take a physically absurd number of simulated years to arrive; real transfer
  // trajectories are shaped (via the burn's timing/direction, not just its magnitude) to make an
  // efficient crossing. Modeled here as a floor on the initial closing speed tied to the real
  // Hohmann-class transfer time quoted in BODIES[].fact, so a vehicle with exactly textbook v-infinity
  // reproduces that real-world duration, while extra v-infinity beyond that (a genuinely "faster,
  // hotter" departure burn) is honestly rewarded with a shorter transfer, same as real mission design.
  const referenceDays = s.body.id === 'moon' ? 3.0 : 210;
  const referenceSpeed = s.transferTotalDistance / (referenceDays * 86400);
  s.transferSpeed = Math.max(vInf, referenceSpeed);
  logEvent(s, 'Trans-'+s.body.short+' coast confirmed — v∞ '+Math.round(vInf)+' m/s, '+Math.round(s.transferTotalDistance/1000).toLocaleString()+' km to go', 'good');
}

// Advances the 1D interplanetary coast by dt: closing speed is shaped by Earth's still-nonzero
// (but fast-fading, 1/r^2) deceleration near departure and the target body's growing pull near
// arrival, exactly the two ends of a real patched-conic trajectory — the flat middle cruise in
// between is where the vast majority of a real transfer's time is actually spent, same as here.
function stepTransfer(s, dt){
  const rEarth = R_PLANET + 2000000 + s.transferTotalDistance - s.transferDistance; // distance from Earth's center, growing as the coast proceeds
  const rTarget = Math.max(s.transferDistance, s.body.radius);                      // distance from target's center, shrinking
  const earthDecel = MU / (rEarth*rEarth);
  const targetAccel = s.body.mu / (rTarget*rTarget);
  s.transferSpeed = Math.max(100, s.transferSpeed - earthDecel*dt + targetAccel*dt);
  s.transferDistance = Math.max(0, s.transferDistance - s.transferSpeed*dt);
  s.t += dt;
  s.accel = 0; s.q = 0;
  // alt/vel repurposed during TRANSFER to mean "distance remaining" / "closing speed" for the HUD
  // and mission history — the vehicle isn't meaningfully "at an altitude above Earth" anymore
  s.alt = s.transferDistance;
  s.vel = s.transferSpeed;
  s.maxVel = Math.max(s.maxVel, s.vel);
  s.history.push({
    t:s.t, alt:s.alt, vel:s.vel, accel:0, mass:s.mass, q:0, tw:0,
    boosterAttached:false, phase:s.phase, throttle:0, downrange:s.downrange,
    flightPathAngle:0, transferDistance:s.transferDistance, transferTotalDistance:s.transferTotalDistance,
  });
  if(s.transferDistance <= s.body.soi){
    captureArrival(s);
    return;
  }
  if(s.t > 3.4e7){ // ~394 days — generous backstop so even a slow-v∞ Mars coast can finish rather than hit an arbitrary wall
    s.phase = 'DONE';
    logEvent(s, 'Simulation time limit reached — transfer did not complete in time', 'bad');
  }
}

// SOI handoff: rebuilds the vehicle's state as a fresh 2D position/velocity vector centered on the
// TARGET body instead of Earth. Rather than starting the vehicle at the real (very large — 66,100km
// for the Moon, 577,000km for Mars) SOI radius, which would mean a passive multi-day freefall under
// nothing but that body's own weak gravity before a landing sequence even begins (verified: ~3 days
// for the Moon alone), this places the vehicle at body.arrivalAlt — a realistic powered-descent/
// entry-interface altitude, the same kind of altitude a real mission's targeted approach trajectory
// would already have burned down to before starting its final descent. The SOI crossing itself
// still happens (and is still logged) at the real distance; only the "then what" from there to
// arrivalAlt is compressed, since coasting that whole stretch has no gameplay or educational value
// once the interplanetary trip itself (the actual multi-day/month TRANSFER) is already real.
// Arrival speed at arrivalAlt is computed via vis-viva from the real transfer-arrival speed at the
// SOI boundary — energy-conserving, not just reusing the SOI-boundary speed unchanged — so a vehicle
// that departed Earth faster (more v-infinity) also arrives at the Moon/Mars faster, honestly.
function captureArrival(s){
  s.arrivedAtBody = true;
  s.phase = 'ARRIVAL';
  const body = s.body;
  // Snap time-warp to 1x the instant arrival begins, synchronously, rather than waiting for
  // autoResetSpeedOnTransition to notice on the next rendered frame — that's fine for the normal
  // per-frame TRANSFER playback, but skipAhead()/runSimTo() can call captureArrival() many times
  // over inside a single skip-ahead click (e.g. "+30d" while still coasting), and without an
  // immediate reset here the whole ARRIVAL→DESCENT→LANDING-BURN→touchdown sequence would still
  // play out at whatever high warp the TRANSFER coast was flown at.
  if(typeof setSpeedMult === 'function') setSpeedMult(1);
  logEvent(s, 'Entering '+body.name+' sphere of influence — '+Math.round(body.soi/1000).toLocaleString()+' km out, closing at '+Math.round(s.transferSpeed)+' m/s', 'mark');
  const rStart = body.soi, rArrival = body.radius + body.arrivalAlt;
  // vis-viva-style energy conservation for a purely radial fall (specific energy = v^2/2 - mu/r
  // stays constant with no thrust/drag between the SOI and arrivalAlt): v_arrival^2 = v_soi^2 +
  // 2*mu*(1/r_arrival - 1/r_soi). Clamped at 0 in case a very slow-v-infinity arrival plus the
  // (small) SOI-to-arrivalAlt gravity gain still rounds to a tiny negative under float error.
  const vArrival = Math.sqrt(Math.max(0, s.transferSpeed*s.transferSpeed + 2*body.mu*(1/rArrival - 1/rStart)));
  logEvent(s, 'Beginning final approach at '+Math.round(body.arrivalAlt/1000)+' km altitude, '+Math.round(vArrival)+' m/s', 'mark');
  // Arrive coming "straight in" along -x, aimed at the body's center — a reasonable simplified
  // approach geometry (real missions target a specific periapsis/inclination; this sim doesn't
  // model the target's own orbital plane, so a direct radial approach is the honest choice rather
  // than faking orbital alignment this model doesn't track).
  s.x = rArrival; s.y = 0;
  s.vx = -vArrival; s.vy = vArrival * 0.18; // slight tangential component so it doesn't plunge dead-center (gives the landing sequence somewhere to arc toward, like a real arrival)
  s.downrangeAngle = 0; s.lastTheta = Math.atan2(s.x, s.y);
  syncScalarsForBody(s, body);
  s.maxAlt = Math.max(s.maxAlt, s.alt);
  s.maxVel = Math.max(s.maxVel, s.vel);
  s.phase = 'ARRIVAL';
}

/* syncScalars, but against an arbitrary body's radius (mu isn't needed here — only radius feeds
   alt/vel/flightPathAngle) instead of the hardcoded R_PLANET, for the post-arrival phases where the
   vehicle orbits/descends onto the Moon or Mars instead of Earth. */
function syncScalarsForBody(s, body){
  const rad = Math.hypot(s.x, s.y);
  s.alt = rad - body.radius;
  s.vel = Math.hypot(s.vx, s.vy);
  const theta = Math.atan2(s.x, s.y);
  let dTheta = theta - s.lastTheta;
  if(dTheta > Math.PI) dTheta -= 2*Math.PI;
  else if(dTheta < -Math.PI) dTheta += 2*Math.PI;
  s.downrangeAngle = (s.downrangeAngle||0) + dTheta;
  s.lastTheta = theta;
  s.downrange = body.radius * s.downrangeAngle;
  if(s.vel > 0.05){
    const radialX = s.x/rad, radialY = s.y/rad;
    const tangentX = radialY, tangentY = -radialX;
    const vRadial = s.vx*radialX + s.vy*radialY;
    const vTangent = s.vx*tangentX + s.vy*tangentY;
    s.flightPathAngle = Math.atan2(vTangent, vRadial);
  } else {
    s.flightPathAngle = 0;
  }
}

/* Body-relative acceleration: gravity toward the target body's center (its own mu, not Earth's),
   plus thrust, plus drag if the body has an atmosphere (Mars; the Moon has none, so airDensity is
   forced to 0 there rather than reusing Earth's air-density curve). Mirrors computeAccel exactly,
   parameterized by body instead of hardcoded to Earth. */
function computeAccelForBody(body, state, thrustN, pitchAngle, mass, cd, frontalArea){
  const rad = Math.hypot(state.x, state.y);
  const gMag = body.mu / (rad*rad);
  const gx = -gMag * (state.x/rad), gy = -gMag * (state.y/rad);
  const radialX = state.x/rad, radialY = state.y/rad;
  const tangentX = radialY, tangentY = -radialX;
  const sinP = Math.sin(pitchAngle), cosP = Math.cos(pitchAngle);
  const thrustDirX = radialX*cosP + tangentX*sinP;
  const thrustDirY = radialY*cosP + tangentY*sinP;
  const tAccel = mass > 0 ? thrustN/mass : 0;
  const tax = thrustDirX * tAccel, tay = thrustDirY * tAccel;

  let dax = 0, day = 0, q = 0;
  if(body.hasAtmosphere){
    const alt = rad - body.radius;
    const rho = alt > 0 ? body.atmosSurfaceRho * Math.exp(-alt / body.atmosScaleHeight) : body.atmosSurfaceRho;
    const airspeed = Math.hypot(state.vx, state.vy);
    q = 0.5 * rho * airspeed * airspeed;
    if(airspeed > 0.01){
      const dragAccel = (q * cd * frontalArea) / Math.max(mass, 1);
      dax = -dragAccel * (state.vx/airspeed);
      day = -dragAccel * (state.vy/airspeed);
    }
  }
  return { ax: gx+tax+dax, ay: gy+tay+day, q };
}

/* RK4 step against a target body's own gravity/atmosphere instead of Earth's — mirrors rk4Step
   exactly, just delegating to computeAccelForBody. */
function rk4StepForBody(body, s, dt, thrustFn){
  function deriv(state, tOffset){
    const p = thrustFn(tOffset);
    const acc = computeAccelForBody(body, state, p.thrustN, p.pitchAngle, p.mass, p.cd, p.frontalArea);
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
  return k1.q;
}

/* Landing-burn ignition/throttle checks, re-parameterized for a target body's own mu instead of
   Earth's MU — mirrors shouldIgniteLandingBurn/landingBurnThrottle exactly. */
function descentSpeedForBody(s){
  const rad = Math.hypot(s.x, s.y);
  const radialX = s.x/rad, radialY = s.y/rad;
  const vRadial = s.vx*radialX + s.vy*radialY;
  return Math.max(0, -vRadial);
}
function shouldIgniteLandingBurnForBody(body, s, v){
  if(s.mass <= v.mfCore || v.thrustN <= 0) return false;
  const vDown = descentSpeedForBody(s);
  if(vDown < 1) return false;
  const rad = Math.hypot(s.x, s.y);
  const gLocal = body.mu / (rad*rad);
  const aMax = (v.thrustN / s.mass) - gLocal;
  if(aMax <= 0) return false;
  const hNeeded = (vDown*vDown) / (2*aMax) * LANDING_SAFETY_MARGIN;
  if(s.alt > hNeeded) return false;
  const dvRem = v.ve * Math.log(Math.max(s.mass,1) / v.mfCore);
  const dvNeeded = vDown * LANDING_DV_MARGIN;
  return dvRem > dvNeeded;
}
function landingBurnThrottleForBody(body, s, v){
  const vDown = descentSpeedForBody(s);
  const rad = Math.hypot(s.x, s.y);
  const gLocal = body.mu / (rad*rad);
  const aMaxPossible = Math.max(0.01, (v.thrustN / s.mass) - gLocal);
  const alt = Math.max(s.alt, 1);
  const need = (vDown*vDown) / (2*aMaxPossible*alt);
  return Math.max(LANDING_MIN_THROTTLE, Math.min(1, need));
}
function retrogradePitchAngleForBody(state){
  const speed = Math.hypot(state.vx, state.vy);
  if(speed < 0.05) return 0;
  return pitchAngleForWorldDirection(state, -state.vx/speed, -state.vy/speed);
}
function finalizeTouchdownForBody(body, s){
  const vDown = descentSpeedForBody(s);
  const rad = Math.hypot(s.x, s.y);
  s.x = (s.x/rad) * body.radius;
  s.y = (s.y/rad) * body.radius;
  s.vx = 0; s.vy = 0;
  syncScalarsForBody(s, body);
  s.phase = 'DONE';
  s.landedBody = body.id;
  const softMax = body.hasAtmosphere ? SOFT_LANDING_VEL_MAX : SOFT_LANDING_VEL_MAX * 0.75; // no atmosphere to help shed speed on the way down (Moon) — slightly less forgiving
  if(vDown <= softMax){
    s.landingOutcome = 'soft';
    logEvent(s, 'Touchdown on '+body.name+' — soft landing, '+vDown.toFixed(1)+' m/s', 'good');
  } else {
    s.landingOutcome = 'crash';
    logEvent(s, 'Impact on '+body.name+' — '+vDown.toFixed(1)+' m/s exceeded survivable touchdown speed', 'bad');
  }
}

/* Advances the vehicle once it's arrived at the target body (ARRIVAL/DESCENT/LANDING-BURN phases,
   target-centric coordinates) — mirrors the tail half of simStep's Earth-departure logic, just
   against the target body's own gravity/radius/atmosphere via the *ForBody helpers above. There's
   no ascent/orbit-insertion path here: arrival always aims straight for a landing attempt, since
   this sim's mission is "does it land," not "does it park in Mars orbit." */
function stepArrival(s, dt){
  const v = s.v, body = s.body;

  if(s.phase === 'LANDING-BURN'){
    if(s.mass <= v.mfCore){
      s.phase = 'DESCENT';
      logEvent(s, 'Landing burn — propellant exhausted, in freefall', 'bad');
    } else {
      const throttleFrac = landingBurnThrottleForBody(body, s, v);
      const thrustN = throttleFrac * v.thrustN;
      const mdot = throttleFrac * v.mdotCore;
      const massAtStart = s.mass;
      const pitch = retrogradePitchAngleForBody(s);
      const q = rk4StepForBody(body, s, dt, function(tOffset){
        const massHere = Math.max(v.mfCore, massAtStart - mdot * tOffset);
        return { thrustN, pitchAngle: pitch, mass: massHere, cd: v.cd, frontalArea: v.frontalArea };
      });
      s.mass = Math.max(v.mfCore, s.mass - mdot * dt);
      s.t += dt;
      syncScalarsForBody(s, body);
      s.q = q;
      s.maxVel = Math.max(s.maxVel, s.vel);
      const weightN = s.mass * (body.mu/Math.pow(Math.hypot(s.x,s.y),2));
      s.accel = weightN > 0 ? (thrustN/weightN)*G0 : 0;
      s.history.push({
        t:s.t, alt:s.alt, vel:s.vel, accel:s.accel, mass:s.mass, q, tw: weightN>0 ? thrustN/weightN : 0,
        boosterAttached:false, phase:s.phase, throttle:throttleFrac, downrange:s.downrange,
        flightPathAngle:s.flightPathAngle, body: body.id,
      });
    }
    if(s.alt <= 0){ finalizeTouchdownForBody(body, s); }
    return;
  }

  // ARRIVAL and DESCENT: unpowered freefall toward the body under its own gravity (+ drag if it
  // has an atmosphere), watching for the landing-burn ignition point exactly like Earth descent.
  const q = rk4StepForBody(body, s, dt, function(){
    return { thrustN:0, pitchAngle:0, mass:s.mass, cd:v.cd, frontalArea:v.frontalArea };
  });
  s.t += dt;
  syncScalarsForBody(s, body);
  s.q = q; s.accel = 0;
  s.maxAlt = Math.max(s.maxAlt, s.alt);
  s.maxVel = Math.max(s.maxVel, s.vel);
  s.history.push({
    t:s.t, alt:s.alt, vel:s.vel, accel:0, mass:s.mass, q, tw:0,
    boosterAttached:false, phase:s.phase, throttle:0, downrange:s.downrange,
    flightPathAngle:s.flightPathAngle, body: body.id,
  });

  if(s.phase === 'ARRIVAL' && s.alt < body.arrivalAlt * 0.98){
    // clear of the very edge of the arrival hand-off (captureArrival places the vehicle at exactly
    // body.arrivalAlt) so descent speed readings are meaningful, then start watching for the
    // landing-burn ignition point exactly like Earth's DESCENT phase does
    s.phase = 'DESCENT';
    logEvent(s, 'Beginning descent to '+body.name, 'mark');
  }
  if(s.phase === 'DESCENT' && !s.landingBurnStarted && shouldIgniteLandingBurnForBody(body, s, v)){
    s.phase = 'LANDING-BURN';
    s.landingBurnStarted = true;
    logEvent(s, 'Landing burn ignition', 'mark');
  } else if(s.phase === 'DESCENT' && s.alt <= 0){
    finalizeTouchdownForBody(body, s);
  } else if(s.t > 3.4e7){
    s.phase = 'DONE';
    logEvent(s, 'Simulation time limit reached before touchdown', 'bad');
  }
}

export { captureTransfer, stepArrival, stepTransfer };
