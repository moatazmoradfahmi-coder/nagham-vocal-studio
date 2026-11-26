/**
 * Build a single portable self-contained HTML file in dist/nagham-studio-standalone.html
 * with CSS, ES modules, and LAME MP3 encoder bundled inline (works 100% offline!).
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const lamejs = fs.readFileSync(path.join(root, 'vendor/lamejs.iife.js'), 'utf8');

const stripImportsExports = (src) =>
  src
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(const|let|var|function|async\s+function|class)\b)/gm, '');

const presetsJs = stripImportsExports(fs.readFileSync(path.join(root, 'js/presets.js'), 'utf8'));
const engineJs = stripImportsExports(fs.readFileSync(path.join(root, 'js/audio-engine.js'), 'utf8'));
const composerJs = stripImportsExports(fs.readFileSync(path.join(root, 'js/auto-composer.js'), 'utf8'));
const visualizersJs = stripImportsExports(fs.readFileSync(path.join(root, 'js/visualizers.js'), 'utf8'));
const appJs = stripImportsExports(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'));

const combinedApp = `(() => {\n"use strict";\n${presetsJs}\n${engineJs}\n${composerJs}\n${visualizersJs}\n${appJs}\n})();`;

// Escape closing script tags if any exist inside code
const safeScript = (code) => code.replace(/<\/script>/gi, '<\\/script>');

let outHtml = html
  .replace('<link rel="stylesheet" href="./styles.css" />', () => `<style>\n${css}\n</style>`)
  .replace(
    '<script src="./vendor/lamejs.iife.js"></script>',
    () => `<script>\n${safeScript(lamejs)}\n</script>`
  )
  .replace(
    '<script type="module" src="./js/app.js"></script>',
    () => `<script>\n${safeScript(combinedApp)}\n</script>`
  );

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const outPath = path.join(root, 'dist/nagham-studio-standalone.html');
fs.writeFileSync(outPath, outHtml, 'utf8');

const sizeKb = (Buffer.byteLength(outHtml, 'utf8') / 1024).toFixed(1);
console.log(`Built standalone file: ${outPath} (${sizeKb} KB)`);
