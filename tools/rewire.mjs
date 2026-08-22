#!/usr/bin/env node
/* ============================================================================
   rewire — regenerates the import/export headers across js/**.

   The modules under js/ share a lot of state and helpers, and hand-maintaining the import lists
   after every move is exactly the kind of bookkeeping that goes stale silently (a missing import
   is a ReferenceError that only fires on the code path that needed it). This tool derives them:

     1. strips the existing generated header (leading `import ...` lines) and footer
        (`export { ... };`) from every file under js/,
     2. finds every top-level declaration in each file and builds a name -> owning-file map,
     3. finds every identifier each file actually uses, and writes the imports it needs,
     4. writes each file's export list as the union of what the others import from it.

   Run it after moving a function between modules:  node tools/rewire.mjs
   Run it with --check in CI to fail if the headers are stale:  node tools/rewire.mjs --check

   It is deliberately conservative: it reports duplicate top-level names across modules (which
   would make ownership ambiguous) and unresolved identifiers are simply left alone, so a genuine
   typo still surfaces as a runtime ReferenceError rather than being papered over.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'js');
const CHECK = process.argv.includes('--check');

function listFiles(dir){
  const out = [];
  for(const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))){
    const p = path.join(dir, e.name);
    if(e.isDirectory()) out.push(...listFiles(p));
    else if(e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* Remove comments, string/template literals and regex literals, so identifier scanning only ever
   sees real code. Regex detection uses the previous significant character: a `/` that follows a
   value (identifier, `)`, `]`, number) is division; anything else starts a regex literal. This is
   the case the naive version got wrong — /[&<>"']/g swallowed the rest of the file as a string. */
function stripNoise(src){
  const out = [];
  let i = 0, prev = '';
  const n = src.length;
  const startsRegex = c => c === '' || '(,=:[!&|?{};+-*%~^<>'.includes(c) || /return|typeof|case|in|of|new|delete|void|do|else/.test(c);
  while(i < n){
    const c = src[i];
    if(c === '/' && src[i+1] === '/'){
      while(i < n && src[i] !== '\n') i++;
    } else if(c === '/' && src[i+1] === '*'){
      i += 2;
      while(i + 1 < n && !(src[i] === '*' && src[i+1] === '/')){ if(src[i] === '\n') out.push('\n'); i++; }
      i += 2;
    } else if(c === '/' && startsRegex(prev)){
      i++;                                   // regex literal
      let inClass = false;
      while(i < n){
        if(src[i] === '\\'){ i += 2; continue; }
        if(src[i] === '[') inClass = true;
        else if(src[i] === ']') inClass = false;
        else if(src[i] === '/' && !inClass) break;
        else if(src[i] === '\n') break;      // unterminated - bail rather than eat the file
        i++;
      }
      i++;
      while(i < n && /[gimsuy]/.test(src[i])) i++;
      out.push(' ');
      prev = ')';
      continue;
    } else if(c === '"' || c === "'" || c === '`'){
      const q = c; i++;
      while(i < n && src[i] !== q){
        if(src[i] === '\\'){ i += 2; continue; }
        if(src[i] === '\n' && q !== '`') break;
        if(src[i] === '\n') out.push('\n');
        i++;
      }
      i++;
      out.push(' ');
      prev = ')';
      continue;
    } else {
      out.push(c);
      if(!/\s/.test(c)) prev = c;
      i++;
      continue;
    }
    prev = '';
  }
  return out.join('');
}

const HEADER_LINE = /^import\s.*;\s*$/;
const FOOTER_LINE = /^export\s*\{[^}]*\}\s*;\s*$/;

function stripGeneratedWrapper(src){
  let lines = src.split('\n');
  while(lines.length && (HEADER_LINE.test(lines[0]) || lines[0].trim() === '')) {
    if(lines[0].trim() === '' && !lines.slice(1).some(l => HEADER_LINE.test(l))) break;
    lines.shift();
  }
  while(lines.length && (FOOTER_LINE.test(lines[lines.length-1]) || lines[lines.length-1].trim() === '')) lines.pop();
  return lines.join('\n');
}

