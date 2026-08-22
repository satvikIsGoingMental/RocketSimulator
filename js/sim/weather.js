import { noseCd } from "../data/rockets.js";
import { airDensity } from "./physics.js";

/* ================================================================================
   WEATHER — surface wind, upper-level wind shear, precipitation, cloud ceiling, and lightning
   risk, all user-controllable, feeding two things: (1) real physics — wind is a genuine velocity
   offset the drag model sees, so a crosswind actually pushes the ascent off a pure vertical line
   and increases dynamic pressure asymmetrically; (2) a rule-based go/no-go analysis modeled on
   real launch commit criteria (surface wind limits, shear limits, precipitation/lofted-debris
   rules, cloud rules, lightning proximity rules) — not a random scrub chance, but the same kind
   of itemized criteria list a real launch weather officer works from.
   ================================================================================ */
const weather = {
  surfaceWindSpeed: 4,      // m/s at the pad
  windDirDeg: 90,            // degrees, 0 = tailwind along +downrange, 90 = pure crosswind
  shearWindSpeed: 22,        // m/s, peak upper-level wind shear (roughly 8-12km alt band)
  precipitation: 'none',     // 'none' | 'light' | 'heavy'
  cloudCeilingM: 3000,       // m, cloud base altitude (lower = thicker/lower cloud deck)
  temperatureC: 18,
  lightningRisk: 'none',     // 'none' | 'possible' | 'active'
};
const DEFAULT_WEATHER = Object.assign({}, weather);

// Wind speed at a given altitude: surface wind near the ground, ramping up through a jet-stream-like
// shear layer around 8-12km (a simplified single-peak profile — real shear profiles are more complex,
// but this captures the real phenomenon that peak wind loading on an ascending vehicle usually isn't
// at the pad, it's from upper-level shear during max-Q).
function windSpeedAtAltitude(alt){
  const surface = weather.surfaceWindSpeed;
  const shearPeakAlt = 10000, shearWidth = 6000;
  const shearContribution = weather.shearWindSpeed * Math.exp(-Math.pow((alt - shearPeakAlt)/shearWidth, 2));
  return surface * Math.exp(-alt/2000) + shearContribution;
}

// Horizontal wind velocity vector (in the same tangent/radial local frame computeAccel uses),
// expressed as an offset to subtract from the vehicle's velocity before computing dynamic pressure
// and drag — aerodynamic force depends on airspeed through the air mass, not speed over the ground.
function windTangentialVelocity(alt){
  const speed = windSpeedAtAltitude(alt);
  // windDirDeg 90 = pure crosswind (full tangential component); 0/180 = pure headwind/tailwind
  // (no tangential component in this 2D in-plane model, since there's no separate downrange-normal
  // axis to push across — represented instead as extra/reduced axial drag via the sign below)
  return speed * Math.sin(weather.windDirDeg * Math.PI/180);
}
function windRadialVelocity(alt){
  const speed = windSpeedAtAltitude(alt);
  return speed * Math.cos(weather.windDirDeg * Math.PI/180) * 0.15; // radial wind component heavily damped — vertical wind is physically minor next to horizontal
}

/* ---------------- launch commit criteria — rule-based go/no-go, not a random scrub chance ----------------
   Modeled loosely on real weather launch commit criteria (surface wind limits at the pad, upper-
   level shear limits during max-Q, precipitation/lofted-debris rules, cloud thickness/triboelectric
   rules, and lightning proximity rules). Each criterion independently evaluates to GO / CAUTION / NO-GO
   with a concrete numeric threshold and the actual measurement that tripped it, the way a real launch
   weather brief itemizes violations rather than reporting one opaque percentage. */
