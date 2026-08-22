import { G0, R_PLANET } from "../core/constants.js";
import { fmt, formatDuration, formatMissionClock } from "../core/format.js";
import { sim } from "../flight/controller.js";
import { orbitalElementsFor } from "../sim/orbit.js";

function updateHud(f){
  const isTransfer = f.phase === 'TRANSFER';
  document.getElementById('hud_eta_row').style.display = isTransfer ? '' : 'none';
  document.getElementById('hud_vel_row').style.display = isTransfer ? 'none' : '';
  document.getElementById('hud_acc_row').style.display = isTransfer ? 'none' : '';
  document.getElementById('hud_tw_row').style.display = isTransfer ? 'none' : '';
  document.getElementById('hud_q_row').style.display = isTransfer ? 'none' : '';

  if(isTransfer){
    document.getElementById('hud_alt_label').textContent = 'Distance to '+sim.body.short;
    document.getElementById('hud_alt').innerHTML = fmt(f.transferDistance/1000,0) + ' <span class="unit">km</span>';
    // ETA from the CURRENT closing speed (not the average) — same "closed-loop, recomputed from
    // where things actually stand right now" philosophy as the landing-burn throttle law elsewhere
    // in this sim, rather than a one-shot estimate frozen at departure.
    const closingSpeed = sim.transferSpeed || 1;
    const etaSeconds = f.transferDistance / Math.max(closingSpeed, 1);
    document.getElementById('hud_eta').textContent = formatDuration(etaSeconds);
  } else {
    // f.body (set per-frame by stepArrival's history.push, see there) rather than the live
    // sim.arrivedAtBody, so scrubbing the review seek bar back to an earlier ascent-phase frame
    // after landing on the Moon/Mars correctly shows "Altitude" (Earth) for THAT frame instead of
    // staying stuck labeled for whichever body the live flight ultimately ended up at.
    document.getElementById('hud_alt_label').textContent = f.body ? 'Altitude (' + sim.body.short + ')' : 'Altitude';
    document.getElementById('hud_alt').innerHTML = fmt(f.alt,0) + ' <span class="unit">m</span>';
    document.getElementById('hud_vel_label').textContent = 'Velocity';
    document.getElementById('hud_vel').innerHTML = fmt(f.vel,0) + ' <span class="unit">m/s</span>';
    document.getElementById('hud_acc').innerHTML = (f.accel/G0).toFixed(2) + ' <span class="unit">g</span>';
    document.getElementById('hud_tw').textContent = f.tw.toFixed(2);
    document.getElementById('hud_q').innerHTML = (f.q/1000).toFixed(1) + ' <span class="unit">kPa</span>';
  }
  document.getElementById('hud_mass').innerHTML = fmt(f.mass,0) + ' <span class="unit">kg</span>';
  const dvRem = sim.v.ve * Math.log(Math.max(f.mass,1) / sim.v.mfCore);
  document.getElementById('hud_dvrem').innerHTML = fmt(Math.max(dvRem,0)) + ' <span class="unit">m/s</span>';
  document.getElementById('hud_throttle_pct').textContent = Math.round(f.throttle*100)+'%';
  document.getElementById('hud_throttle_bar').style.width = (f.throttle*100)+'%';
  document.getElementById('hud_time').textContent = formatMissionClock(f.t);
  document.getElementById('hud_phase').textContent = f.phase === 'TRANSFER' ? 'TRANS-'+sim.body.short.toUpperCase()
    : (f.body ? f.phase+' — '+sim.body.short.toUpperCase() : f.phase);
  updateHudOrbitBlock(f);
}

/* Reconstructs the (x,y,vx,vy) state vector for a given history frame, using exactly the same
   local-frame convention syncScalars() uses (theta measured from the +y axis via downrange, angles
   measured from local radial-outward). History frames only store the scalar alt/vel/downrange/
   flightPathAngle — this rebuilds the vectors needed for an orbital-elements projection from them,
   which is what lets the HUD's projected-orbit readout stay correct while scrubbing the review seek
   bar to an arbitrary past frame, instead of only being valid for the live/final simulation state. */
function stateVectorFromFrame(f){
  const r = R_PLANET + f.alt;
  const theta = f.downrange / R_PLANET;
  const x = r*Math.sin(theta), y = r*Math.cos(theta);
  const radialX = Math.sin(theta), radialY = Math.cos(theta);
  const tangentX = radialY, tangentY = -radialX;
  const fpa = f.flightPathAngle || 0;
  const vRadial = f.vel*Math.cos(fpa), vTangent = f.vel*Math.sin(fpa);
  const vx = vRadial*radialX + vTangent*tangentX;
  const vy = vRadial*radialY + vTangent*tangentY;
  return { x, y, vx, vy };
}

