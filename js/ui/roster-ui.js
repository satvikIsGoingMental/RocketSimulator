import { escapeHtml, fmt } from "../core/format.js";
import { HANDOFF_KEY, customVehicleRaw, refreshRosterFromHandoff, rockets } from "../data/handoff.js";
import { flightActive, resetFlightView, reviewMode } from "../flight/controller.js";
import { buildRocketModel } from "../scene/rocket-model.js";
import { deriveVehicle } from "../sim/physics.js";
import { renderLaunchCriteria } from "./criteria-ui.js";
import { renderDestinationDvCheck } from "./profile-ui.js";

/* ================================================================================
   UI: rocket picker
   ================================================================================ */
const rocketList = document.getElementById('rocketList');
const rocketDetail = document.getElementById('rocketDetail');
let selectedRocketId = rockets[0].id;


function rocketSilhouette(r){
  const h = Math.max(10, Math.min(30, 10 + (r.thrust + r.nboost*r.fboost) / 400));
  return '<svg width="16" height="30" viewBox="0 0 18 34"><rect x="6" y="'+(34-h)+'" width="6" height="'+h+'" rx="1.5" fill="var(--accent)" opacity="0.85"/>'+
    (r.nboost>0 ? '<rect x="1" y="'+(34-h*0.8)+'" width="4" height="'+(h*0.8)+'" rx="1.2" fill="var(--warn)" opacity="0.8"/><rect x="13" y="'+(34-h*0.8)+'" width="4" height="'+(h*0.8)+'" rx="1.2" fill="var(--warn)" opacity="0.8"/>' : '')+
    '</svg>';
}

function renderRocketList(){
  rocketList.innerHTML = rockets.map(function(r){
    return '<button type="button" class="rocket-card'+(selectedRocketId===r.id?' active':'')+'" data-id="'+escapeHtml(r.id)+'">'+
      '<span class="rk-shape">'+rocketSilhouette(r)+'</span>'+
      '<span class="rk-info"><span class="rk-name">'+escapeHtml(r.name)+'</span><span class="rk-meta">'+escapeHtml(r.maker)+' · Ø'+r.diam+'m</span></span>'+
      '</button>';
  }).join('');
  Array.from(rocketList.querySelectorAll('.rocket-card')).forEach(function(card){
    card.addEventListener('click', function(){
      selectRocket(card.getAttribute('data-id'));
    });
  });
}

function renderRocketDetail(){
  const r = rockets.find(function(x){ return x.id === selectedRocketId; });
  const v = deriveVehicle(r);
  const totalThrust = r.thrust + r.nboost*r.fboost;
  const totalProp = r.mprop + r.nboost*r.mboost;
  rocketDetail.innerHTML =
    '<div class="rk-title">'+escapeHtml(r.name)+'</div>'+
    '<div>'+escapeHtml(r.fact)+'</div>'+
    '<div style="margin-top:4px;"><b>'+fmt(totalThrust)+' kN</b> combined liftoff thrust &nbsp;·&nbsp; <b>'+fmt(totalProp)+' kg</b> total propellant'+(r.nboost>0 ? ' &nbsp;·&nbsp; <b>'+r.nboost+'</b> boosters':'')+'</div>';

  document.getElementById('pf_dv').innerHTML = fmt(v.dv) + ' <span class="unit">m/s</span>';
  document.getElementById('pf_m0').innerHTML = fmt(v.m0) + ' <span class="unit">kg</span>';
  document.getElementById('pf_tw').textContent = v.tw.toFixed(2);
  document.getElementById('pf_tb').innerHTML = fmt(v.tbCore,1) + ' <span class="unit">s</span>';

  const flag = document.getElementById('pf_flag');
  if(v.tw < 1){
    flag.innerHTML = '<div class="flag bad">⚠ T/W below 1.0 — this vehicle cannot lift off.</div>';
  } else if(v.tw < 1.15){
    flag.innerHTML = '<div class="flag warn">T/W is thin — expect a slow climb off the pad.</div>';
  } else {
    flag.innerHTML = '<div class="flag good">T/W healthy for liftoff.</div>';
  }

  renderLaunchCriteria();
}

function selectRocket(id){
  selectedRocketId = id;
  renderRocketList();
  renderRocketDetail();
  buildRocketModel();
  resetFlightView();
  if(typeof renderDestinationDvCheck === 'function') renderDestinationDvCheck();
}

/* ---------------- live sync with rocket-calc.html ----------------
   Fires when the Δv Stack calculator (open in another tab, same origin) writes a new vehicle to
   localStorage. Only safe to act on this while still on the pre-flight setup screen — swapping
   the vehicle definition out from under an in-progress or completed flight would desync the HUD,
   the sim's derived physics, and the 3D model mid-animation, so an update that arrives during or
   after a flight is picked up the next time the user returns to Reset/setup instead of applied
   immediately. */
let pendingHandoffRefresh = false;
function applyHandoffRefresh(){
  const hadCustom = customVehicleRaw !== null;
  const wasSelectedCustom = selectedRocketId === 'custom';
  refreshRosterFromHandoff();
  pendingHandoffRefresh = false;
  // keep following the custom vehicle if it was selected (or nothing else was) when it updates;
  // if it just newly appeared, jump to it so the freshly-launched calculator input is what loads
  if(customVehicleRaw && (wasSelectedCustom || !hadCustom)){
    selectedRocketId = 'custom';
  } else if(!customVehicleRaw && wasSelectedCustom){
    selectedRocketId = rockets[0].id; // custom vehicle was cleared while selected — fall back to roster top
  }
  renderRocketList();
  renderRocketDetail();
  buildRocketModel();
}

// Wiring + first paint, called once from js/main.js.
function initRosterUI(){
  renderRocketList();
  renderRocketDetail();
  window.addEventListener('storage', function(e){
    if(e.key !== null && e.key !== HANDOFF_KEY) return; // ignore unrelated keys; null key means "storage cleared"
    if(flightActive || reviewMode){
      pendingHandoffRefresh = true;
      return;
    }
    applyHandoffRefresh();
  });
}

export { applyHandoffRefresh, initRosterUI, pendingHandoffRefresh, selectedRocketId };
