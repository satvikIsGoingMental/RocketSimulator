import { weather } from "../sim/weather.js";
import { renderLaunchCriteria } from "./criteria-ui.js";

/* ================================================================================
   WEATHER UI — sliders/selects bound directly to the `weather` object, re-rendering the launch
   criteria breakdown (and, if a flight is later started, feeding real wind into the physics via
   windTangentialVelocity/windRadialVelocity) on every change.
   ================================================================================ */
const weatherPresets = [
  { name:'Clear calm', surfaceWindSpeed:2, windDirDeg:45, shearWindSpeed:8, precipitation:'none', cloudCeilingM:8000, temperatureC:22, lightningRisk:'none' },
  { name:'Breezy', surfaceWindSpeed:9, windDirDeg:90, shearWindSpeed:18, precipitation:'none', cloudCeilingM:4500, temperatureC:16, lightningRisk:'none' },
  { name:'High shear', surfaceWindSpeed:6, windDirDeg:60, shearWindSpeed:42, precipitation:'none', cloudCeilingM:5000, temperatureC:14, lightningRisk:'none' },
  { name:'Rain', surfaceWindSpeed:11, windDirDeg:90, shearWindSpeed:20, precipitation:'heavy', cloudCeilingM:900, temperatureC:12, lightningRisk:'none' },
  { name:'Storm', surfaceWindSpeed:19, windDirDeg:90, shearWindSpeed:38, precipitation:'heavy', cloudCeilingM:400, temperatureC:11, lightningRisk:'active' },
];

const wxEls = {
  wind: { r: document.getElementById('wx_wind'), v: document.getElementById('wx_wind_v') },
  dir: { r: document.getElementById('wx_dir'), v: document.getElementById('wx_dir_v') },
  shear: { r: document.getElementById('wx_shear'), v: document.getElementById('wx_shear_v') },
  ceil: { r: document.getElementById('wx_ceil'), v: document.getElementById('wx_ceil_v') },
  temp: { r: document.getElementById('wx_temp'), v: document.getElementById('wx_temp_v') },
};
const wxPrecipSelect = document.getElementById('wx_precip');
const wxLightningSelect = document.getElementById('wx_lightning');

function syncWeatherInputs(){
  wxEls.wind.r.value = weather.surfaceWindSpeed; wxEls.wind.v.textContent = weather.surfaceWindSpeed.toFixed(1)+' m/s';
  wxEls.wind.r.setAttribute('aria-valuetext', weather.surfaceWindSpeed.toFixed(1)+' meters per second');
  wxEls.dir.r.value = weather.windDirDeg; wxEls.dir.v.textContent = Math.round(weather.windDirDeg)+'°';
  wxEls.dir.r.setAttribute('aria-valuetext', Math.round(weather.windDirDeg)+' degrees');
  wxEls.shear.r.value = weather.shearWindSpeed; wxEls.shear.v.textContent = weather.shearWindSpeed.toFixed(1)+' m/s';
  wxEls.shear.r.setAttribute('aria-valuetext', weather.shearWindSpeed.toFixed(1)+' meters per second');
  wxEls.ceil.r.value = weather.cloudCeilingM; wxEls.ceil.v.textContent = Math.round(weather.cloudCeilingM)+' m';
  wxEls.ceil.r.setAttribute('aria-valuetext', Math.round(weather.cloudCeilingM)+' meters');
  wxEls.temp.r.value = weather.temperatureC; wxEls.temp.v.textContent = Math.round(weather.temperatureC)+'°C';
  wxEls.temp.r.setAttribute('aria-valuetext', Math.round(weather.temperatureC)+' degrees Celsius');
  wxPrecipSelect.value = weather.precipitation;
  wxLightningSelect.value = weather.lightningRisk;
}

const weatherPresetsRow = document.getElementById('weatherPresets');
function clearActivePreset(){
  Array.from(weatherPresetsRow.children).forEach(function(c){ c.classList.remove('active'); });
}

// Wiring + first paint, called once from js/main.js.
function initWeatherUI(){
  wxEls.wind.r.addEventListener('input', function(){ weather.surfaceWindSpeed = parseFloat(this.value); syncWeatherInputs(); renderLaunchCriteria(); clearActivePreset(); });
  wxEls.dir.r.addEventListener('input', function(){ weather.windDirDeg = parseFloat(this.value); syncWeatherInputs(); renderLaunchCriteria(); clearActivePreset(); });
  wxEls.shear.r.addEventListener('input', function(){ weather.shearWindSpeed = parseFloat(this.value); syncWeatherInputs(); renderLaunchCriteria(); clearActivePreset(); });
  wxEls.ceil.r.addEventListener('input', function(){ weather.cloudCeilingM = parseFloat(this.value); syncWeatherInputs(); renderLaunchCriteria(); clearActivePreset(); });
  wxEls.temp.r.addEventListener('input', function(){ weather.temperatureC = parseFloat(this.value); syncWeatherInputs(); renderLaunchCriteria(); clearActivePreset(); });
  wxPrecipSelect.addEventListener('change', function(){ weather.precipitation = this.value; renderLaunchCriteria(); clearActivePreset(); });
  wxLightningSelect.addEventListener('change', function(){ weather.lightningRisk = this.value; renderLaunchCriteria(); clearActivePreset(); });
  weatherPresets.forEach(function(p){
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = p.name;
    chip.addEventListener('click', function(){
      Object.assign(weather, p);
      syncWeatherInputs();
      clearActivePreset();
      chip.classList.add('active');
      renderLaunchCriteria();
    });
    weatherPresetsRow.appendChild(chip);
  });
  syncWeatherInputs();
  renderLaunchCriteria();
}

export { clearActivePreset, initWeatherUI, syncWeatherInputs };
