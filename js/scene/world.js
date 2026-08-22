import * as THREE from "three";
import { KARMAN_LINE_M } from "../core/constants.js";
import { worldAltitude } from "../flight/loop.js";
import { makeTextSprite } from "./textures.js";
import { scene } from "./three-setup.js";

// Earth-only trees/grass tufts — hidden while landed on the Moon/Mars (see updateBodyLandingScene).
// Assigned by buildVegetation() below, which is why it lives here and not in three-setup.js.
let vegetationGroup = null;

/* ================================================================================
   WORLD SHELL — a large, low-poly curved ground surface standing in for "the planet, seen from
   altitude."

   The physics engine already models Earth as a true sphere (R_PLANET), but the VISUAL scene never
   did: the ground the pad sits on is one flat PlaneGeometry (see groundGeo above), so climbing high
   enough used to reveal a flat square edge rather than a curving horizon — "trippy... seeing a
   square" from up there, per the reported issue. A true 1:1-scale 6371km sphere isn't an option
   here (the whole scene already runs on a deliberately compressed visual scale — see worldAltitude/
   worldDownrange — specifically because rendering real distances would make the pad and nearby
   scenery imperceptibly small).

   First attempt used a literal SphereGeometry polar cap tangent to the pad — see the longer note at
   the top of buildWorldShell for why that was wrong: the pad sits exactly at the sphere's pole, the
   single most UV- and topology-degenerate point on a sphere, and it rendered as huge flat-shaded
   triangular wedges instead of a smooth curve. Fixed by keeping the SAME topology as the
   already-correct flat groundGeo (an evenly-tiled grid, no pole anywhere) and bending it into a
   curve entirely in the vertex shader — each vertex is pushed down by the small-angle sagitta
   approximation of a sphere's surface, y = -dist^2/(2*radius), which is smooth, seamless, and
   reuses exactly the UV/texture-tiling behavior already proven to work on the flat ground.
   ================================================================================ */
const WORLD_SHELL_RADIUS = 40000; // world units — the effective "planet radius" used by the sagitta
                                   // curvature formula in buildWorldShell; nested well inside
                                   // SKY_RADIUS(60000)/CAMERA_FAR(100000) so the shell's outer,
                                   // furthest-drooped edge stays inside the camera's far plane.

// Procedural, dependency-free terrain texture in the same spirit as makeGrassTexture — hand-rolled
// canvas blobs/gradients for landmass, ocean, lakes/rivers, and mountains, baked once at init as a
// single static texture (no live elevation/heightmap: this is a visual backdrop, not a simulated
// terrain, matching the "just needs to look like a landscape" scope of the request). Parameterized
// by palette so the exact same function later produces a grey cratered Moon or a rust-red Mars
// surface (see Stage 4) just by passing different colors/feature mix — one texture generator for
// every landable body in the sim, not a bespoke one per planet.
/* Builds the curved ground standing in for the planet's surface as seen from altitude.

   FIRST ATTEMPT (kept here as a note, not as history worth repeating): a polar-cap SphereGeometry
   positioned so its pole sat at the pad. That put the pad exactly at the sphere's pole — the one
   point where a sphere's standard UV mapping is most degenerate (every one of the 64 longitude
   segments converges there), and the geometry itself has the fewest, largest triangles right at the
   pole too (all "rings" of the low-poly mesh are tiny near theta=0 by construction). Seen from
   directly above that point — exactly the pad's-eye view this is mostly used from — that rendered as
   huge, flat-shaded triangular wedges radiating outward, not a smooth curved landscape. A sphere
   is the RIGHT final shape for a planet, but wrong TOPOLOGY for "a huge, gently-curving surface
   viewed edge-on from one particular point standing on it," which is what this sim actually needs.

   FIX: use a flat, evenly-subdivided PlaneGeometry (same topology as the existing near-pad groundGeo,
   which already tiles/textures correctly with zero UV distortion), and bend it into a curve entirely
   in the VERTEX SHADER, by displacing each vertex downward by an amount that grows with its distance
   from the pad — approximating a sphere's sagitta (drop-off) formula, y_offset = -dist^2/(2*radius),
   the standard small-angle approximation for how far a true sphere's surface falls below a tangent
   plane at a given distance from the tangent point. This keeps the exact same UV grid, texture
   tiling, and lighting model (MeshStandardMaterial, patched via onBeforeCompile so it keeps real
   diffuse/specular lighting from the scene's existing lights rather than needing a hand-rolled
   unlit shader) as the already-working flat ground, and simply pushes each vertex down along Y —
   there is no pole, so there is no degenerate point anywhere in this geometry regardless of where
   the camera stands on it. */
