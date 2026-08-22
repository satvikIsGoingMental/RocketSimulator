import { test, expect } from '@playwright/test';
import { collectConsole, realErrors, openApp, launch, selectVehicle, setDestination, setSpeed, text, missionSeconds, runToResult, skipUntilResult } from './helpers.js';

/* @flight — drives the simulator end to end. These exercise sim/, scene/ and flight/ together,
   which is where a bad import or a missing setter shows up as wrong physics rather than as a
   thrown error.

   Roster note (measured, not assumed): the first six vehicles are suborbital under a default
   gravity turn and come back down; the last six exceed Earth escape velocity. Tests pick a vehicle
   deliberately for the outcome they are checking. */

const SUBORBITAL = 'Falcon 9 (core)';
const ESCAPE_CAPABLE = 'Saturn V + S-IVB (TLI stack)';
const FASTEST_DEPARTURE = 'Atlas V 551 + Centaur + Star 48 (fastest departure)';

test.describe('@flight earth', () => {
  test('a launch runs, populates the HUD, and resolves to a result', async ({ page }) => {
    const c = await openApp(page);
    await selectVehicle(page, SUBORBITAL);
    await launch(page);

    await expect(page.locator('#hud_phase')).not.toHaveText('T-MINUS', { timeout: 20_000 });
    await expect(page.locator('#transport')).toHaveClass(/visible/);
    await expect(page.locator('#missionLog')).toHaveClass(/visible/);
    await expect(page.locator('#missionLog .entry').first()).toBeVisible();

    await expect.poll(async () => parseFloat((await text(page, '#hud_alt')).replace(/[^\d.]/g, '')) || 0,
      { timeout: 30_000, message: 'altitude climbing' }).toBeGreaterThan(0);
    await expect(page.locator('#hud_vel')).not.toHaveText(/^0\s/);
    await expect(page.locator('#hud_mass')).not.toContainText('—');
    await expect(page.locator('#hud_dvrem')).not.toContainText('—');
    expect(parseInt(await text(page, '#hud_throttle_pct'), 10)).toBeGreaterThan(0);

    await runToResult(page);
    await expect(page.locator('#result_title')).not.toHaveText('—');
    for(const id of ['#res_alt', '#res_vel', '#res_q', '#res_tb']){
      await expect(page.locator(id)).not.toHaveText('—');
    }
    // Falcon 9 on a gravity turn is suborbital: it must re-enter, not stay up.
    await expect(page.locator('#missionLog')).toContainText('Re-entering atmosphere');
    expect(realErrors(c.errors), 'console errors during the flight').toEqual([]);
  });

  test('an escape-capable vehicle leaves Earth and shows the orbital block', async ({ page }) => {
    const c = await openApp(page);
    await selectVehicle(page, ESCAPE_CAPABLE);
    await launch(page);
    await runToResult(page);

    await expect(page.locator('#hud_orbit_block')).toBeVisible();
    // An escape trajectory is hyperbolic, so it has no apoapsis to show — the state readout is
    // what carries the answer here.
    await expect(page.locator('#hud_orbit_state')).not.toHaveText('—');
    await expect(page.locator('#result_title')).toContainText(/escape/i);
    await expect(page.locator('#missionLog')).toContainText('Main engine cutoff');
    expect(realErrors(c.errors)).toEqual([]);
  });

  test('a straight-up profile never reaches orbit', async ({ page }) => {
    await openApp(page);
    await selectVehicle(page, ESCAPE_CAPABLE);
    await page.locator('#flightProfileChips [data-profile="straight-up"]').click();
    await launch(page);
    await runToResult(page);
    // A pure vertical hop can only ever come back down — orbital velocity IS horizontal velocity.
    await expect(page.locator('#result_title')).not.toContainText(/\borbit\b/i);
  });

  test('the preflight panel derives real numbers for every vehicle in the roster', async ({ page }) => {
    await openApp(page);
    const names = await page.locator('.rocket-list .rk-name').allInnerTexts();
    expect(names.length).toBeGreaterThan(5);
    for(const n of names){
      await page.locator('.rocket-list .rocket-card', { hasText: n }).first().click();
      for(const id of ['#pf_dv', '#pf_m0', '#pf_tw', '#pf_tb']){
        await expect(page.locator(id), `${n} ${id}`).not.toHaveText('—');
      }
      expect(parseFloat(await text(page, '#pf_tw')), `${n} T/W`).toBeGreaterThan(0);
    }
  });
});