/* Live orbital projection panel. Off the pad, this continuously recomputes "if the engine cut off
   right now, what orbit would that leave me in" from the current position/velocity via vis-viva —
   genuinely useful during the ascent for judging whether the gravity turn is on track, the same way
   a real ascent-guidance display works. Once the flight resolves into a confirmed stable orbit or
   escape trajectory, it switches to reporting that confirmed outcome instead of a live projection.
   Uses stateVectorFromFrame(f) rather than reading the live sim.x/y/vx/vy directly, so this stays
   correct both during live flight (f is always the newest frame there) and while scrubbing the
   review-mode seek bar to an arbitrary earlier frame. */
function updateHudOrbitBlock(f){
  const block = document.getElementById('hud_orbit_block');
  // The projected-orbit panel is an Earth-centric-state readout (stateVectorFromFrame assumes
  // R_PLANET/MU) — meaningless during an interplanetary TRANSFER (f.alt there is repurposed to a
  // distance-to-target in the millions of km, see stepTransfer) and once arrived at another body
  // (its own DESCENT/LANDING-BURN don't have an "orbit" concept in this sim — see stepArrival).
  if(!sim || f.phase === 'TRANSFER' || f.body || f.alt < 200){ block.style.display = 'none'; return; }
  block.style.display = 'flex';

  const labelEl = document.getElementById('hud_orbit_label');
  const stateEl = document.getElementById('hud_orbit_state');
  const apoEl = document.getElementById('hud_apo');
  const periEl = document.getElementById('hud_peri');
  const periodEl = document.getElementById('hud_period');
  const apoRow = apoEl.parentElement;
  const periRow = periEl.parentElement;
  const periodRow = document.getElementById('hud_period_row');

  function setState(text, colorVar){ stateEl.textContent = text; stateEl.style.color = 'var('+colorVar+')'; }
  function showApoPeriPeriod(show){
    apoRow.style.display = show ? '' : 'none';
    periRow.style.display = show ? '' : 'none';
    periodRow.style.display = show ? '' : 'none';
  }

  if(f.phase === 'ORBIT' && f.orbit){
    labelEl.textContent = 'Orbital state';
    setState('Stable orbit', '--good');
    showApoPeriPeriod(true);
    apoEl.innerHTML = fmt((f.orbit.apoapsis-R_PLANET)/1000,1) + ' <span class="unit">km alt</span>';
    periEl.innerHTML = fmt((f.orbit.periapsis-R_PLANET)/1000,1) + ' <span class="unit">km alt</span>';
    periodEl.innerHTML = fmt(f.orbit.period/60,1) + ' <span class="unit">min</span>';
    return;
  }

  if(f.phase === 'ESCAPE'){
    labelEl.textContent = 'Orbital state';
    setState('Escaping — will not return', '--good');
    // apoapsis/periapsis in the closed-orbit sense don't apply to a hyperbolic trajectory; show
    // hyperbolic excess velocity (v∞, the speed the vehicle keeps once infinitely far from the
    // planet) instead — it's the escape-trajectory equivalent of "how big is this orbit"
    apoRow.style.display = 'none';
    periodRow.style.display = 'none';
    periRow.style.display = '';
    const sv = stateVectorFromFrame(f);
    const el = orbitalElementsFor(sv.x, sv.y, sv.vx, sv.vy);
    const vInf = Math.sqrt(Math.max(el.specificEnergy, 0) * 2);
    periEl.previousElementSibling.textContent = 'Excess velocity (v∞)';
    periEl.innerHTML = fmt(vInf,0) + ' <span class="unit">m/s</span>';
    return;
  }

  // still under thrust or coasting pre-classification: live "if MECO happened right now" projection,
  // continuously recomputed from the current state — lets the pilot judge the gravity turn in progress
  labelEl.textContent = 'Projected orbit (if MECO now)';
  periEl.previousElementSibling.textContent = 'Periapsis';
  showApoPeriPeriod(true);
  const sv2 = stateVectorFromFrame(f);
  const el = orbitalElementsFor(sv2.x, sv2.y, sv2.vx, sv2.vy);
  if(el.specificEnergy >= 0){
    setState('Would escape', '--warn');
    apoEl.innerHTML = 'unbound';
    periEl.innerHTML = '—';
    periodEl.innerHTML = '—';
  } else if(el.periapsis <= R_PLANET){
    setState('Suborbital', '--text-dim');
    apoEl.innerHTML = fmt(Math.max(el.apoapsis-R_PLANET,0)/1000,1) + ' <span class="unit">km alt</span>';
    periEl.innerHTML = 'below surface';
    periodEl.innerHTML = '—';
  } else {
    setState('Would be stable', '--good');
    apoEl.innerHTML = fmt((el.apoapsis-R_PLANET)/1000,1) + ' <span class="unit">km alt</span>';
    periEl.innerHTML = fmt((el.periapsis-R_PLANET)/1000,1) + ' <span class="unit">km alt</span>';
    periodEl.innerHTML = fmt(el.period/60,1) + ' <span class="unit">min</span>';
  }
}

export { updateHud };
