import * as THREE from "three";
import { BODIES, R_PLANET } from "../core/constants.js";
import { sim } from "../flight/controller.js";
import { worldAltitude } from "../flight/loop.js";
import { makeTerrainTexture, makeTextSprite } from "./textures.js";
import { scene, starField } from "./three-setup.js";
import { WORLD_SHELL_RADIUS, buildWorldShell } from "./world.js";

// Every mesh in the transfer/arrival staging is created and mutated exclusively by this module, so
// the handles live here rather than in three-setup.js.
let transferGroup = null;      // holds the shrinking Earth marker + growing destination sphere shown during TRANSFER/ARRIVAL
let transferEarthMesh = null;
let transferBodyMesh = null;
let transferBodyLabel = null;
let landedBodyShellMesh = null; // body id whose terrain texture transferBodyMesh currently has applied (see updateBodyLandingScene) — guards against re-applying it every frame
// flight/loop.js clears this when leaving a landed-body scene; an imported binding is read-only at
// the import site, so that write goes through this setter.
function setLandedBodyShellMesh(v){ landedBodyShellMesh = v; }

/* ================================================================================
   TRANSFER SCENE — Earth and the destination body both sit at FIXED positions in the same
   continuous world placeRocket() already uses for ordinary ascent, anchored via worldAltitude() at
   the world-Y each one's real distance from the pad maps to (Earth at R_PLANET, the destination at
   R_PLANET + body.distanceFromEarth). Neither marker moves or rescales on its own — the rocket is
   what moves, flying from near the Earth marker toward the destination marker exactly like it flies
   away from the pad during ascent, just continuing the same worldAltitude curve outward. This
   replaces an earlier version that instead held the rocket fixed in a small manufactured "deep
   space" stage and animated two markers around it, which was a scene-swap/teleport dressed up as a
   flight: the rocket would jump from the real ascent scene into that stage the instant TRANSFER
   began. There is now exactly one coordinate system from liftoff to lunar/Mars arrival, so nothing
   ever cuts or snaps — worldAltitude's own log compression (see its comment) is what keeps a
   384,400km/225M km real distance from requiring a rescale in the first place.
   ================================================================================ */
function buildTransferScene(){
  transferGroup = new THREE.Group();
  transferGroup.visible = false;

  const earthTex = makeTerrainTexture({
    landColor:'#5a7a44', landColor2:'#4a6838', oceanColor:'#2f6a8a', oceanColor2:'#1f4f6d',
    mountainColor:'rgba(120,115,108,0.55)', waterFeatureColor:'rgba(60,120,160,0.85)',
    hasOcean:true, hasWaterFeatures:true,
  });
  transferEarthMesh = new THREE.Mesh(
    new THREE.SphereGeometry(30, 32, 24),
    new THREE.MeshStandardMaterial({ map: earthTex, roughness:1 })
  );
  transferGroup.add(transferEarthMesh);

  transferBodyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(30, 32, 24),
    new THREE.MeshStandardMaterial({ map: earthTex, roughness:1 }) // real texture swapped in by setTransferDestinationVisual() once a destination is known
  );
  transferGroup.add(transferBodyMesh);

  transferBodyLabel = makeTextSprite('DESTINATION');
  transferGroup.add(transferBodyLabel);

  // a dedicated point light standing in for the sun, since these markers sit far outside the ascent
  // scene's shadow-camera frustum (the existing DirectionalLight's shadow bounds are sized for the
  // launch pad, not a scene spanning thousands of world units)
  const transferSun = new THREE.DirectionalLight(0xffffff, 1.6);
  transferSun.position.set(200, 120, 300);
  transferGroup.add(transferSun);
  transferGroup.add(new THREE.AmbientLight(0xffffff, 0.45));

  scene.add(transferGroup);
}

// Builds (once per body, cached) and applies the correct terrain texture to transferBodyMesh — called
// once the destination is known (well before TRANSFER itself begins). Marker POSITION is deliberately
// NOT set here: at launch time sim.transferStartR (the real Earth-centered radius TRANSFER will
// eventually begin from) doesn't exist yet — it depends on exactly how far ESCAPE carries the vehicle
// before captureTransfer fires, which varies flight to flight. Anchoring the Earth marker to a
// guessed/fixed radius here (R_PLANET) instead of the real one is exactly what caused the markers to
// visibly snap into place relative to the rocket the instant TRANSFER began. Position is set in
// updateTransferScene instead, once sim.transferStartR is real.
const transferBodyTexCache = {};
function setTransferDestinationVisual(bodyId){
  if(!transferBodyMesh) return;
  const body = BODIES[bodyId];
  if(!body) return;
  if(!transferBodyTexCache[bodyId]){
    transferBodyTexCache[bodyId] = makeTerrainTexture(body.terrain);
  }
  transferBodyMesh.material.map = transferBodyTexCache[bodyId];
  transferBodyMesh.material.needsUpdate = true;
  transferBodyLabel.material.map.dispose();
  const fresh = makeTextSprite(body.short.toUpperCase());
  transferBodyLabel.material.map = fresh.material.map;
  transferBodyLabel.scale.copy(fresh.scale);
  transferBodyLabel.material.needsUpdate = true;
}

