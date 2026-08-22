import * as THREE from "three";
import { KARMAN_LINE_M } from "../core/constants.js";
import { animate } from "../flight/loop.js";
import { currentRenderedTheme, root } from "../ui/theme.js";
import { buildCloudLayers } from "./clouds.js";
import { setupOrbitControls } from "./controls.js";
import { makeGrassTexture, makeScorchedConcreteTexture, makeTerrainTexture } from "./textures.js";
import { buildTransferScene } from "./transfer-scene.js";
import { WORLD_SHELL_RADIUS, buildAltitudeRings, buildSpaceObjects, buildVegetation, buildWorldShell } from "./world.js";

/* ================================================================================
   THREE.JS SCENE
   ================================================================================ */
let scene, camera, renderer, clock;
let contextLost = false;
let padGroup, rocketGroup;
let exhaustLight = null; // point light standing in for engine-plume radiance, see initThree
let sunLight = null, ambientLight = null, fillLight = null; // scene lighting rig, dimmed/tinted for dark theme by applySkyColors so a night launch actually looks dark instead of full daylight under a black sky
let cloudLayer;
let starField = null;
let spaceObjects = null; // distant planets/moons/satellites riding the same shell as the starfield
let earthShellMesh = null; // curved dome standing in for Earth's surface as seen from altitude
let earthOriginalTexture = null; // Earth's own terrain texture for earthShellMesh (Moon/Mars landings no longer re-skin this mesh — see updateBodyLandingScene)
let groundMesh = null; // flat near-pad ground plane — faded out once spaceMix rises so its hard
                        // square edge doesn't show once fog (which normally hides that edge) itself
                        // fades out above the Karman line; the curved earthShellMesh takes over as
                        // the visible "planet" from there
let spaceRoll = 0; // current roll (radians) of the star/planet shell around the camera, derived from downrange each frame
// spaceRoll is written from two places — flight/controller.js zeroes it on reset, flight/loop.js
// drives it every frame from downrange. An imported ES module binding is read-only at the import
// site, so those writes go through this setter rather than assigning the binding directly.
function setSpaceRoll(v){ spaceRoll = v; }
const SCALE = 1; // world units == meters (scaled visually via rocket size, camera adapts)

const canvasHost = document.getElementById('canvasHost');
const loadingHint = document.getElementById('loadingHint');

function applySkyColors(){
  if(!scene) return;
  const style = getComputedStyle(root);
  const top = style.getPropertyValue('--sky-top').trim();
  const bot = style.getPropertyValue('--sky-bot').trim();
  scene.background = new THREE.Color(bot);
  if(scene.fog) scene.fog.color = new THREE.Color(bot);
  if(scene.userData.skyMesh){
    scene.userData.skyMesh.material.uniforms.topColor.value = new THREE.Color(top);
    scene.userData.skyMesh.material.uniforms.botColor.value = new THREE.Color(bot);
  }
  // The sun/ambient/fill rig above was previously fixed at full daylight intensity regardless of
  // theme, so toggling dark mode only recolored the sky dome and UI chrome — the ground, pad, and
  // rocket stayed lit exactly as bright as at noon, which read as a broken half-applied theme (a
  // pitch-black sky over a sunlit lawn). Dimming and cooling the rig here makes dark mode read as an
  // actual dusk/night launch — pad floodlit by its own exhaust/point-light glow against a dark sky —
  // instead of a palette swap the 3D scene ignores. Driven off the CSS custom properties themselves
  // (via currentRenderedTheme, same source setTheme already uses) so this stays in sync with every
  // path that can change theme: the toggle button, the system prefers-color-scheme media query, and
  // the initial applySkyColors() call in initThree before any user interaction.
  const isDark = currentRenderedTheme() === 'dark';
  if(sunLight){
    sunLight.intensity = isDark ? 0.35 : 2.2;
    sunLight.color.set(isDark ? 0x8fb8ff : 0xffffff);
  }
  if(ambientLight){
    ambientLight.intensity = isDark ? 0.18 : 0.55;
  }
  if(fillLight){
    fillLight.intensity = isDark ? 0.22 : 0.6;
    fillLight.color.set(isDark ? 0x2a3a55 : 0xdfeaf5);
    fillLight.groundColor.set(isDark ? 0x0a0c0a : 0x8a8f7c);
  }
}

