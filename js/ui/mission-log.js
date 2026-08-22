import { R_PLANET } from "../core/constants.js";
import { missionLog, srAnnounce } from "../core/dom.js";
import { destination } from "../core/mission-config.js";
import { sim } from "../flight/controller.js";
import { weather } from "../sim/weather.js";
import { Sound } from "./sound.js";

/* ================================================================================
   MISSION LOG — writes a record of every completed flight (success or failure) to shared
   storage that mission-log.html reads, so "what went wrong and how to prevent it" is answered
   from the user's OWN flight history, not just a fixed reference list of historical failures.
   The diagnosis itself is rule-based (mirrors evaluateLaunchCriteria's approach): concrete
   thresholds against this specific flight's own numbers, not a generic message.
   ================================================================================ */
const MISSION_LOG_KEY = 'dvstack.missionLog.v1';
const MISSION_LOG_MAX_ENTRIES = 200;

function diagnoseFlight(sim, launchWeather, launchCriteria){
  const findings = []; // { severity: 'critical'|'contributing'|'note', text }
  const v = sim.v;

  if(sim.maxAlt <= 200){
    findings.push({ severity:'critical', text:'Thrust-to-weight ratio at liftoff was '+v.tw.toFixed(2)+' — below the 1.0 needed to clear the pad at all. Increase thrust, add boosters, or reduce mass (payload, structure, or propellant load) until liftoff T/W exceeds roughly 1.2.' });
  } else if(v.tw < 1.15 && sim.maxAlt > 200){
    findings.push({ severity:'contributing', text:'Liftoff T/W was thin ('+v.tw.toFixed(2)+') — the vehicle cleared the pad but lost more of its climb to gravity than a healthier T/W (≥1.2) would have. Consider more thrust or less liftoff mass next time.' });
  }

  if(sim.maxQ > 0){
    const qKpa = sim.maxQ/1000;
    if(qKpa > 45){
      findings.push({ severity: sim.maxAlt<=200 ? 'note' : 'contributing', text:'Peak dynamic pressure reached '+qKpa.toFixed(1)+' kPa — a high structural load for this airframe. A slimmer nose profile, a narrower core diameter, or throttling back around max-Q would reduce this.' });
    }
  }

  if(launchWeather){
    if(launchWeather.surfaceWindSpeed >= 12){
      findings.push({ severity:'contributing', text:'Surface wind at launch was '+launchWeather.surfaceWindSpeed.toFixed(1)+' m/s — high enough to meaningfully load the vehicle standing on the pad and bias the early ascent off vertical.' });
    }
    if(launchWeather.shearWindSpeed >= 30){
      findings.push({ severity:'contributing', text:'Upper-level wind shear was '+launchWeather.shearWindSpeed.toFixed(1)+' m/s — a real launch would likely have scrubbed or seen elevated structural loading through max-Q under this shear.' });
    }
  }
  if(launchCriteria && launchCriteria.overall === 'NO-GO'){
    findings.push({ severity:'contributing', text:'This flight launched despite a NO-GO weather call ('+launchCriteria.noGoCount+' violated criteria) — in a real program this launch would have been scrubbed before liftoff.' });
  }

  if(sim.body){
    // Destination flight (Moon/Mars selected) — escape is the expected, necessary first step of
    // the mission rather than an unintended overshoot, so the generic "more Δv than was needed"
    // framing below doesn't apply; give destination-specific findings instead.
    if(sim.landedBody){
      // already covered by the crash/soft findings below (shared with Earth landings)
    } else if(sim.reachedEscape && sim.phase === 'DONE'){
      findings.push({ severity:'critical', text:'Vehicle departed Earth toward '+sim.body.name+' but the mission ended before arrival or landing — check the mission log for whether the transfer coast or the final descent is where it stalled. A generous but finite simulated-time backstop exists for both; a very low departure v∞ can make the transfer alone take longer than that.' });
    } else if(!sim.reachedEscape){
      findings.push({ severity:'critical', text:sim.body.name+' was selected as the destination, but this vehicle never reached Earth escape velocity — without it, there is no departure trajectory to make the trip at all. More total Δv (a higher-Isp vehicle, less payload, or a shallower gravity turn) is needed before a '+sim.body.short+' departure is possible.' });
    }
  } else if(sim.reachedEscape){
    findings.push({ severity:'note', text:'Vehicle exceeded local escape velocity — if orbit insertion was the goal rather than an escape trajectory, this indicates more Δv (or a later, flatter gravity-turn pitch-over) than was needed.' });
  } else if(!sim.reachedOrbit && sim.maxAlt > 200){
    findings.push({ severity: sim.maxAlt > 50000 ? 'contributing':'note', text:'Vehicle did not reach a stable orbit — apogee of '+Math.round(sim.maxAlt)+'m was reached on a suborbital arc. More total Δv, a higher T/W, or a shallower/longer gravity turn (more time thrusting tangentially before MECO) would each help close the orbit.' });
  }

  if(sim.landingOutcome === 'crash'){
    const where = sim.landedBody ? ' at '+sim.body.name : '';
    if(!sim.landingBurnStarted){
      findings.push({ severity:'critical', text:'No landing burn was attempted'+where+' — remaining Δv at arrival was too low to plausibly arrest the descent. Leave more propellant margin (a lower payload/mass fraction, or a less aggressive ascent/departure that burns less of the tank) if a powered landing is the goal.' });
    } else {
      findings.push({ severity:'critical', text:'A landing burn was attempted'+where+' but the vehicle ran out of propellant before killing its descent speed, and struck the surface too hard to survive. The Δv margin at ignition was thinner than the burn actually needed — more reserve propellant, or an earlier/higher ignition altitude, would help next time.' });
    }
  } else if(sim.landingOutcome === 'soft' && sim.landingBurnStarted){
    findings.push({ severity:'note', text:'Landing burn successfully arrested the descent for a soft touchdown'+(sim.landedBody ? ' on '+sim.body.name : '')+' — a clean powered landing.' });
  }

  if(findings.length === 0){
    findings.push({ severity:'note', text: sim.landedBody ? 'Clean flight — landed safely on '+sim.body.name+' with no flagged issues.' : sim.reachedOrbit ? 'Clean flight — stable orbit achieved with no flagged issues.' : sim.reachedEscape ? 'Clean flight — escape trajectory achieved with no flagged issues.' : 'Clean flight — no issues flagged for this ascent and landing.' });
  }
  return findings;
}

