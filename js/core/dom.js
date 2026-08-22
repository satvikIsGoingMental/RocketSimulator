/* ================================================================================
   SHARED DOM HANDLES

   The elements more than one module talks to, looked up once here instead of being re-queried
   (or re-cached under a second name) in every module that touches them. Modules that own a
   single widget outright — the theme button, the mute button, the weather sliders, the canvas
   host — still cache it locally in that module; only the genuinely shared handles live here.

   These run at module-evaluation time, which is safe: js/main.js is loaded as
   <script type="module">, and module scripts are deferred, so the whole document is parsed
   before any of this executes.
   ================================================================================ */
const setupPanel = document.getElementById('setupPanel');
const hud = document.getElementById('hud');
const transport = document.getElementById('transport');
const camRow = document.getElementById('camRow');
const missionLog = document.getElementById('missionLog');
const srAnnounce = document.getElementById('srAnnounce');
const launchBtn = document.getElementById('launchBtn');
const resetBtn = document.getElementById('resetBtn');
const resultOverlay = document.getElementById('resultOverlay');
const seekBar = document.getElementById('seekBar');

export { camRow, hud, launchBtn, missionLog, resetBtn, resultOverlay, seekBar, setupPanel, srAnnounce, transport };
