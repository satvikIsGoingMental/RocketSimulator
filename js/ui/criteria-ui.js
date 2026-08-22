import { rockets } from "../data/handoff.js";
import { evaluateLaunchCriteria } from "../sim/weather.js";
import { selectedRocketId } from "./roster-ui.js";

/* Renders the itemized launch commit criteria breakdown for the currently selected vehicle under
   the currently configured weather. Re-run any time the vehicle or any weather control changes,
   so the go/no-go readout always reflects exactly what will happen if Ignition & Liftoff is
   pressed right now. */
function renderLaunchCriteria(){
  const r = rockets.find(function(x){ return x.id === selectedRocketId; });
  if(!r) return;
  const result = evaluateLaunchCriteria(r);

  const overallEl = document.getElementById('lcc_overall');
  const scrubNote = result.overall === 'GO'
    ? 'All criteria satisfied.'
    : (result.scrubLikelihoodPct >= 90 ? 'Almost certain scrub.' : result.scrubLikelihoodPct >= 50 ? 'Likely scrub.' : 'Possible scrub — marginal conditions.');
  overallEl.innerHTML = '<div class="lcc-overall '+result.overall+'">'+
    '<span>'+result.overall+'</span>'+
    '<span class="scrub-pct">'+(result.overall==='GO' ? scrubNote : result.scrubLikelihoodPct+'% scrub likelihood — '+scrubNote)+'</span>'+
    '</div>';

  const listEl = document.getElementById('lcc_list');
  listEl.innerHTML = result.criteria.map(function(c){
    return '<div class="lcc-row">'+
      '<div class="lcc-row-head">'+
        '<span class="lcc-row-name">'+c.name+'</span>'+
        '<span class="lcc-badge '+c.status+'">'+c.status+'</span>'+
      '</div>'+
      '<div class="lcc-row-head"><span class="lcc-row-value">'+c.value+' (limit '+c.limit+')</span></div>'+
      '<div class="lcc-row-detail">'+c.detail+'</div>'+
      '</div>';
  }).join('');
}

export { renderLaunchCriteria };
