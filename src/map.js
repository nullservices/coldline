/* =====================================================================
   MAP — layered ASCII map compiled to axis-aligned solids.
   Pure JS (no three.js) so tools/mapcheck.js can load it in node.

   Each layer is a grid of the same size; layer k starts at y = k * H.
   The bottom half of the map is the top half rotated 180° so both
   teams get the same base.

   Cell characters (any layer):
     .  empty                      #  concrete block, full layer height
     B  brick block                C  shipping container (2.4 high)
     c  crate (1.2)                l  low barrier (1.0)
     o  square pillar               =  floor slab (layer k > 0 only)
     r  floor slab with railings on every edge that drops off
     w  window: sill to 1.0, header from 2.2 (crouch-jump through)
     a  doorway: header only, from 2.2
     ^ v < >  stairs rising towards the arrow (one full layer per cell)
     L  ladder (stack L in consecutive layers for a taller ladder)
     *  ceiling lamp hung from the layer above (no collision)
     S  team spawn (team by map half)   D  spawn usable in deathmatch
     F  flag / case position
   Anything but '.', '#', 'B' on a layer above ground also lays a slab.
   ===================================================================== */
export const CS = 2.5, H = 2.8, SLAB = 0.25, STEP = 0.4, RAIL_H = 1.05;

const TOP = [[
  '#################################',
  '#S.S.S.S...BL..c....C...........#',
  '#.....F.........................#',
  '#..........B...c...D...C........#',
  '#.>........B....C..........c....#',
  '#BBBB.BBBB.B............l.......#',
  '#..l.......c...vv..l....c....v..#',
  '#....C.....c...........C...######',
  '#.............o........c...######',
  '#...C.......c.........c..cC######',
  '#...D.....l..........C..C..######',
  '#..l.............o...C.....######',
  '#....c....ll.........c..D..######',
  '#.c........>#######<.c.....######',
  '#...l.......#######........######',
], [
  '#################################',
  '#..........BL...................#',
  '#..*....*..B....................#',
  '#..rrrrrr>=w....................#',
  '#..=S===S==w....................#',
  '#wwwwBwwwwBB....................#',
  '#...............................#',
  '#..............rr..........r....#',
  '#..............rr..........r.c..#',
  '#..............rr..........r....#',
  '#..............rr..........r.D..#',
  '#..............rr..........r....#',
  '#..............rr..........r....#',
  '#.............l...l........r....#',
  '#...............c..........r....#',
], [
  '#################################',
  '#==========.....................#',
  '#==========.....................#',
  '#========.=l....................#',
  '#==========l....................#',
  '#lllllllllll....................#',
  '#...............................#',
  '#...............................#',
  '#...............................#',
  '#...............................#',
  '#...............................#',
  '#...............................#',
  '#...............................#',
  '#...............................#',
  '#...............................#',
]];
const FLIP = { '^': 'v', 'v': '^', '<': '>', '>': '<' };
const mirror = (rows) => rows.concat(rows.slice().reverse().map((r) => [...r].reverse().map((c) => FLIP[c] || c).join('')));
export const LAYERS = TOP.map(mirror);
export const MW = LAYERS[0][0].length, MH = LAYERS[0].length, MAXY = LAYERS.length * H;
LAYERS.forEach((L, k) => L.forEach((r, i) => { if (r.length !== MW) throw new Error(`layer ${k} row ${i} has length ${r.length}`); }));

