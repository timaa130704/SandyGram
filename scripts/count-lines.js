// Подсчёт строк и файлов по всему проекту (без node_modules/.git/сборок/генераций).
const fs = require('fs');
const path = require('path');

function walk(dir) {
  let lines = 0, files = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|\.git|bin|obj|build|dist|publish|release|\.expo|app[\\/]android/.test(p)) continue;
      const r = walk(p);
      lines += r.lines;
      files += r.files;
    } else if (/\.(js|mjs|jsx|ts|tsx|css|html|json|cs|xaml|csproj|md|txt|rules|properties|ps1)$/i.test(e.name)) {
      try {
        const c = fs.readFileSync(p, 'utf8').split(/\r?\n/).length - 1;
        lines += c;
        files += 1;
      } catch (_) {}
    }
  }
  return { lines, files };
}

const r = walk('.');
console.log('ФАЙЛОВ: ' + r.files + '   СТРОК: ' + r.lines);