function buildWorldShell(radius, texture, opts){
  opts = opts || {};
  const span = opts.span || radius * 1.05; // half-width of the flat grid before it's curved, in world units
  const segments = opts.segments || 220;   // even grid subdivision — no pole, so this can stay modest
  const geo = new THREE.PlaneGeometry(span*2, span*2, segments, segments);
  geo.rotateX(-Math.PI/2); // lay flat like the existing groundGeo (PlaneGeometry is XY by default)

  const mat = new THREE.MeshStandardMaterial({ map: texture, color: 0xffffff, roughness: 1, fog: true });
  mat.onBeforeCompile = function(shader){
    shader.uniforms.curveRadius = { value: radius };
    shader.vertexShader = 'uniform float curveRadius;\n' + shader.vertexShader;
    // #include <begin_vertex> is three.js's standard injection point defining `vec3 transformed`
    // from the raw position attribute — displacing Y here (in local/object space, before any of the
    // standard model/view/projection transforms run) is the earliest, simplest place to bend the
    // mesh without fighting the rest of MeshStandardMaterial's generated shader.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' +
      '  float distFromCenter = length(position.xz);\n' +
      '  transformed.y -= (distFromCenter*distFromCenter) / (2.0 * curveRadius);\n'
    );
    // Recompute the normal to match the curve instead of leaving it straight up everywhere — for
    // y = -(x^2+z^2)/(2R), the analytic surface gradient gives normal = normalize(x/R, 1, z/R).
    // Without this the whole curved surface would shade as flat-lit (correct color, but visibly
    // "wrong" lighting on anything past the near-flat middle), since MeshStandardMaterial's lighting
    // depends on the normal, and #include <beginnormal_vertex> runs BEFORE begin_vertex normally
    // defines `objectNormal` from the geometry's untouched (flat, +Y) normal attribute.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n' +
      '  float ndFromCenter = length(position.xz);\n' +
      '  objectNormal = normalize(vec3(position.x/curveRadius, 1.0, position.z/curveRadius));\n'
    );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false; // a fogged, far-distance backdrop — shadow receiving here would be
                               // both invisible in practice and wasted GPU time
  return mesh;
}
// simple low-poly conifer/deciduous tree, instanced in rings around the pad so the field
// reads as a real landscape and gives the eye fixed-size objects to judge scale/speed against
function buildVegetation(){
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3.2, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color:0x5b4632, roughness:1 });
  const conifer1Geo = new THREE.ConeGeometry(2.6, 6.5, 8);
  const conifer2Geo = new THREE.ConeGeometry(2.0, 5.0, 8);
  const leafMatA = new THREE.MeshStandardMaterial({ color:0x3f6b3a, roughness:0.95 });
  const leafMatB = new THREE.MeshStandardMaterial({ color:0x4d7a42, roughness:0.95 });
  const roundLeafGeo = new THREE.SphereGeometry(2.4, 8, 6);

  const TREE_COUNT = 420;
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, TREE_COUNT);
  const conifer1Mesh = new THREE.InstancedMesh(conifer1Geo, leafMatA, TREE_COUNT);
  const conifer2Mesh = new THREE.InstancedMesh(conifer2Geo, leafMatB, TREE_COUNT);
  const roundMesh = new THREE.InstancedMesh(roundLeafGeo, leafMatB, TREE_COUNT);
  trunkMesh.castShadow = conifer1Mesh.castShadow = conifer2Mesh.castShadow = roundMesh.castShadow = true;
  trunkMesh.receiveShadow = conifer1Mesh.receiveShadow = conifer2Mesh.receiveShadow = roundMesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  let ci1=0, ci2=0, cr=0;
  // keep a clearing around the pad (radius ~55) so the launch complex stays readable, scatter
  // trees out to 900m in a few density bands so the near tree line is dense and it thins with range
  for(let i=0;i<TREE_COUNT;i++){
    const rad = 60 + Math.pow(Math.random(), 0.6) * 840;
    const ang = Math.random()*Math.PI*2;
    const x = Math.cos(ang)*rad, z = Math.sin(ang)*rad;
    const s = 0.6 + Math.random()*1.0;
    const rot = Math.random()*Math.PI*2;

    dummy.position.set(x, 1.6*s, z);
    dummy.rotation.set(0, rot, 0);
    dummy.scale.set(s,s,s);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(i, dummy.matrix);

    const kind = Math.random();
    if(kind < 0.45){
      dummy.position.set(x, 3.2*s + 3.2*s*0.5, z);
      dummy.scale.set(s,s,s);
      dummy.updateMatrix();
      conifer1Mesh.setMatrixAt(ci1++, dummy.matrix);
    } else if(kind < 0.8){
      dummy.position.set(x, 3.2*s + 2.5*s*0.5, z);
      dummy.scale.set(s,s,s);
      dummy.updateMatrix();
      conifer2Mesh.setMatrixAt(ci2++, dummy.matrix);
    } else {
      dummy.position.set(x, 3.2*s + 2.2*s, z);
      dummy.scale.set(s,s,s);
      dummy.updateMatrix();
      roundMesh.setMatrixAt(cr++, dummy.matrix);
    }
  }
  trunkMesh.instanceMatrix.needsUpdate = true;
  conifer1Mesh.count = ci1; conifer1Mesh.instanceMatrix.needsUpdate = true;
  conifer2Mesh.count = ci2; conifer2Mesh.instanceMatrix.needsUpdate = true;
  roundMesh.count = cr; roundMesh.instanceMatrix.needsUpdate = true;
  vegetationGroup = new THREE.Group();
  vegetationGroup.add(trunkMesh, conifer1Mesh, conifer2Mesh, roundMesh);
  scene.add(vegetationGroup);

  // grass tufts scattered close-in, for foreground detail/parallax near the pad
  const tuftGeo = new THREE.ConeGeometry(0.35, 1.4, 4);
  const tuftMat = new THREE.MeshStandardMaterial({ color:0x5f8a4a, roughness:1 });
  const TUFT_COUNT = 500;
  const tuftMesh = new THREE.InstancedMesh(tuftGeo, tuftMat, TUFT_COUNT);
  tuftMesh.castShadow = false; tuftMesh.receiveShadow = true;
  for(let i=0;i<TUFT_COUNT;i++){
    const rad = 30 + Math.random()*220;
    const ang = Math.random()*Math.PI*2;
    const s = 0.7 + Math.random()*1.2;
    dummy.position.set(Math.cos(ang)*rad, 0.7*s, Math.sin(ang)*rad);
    dummy.rotation.set(0, Math.random()*Math.PI*2, 0);
    dummy.scale.set(s,s,s);
    dummy.updateMatrix();
    tuftMesh.setMatrixAt(i, dummy.matrix);
  }
  tuftMesh.instanceMatrix.needsUpdate = true;
  vegetationGroup.add(tuftMesh);
}
// concentric ground-projected rings + altitude flags the rocket climbs past, each labeled with
// its altitude — a literal ruler standing next to the flight so climb rate has a visible scale.
let altitudeRingLabels = [];
let karmanRingMesh = null, karmanRingLabel = null;
let altitudeRingMarks = []; // { alt, mesh, label } for the non-Karman reference rings — see applySceneMode for why these fade by proximity to the current altitude instead of all staying visible together
// Builds a handful of distant planet/moon disks and a satellite, scattered around a shell of the
// given radius (same shell the starfield sits on). Returns a THREE.Group so the whole set can be
// faded in with spaceMix and rotated together (see updateSpaceTransition / the spaceRoll drift in
// the render loop) — landmarks the eye can use to tell a long unpowered coast is still eating up
// real distance, rather than everything around the ship looking permanently frozen.
function buildSpaceObjects(shellRadius){
  const group = new THREE.Group();
  const planetColors = [0xd98a52, 0x7fa8c9, 0xb8c98a, 0xc97fa0];
  const PLANET_COUNT = 5;
  for(let i=0;i<PLANET_COUNT;i++){
    let x,y,z,len;
    do{ x=Math.random()*2-1; y=Math.random()*2-1; z=Math.random()*2-1; len=x*x+y*y+z*z; } while(len>1||len<0.0001);
    len = Math.sqrt(len);
    const r = shellRadius * (0.55 + Math.random()*0.35); // scatter at varying depths, not one flat shell
    const px = (x/len)*r, py = Math.abs(y/len)*r*0.7 + r*0.1, pz = (z/len)*r;
    const size = shellRadius * (0.008 + Math.random()*0.02);
    const mat = new THREE.MeshBasicMaterial({
      color: planetColors[i % planetColors.length],
      transparent:true, opacity:0,
    });
    const planet = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), mat);
    planet.position.set(px, py, pz);
    group.add(planet);
  }
  // one small satellite silhouette — a simple box + panel "spacecraft" shape, closer in than the
  // planets so its parallax against them reads a little faster as spaceRoll advances
  const satGroup = new THREE.Group();
  const satMat = new THREE.MeshBasicMaterial({ color:0xdadfd8, transparent:true, opacity:0 });
  const satBody = new THREE.Mesh(new THREE.BoxGeometry(1,1,2.4), satMat);
  satGroup.add(satBody);
  [-1,1].forEach(function(side){
    const panel = new THREE.Mesh(new THREE.BoxGeometry(3.6,0.08,1.4), satMat);
    panel.position.x = side*2.6;
    satGroup.add(panel);
  });
  const satR = shellRadius * 0.4;
  const satAng = Math.random()*Math.PI*2;
  satGroup.position.set(Math.cos(satAng)*satR, satR*0.15, Math.sin(satAng)*satR);
  satGroup.scale.setScalar(shellRadius * 0.006);
  satGroup.userData.isSatellite = true;
  group.add(satGroup);
  group.visible = false;
  return group;
}

