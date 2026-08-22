import { G0, MU, R_ATMOS, R_PLANET } from "../core/constants.js";
import { finalizeTouchdown, landingBurnThrottle, shouldIgniteLandingBurn } from "./landing.js";
import { captureOrbit, orbitalElementsFor, propagateOrbit } from "./orbit.js";
import { computeAccel, pitchAngleForAltitude, retrogradePitchAngle, rk4Step, syncScalars } from "./physics.js";
import { captureTransfer, stepArrival, stepTransfer } from "./transfer.js";

function simStep(s, dt){
  if(s.phase === 'DONE') return;
  const r = s.rocket, v = s.v;

  if(s.arrivedAtBody){
    stepArrival(s, dt);
    return;
  }

  if(s.orbitCoast){
    s.t += dt;
    const st = propagateOrbit(s.orbit, s.t - s.orbit.epoch);
    s.x = st.x; s.y = st.y; s.vx = st.vx; s.vy = st.vy;
    syncScalars(s);
    s.accel = 0; s.q = 0;
    s.maxAlt = Math.max(s.maxAlt, s.alt);
    s.maxVel = Math.max(s.maxVel, s.vel);
    s.history.push({
      t:s.t, alt:s.alt, vel:s.vel, accel:0, mass:s.mass, q:0, tw:0,
      boosterAttached:false, phase:s.phase, throttle:0, downrange:s.downrange,
      flightPathAngle:s.flightPathAngle, orbit: s.orbit,
    });
    if(s.t > 3600){
      s.phase = 'DONE';
      logEvent(s, 'Simulation time limit reached (T+60:00)', 'good');
    }
    return;
  }

  if(s.escapeCoast){
    // past the atmosphere and on a confirmed hyperbolic trajectory: gravity is the only force
    // left (drag is negligible and there's no more propellant), so a plain RK4 pass with zero
    // thrust is both correct and cheap — no analytic shortcut needed since we don't need to jump
    // arbitrarily far ahead the way a multi-hour closed orbit coast does. Kept running just long
    // enough (past ~2 Earth radii of altitude) to get a clean hyperbolic excess velocity reading
    // for handoff into TRANSFER — see captureTransfer() below.
    const q = rk4Step(s, dt, function(){ return { thrustN:0, pitchAngle:0, mass:s.mass, cd:v.cd, frontalArea:v.frontalArea }; });
    s.t += dt;
    syncScalars(s);
    s.q = q; s.accel = 0;
    s.maxAlt = Math.max(s.maxAlt, s.alt);
    s.maxVel = Math.max(s.maxVel, s.vel);
    s.history.push({
      t:s.t, alt:s.alt, vel:s.vel, accel:0, mass:s.mass, q, tw:0,
      boosterAttached:false, phase:s.phase, throttle:0, downrange:s.downrange,
      flightPathAngle:s.flightPathAngle,
    });
    if(s.body && s.alt > R_PLANET * 1.5){
      // Clear of Earth's immediate pull and on a confirmed escape trajectory with a destination
      // selected — hand off from the 2D Earth-centric vector state to the 1D interplanetary
      // transfer model (captureTransfer/TRANSFER phase below).
      captureTransfer(s);
      return;
    }
    if(s.t > 3600){
      s.phase = 'DONE';
      logEvent(s, 'Simulation time limit reached (T+60:00)', 'good');
    }
    return;
  }

  if(s.phase === 'TRANSFER'){
    stepTransfer(s, dt);
    return;
  }

  if(s.ballisticCoast){
    // Bound (specific energy < 0) but suborbital ellipse — periapsis is below the ground, so this
    // trajectory WILL eventually re-enter, but that might be a very high apoapsis and (per Kepler's
    // third law) take a very long time in real seconds to get there and fall back. While altitude
    // stays above the atmosphere interface, gravity is the only meaningful force, so — exactly like
    // the confirmed-stable-orbit case — the analytic Kepler solution can jump straight to any future
    // time instantly and exactly, instead of grinding through potentially hours of real seconds via
    // frame-by-frame RK4 (which is what silently starved this case before: a high-apoapsis ballistic
    // arc could need over an hour of simulated time just to reach apogee, longer than the sim's own
    // time cap, so it would never resolve to a landing). Once altitude drops back into the atmosphere,
    // drop out of analytic propagation and hand off to full numeric RK4 (with drag) for a realistic
    // powered-free descent through the air, same as any other landing.
    s.t += dt;
    const st = propagateOrbit(s.orbit, s.t - s.orbit.epoch);
    s.x = st.x; s.y = st.y; s.vx = st.vx; s.vy = st.vy;
    syncScalars(s);
    s.accel = 0; s.q = 0;
    s.maxAlt = Math.max(s.maxAlt, s.alt);
    s.maxVel = Math.max(s.maxVel, s.vel);
    s.history.push({
      t:s.t, alt:s.alt, vel:s.vel, accel:0, mass:s.mass, q:0, tw:0,
      boosterAttached:false, phase:s.phase, throttle:0, downrange:s.downrange,
      flightPathAngle:s.flightPathAngle,
    });
    if(s.alt <= R_ATMOS - R_PLANET){
      s.ballisticCoast = false; // re-entering the modeled atmosphere: switch back to full numeric integration below
      logEvent(s, 'Re-entering atmosphere', 'mark');
    } else if(s.t > 21600){
      // ballistic (non-orbital) trajectories get a longer backstop than the 3600s used elsewhere —
      // a legitimate high-apoapsis suborbital arc can genuinely take longer than an hour to fall
      // back, unlike the old model's cases, which is exactly the bug this whole branch fixes
      s.phase = 'DONE';
      logEvent(s, 'Simulation time limit reached (T+360:00)', 'good');
    }
    return;
  }

  if(s.phase === 'LANDING-BURN'){
    // Closed-loop suicide burn: throttle and retrograde thrust direction are both recomputed every
    // step from the CURRENT state (see landingBurnThrottle/retrogradePitchAngle), not scheduled
    // open-loop from the ignition instant — exactly like the ascent's gravity-turn program is a
    // function of current altitude rather than a fixed timeline, this is a function of current
    // altitude/speed. If propellant runs out mid-burn, drop back to a plain DESCENT freefall for
    // the remainder — the vehicle most likely then crashes, which is the honest outcome for an
    // under-margined attempt (see LANDING_DV_MARGIN's comment above).
    if(s.mass <= v.mfCore){
      s.phase = 'DESCENT';
      logEvent(s, 'Landing burn — propellant exhausted, in freefall', 'bad');
    } else {
      const throttleFrac = landingBurnThrottle(s, v);
      const thrustN = throttleFrac * v.thrustN;
      const mdot = throttleFrac * v.mdotCore;
      const massAtStart = s.mass;
      const pitch = retrogradePitchAngle(s);
      const q = rk4Step(s, dt, function(tOffset){
        const massHere = Math.max(v.mfCore, massAtStart - mdot * tOffset);
        return { thrustN, pitchAngle: pitch, mass: massHere, cd: v.cd, frontalArea: v.frontalArea };
      });
      s.mass = Math.max(v.mfCore, s.mass - mdot * dt);
      s.t += dt;
      syncScalars(s);
      s.q = q;
      s.maxVel = Math.max(s.maxVel, s.vel);
      const weightN = s.mass * (MU/Math.pow(Math.hypot(s.x,s.y),2));
      s.accel = weightN > 0 ? (thrustN/weightN)*G0 : 0;
      s.history.push({
        t:s.t, alt:s.alt, vel:s.vel, accel:s.accel, mass:s.mass, q, tw: weightN>0 ? thrustN/weightN : 0,
        boosterAttached:false, phase:s.phase, throttle:throttleFrac, downrange:s.downrange,
        flightPathAngle:s.flightPathAngle,
      });
    }
    if(s.alt <= 0){
      finalizeTouchdown(s);
    }
    return;
  }

  // determine active thrust + mdot based on phase (unchanged from the pre-orbital-mechanics model)
  let thrustN = 0, mdot = 0;
  const boosterBurning = s.boosterAttached && !s.boosterSeparated && s.t < v.boostBurnTime;

  // Destination flights (Moon/Mars) only: cut the core off the instant real Earth-escape is
  // confirmed, instead of always burning every drop of core propellant regardless of need. Without
  // this, tbCore (propellant mass / mass flow rate) always finishes exactly when the tank hits dry
  // mass, so s.mass == v.mfCore at every core burnout, EVERY vehicle, EVERY flight — meaning "Δv
  // remaining" (which is a function of s.mass vs v.mfCore) is always exactly zero by the time a
  // destination flight reaches TRANSFER, and the suicide-burn landing system built for arrival could
  // structurally never ignite for any vehicle, no matter how much total Δv it had. Real missions
  // don't burn a stage to bone-dry the instant it's merely capable of escape either — they cut off
  // once the targeted trajectory is achieved and save whatever's left for what comes next. Earth-
  // orbit-only flights are deliberately left burning to depletion as before: nothing downstream of a
  // stable orbit or plain suborbital hop in this sim ever spends propellant again, so an early cutoff
  // there would only ever reduce apogee for no benefit.
  if(s.body && !s.earlyMECO && s.t > 2){
    const el = orbitalElementsFor(s.x, s.y, s.vx, s.vy);
    if(el.specificEnergy >= 0) s.earlyMECO = true;
  }
  const coreBurning = s.t < v.tbCore && !s.earlyMECO;

  if(coreBurning) { thrustN += v.thrustN; mdot += v.mdotCore; }
  if(boosterBurning) { thrustN += v.boostThrustN; mdot += v.mdotBoost; }

  if(!coreBurning && s.phase !== 'COAST' && s.phase !== 'DONE' && s.phase !== 'DESCENT' && s.phase !== 'ORBIT' && s.phase !== 'ESCAPE' && s.phase !== 'BALLISTIC' && s.phase !== 'LANDING-BURN'){
    s.phase = 'COAST';
    if(!s.coreBurnout){
      s.coreBurnout = true;
      logEvent(s, s.earlyMECO ? 'Main engine cutoff (MECO) — escape trajectory confirmed, banking remaining propellant for the landing attempt' : 'Main engine cutoff (MECO)', 'mark');
    }
  }

  // booster separation trigger — drop the spent boosters' own structural mass along with them;
  // without this the sim kept carrying dead booster mass in s.mass all the way to orbit, silently
  // inflating dry mass for every T/W and dv-remaining calc for the rest of the flight
  if(s.boosterAttached && !s.boosterSeparated && s.t >= v.boostBurnTime && v.boostBurnTime > 0){
    s.boosterSeparated = true;
    s.mass = Math.max(v.mfCore, s.mass - v.mstructBoost);
    logEvent(s, 'Booster separation', 'mark');
  }

  if(s.phase === 'PAD' && (thrustN > 0)) {
    s.phase = boosterBurning ? 'BOOST' : 'CORE';
  } else if(s.phase === 'BOOST' && !boosterBurning){
    s.phase = coreBurning ? 'CORE' : 'COAST';
  }

  const pitch = pitchAngleForAltitude(s.alt, v.targetOrbitAlt);
  const massAtStart = s.mass;

  const q = rk4Step(s, dt, function(tOffset){
    // mass depletes linearly through the sub-step so RK4's interior evaluations see a consistent
    // (if approximate) mass rather than the value frozen at the step's start
    const massHere = Math.max(v.mfCore, massAtStart - mdot * tOffset);
    return { thrustN, pitchAngle: pitch, mass: massHere, cd: v.cd, frontalArea: v.frontalArea };
  });

  s.mass = Math.max(v.mfCore, s.mass - mdot * dt);
  s.t += dt;
  syncScalars(s);

  // resting on the pad: don't let numerical noise pull the vehicle below the surface before liftoff clears it
  if(s.alt <= 0 && s.phase === 'PAD'){
    s.x = 0; s.y = R_PLANET; s.vx = 0; s.vy = 0;
    syncScalars(s);
  }

  // HUD "acceleration" reports net coordinate acceleration along the direction of travel — thrust
  // minus gravity minus drag, the same convention the pre-orbital-mechanics model used (net-zero
  // at rest on the pad, net-zero in a stable unpowered coast). Evaluated directly via computeAccel
  // at the step's end state rather than differentiating velocity, which would also (incorrectly)
  // pick up gravity's own contribution to Δv over the step as if it were felt acceleration.
  {
    const accVec = computeAccel(s, thrustN, pitch, s.mass, v.cd, v.frontalArea);
    const gMagNow = MU / Math.pow(Math.hypot(s.x,s.y), 2);
    const speed = Math.hypot(s.vx, s.vy);
    // net accel magnitude minus the gravity component that's always present, signed by whether
    // thrust+drag together are net-accelerating (+) or net-decelerating (-) the vehicle
    const gx = -gMagNow * (s.x/Math.hypot(s.x,s.y)), gy = -gMagNow * (s.y/Math.hypot(s.x,s.y));
    const netX = accVec.ax - gx, netY = accVec.ay - gy; // thrust + drag only, gravity subtracted
    const netMag = Math.hypot(netX, netY);
    const travelDirX = speed>0.01 ? s.vx/speed : netX, travelDirY = speed>0.01 ? s.vy/speed : netY;
    const sign = (netX*travelDirX + netY*travelDirY) >= 0 ? 1 : -1;
    s.accel = thrustN>0 ? sign*netMag : -gMagNow;
  }
  s.q = q;

  s.maxAlt = Math.max(s.maxAlt, s.alt);
  s.maxVel = Math.max(s.maxVel, s.vel);
  s.maxQ = Math.max(s.maxQ, q);

  const weightN = s.mass * (MU/Math.pow(Math.hypot(s.x,s.y),2));
  const tw = weightN > 0 ? thrustN / weightN : 0;
  s.maxAcc = Math.max(s.maxAcc, tw*G0);

  s.history.push({
    t:s.t, alt:s.alt, vel:s.vel, accel:s.accel, mass:s.mass, q, tw,
    boosterAttached: s.boosterAttached && !s.boosterSeparated,
    phase:s.phase, throttle: v.totalThrustN>0 ? thrustN/v.totalThrustN : 0, downrange:s.downrange,
    flightPathAngle:s.flightPathAngle,
  });

  // Orbit/escape/re-entry classification, evaluated continuously after MECO — this replaces the
  // old single "crossed 7800 m/s at some point" freeze-frame check with the real thing: compute
  // actual orbital elements from the current state and see what they mean.
  //  - specific energy >= 0                                  -> hyperbolic: genuine escape, gone for good
  //  - specific energy < 0, periapsis clears the ground       -> stable closed orbit, coast forever
  //  - specific energy < 0, periapsis below ground, still
  //    above the atmosphere interface                        -> bound suborbital ellipse — will
  //    re-enter eventually, possibly after a long climb to a high apoapsis, so hand off to analytic
  //    Kepler propagation (ballisticCoast) rather than grinding through it frame by frame
  //  - already back inside the atmosphere interface           -> integrate the descent numerically,
  //    same as always, since drag is no longer negligible there
  if(s.coreBurnout && !s.apogeeLogged && s.t > 2){
    const el = orbitalElementsFor(s.x, s.y, s.vx, s.vy);
    if(el.specificEnergy >= 0){
      s.apogeeLogged = true;
      s.reachedEscape = true;
      s.escapeCoast = true;
      s.phase = 'ESCAPE';
      logEvent(s, 'Escape trajectory confirmed — exceeding local escape velocity, vehicle will not return', 'good');
    } else if(el.periapsis > R_PLANET + 500 && s.alt > 500){
      // stable orbit: don't declare it the instant MECO happens (a raw ballistic coast right after
      // cutoff can transiently look orbit-shaped before atmosphere/altitude settle) — require
      // clearing a small margin above the ground and being comfortably above the discernible
      // atmosphere so this doesn't fire while still deep in a suborbital ascent
      s.apogeeLogged = true;
      s.reachedOrbit = true;
      s.orbitCoast = true;
      s.phase = 'ORBIT';
      s.orbit = captureOrbit(s);
      logEvent(s, 'Stable orbit achieved — periapsis '+Math.round(el.periapsis-R_PLANET)+'m, apoapsis '+Math.round(el.apoapsis-R_PLANET)+'m', 'good');
    } else if(s.alt > R_ATMOS - R_PLANET){
      // bound but suborbital, and already above the atmosphere — capture the ellipse now and let
      // ballisticCoast fast-forward it via Kepler's equation instead of numerically stepping through
      // what can be a very long real-time climb to apoapsis on a high, imperfectly-circularized arc
      s.apogeeLogged = true;
      s.ballisticCoast = true;
      s.phase = 'BALLISTIC';
      s.orbit = captureOrbit(s);
      logEvent(s, 'Suborbital — apoapsis '+Math.round(el.apoapsis-R_PLANET)+'m, will re-enter', 'mark');
    } else if(s.vel > 0 && (s.x*s.vx + s.y*s.vy) <= 0 && s.alt > 0){
      // radial velocity crossed zero while still inside the atmosphere: this is apogee for a low
      // ballistic hop — same "reached the top, now falling" moment the old scalar model detected
      s.apogeeLogged = true;
      s.phase = 'DESCENT';
      logEvent(s, 'Apogee reached — descending', 'mark');
    }
  } else if(s.apogeeLogged && s.phase === 'BALLISTIC' && !s.ballisticCoast){
    // just dropped out of analytic ballistic-coast propagation back into the atmosphere interface —
    // continue as a normal numerically-integrated descent from here
    s.phase = 'DESCENT';
  } else if(s.apogeeLogged && s.phase === 'DESCENT' && !s.landingBurnStarted && shouldIgniteLandingBurn(s, v)){
    s.phase = 'LANDING-BURN';
    s.landingBurnStarted = true;
    logEvent(s, 'Landing burn ignition', 'mark');
  } else if(s.apogeeLogged && s.phase === 'DESCENT' && s.alt <= 0){
    finalizeTouchdown(s);
  } else if(s.t > 3600){
    s.phase = 'DONE';
    logEvent(s, 'Simulation time limit reached (T+60:00)', 'good');
  }
}

function logEvent(s, text, cls){
  s.log.push({ t:s.t, text, cls: cls||'' });
}

export { logEvent, simStep };
