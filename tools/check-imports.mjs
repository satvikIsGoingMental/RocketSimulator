#!/usr/bin/env node
/* ============================================================================
   check-imports — fails if any module assigns to a name it imported.

   ES module import bindings are read-only at the import site: `flightActive = false` in a module
   that imported `flightActive` throws "Assignment to constant variable" at runtime, and only on
   the code path that reaches it. That is the single most likely way this refactor can regress, so
   it gets its own check rather than relying on a test happening to walk that path.

   The fix for a hit is always the same: add a setter next to the declaration in the owning module
   (`function setFoo(v){ foo = v; }`) and call that instead.

   Usage: node tools/check-imports.mjs
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'js');

const files = [];
(function walk(dir){
  for(const e of fs.readdirSync(dir, { withFileTypes: true })){
    const p = path.join(dir, e.name);
    if(e.isDirectory()) walk(p);
    else if(e.name.endsWith('.js')) files.push(p);
  }
})(JS);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hits = [];

for(const file of files){
  const src = fs.readFileSync(file, 'utf8');
  const imported = new Set();
  for(const m of src.matchAll(/^import \{([^}]*)\} from/gm)){
    for(const n of m[1].split(',')) imported.add(n.trim());
  }
  if(!imported.size) continue;

  src.split('\n').forEach((line, i) => {
    if(/^\s*(import|export)\s/.test(line)) return;
    const code = line.replace(/\/\/.*$/, '');
    for(const name of imported){
      const re = new RegExp(`(^|[^.\\w$])${esc(name)}\\s*(=(?!=)|\\+\\+|--|\\+=|-=|\\*=|/=)`);
      if(re.test(code)) hits.push(`${path.relative(ROOT, file)}:${i + 1}  assigns imported "${name}"\n    ${line.trim().slice(0, 100)}`);
    }
  });
}

if(hits.length){
  console.error('Assignment to an imported binding (this throws at runtime):\n');
  for(const h of hits) console.error('  ' + h + '\n');
  console.error(`${hits.length} problem(s). Add a setter in the owning module and call that instead.`);
  process.exit(1);
}
console.log('no module assigns to an imported binding');
