import { launchBtn, resetBtn } from "../core/dom.js";
import { flightActive, sim } from "../flight/controller.js";
import { setUserZoom, stepZoom, updateZoomHint } from "../scene/controls.js";

/* ---------------- keyboard shortcuts ----------------
   Dispatched to whichever real button already owns the behavior (.click()) rather than duplicating
   their logic here, so there is exactly one place — the existing click handlers above — that ever
   needs to change if that behavior changes. Ignored while focus is in a form control (range slider,
   select, or a button mid-interaction) so e.g. arrowing a weather slider or spacebar-activating a
   focused chip isn't hijacked into a global action; ignored with any modifier key held so browser/OS
   shortcuts (Ctrl+R reload, Cmd+= zoom the page, etc.) are left alone. */
function initShortcuts(){
  document.addEventListener('keydown', function(e){
    if(e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    switch(e.key){
      case ' ':
        if(flightActive){ document.getElementById('pauseBtn').click(); e.preventDefault(); }
        break;
      case '+': case '=':
        stepZoom(1/1.25); e.preventDefault();
        break;
      case '-': case '_':
        stepZoom(1.25); e.preventDefault();
        break;
      case '0':
        setUserZoom(1); updateZoomHint(); e.preventDefault();
        break;
      case 'r': case 'R':
        if(resetBtn.style.display !== 'none') resetBtn.click();
        break;
      case 'Enter':
        if(!flightActive && !sim) launchBtn.click();
        break;
    }
  });
}

export { initShortcuts };
