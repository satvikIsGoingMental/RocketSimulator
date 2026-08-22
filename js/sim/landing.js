import { MU, R_PLANET } from "../core/constants.js";
import { syncScalars } from "./physics.js";
import { logEvent } from "./step.js";

/* ================================================================================
   LANDING BURN — suicide-burn re-ignition during DESCENT.

   A falling stage with leftover propellant can re-light and kill its own descent speed before
   impact, exactly like a real Falcon 9/Starship landing — but only IF it has enough propellant-
   based Δv left to do so. This is deliberately gated on the SAME Δv figure already shown on the
   HUD ("Δv remaining"), not a new per-vehicle "can land" flag: a vehicle that spent its whole
   propellant load reaching orbit/escape (the combined-stack vehicles, e.g. Saturn V+S-IVB) simply
   won't have the margin to attempt a burn and will crash, which is the correct, honest outcome for
   an upper stage that was never designed to come back — "no guarantee your rocket makes it" made
   concrete here, not just at a destination arrival.
   ================================================================================ */
const LANDING_SAFETY_MARGIN = 1.6; // ignition altitude is inflated by this factor over the bare
                                    // constant-deceleration kinematic minimum, to leave room for
                                    // RK4 discretization error and the throttle law's own response
                                    // lag — a real guidance computer keeps exactly this kind of
                                    // margin rather than igniting at the theoretical last instant
const LANDING_DV_MARGIN = 1.1;     // required Δv must exceed the predicted burn's Δv need by this
                                    // factor before a burn is even attempted — the "no guarantee"
                                    // slop: a flight that only just clears this bar can still run
                                    // the tank dry mid-burn and crash anyway (handled below)
const LANDING_MIN_THROTTLE = 0.4;  // real engines have a minimum stable throttle floor; below this
                                    // the sim would be pretending a rocket engine can be feathered
                                    // to near-zero thrust, which isn't physically representative
const SOFT_LANDING_VEL_MAX = 8;    // m/s vertical speed at touchdown — a Falcon-9-class landing-leg
                                    // structural budget; below this counts as a survivable landing

/* True local (radial) descent speed — positive falling toward the planet, matching how vDown is
   used throughout this section. Uses the same radial-component projection syncScalars already
   computes for flightPathAngle, just returned as a raw m/s figure instead of an angle. */
function descentSpeed(s){
  const r = Math.hypot(s.x, s.y);
  const radialX = s.x/r, radialY = s.y/r;
  const vRadial = s.vx*radialX + s.vy*radialY; // negative while falling (radius shrinking)
  return Math.max(0, -vRadial);
}

/* Whether NOW is the moment to ignite the landing burn: true once the altitude remaining is at or
   below what's needed to kill the current descent speed at max available deceleration (with
   margin), AND there's enough Δv left to plausibly finish the job. Evaluated every DESCENT step
   (a closed-loop check, not a precomputed one-shot altitude) so it naturally adapts to whatever
   descent speed the vehicle actually has when it gets there, rather than assuming a fixed profile. */
function shouldIgniteLandingBurn(s, v){
  if(s.mass <= v.mfCore || v.thrustN <= 0) return false; // no propellant or no engine left to burn with
  const vDown = descentSpeed(s);
  if(vDown < 1) return false; // not meaningfully falling yet (e.g. still near apogee) — nothing to burn off
  const r = Math.hypot(s.x, s.y);
  const gLocal = MU / (r*r);
  const aMax = (v.thrustN / s.mass) - gLocal; // net deceleration available at full throttle, straight retrograde
  if(aMax <= 0) return false; // thrust can't even overcome local gravity — burning now can't help
  const hNeeded = (vDown*vDown) / (2*aMax) * LANDING_SAFETY_MARGIN;
  if(s.alt > hNeeded) return false; // not yet at the ignition point
  const dvRem = v.ve * Math.log(Math.max(s.mass,1) / v.mfCore);
  const dvNeeded = vDown * LANDING_DV_MARGIN;
  return dvRem > dvNeeded;
}

/* Closed-loop suicide-burn throttle law, recomputed every step from the CURRENT altitude/speed —
   this is what makes it self-correcting (like a real landing guidance loop) rather than an
   open-loop timed burn: if the vehicle is decelerating faster than strictly needed, throttle eases
   off; if it's behind schedule, throttle climbs back toward 1.0. */
function landingBurnThrottle(s, v){
  const vDown = descentSpeed(s);
  const r = Math.hypot(s.x, s.y);
  const gLocal = MU / (r*r);
  const aMaxPossible = Math.max(0.01, (v.thrustN / s.mass) - gLocal);
  const alt = Math.max(s.alt, 1);
  const need = (vDown*vDown) / (2*aMaxPossible*alt);
  return Math.max(LANDING_MIN_THROTTLE, Math.min(1, need));
}

/* Snaps the vehicle onto the surface and decides the landing outcome from the vertical speed it
   was carrying at the instant it crossed alt<=0 — soft touchdown vs. crash — instead of the old
   code's unconditional "Touchdown — simulation complete" regardless of impact speed. Shared by both
   the plain-freefall DESCENT touchdown case and the LANDING-BURN case (a burn that didn't fully
   arrest descent before running out of altitude still ends up here, just with a lower vDown than an
   uncontrolled freefall would have had — same function, same threshold, honestly applied either way. */
function finalizeTouchdown(s){
  const vDown = descentSpeed(s);
  const r = Math.hypot(s.x, s.y);
  s.x = (s.x/r) * R_PLANET;
  s.y = (s.y/r) * R_PLANET;
  s.vx = 0; s.vy = 0;
  syncScalars(s);
  s.phase = 'DONE';
  if(vDown <= SOFT_LANDING_VEL_MAX){
    s.landingOutcome = 'soft';
    logEvent(s, 'Touchdown — soft landing, '+vDown.toFixed(1)+' m/s', 'good');
  } else {
    s.landingOutcome = 'crash';
    logEvent(s, 'Impact — '+vDown.toFixed(1)+' m/s exceeded survivable touchdown speed', 'bad');
  }
}

export { LANDING_DV_MARGIN, LANDING_MIN_THROTTLE, LANDING_SAFETY_MARGIN, SOFT_LANDING_VEL_MAX, finalizeTouchdown, landingBurnThrottle, shouldIgniteLandingBurn };