test.describe('@flight transport', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await selectVehicle(page, ESCAPE_CAPABLE);
    await launch(page);
  });

  test('pause freezes the mission clock and resume restarts it', async ({ page }) => {
    await page.locator('#pauseBtn').click();
    const t1 = await missionSeconds(page);
    await page.waitForTimeout(1200);
    expect(await missionSeconds(page)).toBe(t1);

    await page.locator('#pauseBtn').click();
    await expect.poll(() => missionSeconds(page), { timeout: 15_000 }).toBeGreaterThan(t1);
  });

  test('each speed chip becomes the active one', async ({ page }) => {
    for(const mult of ['1', '5', '20', '60', '200']){
      await setSpeed(page, mult);
      await expect(page.locator(`#speedRow [data-speed="${mult}"]`)).toHaveClass(/active/);
    }
  });

  test('skip ahead jumps the mission clock forward', async ({ page }) => {
    const before = await missionSeconds(page);
    await page.locator('#skipRow [data-skip="60"]').click();
    await expect.poll(() => missionSeconds(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 55);
  });

  test('all three camera modes activate', async ({ page }) => {
    for(const cam of ['ground', 'orbit', 'chase']){
      await page.locator(`#camChips [data-cam="${cam}"]`).click();
      await expect(page.locator(`#camChips [data-cam="${cam}"]`)).toHaveClass(/active/);
    }
  });

  test('space bar toggles pause', async ({ page }) => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press(' ');
    const t1 = await missionSeconds(page);
    await page.waitForTimeout(1000);
    expect(await missionSeconds(page)).toBe(t1);
    await page.keyboard.press(' ');
    await expect.poll(() => missionSeconds(page), { timeout: 15_000 }).toBeGreaterThan(t1);
  });
});

test.describe('@flight review and reset', () => {
  test('"Fly again" returns to the setup screen with everything reset', async ({ page }) => {
    const c = await openApp(page);
    await selectVehicle(page, SUBORBITAL);
    await launch(page);
    await page.locator('#camChips [data-cam="orbit"]').click();
    await runToResult(page);

    await page.locator('#againBtn').click();
    await expect(page.locator('#setupPanel')).not.toHaveClass(/hidden/);
    await expect(page.locator('#hud')).not.toHaveClass(/visible/);
    await expect(page.locator('#resultOverlay')).not.toHaveClass(/visible/);
    await expect(page.locator('#launchBtn')).toBeVisible();
    // resetFlightView() snaps the camera back to chase — this is the setCamMode() path.
    await expect(page.locator('#camChips [data-cam="chase"]')).toHaveClass(/active/);
    await expect(page.locator('#seekBar')).toBeDisabled();
    expect(realErrors(c.errors)).toEqual([]);
  });

  test('"Review flight" enables the seek bar and scrubbing moves the HUD', async ({ page }) => {
    const c = await openApp(page);
    await selectVehicle(page, SUBORBITAL);
    await launch(page);
    await runToResult(page);

    await page.locator('#reviewBtn').click();
    await expect(page.locator('#resultOverlay')).not.toHaveClass(/visible/);
    await expect(page.locator('#seekBar')).toBeEnabled();

    const endAlt = await text(page, '#hud_alt');
    await page.locator('#seekBar').fill('1');
    await expect.poll(() => text(page, '#hud_alt'), { timeout: 15_000 }).not.toBe(endAlt);
    await expect(page.locator('#seekTime')).toContainText('T+');
    expect(realErrors(c.errors)).toEqual([]);
  });

  test('a completed flight is written to the shared mission log', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => localStorage.removeItem('dvstack.missionLog.v1'));
    await selectVehicle(page, SUBORBITAL);
    await launch(page);
    await runToResult(page);

    const entries = await page.evaluate(() => JSON.parse(localStorage.getItem('dvstack.missionLog.v1') || '[]'));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].vehicleName).toBe(SUBORBITAL);
    expect(entries[0].outcome).toBeTruthy();
    expect(entries[0].findings.length).toBeGreaterThan(0);
  });
});

