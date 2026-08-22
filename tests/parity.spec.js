import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* @parity — proves the split reproduces legacy/rocket-sim.html rather than approximating it.
   The CSS and the markup were pure text moves, so they are held to byte equality. The JS was
   genuinely rewritten (imports/exports/setters), so it is held to declaration equality plus the
   rendered-style comparison at the bottom. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = fs.readFileSync(path.join(ROOT, 'legacy', 'rocket-sim.html'), 'utf8');

// Load order must match the <link> order in index.html; the cascade depends on it.
const CSS_ORDER = ['base', 'tokens', 'layout', 'header', 'stage', 'panels', 'weather', 'criteria', 'hud', 'transport', 'overlay'];

function section(src, open, close){
  const a = src.indexOf(open);
  const b = src.indexOf(close, a);
  expect(a, `found ${open}`).toBeGreaterThan(-1);
  expect(b, `found ${close}`).toBeGreaterThan(a);
  return src.slice(a + open.length, b);
}

test.describe('@parity source', () => {
  test('index.html links every css file, in the documented order', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const linked = [...html.matchAll(/<link rel="stylesheet" href="css\/([\w-]+)\.css"/g)].map(m => m[1]);
    expect(linked).toEqual(CSS_ORDER);

    const onDisk = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css')).map(f => f.replace(/\.css$/, '')).sort();
    expect(onDisk, 'no orphaned or unlinked stylesheet').toEqual([...CSS_ORDER].sort());
  });

  test('concatenated css is byte-identical to the legacy <style> block', () => {
    const joined = CSS_ORDER.map(n => fs.readFileSync(path.join(ROOT, 'css', `${n}.css`), 'utf8')).join('');
    const original = section(LEGACY, '<style>\n', '</style>');
    expect(joined).toBe(original);
  });

  test('body markup is byte-identical to the legacy markup', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const body = section(html, '<body>\n\n', '\n\n<!--\n  three.js removed');
    const original = section(LEGACY, '</style>\n\n', '\n\n<!--\n  three.js removed');
    expect(body).toBe(original);
  });

  test('every top-level declaration from the legacy script still exists in js/', () => {
    const script = section(LEGACY, '<script type="module">\n', '\n</script>');
    const names = new Set();
    for(const line of script.split('\n')){
      const m = /^(?:async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if(m) names.add(m[2]);
    }
    expect(names.size).toBeGreaterThan(100);

    const sources = [];
    (function walk(dir){
      for(const e of fs.readdirSync(dir, { withFileTypes: true })){
        const p = path.join(dir, e.name);
        if(e.isDirectory()) walk(p);
        else if(e.name.endsWith('.js')) sources.push(fs.readFileSync(p, 'utf8'));
      }
    })(path.join(ROOT, 'js'));
    const all = sources.join('\n');

    const missing = [...names].filter(n => !new RegExp(`(?:function|const|let|var|class)\\s+${n.replace(/\$/g, '\\$')}\\b`).test(all));
    /* The single deliberate deletion: `landedBodyShells` was declared in the legacy script and
       never read or written anywhere in it — dead weight that had no place in any of the new
       modules. Everything else must survive the split verbatim. */
    const DELIBERATELY_REMOVED = ['landedBodyShells'];
    expect(missing.filter(n => !DELIBERATELY_REMOVED.includes(n)), 'declarations lost in the split').toEqual([]);
  });

  test('no module does DOM work at import time except the shared handles', () => {
    const offenders = [];
    (function walk(dir){
      for(const e of fs.readdirSync(dir, { withFileTypes: true })){
        const p = path.join(dir, e.name);
        if(e.isDirectory()){ walk(p); continue; }
        if(!e.name.endsWith('.js')) continue;
        const rel = path.relative(ROOT, p).replace(/\\/g, '/');
        if(rel === 'js/core/dom.js' || rel === 'js/main.js') continue;
        for(const line of fs.readFileSync(p, 'utf8').split('\n')){
          if(/^(document|window)\.(add|get|query)/.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 70)}`);
        }
      }
    })(path.join(ROOT, 'js'));
    // Module-eval-time listeners are what reintroduce ordering bugs; keep the list empty.
    expect(offenders).toEqual([]);
  });
});

test.describe('@parity rendered', () => {
  // Both pages are loaded offline: the legacy one points at unpkg, which we block so the
  // comparison measures CSS only and never depends on the network.
  const SELECTORS = [
    'body', '.app', 'header.top', 'header.top h1', '.eyebrow', '.icon-btn', '.btn',
    '.stage', '.setup-panel', '.panel', '.panel-head h2', '.hint', '.chip', '.chip.active',
    '.wx-field', '.wx-label', '.hud', '.transport', '.speed-chip', '.result-overlay', '.mission-log',
  ];
  const PROPS = [
    'display', 'position', 'color', 'backgroundColor', 'borderColor', 'borderRadius',
    'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'padding', 'margin', 'gap',
    'width', 'height', 'opacity', 'boxShadow', 'textTransform',
  ];

  /* Both pages are compared with their scripts blocked, so this measures the stylesheets and the
     static markup only — no JS-applied classes, no dependence on the legacy page's CDN. */
  async function blockScripts(page){
    await page.route('**unpkg.com/**', r => r.abort());
    await page.route('**/js/main.js', r => r.abort());
    await page.route('**/vendor/three/**', r => r.abort());
  }

  async function snapshot(page, url){
    await blockScripts(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300); // let fonts/vars settle
    return page.evaluate(({ SELECTORS, PROPS }) => {
      const out = {};
      for(const sel of SELECTORS){
        const el = document.querySelector(sel);
        if(!el){ out[sel] = null; continue; }
        const cs = getComputedStyle(el);
        out[sel] = Object.fromEntries(PROPS.map(p => [p, cs[p]]));
      }
      return out;
    }, { SELECTORS, PROPS });
  }

  for(const theme of ['light', 'dark']){
    test(`computed styles match the legacy build (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      const now = await snapshot(page, '/index.html');
      const then = await snapshot(page, '/legacy/rocket-sim.html');
      expect(Object.keys(now).filter(k => now[k] === null), 'selectors missing from the refactor').toEqual(
        Object.keys(then).filter(k => then[k] === null));
      expect(now).toEqual(then);
    });
  }

  test('the DOM tree of the app shell is identical', async ({ page }) => {
    async function shape(url){
      await blockScripts(page);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => {
        // Snapshot structure only — ids, tags, static classes — not text the JS fills in.
        const walk = el => ({
          tag: el.tagName,
          id: el.id || null,
          cls: (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).sort().join(' '),
          kids: [...el.children].map(walk),
        });
        const root = document.querySelector('.app').cloneNode(true);
        return walk(root);
      });
    }
    const now = await shape('/index.html');
    const then = await shape('/legacy/rocket-sim.html');
    expect(now).toEqual(then);
  });
});
