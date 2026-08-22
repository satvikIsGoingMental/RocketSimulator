function fmt(v, digits){
  if(!Number.isFinite(v)) return '—';
  if(digits === undefined) digits = 0;
  const abs = Math.abs(v);
  if(abs >= 1000000) return (v/1000000).toFixed(2)+'M';
  if(abs >= 10000) return v.toLocaleString(undefined, {maximumFractionDigits:0});
  return v.toLocaleString(undefined, {maximumFractionDigits:digits, minimumFractionDigits:0});
}

// Rocket name/maker/fact strings ultimately trace back to localStorage (the calculator/designer
// handoff payload — see readCustomVehicle), which is a same-origin trust boundary, not a hostile
// one, but it's still writable by any script or extension with access to this origin. Escaping
// here means a malformed or tampered payload can only ever show as garbled text, never execute.
const ESCAPE_HTML_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){ return ESCAPE_HTML_MAP[c]; });
}
// T+ mission clock, extended to days once a flight runs long enough to need them (an interplanetary
// transfer can run for months of simulated time — the old fixed MM:SS format would just keep
// climbing past 99 minutes with no days digit, which stops being readable as a mission clock).
function formatMissionClock(t){
  if(t < 86400) {
    const mm = Math.floor(t/60), ss = Math.floor(t%60);
    return 'T+'+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0');
  }
  const days = Math.floor(t/86400);
  const hh = Math.floor((t%86400)/3600);
  return 'T+'+days+'d '+String(hh).padStart(2,'0')+'h';
}
// Same "days once it's long" idea for a plain duration (used for ETA, which is always a forward-
// looking span rather than a mission-elapsed clock, so it doesn't need the T+ prefix).
function formatDuration(seconds){
  if(!Number.isFinite(seconds) || seconds < 0) return '—';
  if(seconds < 120) return Math.round(seconds)+'s';
  if(seconds < 7200) return Math.round(seconds/60)+' min';
  if(seconds < 172800) return (seconds/3600).toFixed(1)+' hr';
  return (seconds/86400).toFixed(1)+' days';
}

export { escapeHtml, fmt, formatDuration, formatMissionClock };
