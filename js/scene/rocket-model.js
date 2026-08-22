import * as THREE from "three";
import { rockets } from "../data/handoff.js";
import { deriveVehicle } from "../sim/physics.js";
import { selectedRocketId } from "../ui/roster-ui.js";
import { orbitState } from "./controls.js";
import { getHullTexture } from "./textures.js";
import { rocketGroup } from "./three-setup.js";

// Meshes owned by the procedural model builder below — declared here rather than in three-setup.js
// because buildRocketModel() is the only thing that ever assigns them; three-setup only creates the
// empty rocketGroup they get parented to.
let coreMeshGroup, boosterMeshes = [], flameMeshes = [], boosterFlameMeshes = [];

/* ================================================================================
   PROCEDURAL ROCKET MODEL — built from rocket-calc.html's geometry fields

   Earlier this was a single CylinderGeometry body with a cone/sphere/flat nose cap, one paint
   stripe, four flat box "fins," and a solid cone for each engine bell — recognizable as "a
   rocket" only in silhouette. This rebuild generates the body and nose as a single lathed
   revolution profile using each nose type's real aerodynamic curve (true von Kármán ogive,
   true elliptical, straight conical, flat-faced with a chamfer) instead of primitive stand-ins,
   adds an interstage taper and engine skirt flare so the hull reads as tankage rather than a
   tube, gives fins actual swept/tapered silhouettes, and builds each engine as a nested
   chamber+bell+skirt with a mounting plate instead of one solid cone. Still fully procedural and
   driven by the same vehicle fields (diam, length, nose type, engine count) so every roster
   vehicle — and any future custom/designer-built vehicle — generates correctly with no
   per-vehicle hardcoded meshes.
   ================================================================================ */
let rocketDims = null; // { diam, coreLen, boosterDiam, boosterLen, nboost }

// Fallback for vehicles that don't specify an explicit engine count (e.g. a custom vehicle handed
// off from the calculator): cluster more, smaller engines onto wider/higher-thrust stages, the way
// real launch vehicles trade single large engines for clustered smaller ones as thrust scales up.
function estimateEngineCount(thrustKN, diam){
  const perEngineTarget = 800 + diam*120; // kN per engine, roughly scaling with available base diameter
  const n = Math.round(thrustKN / perEngineTarget);
  return Math.max(1, Math.min(33, n));
}

/* Radius-as-a-function-of-axial-position profiles for each nose shape, sampled into a lathe curve.
   x runs 0 (base, full body radius) to 1 (tip, radius 0). Real curves, not primitive stand-ins:
    - ogive: von Kármán profile, y = (R/√π)·√(θ − sin(2θ)/2), θ = arccos(1 − 2x) — the low-drag
      shape actually used on most modern boosters, notably NOT a cone despite looking similar.
    - elliptical: true quarter-ellipse, y = R·√(1 − x²).
    - conical: straight taper.
    - flat: near-full radius until very close to the tip, then a short chamfer — a blunt face,
      not a point. */
function noseRadiusProfile(nose, xFrac){
  const x = Math.max(0, Math.min(1, xFrac));
  if(nose === 'elliptical'){
    return Math.sqrt(Math.max(0, 1 - x*x));
  }
  if(nose === 'flat'){
    if(x < 0.85) return 1 - x*0.05;
    const t = (x-0.85)/0.15;
    return (1-0.85*0.05) * (1-t) + 0.02*t;
  }
  if(nose === 'conical'){
    return 1 - x;
  }
  // ogive (default) — von Kármán. theta is parameterized from the tip (x=1 -> theta=0) so the
  // profile is full radius at the base (x=0) and comes to a point at the tip (x=1), matching
  // every other nose profile's convention here. Feeding x in directly instead of (1-x) inverts
  // the curve — bulbous at the tip, pinched at the base — i.e. the nose renders upside-down.
  const theta = Math.acos(Math.max(-1, Math.min(1, 1 - 2*(1 - x))));
  return Math.sqrt(Math.max(0, (theta - Math.sin(2*theta)/2) / Math.PI));
}

/* Builds one lathed profile for the whole hull: a short flared engine skirt at the base, a
   cylindrical tank section (with a subtle interstage taper partway up so it doesn't read as a
   featureless tube), then the nose curve running up to a point/blunt tip. Returns a THREE.Mesh
   using LatheGeometry, UV-mapped along its length for the panel-line texture applied by the caller. */
