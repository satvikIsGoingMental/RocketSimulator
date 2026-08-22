import { resultOverlay, seekBar, transport } from "../core/dom.js";
import { fmt, formatDuration } from "../core/format.js";
import { launchCriteriaSnapshot, launchWeatherSnapshot, setFlightActive, sim, updateSeekLabel } from "../flight/controller.js";
import { logMissionResult } from "./mission-log.js";

function finishFlight(){
  setFlightActive(false);
  transport.classList.remove('visible');
  const r = sim.rocket;
  let title, lede, eyebrow = 'Flight Complete', titleColor = '';
  if(sim.maxAlt <= 200){
    title = 'Vehicle failed to clear the pad';
    lede = 'Thrust-to-weight was insufficient for a clean liftoff — check the Preflight panel next time.';
  } else if(sim.landedBody){
    // landedBody is only ever set once the vehicle actually reached and touched down at the target
    // body (see finalizeTouchdownForBody) — checked BEFORE reachedEscape/reachedOrbit below, since
    // both of those flip true earlier in the SAME flight (Earth escape is how a destination flight
    // gets to the Moon/Mars in the first place) and would otherwise mis-report a completed landing
    // as merely "gone for good."
    const bodyName = sim.body.name;
    if(sim.landingOutcome === 'soft'){
      title = 'Landed on '+bodyName;
      lede = sim.landingBurnStarted
        ? r.name+' flew a suicide-burn landing onto '+bodyName+' after a '+formatDuration(sim.t)+' mission — touchdown speed within survivable limits.'
        : r.name+' descended to '+bodyName+' and touched down gently under its own gravity.';
      eyebrow = 'Mission Complete — Landed on '+sim.body.short;
      titleColor = 'var(--good)';
    } else {
      title = 'Vehicle lost at '+bodyName;
      lede = sim.landingBurnStarted
        ? r.name+' attempted a landing burn at '+bodyName+' but ran out of propellant before killing its descent speed, and struck the surface too hard to survive.'
        : r.name+' had insufficient Δv remaining to attempt a landing burn at '+bodyName+' and struck the surface uncontrolled.';
      eyebrow = 'Mission Complete — Lost at '+sim.body.short;
      titleColor = 'var(--bad)';
    }
  } else if(sim.body && sim.phase === 'DONE' && !sim.landedBody && sim.t > 1000){
    // destination was selected but the flight ended (time-limit backstop, see stepTransfer/
    // stepArrival) before ever touching down — most likely the transfer ran out of the sim's
    // generous but finite time backstop, or the vehicle ran dry before finishing a landing attempt.
    title = 'Mission incomplete — never reached '+sim.body.name;
    lede = r.name+' did not complete its trip to '+sim.body.name+' within the simulated mission window. Check the mission log for exactly where it stalled.';
    eyebrow = 'Mission Incomplete';
    titleColor = 'var(--warn)';
  } else if(sim.reachedEscape){
    title = 'Escape trajectory — gone for good';
    lede = r.name+' exceeded local escape velocity after a '+sim.v.tbCore.toFixed(0)+'s core burn and is now permanently leaving the planet\'s gravity well.';
  } else if(sim.reachedOrbit){
    title = 'Orbit reached';
    lede = r.name+' exceeded orbital velocity after a '+sim.v.tbCore.toFixed(0)+'s core burn and is coasting in a stable orbit.';
  } else if(sim.landingOutcome === 'soft'){
    title = 'Landing successful';
    lede = sim.landingBurnStarted
      ? r.name+' flew a suicide-burn landing back to the surface after a '+sim.v.tbCore.toFixed(0)+'s core burn — touchdown speed within survivable limits.'
      : r.name+' reached apogee after a '+sim.v.tbCore.toFixed(0)+'s core burn, then fell back and touched down gently.';
    eyebrow = 'Flight Complete — Landed';
    titleColor = 'var(--good)';
  } else if(sim.landingOutcome === 'crash'){
    title = 'Vehicle lost — hard impact';
    lede = sim.landingBurnStarted
      ? r.name+' attempted a landing burn but ran out of propellant before killing its descent speed, and struck the ground too hard to survive.'
      : r.name+' had insufficient Δv remaining to attempt a landing burn and fell back to the surface uncontrolled.';
    eyebrow = 'Flight Complete — Lost';
    titleColor = 'var(--bad)';
  } else {
    title = 'Flight complete — touchdown';
    lede = r.name+' reached apogee after a '+sim.v.tbCore.toFixed(0)+'s core burn, then fell back and touched down.';
  }
  document.getElementById('result_eyebrow').textContent = eyebrow;
  const titleEl = document.getElementById('result_title');
  titleEl.textContent = title;
  titleEl.style.color = titleColor;
  document.getElementById('result_lede').textContent = lede;
  if(sim.body){
    // A destination flight's most meaningful summary numbers are mission duration and how it
    // touched down, not max-Q/burn-time (which are ascent-only figures already visible in the
    // mission log) — swap the mini-stats to match rather than showing a giant, meaningless
    // "max altitude" of hundreds of millions of km from the interplanetary coast.
    document.getElementById('res_alt_label').textContent = 'Mission duration';
    document.getElementById('res_alt').textContent = formatDuration(sim.t);
    document.getElementById('res_vel_label').textContent = sim.landedBody ? 'Touchdown speed' : 'Max velocity';
    if(sim.landedBody && sim.history.length){
      const last = sim.history[sim.history.length-1];
      document.getElementById('res_vel').innerHTML = fmt(last.vel,1) + ' <span class="unit">m/s</span>';
    } else {
      document.getElementById('res_vel').innerHTML = fmt(sim.maxVel) + ' <span class="unit">m/s</span>';
    }
    document.getElementById('res_q_label').textContent = 'Distance traveled';
    document.getElementById('res_q').innerHTML = fmt(sim.transferTotalDistance/1000,0) + ' <span class="unit">km</span>';
    document.getElementById('res_tb_label').textContent = 'Departure burn';
    document.getElementById('res_tb').innerHTML = fmt(sim.v.tbCore,1) + ' <span class="unit">s</span>';
  } else {
    document.getElementById('res_alt_label').textContent = 'Max altitude';
    document.getElementById('res_alt').innerHTML = fmt(sim.maxAlt) + ' <span class="unit">m</span>';
    document.getElementById('res_vel_label').textContent = 'Max velocity';
    document.getElementById('res_vel').innerHTML = fmt(sim.maxVel) + ' <span class="unit">m/s</span>';
    document.getElementById('res_q_label').textContent = 'Max Q';
    document.getElementById('res_q').innerHTML = (sim.maxQ/1000).toFixed(1) + ' <span class="unit">kPa</span>';
    document.getElementById('res_tb_label').textContent = 'Burn duration';
    document.getElementById('res_tb').innerHTML = fmt(sim.v.tbCore,1) + ' <span class="unit">s</span>';
  }
  resultOverlay.classList.add('visible');
  seekBar.disabled = false;
  seekBar.max = Math.max(sim.t, 1);
  seekBar.value = sim.t;
  updateSeekLabel(sim.t);

  logMissionResult(sim, r, launchWeatherSnapshot, launchCriteriaSnapshot);
}

export { finishFlight };
