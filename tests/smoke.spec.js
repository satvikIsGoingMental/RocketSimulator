import { test, expect } from '@playwright/test';
import { collectConsole, realErrors, openApp, launch, text } from './helpers.js';

/* @smoke — the refactor's first line of defence. Every one of these would have passed trivially in
   the original single-file build; if one fails now, the split broke something. */

test.describe('@smoke boot', () => {
  test('loads with no console errors and starts the 3D scene', async ({ page }) => {
    const c = collectConsole(page);
    await page.goto('/index.html', { waitUntil: 'load' });

    // The loading hint clears only once initThree() + buildRocketModel() both return.
    await expect(page.locator('#loadingHint')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('#canvasHost canvas')).toBeVisible();

    expect(realErrors(c.errors), 'console errors during boot').toEqual([]);
  });

  test('page metadata and every stylesheet/module resolves', async ({ page }) => {
    const c = collectConsole(page);
    const failed = [];
    page.on('response', r => { if(r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

    await openApp(page);

    await expect(page).toHaveTitle('Δv Stack — Launch Simulator');
    expect(failed, 'non-200 responses').toEqual([]);
    expect(realErrors(c.errors)).toEqual([]);
  });

  test('three.js is served from the local vendor copy, not a CDN', async ({ page }) => {
    const urls = [];
    page.on('request', r => urls.push(r.url()));
    await openApp(page);

    expect(urls.some(u => u.includes('/vendor/three/three.module.js')), 'vendored three.js was requested').toBe(true);
    expect(urls.filter(u => /unpkg\.com|jsdelivr|cdnjs|skypack/.test(u)), 'no CDN requests').toEqual([]);
  });
});

test.describe('@smoke setup panel', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  test('roster renders and selecting a vehicle updates detail + preflight', async ({ page }) => {
    const cards = page.locator('.rocket-list .rocket-card');
    await expect(cards).not.toHaveCount(0);
    await expect(page.locator('#rocketDetail')).not.toBeEmpty();

    const before = await text(page, '#pf_dv');
    await cards.nth(1).click();
    await expect(cards.nth(1)).toHaveClass(/active/);

    for(const id of ['#pf_dv', '#pf_m0', '#pf_tw', '#pf_tb']){
      await expect(page.locator(id)).not.toHaveText('—');
    }
    // A different vehicle must produce a different Δv; if it doesn't, the detail panel isn't
    // actually re-deriving from the selected rocket.
    await expect(page.locator('#pf_dv')).not.toHaveText(before);
  });

  test('launch criteria list renders and reacts to the weather sliders', async ({ page }) => {
    await expect(page.locator('#lcc_overall')).not.toBeEmpty();
    const items = page.locator('#lcc_list > *');
    await expect(items).not.toHaveCount(0);

    const calm = await text(page, '#lcc_overall');
    // Drive it hard into NO-GO territory: max wind, max shear, heavy rain, active lightning.
    await page.locator('#wx_wind').fill('35');
    await page.locator('#wx_shear').fill('55');
    await page.locator('#wx_precip').selectOption('heavy');
    await page.locator('#wx_lightning').selectOption('active');
    await expect(page.locator('#wx_wind_v')).toContainText('35');
    await expect(page.locator('#lcc_overall')).toContainText('NO-GO');
    expect(calm).not.toContain('NO-GO');
  });

  test('weather presets, flight profile and destination chips all switch', async ({ page }) => {
    const preset = page.locator('#weatherPresets .chip').nth(1);
    await preset.click();
    await expect(preset).toHaveClass(/active/);

    await page.locator('#flightProfileChips [data-profile="straight-up"]').click();
    await expect(page.locator('#flightProfileChips [data-profile="straight-up"]')).toHaveClass(/active/);
    await expect(page.locator('#flightProfileNote')).toContainText('vertical');

    for(const d of ['moon', 'mars', 'earth-orbit']){
      await page.locator(`#destinationChips [data-destination="${d}"]`).click();
      await expect(page.locator(`#destinationChips [data-destination="${d}"]`)).toHaveClass(/active/);
      await expect(page.locator('#destinationNote')).not.toBeEmpty();
    }
  });

  test('reset-setup button restores weather and zoom defaults', async ({ page }) => {
    await page.locator('#wx_wind').fill('30');
    await page.locator('#flightProfileChips [data-profile="straight-up"]').click();
    await page.locator('#destinationChips [data-destination="mars"]').click();

    await page.locator('#resetSetupBtn').click();

    await expect(page.locator('#wx_wind_v')).toContainText('4');
    await expect(page.locator('#flightProfileChips [data-profile="gravity-turn"]')).toHaveClass(/active/);
    await expect(page.locator('#destinationChips [data-destination="earth-orbit"]')).toHaveClass(/active/);
    await expect(page.locator('#zoomLabel')).toHaveText('1.00×');
  });
});

test.describe('@smoke chrome', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  test('theme toggle flips data-theme and survives a reload', async ({ page }) => {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.locator('#themeToggle').click();
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(before);
    expect(['dark', 'light']).toContain(after);
  });

  test('mute toggle updates its pressed state', async ({ page }) => {
    const btn = page.locator('#muteToggle');
    const before = await btn.getAttribute('aria-pressed');
    await btn.click();
    await expect(btn).not.toHaveAttribute('aria-pressed', before ?? 'false');
  });

  test('zoom buttons and the 0 key drive the zoom readout', async ({ page }) => {
    // #camRow (which holds the zoom controls) is pointer-events:none until a flight starts.
    await launch(page);
    await expect(page.locator('#camRow')).toHaveClass(/visible/);

    await expect(page.locator('#zoomLabel')).toHaveText('1.00×');
    await page.locator('#zoomInBtn').click();
    await expect(page.locator('#zoomLabel')).not.toHaveText('1.00×');
    await page.locator('#zoomResetBtn').click();
    await expect(page.locator('#zoomLabel')).toHaveText('1.00×');

    await page.locator('#zoomOutBtn').click();
    await expect(page.locator('#zoomLabel')).not.toHaveText('1.00×');
    // The keydown handler deliberately ignores keys while a BUTTON has focus.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('0');
    await expect(page.locator('#zoomLabel')).toHaveText('1.00×');
  });
});