function logMissionResult(sim, r, launchWeather, launchCriteria){
  let existing = [];
  try{
    const raw = localStorage.getItem(MISSION_LOG_KEY);
    if(raw) existing = JSON.parse(raw) || [];
  }catch(err){ existing = []; }
  if(!Array.isArray(existing)) existing = [];

  const outcome = sim.maxAlt <= 200 ? 'pad-failure'
    : sim.landedBody ? (sim.landingOutcome === 'crash' ? 'crashed-'+sim.landedBody : 'landed-'+sim.landedBody)
    : sim.body ? 'mission-incomplete' // destination selected, escaped Earth, but never touched down (see diagnoseFlight)
    : sim.reachedEscape ? 'escape'
    : sim.reachedOrbit ? 'orbit'
    : sim.landingOutcome === 'crash' ? 'crashed'
    : 'landed'; // covers both a soft landing-burn touchdown and a gentle unpowered ballistic-hop
                // touchdown (landingOutcome is set by finalizeTouchdown() either way — see there)

  const entry = {
    schema: 1,
    id: 'm' + Date.now() + Math.floor(Math.random()*1000),
    t: Date.now(),
    vehicleName: r.name,
    vehicleId: r.id,
    outcome,
    destination: sim.body ? sim.body.id : 'earth-orbit',
    missionDuration: sim.body ? sim.t : null,
    maxAlt: sim.maxAlt,
    maxVel: sim.maxVel,
    maxQ: sim.maxQ,
    burnTime: sim.v.tbCore,
    liftoffTW: sim.v.tw,
    dv: sim.v.dv,
    orbit: sim.orbit ? { apoapsisAlt: sim.orbit.apoapsis-R_PLANET, periapsisAlt: sim.orbit.periapsis-R_PLANET, periodMin: sim.orbit.period/60 } : null,
    weather: launchWeather ? Object.assign({}, launchWeather) : null,
    launchCriteriaOverall: launchCriteria ? launchCriteria.overall : null,
    findings: diagnoseFlight(sim, launchWeather, launchCriteria),
  };

  existing.unshift(entry);
  if(existing.length > MISSION_LOG_MAX_ENTRIES) existing = existing.slice(0, MISSION_LOG_MAX_ENTRIES);

  try{
    localStorage.setItem(MISSION_LOG_KEY, JSON.stringify(existing));
  }catch(err){ /* storage unavailable — the flight result still displays locally, it just won't be logged */ }
}
/* ---------------- in-flight log rendering + screen-reader announcements ----------------
   Separate from the persisted mission log above: this is the live scrolling log in the corner of
   the 3D view during a flight. lastAnnouncedLogT tracks which entry the aria-live region has
   already spoken, so a re-render (which happens on every skip/scrub) doesn't re-announce it. */
let lastAnnouncedLogT = null;
// Called by startLaunch so each flight announces its own log from the beginning.
function resetLogAnnouncer(){
  lastAnnouncedLogT = null;
}
function renderMissionLog(){
  missionLog.innerHTML = sim.log.slice().reverse().map(function(e){
    return '<div class="entry '+e.cls+'"><span class="t">T+'+e.t.toFixed(0)+'s</span><span>'+e.text+'</span></div>';
  }).join('');
  Sound.voiceLogEntries(sim.log);
  const latest = sim.log[sim.log.length-1];
  if(latest && latest.t !== lastAnnouncedLogT){
    lastAnnouncedLogT = latest.t;
    srAnnounce.textContent = latest.text;
  }
}

export { logMissionResult, renderMissionLog, resetLogAnnouncer };