export const cellX = (cx) => (cx - MW / 2 + 0.5) * CS, cellZ = (cz) => (cz - MH / 2 + 0.5) * CS;
export const toCx = (x) => Math.floor(x / CS + MW / 2), toCz = (z) => Math.floor(z / CS + MH / 2);
const DIRS = { '^': [0, -1], 'v': [0, 1], '<': [-1, 0], '>': [1, 0] };
const D4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export const SPAWNS = { 1: [], 2: [], all: [] }, BASE = {};
export const boxes = [];   // render list: { x, y, z, sx, sy, sz, kind } (centre + size)
export const ladders = []; // render list: { x, z, y0, y1, nx, nz } (nx,nz = direction of the wall)
export const lamps = [];   // ceiling lamps: { x, y, z }
const cells = [];          // per cell: { s: [{x0,x1,z0,z1,y0,y1}], stair, ladder, rails: {dir: top} }
for (let i = 0; i < MW * MH; i++) cells.push({ s: [], stair: null, ladder: null, rails: [] });
const at = (cx, cz) => cells[cz * MW + cx];
const chr = (k, cx, cz) => (k < 0 || k >= LAYERS.length || cx < 0 || cz < 0 || cx >= MW || cz >= MH ? '#' : LAYERS[k][cz][cx]);
const FULL = { '#': 'concrete', B: 'brick' };

function solid(cx, cz, x0, x1, z0, z1, y0, y1, kind, render = true) {
  const X = cellX(cx) - CS / 2, Z = cellZ(cz) - CS / 2;
  at(cx, cz).s.push({ x0: X + x0, x1: X + x1, z0: Z + z0, z1: Z + z1, y0, y1 });
  if (render) boxes.push({ x: X + (x0 + x1) / 2, y: (y0 + y1) / 2, z: Z + (z0 + z1) / 2, sx: x1 - x0, sy: y1 - y0, sz: z1 - z0, kind });
}
const deco = (cx, cz, x0, x1, z0, z1, y0, y1, kind) => { const X = cellX(cx) - CS / 2, Z = cellZ(cz) - CS / 2; boxes.push({ x: X + (x0 + x1) / 2, y: (y0 + y1) / 2, z: Z + (z0 + z1) / 2, sx: x1 - x0, sy: y1 - y0, sz: z1 - z0, kind }); };

// pass 1: solids
LAYERS.forEach((L, k) => {
  const y0 = k * H;
  for (let cz = 0; cz < MH; cz++) for (let cx = 0; cx < MW; cx++) {
    const ch = L[cz][cx], team = cz < MH / 2 ? 1 : 2, c = at(cx, cz);
    if (ch === '.') continue;
    if (FULL[ch]) { solid(cx, cz, 0, CS, 0, CS, y0, y0 + H, FULL[ch]); continue; }
    if (k > 0 && ch !== 'L' && ch !== '*' && !FULL[chr(k - 1, cx, cz)]) solid(cx, cz, 0, CS, 0, CS, y0 - SLAB, y0, ch === 'r' ? 'grate' : 'slab');
    const m = CS * 0.5;
    if (ch === 'C') { solid(cx, cz, 0, CS, 0, CS, y0, y0 + 2.4, 'container'); c.tint = 1; }
    else if (ch === 'c') solid(cx, cz, 0.05, CS - 0.05, 0.05, CS - 0.05, y0, y0 + 1.2, 'crate');
    else if (ch === 'l') solid(cx, cz, 0.1, CS - 0.1, 0.1, CS - 0.1, y0, y0 + 1.0, 'barrier');
    else if (ch === 'o') solid(cx, cz, m - 0.25, m + 0.25, m - 0.25, m + 0.25, y0 - (k ? SLAB : 0), y0 + H, 'concrete');
    else if (ch === 'w') {
      solid(cx, cz, 0, CS, 0, CS, y0, y0 + 1.0, 'brick'); solid(cx, cz, 0, CS, 0, CS, y0 + 2.2, y0 + H, 'brick');
      // frame: pick the thin axis from the neighbours that are walls
      const alongX = FULL[chr(k, cx - 1, cz)] || chr(k, cx - 1, cz) === 'w' || FULL[chr(k, cx + 1, cz)] || chr(k, cx + 1, cz) === 'w';
      for (const t of [0.05, CS / 2 - 0.04, CS - 0.13]) alongX ? deco(cx, cz, t, t + 0.08, m - 0.1, m + 0.1, y0 + 1.0, y0 + 2.2, 'metal') : deco(cx, cz, m - 0.1, m + 0.1, t, t + 0.08, y0 + 1.0, y0 + 2.2, 'metal');
    }
    else if (ch === 'a') solid(cx, cz, 0, CS, 0, CS, y0 + 2.2, y0 + H, 'concrete');
    else if (DIRS[ch]) {
      c.stair = { dir: ch, y0 }; const [dx, dz] = DIRS[ch], N = 8;
      for (let i = 0; i < N; i++) { // render-only steps; collision is the smooth ramp in stairH()
        const a = i / N * CS, b = (i + 1) / N * CS, top = y0 + H * (i + 1) / N, bot = y0 - (k ? SLAB : 0);
        if (dx > 0) deco(cx, cz, a, b, 0, CS, bot, top, 'step'); else if (dx < 0) deco(cx, cz, CS - b, CS - a, 0, CS, bot, top, 'step');
        else if (dz > 0) deco(cx, cz, 0, CS, a, b, bot, top, 'step'); else deco(cx, cz, 0, CS, CS - b, CS - a, bot, top, 'step');
      }
    }
    else if (ch === '*') { lamps.push({ x: cellX(cx), y: y0 + H - 0.45, z: cellZ(cz) }); deco(cx, cz, m - 0.35, m + 0.35, m - 0.35, m + 0.35, y0 + H - 0.5, y0 + H - 0.42, 'lamp'); deco(cx, cz, m - 0.03, m + 0.03, m - 0.03, m + 0.03, y0 + H - 0.42, y0 + H, 'metal'); }
    else if (ch === 'L') { if (c.ladder && Math.abs(c.ladder.y1 - y0) < 0.01) c.ladder.y1 = y0 + H; else c.ladder = { y0, y1: y0 + H }; }
    else if (ch === 'S') { const p = { x: cellX(cx), y: y0, z: cellZ(cz) }; SPAWNS[team].push(p); SPAWNS.all.push(p); }
    else if (ch === 'D') SPAWNS.all.push({ x: cellX(cx), y: y0, z: cellZ(cz) });
    else if (ch === 'F') BASE[team] = { x: cellX(cx), y: y0, z: cellZ(cz) };
  }
});

