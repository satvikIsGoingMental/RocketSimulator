import { MU } from "../core/constants.js";

/* Orbital elements from the current state via vis-viva / specific orbital energy. Works for any
   state, bound or unbound — the caller decides what to do with a positive-energy (escape) result. */
function orbitalElementsFor(x, y, vx, vy){
  const r = Math.hypot(x, y);
  const v = Math.hypot(vx, vy);
  const specificEnergy = (v*v)/2 - MU/r;                 // < 0 bound, >= 0 unbound (parabolic/hyperbolic)
  // specific angular momentum (z-component of r × v in 2D)
  const h = x*vy - y*vx;
  const eVec_x = (vy*h)/MU - x/r;
  const eVec_y = (-vx*h)/MU - y/r;
  const e = Math.hypot(eVec_x, eVec_y);                  // eccentricity
  let a = null, apoapsis = null, periapsis = null, period = null;
  if(specificEnergy < 0){
    a = -MU / (2*specificEnergy);
    apoapsis = a * (1 + e);
    periapsis = a * (1 - e);
    period = 2*Math.PI*Math.sqrt(Math.pow(a,3)/MU);
  }
  return { specificEnergy, angularMomentum: h, eccentricity: e, a, apoapsis, periapsis, period, r, v };
}

/* Analytically propagates a known stable orbit to time t, instead of continuing to numerically
   integrate — once the orbit is confirmed closed (periapsis clears the ground) there's no thrust
   or drag left to model, so solving Kepler's equation directly is exact and lets the sim jump the
   vehicle to an arbitrary future time instantly (needed for the seek bar / skip-ahead controls,
   which would otherwise have to simulate an orbit frame-by-frame for potentially hours). */
function propagateOrbit(orbit, tSinceEpoch){
  const n = 2*Math.PI / orbit.period;         // mean motion
  const M = mod2pi(orbit.M0 + n*tSinceEpoch); // mean anomaly
  // solve Kepler's equation M = E - e sin(E) for eccentric anomaly E via Newton-Raphson.
  // 16 iterations converges to machine precision even at e=0.999 (near-parabolic, the highest
  // eccentricity this simulator's ballistic/orbital trajectories realistically reach) — verified
  // by sweep; 8 iterations left a residual up to ~1e-4 at that extreme, enough to visibly drift
  // an analytically-propagated high-eccentricity orbit's displayed position over many periods.
  let E = orbit.e < 0.8 ? M : Math.PI;
  for(let i=0;i<16;i++){
    E = E - (E - orbit.e*Math.sin(E) - M) / (1 - orbit.e*Math.cos(E));
  }
  const cosNu = (Math.cos(E) - orbit.e) / (1 - orbit.e*Math.cos(E));
  const sinNu = (Math.sqrt(1-orbit.e*orbit.e) * Math.sin(E)) / (1 - orbit.e*Math.cos(E));
  const nu = Math.atan2(sinNu, cosNu);        // true anomaly
  const r = orbit.a * (1 - orbit.e*Math.cos(E));
  // Position/velocity in the orbital plane, rotated by the argument of periapsis stored at capture.
  // NOTE on `sense`: the Kepler M->E->nu chain above always advances nu in the "prograde" sense
  // (increasing with time) regardless of which physical direction the vehicle is actually orbiting
  // — that convention is baked into the M=E-e*sinE equation itself, not something this code chose.
  // For a genuinely retrograde orbit (sense=-1, i.e. angular momentum h<0), the vehicle's physical
  // angle theta must DECREASE as nu increases, so sense has to multiply nu's contribution to theta
  // with a flipped overall sign, not just tag along as an extra multiplier on the final x — this
  // was verified against an independent RK4 ground-truth integrator across multiple prograde and
  // retrograde test orbits (the previous `x = r*sin(theta)*sense` form, with theta=nu+argPeriapsis,
  // reproduced the capture position exactly at tSinceEpoch=0 but drifted the vehicle to a
  // completely wrong point after even a few seconds of coast for a retrograde orbit — SENSE must
  // be applied to nu's own contribution to theta, not tacked on afterward as a mirror of x).
  const theta = orbit.argPeriapsis - nu*orbit.sense;
  const x = r * Math.sin(theta);
  const y = r * Math.cos(theta);
  const vMag = Math.sqrt(MU * (2/r - 1/orbit.a));
  const flightPathAngle = Math.atan2(orbit.e*Math.sin(nu), 1+orbit.e*Math.cos(nu));
  const velTheta = theta - orbit.sense*(Math.PI/2 - flightPathAngle);
  const vx = vMag * Math.sin(velTheta);
  const vy = vMag * Math.cos(velTheta);
  return { x, y, vx, vy, r };
}
function mod2pi(a){ const m = a % (2*Math.PI); return m < 0 ? m + 2*Math.PI : m; }

function captureOrbit(s){
  const el = orbitalElementsFor(s.x, s.y, s.vx, s.vy);
  // argument of periapsis + current true anomaly, derived directly from position/velocity so the
  // analytic propagator starts exactly where the numeric integrator left off (no discontinuity).
  // argPeriapsis is defined to satisfy theta0 = argPeriapsis - trueAnom*sense, matching
  // propagateOrbit's theta = argPeriapsis - nu*sense above (see the note there for why sense
  // multiplies nu's contribution this way instead of being applied to the final x/y/vx/vy).
  const r = Math.hypot(s.x, s.y);
  const sense = (s.x*s.vy - s.y*s.vx) >= 0 ? 1 : -1; // sign of angular momentum = orbit direction in this 2D plane
  const theta = Math.atan2(s.x, s.y); // current angle from +y axis, matching propagateOrbit's convention
  const cosNu = (el.a*(1-el.eccentricity*el.eccentricity)/r - 1) / el.eccentricity;
  const clampedCosNu = Math.max(-1, Math.min(1, cosNu));
  // radial velocity sign tells us whether we're past periapsis (moving outward) or past apoapsis
  const rDot = (s.x*s.vx + s.y*s.vy) / r;
  const trueAnom = Math.acos(clampedCosNu) * (rDot >= 0 ? 1 : -1);
  const argPeriapsis = theta + trueAnom*sense;
  const E0 = 2*Math.atan2(Math.sqrt(1-el.eccentricity)*Math.sin(trueAnom/2), Math.sqrt(1+el.eccentricity)*Math.cos(trueAnom/2));
  const M0 = E0 - el.eccentricity*Math.sin(E0);
  return {
    a: el.a, e: el.eccentricity, apoapsis: el.apoapsis, periapsis: el.periapsis, period: el.period,
    argPeriapsis, sense, M0, epoch: s.t,
  };
}

export { captureOrbit, mod2pi, orbitalElementsFor, propagateOrbit };