// Fraction of the way from "thick atmosphere" to "space" for a given altitude — 0 at the ground,
// 1 at the Karman line and beyond. Drives both the sky darkening and the starfield fade-in below,
// so "have I left the atmosphere" becomes something visible instead of only a HUD number crossing
// an invisible 100km threshold.
function spaceMixForAltitude(alt){
  const startFade = 25000; // sky starts visibly darkening well before the Karman line
  if(alt <= startFade) return 0;
  return Math.max(0, Math.min(1, (alt - startFade) / (KARMAN_LINE_M - startFade)));
}

// Updates the sky dome shader's day<->space blend and the starfield's opacity together every frame,
// driven by the rocket's current altitude — this is the actual visual "leaving the atmosphere" cue.
function updateSpaceTransition(alt){
  const mix = spaceMixForAltitude(alt);
  if(scene && scene.userData.skyMesh){
    scene.userData.skyMesh.material.uniforms.spaceMix.value = mix;
  }
  if(starField){
    starField.material.opacity = mix;
    starField.visible = mix > 0.01;
  }
  if(spaceObjects){
    spaceObjects.visible = mix > 0.01;
    spaceObjects.traverse(function(obj){
      if(obj.material) obj.material.opacity = mix * (obj.parent && obj.parent.userData.isSatellite ? 0.9 : 0.85);
    });
  }
  if(earthShellMesh){
    // Tint the shell darker (toward black, like the real planet's day/night terminator seen from
    // orbit) as spaceMix rises, rather than fading it out — the ground should still visibly BE there
    // once you're in orbit looking down, just dim, not vanish. lerp is applied to the material color
    // multiplier (MeshStandardMaterial tints its texture map by .color), so the underlying terrain
    // texture is untouched and this is cheap to update every frame.
    const shade = 1 - mix * 0.85;
    earthShellMesh.material.color.setScalar(shade);
  }
  if(groundMesh){
    // The flat pad-side ground plane is only there for near-field texture detail at low altitude;
    // its hard 20000-unit square edge is normally masked by scene.fog, but fog itself fades out as
    // spaceMix rises (see the "Above the Karman line there is no atmosphere" fog logic below), which
    // would otherwise unmask that edge as a giant flat green square against the curved earthShellMesh.
    // Fading the plane's own opacity out over the same climb keeps only the round shell visible by
    // the time fog stops covering for it.
    groundMesh.material.opacity = 1 - mix;
    groundMesh.visible = mix < 0.999;
  }
  return mix;
}

