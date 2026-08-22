#!/usr/bin/env node
/* Prints a compact pass/fail summary of test-results/results.json (written by PW_JSON=1 runs). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'test-results', 'results.json');
if(!fs.existsSync(file)){
  console.error('no test-results/results.json — run: npm run test:json');
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(file, 'utf8'));

let passed = 0, failed = 0, skipped = 0;
const failures = [];
(function walk(suite){
  for(const child of suite.suites || []) walk(child);
  for(const spec of suite.specs || []){
    for(const t of spec.tests){
      const last = t.results[t.results.length - 1];
      if(!last) continue;
      if(last.status === 'passed') passed++;
      else if(last.status === 'skipped') skipped++;
      else {
        failed++;
        failures.push(`${spec.title}\n    ${((last.error && last.error.message) || '').split('\n').slice(0, 6).join('\n    ')}`);
      }
    }
  }
})({ suites: report.suites });

for(const f of failures) console.log('FAIL: ' + f + '\n');
console.log(`passed ${passed}  failed ${failed}  skipped ${skipped}`);
process.exit(failed ? 1 : 0);
