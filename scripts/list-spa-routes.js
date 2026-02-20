const fs = require('fs');
const path = require('path');
const spaRoot = path.join(process.cwd(), 'packages', 'spa', 'src');
function collectFiles(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(full, out);
    else if (ent.isFile() && /\.(ts|tsx|js)$/.test(ent.name)) out.push(full);
  }
}
const files = [];
try { collectFiles(spaRoot, files); } catch (e) { console.error('spaRoot not found', spaRoot); process.exit(1); }
const re = /apiClient\.(get|post|put|patch|delete)(?:<[^>]+>)?\s*\(\s*([`\"'][^`\"']*[`\"'])/g;
const routes = new Set();
for (const f of files) {
  try {
    const c = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(c))) {
      const method = m[1].toUpperCase();
      const raw = m[2].replace(/^['"`]|['"`]$/g, '').replace(/\$\{[^}]+\}/g, ':param');
      if (!/^https?:\/\//.test(raw)) routes.add(`${method} ${raw}`);
    }
  } catch (e) {}
}
const arr = Array.from(routes).sort();
console.log('Found', arr.length, 'routes');
arr.forEach(r => console.log(r));