/* ---------- point queries ---------- */
export function stairH(c, x, z) {
  const st = c.stair; if (!st) return -1;
  const [dx, dz] = DIRS[st.dir], cx = toCx(x), cz = toCz(z), lx = x - (cellX(cx) - CS / 2), lz = z - (cellZ(cz) - CS / 2);
  const t = dx > 0 ? lx / CS : dx < 0 ? 1 - lx / CS : dz > 0 ? lz / CS : 1 - lz / CS;
  return st.y0 + H * Math.max(0.02, Math.min(1, t));
}
const cellAt = (x, z) => { const cx = toCx(x), cz = toCz(z); return cx < 0 || cz < 0 || cx >= MW || cz >= MH ? null : cells[cz * MW + cx]; };
export function solidAt(x, y, z) {
  const c = cellAt(x, z); if (!c) return y < MAXY;
  if (y < 0) return true;
  for (const s of c.s) if (y >= s.y0 && y < s.y1 && x >= s.x0 && x < s.x1 && z >= s.z0 && z < s.z1) return true;
  if (c.stair) { const h = stairH(c, x, z); if (y < h && y >= c.stair.y0 - SLAB - 0.01) return true; }
  return false;
}
// highest standable top at (x,z) that is not above feet+step
export function topAt(x, z, feet, step = STEP) {
  const c = cellAt(x, z); if (!c) return 0;
  let g = 0; const lim = feet + step;
  for (const s of c.s) if (s.y1 <= lim && s.y1 > g && x >= s.x0 && x < s.x1 && z >= s.z0 && z < s.z1) g = s.y1;
  if (c.stair) { const h = stairH(c, x, z); if (h <= lim && h > g) g = h; }
  return g;
}
// lowest solid bottom above feet+step at (x,z)
export function ceilAt(x, z, feet, step = STEP) {
  const c = cellAt(x, z); if (!c) return MAXY;
  let m = 1e9; const lim = feet + step;
  for (const s of c.s) if (s.y0 > lim && s.y0 < m && x >= s.x0 && x < s.x1 && z >= s.z0 && z < s.z1) m = s.y0;
  return m;
}
// would a body of radius r, standing at feet with height h, intersect anything?
export function blockedAt(x, z, feet, h, r, step = STEP) {
  const lim = feet + step + 0.01, top = feet + h;
  for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
    const px = x + dx, pz = z + dz, c = cellAt(px, pz); if (!c) return true;
    for (const s of c.s) if (s.y1 > lim && s.y0 < top && px >= s.x0 && px < s.x1 && pz >= s.z0 && pz < s.z1) return true;
    if (c.stair && stairH(c, px, pz) > lim) return true;
  }
  return false;
}
export function groundAt(x, z, feet, r, step = STEP) {
  let g = 0; for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) g = Math.max(g, topAt(x + dx, z + dz, feet, step)); return g;
}
export function ceilingAt(x, z, feet, r, step = STEP) {
  let m = 1e9; for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) m = Math.min(m, ceilAt(x + dx, z + dz, feet, step)); return m;
}
export function ladderAt(x, z) { const c = cellAt(x, z); return c ? c.ladder : null; }
export function rayMap(ox, oy, oz, dx, dy, dz, max, step = 0.12) {
  for (let t = 0.1; t < max; t += step) { const y = oy + dy * t; if (y < 0) return t; if (y < MAXY && solidAt(ox + dx * t, y, oz + dz * t)) return t; }
  return max;
}
export function los(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.hypot(dx, dy, dz);
  return d < 0.5 || rayMap(ax, ay, az, dx / d, dy / d, dz / d, d, 0.3) >= d;
}

