/* =====================================================================
   MAP — layered ASCII map compiled to axis-aligned solids.
   Pure JS (no three.js) so tools/mapcheck.js can load it in node.

   compile(def) takes a map definition from src/maps/ and returns the
   playable map: solids, point queries, exact ray casts, the bot nav graph.

   Each layer is a grid of the same size; layer k starts at y = k * H.
   Unless def.sym === 'none', the bottom half of the map is the top half
   rotated 180° so both teams get the same base.

   Cell characters (any layer):
     .  empty                      #  wall block, full layer height (kind: def.kinds['#'], default concrete)
     B  second wall kind (brick)   p  third wall kind (plaster)   W  wood block
     g  glass curtain wall, full layer (see and shoot through, blocks movement)
     C  shipping container (2.4)   c  crate (1.2)     h  wall 1.4 (vault over)
     l  low barrier / parapet (1.0) P  planter (0.9)    d  desk (0.75)
     k  market stall: counter (1.0) under a canopy        o  square pillar
     m  floor tile (0.04, kind def.kinds.m, default marble)
     =  floor slab (layer k > 0): carpet on top, ceiling tiles below
     r  deck slab with railings on every edge that drops off (terraces)
     R  roof slab
     w  window: sill to 1.0, header from 2.2 (crouch-jump through)
     a  doorway: header only, from 2.2
     ^ v < >  stairs rising towards the arrow (one full layer per cell)
     L  ladder (stack L in consecutive layers for a taller ladder)
     *  ceiling lamp hung from the layer above (no collision)
     S  team spawn (team by map half)   D  spawn usable in deathmatch
     F  flag / case position
   Anything but '.', a wall block or 'L' on a layer above ground also lays a slab,
   unless the cell below is a wall block.
   def.kinds remaps the material kind of a character, e.g. { '#': 'stone', '=': 'floor2' }.
   ===================================================================== */
export const CS = 2.5, H = 2.8, SLAB = 0.25, STEP = 0.4, RAIL_H = 1.05;
export const NODE = 6; // max floors per cell

const FLIP = { '^': 'v', 'v': '^', '<': '>', '>': '<' };
export const mirror = (rows) => rows.concat(rows.slice().reverse().map((r) => [...r].reverse().map((c) => FLIP[c] || c).join('')));
const DIRS = { '^': [0, -1], 'v': [0, 1], '<': [-1, 0], '>': [1, 0] };
const D4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const DEFAULT_KINDS = { '#': 'concrete', B: 'brick', p: 'plaster', W: 'wood', m: 'marble', c: 'crate', C: 'container', l: 'barrier', h: 'concrete', P: 'planter', d: 'desk', k: 'crate', o: 'concrete', '=': 'floor', r: 'deck', R: 'roof', w: 'brick', a: 'concrete', step: 'step', frame: 'metal', canopy: 'awning' };

