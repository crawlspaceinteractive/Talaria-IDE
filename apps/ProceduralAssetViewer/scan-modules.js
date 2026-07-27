#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '../../modules');
const outFile = path.join(__dirname, 'modules.json');

function scan(dir, root) {
  const entries = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { console.error('Cannot read:', dir); return entries; }
  for (const f of items) {
    if (f.name.startsWith('.')) continue;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      entries.push(...scan(full, root));
    } else if (f.name.endsWith('.js')) {
      entries.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  }
  return entries;
}

const modules = scan(target, target).sort();
fs.writeFileSync(outFile, JSON.stringify(modules, null, 2) + '\n');
console.log('Found ' + modules.length + ' modules -> ' + path.relative(process.cwd(), outFile));