function buildHullMesh(radius, cylLen, noseLen, nose, segments, material){
  const pts = [];
  const skirtLen = cylLen * 0.045;
  const interstageY = cylLen * 0.62;

  // engine skirt: slight outward flare at the very base for a mounting-structure silhouette
  pts.push(new THREE.Vector2(radius*1.06, 0));
  pts.push(new THREE.Vector2(radius*1.06, skirtLen*0.4));
  pts.push(new THREE.Vector2(radius, skirtLen));

  // main tank cylinder, with a subtle interstage taper so the hull isn't a featureless tube
  pts.push(new THREE.Vector2(radius, interstageY - cylLen*0.03));
  pts.push(new THREE.Vector2(radius*0.94, interstageY));
  pts.push(new THREE.Vector2(radius*0.94, interstageY + cylLen*0.05));
  pts.push(new THREE.Vector2(radius, interstageY + cylLen*0.09));
  pts.push(new THREE.Vector2(radius, cylLen));

  // nose curve, sampled from the analytic profile for this nose type
  const NOSE_SAMPLES = 14;
  for(let i=1;i<=NOSE_SAMPLES;i++){
    const t = i/NOSE_SAMPLES;
    const r = Math.max(0.0001, radius * noseRadiusProfile(nose, t));
    pts.push(new THREE.Vector2(r, cylLen + t*noseLen));
  }

  const geo = new THREE.LatheGeometry(pts, segments);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

function computeRocketDims(r){
  const v = deriveVehicle(r);
  const vol = r.density > 0 ? r.mprop / r.density : 10;
  const rad = r.diam/2;
  const capVol = rad > 0 ? (4/3)*Math.PI*Math.pow(rad,3) : 0;
  const cylVol = Math.max(vol - capVol, 0);
  const area = Math.PI * rad * rad;
  const cylLen = area > 0 ? cylVol/area : 5;
  const coreLen = Math.max(cylLen + r.diam, r.diam*3);

  // Boosters are modeled (per rocket-calc.html) as stages sharing the core's bulk density and
  // proportions, just scaled by propellant mass — so give them the core's fineness ratio scaled
  // by the cube root of their mass ratio, instead of an independent diameter/length solve that
  // can blow up when a "booster" actually carries as much propellant as the core (e.g. Falcon Heavy).
  let boosterLen = 0, boosterDiam = 0;
  if(r.nboost > 0){
    const massRatio = r.mprop > 0 ? r.mboost / r.mprop : 1;
    const linScale = Math.cbrt(Math.max(massRatio, 0.02));
    boosterDiam = Math.max(r.diam * linScale, r.diam * 0.18);
    boosterDiam = Math.min(boosterDiam, r.diam * 0.9);
    boosterLen = coreLen * (boosterDiam / r.diam);
  }

  // visual scale: real rockets range ~15m (Electron) to ~120m (Starship stack), keep in a display-friendly band
  const displayScale = Math.max(0.6, Math.min(2.2, 30/coreLen));

  return { diam:r.diam, coreLen, boosterDiam, boosterLen, nboost:r.nboost, displayScale };
}

/* Tapered, swept fin silhouette (extruded from a 2D outline) instead of a flat rectangular box —
   leading edge sweeps back from root to tip, trailing edge is near-vertical, tip chord is
   narrower than root chord, which is what makes a fin read as an aerodynamic control surface
   rather than a slab bolted on for silhouette only. */
function buildFinMesh(rootChord, tipChord, span, thickness, material){
  const shape = new THREE.Shape();
  const sweep = rootChord * 0.55; // how far back the leading edge sweeps over the span
  shape.moveTo(0, 0);
  shape.lineTo(rootChord, 0);
  shape.lineTo(sweep + tipChord, span);
  shape.lineTo(sweep, span);
  shape.lineTo(0, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled:false, curveSegments:1 });
  geo.translate(-rootChord*0.15, 0, -thickness/2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

/* One engine: combustion chamber (short wide cylinder) narrowing through a throat into a flared
   bell nozzle, sitting on a small mounting flange — three distinct geometric stages instead of a
   single solid cone, which is what makes it read as a nozzle rather than a party hat. */
function buildEngineMesh(engineRadius, engineMat, bellMat){
  const group = new THREE.Group();
  const chamberR = engineRadius * 0.62, chamberH = engineRadius * 0.5;
  const throatR = engineRadius * 0.4;
  const bellH = engineRadius * 1.35;

  const chamber = new THREE.Mesh(new THREE.CylinderGeometry(chamberR, throatR, chamberH, 14), engineMat);
  chamber.position.y = chamberH/2;
  group.add(chamber);

  const bellPts = [
    new THREE.Vector2(throatR, 0),
    new THREE.Vector2(throatR*1.05, -bellH*0.12),
    new THREE.Vector2(engineRadius*0.7, -bellH*0.55),
    new THREE.Vector2(engineRadius, -bellH),
  ];
  const bellGeo = new THREE.LatheGeometry(bellPts, 14);
  const bell = new THREE.Mesh(bellGeo, bellMat);
  group.add(bell);

  const flange = new THREE.Mesh(new THREE.CylinderGeometry(chamberR*1.15, chamberR*1.15, chamberH*0.18, 14), bellMat);
  flange.position.y = chamberH*0.05;
  group.add(flange);

  group.castShadow = true;
  group.traverse(function(o){ if(o.isMesh) o.castShadow = true; });
  return group;
}


// Small RCS thruster pod greeble, scattered near the top of a hull for close-range detail.
function buildRcsPod(scale, material){
  const group = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(scale*0.9, scale*0.6, scale*0.7), material);
  group.add(box);
  const nozzleGeo = new THREE.ConeGeometry(scale*0.16, scale*0.4, 8);
  [[1,0,0],[-1,0,0],[0,0,1]].forEach(function(dir){
    const nz = new THREE.Mesh(nozzleGeo, material);
    nz.position.set(dir[0]*scale*0.55, 0, dir[2]*scale*0.55);
    nz.rotation.z = dir[0] !== 0 ? Math.sign(dir[0]) * Math.PI/2 : 0;
    nz.rotation.x = dir[2] !== 0 ? Math.sign(dir[2]) * Math.PI/2 : 0;
    group.add(nz);
  });
  group.castShadow = true;
  group.traverse(function(o){ if(o.isMesh) o.castShadow = true; });
  return group;
}

function buildRocketModel(){
  // clear old — dispose each removed mesh's own geometry/material so switching vehicles
  // repeatedly (or repeated calculator-handoff rebuilds via applyHandoffRefresh) doesn't
  // leak GPU buffers. The shared hull texture (hullTextureCache) is intentionally NOT
  // disposed here since it's cached and reused across rebuilds, not per-instance.
  while(rocketGroup.children.length){
    const child = rocketGroup.children[0];
    child.traverse(function(o){
      if(!o.isMesh) return;
      if(o.geometry) o.geometry.dispose();
      if(o.material){
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function(m){ m.dispose(); });
      }
    });
    rocketGroup.remove(child);
  }
  flameMeshes = []; boosterFlameMeshes = []; boosterMeshes = [];

  const r = rockets.find(function(x){ return x.id === selectedRocketId; });
  const dims = computeRocketDims(r);
  rocketDims = dims;
  const s = dims.displayScale;

  const hullTex = getHullTexture();
  const bodyMat = new THREE.MeshStandardMaterial({ color:0xe7e9e4, roughness:0.5, metalness:0.12, map:hullTex });
  const stripeMat = new THREE.MeshStandardMaterial({ color:0xc8501f, roughness:0.5 });
  const boosterMat = new THREE.MeshStandardMaterial({ color:0xd7d9d2, roughness:0.55, metalness:0.12, map:hullTex });
  const engineMat = new THREE.MeshStandardMaterial({ color:0x33342f, roughness:0.4, metalness:0.65 });
  const bellMat = new THREE.MeshStandardMaterial({ color:0x8a8d88, roughness:0.35, metalness:0.75 });
  const darkTrimMat = new THREE.MeshStandardMaterial({ color:0x21241f, roughness:0.6, metalness:0.4 });
  const boosterBandMat = new THREE.MeshStandardMaterial({ color:0xa3730a, roughness:0.5 });

  const radius = (dims.diam/2) * s;
  const cylLen = Math.max(dims.coreLen - dims.diam, dims.diam) * s;
  const noseLen = dims.diam * 1.1 * s;

  const core = new THREE.Group();

  const hullSegments = radius > 1.4 ? 32 : 22; // more sides on wide stages, where faceting would otherwise show
  const hull = buildHullMesh(radius, cylLen, noseLen, r.nose, hullSegments, bodyMat);
  // stretch the texture's panel/rivet detail along the real hull length so it doesn't look stretched
  // or squashed differently between a stubby Electron and a towering Saturn V core
  hullTex.repeat.set(1, Math.max(1, cylLen/ (radius*2.2)));
  core.add(hull);

  // accent stripe band, wrapped around the tank section
  const bandGeo = new THREE.CylinderGeometry(radius*1.012, radius*1.012, cylLen*0.055, hullSegments);
  const band = new THREE.Mesh(bandGeo, stripeMat);
  band.position.y = cylLen*0.32;
  band.castShadow = true;
  core.add(band);

  // fins — four swept, tapered control surfaces at the base
  const finRoot = radius*0.85, finTip = radius*0.32, finSpan = cylLen*0.17, finThick = Math.max(0.05*s, radius*0.05);
  for(let i=0;i<4;i++){
    const fin = buildFinMesh(finRoot, finTip, finSpan, finThick, stripeMat);
    const ang = (i/4)*Math.PI*2;
    fin.position.set(Math.cos(ang)*radius*0.98, cylLen*0.02, Math.sin(ang)*radius*0.98);
    fin.rotation.y = -ang + Math.PI/2;
    core.add(fin);
  }

  // RCS thruster pods near the top of the tank section, for close-range detail on larger vehicles
  if(radius > 0.5){
    const podScale = radius*0.22;
    for(let i=0;i<3;i++){
      const ang = (i/3)*Math.PI*2 + 0.4;
      const pod = buildRcsPod(podScale, darkTrimMat);
      pod.position.set(Math.cos(ang)*radius*0.97, cylLen*0.92, Math.sin(ang)*radius*0.97);
      pod.rotation.y = -ang;
      core.add(pod);
    }
  }

  // core engine cluster — count comes from the vehicle's own data when available, otherwise
  // estimated from thrust/diameter so any vehicle (roster, custom, or future designer-built)
  // gets a sensible cluster instead of silently defaulting to a single engine
  const engineCount = Math.max(1, Math.round(r.engines || estimateEngineCount(r.thrust, r.diam)));
  const engineRadius = radius / Math.max(3, Math.sqrt(engineCount)*1.6);
  const flameGroupCore = new THREE.Group();
  const enginePositions = layoutEnginePositions(engineCount, radius*0.55);
  for(let i=0;i<engineCount;i++){
    const pos = enginePositions[i];
    const engine = buildEngineMesh(engineRadius, engineMat, bellMat);
    engine.position.set(pos.x, 0, pos.z);
    core.add(engine);

    const ringOffset = Math.hypot(pos.x, pos.z);
    const flame = makeFlame(engineRadius, radius, ringOffset);
    flame.position.set(pos.x, -engineRadius*1.3, pos.z);
    flame.visible = false;
    flame.traverse(function(o){ if(o.isMesh) o.renderOrder += 10; });
    flameGroupCore.add(flame);
  }
  core.add(flameGroupCore);
  flameMeshes.push(flameGroupCore);

  core.position.y = 0;
  rocketGroup.add(core);
  coreMeshGroup = core;

  // boosters
  if(dims.nboost > 0){
    const bRadius = (dims.boosterDiam/2) * s;
    const bCylLen = Math.max(dims.boosterLen - dims.boosterDiam, dims.boosterDiam) * s;
    const bNoseLen = dims.boosterDiam * 1.1 * s;
    const offset = radius + bRadius + 0.15*s;
    const bSegments = bRadius > 1.2 ? 26 : 18;
    const bEngineCount = Math.max(1, Math.round(r.boosterEngines || estimateEngineCount(r.fboost, r.diam)));
    const bEnginePositions = layoutEnginePositions(bEngineCount, bRadius*0.5);

    for(let i=0;i<dims.nboost;i++){
      const bGroup = new THREE.Group();
      const ang = dims.nboost===2 ? (i===0?0:Math.PI) : (i/dims.nboost)*Math.PI*2;
      const bx = Math.cos(ang)*offset, bz = Math.sin(ang)*offset;

      const bHull = buildHullMesh(bRadius, bCylLen, bNoseLen, r.nose, bSegments, boosterMat);
      bGroup.add(bHull);

      const bBand = new THREE.Mesh(new THREE.CylinderGeometry(bRadius*1.012,bRadius*1.012,bCylLen*0.07,bSegments), boosterBandMat);
      bBand.position.y = bCylLen*0.28;
      bGroup.add(bBand);

      const bEngineR = bRadius / Math.max(2.4, Math.sqrt(bEngineCount)*1.4);
      const bFlameGroup = new THREE.Group();
      for(let j=0;j<bEngineCount;j++){
        const pos = bEnginePositions[j];
        const bEngine = buildEngineMesh(bEngineR, engineMat, bellMat);
        bEngine.position.set(pos.x, 0, pos.z);
        bGroup.add(bEngine);

        const bRingOffset = Math.hypot(pos.x, pos.z);
        const bFlame = makeFlame(bEngineR, bRadius, bRingOffset);
        bFlame.position.set(pos.x, -bEngineR*1.3, pos.z);
        bFlame.visible = false;
        bFlame.traverse(function(o){ if(o.isMesh) o.renderOrder += 10; });
        bFlameGroup.add(bFlame);
        boosterFlameMeshes.push(bFlame);
      }
      bGroup.add(bFlameGroup);

      bGroup.position.set(bx, 0, bz);
      rocketGroup.add(bGroup);
      boosterMeshes.push(bGroup);
    }
  }

  // position whole rocket on pad
  rocketGroup.position.set(0, 3, 0);
  rocketGroup.userData.dims = dims;
  rocketGroup.userData.scale = s;

  // reset camera near pad
  orbitState.dist = Math.max(24, dims.coreLen * s * 1.4);
}

