import * as THREE from "three";

/* ================================================================================
   SCENERY — ground texture, trees/grass, cloud layers, altitude rings.
   All of this exists to give the eye fixed reference points so climb speed reads
   visually instead of only as a HUD number: things the rocket passes, and things
   left behind on the ground that shrink/streak as altitude and velocity grow.
   ================================================================================ */

// tileable-looking mottled grass texture, generated once on a canvas (no external assets)
function makeGrassTexture(){
  const size = 512;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#71835b';
  ctx.fillRect(0,0,size,size);
  const blades = 5000;
  for(let i=0;i<blades;i++){
    const x = Math.random()*size, y = Math.random()*size;
    const shade = 0.75 + Math.random()*0.5;
    const g = Math.floor(120*shade), r = Math.floor(90*shade), b = Math.floor(60*shade);
    ctx.fillStyle = 'rgb('+r+','+g+','+b+')';
    const w = 1.2 + Math.random()*2.2, h = 1.2 + Math.random()*2.2;
    ctx.fillRect(x, y, w, h);
  }
  // faint dirt patches
  for(let i=0;i<24;i++){
    const x = Math.random()*size, y = Math.random()*size, rad = 6+Math.random()*18;
    const grd = ctx.createRadialGradient(x,y,0,x,y,rad);
    grd.fillStyle = 'rgba(120,100,70,0.18)';
    grd.addColorStop(0,'rgba(120,100,70,0.22)');
    grd.addColorStop(1,'rgba(120,100,70,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI*2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cnv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1400, 1400);
  tex.anisotropy = 4;
  return tex;
}

// Weathered launch-pad concrete: a mottled gray base plus soot/scorch blooms concentrated toward one
// edge (the flame-trench side) and radiating outward, so the pad surface itself carries visible
// evidence of prior static fires/launches instead of reading as clean, unused concrete under a
// rocket that's supposedly about to light its engines.
let scorchedConcreteTex = null;
function makeScorchedConcreteTexture(){
  if(scorchedConcreteTex) return scorchedConcreteTex;
  const size = 512;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#5b5f59';
  ctx.fillRect(0,0,size,size);
  for(let i=0;i<9000;i++){
    const x = Math.random()*size, y = Math.random()*size;
    const shade = 0.8 + Math.random()*0.4;
    const c = Math.floor(90*shade);
    ctx.fillStyle = 'rgba('+c+','+c+','+(c+3)+',0.5)';
    ctx.fillRect(x, y, 1.4, 1.4);
  }
  // panel seams, evenly spaced — real pad decks are poured in sections
  ctx.strokeStyle = 'rgba(20,22,20,0.35)';
  ctx.lineWidth = 1.5;
  for(let i=1;i<8;i++){
    const p = (i/8)*size;
    ctx.beginPath(); ctx.moveTo(p,0); ctx.lineTo(p,size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,p); ctx.lineTo(size,p); ctx.stroke();
  }
  // soot blooms radiating from the trench edge (the top of the texture, mapped under the vehicle)
  for(let i=0;i<70;i++){
    const x = size*0.5 + (Math.random()-0.5)*size*0.9;
    const y = size*0.3*Math.pow(Math.random(), 1.8);
    const rad = 20 + Math.random()*70;
    const grd = ctx.createRadialGradient(x,y,0,x,y,rad);
    grd.addColorStop(0, 'rgba(15,14,12,0.5)');
    grd.addColorStop(0.5, 'rgba(15,14,12,0.22)');
    grd.addColorStop(1, 'rgba(15,14,12,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI*2); ctx.fill();
  }
  scorchedConcreteTex = new THREE.CanvasTexture(cnv);
  return scorchedConcreteTex;
}
function makeTerrainTexture(opts){
  opts = opts || {};
  const size = 1024;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');

  const landColor = opts.landColor || '#5a7a44';
  const landColor2 = opts.landColor2 || '#4a6838';
  const oceanColor = opts.oceanColor || '#2f6a8a';
  const oceanColor2 = opts.oceanColor2 || '#1f4f6d';
  const mountainColor = opts.mountainColor || 'rgba(120,115,108,0.55)';
  const waterFeatureColor = opts.waterFeatureColor || 'rgba(60,120,160,0.85)';
  const hasOcean = opts.hasOcean !== false;
  const hasWaterFeatures = opts.hasWaterFeatures !== false;
  const craterColor = opts.craterColor || null; // set (Moon) to draw dark radial craters instead of lakes/mountains

  // base fill — ocean everywhere first (if this body has one), landmasses painted on top as blobs
  if(hasOcean){
    const oceanGrd = ctx.createLinearGradient(0,0,0,size);
    oceanGrd.addColorStop(0, oceanColor);
    oceanGrd.addColorStop(1, oceanColor2);
    ctx.fillStyle = oceanGrd;
    ctx.fillRect(0,0,size,size);
  } else {
    ctx.fillStyle = landColor2;
    ctx.fillRect(0,0,size,size);
  }

  // landmasses: a handful of large soft-edged blobs (irregular polygons with rounded jitter, not
  // perfect circles, so they read as continents/islands rather than dots)
  function blobPath(cx, cy, r, irregularity){
    const pts = 10 + Math.floor(Math.random()*6);
    ctx.beginPath();
    for(let i=0;i<=pts;i++){
      const a = (i/pts) * Math.PI*2;
      const rr = r * (1 + (Math.random()-0.5)*irregularity);
      const x = cx + Math.cos(a)*rr, y = cy + Math.sin(a)*rr;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.closePath();
  }

  if(hasOcean){
    const landmassCount = 5 + Math.floor(Math.random()*3);
    for(let i=0;i<landmassCount;i++){
      const cx = Math.random()*size, cy = Math.random()*size, r = size*(0.09 + Math.random()*0.14);
      ctx.fillStyle = Math.random() < 0.5 ? landColor : landColor2;
      blobPath(cx, cy, r, 0.4);
      ctx.fill();
    }
  } else {
    // no-ocean body (Moon/Mars): scatter broad tonal variation blobs directly on the base fill so
    // the surface isn't a flat, featureless color
    const patchCount = 10 + Math.floor(Math.random()*8);
    for(let i=0;i<patchCount;i++){
      const cx = Math.random()*size, cy = Math.random()*size, r = size*(0.05 + Math.random()*0.12);
      ctx.fillStyle = landColor;
      ctx.globalAlpha = 0.35 + Math.random()*0.3;
      blobPath(cx, cy, r, 0.5);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // lakes/rivers: small water blobs plus a few connected stroked paths winding across landmasses
  if(hasWaterFeatures){
    ctx.fillStyle = waterFeatureColor;
    const lakeCount = 14 + Math.floor(Math.random()*10);
    for(let i=0;i<lakeCount;i++){
      const cx = Math.random()*size, cy = Math.random()*size, r = size*(0.004 + Math.random()*0.012);
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
    }
    ctx.strokeStyle = waterFeatureColor;
    const riverCount = 6 + Math.floor(Math.random()*5);
    for(let i=0;i<riverCount;i++){
      let x = Math.random()*size, y = Math.random()*size;
      ctx.lineWidth = 1.5 + Math.random()*2.5;
      ctx.beginPath();
      ctx.moveTo(x,y);
      const segs = 4 + Math.floor(Math.random()*4);
      for(let j=0;j<segs;j++){
        x += (Math.random()-0.5)*size*0.15;
        y += (Math.random()-0.5)*size*0.15;
        ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
  }

  // mountains: clustered soft grey blotches (a cheap stand-in for relief shading — this is a static
  // backdrop texture, not a real heightmap, so shading is faked with overlapping translucent blobs)
  if(mountainColor){
    ctx.fillStyle = mountainColor;
    const rangeCount = 4 + Math.floor(Math.random()*4);
    for(let i=0;i<rangeCount;i++){
      const cx = Math.random()*size, cy = Math.random()*size;
      const blobCount = 5 + Math.floor(Math.random()*6);
      for(let j=0;j<blobCount;j++){
        const bx = cx + (Math.random()-0.5)*size*0.08, by = cy + (Math.random()-0.5)*size*0.08;
        const r = size*(0.01 + Math.random()*0.02);
        ctx.beginPath(); ctx.arc(bx,by,r,0,Math.PI*2); ctx.fill();
      }
    }
  }

  // craters (Moon-style bodies only): dark radial-gradient rings, a mix of large and small
  if(craterColor){
    const craterCount = 40 + Math.floor(Math.random()*30);
    for(let i=0;i<craterCount;i++){
      const cx = Math.random()*size, cy = Math.random()*size, r = size*(0.008 + Math.random()*0.045);
      const grd = ctx.createRadialGradient(cx,cy,0,cx,cy,r);
      grd.addColorStop(0, craterColor);
      grd.addColorStop(0.75, craterColor);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
      // bright rim highlight on one side, cheap way to read as a crater rather than a flat spot
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = Math.max(1, r*0.06);
      ctx.beginPath(); ctx.arc(cx,cy,r*0.9,0.2,Math.PI*0.9); ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(cnv);
  return tex;
}
// layered billboard clouds at a few altitudes — the rocket visibly climbs past/through these,
// which (along with the altitude rings) is the main "ruler" for judging climb speed by eye
function makeCloudTexture(){
  const size = 128;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');
  ctx.clearRect(0,0,size,size);
  const blobs = 7;
  for(let i=0;i<blobs;i++){
    const x = size*0.5 + (Math.random()-0.5)*size*0.55;
    const y = size*0.5 + (Math.random()-0.5)*size*0.35;
    const r = size*(0.22+Math.random()*0.2);
    const grd = ctx.createRadialGradient(x,y,0,x,y,r);
    grd.addColorStop(0,'rgba(255,255,255,0.95)');
    grd.addColorStop(0.6,'rgba(255,255,255,0.55)');
    grd.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cnv);
  return tex;
}
function makeTextSprite(text){
  const cnv = document.createElement('canvas');
  const ctx = cnv.getContext('2d');
  const fontSize = 40;
  ctx.font = 'bold '+fontSize+'px monospace';
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  cnv.width = w; cnv.height = fontSize*1.6;
  ctx.font = 'bold '+fontSize+'px monospace';
  ctx.fillStyle = 'rgba(20,25,20,0.55)';
  ctx.fillRect(0,0,cnv.width,cnv.height);
  ctx.fillStyle = '#eef1ea';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, cnv.height/2);
  const tex = new THREE.CanvasTexture(cnv);
  const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthTest:false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(cnv.width/14, cnv.height/14, 1);
  sprite.renderOrder = 10;
  return sprite;
}
// Procedural hull texture: faint vertical panel lines + a couple of horizontal weld rings, applied
// as a subtle normal-less albedo variation so the fuselage reads as built-up tankage rather than a
// perfectly smooth plastic tube, without adding any extra geometry.
let hullTextureCache = null;
function getHullTexture(){
  if(hullTextureCache) return hullTextureCache;
  const w = 512, h = 512;
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#e9ebe6';
  ctx.fillRect(0,0,w,h);
  ctx.strokeStyle = 'rgba(90,95,88,0.16)';
  ctx.lineWidth = 1;
  const panelCols = 12;
  for(let i=0;i<panelCols;i++){
    const x = (i/panelCols)*w;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(70,74,68,0.22)';
  ctx.lineWidth = 2;
  [0.18, 0.5, 0.82].forEach(function(f){
    ctx.beginPath(); ctx.moveTo(0,f*h); ctx.lineTo(w,f*h); ctx.stroke();
  });
  // faint rivet dots along the panel seams for close-up detail
  ctx.fillStyle = 'rgba(60,64,58,0.18)';
  for(let i=0;i<panelCols;i++){
    const x = (i/panelCols)*w;
    for(let j=0;j<26;j++){
      const y = (j/26)*h + (i%2)*6;
      ctx.beginPath(); ctx.arc(x, y, 1.1, 0, Math.PI*2); ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cnv);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  hullTextureCache = tex;
  return tex;
}
// A soft radial-gradient sprite (billboarded to the camera automatically by THREE.Sprite) reads as
// a wisp of vapor at any viewing angle; the old faceted low-poly sphere mesh showed hard polygon
// edges and a flat-shaded silhouette up close, especially once the camera pulled in tight during
// chase/orbit cam. One shared canvas texture backs every particle system in the scene (trail, smoke,
// clouds already had their own) — see softParticleTexture().
let softParticleTex = null;
function softParticleTexture(){
  if(softParticleTex) return softParticleTex;
  const size = 64;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');
  const grd = ctx.createRadialGradient(size/2,size/2,0, size/2,size/2,size/2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0,0,size,size);
  softParticleTex = new THREE.CanvasTexture(cnv);
  return softParticleTex;
}

export { getHullTexture, makeCloudTexture, makeGrassTexture, makeScorchedConcreteTexture, makeTerrainTexture, makeTextSprite, softParticleTexture };
