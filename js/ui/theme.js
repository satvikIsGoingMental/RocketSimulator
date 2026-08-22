import { applySkyColors } from "../scene/three-setup.js";

/* ================================================================================
   THEME (matches rocket-calc.html)
   ================================================================================ */
const root = document.documentElement;
const themeBtn = document.getElementById('themeToggle');
function currentRenderedTheme(){
  const stamped = root.getAttribute('data-theme');
  if(stamped) return stamped;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function setTheme(t){
  if(t){ root.setAttribute('data-theme', t); }
  else { root.removeAttribute('data-theme'); }
  applySkyColors();
}

// Wiring, called once from js/main.js. Kept out of module-evaluation time so the order in which
// the UI comes up is decided in one visible place rather than by the import graph.
function initTheme(){
  themeBtn.addEventListener('click', function(){
    const now = currentRenderedTheme();
    setTheme(now === 'dark' ? 'light' : 'dark');
  });
}

export { currentRenderedTheme, initTheme, root };