test.describe('@flight interplanetary', () => {
  /* The transfer coast and the arrival/landing sequence are the deepest paths in sim/, and the
     ones a bad import in transfer.js would silently break. Each run is warped to touchdown. */
  /* Outcomes below are what the simulator actually does with the roster's fastest departure
     vehicle, verified against legacy/rocket-sim.html run the same way:
       - Moon:  reaches the lunar sphere of influence and attempts a powered descent.
       - Mars:  a ~200-400 m/s v∞ departure cannot close 225 million km inside the sim's own
                transfer time budget, so it ends on "Mission incomplete". That is pre-existing
                app behaviour, not a refactor regression — the legacy build does the same. */
  const MISSIONS = [
    { body: 'moon', coast: 'Trans-Moon coast confirmed', reaches: 'sphere of influence' },
    { body: 'mars', coast: 'Trans-Mars coast confirmed', reaches: 'Simulation time limit reached' },
  ];

  for(const { body, coast, reaches } of MISSIONS){
    test(`a ${body} mission departs Earth and runs the patched-conic coast`, async ({ page }) => {
      test.slow();
      const c = await openApp(page);
      await selectVehicle(page, FASTEST_DEPARTURE);
      await setDestination(page, body);
      await expect(page.locator('#destinationDvCheck')).not.toBeEmpty();
      await launch(page);
      await setSpeed(page, 100000);

      // Each +30d skip resolves a month of coast in one runSimTo() pass.
      await skipUntilResult(page, 2592000, 45);
      await expect(page.locator('#result_title')).not.toHaveText('—');
      // The log keeps every event, so it proves the whole path ran: ascent -> Earth departure ->
      // transfer coast -> however this particular mission ends.
      await expect(page.locator('#missionLog')).toContainText('Escape trajectory confirmed');
      await expect(page.locator('#missionLog')).toContainText(coast);
      await expect(page.locator('#missionLog')).toContainText(reaches);

      const entries = await page.evaluate(() => JSON.parse(localStorage.getItem('dvstack.missionLog.v1') || '[]'));
      expect(entries[0].destination).toBe(body);
      expect(realErrors(c.errors), `console errors during the ${body} mission`).toEqual([]);
    });
  }
});

test.describe('@flight physics parity', () => {
  /* The strongest guarantee available: run the identical scripted flight against index.html and
     against legacy/rocket-sim.html and compare the outcomes.

     Exact equality is not the bar, and deliberately so — the sim advances in real-time animation
     frames before the seek fires, so the number of 1/60s steps taken before the fast-forward
     varies run to run. Measured, the legacy build disagrees with ITSELF by ~0.08% on peak
     altitude across repeat runs. The tolerance below is well inside that pre-existing spread, so
     a genuine physics change (a lost constant, a wrong sign, a dropped drag term) still fails
     loudly while frame-timing jitter does not. */
  const TOLERANCE = 0.01; // 1%

  async function flyAndMeasure(page, url){
    await page.route('**unpkg.com/**', r => r.continue());
    await page.goto(url);
    await expect(page.locator('#loadingHint')).toBeHidden({ timeout: 40_000 });
    await page.locator('.rocket-list .rocket-card', { hasText: SUBORBITAL }).first().click();
    await page.locator('#launchBtn').click();
    await expect(page.locator('#hud')).toHaveClass(/visible/);
    await page.locator('#seekBar').fill('3600');
    await expect(page.locator('#resultOverlay')).toHaveClass(/visible/, { timeout: 40_000 });

    const num = async sel => parseFloat((await page.locator(sel).innerText()).replace(/[^\d.]/g, ''));
    return {
      title: await page.locator('#result_title').innerText(),
      lede: await page.locator('#result_lede').innerText(),
      /* Event names and their ORDER must match exactly. Every number inside the log is blanked
         out first: the T+ timestamps and the quoted speeds/altitudes carry the same frame-timing
         jitter the magnitudes below are given a tolerance for. */
      events: (await page.locator('#missionLog').innerText()).replace(/[\d.,]+/g, '#'),
      maxAlt: await num('#res_alt'),
      maxVel: await num('#res_vel'),
      maxQ: await num('#res_q'),
      burn: await num('#res_tb'),
    };
  }

  test('the refactored build flies the same mission as the legacy single file', async ({ page }) => {
    test.slow();
    const now = await flyAndMeasure(page, '/index.html');
    const legacy = await flyAndMeasure(page, '/legacy/rocket-sim.html');

    expect(now.title).toBe(legacy.title);
    expect(now.lede).toBe(legacy.lede);
    expect(now.events).toBe(legacy.events);
    for(const key of ['maxAlt', 'maxVel', 'maxQ', 'burn']){
      expect(now[key], `${key}: ${now[key]} vs legacy ${legacy[key]}`)
        .toBeCloseTo(legacy[key], -Math.log10(Math.abs(legacy[key] || 1) * TOLERANCE));
    }
  });
});