export function compile(def) {
  const LAYERS = def.sym === 'none' ? def.layers : def.layers.map(mirror);
  const MW = LAYERS[0][0].length, MH = LAYERS[0].length, MAXY = LAYERS.length * H;
  LAYERS.forEach((L, k) => L.forEach((r, i) => { if (r.length !== MW) throw new Error(`${def.name}: layer ${k} row ${i} has length ${r.length}`); }));
  const KIND = { ...DEFAULT_KINDS, ...(def.kinds || {}) };

  const cellX = (cx) => (cx - MW / 2 + 0.5) * CS, cellZ = (cz) => (cz - MH / 2 + 0.5) * CS;
  const toCx = (x) => Math.floor(x / CS + MW / 2), toCz = (z) => Math.floor(z / CS + MH / 2);

  const SPAWNS = { 1: [], 2: [], all: [] }, BASE = {};
  const boxes = [];   // render list: { x, y, z, sx, sy, sz, kind } (centre + size)
  const ladders = []; // render list: { x, z, y0, y1, nx, nz } (nx,nz = direction of the wall)
  const lamps = [];   // ceiling lamps: { x, y, z }
  const cells = [];   // per cell: { s: [{x0,x1,z0,z1,y0,y1,ghost?,rail?}], stair, ladder, rails: {dir: top} }
  for (let i = 0; i < MW * MH; i++) cells.push({ s: [], stair: null, ladder: null, rails: [] });
  const at = (cx, cz) => cells[cz * MW + cx];
  const chr = (k, cx, cz) => (k < 0 || k >= LAYERS.length || cx < 0 || cz < 0 || cx >= MW || cz >= MH ? '#' : LAYERS[k][cz][cx]);
  const FULL = { '#': 1, B: 1, p: 1, W: 1 };
  const WALLISH = (ch) => FULL[ch] || ch === 'w' || ch === 'g';

  function solid(cx, cz, x0, x1, z0, z1, y0, y1, kind, render = true, extra) {
    const X = cellX(cx) - CS / 2, Z = cellZ(cz) - CS / 2;
    at(cx, cz).s.push({ x0: X + x0, x1: X + x1, z0: Z + z0, z1: Z + z1, y0, y1, ...extra });
    if (render) boxes.push({ x: X + (x0 + x1) / 2, y: (y0 + y1) / 2, z: Z + (z0 + z1) / 2, sx: x1 - x0, sy: y1 - y0, sz: z1 - z0, kind });
  }
  const deco = (cx, cz, x0, x1, z0, z1, y0, y1, kind) => { const X = cellX(cx) - CS / 2, Z = cellZ(cz) - CS / 2; boxes.push({ x: X + (x0 + x1) / 2, y: (y0 + y1) / 2, z: Z + (z0 + z1) / 2, sx: x1 - x0, sy: y1 - y0, sz: z1 - z0, kind }); };

  // pass 1: solids
  LAYERS.forEach((L, k) => {
    const y0 = k * H;
    for (let cz = 0; cz < MH; cz++) for (let cx = 0; cx < MW; cx++) {
      const ch = L[cz][cx], team = cz < MH / 2 ? 1 : 2, c = at(cx, cz);
      if (ch === '.') continue;
      if (FULL[ch]) { solid(cx, cz, 0, CS, 0, CS, y0, y0 + H, KIND[ch]); continue; }
      if (k > 0 && ch !== 'L' && !FULL[chr(k - 1, cx, cz)]) solid(cx, cz, 0, CS, 0, CS, y0 - SLAB, y0, ch === 'r' ? KIND.r : ch === 'R' || ch === 'l' ? KIND.R : KIND['=']);
      const m = CS * 0.5;
      if (ch === 'g') { // curtain wall: a thin pane with a spandrel band above and a sill below; blocks movement but not sight or shots
        c.s.push({ x0: cellX(cx) - CS / 2, x1: cellX(cx) + CS / 2, z0: cellZ(cz) - CS / 2, z1: cellZ(cz) + CS / 2, y0, y1: y0 + H, ghost: true });
        const alongX = WALLISH(chr(k, cx - 1, cz)) || WALLISH(chr(k, cx + 1, cz)), t = 0.06;
        const pane = (a, b, y1, y2, kind) => alongX ? deco(cx, cz, 0, CS, m - a, m + b, y1, y2, kind) : deco(cx, cz, m - a, m + b, 0, CS, y1, y2, kind);
        pane(t, t, y0 + 0.1, y0 + H - 0.35, 'glass'); pane(0.2, 0.2, y0 + H - 0.35, y0 + H, KIND['#']); pane(0.15, 0.15, y0, y0 + 0.1, 'metal');
        for (const q of [0.02, CS / 2 - 0.03, CS - 0.08]) alongX ? deco(cx, cz, q, q + 0.06, m - 0.08, m + 0.08, y0 + 0.1, y0 + H - 0.35, 'metal') : deco(cx, cz, m - 0.08, m + 0.08, q, q + 0.06, y0 + 0.1, y0 + H - 0.35, 'metal');
        continue;
      }
      if (ch === 'C') { solid(cx, cz, 0, CS, 0, CS, y0, y0 + 2.4, KIND.C); c.tint = 1; }
      else if (ch === 'P') solid(cx, cz, 0.2, CS - 0.2, 0.2, CS - 0.2, y0, y0 + 0.9, KIND.P);
      else if (ch === 'd') solid(cx, cz, 0.3, CS - 0.3, 0.55, CS - 0.55, y0 + 0.02, y0 + 0.75, KIND.d);
      else if (ch === 'm') solid(cx, cz, 0, CS, 0, CS, y0, y0 + 0.04, KIND.m);
      else if (ch === 'c') solid(cx, cz, 0.05, CS - 0.05, 0.05, CS - 0.05, y0, y0 + 1.2, KIND.c);
      else if (ch === 'l') solid(cx, cz, 0.1, CS - 0.1, 0.1, CS - 0.1, y0, y0 + 1.0, KIND.l);
      else if (ch === 'h') solid(cx, cz, 0.05, CS - 0.05, 0.05, CS - 0.05, y0, y0 + 1.4, KIND.h);
      else if (ch === 'k') { // market stall: counter under a canopy on four posts
        const alongX = WALLISH(chr(k, cx, cz - 1)) || WALLISH(chr(k, cx, cz + 1)) || chr(k, cx - 1, cz) === 'k' || chr(k, cx + 1, cz) === 'k';
        if (alongX) solid(cx, cz, 0.1, CS - 0.1, m - 0.5, m + 0.5, y0, y0 + 1.0, KIND.k); else solid(cx, cz, m - 0.5, m + 0.5, 0.1, CS - 0.1, y0, y0 + 1.0, KIND.k);
        deco(cx, cz, 0.05, CS - 0.05, 0.05, CS - 0.05, y0 + 2.25, y0 + 2.33, KIND.canopy);
        for (const [px, pz] of [[0.12, 0.12], [CS - 0.12, 0.12], [0.12, CS - 0.12], [CS - 0.12, CS - 0.12]]) deco(cx, cz, px - 0.04, px + 0.04, pz - 0.04, pz + 0.04, y0, y0 + 2.25, 'metal');
      }
      else if (ch === 'o') solid(cx, cz, m - 0.25, m + 0.25, m - 0.25, m + 0.25, y0 - (k ? SLAB : 0), y0 + H, KIND.o);
      else if (ch === 'w') {
        solid(cx, cz, 0, CS, 0, CS, y0, y0 + 1.0, KIND.w); solid(cx, cz, 0, CS, 0, CS, y0 + 2.2, y0 + H, KIND.w);
        // frame: pick the thin axis from the neighbours that are walls
        const alongX = WALLISH(chr(k, cx - 1, cz)) || WALLISH(chr(k, cx + 1, cz));
        for (const t of [0.05, CS / 2 - 0.04, CS - 0.13]) alongX ? deco(cx, cz, t, t + 0.08, m - 0.1, m + 0.1, y0 + 1.0, y0 + 2.2, KIND.frame) : deco(cx, cz, m - 0.1, m + 0.1, t, t + 0.08, y0 + 1.0, y0 + 2.2, KIND.frame);
      }
      else if (ch === 'a') solid(cx, cz, 0, CS, 0, CS, y0 + 2.2, y0 + H, KIND.a);
      else if (DIRS[ch]) {
        c.stair = { dir: ch, y0 }; const [dx, dz] = DIRS[ch], N = 8;
        for (let i = 0; i < N; i++) { // render-only steps; collision is the smooth ramp in stairH()
          const a = i / N * CS, b = (i + 1) / N * CS, top = y0 + H * (i + 1) / N, bot = y0 - (k ? SLAB : 0);
          if (dx > 0) deco(cx, cz, a, b, 0, CS, bot, top, KIND.step); else if (dx < 0) deco(cx, cz, CS - b, CS - a, 0, CS, bot, top, KIND.step);
          else if (dz > 0) deco(cx, cz, 0, CS, a, b, bot, top, KIND.step); else deco(cx, cz, 0, CS, CS - b, CS - a, bot, top, KIND.step);
        }
      }
      else if (ch === '*') { lamps.push({ x: cellX(cx), y: y0 + H - 0.45, z: cellZ(cz) }); deco(cx, cz, m - 0.35, m + 0.35, m - 0.35, m + 0.35, y0 + H - 0.5, y0 + H - 0.42, 'lamp'); deco(cx, cz, m - 0.03, m + 0.03, m - 0.03, m + 0.03, y0 + H - 0.42, y0 + H, 'metal'); }
      else if (ch === 'L') { if (c.ladder && Math.abs(c.ladder.y1 - y0) < 0.01) c.ladder.y1 = y0 + H; else c.ladder = { y0, y1: y0 + H }; }
      else if (ch === 'S') { const p = { x: cellX(cx), y: y0, z: cellZ(cz) }; SPAWNS[team].push(p); SPAWNS.all.push(p); }
      else if (ch === 'D') SPAWNS.all.push({ x: cellX(cx), y: y0, z: cellZ(cz) });
      else if (ch === 'F') BASE[team] = { x: cellX(cx), y: y0, z: cellZ(cz) };
    }
  });
  if (!BASE[1] || !BASE[2]) throw new Error(`${def.name}: both halves need an F cell`);

  /* ---------- point queries ---------- */
  function stairH(c, x, z) {
    const st = c.stair; if (!st) return -1;
    const [dx, dz] = DIRS[st.dir], cx = toCx(x), cz = toCz(z), lx = x - (cellX(cx) - CS / 2), lz = z - (cellZ(cz) - CS / 2);
    const t = dx > 0 ? lx / CS : dx < 0 ? 1 - lx / CS : dz > 0 ? lz / CS : 1 - lz / CS;
    return st.y0 + H * Math.max(0.02, Math.min(1, t));
  }
  const cellAt = (x, z) => { const cx = toCx(x), cz = toCz(z); return cx < 0 || cz < 0 || cx >= MW || cz >= MH ? null : cells[cz * MW + cx]; };
  function solidAt(x, y, z) {
    const c = cellAt(x, z); if (!c) return y < MAXY;
    if (y < 0) return true;
    for (const s of c.s) if (!s.ghost && !s.rail && y >= s.y0 && y < s.y1 && x >= s.x0 && x < s.x1 && z >= s.z0 && z < s.z1) return true;
    if (c.stair) { const h = stairH(c, x, z); if (y < h && y >= c.stair.y0 - SLAB - 0.01) return true; }
    return false;
  }
  // highest standable top at (x,z) that is not above feet+step
  function topAt(x, z, feet, step = STEP) {
    const c = cellAt(x, z); if (!c) return 0;
    let g = 0; const lim = feet + step;
    for (const s of c.s) if (s.y1 <= lim && s.y1 > g && x >= s.x0 && x < s.x1 && z >= s.z0 && z < s.z1) g = s.y1;
    if (c.stair) { const h = stairH(c, x, z); if (h <= lim && h > g) g = h; }
    return g;
  }
  // lowest solid bottom above feet+step at (x,z)
  function ceilAt(x, z, feet, step = STEP) {
    const c = cellAt(x, z); if (!c) return MAXY;
    let m = 1e9; const lim = feet + step;
    for (const s of c.s) if (s.y0 > lim && s.y0 < m && x >= s.x0 && x < s.x1 && z >= s.z0 && z < s.z1) m = s.y0;
    return m;
  }
  // would a body of radius r, standing at feet with height h, intersect anything?
  function blockedAt(x, z, feet, h, r, step = STEP) {
    const lim = feet + step + 0.01, top = feet + h;
    for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
      const px = x + dx, pz = z + dz, c = cellAt(px, pz); if (!c) return true;
      for (const s of c.s) if (s.y1 > lim && s.y0 < top && px >= s.x0 && px < s.x1 && pz >= s.z0 && pz < s.z1) return true;
      if (c.stair && stairH(c, px, pz) > lim) return true;
    }
    return false;
  }
  function groundAt(x, z, feet, r, step = STEP) {
    let g = 0; for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) g = Math.max(g, topAt(x + dx, z + dz, feet, step)); return g;
  }
  function ceilingAt(x, z, feet, r, step = STEP) {
    let m = 1e9; for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) m = Math.min(m, ceilAt(x + dx, z + dz, feet, step)); return m;
  }
  const ladderAt = (x, z) => { const c = cellAt(x, z); return c ? c.ladder : null; };

  /* ---------- exact ray cast ----------
     Walks the cell grid along the ray and intersects every solid box and stair ramp
     analytically, so thin slabs and pillars are never skipped. Glass and railings
     do not stop rays. Returns the distance of the first hit or `max`. */
  function rayBox(s, ox, oy, oz, dx, dy, dz) {
    let t0 = -Infinity, t1 = Infinity;
    const ax = [s.x0, s.y0, s.z0], bx = [s.x1, s.y1, s.z1], o = [ox, oy, oz], d = [dx, dy, dz];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < ax[i] || o[i] >= bx[i]) return Infinity; continue; }
      let a = (ax[i] - o[i]) / d[i], b = (bx[i] - o[i]) / d[i]; if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity;
    }
    return t1 < 0 ? Infinity : Math.max(0, t0);
  }
  function rayStair(c, cx, cz, ox, oy, oz, dx, dy, dz, ta, tb) {
    const st = c.stair, [sdx, sdz] = DIRS[st.dir], X0 = cellX(cx) - CS / 2, Z0 = cellZ(cz) - CS / 2;
    const yl = st.y0 - SLAB, yh = st.y0 + H;
    if (Math.abs(dy) > 1e-9) { // clip the cell interval to the ramp's height range
      let a = (yl - oy) / dy, b = (yh - oy) / dy; if (a > b) [a, b] = [b, a];
      if (a > ta) ta = a; if (b < tb) tb = b;
    } else if (oy < yl || oy >= yh) return Infinity;
    if (ta >= tb) return Infinity;
    // f(t) = y(t) - ramp height, linear in t; the ramp is solid where f < 0
    let A, B;
    if (sdx > 0) { A = oy - st.y0 - H * (ox - X0) / CS; B = dy - H * dx / CS; }
    else if (sdx < 0) { A = oy - st.y0 - H * (X0 + CS - ox) / CS; B = dy + H * dx / CS; }
    else if (sdz > 0) { A = oy - st.y0 - H * (oz - Z0) / CS; B = dy - H * dz / CS; }
    else { A = oy - st.y0 - H * (Z0 + CS - oz) / CS; B = dy + H * dz / CS; }
    const fa = A + B * ta, fb = A + B * tb;
    if (fa < 0) return Math.max(0, ta);
    if (fb < 0) return ta + (tb - ta) * (fa / (fa - fb));
    return Infinity;
  }
  function rayMap(ox, oy, oz, dx, dy, dz, max) {
    let best = max;
    if (dy < 0) { const t = -oy / dy; if (t < best) best = t; } // ground plane
    let cx = toCx(ox), cz = toCz(oz);
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    let tx = sx ? ((cx + (sx > 0 ? 1 : 0) - MW / 2) * CS - ox) / dx : Infinity, tz = sz ? ((cz + (sz > 0 ? 1 : 0) - MH / 2) * CS - oz) / dz : Infinity;
    const ddx = sx ? CS / Math.abs(dx) : Infinity, ddz = sz ? CS / Math.abs(dz) : Infinity;
    let t0 = 0;
    for (let guard = 0; guard < 400 && t0 < best; guard++) {
      const t1 = Math.min(tx, tz, best);
      if (cx < 0 || cz < 0 || cx >= MW || cz >= MH) { // outside the grid: solid below the map top
        const ya = oy + dy * t0;
        if (ya < MAXY) { if (t0 < best) best = t0; }
        else if (dy < 0) { const t = (MAXY - oy) / dy; if (t < t1 && t < best) best = t; }
      } else {
        const c = cells[cz * MW + cx];
        for (const s of c.s) { if (s.ghost || s.rail) continue; const t = rayBox(s, ox, oy, oz, dx, dy, dz); if (t < best && t <= t1 + 1e-6) best = t; }
        if (c.stair) { const t = rayStair(c, cx, cz, ox, oy, oz, dx, dy, dz, t0, t1); if (t < best) best = t; }
      }
      if (t1 >= best) break;
      if (tx < tz) { cx += sx; tx += ddx; } else { cz += sz; tz += ddz; }
      t0 = t1;
    }
    return best;
  }
  function los(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.hypot(dx, dy, dz);
    return d < 0.5 || rayMap(ax, ay, az, dx / d, dy / d, dz / d, d) >= d - 0.01;
  }

  /* ---------- walkable surfaces (floors) per cell ---------- */
  const covers = (s, cx, cz) => { const x = cellX(cx), z = cellZ(cz); return x >= s.x0 && x < s.x1 && z >= s.z0 && z < s.z1; };
  function clear(c, cx, cz, f) { for (const s of c.s) if (covers(s, cx, cz) && s.y0 < f + 1.6 && s.y1 > f + 0.05) return false; return true; }
  const floors = [];   // per cell: sorted array of standable heights; a stair cell's last entry is the stair itself (mid height)
  const stairIdx = []; // per cell: index of the stair node in floors, or -1
  for (let cz = 0; cz < MH; cz++) for (let cx = 0; cx < MW; cx++) {
    const c = at(cx, cz), fs = [];
    const lim = c.stair ? c.stair.y0 - SLAB - 0.1 : MAXY - 1; // under an upper-floor stair the lower floors stay walkable
    const cand = [0]; for (const s of c.s) if (covers(s, cx, cz)) cand.push(s.y1);
    if (c.ladder) cand.push(c.ladder.y0, c.ladder.y1);
    for (const f of cand.sort((a, b) => a - b)) if (f < lim && clear(c, cx, cz, f) && !fs.some((g) => Math.abs(g - f) < 0.2)) fs.push(Math.round(f * 100) / 100);
    if (c.ladder && !fs.includes(c.ladder.y1)) fs.push(c.ladder.y1);
    if (c.stair) fs.push(c.stair.y0 + H / 2);
    stairIdx.push(c.stair ? fs.length - 1 : -1);
    if (fs.length > NODE) throw new Error(`${def.name}: cell ${cx},${cz} has ${fs.length} floors`);
    floors.push(fs);
  }
  const floorNear = (cx, cz, y, tol = 0.5) => {
    if (cx < 0 || cz < 0 || cx >= MW || cz >= MH) return false;
    const c = at(cx, cz), ci = cz * MW + cx;
    if (c.stair && (Math.abs(c.stair.y0 - y) < tol || Math.abs(c.stair.y0 + H - y) < tol)) return true;
    return floors[ci].some((f, i) => i !== stairIdx[ci] && f <= y + 0.05 && f >= y - tol);
  };

  // pass 2: railings on 'r' cells, then ladder render info
  LAYERS.forEach((L, k) => {
    const y0 = k * H;
    for (let cz = 0; cz < MH; cz++) for (let cx = 0; cx < MW; cx++) {
      if (L[cz][cx] !== 'r') continue;
      const c = at(cx, cz);
      D4.forEach(([dx, dz], d) => {
        if (floorNear(cx + dx, cz + dz, y0)) return;
        if (WALLISH(chr(k, cx + dx, cz + dz))) return;
        c.rails[d] = y0 + RAIL_H;
        const t = 0.1, rail = { rail: true };
        if (dx > 0) solid(cx, cz, CS - t, CS, 0, CS, y0, y0 + RAIL_H, 'rail', false, rail); else if (dx < 0) solid(cx, cz, 0, t, 0, CS, y0, y0 + RAIL_H, 'rail', false, rail);
        else if (dz > 0) solid(cx, cz, 0, CS, CS - t, CS, y0, y0 + RAIL_H, 'rail', false, rail); else solid(cx, cz, 0, CS, 0, t, y0, y0 + RAIL_H, 'rail', false, rail);
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
    const best = D4.find(([dx, dz]) => WALLISH(chr(k, cx + dx, cz + dz))) || D4.find(([dx, dz]) => cx + dx >= 0 && cz + dz >= 0 && cx + dx < MW && cz + dz < MH && at(cx + dx, cz + dz).s.some((s) => s.y1 >= c.ladder.y1 - 0.01)) || [0, -1];
    const [nx, nz] = best; c.ladder.nx = nx; c.ladder.nz = nz;
    ladders.push({ x: cellX(cx), z: cellZ(cz), y0: c.ladder.y0, y1: c.ladder.y1, nx, nz });
    const m = CS / 2, off = 0.35, { y0, y1 } = c.ladder;
    const px = m + nx * (m - off), pz = m + nz * (m - off);
    for (const s of [-0.3, 0.3]) nx ? deco(cx, cz, px - 0.03, px + 0.03, pz + s - 0.03, pz + s + 0.03, y0, y1 + 0.9, 'metal') : deco(cx, cz, px + s - 0.03, px + s + 0.03, pz - 0.03, pz + 0.03, y0, y1 + 0.9, 'metal');
    for (let y = y0 + 0.3; y < y1 + 0.3; y += 0.3) nx ? deco(cx, cz, px - 0.02, px + 0.02, pz - 0.3, pz + 0.3, y - 0.02, y + 0.02, 'metal') : deco(cx, cz, px - 0.3, px + 0.3, pz - 0.02, pz + 0.02, y - 0.02, y + 0.02, 'metal');
  }

  /* ---------- bot navigation ---------- */
  const nid = (ci, fi) => ci * NODE + fi;
  const railBlocks = (top, f) => top !== undefined && top - RAIL_H < f + 0.5 && top > f + 0.3; // a railing only blocks the floor it stands on
  function nearestFloor(ci, y) { const fs = floors[ci]; let b = -1, bd = 1e9; fs.forEach((f, i) => { if (i === stairIdx[ci]) return; const d = Math.abs(f - y); if (d < bd) { bd = d; b = i; } }); return b; }
  function edges(ci) {
    const cx = ci % MW, cz = (ci / MW) | 0, c = cells[ci], out = [];
    const link = (nx, nz, from, up, down, rails) => {
      if (nx < 0 || nz < 0 || nx >= MW || nz >= MH) return;
      const ni = nz * MW + nx, n = cells[ni], nsi = stairIdx[ni];
      floors[ni].forEach((g, gi) => {
        if (gi === nsi) { // enter a stair only from its ends
          const [sdx, sdz] = DIRS[n.stair.dir], lo = Math.abs(n.stair.y0 - from) < 0.5, hi = Math.abs(n.stair.y0 + H - from) < 0.5;
          if ((lo && nx - sdx === cx && nz - sdz === cz) || (hi && nx + sdx === cx && nz + sdz === cz)) out.push(nid(ni, gi));
          return;
        }
        if (g > from + up || g < from - down || (rails !== undefined && railBlocks(n.rails[rails], g))) return;
        if (g < from - 0.3 && n.s.some((s) => covers(s, nx, nz) && s.y0 < from + 0.1 && s.y1 > g + 0.05)) return; // a drop must not pass through a floor
        out.push(nid(ni, gi));
      });
    };
    return floors[ci].map((f, fi) => {
      out.length = 0;
      if (fi === stairIdx[ci]) {
        const [dx, dz] = DIRS[c.stair.dir];
        link(cx - dx, cz - dz, c.stair.y0, 0.5, 0.5); link(cx + dx, cz + dz, c.stair.y0 + H, 0.5, 0.5);
        return [fi, out.slice()];
      }
      if (c.ladder) { const o = c.ladder.y0 === f ? c.ladder.y1 : c.ladder.y1 === f ? c.ladder.y0 : null; if (o !== null) { const i = floors[ci].indexOf(o); if (i >= 0) out.push(nid(ci, i)); } }
      D4.forEach(([dx, dz], d) => { if (railBlocks(c.rails[d], f)) return; link(cx + dx, cz + dz, f, 1.35, 3.0, (d + 2) % 4); });
      // diagonals only across open, level corners
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ok = (ax, az) => ax >= 0 && az >= 0 && ax < MW && az < MH && floors[az * MW + ax].some((g, gi) => gi !== stairIdx[az * MW + ax] && Math.abs(g - f) < 0.3) && !Object.keys(cells[az * MW + ax].rails).length && !Object.keys(c.rails).length;
        if (ok(cx + dx, cz) && ok(cx, cz + dz) && ok(cx + dx, cz + dz)) { const ni = (cz + dz) * MW + cx + dx; floors[ni].forEach((g, gi) => { if (gi !== stairIdx[ni] && Math.abs(g - f) < 0.3) out.push(nid(ni, gi)); }); }
      }
      return [fi, out.slice()];
    });
  }
  const ADJ = new Array(MW * MH * NODE).fill(null);
  for (let ci = 0; ci < MW * MH; ci++) for (const [fi, out] of edges(ci)) ADJ[nid(ci, fi)] = out;
  const nodeCount = ADJ.filter(Boolean).length;
  function nodeAt(x, y, z) {
    y = +y || 0;
    const cx = Math.max(0, Math.min(MW - 1, toCx(x))), cz = Math.max(0, Math.min(MH - 1, toCz(z))), ci = cz * MW + cx;
    const c = cells[ci], si = stairIdx[ci];
    const fi = si >= 0 && y > c.stair.y0 - 0.5 ? si : nearestFloor(ci, y); return fi < 0 ? -1 : nid(ci, fi);
  }
  const nodePos = (n) => { const ci = (n / NODE) | 0, fi = n % NODE; return { x: cellX(ci % MW), y: floors[ci][fi], z: cellZ((ci / MW) | 0), stair: fi === stairIdx[ci] }; };
  const prev = new Int32Array(ADJ.length);
  function findPath(x, y, z, gx, gy, gz) {
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
  function reachable(x, y, z) { // node count reachable from a point (for mapcheck)
    const s = nodeAt(x, y, z); const seen = new Set([s]), q = [s];
    for (let i = 0; i < q.length; i++) for (const n of ADJ[q[i]] || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    return seen;
  }

  return {
    id: def.id, name: def.name, desc: def.desc, theme: def.theme || {}, LAYERS, MW, MH, MAXY, CS, H, SLAB, STEP, RAIL_H, NODE,
    cellX, cellZ, toCx, toCz, SPAWNS, BASE, boxes, ladders, lamps, stairH, solidAt, topAt, ceilAt, blockedAt, groundAt, ceilingAt, ladderAt,
    rayMap, los, floors, stairIdx, nodeCount, nodeAt, findPath, reachable, cellsRO: cells,
  };
}