/* Shared engine-cluster layout: 1 engine centered; 2-4 in a ring; 5+ gets a centered engine plus
   an outer ring (matching how real multi-engine clusters like the F-1 quincunx or Merlin octaweb
   are actually arranged) so engine count reads as a real cluster shape, not an arbitrary scatter. */
function layoutEnginePositions(count, ringRadius){
  const positions = [];
  if(count <= 1){
    positions.push({x:0, z:0});
    return positions;
  }
  if(count <= 4){
    for(let i=0;i<count;i++){
      const ang = (i/count)*Math.PI*2;
      positions.push({ x:Math.cos(ang)*ringRadius*0.62, z:Math.sin(ang)*ringRadius*0.62 });
    }
    return positions;
  }
  // center engine + ring for the remainder
  positions.push({x:0, z:0});
  const ringCount = count - 1;
  for(let i=0;i<ringCount;i++){
    const ang = (i/ringCount)*Math.PI*2;
    positions.push({ x:Math.cos(ang)*ringRadius, z:Math.sin(ang)*ringRadius });
  }
  return positions;
}

// Shared geometry for every flame layer across every engine on every vehicle — a cone scaled per
// engine radius looks identical to one built at that radius, so there's no reason to allocate a
// fresh geometry per engine (rockets with 9-33 engines would otherwise upload that many buffers).
let flameCoreGeo = null, flameGlowGeo = null, flameDiamondGeo = null;
function flameSharedGeo(){
  if(!flameCoreGeo){
    flameCoreGeo = new THREE.ConeGeometry(0.85, 4, 12, 1, true);
    flameGlowGeo = new THREE.ConeGeometry(1, 4, 12, 1, true);
    flameDiamondGeo = new THREE.TorusGeometry(0.4, 0.11, 8, 14);
  }
  return { core:flameCoreGeo, glow:flameGlowGeo, diamond:flameDiamondGeo };
}