// Per-frame: anchors both markers at their real, fixed world positions (Earth at sim.transferStartR —
// the actual radius TRANSFER began from, continuing exactly where ESCAPE's own worldAltitude mapping
// left the rocket, not a re-guessed R_PLANET — and the destination at transferStartR's own reference
// frame plus the real remaining distance at capture time), recomputed each frame only because
// transferStartR isn't known until captureTransfer fires but is CONSTANT for the rest of this flight,
// so the markers still don't move once TRANSFER is underway — only their apparent SIZE grows/shrinks
// with actual proximity, using the same real transferDistance/transferTotalDistance the HUD reads, so
// a close flyby honestly looks close instead of the fixed-size dot a purely positional anchor would
// give at real interplanetary scale.
function updateTransferScene(frame){
  if(!transferGroup || !sim || !sim.body) return;
  const startR = sim.transferStartR || R_PLANET;
  const earthY = 3 + worldAltitude(startR);
  const bodyY = 3 + worldAltitude(startR + sim.transferTotalDistance);
  transferEarthMesh.position.set(0, earthY, 40);   // offset sideways off the flight axis so the rocket visibly passes them, not through them
  transferBodyMesh.position.set(0, bodyY, -40);
  transferBodyLabel.position.set(0, bodyY + 44, -40);

  const progressToTarget = 1 - Math.max(0, Math.min(1, frame.transferDistance / Math.max(frame.transferTotalDistance,1)));
  const eased = Math.pow(progressToTarget, 0.55); // ease so growth visibly quickens near arrival, matching stepTransfer's own growing-target-gravity accel
  const bodyScale = 1 + eased * 9; // grows up to 10x its base size as it's approached
  transferBodyMesh.scale.setScalar(bodyScale);
  transferBodyLabel.visible = bodyScale < 4; // hide the text label once the body itself is big enough to read as a planet, not a dot

  const earthScale = Math.max(0.15, 1 - eased * 0.85); // shrinks (with real distance already receding it, see placeRocket) as the trip progresses
  transferEarthMesh.scale.setScalar(earthScale);
}


/* ================================================================================
   BODY LANDING SCENE — ARRIVAL/DESCENT/LANDING-BURN (sim.arrivedAtBody true) no longer cuts to a
   separate re-centered scene at the SOI handoff. The Moon/Mars marker (transferBodyMesh) keeps
   growing exactly as it did during TRANSFER (see updateTransferScene) as the vehicle closes in, and
   folds its sideways flyby offset (z:-40, there so the rocket visibly passed Earth/Moon markers
   during transfer rather than flying through them) back onto the rocket's own flight axis so the
   vehicle descends straight at it instead of alongside it.
   No coordinate re-basing, no mesh swap, no hidden-until-now scene: placeRocket() already positions
   the rocket every frame via the same worldAltitude(body.distanceFromEarth - alt) mapping this marker
   itself is parked with (see updateTransferScene's bodyY), so the two were already converging on the
   same point before this function ever touches anything.
   A raw scaled-up SphereGeometry stops looking like ground once the camera gets close (its native
   32x24 segment count means, at any scale large enough to fill the view, each visible triangle is
   already huge and flat — the same low-poly-pole problem buildWorldShell's own header comment
   documents, just from being highly magnified rather than from sitting at the pole). So instead of
   scaling transferBodyMesh all the way up into "ground," a SECOND mesh — bodyGroundShell, built once
   per body from the exact same buildWorldShell sagitta-curve technique earthShellMesh already uses
   for Earth's own close-range descent view — fades in underneath the rocket once it's close enough
   (inside arrivalAlt) that a flat-shaded sphere would start looking wrong, and transferBodyMesh
   itself fades out over the same span, the same "planet becomes ground" handoff Earth's own ascent/
   descent makes between its distant-orbit view and groundMesh/earthShellMesh, just mirrored for
   arrival instead of launch.
   ================================================================================ */
