// node tools/mapcheck.js — validates the map: layer sizes, spawn/base reachability, bot nav coverage.
import * as M from '../src/map.js';

const { MW, MH, LAYERS, SPAWNS, BASE, floors, H } = M;
console.log(`map ${MW}x${MH} cells, ${LAYERS.length} layers, ${M.boxes.length} render boxes, ${M.ladders.length} ladders, ${M.nodeCount} nav nodes`);
console.log(`spawns: red ${SPAWNS[1].length}, blue ${SPAWNS[2].length}, dm ${SPAWNS.all.length}; bases`, BASE);

// overview: highest standable floor per cell, as a digit (floor / 1.4)
const sym = (f) => f === null ? '#' : f === 0 ? '.' : String.fromCharCode(48 + Math.min(9, Math.round(f / 1.4)));
console.log('\nhighest walkable surface per cell (. ground, 2 = 2.8m, 4 = 5.6m, # none):');
for (let z = 0; z < MH; z++) { let s = ''; for (let x = 0; x < MW; x++) { const fs = floors[z * MW + x]; s += sym(fs.length ? fs[fs.length - 1] : null); } console.log(s); }

let bad = 0;
const pts = [];
for (const p of SPAWNS[1]) pts.push(['red spawn', p]);
for (const p of SPAWNS[2]) pts.push(['blue spawn', p]);
for (const p of SPAWNS.all) pts.push(['dm spawn', p]);
pts.push(['base 1', BASE[1]], ['base 2', BASE[2]]);
const seen = M.reachable(BASE[1].x, BASE[1].y, BASE[1].z);
for (const [name, p] of pts) {
  const n = M.nodeAt(p.x, p.y, p.z);
  if (!seen.has(n)) { bad++; console.log(`UNREACHABLE from base 1: ${name} at ${p.x},${p.y},${p.z}`); }
  const path = M.findPath(p.x, p.y, p.z, BASE[2].x, BASE[2].y, BASE[2].z);
  if (!path) { bad++; console.log(`NO PATH to base 2 from ${name} at ${p.x},${p.y},${p.z}`); }
}
console.log(`\nnav nodes reachable from base 1: ${seen.size} / ${M.nodeCount}`);
const p = M.findPath(BASE[1].x, BASE[1].y, BASE[1].z, BASE[2].x, BASE[2].y, BASE[2].z);
console.log(`base-to-base path: ${p ? p.length + ' steps, max height ' + Math.max(...p.map((n) => n.y)).toFixed(1) : 'NONE'}`);
// unreachable islands (nodes not connected to base 1) — list a few
const isl = [];
for (let ci = 0; ci < MW * MH; ci++) floors[ci].forEach((f, fi) => { if (!seen.has(ci * M.NODE + fi)) isl.push(`(${ci % MW},${(ci / MW) | 0}) y=${f}`); });
if (isl.length) console.log(`\n${isl.length} nav nodes not reachable from base 1, e.g.: ${isl.slice(0, 12).join('  ')}`);
console.log(bad ? `\nFAIL: ${bad} problems` : '\nOK');
process.exit(bad ? 1 : 0);
