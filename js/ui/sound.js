import { destination } from "../core/mission-config.js";

/* ================================================================================
   SOUND — fully synthesized with the Web Audio API (filtered noise + oscillators),
   same "no external assets" philosophy as the canvas-generated textures above. Two
   layers: a continuous engine bed (rumble + wind + rushing air, all driven every
   frame off engineThrustIntensity/altitude/airspeed, exactly the same signals the
   visual flame/exhaust-light code already uses) and one-shot cues fired off the
   mission log (ignition, MECO, stage sep, landing burn, touchdown/impact) so audio
   and the on-screen event text always agree, without threading sound calls through
   every physics function individually.
   ================================================================================ */
const SOUND_MUTE_KEY = 'dvstack.soundMuted.v1';
const Sound = (function(){
  let ctx = null, master = null, unlocked = false;
  let muted = false;
  try{ muted = localStorage.getItem(SOUND_MUTE_KEY) === '1'; }catch(e){}

  // continuous-bed nodes, built once on unlock and left running with their gains
  // rode up/down every frame rather than started/stopped (avoids audible clicks
  // and lets the same noise buffer loop for the whole session)
  let rumbleGain, rumbleFilter, windGain, windFilter, crackleGain;
  let lastLoggedIndex = 0; // how many sim.log entries we've already voiced, mirrors lastAnnouncedLogT's dedup role

  function noiseBuffer(seconds){
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i=0;i<n;i++) d[i] = Math.random()*2-1;
    return buf;
  }

  function makeNoiseSource(seconds){
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(seconds);
    src.loop = true;
    return src;
  }

  function build(){
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    master.connect(ctx.destination);

    // low, filtered noise + a sub oscillator underneath it: reads as engine/combustion
    // rumble rather than pure static. Filter cutoff and gain are pushed every frame.
    const rumbleNoise = makeNoiseSource(2);
    rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 220;
    rumbleFilter.Q.value = 0.6;
    rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumbleNoise.connect(rumbleFilter).connect(rumbleGain).connect(master);
    rumbleNoise.start();

    const sub = ctx.createOscillator();
    sub.type = 'sawtooth';
    sub.frequency.value = 42;
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    sub.connect(subGain).connect(master);
    sub.start();
    rumbleGain.userData = { sub, subGain };

    // rushing-air/wind bed: high-passed noise, present only while there's meaningful
    // dynamic pressure (thick air + real airspeed) and fully gone once the sky mixes to space
    const windNoise = makeNoiseSource(2);
    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 1200;
    windFilter.Q.value = 0.5;
    windGain = ctx.createGain();
    windGain.gain.value = 0;
    windNoise.connect(windFilter).connect(windGain).connect(master);
    windNoise.start();

    // faint high-frequency crackle bed under the rumble at high throttle, standing in for
    // combustion roughness/shock-diamond crackle — subtle, just adds texture at full throttle
    const crackleNoise = makeNoiseSource(1);
    const crackleFilter = ctx.createBiquadFilter();
    crackleFilter.type = 'highpass';
    crackleFilter.frequency.value = 2600;
    crackleGain = ctx.createGain();
    crackleGain.gain.value = 0;
    crackleNoise.connect(crackleFilter).connect(crackleGain).connect(master);
    crackleNoise.start();
  }

  function unlock(){
    if(unlocked) return;
    unlocked = true;
    try{
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if(!Ctx) return;
      ctx = new Ctx();
      build();
    }catch(e){ ctx = null; }
  }

  function ramp(param, value, tc){
    if(!ctx) return;
    param.setTargetAtTime(value, ctx.currentTime, tc || 0.08);
  }

  // continuous bed — called every animation frame with the same signals already driving
  // the visuals: 0..1 smoothed throttle, current altitude (m), and current airspeed (m/s)
  function updateEngineBed(throttleIntensity, alt, airspeed){
    if(!ctx || muted) return;
    if(ctx.state === 'suspended') ctx.resume().catch(function(){});
    const t = Math.max(0, Math.min(1, throttleIntensity||0));
    ramp(rumbleGain.gain, t * 0.5, 0.12);
    ramp(rumbleFilter.frequency, 110 + t*260, 0.15);
    if(rumbleGain.userData){
      ramp(rumbleGain.userData.subGain.gain, t * 0.22, 0.12);
      ramp(rumbleGain.userData.sub.frequency, 36 + t*30, 0.2);
    }
    ramp(crackleGain.gain, Math.max(0, t-0.55) * 0.09, 0.1);

    // wind bed: fades in with dynamic pressure (thick air * airspeed), and dies out
    // completely once altitude passes the Karman line — nothing left to rush past
    const rho = Math.max(0, 1 - Math.max(0, (alt||0)) / 45000); // matches airDensity's rough falloff shape closely enough for an audio cue, not a physics input
    const spaceMix = Math.max(0, Math.min(1, ((alt||0) - 25000) / 75000));
    const windLevel = Math.min(1, Math.abs(airspeed||0) / 340) * rho * (1 - spaceMix);
    ramp(windGain.gain, windLevel * 0.22, 0.25);
    ramp(windFilter.frequency, 700 + Math.min(Math.abs(airspeed||0), 900)*1.1, 0.3);
  }

  function silenceEngineBed(){
    if(!ctx) return;
    ramp(rumbleGain.gain, 0, 0.25);
    ramp(windGain.gain, 0, 0.3);
    ramp(crackleGain.gain, 0, 0.2);
    if(rumbleGain.userData) ramp(rumbleGain.userData.subGain.gain, 0, 0.25);
  }

  // one-shot cue: short envelope on a fresh oscillator/noise burst, self-disconnecting
  // when done rather than kept alive, since these fire a handful of times per flight
  function beep(freq, dur, type, vol, delay){
    if(!ctx || muted) return;
    const t0 = ctx.currentTime + (delay||0);
    const osc = ctx.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol||0.3, t0+0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0+dur+0.05);
  }

  function thump(dur, vol, freqStart, freqEnd){
    if(!ctx || muted) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqStart, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20,freqEnd), t0+dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0+dur+0.05);
  }

  function burst(dur, vol, filterType, filterFreq){
    if(!ctx || muted) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(dur);
    const f = ctx.createBiquadFilter();
    f.type = filterType || 'lowpass';
    f.frequency.value = filterFreq || 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
  }

  function ignitionCue(){
    burst(1.4, 0.5, 'lowpass', 900);
    thump(1.1, 0.6, 90, 28);
  }
  function meco(){ thump(0.5, 0.35, 340, 60); }
  function separation(){ burst(0.35, 0.4, 'bandpass', 1500); }
  function landingBurnIgnition(){ burst(0.9, 0.4, 'lowpass', 700); thump(0.7, 0.4, 70, 24); }
  function touchdown(){ thump(0.4, 0.5, 130, 30); }
  function impact(){ burst(0.6, 0.7, 'lowpass', 500); thump(0.5, 0.6, 150, 18); }
  function achievement(){ beep(660,0.14,'triangle',0.22,0); beep(880,0.22,'triangle',0.22,0.13); }
  function warning(){ beep(220,0.2,'square',0.18,0); }
  function uiClick(){ beep(520,0.05,'sine',0.12,0); }

  // fires one-shot cues by scanning any sim.log entries this function hasn't seen yet —
  // reuses the same log text the mission-log panel already renders, keyed off phrases that
  // uniquely identify each event, so sound and the visible log can never drift apart
  function voiceLogEntries(log){
    if(!ctx || muted || !log) return;
    for(let i=lastLoggedIndex; i<log.length; i++){
      const text = log[i].text;
      if(text.indexOf('Ignition sequence start') === 0) ignitionCue();
      else if(text.indexOf('Main engine cutoff') === 0) meco();
      else if(text.indexOf('Booster separation') === 0) separation();
      else if(text.indexOf('Landing burn ignition') === 0) landingBurnIgnition();
      else if(text.indexOf('Touchdown') === 0) touchdown();
      else if(text.indexOf('Impact') === 0) impact();
      else if(text.indexOf('Stable orbit achieved') === 0) achievement();
      else if(text.indexOf('Escape trajectory confirmed') === 0) achievement();
      else if(text.indexOf('sphere of influence') !== -1) achievement();
      else if(text.indexOf('propellant exhausted') !== -1) warning();
      else if(text.indexOf('Re-entering atmosphere') === 0) burst(1.0, 0.25, 'highpass', 2200);
    }
    lastLoggedIndex = log.length;
  }
  function resetLogCursor(){ lastLoggedIndex = 0; }

  function setMuted(v){
    muted = v;
    try{ localStorage.setItem(SOUND_MUTE_KEY, muted ? '1' : '0'); }catch(e){}
    if(master) ramp(master.gain, muted ? 0 : 0.85, 0.1);
    if(muted) silenceEngineBed();
  }
  function isMuted(){ return muted; }

  return {
    unlock, updateEngineBed, silenceEngineBed, voiceLogEntries, resetLogCursor,
    uiClick, setMuted, isMuted
  };
})();

const muteBtn = document.getElementById('muteToggle');
function renderMuteIcon(){
  const muted = Sound.isMuted();
  muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  muteBtn.title = muted ? 'Unmute sound' : 'Mute sound';
  muteBtn.setAttribute('aria-label', muteBtn.title);
  document.getElementById('muteIcon').innerHTML = muted
    ? '<path d="M4 9v6h4l5 5V4L8 9H4Z"/><path d="M17 9l5 6M22 9l-5 6" stroke-linecap="round"/>'
    : '<path d="M4 9v6h4l5 5V4L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12" stroke-linecap="round"/>';
}

function initSound(){
  renderMuteIcon();
  muteBtn.addEventListener('click', function(){
    Sound.unlock();
    Sound.setMuted(!Sound.isMuted());
    renderMuteIcon();
    if(!Sound.isMuted()) Sound.uiClick();
  });
}

export { Sound, initSound };
