import { fmt } from "../core/format.js";
import { DEFAULT_DESTINATION, DEFAULT_FLIGHT_PROFILE, destination, flightProfile, setDestination, setFlightProfile } from "../core/mission-config.js";
import { rockets } from "../data/handoff.js";
import { setUserZoom, updateZoomHint } from "../scene/controls.js";
import { deriveVehicle } from "../sim/physics.js";
import { DEFAULT_WEATHER, weather } from "../sim/weather.js";
import { renderLaunchCriteria } from "./criteria-ui.js";
import { selectedRocketId } from "./roster-ui.js";
import { clearActivePreset, syncWeatherInputs } from "./weather-ui.js";

// Flight profile chips — same active/inactive chip pattern the camera-mode row uses.
const FLIGHT_PROFILE_NOTES = {
  'gravity-turn': 'Pitches over toward horizontal after 1200m so the vehicle can build the horizontal velocity an orbit needs.',
  'straight-up': 'Thrust stays pointed dead vertical for the whole burn — a simple vertical hop. It will never reach orbit this way (orbital velocity IS horizontal velocity), by design.',
};

// Destination chips — choosing the Moon or Mars doesn't change the ascent physics at all, only
// what happens AFTER Earth escape (see captureTransfer/stepTransfer/stepArrival in the physics
// section): the vehicle coasts the real distance to the chosen body under real gravity and
// attempts a real landing there instead of just coasting on a permanent hyperbolic Earth orbit.
const DESTINATION_NOTES = {
  'earth-orbit': 'Reach orbit or escape velocity and coast — no interplanetary transfer, no landing on another body.',
  moon: 'After Earth escape, coasts the real 384,400 km to the Moon (~3 days at a textbook departure speed) and attempts a landing. No atmosphere there — nothing but the landing burn to arrest a fall.',
  mars: 'After Earth escape, coasts a real Hohmann-class transfer distance to Mars (~6-9 months at a textbook departure speed) and attempts a landing through its thin CO₂ atmosphere.',
};
function renderDestinationDvCheck(){
  const el = document.getElementById('destinationDvCheck');
  if(destination === 'earth-orbit'){ el.innerHTML = ''; return; }
  const r = rockets.find(function(x){ return x.id === selectedRocketId; });
  if(!r){ el.innerHTML = ''; return; }
  const v = deriveVehicle(r);
  // Rough Δv sanity check shown in the setup panel, before launch: real Earth escape needs on the
  // order of 11.2-16 km/s depending on how efficient the ascent's gravity-turn/gravity losses are
  // (this sim's own escape-capable roster tops out flying real gravity-turn ascents in the
  // 11-16 km/s ideal-Δv band — see the ESCAPE-CAPABLE VEHICLES comment on stockRockets above), so
  // flag vehicles well short of that rather than let the user launch into a flight that can only
  // ever reach a suborbital arc or, at best, low Earth orbit.
  if(v.dv < 9000){
    el.innerHTML = '<div class="flag bad">⚠ This vehicle\'s Δv ('+fmt(v.dv)+' m/s) falls well short of what reaching '+(destination==='moon'?'the Moon':'Mars')+' needs. Try one of the escape-capable vehicles lower in the roster.</div>';
  } else if(v.dv < 11200){
    el.innerHTML = '<div class="flag warn">Δv is tight for an Earth-escape departure toward '+(destination==='moon'?'the Moon':'Mars')+' — a shallow gravity turn will help stretch it.</div>';
  } else {
    el.innerHTML = '<div class="flag good">Δv margin looks sufficient for an escape departure toward '+(destination==='moon'?'the Moon':'Mars')+'.</div>';
  }
}

// Setup-screen reset — separate from the in-flight "Reset" button (#resetBtn, which returns an
// active/finished flight to the setup screen). This one restores weather sliders and free-zoom
// back to their defaults so a messed-up setup can be started over without reloading the page.
// Vehicle selection is left alone: switching it is already one click in the roster below, and
// forcing it back to the stock default would silently discard a custom vehicle handed off from
// the calculator/designer, which isn't what "reset the settings" should do.

// Wiring + first paint, called once from js/main.js.
function initProfileUI(){
  document.getElementById('flightProfileChips').addEventListener('click', function(e){
    const btn = e.target.closest('[data-profile]');
    if(!btn) return;
    setFlightProfile(btn.dataset.profile);
    document.querySelectorAll('#flightProfileChips .chip').forEach(function(c){ c.classList.toggle('active', c === btn); });
    document.getElementById('flightProfileNote').textContent = FLIGHT_PROFILE_NOTES[flightProfile];
  });
  document.getElementById('destinationChips').addEventListener('click', function(e){
    const btn = e.target.closest('[data-destination]');
    if(!btn) return;
    setDestination(btn.dataset.destination);
    document.querySelectorAll('#destinationChips .chip').forEach(function(c){ c.classList.toggle('active', c === btn); });
    document.getElementById('destinationNote').textContent = DESTINATION_NOTES[destination];
    renderDestinationDvCheck();
  });
  renderDestinationDvCheck();
  document.getElementById('resetSetupBtn').addEventListener('click', function(){
    Object.assign(weather, DEFAULT_WEATHER);
    syncWeatherInputs();
    clearActivePreset();
    renderLaunchCriteria();
    setUserZoom(1);
    if(typeof updateZoomHint === 'function') updateZoomHint();
    setFlightProfile(DEFAULT_FLIGHT_PROFILE);
    document.querySelectorAll('#flightProfileChips .chip').forEach(function(c){ c.classList.toggle('active', c.dataset.profile === DEFAULT_FLIGHT_PROFILE); });
    document.getElementById('flightProfileNote').textContent = FLIGHT_PROFILE_NOTES[DEFAULT_FLIGHT_PROFILE];
    setDestination(DEFAULT_DESTINATION);
    document.querySelectorAll('#destinationChips .chip').forEach(function(c){ c.classList.toggle('active', c.dataset.destination === DEFAULT_DESTINATION); });
    document.getElementById('destinationNote').textContent = DESTINATION_NOTES[DEFAULT_DESTINATION];
    renderDestinationDvCheck();
  });
}

export { initProfileUI, renderDestinationDvCheck };
