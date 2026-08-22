import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectConsole, realErrors } from './helpers.js';

/* @pack — builds the itch.io archive, unpacks it, and runs the game out of the unpacked copy with
   the network cut off. This is the only check that catches "works locally, dead on itch": a file
   left out of the zip, a wrong relative path, or a lingering CDN dependency. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = path.join(ROOT, 'dist', 'rocket-sim-itch.zip');
const PREVIEW = path.join(ROOT, 'dist', 'preview');

test.describe('@pack itch.io build', () => {
  /* Serial: both tests share one build of the zip. Run in parallel they land on separate workers,
     each runs beforeAll, and the second packer fails trying to overwrite a zip the first still
     has open. */
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'pack-itch.ps1')], {
      cwd: ROOT, stdio: 'pipe',
    });
    fs.rmSync(PREVIEW, { recursive: true, force: true });
    fs.mkdirSync(PREVIEW, { recursive: true });
    execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -Path '${ZIP}' -DestinationPath '${PREVIEW}' -Force`], { stdio: 'pipe' });
  });

  test('the archive puts index.html at the root and excludes dev files', () => {
    expect(fs.existsSync(path.join(PREVIEW, 'index.html')), 'index.html at archive root').toBe(true);
    expect(fs.existsSync(path.join(PREVIEW, 'vendor', 'three', 'three.module.js'))).toBe(true);
    expect(fs.existsSync(path.join(PREVIEW, 'js', 'main.js'))).toBe(true);
    expect(fs.readdirSync(path.join(PREVIEW, 'css')).length).toBe(11);

    for(const excluded of ['legacy', 'tools', 'tests', 'node_modules', 'package.json', 'playwright.config.js', 'CLAUDE.md']){
      expect(fs.existsSync(path.join(PREVIEW, excluded)), `${excluded} must not ship`).toBe(false);
    }
  });

  test('the unpacked build boots and flies with the network blocked', async ({ page }) => {
    // Anything not served from this origin is refused outright — proves the zip is self-contained.
    await page.route('**', route => {
      const url = route.request().url();
      if(url.startsWith('http://127.0.0.1:4173/dist/preview/') || url.startsWith('data:') || url.startsWith('blob:')){
        return route.continue();
      }
      return route.abort();
    });

    const c = collectConsole(page);
    await page.goto('/dist/preview/index.html', { waitUntil: 'load' });
    await expect(page.locator('#loadingHint')).toBeHidden({ timeout: 40_000 });
    await expect(page.locator('#canvasHost canvas')).toBeVisible();
    await expect(page.locator('.rocket-list .rocket-card').first()).toBeVisible();

    await page.locator('#launchBtn').click();
    await expect(page.locator('#hud')).toHaveClass(/visible/);
    await page.locator('#seekBar').fill('3600');
    await expect(page.locator('#resultOverlay')).toHaveClass(/visible/, { timeout: 60_000 });
    await expect(page.locator('#result_title')).not.toHaveText('—');

    // The three companion-page links in the header 404 by design (separate apps); everything the
    // game itself needs must have loaded.
    expect(realErrors(c.errors).filter(e => !/rocket-calc|rocket-designer|mission-log\.html/.test(e))).toEqual([]);
  });
});