/* ---------- walkable surfaces (floors) per cell ---------- */
const covers = (s, cx, cz) => { const x = cellX(cx), z = cellZ(cz); return x >= s.x0 && x < s.x1 && z >= s.z0 && z < s.z1; };
function clear(c, cx, cz, f) { for (const s of c.s) if (covers(s, cx, cz) && s.y0 < f + 1.6 && s.y1 > f + 0.05) return false; return true; }
export const floors = []; // per cell: sorted array of standable heights (stairs: single mid node)
for (let cz = 0; cz < MH; cz++) for (let cx = 0; cx < MW; cx++) {
  const c = at(cx, cz), fs = new Set();
  if (c.stair) { floors.push([c.stair.y0 + H / 2]); continue; }
  const cand = [0]; for (const s of c.s) if (covers(s, cx, cz)) cand.push(s.y1);
  if (c.ladder) cand.push(c.ladder.y0, c.ladder.y1);
  for (const f of cand) if (f < MAXY - 1 && clear(c, cx, cz, f)) fs.add(Math.round(f * 100) / 100);
  if (c.ladder) fs.add(c.ladder.y1);
  floors.push([...fs].sort((a, b) => a - b));
}
const floorNear = (cx, cz, y, tol = 0.5) => { if (cx < 0 || cz < 0 || cx >= MW || cz >= MH) return false; const c = at(cx, cz); if (c.stair) return Math.abs(c.stair.y0 - y) < tol || Math.abs(c.stair.y0 + H - y) < tol; return floors[cz * MW + cx].some((f) => f <= y + 0.05 && f >= y - tol); };