function buildAltitudeRings(){
  const marks = [100, 300, 1000, 3000, 10000, 30000, 80000, KARMAN_LINE_M, 300000];
  marks.forEach(function(m){
    const worldY = worldAltitudeForRings(m);
    const isKarman = m === KARMAN_LINE_M;
    const geo = new THREE.RingGeometry(isKarman ? 68 : 70, isKarman ? 73 : 71, 64);
    geo.rotateX(-Math.PI/2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: isKarman ? 0x6fd4e8 : 0xffffff,
      transparent:true, opacity: isKarman ? 0.55 : 0.18, side:THREE.DoubleSide,
    }));
    mesh.position.y = worldY;
    scene.add(mesh);
    if(isKarman) karmanRingMesh = mesh;

    const label = makeTextSprite((isKarman ? 'KARMAN LINE — ' : '') + (m >= 1000 ? (m/1000)+' km' : m+' m'));
    label.position.set(74, worldY, 0);
    scene.add(label);
    altitudeRingLabels.push(label);
    if(isKarman) karmanRingLabel = label;
    // Non-Karman rings/labels get faded by proximity to the current altitude in applySceneMode —
    // all 8 of them sitting permanently visible at once (previously the only behavior) meant that
    // from any zoomed-out or shallow viewing angle, their thin edges lined up along the vehicle's
    // vertical flight path and visually chained together into what read as a single stray line
    // running from the pad up to the vehicle at any altitude — see the comment there for the fix.
    if(!isKarman) altitudeRingMarks.push({ alt:m, mesh, label });
  });
}
// altitude rings are placed using the same log-compressed mapping as the rocket itself (defined
// later as worldAltitude); this thin wrapper exists only so buildAltitudeRings can run before that
// function's declaration is hoisted-visible at call time — both reference the same math.
function worldAltitudeForRings(alt){ return worldAltitude(alt); }

export { WORLD_SHELL_RADIUS, altitudeRingMarks, buildAltitudeRings, buildSpaceObjects, buildVegetation, buildWorldShell, karmanRingLabel, karmanRingMesh, vegetationGroup };
