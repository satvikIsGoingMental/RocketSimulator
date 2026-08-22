import * as THREE from "three";
import { makeCloudTexture } from "./textures.js";
import { scene } from "./three-setup.js";

const cloudGroups = []; // { group, baseY, driftSpeed }
function buildCloudLayers(){
  const cloudTex = makeCloudTexture();
  const cloudMat = new THREE.SpriteMaterial({ map:cloudTex, transparent:true, opacity:0.85, depthWrite:false, fog:true });

  // three altitude bands: low cumulus (~140m), mid-deck (~900m), high cirrus-ish (~3200m —
  // above this the log altitude compression keeps the rocket's visual climb readable through it)
  const layers = [
    { y: 140,  count: 26, spread: 2600, scale: [40,80],  opacity:0.85, driftSpeed: 1.6 },
    { y: 900,  count: 22, spread: 4200, scale: [70,130], opacity:0.7,  driftSpeed: 2.6 },
    { y: 3200, count: 18, spread: 7000, scale: [140,240],opacity:0.55, driftSpeed: 4.2 },
  ];

  layers.forEach(function(layer){
    const group = new THREE.Group();
    for(let i=0;i<layer.count;i++){
      const sprite = new THREE.Sprite(cloudMat.clone());
      const ang = Math.random()*Math.PI*2;
      const rad = 300 + Math.random()*layer.spread;
      sprite.position.set(Math.cos(ang)*rad, layer.y + (Math.random()-0.5)*layer.y*0.25, Math.sin(ang)*rad);
      const sc = layer.scale[0] + Math.random()*(layer.scale[1]-layer.scale[0]);
      sprite.scale.set(sc, sc*0.55, 1);
      sprite.material.opacity = layer.opacity * (0.7+Math.random()*0.3);
      sprite.userData.baseOpacity = sprite.material.opacity; // preserved per-sprite variation, used by setCloudsSpaceMix to fade without flattening it
      sprite.material.rotation = Math.random()*Math.PI*2;
      group.add(sprite);
    }
    scene.add(group);
    cloudGroups.push({ group:group, baseY:layer.y, driftSpeed:layer.driftSpeed });
  });
}

function updateClouds(dt, rocketVelocity){
  // clouds drift on their own slowly, and *stream past* faster as the rocket's velocity climbs —
  // this turns "how fast am I going" into something you see, not just read off the HUD
  const streak = Math.min(Math.abs(rocketVelocity||0) * 0.012, 60);
  cloudGroups.forEach(function(c){
    c.group.rotation.y += dt * (c.driftSpeed*0.002 + streak*0.0006);
  });
}
// cloudGroups is several independent THREE.Group layers (see buildCloudLayers), not one mesh, so
// hiding "the clouds" needs to toggle all of them — used by applySceneMode/updateBodyLandingScene
// to hide Earth's clouds during an interplanetary transfer or once landed on the Moon/Mars.
//
// Separately, clouds live at fixed low altitudes (140-3200m) but applySceneMode's visible toggle
// only tracks phase (inTransfer/landed), not altitude — so on ASCENT/COAST/ORBIT/ESCAPE the clouds
// stayed fully visible no matter how high the vehicle climbed. worldAltitude's log compression then
// packs that fixed low-altitude layer visually close to a rocket that's actually millions of meters
// up, which read as a field of white "debris" drifting around the vehicle in deep space. Fix: fade
// cloud opacity out with spaceMixForAltitude (the same 0->1 leaving-the-atmosphere signal that
// already dims the sky/ground) via setCloudsSpaceMix, called every frame from the same place
// updateSpaceTransition runs, so clouds are gone well before the vehicle is meaningfully above them.
function setCloudsSpaceMix(mix){
  const opacityScale = Math.max(0, 1 - mix);
  cloudGroups.forEach(function(c){
    c.group.visible = opacityScale > 0.01;
    c.group.children.forEach(function(sprite){
      sprite.material.opacity = sprite.userData.baseOpacity * opacityScale;
    });
  });
}
function setCloudsVisible(visible){
  cloudGroups.forEach(function(c){ c.group.visible = visible; });
}

export { buildCloudLayers, setCloudsSpaceMix, setCloudsVisible, updateClouds };