// pass 2: railings on 'r' cells, then ladder render info
LAYERS.forEach((L, k) => {
  const y0 = k * H;
  for (let cz = 0; cz < MH; cz++) for (let cx = 0; cx < MW; cx++) {
    if (L[cz][cx] !== 'r') continue;
    const c = at(cx, cz);
    D4.forEach(([dx, dz], d) => {
      if (floorNear(cx + dx, cz + dz, y0)) return;
      const n = chr(k, cx + dx, cz + dz); if (FULL[n] || n === 'w') return;
      c.rails[d] = y0 + RAIL_H;
      const t = 0.1;
      if (dx > 0) solid(cx, cz, CS - t, CS, 0, CS, y0, y0 + RAIL_H, 'rail', false); else if (dx < 0) solid(cx, cz, 0, t, 0, CS, y0, y0 + RAIL_H, 'rail', false);
      else if (dz > 0) solid(cx, cz, 0, CS, CS - t, CS, y0, y0 + RAIL_H, 'rail', false); else solid(cx, cz, 0, CS, 0, t, y0, y0 + RAIL_H, 'rail', false);
      // render: two bars + posts
      const bar = (y) => dx ? deco(cx, cz, dx > 0 ? CS - 0.08 : 0.02, dx > 0 ? CS - 0.02 : 0.08, 0, CS, y - 0.03, y + 0.03, 'metal') : deco(cx, cz, 0, CS, dz > 0 ? CS - 0.08 : 0.02, dz > 0 ? CS - 0.02 : 0.08, y - 0.03, y + 0.03, 'metal');
      bar(y0 + RAIL_H); bar(y0 + RAIL_H * 0.55);
      for (const p of [0.08, CS / 2, CS - 0.08]) dx ? deco(cx, cz, dx > 0 ? CS - 0.08 : 0.02, dx > 0 ? CS - 0.02 : 0.08, p - 0.03, p + 0.03, y0, y0 + RAIL_H, 'metal') : deco(cx, cz, p - 0.03, p + 0.03, dz > 0 ? CS - 0.08 : 0.02, dz > 0 ? CS - 0.02 : 0.08, y0, y0 + RAIL_H, 'metal');
    });
  }
});
for (let cz = 0; cz < MH; cz++) for (let cx = 0; cx < MW; cx++) {
  const c = at(cx, cz); if (!c.ladder) continue;
  const k = Math.round(c.ladder.y0 / H);
  let best = D4.find(([dx, dz]) => FULL[chr(k, cx + dx, cz + dz)]) || D4.find(([dx, dz]) => at(cx + dx, cz + dz).s.some((s) => s.y1 >= c.ladder.y1 - 0.01)) || [0, -1];
  const [nx, nz] = best; c.ladder.nx = nx; c.ladder.nz = nz;
  ladders.push({ x: cellX(cx), z: cellZ(cz), y0: c.ladder.y0, y1: c.ladder.y1, nx, nz });
  const m = CS / 2, off = 0.35, { y0, y1 } = c.ladder;
  const px = m + nx * (m - off), pz = m + nz * (m - off);
  for (const s of [-0.3, 0.3]) nx ? deco(cx, cz, px - 0.03, px + 0.03, pz + s - 0.03, pz + s + 0.03, y0, y1 + 0.9, 'metal') : deco(cx, cz, px + s - 0.03, px + s + 0.03, pz - 0.03, pz + 0.03, y0, y1 + 0.9, 'metal');
  for (let y = y0 + 0.3; y < y1 + 0.3; y += 0.3) nx ? deco(cx, cz, px - 0.02, px + 0.02, pz - 0.3, pz + 0.3, y - 0.02, y + 0.02, 'metal') : deco(cx, cz, px - 0.3, px + 0.3, pz - 0.02, pz + 0.02, y - 0.02, y + 0.02, 'metal');
}

