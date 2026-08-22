import { launchBtn } from "./core/dom.js";
import { initFlightControls } from "./flight/controller.js";
import { initCameraControls } from "./scene/controls.js";
import { buildRocketModel } from "./scene/rocket-model.js";
import { initThree, loadingHint } from "./scene/three-setup.js";
import { initProfileUI } from "./ui/profile-ui.js";
import { initRosterUI } from "./ui/roster-ui.js";
import { initShortcuts } from "./ui/shortcuts.js";
import { initSound } from "./ui/sound.js";
import { initTheme } from "./ui/theme.js";
import { initWeatherUI } from "./ui/weather-ui.js";

/* ================================================================================
   ENTRY POINT

   Every other module in js/ only *declares* things — no module wires up a listener or paints a
   panel just because it was imported. All of that happens here, in the order below, which is the
   same order the original single-file build ran it in. Keeping it explicit means the startup
   sequence is readable in one place instead of being an emergent property of the import graph,
   and it removes the temporal-dead-zone hazards that come with cyclic imports doing work at
   module-evaluation time.

   This file is loaded as <script type="module">, which is deferred by default, so the document is
   fully parsed before any of this runs.
   ================================================================================ */

// Panels, chips, sliders and the transport bar. All pure DOM work — none of it touches WebGL, so
// it stays useful even on the failure path below where the 3D view can't start.
function initUI(){
  initTheme();
  initSound();
  initRosterUI();
  initWeatherUI();
  initProfileUI();
  initFlightControls();
  initCameraControls();
  initShortcuts();
}

function boot(){
  initUI();
  try{
    initThree();
    buildRocketModel();
  }catch(err){
    // Most likely cause: WebGL unavailable (disabled in browser settings, blocked by a locked-down
    // environment, or no GPU/driver support) — new THREE.WebGLRenderer(...) throws synchronously in
    // that case. Without this catch the page is left stuck reading "Loading 3D engine…" forever with
    // no explanation, since nothing else clears loadingHint on this path.
    console.error('3D scene failed to initialize:', err);
    loadingHint.textContent = 'Could not start the 3D view — your browser or device may not support WebGL.';
    loadingHint.style.display = '';
    if(launchBtn) launchBtn.disabled = true;
  }
}

// THREE is a real `import` binding (see the import map in index.html) rather than a global filled
// in asynchronously, so there's no race to guard against here: by the time this module body runs,
// the import has already resolved. A failed fetch of the three.js module instead surfaces as this
// whole module graph failing to load, which the browser reports as a page-level error on its own.
if(document.readyState === 'complete' || document.readyState === 'interactive'){
  boot();
} else {
  window.addEventListener('DOMContentLoaded', boot);
}
