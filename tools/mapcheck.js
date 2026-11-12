// node tools/mapcheck.js [mapId] — validates maps: layer sizes, spawn/base reachability, bot nav coverage, ray casts.
import { compile } from '../src/map.js';
import { MAPS } from '../src/maps/index.js';

const only = process.argv[2];
let bad = 0;
for (const def of MAPS) {
  if (only && def.id !== only) continue;
  const M = compile(def);
  const { MW, MH, LAYERS, SPAWNS, BASE, floors } = M;
  console.log(`\n=== ${def.name} (${def.id}) ===`);
  console.log(`map ${MW}x${MH} cells, ${LAYERS.length} layers, ${M.boxes.length} render boxes, ${M.ladders.length} ladders, ${M.nodeCount} nav nodes`);
  console.log(`spawns: red ${SPAWNS[1].length}, blue ${SPAWNS[2].length}, dm ${SPAWNS.all.length}; bases`, BASE);

  // overview: highest standable floor per cell, as a digit (floor / 1.4)
  const sym = (f) => f === null ? '#' : f === 0 ? '.' : String.fromCharCode(48 + Math.min(9, Math.round(f / 1.4)));
  console.log('highest walkable surface per cell (. ground, 2 = 2.8m, 4 = 5.6m, # none):');
  for (let z = 0; z < MH; z++) { let s = ''; for (let x = 0; x < MW; x++) { const fs = floors[z * MW + x]; s += sym(fs.length ? fs[fs.length - 1] : null); } console.log(s); }

  const pts = [];
  for (const p of SPAWNS[1]) pts.push(['red spawn', p]);
  for (const p of SPAWNS[2]) pts.push(['blue spawn', p]);
  for (const p of SPAWNS.all) pts.push(['dm spawn', p]);
  pts.push(['base 1', BASE[1]], ['base 2', BASE[2]]);
  if (SPAWNS[1].length < 2 || SPAWNS[2].length < 2 || SPAWNS.all.length < 6) { bad++; console.log('TOO FEW SPAWNS'); }
  const seen = M.reachable(BASE[1].x, BASE[1].y, BASE[1].z);
  for (const [name, p] of pts) {
    const n = M.nodeAt(p.x, p.y, p.z);
    if (!seen.has(n)) { bad++; console.log(`UNREACHABLE from base 1: ${name} at ${p.x},${p.y},${p.z}`); }
    const path = M.findPath(p.x, p.y, p.z, BASE[2].x, BASE[2].y, BASE[2].z);
    if (!path) { bad++; console.log(`NO PATH to base 2 from ${name} at ${p.x},${p.y},${p.z}`); }
    if (M.blockedAt(p.x, p.z, p.y, 1.75, 0.32)) { bad++; console.log(`SPAWN INSIDE GEOMETRY: ${name} at ${p.x},${p.y},${p.z}`); }
  }
  console.log(`nav nodes reachable from base 1: ${seen.size} / ${M.nodeCount}`);
  const p = M.findPath(BASE[1].x, BASE[1].y, BASE[1].z, BASE[2].x, BASE[2].y, BASE[2].z);
  console.log(`base-to-base path: ${p ? p.length + ' steps, max height ' + Math.max(...p.map((n) => n.y)).toFixed(1) : 'NONE'}`);
  const isl = [];
  for (let ci = 0; ci < MW * MH; ci++) floors[ci].forEach((f, fi) => { if (!seen.has(ci * M.NODE + fi)) isl.push(`(${ci % MW},${(ci / MW) | 0}) y=${f}`); });
  if (isl.length) console.log(`${isl.length} nav nodes not reachable from base 1, e.g.: ${isl.slice(0, 12).join('  ')}`);

  // ray cast self-check: the exact cast must never report a hit farther than a fine-sampled march finds
  let rayBad = 0, rnd = 1;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
  for (let i = 0; i < 4000; i++) {
    const ox = (rand() - 0.5) * MW * M.CS, oz = (rand() - 0.5) * MH * M.CS, oy = rand() * (M.MAXY - 0.5) + 0.3;
    if (M.solidAt(ox, oy, oz)) continue;
    const a = rand() * Math.PI * 2, e = (rand() - 0.5) * 2.4, dx = Math.cos(a) * Math.cos(e), dy = Math.sin(e), dz = Math.sin(a) * Math.cos(e);
    const t = M.rayMap(ox, oy, oz, dx, dy, dz, 60);
    let s = 60; for (let q = 0.02; q < 60; q += 0.02) { const y = oy + dy * q; if (y < 0 || (y < M.MAXY && M.solidAt(ox + dx * q, y, oz + dz * q))) { s = q; break; } }
    if (t > s + 0.05) { rayBad++; if (rayBad <= 3) console.log(`RAY MISS: from ${ox.toFixed(1)},${oy.toFixed(1)},${oz.toFixed(1)} dir ${dx.toFixed(2)},${dy.toFixed(2)},${dz.toFixed(2)} exact ${t.toFixed(2)} sampled ${s.toFixed(2)}`); }
  }
  if (rayBad) { bad++; console.log(`RAY CHECK: ${rayBad} rays passed through solids`); } else console.log('ray check OK');
}
console.log(bad ? `\nFAIL: ${bad} problems` : '\nOK');
process.exit(bad ? 1 : 0);