/* Layered rocket exhaust: a tight bright-white core (the hottest, densest part of the plume),
   wrapped in a wider soft orange glow (additive-blended so overlapping layers brighten instead of
   just occluding each other, the way a real luminous gas plume does), plus a couple of thin "shock
   diamond" rings standing in for the banded shockwave pattern visible in real vacuum-expanding
   exhaust. Everything here is a THREE.Group so updateEngineVisuals can flicker/scale the whole
   plume together, and PLUME_STATE (attached via userData) carries the per-engine random phase so a
   cluster of engines doesn't flicker in lockstep like a single strobing light. */
function makeFlame(radius, hullRadius, ringOffset){
  const geo = flameSharedGeo();
  const group = new THREE.Group();

  // A real exhaust plume flares out visibly wider than the nozzle it left, especially for small,
  // tightly-clustered engines (Electron's 9 Rutherfords) where neighboring plumes merge into one
  // bright column. Deriving the flame's size directly from the physical engineRadius (as this
  // function used to) instead shrinks it in lockstep with the engine, so a small-diameter, many-
  // engine vehicle ends up with flame cones a few hundredths of a world unit wide — thin enough to
  // read as bare white needles with no visible glow at all once the additive-blended orange layer
  // drops below a couple of screen pixels. flameRadius keeps the physical engineRadius for spacing/
  // position (layoutEnginePositions et al, and the engine bell mesh itself, still use the real
  // radius) but floors the SIZE the flame is built at relative to hullRadius — a fixed multiple of
  // the per-engine radius (tried 1.4x) just rescales the same problem, since a 9-engine cluster's
  // individual radius is already tiny relative to its hull; anchoring the floor to hull size instead
  // keeps the flame legible without ever letting it swallow the airframe on any vehicle in the roster.
  // For an off-axis engine in a ring (ringOffset = distance of that engine from the rocket's
  // centerline), the widened glow layer's outer edge sits at ringOffset + flameRadius*widthMul — if
  // that's left uncapped, an outer engine in a tightly-packed cluster (Electron's 9 Rutherfords ring
  // at ringOffset ~0.33 with hullRadius 0.6) floors to 0.4*hullRadius=0.24 and pushes its glow edge
  // out past the hull, up into the fins mounted at the base. Capping the floor by how much clearance
  // is actually left between that engine and the hull edge keeps the merged column bright without
  // letting individual off-axis flames poke out sideways through the airframe.
  const clearance = hullRadius ? Math.max(radius, (hullRadius - (ringOffset||0)) * 0.9) : Infinity;
  const flameRadius = hullRadius ? Math.min(clearance, Math.max(radius, hullRadius * 0.4)) : radius;

  const glowMat = new THREE.MeshBasicMaterial({
    color:0xff7a2e, transparent:true, opacity:0.55, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(geo.glow, glowMat);
  glow.scale.set(flameRadius, flameRadius*4.6, flameRadius);
  glow.rotation.x = Math.PI;
  // geo.glow (ConeGeometry height 4) is centered on its own origin, with its apex at local y=+2 and
  // base at y=-2 before the 180 deg flip above swaps them (apex -> -2, base -> +2). Left at
  // position.y=0, the wide base would sit 2x the Y scale *above* the flame's own origin, poking up
  // past the nozzle exit into the engine/hull instead of hanging entirely below it, so shift the
  // whole cone down by that same amount to pin the base at the origin and let the tapered tip trail
  // away downward.
  glow.position.y = -flameRadius*4.6*2;
  glow.renderOrder = 1;
  group.add(glow);

  const coreMat = new THREE.MeshBasicMaterial({
    color:0xfff2c0, transparent:true, opacity:0.95, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide,
  });
  const core = new THREE.Mesh(geo.core, coreMat);
  core.scale.set(flameRadius, flameRadius*3.1, flameRadius);
  core.rotation.x = Math.PI;
  core.position.y = -flameRadius*3.1*2;
  core.renderOrder = 2;
  group.add(core);

  const diamondMat = new THREE.MeshBasicMaterial({
    color:0xbfe8ff, transparent:true, opacity:0.5, blending:THREE.AdditiveBlending, depthWrite:false,
  });
  const diamonds = [];
  for(let i=0;i<2;i++){
    const d = new THREE.Mesh(geo.diamond, diamondMat.clone());
    d.rotation.x = Math.PI/2;
    d.scale.setScalar(flameRadius * (0.62 - i*0.16));
    d.position.y = -flameRadius*(1.4 + i*1.35);
    d.renderOrder = 3;
    group.add(d);
    diamonds.push(d);
  }

  group.userData.plume = { glow, core, diamonds, radius:flameRadius, seed: Math.random()*100 };
  return group;
}

export { boosterFlameMeshes, boosterMeshes, buildRocketModel, coreMeshGroup, flameMeshes, rocketDims };