function initThree(){
  scene = new THREE.Scene();
  clock = new THREE.Clock();

  // SKY_RADIUS must stay comfortably beyond the highest world-space position placeRocket() can ever
  // produce. worldAltitude() is uncapped (see its own comment — no scene-swap teleport, the vehicle
  // stays in one continuous Earth-relative world all the way to the Moon/Mars), but its log1p growth
  // is so slow that even real lunar distance (384,400km) only reaches ~830 world units and real Mars
  // transfer distance (~225M km) only ~1120 — nowhere near SKY_RADIUS even with displayScale's 2.2x
  // ceiling factored in. SKY_RADIUS keeps large headroom regardless; CAMERA_FAR gives the sky sphere
  // itself (and the starfield just inside it) room to still be drawn without being clipped by the
  // camera's own far plane.
  const SKY_RADIUS = 60000;
  const CAMERA_FAR = 100000;
  camera = new THREE.PerspectiveCamera(50, canvasHost.clientWidth/canvasHost.clientHeight, 0.1, CAMERA_FAR);
  camera.position.set(40, 20, 60);

  renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvasHost.clientWidth, canvasHost.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvasHost.appendChild(renderer.domElement);

  // GPU context loss (driver reset, tab backgrounded under memory pressure, OS GPU-process crash)
  // otherwise leaves this permanently rendering nothing with no error and no way to recover short
  // of a manual page reload. The 'webglcontextlost' event fires just before the context actually
  // dies; preventDefault() tells the browser a restore attempt is wanted. animate() checks
  // contextLost every frame so it stops touching a dead GL context (which throws) in the meantime.
  // A restored context is still valid, but every GPU-side resource it held (geometries, textures,
  // compiled programs — the entire rocket model, terrain textures, sky shader, everything built
  // across this 5000-line scene graph) is gone. Rebuilding all of that in place from an event
  // handler is the same amount of state-reconstruction work as a fresh load, with much higher risk
  // of missing a cache or leaving a stale reference — so recover the same way a user would after
  // any other GPU crash: reload. The in-flight mission log/history is lost either way once the
  // context dies; there is nothing left to preserve by avoiding the reload.
  renderer.domElement.addEventListener('webglcontextlost', function(e){
    e.preventDefault();
    contextLost = true;
    loadingHint.textContent = 'Graphics context lost — reloading…';
    loadingHint.style.display = '';
    setTimeout(function(){ window.location.reload(); }, 400);
  }, false);

  // sky gradient dome — blends between the normal day-sky gradient and near-black "space" as
  // spaceMix (driven every frame by the rocket's altitude, see updateSpaceTransition) goes 0->1,
  // which is the actual visible cue for "the vehicle has climbed out of the atmosphere," rather
  // than that fact only ever showing up as a number in the HUD.
  const skyGeo = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    uniforms:{
      topColor:{value:new THREE.Color('#bcd6e8')}, botColor:{value:new THREE.Color('#eef3ea')},
      spaceMix:{value:0},
    },
    vertexShader:'varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader:'varying vec3 vPos; uniform vec3 topColor; uniform vec3 botColor; uniform float spaceMix;\n'+
      'void main(){\n'+
      '  float h = normalize(vPos).y * 0.5 + 0.5;\n'+
      '  vec3 daySky = mix(botColor, topColor, clamp(h*1.4,0.0,1.0));\n'+
      '  vec3 spaceSky = mix(vec3(0.02,0.02,0.035), vec3(0.0,0.0,0.01), clamp(h*1.4,0.0,1.0));\n'+
      '  gl_FragColor = vec4(mix(daySky, spaceSky, spaceMix), 1.0);\n'+
      '}',
    side: THREE.BackSide, depthWrite:false,
  });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  scene.add(skyMesh);
  scene.userData.skyMesh = skyMesh;

  // starfield — a fixed shell of points around the camera, invisible in atmosphere and faded in by
  // updateSpaceTransition as spaceMix rises, so leaving the atmosphere reads as "the sky went dark
  // and filled with stars," not just a ring label on the way up.
  const starCount = 2200;
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(starCount*3);
  for(let i=0;i<starCount;i++){
    // random point on a sphere (rejection-free: normalize a gaussian-ish uniform cube sample)
    let x,y,z,len;
    do{ x=Math.random()*2-1; y=Math.random()*2-1; z=Math.random()*2-1; len=x*x+y*y+z*z; } while(len>1||len<0.0001);
    len = Math.sqrt(len);
    const r = SKY_RADIUS * 0.95; // just inside the sky dome so stars never poke through its surface
    starPos[i*3] = (x/len)*r; starPos[i*3+1] = Math.abs(y/len)*r*0.9 + r*0.05; starPos[i*3+2] = (z/len)*r;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color:0xffffff, size:34, sizeAttenuation:true, transparent:true, opacity:0, depthWrite:false });
  starField = new THREE.Points(starGeo, starMat);
  starField.renderOrder = -1;
  starField.visible = false;
  scene.add(starField);

  // distant planets/moons/a satellite, seeded onto the same shell the starfield lives on. On their
  // own, stars this far away barely shift frame to frame, so a long unpowered coast (escape/orbit)
  // could look totally static even though the vehicle is still moving fast — these give the eye a
  // handful of concrete landmarks that visibly drift past as spaceRoll (below) advances with
  // downrange distance, which is what actually sells "still travelling" during a long coast.
  spaceObjects = buildSpaceObjects(SKY_RADIUS * 0.9);
  scene.add(spaceObjects);

  scene.fog = new THREE.Fog(0xeef3ea, 2000, 18000);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(300, 600, 200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048,2048);
  sun.shadow.camera.left = -200; sun.shadow.camera.right = 200;
  sun.shadow.camera.top = 200; sun.shadow.camera.bottom = -200;
  sun.shadow.camera.far = 2000;
  scene.add(sun);
  sunLight = sun;
  ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambientLight);
  fillLight = new THREE.HemisphereLight(0xdfeaf5, 0x8a8f7c, 0.6);
  scene.add(fillLight);
  applySkyColors(); // lighting rig above is built with light-theme intensities; sync immediately in case dark mode is already active (system preference or a stamped data-theme) so the pad doesn't flash full-daylight on first frame

  // ground — near field gets a mottled grass texture (procedural canvas) tiled fine enough to
  // read as texture detail near the pad; far field stays a simple plane so it doesn't cost much.
  const groundGeo = new THREE.PlaneGeometry(20000, 20000, 1, 1);
  const groundTex = makeGrassTexture();
  const groundMat = new THREE.MeshStandardMaterial({ map:groundTex, color:0xffffff, roughness:1, transparent:true });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  scene.add(ground);
  groundMesh = ground;

  // curved Earth shell — see the WORLD SHELL header comment above buildWorldShell/makeTerrainTexture
  // for why this exists alongside (not instead of) the flat groundGeo above: flat ground stays for
  // near-pad detail, this shell gives the view its curvature once the camera is far enough out to
  // see it, with the seam between the two hidden by scene.fog exactly like the flat plane's own edge
  // already was. Positioned a few units below the flat ground (both are otherwise coplanar — near-
  // flat, at y=0 — right at the shared center) purely to avoid z-fighting where they'd overlap; the
  // curved shell's own sagitta droop takes over as the visible surface well before its near-center
  // region would otherwise show through.
  const earthTerrainTex = makeTerrainTexture({
    landColor:'#5a7a44', landColor2:'#4a6838',
    oceanColor:'#2f6a8a', oceanColor2:'#1f4f6d',
    mountainColor:'rgba(120,115,108,0.55)', waterFeatureColor:'rgba(60,120,160,0.85)',
    hasOcean:true, hasWaterFeatures:true,
  });
  earthShellMesh = buildWorldShell(WORLD_SHELL_RADIUS, earthTerrainTex);
  earthShellMesh.position.y = -4;
  scene.add(earthShellMesh);
  earthOriginalTexture = earthTerrainTex; // kept so applySceneMode() can restore Earth's own look after a body landing re-skins this same mesh

  buildVegetation();
  buildCloudLayers();
  buildAltitudeRings();

  // launch pad
  padGroup = new THREE.Group();
  // Pad deck is a disc with a real rectangular slot cut through it (THREE.Shape + a hole path,
  // extruded) rather than a solid disc with a box merely placed on top — a box "trench" sitting on
  // an unbroken solid deck was fully hidden under the deck's own flat top face, so the exhaust had
  // nowhere visible to actually go. The slot runs from near dead center (under the vehicle) out past
  // the deck's edge, matching how a real flame trench passes clean through the pad structure.
  const deckShape = new THREE.Shape();
  deckShape.absarc(0, 0, 14, 0, Math.PI*2, false);
  const slotHalfW = 3.25, slotNear = 1.5, slotFar = 25;
  const slotHole = new THREE.Path();
  slotHole.moveTo(-slotHalfW, slotNear);
  slotHole.lineTo(slotHalfW, slotNear);
  slotHole.lineTo(slotHalfW, slotFar);
  slotHole.lineTo(-slotHalfW, slotFar);
  slotHole.closePath();
  deckShape.holes.push(slotHole);
  const deckGeo = new THREE.ExtrudeGeometry(deckShape, { depth:3, bevelEnabled:false, curveSegments:32 });
  deckGeo.rotateX(-Math.PI/2);
  deckGeo.translate(0, -1.5, 0); // ExtrudeGeometry builds from z=0..depth; recenter so the deck spans y ∈ [-1.5, 1.5] like the old CylinderGeometry(_,_,3) did
  const padBase = new THREE.Mesh(
    deckGeo,
    new THREE.MeshStandardMaterial({ color:0x555a52, roughness:0.9, map:makeScorchedConcreteTexture() })
  );
  padBase.position.y = 1.5;
  padBase.castShadow = true; padBase.receiveShadow = true;
  padGroup.add(padBase);

  // flame trench — the deflector duct beneath the slot, standing in for the structure every real pad
  // needs to route exhaust sideways away from the engines instead of it slamming straight back up.
  // Sits below the deck's cut so the slot in padBase reveals it instead of it being fully enclosed.
  const trenchMat = new THREE.MeshStandardMaterial({ color:0x232621, roughness:0.95 });
  const trenchDepth = 6, trenchCenterZ = (slotNear+slotFar)/2, trenchLen = slotFar-slotNear;
  const trench = new THREE.Mesh(new THREE.BoxGeometry(slotHalfW*2 - 0.3, trenchDepth, trenchLen - 0.3), trenchMat);
  trench.position.set(0, -1.5 - trenchDepth/2, trenchCenterZ);
  trench.receiveShadow = true;
  padGroup.add(trench);
  const trenchWallMat = new THREE.MeshStandardMaterial({ color:0x4a4e48, roughness:0.9 });
  [-1,1].forEach(function(side){
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.3, trenchDepth+3, trenchLen), trenchWallMat);
    wall.position.set(side*(slotHalfW-0.15), -1.5 - trenchDepth/2, trenchCenterZ);
    wall.castShadow = true; wall.receiveShadow = true;
    padGroup.add(wall);
  });

  // four lattice lightning-mast towers around the pad perimeter, now cross-braced so they read as a
  // real steel structure rather than four bare floating poles
  const towerMat = new THREE.MeshStandardMaterial({ color:0x8a8f8a, roughness:0.6, metalness:0.3 });
  const towerPositions = [];
  for(let i=0;i<4;i++){
    const tower = new THREE.Mesh(new THREE.BoxGeometry(1.2, 26, 1.2), towerMat);
    const ang = (i/4)*Math.PI*2 + Math.PI/4;
    const pos = { x:Math.cos(ang)*11, z:Math.sin(ang)*11 };
    tower.position.set(pos.x, 13+3, pos.z);
    tower.castShadow = true;
    padGroup.add(tower);
    towerPositions.push(pos);
  }
  // diagonal cross-braces between adjacent towers at two heights, plus one horizontal ring — cheap
  // thin boxes oriented with lookAt, matching the fin/RCS-pod trick used elsewhere in the file for
  // turning a primitive box into an angled structural member
  const braceMat = new THREE.MeshStandardMaterial({ color:0x6f746e, roughness:0.7, metalness:0.2 });
  [8, 18].forEach(function(h){
    for(let i=0;i<4;i++){
      const a = towerPositions[i], b = towerPositions[(i+1)%4];
      const dx = b.x-a.x, dz = b.z-a.z;
      const len = Math.hypot(dx, dz);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, len), braceMat);
      brace.position.set((a.x+b.x)/2, h+3, (a.z+b.z)/2);
      brace.rotation.y = Math.atan2(dx, dz);
      brace.castShadow = true;
      padGroup.add(brace);
    }
  });

  // umbilical/strongback arm — a single angled tower closer to the vehicle with a boxy swing-arm
  // reaching toward the core, the one visually distinct "service structure" element real pads have
  // that this scene otherwise lacked entirely alongside the generic corner lightning masts.
  const strongbackMat = new THREE.MeshStandardMaterial({ color:0x7f8880, roughness:0.55, metalness:0.35 });
  const strongback = new THREE.Group();
  const spine = new THREE.Mesh(new THREE.BoxGeometry(1.6, 30, 1.6), strongbackMat);
  spine.position.set(0, 15+3, 0);
  spine.castShadow = true;
  strongback.add(spine);
  const armMat = new THREE.MeshStandardMaterial({ color:0xc8501f, roughness:0.5, metalness:0.25 });
  const arm = new THREE.Mesh(new THREE.BoxGeometry(9, 1.1, 1.1), armMat);
  arm.position.set(-4.7, 21+3, 0);
  arm.castShadow = true;
  strongback.add(arm);
  const armGusset = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.4), armMat);
  armGusset.position.set(-0.5, 19.7+3, 0);
  armGusset.rotation.z = -0.5;
  strongback.add(armGusset);
  strongback.position.set(-14.5, 0, -3);
  padGroup.add(strongback);

  scene.add(padGroup);

  rocketGroup = new THREE.Group();
  scene.add(rocketGroup);

  // exhaust glow light — a single point light standing in for the combined radiance of every lit
  // engine bell, repositioned each frame onto the rocket's base (see updateEngineVisuals) and faded
  // by engineThrustIntensity. Real engine plumes are genuinely bright enough to backlight the
  // vehicle and throw warm light across the pad at night/low sun angle; without this, throttle was
  // only ever a HUD number and the flame mesh itself, with nothing it visibly illuminated.
  exhaustLight = new THREE.PointLight(0xff9a4d, 0, 260, 1.7);
  scene.add(exhaustLight);

  buildTransferScene();

  applySkyColors();

  window.addEventListener('resize', onResize);
  setupOrbitControls();
  animate();
  loadingHint.style.display = 'none';
}

function onResize(){
  if(!renderer) return;
  camera.aspect = canvasHost.clientWidth/canvasHost.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(canvasHost.clientWidth, canvasHost.clientHeight);
}

export { applySkyColors, camera, clock, contextLost, earthShellMesh, exhaustLight, groundMesh, initThree, loadingHint, padGroup, renderer, rocketGroup, scene, setSpaceRoll, spaceMixForAltitude, spaceObjects, spaceRoll, starField, updateSpaceTransition };
