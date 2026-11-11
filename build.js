import esbuild from 'esbuild';
import fs from 'fs';
const r = esbuild.buildSync({ entryPoints: ['src/game.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync('src/template.html', 'utf8').replace('/*__GAME__*/', () => js);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
fs.writeFileSync('index.html', html);
console.log('built', (html.length / 1024).toFixed(0) + ' KB');