const bodyShellTexCache = {};
const bodyGroundShells = {}; // body id -> built buildWorldShell mesh (lazy, cached across flights)
function updateBodyLandingScene(frame, body){
  if(!sim || !body || !transferBodyMesh || !transferGroup) return;
  transferGroup.visible = true;
  if(transferEarthMesh) transferEarthMesh.visible = false; // long since receded past relevance by the time arrival begins

  if(!bodyShellTexCache[body.id]) bodyShellTexCache[body.id] = makeTerrainTexture(body.terrain);
  if(landedBodyShellMesh !== body.id){
    transferBodyMesh.material.map = bodyShellTexCache[body.id];
    transferBodyMesh.material.needsUpdate = true;
    landedBodyShellMesh = body.id;
    if(transferBodyLabel) transferBodyLabel.visible = false; // no longer reads as a labeled destination dot once landing is underway
  }
  if(!bodyGroundShells[body.id]){
    const shell = buildWorldShell(WORLD_SHELL_RADIUS, bodyShellTexCache[body.id]);
    shell.visible = false;
    scene.add(shell);
    bodyGroundShells[body.id] = shell;
  }
  const groundShell = bodyGroundShells[body.id];

  // frame.alt here is already Earth-relative (placeRocket converted it), so the marker's Y anchor is
  // the same worldAltitude(body.distanceFromEarth) position it's been approaching throughout TRANSFER
  // — and, at touchdown (bodyAlt 0), exactly where the rocket itself ends up (placeRocket's newY).
  const touchdownY = 3 + worldAltitude(body.distanceFromEarth);
  // closeness: 0 far out (still looks like a distant planet), 1 at/below the real descent-start
  // altitude (arrivalAlt) — by which point it should already fill the frame like standing ground.
  const closeness = Math.max(0, Math.min(1, 1 - (frame.bodyAlt || 0) / body.arrivalAlt));
  const eased = Math.pow(closeness, 0.6);
  // Continues the same growth curve updateTransferScene used during TRANSFER (which tops out at 10x
  // approaching the SOI) a bit further, fading out entirely as groundShell fades in — never scaled
  // all the way to ground-filling size itself, since that's exactly the regime it renders badly in.
  const baseRadius = 30;
  const bodyScale = 10 + eased * 40;
  transferBodyMesh.scale.setScalar(bodyScale);
  const dropBelowSurface = baseRadius * bodyScale * eased * 0.3; // small settle, not a full ground drop
  const bodyY = touchdownY - dropBelowSurface;
  // Un-offset from the sideways flyby position back onto the flight axis (z:0) over the same approach,
  // so the vehicle ends up descending straight at the marker instead of alongside it.
  const z = -40 * (1 - eased);
  transferBodyMesh.position.set(0, bodyY, z);
  if(transferBodyLabel) transferBodyLabel.position.set(0, touchdownY + 44, z);

  // groundShell fades in over the same span transferBodyMesh fades out, always parked directly under
  // the rocket's CURRENT position (like earthShellMesh sits under the pad) so its sagitta curvature
  // always reads correctly regardless of how far downrange the vehicle has drifted during descent.
  const groundMix = Math.max(0, Math.min(1, (closeness - 0.5) / 0.5)); // ramps over the closer half of the approach
  groundShell.visible = groundMix > 0.001;
  if(groundShell.visible){
    groundShell.position.set(frame.downrangeWorldX || 0, touchdownY - 4, 0);
    groundShell.material.opacity = groundMix;
    groundShell.material.transparent = groundMix < 0.999;
  }
  transferBodyMesh.visible = groundMix < 0.999;
  if(transferBodyMesh.material){
    transferBodyMesh.material.opacity = 1 - groundMix;
    transferBodyMesh.material.transparent = groundMix > 0.001;
  }

  scene.background = new THREE.Color(body.terrain.skyColor);
  if(scene.fog){
    const fogMix = eased; // ease Earth's own fog settings into the body's as it fills the view
    scene.fog.color = new THREE.Color(body.terrain.skyColor);
    scene.fog.near = THREE.MathUtils.lerp(scene.fog.near, body.hasAtmosphere ? 3000 : 400000, fogMix*0.3);
    scene.fog.far = THREE.MathUtils.lerp(scene.fog.far, body.hasAtmosphere ? 30000 : 500000, fogMix*0.3);
  }
  if(scene.userData.skyMesh) scene.userData.skyMesh.visible = false; // the Earth day-sky gradient dome doesn't apply out here — flat background color instead
  if(starField){ starField.visible = true; starField.material.opacity = body.hasAtmosphere ? 0.35 : 1; } // stars visible even in daylight on an airless body — no air to scatter sunlight into a blue sky
}

export { bodyGroundShells, buildTransferScene, landedBodyShellMesh, setLandedBodyShellMesh, setTransferDestinationVisual, transferBodyLabel, transferBodyMesh, transferEarthMesh, transferGroup, updateBodyLandingScene, updateTransferScene };