const DECL = /^(?:async\s+)?(function|const|let|var|class)\s+(.*)$/;
const NAME = /^([A-Za-z_$][\w$]*)/;

function declaredNames(clean){
  const names = [];
  for(const line of clean.split('\n')){
    const m = DECL.exec(line);
    if(!m) continue;
    const [, kind, rest] = m;
    if(kind === 'function' || kind === 'class'){
      const nm = NAME.exec(rest);
      if(nm) names.push(nm[1]);
      continue;
    }
    let depth = 0, buf = '';
    const parts = [];
    for(const ch of rest){
      if('([{'.includes(ch)) depth++;
      else if(')]}'.includes(ch)) depth--;
      if(ch === ',' && depth === 0){ parts.push(buf); buf = ''; }
      else buf += ch;
    }
    parts.push(buf);
    for(const part of parts){
      const nm = NAME.exec(part.trim());
      if(nm) names.push(nm[1]);
    }
  }
  return names;
}

const files = listFiles(JS);
const body = new Map(), clean = new Map(), owns = new Map();
const ownerOf = new Map();

for(const f of files){
  const b = stripGeneratedWrapper(fs.readFileSync(f, 'utf8'));
  body.set(f, b);
  const c = stripNoise(b);
  clean.set(f, c);
  const names = declaredNames(c);
  owns.set(f, names);
  for(const n of names){
    if(ownerOf.has(n)) console.error(`! duplicate top-level name "${n}" in ${path.relative(ROOT, ownerOf.get(n))} and ${path.relative(ROOT, f)}`);
    ownerOf.set(n, f);
  }
}

const IDENT = /[A-Za-z_$][\w$]*/g;
const needs = new Map(), exportsOf = new Map(files.map(f => [f, new Set()]));

for(const f of files){
  const used = new Set(clean.get(f).match(IDENT) || []);
  const mine = new Set(owns.get(f));
  const imp = new Map();
  for(const u of [...used].sort()){
    if(mine.has(u)) continue;
    const src = ownerOf.get(u);
    if(!src || src === f) continue;
    if(!imp.has(src)) imp.set(src, []);
    imp.get(src).push(u);
    exportsOf.get(src).add(u);
  }
  needs.set(f, imp);
}

const spec = (from, to) => {
  const r = path.relative(path.dirname(from), to).split(path.sep).join('/');
  return r.startsWith('.') ? r : './' + r;
};

let stale = 0;
for(const f of files){
  const lines = [];
  if(/\bTHREE\b/.test(clean.get(f))) lines.push('import * as THREE from "three";');
  const sources = [...needs.get(f).keys()].sort((a, b) => spec(f, a).localeCompare(spec(f, b)));
  for(const s of sources){
    const names = [...new Set(needs.get(f).get(s))].sort();
    lines.push(`import { ${names.join(', ')} } from "${spec(f, s)}";`);
  }
  const header = lines.length ? lines.join('\n') + '\n\n' : '';
  const exported = [...exportsOf.get(f)].sort();
  const footer = exported.length ? `\nexport { ${exported.join(', ')} };\n` : '';
  const next = header + body.get(f).replace(/^\n+/, '').replace(/\n+$/, '') + '\n' + footer;
  const current = fs.readFileSync(f, 'utf8');
  if(next !== current){
    stale++;
    if(CHECK) console.error(`stale header: ${path.relative(ROOT, f)}`);
    else fs.writeFileSync(f, next, 'utf8');
  }
}

if(CHECK){
  if(stale){ console.error(`\n${stale} file(s) have stale import/export headers — run: node tools/rewire.mjs`); process.exit(1); }
  console.log('import/export headers are up to date');
} else {
  console.log(stale ? `rewired ${stale} file(s)` : 'no changes');
}
