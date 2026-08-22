import * as THREE from "three";
import { R_PLANET } from "../core/constants.js";
import { sim } from "../flight/controller.js";
import { worldAltitude, worldDownrange } from "../flight/loop.js";
import { mod2pi } from "../sim/orbit.js";
import { scene } from "./three-setup.js";

// The orbit ring and its apoapsis/periapsis markers are built lazily on first use and only ever
// touched by this module.
let orbitPathMesh = null, apoMarker = null, periMarker = null;

/* ================================================================================
   ORBIT PATH VISUAL — once a stable orbit is captured (sim.orbit set, phase 'ORBIT'), draw the
   actual elliptical path as a line loop through the same (downrange, altitude) world-space mapping
   the rocket itself is drawn with, plus apoapsis/periapsis markers. This is the concrete answer to
   "let me actually see the orbit" — apoapsis/periapsis were previously HUD numbers only; now
   they're points on a visible ring the vehicle is seen circling.
   ================================================================================ */
const ORBIT_PATH_SEGMENTS = 128;
function buildOrbitPathIfNeeded(){
  if(orbitPathMesh) return;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array((ORBIT_PATH_SEGMENTS+1) * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color:0x6fd4e8, transparent:true, opacity:0.75 });
  orbitPathMesh = new THREE.Line(geo, mat);
  orbitPathMesh.visible = false;
  scene.add(orbitPathMesh);

  const markerGeo = new THREE.SphereGeometry(6, 12, 10);
  apoMarker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color:0xe0b13f }));
  periMarker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color:0xff6b58 }));
  apoMarker.visible = false; periMarker.visible = false;
  scene.add(apoMarker); scene.add(periMarker);
}

// Maps a point on the captured orbit (given by true anomaly nu) to the same visual (worldDownrange,
// worldAltitude) space the rocket is placed in, anchored so the path stays near the rocket's current
// unwrapped downrange (rather than always near the pad's original lap) as it accumulates orbits.
function orbitPointToWorld(orbit, nu, refDownrangeAngle){
  const r = orbit.a * (1 - orbit.e*orbit.e) / (1 + orbit.e*Math.cos(nu));
  const theta = nu + orbit.argPeriapsis; // angle from +y axis, same convention as propagateOrbit
  const alt = r - R_PLANET;
  // choose the unwrapped angle nearest refDownrangeAngle so the drawn loop sits next to the vehicle
  // instead of snapping back to its very first pass every frame
  let angle = theta * orbit.sense;
  let delta = angle - mod2pi(refDownrangeAngle);
  while(delta > Math.PI) delta -= 2*Math.PI;
  while(delta < -Math.PI) delta += 2*Math.PI;
  const unwrapped = refDownrangeAngle + delta;
  return { x: worldDownrange(unwrapped * R_PLANET), y: 3 + worldAltitude(Math.max(alt,0)) };
}

function updateOrbitPathVisual(){
  // BALLISTIC (suborbital) trajectories have sim.orbit set too — orbitalElementsFor() computes real
  // ellipse elements for ANY bound trajectory, including one whose periapsis is deep underground and
  // will re-enter well before ever reaching it. Drawing the full ring for one of those sends most of
  // the loop through orbitPointToWorld with alt clamped to 0 (ground level) for the entire underground
  // arc — since worldAltitude(0) sits near the pad while the vehicle itself is still near apoapsis at
  // altitude, the polyline connecting those two regions draws as a stray near-vertical line from the
  // vehicle's real position straight down to the ground, which has no physical meaning (the vehicle
  // was never going to trace that ring; it's going to hit atmosphere and come down long before
  // reaching that periapsis). Only draw the ring once periapsis actually clears the surface, i.e. once
  // it's a real stable orbit the vehicle will keep circling — the same bar sim.reachedOrbit already
  // uses to call a flight "orbit reached" rather than merely suborbital.
  const orbit = sim ? sim.orbit : null;
  const isRealOrbit = orbit && orbit.periapsis > R_PLANET + 500; // same margin captureOrbit/reachedOrbit require before calling a trajectory a stable orbit at all
  if(!sim || !isRealOrbit || (sim.phase !== 'ORBIT' && sim.phase !== 'BALLISTIC')){
    if(orbitPathMesh) orbitPathMesh.visible = false;
    if(apoMarker) apoMarker.visible = false;
    if(periMarker) periMarker.visible = false;
    return;
  }
  buildOrbitPathIfNeeded();
  const refAngle = sim.downrangeAngle || 0;
  const posAttr = orbitPathMesh.geometry.getAttribute('position');
  for(let i=0;i<=ORBIT_PATH_SEGMENTS;i++){
    const nu = (i/ORBIT_PATH_SEGMENTS) * Math.PI*2 - Math.PI;
    const p = orbitPointToWorld(orbit, nu, refAngle);
    posAttr.setXYZ(i, p.x, p.y, 0);
  }
  posAttr.needsUpdate = true;
  orbitPathMesh.geometry.computeBoundingSphere();
  orbitPathMesh.visible = true;

  const apoP = orbitPointToWorld(orbit, Math.PI, refAngle);   // true anomaly pi = apoapsis
  const periP = orbitPointToWorld(orbit, 0, refAngle);        // true anomaly 0 = periapsis
  apoMarker.position.set(apoP.x, apoP.y, 0);
  periMarker.position.set(periP.x, periP.y, 0);
  apoMarker.visible = true; periMarker.visible = true;
}

export { updateOrbitPathVisual };
