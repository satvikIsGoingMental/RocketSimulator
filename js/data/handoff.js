import { noseCd, stockRockets } from "./rockets.js";

/* ================================================================================
   HANDOFF FROM Δv STACK CALCULATOR — rocket-calc.html writes the vehicle currently on
   screen there to localStorage on every change (same schema, see exportVehicleToLaunchSim
   in that file). If present, it's surfaced here as a selectable "Custom" vehicle built
   from those exact inputs, satisfying "use your inputs to launch the Rockets with your
   specific specs". A 'storage' event listener keeps it live if both tools are open at
   once — tweak a slider in the calculator tab, switch to this tab, and the roster/HUD
   reflect the new numbers without a reload.
   ================================================================================ */
const HANDOFF_KEY = 'dvstack.customVehicle.v1';
let rockets = stockRockets.slice();
let customVehicleRaw = null; // last-read handoff payload, or null if none/invalid

function readCustomVehicle(){
  let raw;
  try{
    raw = localStorage.getItem(HANDOFF_KEY);
  }catch(err){
    return null; // localStorage inaccessible (private browsing etc.) — behave as if nothing was saved
  }
  if(!raw) return null;
  let payload;
  try{
    payload = JSON.parse(raw);
  }catch(err){
    return null; // corrupt value — ignore rather than crash the roster build
  }
  if(!payload || payload.schema !== 1) return null; // unknown/future schema — ignore rather than misinterpret
  const required = ['isp','of','density','mprop','mpay','fstruct','diam','thrust','nose','nboost','fboost','mboost'];
  for(let i=0;i<required.length;i++){
    if(typeof payload[required[i]] !== 'number' && required[i] !== 'nose') return null;
  }
  if(typeof payload.nose !== 'string' || !(payload.nose in noseCd)) return null;
  // Type-checking alone lets through values that are numbers but not physically sane — 0 or negative
  // propellant/thrust/diameter, Infinity from a runaway calculator field, etc. deriveVehicle() has no
  // reason to expect those and doesn't defend against them, so they used to flow straight through into
  // the physics: a rocket that silently sinks through the pad at liftoff (mprop=0, so m0<=mf and dv
  // clamps to 0 while gravity still applies) or renders as nothing at all while falling forever (a
  // mass/thrust combination the display formats as "1000000.00M kg"). isp/diam/thrust/mprop can never
  // legitimately be zero for a vehicle that flies, so those reject at <= 0; of/density are carried
  // through from the calculator's sizing math but aren't consumed by anything in this file's physics,
  // and the calculator's own of_r slider allows 0 (a monopropellant has no meaningful oxidizer:fuel
  // ratio), so those two stay valid at 0 like the other not-always-present fields (mpay, the boosters).
  const strictlyPositive = ['isp','diam','thrust','mprop'];
  const nonNegative = ['mpay','nboost','fboost','mboost','of','density'];
  for(let i=0;i<strictlyPositive.length;i++){
    const v = payload[strictlyPositive[i]];
    if(!Number.isFinite(v) || v <= 0) return null;
  }
  for(let i=0;i<nonNegative.length;i++){
    const v = payload[nonNegative[i]];
    if(!Number.isFinite(v) || v < 0) return null;
  }
  if(!Number.isFinite(payload.fstruct) || payload.fstruct <= 0 || payload.fstruct >= 1) return null;
  return payload;
}

function buildCustomRocketEntry(payload){
  return {
    id:'custom', name: payload.label || 'Custom vehicle', maker:'Δv Stack calculator', diam: payload.diam,
    isp: payload.isp, of: payload.of, density: payload.density, nose: payload.nose,
    mprop: payload.mprop, mpay: payload.mpay, fstruct: payload.fstruct, thrust: payload.thrust,
    nboost: payload.nboost, fboost: payload.fboost, mboost: payload.mboost,
    fact: payload.basedOn
      ? 'Loaded from the Δv Stack calculator, starting from the '+(stockRockets.find(function(x){return x.id===payload.basedOn;})||{name:payload.basedOn}).name+' preset.'
      : 'Loaded from the Δv Stack calculator — every field matches what was on screen there.',
    isCustom: true,
  };
}

function refreshRosterFromHandoff(){
  customVehicleRaw = readCustomVehicle();
  rockets = customVehicleRaw ? [buildCustomRocketEntry(customVehicleRaw)].concat(stockRockets) : stockRockets.slice();
}
refreshRosterFromHandoff();

export { HANDOFF_KEY, customVehicleRaw, refreshRosterFromHandoff, rockets };