/* ---------- bot navigation ---------- */
const NODE = 4; // max floors per cell
const nid = (ci, fi) => ci * NODE + fi;
function nearestFloor(ci, y) { const fs = floors[ci]; let b = -1, bd = 1e9; fs.forEach((f, i) => { const d = Math.abs(f - y); if (d < bd) { bd = d; b = i; } }); return b; }
function edges(ci) {
  const cx = ci % MW, cz = (ci / MW) | 0, c = cells[ci], out = [];
  const link = (nx, nz, from, up, down, rails) => {
    if (nx < 0 || nz < 0 || nx >= MW || nz >= MH) return;
    const ni = nz * MW + nx, n = cells[ni];
    if (n.stair) { // enter a stair only from its ends
      const [sdx, sdz] = DIRS[n.stair.dir], lo = Math.abs(n.stair.y0 - from) < 0.5, hi = Math.abs(n.stair.y0 + H - from) < 0.5;
      if ((lo && nx - sdx === cx && nz - sdz === cz) || (hi && nx + sdx === cx && nz + sdz === cz)) out.push(nid(ni, 0));
      return;
    }
    floors[ni].forEach((g, gi) => { if (g <= from + up && g >= from - down && !(rails && n.rails[rails] > g + 0.3)) out.push(nid(ni, gi)); });
  };
  if (c.stair) {
    const [dx, dz] = DIRS[c.stair.dir];
    link(cx - dx, cz - dz, c.stair.y0, 0.5, 0.5); link(cx + dx, cz + dz, c.stair.y0 + H, 0.5, 0.5);
    return [[0, out]];
  }
  return floors[ci].map((f, fi) => {
    out.length = 0;
    if (c.ladder) { const o = c.ladder.y0 === f ? c.ladder.y1 : c.ladder.y1 === f ? c.ladder.y0 : null; if (o !== null) { const i = floors[ci].indexOf(o); if (i >= 0) out.push(nid(ci, i)); } }
    D4.forEach(([dx, dz], d) => { if (c.rails[d] > f + 0.3) return; link(cx + dx, cz + dz, f, 1.35, 3.0, (d + 2) % 4); });
    // diagonals only across open, level corners
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ok = (ax, az) => ax >= 0 && az >= 0 && ax < MW && az < MH && !cells[az * MW + ax].stair && floors[az * MW + ax].some((g) => Math.abs(g - f) < 0.3) && !Object.keys(cells[az * MW + ax].rails).length && !Object.keys(c.rails).length;
      if (ok(cx + dx, cz) && ok(cx, cz + dz) && ok(cx + dx, cz + dz)) { const ni = (cz + dz) * MW + cx + dx; floors[ni].forEach((g, gi) => { if (Math.abs(g - f) < 0.3) out.push(nid(ni, gi)); }); }
    }
    return [fi, out.slice()];
  });
}
const ADJ = new Array(MW * MH * NODE).fill(null);
for (let ci = 0; ci < MW * MH; ci++) for (const [fi, out] of edges(ci)) ADJ[nid(ci, fi)] = out;
export const nodeCount = ADJ.filter(Boolean).length;
export function nodeAt(x, y, z) {
  y = +y || 0;
  const cx = Math.max(0, Math.min(MW - 1, toCx(x))), cz = Math.max(0, Math.min(MH - 1, toCz(z))), ci = cz * MW + cx;
  const fi = cells[ci].stair ? 0 : nearestFloor(ci, y); return fi < 0 ? -1 : nid(ci, fi);
}
const nodePos = (n) => { const ci = (n / NODE) | 0, fi = n % NODE, c = cells[ci]; return { x: cellX(ci % MW), y: c.stair ? c.stair.y0 + H / 2 : floors[ci][fi], z: cellZ((ci / MW) | 0), stair: !!c.stair }; };
const prev = new Int32Array(ADJ.length);
export function findPath(x, y, z, gx, gy, gz) {
  const s = nodeAt(x, y, z), g = nodeAt(gx, gy, gz);
  if (s < 0 || g < 0 || !ADJ[g]) return null;
  prev.fill(-2); prev[s] = -1; const q = [s];
  for (let i = 0; i < q.length; i++) {
    const c = q[i]; if (c === g) break;
    for (const n of ADJ[c]) if (prev[n] === -2) { prev[n] = c; q.push(n); }
  }
  if (prev[g] === -2) return null;
  const path = []; for (let c = g; c !== s && c >= 0; c = prev[c]) path.push(nodePos(c));
  return path.reverse();
}
export function reachable(x, y, z) { // node count reachable from a point (for mapcheck)
  const s = nodeAt(x, y, z); const seen = new Set([s]), q = [s];
  for (let i = 0; i < q.length; i++) for (const n of ADJ[q[i]] || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}
export const cellsRO = cells;