function evaluateLaunchCriteria(vehicle){
  const criteria = [];
  const cd = noseCd[vehicle.nose] || 0.4;
  const diam = vehicle.diam;

  // Surface wind — real vehicles have a documented pad wind limit; scale it down slightly for
  // slender/high-fineness vehicles (more wind-sensitive standing on the pad) vs. a flat baseline.
  const surfaceLimit = 15 - Math.min(4, diam*0.3); // m/s, rough stand-in for a real per-vehicle pad wind limit
  {
    const v = weather.surfaceWindSpeed;
    let status = 'GO', detail = 'Within pad wind limits.';
    if(v >= surfaceLimit){ status = 'NO-GO'; detail = 'Exceeds the '+surfaceLimit.toFixed(0)+' m/s pad wind limit for this vehicle.'; }
    else if(v >= surfaceLimit*0.75){ status = 'CAUTION'; detail = 'Approaching the '+surfaceLimit.toFixed(0)+' m/s pad wind limit.'; }
    criteria.push({ name:'Surface wind', value: v.toFixed(1)+' m/s', limit: surfaceLimit.toFixed(0)+' m/s', status, detail });
  }

  // Upper-level wind shear — real launches are frequently scrubbed for this even in calm surface
  // conditions, since shear loads the vehicle structurally during max-Q, not at the pad.
  {
    const v = weather.shearWindSpeed;
    const shearLimit = 30;
    let status = 'GO', detail = 'Upper-level shear within structural margins.';
    if(v >= shearLimit){ status = 'NO-GO'; detail = 'Peak shear exceeds the '+shearLimit+' m/s structural limit around max-Q.'; }
    else if(v >= shearLimit*0.7){ status = 'CAUTION'; detail = 'Shear is significant — expect a rougher, more throttled max-Q.'; }
    criteria.push({ name:'Upper-level wind shear', value: v.toFixed(1)+' m/s', limit: shearLimit+' m/s', status, detail });
  }

  // Precipitation — rain during ascent erodes thermal protection and risks static buildup; heavy
  // precipitation is a hard scrub for almost every real vehicle.
  {
    const p = weather.precipitation;
    let status = 'GO', detail = 'No precipitation.';
    if(p === 'heavy'){ status = 'NO-GO'; detail = 'Heavy precipitation risks TPS erosion and triboelectric charging — hard scrub.'; }
    else if(p === 'light'){ status = 'CAUTION'; detail = 'Light precipitation — within limits but reduces margin.'; }
    criteria.push({ name:'Precipitation', value: p, limit:'none/light only', status, detail });
  }

  // Cloud ceiling / thickness — thick, low cloud decks are a lightning-triggering risk (the vehicle's
  // own exhaust plume can trigger a strike through a thick enough charged cloud layer) independent of
  // whether lightning has actually been observed.
  {
    const ceil = weather.cloudCeilingM;
    const ceilLimit = 1500;
    let status = 'GO', detail = 'Cloud ceiling clear of triggered-lightning risk altitude.';
    if(ceil < ceilLimit){ status = 'NO-GO'; detail = 'Ceiling below '+ceilLimit+'m — thick low cloud risks triggered lightning through the exhaust plume.'; }
    else if(ceil < ceilLimit*2){ status = 'CAUTION'; detail = 'Moderate cloud ceiling — within limits but worth monitoring.'; }
    criteria.push({ name:'Cloud ceiling', value: Math.round(ceil)+' m', limit:'≥ '+ceilLimit+' m', status, detail });
  }

  // Lightning — the most unambiguous hard scrub in any real launch commit criteria set.
  {
    const risk = weather.lightningRisk;
    let status = 'GO', detail = 'No lightning risk.';
    if(risk === 'active'){ status = 'NO-GO'; detail = 'Active lightning or a lightning warning within range — automatic hold.'; }
    else if(risk === 'possible'){ status = 'CAUTION'; detail = 'Conditions favorable for lightning — range safety monitoring closely.'; }
    criteria.push({ name:'Lightning', value: risk, limit:'none', status, detail });
  }

  // Dynamic pressure at estimated max-Q under these wind conditions — folds the vehicle's own
  // aerodynamic shape into the weather assessment rather than treating weather as vehicle-agnostic.
  {
    const maxQAlt = 12000; // representative altitude band for max-Q on a typical ascent profile
    const shear = windSpeedAtAltitude(maxQAlt);
    const rho = airDensity(maxQAlt);
    const estAscentSpeed = 340; // representative transonic ascent speed near max-Q
    const relSpeed = estAscentSpeed + shear*0.3; // crude coupling: crosswind shear adds to effective dynamic pressure
    const frontalArea = Math.PI*Math.pow(diam/2,2);
    const qEst = 0.5*rho*relSpeed*relSpeed*cd*frontalArea/1000; // kN, rough structural-load proxy
    const qLimit = 45 + diam*3;
    let status = 'GO', detail = 'Estimated max-Q load within structural margins for this airframe.';
    if(qEst >= qLimit){ status = 'NO-GO'; detail = 'Estimated max-Q load exceeds structural margin given current shear.'; }
    else if(qEst >= qLimit*0.8){ status = 'CAUTION'; detail = 'Max-Q load is elevated — margin is thin.'; }
    criteria.push({ name:'Estimated max-Q load', value: Math.round(qEst)+' kN·proxy', limit: Math.round(qLimit)+' kN·proxy', status, detail });
  }

  const noGoCount = criteria.filter(function(c){ return c.status === 'NO-GO'; }).length;
  const cautionCount = criteria.filter(function(c){ return c.status === 'CAUTION'; }).length;
  const overall = noGoCount > 0 ? 'NO-GO' : (cautionCount > 0 ? 'CAUTION' : 'GO');
  // scrub likelihood: not a random draw, but a deterministic read-out of how many criteria are
  // violated/marginal, framed the way a real weather brief would state confidence in a scrub
  const scrubLikelihoodPct = Math.min(97, noGoCount*38 + cautionCount*12);

  return { criteria, overall, noGoCount, cautionCount, scrubLikelihoodPct };
}

export { DEFAULT_WEATHER, evaluateLaunchCriteria, weather, windRadialVelocity, windTangentialVelocity };
