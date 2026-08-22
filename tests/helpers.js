import { expect } from '@playwright/test';

/**
 * Attaches console/pageerror collectors BEFORE navigation, so nothing thrown during module
 * evaluation is missed. Returns { errors, warnings } arrays that fill as the page runs.
 */
export function collectConsole(page){
  const errors = [];
  const warnings = [];
  page.on('console', msg => {
    if(msg.type() === 'error') errors.push(msg.text());
    else if(msg.type() === 'warning') warnings.push(msg.text());
  });
  page.on('pageerror', err => errors.push('pageerror: ' + (err && err.stack ? err.stack : String(err))));
  page.on('requestfailed', req => errors.push('requestfailed: ' + req.url() + ' — ' + (req.failure()?.errorText || '')));
  return { errors, warnings };
}

/** Navigate to the app and wait until the 3D scene has actually started. */
export async function openApp(page, path = '/index.html'){
  const console_ = collectConsole(page);
  await page.goto(path, { waitUntil: 'load' });
  await expect(page.locator('#loadingHint')).toBeHidden({ timeout: 30_000 });
  return console_;
}

/**
 * Console noise that is not a defect in this app:
 *  - Chromium's software-WebGL warnings under SwiftShader
 *  - the deliberate console.error in boot()'s WebGL-unavailable path is NOT ignored; if it fires,
 *    the run genuinely failed.
 */
export const IGNORABLE = [
  /SwiftShader/i,
  /software rendering/i,
  /GPU stall/i,
  /Automatic fallback to software WebGL/i,
  /THREE\.WebGLRenderer: A WebGL context could not be created\. Reason: .*swiftshader/i,
];

export function realErrors(errors){
  return errors.filter(e => !IGNORABLE.some(rx => rx.test(e)));
}

/** Read a live value out of the page by CSS selector's text content. */
export async function text(page, selector){
  return (await page.locator(selector).innerText()).trim();
}

/** Click "Ignition & Liftoff" and wait for the HUD to take over from the setup panel. */
export async function launch(page){
  await page.locator('#launchBtn').click();
  await expect(page.locator('#hud')).toHaveClass(/visible/);
  await expect(page.locator('#setupPanel')).toHaveClass(/hidden/);
}

/** Pick a vehicle from the roster by its visible name. */
export async function selectVehicle(page, name){
  await page.locator('.rocket-list .rocket-card', { hasText: name }).first().click();
  await expect(page.locator('#rocketDetail')).toContainText(name);
}

/** Set the destination chip (earth-orbit | moon | mars). */
export async function setDestination(page, id){
  await page.locator(`#destinationChips [data-destination="${id}"]`).click();
  await expect(page.locator(`#destinationChips [data-destination="${id}"]`)).toHaveClass(/active/);
}

/** Set time warp by clicking a speed chip. */
export async function setSpeed(page, mult){
  await page.locator(`#speedRow [data-speed="${mult}"]`).click();
}

/** Mission elapsed time, in seconds, parsed from the HUD clock. */
export async function missionSeconds(page){
  const raw = await text(page, '#hud_time');           // "T+00:42" or "T+1d 03:12:07"
  const m = raw.replace(/^T\+/, '').trim();
  const dayMatch = m.match(/^(\d+)d\s+(.*)$/);
  const days = dayMatch ? parseInt(dayMatch[1], 10) : 0;
  const clock = dayMatch ? dayMatch[2] : m;
  const parts = clock.split(':').map(Number);
  const [h, mi, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return days * 86400 + h * 3600 + mi * 60 + s;
}

/**
 * Fast-forward a live flight to its end. The seek bar's input handler calls runSimTo() directly,
 * which resolves the whole remaining flight in one pass — far quicker and less flaky than clicking
 * the skip chips repeatedly. Earth flights always terminate by the sim's own T+3600s backstop.
 */
export async function runToResult(page, targetT = 3600){
  await page.locator('#seekBar').fill(String(targetT));
  await expect(page.locator('#resultOverlay')).toHaveClass(/visible/, { timeout: 60_000 });
}

/**
 * Interplanetary coasts run for simulated weeks or months, past what the seek bar's 3600s range
 * covers, so those are advanced with the skip chips instead.
 */
export async function skipUntilResult(page, skipSeconds, maxClicks = 40){
  const chip = page.locator(`#skipRow [data-skip="${skipSeconds}"]`);
  for(let i = 0; i < maxClicks; i++){
    const cls = (await page.locator('#resultOverlay').getAttribute('class')) || '';
    if(cls.includes('visible')) return;
    await chip.click();
    await page.waitForTimeout(120);
  }
  await expect(page.locator('#resultOverlay')).toHaveClass(/visible/, { timeout: 60_000 });
}
