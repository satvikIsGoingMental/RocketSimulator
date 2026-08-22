import { renderer } from "./three-setup.js";

let camMode = 'chase';
// flight/controller.js snaps the camera back to chase on reset; ui/shortcuts.js resets the zoom
// with the "0" key. Both are imported bindings there, hence these setters.
function setCamMode(m){ camMode = m; }
let orbitState = { yaw:0.5, pitch:0.35, dist:60, dragging:false, lastX:0, lastY:0 };
// Free zoom multiplier, independent of altitude/speed/camera mode — the mouse wheel (or pinch on
// trackpads, which the browser reports as wheel events too) always adjusts this, in every camera
// mode, so the user can zoom in or out at will regardless of how fast the vehicle is climbing.
let userZoom = 1;
function setUserZoom(z){ userZoom = z; }
const USER_ZOOM_MIN = 0.15, USER_ZOOM_MAX = 8;
/* ---------------- orbit-drag + free zoom controls ----------------
   Drag-to-orbit only applies in 'orbit' cam mode (dragging the chase/ground cameras around would
   fight their own auto-framing), but the zoom wheel applies in EVERY camera mode — this is the
   fix for zoom being locked to altitude/speed with no user override. */
// Two-finger pinch-to-zoom, tracked alongside (not instead of) the existing single-pointer orbit
// drag above. Pointer Events fire for touch as well as mouse, so a single finger already drags the
// camera in 'orbit' mode via the handlers below — but the 'wheel' event that drives zoom everywhere
// else never fires for touch at all, which left touch users with literally no way to zoom except
// hunting for the tiny on-screen +/- buttons. Tracked by pointerId in a Map so it works regardless
// of which two of the (possibly more, e.g. a stray palm contact) active pointers are the zoom pair:
// on the second simultaneous pointerdown, the pair's current on-screen distance becomes the
// baseline; each subsequent move of either pointer compares the new distance against that baseline
// to get a zoom ratio, exactly like the wheel handler's exp(deltaY) step but driven by finger
// spread instead of scroll delta.
const activePointers = new Map(); // pointerId -> {x,y}
let pinchStartDist = null, pinchStartZoom = 1;
function pointerPairDistance(){
  const pts = Array.from(activePointers.values());
  if(pts.length < 2) return null;
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}
function setupOrbitControls(){
  const el = renderer.domElement;
  el.addEventListener('pointerdown', function(e){
    activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if(activePointers.size === 2){
      pinchStartDist = pointerPairDistance();
      pinchStartZoom = userZoom;
      orbitState.dragging = false; // two fingers down means pinch, not orbit-drag — don't fight it
      return;
    }
    if(camMode !== 'orbit' || activePointers.size !== 1) return;
    orbitState.dragging = true;
    orbitState.lastX = e.clientX; orbitState.lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', function(e){
    if(activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if(activePointers.size === 2 && pinchStartDist){
      const dist = pointerPairDistance();
      if(dist && dist > 1){
        userZoom = Math.max(USER_ZOOM_MIN, Math.min(USER_ZOOM_MAX, pinchStartZoom * (pinchStartDist / dist)));
        updateZoomHint();
      }
      return;
    }
    if(!orbitState.dragging) return;
    const dx = e.clientX - orbitState.lastX, dy = e.clientY - orbitState.lastY;
    orbitState.lastX = e.clientX; orbitState.lastY = e.clientY;
    orbitState.yaw -= dx * 0.006;
    orbitState.pitch = Math.max(0.05, Math.min(1.5, orbitState.pitch - dy * 0.006));
  });
  function releasePointer(e){
    activePointers.delete(e.pointerId);
    if(activePointers.size < 2) pinchStartDist = null;
    orbitState.dragging = false;
  }
  window.addEventListener('pointerup', releasePointer);
  window.addEventListener('pointercancel', releasePointer);
  el.addEventListener('wheel', function(e){
    e.preventDefault();
    // multiplicative step (not additive) so zooming feels consistent whether userZoom is currently
    // small or large, and clamp to a sane range so the rocket can never be scrolled to a pinpoint
    // or scrolled so far out the scene disappears
    const factor = Math.exp(e.deltaY * 0.0012);
    userZoom = Math.max(USER_ZOOM_MIN, Math.min(USER_ZOOM_MAX, userZoom * factor));
    updateZoomHint();
  }, { passive:false });
}

/* ---------------- free zoom UI: buttons mirror the wheel/pinch gesture, in every cam mode ---------------- */
function updateZoomHint(){
  document.getElementById('zoomLabel').textContent = userZoom.toFixed(2)+'×';
}
function stepZoom(factor){
  userZoom = Math.max(USER_ZOOM_MIN, Math.min(USER_ZOOM_MAX, userZoom * factor));
  updateZoomHint();
}

// Camera-mode chips + the zoom buttons, wired once from js/main.js. The pointer/wheel handlers on
// the canvas itself are attached separately by setupOrbitControls(), which initThree() calls once
// the renderer's DOM element exists.
function initCameraControls(){
  Array.from(document.getElementById('camChips').children).forEach(function(chip){
    chip.addEventListener('click', function(){
      camMode = chip.getAttribute('data-cam');
      Array.from(document.getElementById('camChips').children).forEach(function(c){ c.classList.remove('active'); });
      chip.classList.add('active');
    });
  });
  document.getElementById('zoomInBtn').addEventListener('click', function(){ stepZoom(1/1.25); });
  document.getElementById('zoomOutBtn').addEventListener('click', function(){ stepZoom(1.25); });
  document.getElementById('zoomResetBtn').addEventListener('click', function(){ setUserZoom(1); updateZoomHint(); });
  updateZoomHint();
}

export { camMode, initCameraControls, orbitState, setCamMode, setUserZoom, setupOrbitControls, stepZoom, updateZoomHint, userZoom };
