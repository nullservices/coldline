import * as THREE from 'three';
import { Peer } from 'peerjs';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* =====================================================================
   COLDLINE — browser team shooter. One player hosts (their browser runs
   the match), everyone else connects peer-to-peer with an invite code.
   ===================================================================== */
const $ = (s) => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const TEST = Q.has('test');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;

/* ------------------------------ map ------------------------------ */
const TOP = [
  '#################################',
  '#S.S.S.#....c.......c.....#.....#',
  '#......#..................#..D..#',
  '#..F........CC....l.............#',
  '#......#..........l.......##.####',
  '#S.S.S.#....c.........c.........#',
  '####.###.........###.......c....#',
  '#...........c....#.#....l.......#',
  '#..D...l.........#......l..CC...#',
  '#......l....##.......#..........#',
  '#..CC.......#....c...#....####.##',
  '#...........#........#..........#',
  '####..####..#..ll....####....D..#',
  '#.........................c.....#',
  '#...c....l.....C...C.......l....#',
];
const ROWS = TOP.concat(TOP.slice().reverse().map((r) => [...r].reverse().join('')));
const MW = 33, MH = ROWS.length, CS = 2.5;
ROWS.forEach((r, i) => { if (r.length !== MW) throw new Error('map row ' + i + ' has length ' + r.length); });
const HGT = { '#': 5, C: 2.4, c: 1.2, l: 1.0 };
const hgt = new Float32Array(MW * MH);
const cellX = (cx) => (cx - MW / 2 + 0.5) * CS, cellZ = (cz) => (cz - MH / 2 + 0.5) * CS;
const toCx = (x) => Math.floor(x / CS + MW / 2), toCz = (z) => Math.floor(z / CS + MH / 2);
const SPAWNS = { 1: [], 2: [], all: [] }, BASE = {};
for (let z = 0; z < MH; z++) for (let x = 0; x < MW; x++) {
  const ch = ROWS[z][x], team = z < MH / 2 ? 1 : 2, p = { x: cellX(x), z: cellZ(z) };
  hgt[z * MW + x] = HGT[ch] || 0;
  if (ch === 'S') { SPAWNS[team].push(p); SPAWNS.all.push(p); }
  if (ch === 'D') SPAWNS.all.push(p);
  if (ch === 'F') BASE[team] = p;
}
function hAt(x, z) { const cx = toCx(x), cz = toCz(z); return cx < 0 || cz < 0 || cx >= MW || cz >= MH ? 99 : hgt[cz * MW + cx]; }
function rayMap(ox, oy, oz, dx, dy, dz, max, step = 0.12) {
  for (let t = 0.1; t < max; t += step) { const y = oy + dy * t; if (y < 0) return t; if (y < 5.2 && hAt(ox + dx * t, oz + dz * t) > y) return t; }
  return max;
}
function los(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.hypot(dx, dy, dz);
  return d < 0.5 || rayMap(ax, ay, az, dx / d, dy / d, dz / d, d, 0.35) >= d;
}
function bfs(sx, sz, gx, gz) {
  if (gx < 0 || gz < 0 || gx >= MW || gz >= MH || hgt[gz * MW + gx] > 0) return null;
  const prev = new Int32Array(MW * MH).fill(-2), s = sz * MW + sx, g = gz * MW + gx, q = [s]; prev[s] = -1;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]; if (c === g) break;
    const cx = c % MW, cz = (c / MW) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz; if (nx < 0 || nz < 0 || nx >= MW || nz >= MH) continue;
      const n = nz * MW + nx; if (prev[n] !== -2 || hgt[n] > 0) continue;
      if (dx && dz && (hgt[cz * MW + nx] > 0 || hgt[nz * MW + cx] > 0)) continue;
      prev[n] = c; q.push(n);
    }
  }
  if (prev[g] === -2) return null;
  const path = []; for (let c = g; c !== s && c >= 0; c = prev[c]) path.push({ x: cellX(c % MW), z: cellZ((c / MW) | 0) });
  return path.reverse();
}

/* ---------------------------- weapons ---------------------------- */
const WPN = [
  { n: 'MK-7 Rifle', s: 'Rifle', dmg: 26, rpm: 620, mag: 30, res: 120, spread: 0.010, auto: true, rel: 2.1, kick: 0.011, len: 0.75, pitch: 1 },
  { n: 'Viper SMG', s: 'SMG', dmg: 17, rpm: 880, mag: 36, res: 144, spread: 0.020, auto: true, rel: 1.8, kick: 0.007, len: 0.5, pitch: 1.4 },
  { n: 'Breacher 12', s: 'Shotgun', dmg: 12, pellets: 9, rpm: 72, mag: 6, res: 30, spread: 0.055, auto: false, rel: 2.6, kick: 0.05, len: 0.8, pitch: 0.6 },
  { n: 'Longbow .308', s: 'Sniper', dmg: 92, rpm: 44, mag: 5, res: 25, spread: 0.05, auto: false, rel: 2.8, kick: 0.06, len: 1.0, pitch: 0.5, scope: true },
  { n: 'P9 Sidearm', s: 'Pistol', dmg: 30, rpm: 380, mag: 12, res: 60, spread: 0.013, auto: false, rel: 1.4, kick: 0.02, len: 0.25, pitch: 1.2 },
];
const CFG = { dm: { limit: 20, time: 600, respawn: 3 }, ctf: { limit: 5, time: 900, respawn: 5 }, inf: { limit: 7, time: 180, respawn: Infinity } };
const MODE_NAME = { dm: 'Deathmatch', ctf: 'Capture the Flag', inf: 'Infiltration' };
const TEAM_NAME = ['', 'Red', 'Blue'], TEAM_COL = ['#d8b45a', '#d1483b', '#3f7fd6'];
const BOT_NAMES = ['Alder', 'Brook', 'Cinder', 'Dax', 'Echo', 'Flint', 'Garnet', 'Hollis', 'Indigo', 'Juno'];

/* =====================================================================
   NETWORK — PeerJS data channels; host is the server
   ===================================================================== */
const PREFIX = 'coldline-v1-';
const Net = { peer: null, isHost: false, conns: new Map(), hostConn: null, code: '' };
function peerOpts() {
  const o = { debug: 0 };
  if (Q.get('peer')) { const [h, p] = Q.get('peer').split(':'); Object.assign(o, { host: h, port: +p, path: '/', secure: false, config: { iceServers: [] } }); }
  return o;
}
const genCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[(Math.random() * 31) | 0]).join('');
function netHost(done, fail, tries = 0) {
  const code = genCode(), peer = new Peer(PREFIX + code, peerOpts());
  peer.on('open', () => { Net.peer = peer; Net.isHost = true; Net.code = code; done(code); });
  peer.on('connection', (conn) => {
    const pid = Host.nextId++; Net.conns.set(pid, conn);
    conn.on('data', (m) => Host.onMsg(pid, m));
    conn.on('close', () => { Net.conns.delete(pid); Host.removePlayer(pid); });
  });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id' && tries < 4) { peer.destroy(); netHost(done, fail, tries + 1); }
    else if (!Net.peer) fail('Could not reach the matchmaking service. Check your connection and try again.');
  });
}
function netJoin(code, done, fail) {
  const peer = new Peer(undefined, peerOpts()); let ok = false;
  const timer = setTimeout(() => { if (!ok) { peer.destroy(); fail('No match found for that code.'); } }, 12000);
  peer.on('open', () => {
    const conn = peer.connect(PREFIX + code, { serialization: 'json' });
    conn.on('open', () => { ok = true; clearTimeout(timer); Net.peer = peer; Net.hostConn = conn; Net.code = code; done(); });
    conn.on('data', (m) => Client.onMsg(m));
    conn.on('close', () => { if (ok) leave('The host ended the match.'); });
  });
  peer.on('error', (e) => { if (!ok) { clearTimeout(timer); fail(e.type === 'peer-unavailable' ? 'No match found for that code.' : 'Connection failed. Try again.'); } });
}
const toHost = (m) => { if (Net.isHost) Host.onMsg(1, m); else if (Net.hostConn && Net.hostConn.open) Net.hostConn.send(m); };

/* =====================================================================
   HOST — authoritative match state, objectives, bots
   ===================================================================== */
const Host = {
  on: false, players: new Map(), mode: 'dm', scores: [0, 0, 0], time: 0, phase: 'live', phaseT: 0, flags: [], seq: 0, snapAcc: 0, last: 0,
  nextId: 2, nextBot: 100, clock: 0, roundAge: 0,
  send(id, m) { if (id === 1) Client.onMsg(m); else { const c = Net.conns.get(id); if (c && c.open) c.send(m); } },
  all(m) { for (const c of Net.conns.values()) if (c.open) c.send(m); Client.onMsg(m); },
  say(text, team = 0) { this.all({ t: 'msg', text, team }); },
  start(mode, bots, name) {
    this.on = true; this.mode = mode; this.players.clear();
    this.addPlayer(1, name, false);
    for (let i = 0; i < bots; i++) this.addPlayer(this.nextBot++, BOT_NAMES[i % BOT_NAMES.length], true);
    this.resetMatch();
    this.last = performance.now();
    try { const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),33)']))); w.onmessage = () => this.tick(); this.timer = w; }
    catch (e) { this.timer = setInterval(() => this.tick(), 33); }
  },
  stop() { this.on = false; if (this.timer) { if (this.timer.terminate) this.timer.terminate(); else clearInterval(this.timer); } },
  roster() { this.all({ t: 'roster', list: [...this.players.values()].map((p) => [p.id, p.name, p.team, p.bot ? 1 : 0]) }); },
  pickTeam() { if (this.mode === 'dm') return 0; let a = 0, b = 0; for (const p of this.players.values()) p.team === 1 ? a++ : b++; return a <= b ? 1 : 2; },
  addPlayer(id, name, bot) {
    const p = { id, name: String(name || 'Player').slice(0, 14), team: this.pickTeam(), bot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, cr: false, hp: 100, alive: false, k: 0, d: 0, w: 0,
      respawnAt: 0, ai: { path: null, pi: 0, goalT: 0, think: Math.random() * 0.25, target: null, react: 0, next: 0, burst: 0 } };
    this.players.set(id, p);
    if (!bot) this.send(id, { t: 'welcome', id, mode: this.mode, code: Net.code });
    this.roster();
    if (this.on) {
      if (this.mode === 'inf' && this.phase === 'live' && this.roundAge > 15) { p.respawnAt = Infinity; this.send(id, { t: 'msg', text: 'You will deploy next round' }); }
      else this.spawn(p);
      this.say(p.name + ' joined');
    }
    return p;
  },
  removePlayer(id) { const p = this.players.get(id); if (!p) return; this.dropFlags(p); this.players.delete(id); this.roster(); this.say(p.name + ' left'); },
  spawn(p) {
    let pts = p.team ? SPAWNS[p.team] : SPAWNS.all, best = pts[(Math.random() * pts.length) | 0];
    if (!p.team) { // deathmatch: prefer points far from everyone else
      let bs = -1;
      for (const s of pts) { let m = 1e9; for (const o of this.players.values()) if (o.alive && o !== p) m = Math.min(m, Math.hypot(o.x - s.x, o.z - s.z)); m += Math.random() * 8; if (m > bs) { bs = m; best = s; } }
    }
    p.x = best.x + (Math.random() - 0.5) * 0.8; p.z = best.z + (Math.random() - 0.5) * 0.8; p.y = 0; p.yaw = Math.atan2(p.x, p.z); p.pitch = 0;
    p.hp = 100; p.alive = true; p.ai.path = null; p.ai.target = null;
    this.all({ t: 'spawn', id: p.id, x: r2(p.x), z: r2(p.z), yaw: r2(p.yaw) });
  },
  setupFlags() {
    const mk = (team, isCase) => ({ team, s: 0, x: BASE[team].x, y: 0, z: BASE[team].z, c: 0, dt: 0, isCase });
    this.flags = this.mode === 'ctf' ? [mk(1), mk(2)] : this.mode === 'inf' ? [mk(1, true)] : [];
  },
  resetMatch() { this.scores = [0, 0, 0]; for (const p of this.players.values()) { p.k = 0; p.d = 0; } this.newRound(); this.say(MODE_NAME[this.mode] + ' — go'); },
  newRound() { this.phase = 'live'; this.time = CFG[this.mode].time; this.roundAge = 0; this.setupFlags(); for (const p of this.players.values()) this.spawn(p); },
  endMatch(text) { this.phase = 'over'; this.phaseT = 10; this.say(text); },
  roundWin(team, why) {
    this.scores[team]++;
    if (this.scores[team] >= CFG.inf.limit) this.endMatch(TEAM_NAME[team] + ' team wins the match');
    else { this.phase = 'roundend'; this.phaseT = 5; this.say(TEAM_NAME[team] + ' wins the round — ' + why, team); }
  },
  dropFlags(p) { for (const f of this.flags) if (f.s === 1 && f.c === p.id) { f.s = 2; f.c = 0; f.x = p.x; f.y = p.y; f.z = p.z; f.dt = 25; this.say((f.isCase ? 'The case' : TEAM_NAME[f.team] + ' flag') + ' was dropped'); } },
  damage(tid, aid, dmg, hs, w) {
    const v = this.players.get(tid), a = this.players.get(aid);
    if (!v || !v.alive || this.phase !== 'live') return;
    if (a && a !== v && a.team && a.team === v.team) return;
    v.hp -= Math.min(300, dmg);
    if (a) this.send(tid, { t: 'hurt', x: r2(a.x), z: r2(a.z) });
    if (v.hp <= 0) this.kill(v, a, w, hs);
  },
  kill(v, a, w, hs) {
    v.alive = false; v.hp = 0; v.d++; if (a && a !== v) a.k++;
    this.dropFlags(v);
    v.respawnAt = this.clock + CFG[this.mode].respawn;
    this.all({ t: 'kill', a: a ? a.id : 0, v: v.id, w, hs: hs ? 1 : 0, rs: CFG[this.mode].respawn });
    if (this.mode === 'dm' && a && a.k >= CFG.dm.limit) this.endMatch(a.name + ' wins the match');
    if (this.mode === 'inf') this.checkElim();
  },
  checkElim() {
    if (this.phase !== 'live') return;
    const n = [0, 0, 0], al = [0, 0, 0];
    for (const p of this.players.values()) { n[p.team]++; if (p.alive) al[p.team]++; }
    if (n[1] && n[2]) { if (!al[1]) this.roundWin(2, 'defenders eliminated'); else if (!al[2]) this.roundWin(1, 'attackers eliminated'); }
    else if (!al[1] && !al[2]) this.newRound();
  },
  onMsg(id, m) {
    const p = this.players.get(id);
    if (m.t === 'join') { if (!p) this.addPlayer(id, m.name, false); return; }
    if (!p) return;
    if (m.t === 'in') { if (p.alive) { p.x = +m.x || 0; p.y = +m.y || 0; p.z = +m.z || 0; p.yaw = +m.yaw || 0; p.pitch = +m.pitch || 0; p.cr = !!m.cr; p.w = m.w | 0; } }
    else if (m.t === 'fire') { if (p.alive) { const msg = { t: 'fire', id, w: m.w | 0, es: m.es }; for (const [cid, c] of Net.conns) if (cid !== id && c.open) c.send(msg); if (id !== 1) Client.onMsg(msg); } }
    else if (m.t === 'hit') { if (p.alive) { const w = WPN[m.w | 0] || WPN[0]; this.damage(m.id, id, w.dmg * clamp(m.n | 0, 1, w.pellets || 1) * (m.hs ? 2 : 1), m.hs, m.w | 0); } }
    else if (m.t === 'team') { if (this.mode !== 'dm') { if (p.alive) this.kill(p, null, 0, 0); p.team = 3 - p.team; this.roster(); this.say(p.name + ' switched to ' + TEAM_NAME[p.team]); } }
  },
  tickFlags(dt) {
    for (const f of this.flags) {
      if (f.s === 1) {
        const c = this.players.get(f.c);
        if (!c || !c.alive) { f.s = 2; f.c = 0; f.dt = 25; continue; }
        f.x = c.x; f.y = c.y; f.z = c.z;
        if (f.isCase) { if (Math.hypot(c.x - BASE[2].x, c.z - BASE[2].z) < 2.2) { this.roundWin(2, 'case extracted'); return; } }
        else {
          const own = this.flags.find((o) => o.team === c.team);
          if (own.s === 0 && Math.hypot(c.x - BASE[c.team].x, c.z - BASE[c.team].z) < 2) {
            this.scores[c.team]++; f.s = 0; f.c = 0; f.x = BASE[f.team].x; f.y = 0; f.z = BASE[f.team].z;
            this.say(c.name + ' captured the ' + TEAM_NAME[f.team] + ' flag', c.team);
            if (this.scores[c.team] >= CFG.ctf.limit) { this.endMatch(TEAM_NAME[c.team] + ' team wins the match'); return; }
          }
        }
        continue;
      }
      if (f.s === 2 && !f.isCase) { f.dt -= dt; if (f.dt <= 0) { f.s = 0; f.x = BASE[f.team].x; f.y = 0; f.z = BASE[f.team].z; this.say(TEAM_NAME[f.team] + ' flag returned'); continue; } }
      for (const p of this.players.values()) {
        if (!p.alive || Math.hypot(p.x - f.x, p.z - f.z) > 1.5 || Math.abs(p.y - f.y) > 2) continue;
        if (p.team !== f.team) { f.s = 1; f.c = p.id; this.say(p.name + (f.isCase ? ' has the case' : ' took the ' + TEAM_NAME[f.team] + ' flag'), p.team); break; }
        else if (f.s === 2 && !f.isCase) { f.s = 0; f.x = BASE[f.team].x; f.y = 0; f.z = BASE[f.team].z; this.say(p.name + ' returned the ' + TEAM_NAME[f.team] + ' flag', p.team); break; }
      }
    }
  },
  botGoal(b) {
    const rnd = () => SPAWNS.all[(Math.random() * SPAWNS.all.length) | 0];
    if (this.mode === 'ctf') {
      const mine = this.flags.find((f) => f.team === b.team), theirs = this.flags.find((f) => f.team !== b.team);
      if (theirs.s === 1 && theirs.c === b.id) return BASE[b.team];
      if (mine.s === 2 && Math.random() < 0.6) return mine;
      if (theirs.s === 1) return Math.random() < 0.5 ? BASE[b.team] : rnd();
      return Math.random() < 0.75 ? theirs : rnd();
    }
    if (this.mode === 'inf') {
      const f = this.flags[0];
      if (b.team === 2) return f.s === 1 && f.c === b.id ? BASE[2] : f.s === 1 ? BASE[2] : f;
      if (f.s !== 0) return f;
      return { x: f.x + (Math.random() - 0.5) * 30, z: f.z + (Math.random() - 0.5) * 30 };
    }
    return rnd();
  },
  tickBot(b, dt) {
    const ai = b.ai;
    ai.think -= dt;
    if (ai.think <= 0) {
      ai.think = 0.25;
      let best = null, bd = 70;
      for (const e of this.players.values()) {
        if (!e.alive || e === b || (b.team && e.team === b.team)) continue;
        const d = Math.hypot(e.x - b.x, e.z - b.z); if (d >= bd) continue;
        let da = Math.atan2(-(e.x - b.x), -(e.z - b.z)) - b.yaw; da = Math.atan2(Math.sin(da), Math.cos(da));
        if (d > 8 && Math.abs(da) > 1.3) continue;
        if (los(b.x, 1.5, b.z, e.x, e.y + (e.cr ? 0.8 : 1.2), e.z)) { best = e; bd = d; }
      }
      if (best !== ai.target) { ai.target = best; ai.react = 0.3 + Math.random() * 0.35; ai.burst = 0; }
      ai.goalT -= 0.25;
      if (!ai.path || ai.pi >= ai.path.length || ai.goalT <= 0) {
        const g = this.botGoal(b);
        ai.path = bfs(clamp(toCx(b.x), 0, MW - 1), clamp(toCz(b.z), 0, MH - 1), toCx(g.x), toCz(g.z)); ai.pi = 0; ai.goalT = 5 + Math.random() * 5;
        if (!ai.path) { const s = SPAWNS.all[(Math.random() * SPAWNS.all.length) | 0]; ai.path = bfs(clamp(toCx(b.x), 0, MW - 1), clamp(toCz(b.z), 0, MH - 1), toCx(s.x), toCz(s.z)) || []; }
      }
    }
    const tgt = ai.target && ai.target.alive ? ai.target : null;
    let mvYaw = b.yaw;
    if (ai.path && ai.pi < ai.path.length) {
      const wp = ai.path[ai.pi], dx = wp.x - b.x, dz = wp.z - b.z, d = Math.hypot(dx, dz), sp = (tgt ? 2.4 : 4.6) * dt;
      if (d <= Math.max(sp, 0.25)) ai.pi++; else { b.x += dx / d * sp; b.z += dz / d * sp; mvYaw = Math.atan2(-dx, -dz); }
    }
    const want = tgt ? Math.atan2(-(tgt.x - b.x), -(tgt.z - b.z)) : mvYaw;
    let da = want - b.yaw; da = Math.atan2(Math.sin(da), Math.cos(da)); b.yaw += da * Math.min(1, dt * 9);
    b.y = 0; b.cr = false;
    if (tgt) {
      const d = Math.hypot(tgt.x - b.x, tgt.z - b.z), ty = tgt.y + (tgt.cr ? 0.75 : 1.15);
      b.pitch = Math.atan2(ty - 1.5, d);
      ai.react -= dt;
      if (ai.react <= 0 && this.clock >= ai.next) {
        ai.next = this.clock + 0.12; if (++ai.burst >= 4 + ((Math.random() * 3) | 0)) { ai.burst = 0; ai.next = this.clock + 0.45 + Math.random() * 0.6; }
        const hitP = clamp(0.5 - d * 0.006, 0.1, 0.5), hit = Math.random() < hitP;
        const miss = hit ? 0.1 : 0.9, ex = tgt.x + (Math.random() - 0.5) * miss * 2, ey = ty + (Math.random() - 0.5) * miss, ez = tgt.z + (Math.random() - 0.5) * miss * 2;
        this.all({ t: 'fire', id: b.id, w: 0, es: [[r2(ex), r2(ey), r2(ez)]] });
        if (hit) { const hs = Math.random() < 0.07; this.damage(tgt.id, b.id, hs ? 44 : 22, hs, 0); }
      }
    }
  },
  tick() {
    if (!this.on) return;
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000); this.last = now; this.clock += dt;
    if (this.phase === 'over') { this.phaseT -= dt; if (this.phaseT <= 0) this.resetMatch(); }
    else if (this.phase === 'roundend') { this.phaseT -= dt; if (this.phaseT <= 0) this.newRound(); }
    else {
      this.time -= dt; this.roundAge += dt;
      for (const p of this.players.values()) {
        if (p.alive) { if (p.bot) this.tickBot(p, dt); }
        else if (this.clock >= p.respawnAt) this.spawn(p);
      }
      this.tickFlags(dt);
      if (this.time <= 0 && this.phase === 'live') {
        if (this.mode === 'inf') this.roundWin(1, 'time ran out');
        else if (this.mode === 'ctf') this.endMatch(this.scores[1] === this.scores[2] ? 'Draw' : TEAM_NAME[this.scores[1] > this.scores[2] ? 1 : 2] + ' team wins the match');
        else { const top = [...this.players.values()].sort((a, b) => b.k - a.k)[0]; this.endMatch(top.name + ' wins the match'); }
      }
    }
    this.snapAcc += dt;
    if (this.snapAcc >= 0.05) {
      this.snapAcc = 0;
      this.all({ t: 's', q: ++this.seq, ph: this.phase, tm: Math.max(0, Math.ceil(this.time)), sc: this.scores,
        p: [...this.players.values()].map((p) => [p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.pitch), (p.alive ? 1 : 0) | (p.cr ? 2 : 0), Math.max(0, Math.round(p.hp)), p.w, p.k, p.d]),
        f: this.flags.map((f) => [f.s, r2(f.x), r2(f.y), r2(f.z), f.c, f.team, f.isCase ? 1 : 0]) });
    }
  },
};

/* =====================================================================
   RENDERER + WORLD
   ===================================================================== */
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.52;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, 1, 0.05, 1200);
camera.rotation.order = 'YXZ'; scene.add(camera);

// sky + sun + image-based lighting
const sky = new Sky(); sky.scale.setScalar(1000); scene.add(sky);
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(50), THREE.MathUtils.degToRad(215));
Object.assign(sky.material.uniforms.turbidity, { value: 5 }); sky.material.uniforms.rayleigh.value = 1.4;
sky.material.uniforms.mieCoefficient.value = 0.006; sky.material.uniforms.mieDirectionalG.value = 0.82;
sky.material.uniforms.sunPosition.value.copy(sunDir);
{
  const pm = new THREE.PMREMGenerator(renderer), s2 = new THREE.Scene(), sk2 = sky.clone(); s2.add(sk2);
  scene.environment = pm.fromScene(s2, 0, 0.1, 1100).texture; scene.environmentIntensity = 0.3; pm.dispose();
}
scene.fog = new THREE.FogExp2('#9fb2c2', 0.004);
const sun = new THREE.DirectionalLight('#ffe2b8', 2.6);
sun.position.copy(sunDir).multiplyScalar(90); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -62, right: 62, top: 62, bottom: -62, near: 10, far: 200 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, new THREE.HemisphereLight('#bcd4ee', '#5a5246', 0.3));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.4, 1.0); composer.addPass(bloom);
composer.addPass(new OutputPass());
let gfxHigh = true;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

/* ---------- procedural PBR textures ---------- */
function hash2(x, y) { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vn(x, y) { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
const fbm = (x, y) => vn(x, y) * 0.5 + vn(x * 2.1, y * 2.1) * 0.25 + vn(x * 4.3, y * 4.3) * 0.15 + vn(x * 9, y * 9) * 0.1;
// fn(u,v) -> [r,g,b,height]; returns {map, normalMap}
function makeTex(size, fn, strength = 2, repeat = [1, 1]) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size; const cx = cv.getContext('2d'), img = cx.createImageData(size, size);
  const hts = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = fn(x / size, y / size, x, y), i = (y * size + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255; hts[y * size + x] = c[3];
  }
  cx.putImageData(img, 0, 0);
  const nv = document.createElement('canvas'); nv.width = nv.height = size; const nx = nv.getContext('2d'), nimg = nx.createImageData(size, size);
  const H = (x, y) => hts[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength, l = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
    nimg.data[i] = (-dx / l * 0.5 + 0.5) * 255; nimg.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; nimg.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; nimg.data[i + 3] = 255;
  }
  nx.putImageData(nimg, 0, 0);
  const map = new THREE.CanvasTexture(cv), normalMap = new THREE.CanvasTexture(nv);
  for (const t of [map, normalMap]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); t.anisotropy = 8; }
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, normalMap };
}
const shade = (rgb, k) => [rgb[0] * k, rgb[1] * k, rgb[2] * k];
const T = {
  concrete: makeTex(512, (u, v) => {
    const n = fbm(u * 6, v * 6), fine = hash2((u * 512) | 0, (v * 512) | 0), seam = Math.min(Math.abs(((v * 4) % 1) - 0.5), Math.abs(((u * 2) % 1) - 0.5)) > 0.485 ? 0.55 : 1;
    const stain = Math.pow(fbm(u * 2.2 + 9, v * 5), 3) * 0.5, k = (0.62 + n * 0.34 + fine * 0.06 - stain) * seam;
    return [...shade([128, 124, 116], k), n * 0.6 + fine * 0.25 + (seam < 1 ? -1.2 : 0)];
  }, 3, [1, 2]),
  floor: makeTex(1024, (u, v) => {
    const n = fbm(u * 14, v * 14), fine = hash2((u * 1024) | 0, (v * 1024) | 0), crack = 1;
    const gx = (u * 4) % 1, gy = (v * 4) % 1, joint = gx < 0.006 || gy < 0.006 ? 0.6 : 1, oil = Math.pow(fbm(u * 3 + 20, v * 3 + 7), 4) * 0.55;
    const k = (0.5 + n * 0.3 + fine * 0.1 - oil) * crack * joint;
    return [...shade([158, 152, 142], k), n * 0.25 + fine * 0.3 + (crack < 1 || joint < 1 ? -1.5 : 0)];
  }, 1.6, [MW / 4, MH / 4]),
  crate: makeTex(256, (u, v) => {
    const b = 0.09, edge = u < b || v < b || u > 1 - b || v > 1 - b, plank = ((u * 5) % 1) < 0.05, diag = Math.abs(u - v) < 0.05 && !edge;
    const grain = fbm(u * 3, v * 40) * 0.35 + fbm(u * 30, v * 30) * 0.1, k = 0.6 + grain - (plank && !edge ? 0.3 : 0) + (edge || diag ? 0.08 : 0);
    return [...shade(edge || diag ? [150, 112, 66] : [176, 134, 80], k), (edge || diag ? 1 : 0.4) + grain * 0.5 - (plank ? 0.6 : 0)];
  }, 4),
  container: makeTex(256, (u, v) => {
    const rib = Math.sin(u * Math.PI * 2 * 12), rust = Math.pow(fbm(u * 5, v * 8 + 4), 3.2), band = v < 0.06 || v > 0.94;
    const k = 0.78 + rib * 0.1 - rust * 0.25, c = rust > 0.25 ? [150, 92, 60] : [255, 255, 255];
    return [...shade(c, band ? k * 0.8 : k), band ? 1.2 : rib * 0.6 - rust * 0.3];
  }, 3.5),
  barrier: makeTex(256, (u, v) => {
    const n = fbm(u * 8, v * 8), stripe = v < 0.22 && ((u * 6 + v * 1.4) % 1) < 0.5, top = v < 0.22;
    const c = top ? (stripe ? [226, 176, 40] : [38, 36, 34]) : [176, 172, 164];
    return [...shade(c, 0.7 + n * 0.3), n * 0.5 + (Math.abs(v - 0.22) < 0.012 ? -1 : 0)];
  }, 2.5),
};
const mat = (t, o = {}) => new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughness: 0.9, metalness: 0, ...o });

/* ---------- build the level ---------- */
{
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(MW * CS, MH * CS), mat(T.floor, { roughness: 0.97 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshStandardMaterial({ color: '#6f6a5c', roughness: 1 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.05; outer.receiveShadow = true; scene.add(outer);
  const kinds = { '#': { m: mat(T.concrete), h: 5 }, C: { m: mat(T.container, { roughness: 0.55, metalness: 0.5 }), h: 2.4 }, c: { m: mat(T.crate, { roughness: 0.8 }), h: 1.2 }, l: { m: mat(T.barrier), h: 1.0 } };
  const cols = ['#3d6e8f', '#8c4a3a', '#56704a', '#b08a3c', '#5b5f66'];
  const d = new THREE.Object3D(), col = new THREE.Color();
  for (const ch in kinds) {
    const k = kinds[ch], cells = [];
    for (let z = 0; z < MH; z++) for (let x = 0; x < MW; x++) if (ROWS[z][x] === ch) cells.push([x, z]);
    const sz = ch === 'c' ? CS * 0.96 : CS;
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(sz, k.h, sz), k.m, cells.length);
    im.castShadow = true; im.receiveShadow = true;
    cells.forEach(([x, z], i) => {
      d.position.set(cellX(x), k.h / 2, cellZ(z)); d.rotation.set(0, 0, 0); d.updateMatrix(); im.setMatrixAt(i, d.matrix);
      if (ch === 'C') im.setColorAt(i, col.set(cols[(hash2(x, z) * cols.length) | 0]));
      else { const v = 0.86 + hash2(x * 3, z * 7) * 0.2; im.setColorAt(i, col.setRGB(v, v, v)); }
    });
    scene.add(im);
  }
  // distant skyline blocks so the yard does not float in emptiness
  const far = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#5d6066', roughness: 0.95 }), 46);
  for (let i = 0; i < 46; i++) {
    const a = i / 46 * Math.PI * 2 + hash2(i, 5) * 0.1, r = 85 + hash2(i, 1) * 60, w = 10 + hash2(i, 2) * 22, h = 8 + hash2(i, 3) * 30;
    d.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r); d.rotation.set(0, a, 0); d.scale.set(w, h, 10 + hash2(i, 4) * 16); d.updateMatrix(); far.setMatrixAt(i, d.matrix);
    const v = 0.55 + hash2(i, 9) * 0.4; far.setColorAt(i, col.setRGB(v, v * 0.98, v * 0.95));
  }
  scene.add(far);
}

/* ---------- objective markers ---------- */
function ringMesh(color) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.9, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.03; g.add(disc); g.userData.mat = disc.material; return g;
}
const baseMark = { 1: ringMesh(TEAM_COL[1]), 2: ringMesh(TEAM_COL[2]) };
for (const t of [1, 2]) { baseMark[t].position.set(BASE[t].x, 0, BASE[t].z); scene.add(baseMark[t]); }
function flagMesh() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.4, 8), new THREE.MeshStandardMaterial({ color: '#d0d0d0', metalness: 0.9, roughness: 0.3 })); pole.position.y = 1.2;
  const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.03), new THREE.MeshStandardMaterial({ color: '#fff', roughness: 0.8, emissive: '#000' })); cloth.position.set(0.47, 2.05, 0);
  const cs = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.42, 0.16), new THREE.MeshStandardMaterial({ color: '#2a2d31', metalness: 0.7, roughness: 0.35 })); body.position.y = 0.3;
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.17), new THREE.MeshStandardMaterial({ color: '#f0a83a', emissive: '#f0a83a', emissiveIntensity: 1.6 })); band.position.y = 0.3;
  cs.add(body, band);
  for (const m of [pole, cloth, body]) m.castShadow = true;
  g.add(pole, cloth, cs); g.userData = { pole, cloth, cs }; g.visible = false; scene.add(g); return g;
}
const flagMeshes = [flagMesh(), flagMesh()];

/* ---------- soldiers ---------- */
const skinMat = new THREE.MeshStandardMaterial({ color: '#c99773', roughness: 0.7 });
const gunMat = new THREE.MeshStandardMaterial({ color: '#17191c', roughness: 0.55, metalness: 0.35 });
const gearMat = new THREE.MeshStandardMaterial({ color: '#2b2e2a', roughness: 0.85 });
function soldier() {
  const g = new THREE.Group(), cloth = new THREE.MeshStandardMaterial({ color: '#777', roughness: 0.9 });
  const add = (geo, m, x, y, z, parent = g) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
  const legGeo = new THREE.CapsuleGeometry(0.085, 0.62, 3, 8).translate(0, -0.4, 0);
  const legL = add(legGeo, cloth, -0.11, 0.86, 0), legR = add(legGeo, cloth, 0.11, 0.86, 0);
  const upper = new THREE.Group(); upper.position.y = 0.9; g.add(upper);
  add(new THREE.CapsuleGeometry(0.19, 0.3, 4, 10), cloth, 0, 0.3, 0, upper);
  add(new THREE.BoxGeometry(0.44, 0.36, 0.3), gearMat, 0, 0.32, 0, upper);          // vest
  add(new THREE.BoxGeometry(0.3, 0.34, 0.14), gearMat, 0, 0.3, 0.2, upper);            // pack
  add(new THREE.SphereGeometry(0.115, 12, 10), skinMat, 0, 0.7, 0, upper);
  const helm = add(new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), cloth, 0, 0.72, 0, upper);
  const armGeo = new THREE.CapsuleGeometry(0.06, 0.42, 3, 8);
  const aL = add(armGeo, cloth, -0.2, 0.36, -0.25, upper); aL.rotation.set(-1.25, 0, -0.5);
  const aR = add(armGeo, cloth, 0.22, 0.34, -0.18, upper); aR.rotation.set(-1.0, 0, 0.15);
  add(new THREE.BoxGeometry(0.06, 0.1, 0.78), gunMat, 0.1, 0.4, -0.45, upper);
  add(new THREE.BoxGeometry(0.05, 0.16, 0.08), gunMat, 0.1, 0.3, -0.3, upper);
  g.userData = { cloth, legL, legR, upper, helm };
  return g;
}
function nameSprite(text, color) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 48; const cx = cv.getContext('2d');
  cx.font = '600 26px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.lineWidth = 5; cx.strokeStyle = 'rgba(0,0,0,.8)';
  cx.strokeText(text, 128, 24); cx.fillStyle = color; cx.fillText(text, 128, 24);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false })); sp.scale.set(1.6, 0.3, 1); sp.position.y = 2.05; return sp;
}

/* ---------- effects ---------- */
const tracerMat = new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
tracerMat.color.multiplyScalar(2.5);
const tracers = Array.from({ length: 48 }, () => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 1), tracerMat); m.visible = false; scene.add(m); return { m, t: 0 }; });
const puffMat = () => new THREE.SpriteMaterial({ color: '#cfc7b8', transparent: true, opacity: 0, depthWrite: false });
const puffs = Array.from({ length: 48 }, () => { const m = new THREE.Sprite(puffMat()); m.visible = false; scene.add(m); return { m, t: 1 }; });
let trI = 0, pfI = 0; const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function tracer(ax, ay, az, bx, by, bz, blood) {
  const tr = tracers[trI++ % tracers.length]; _a.set(ax, ay, az); _b.set(bx, by, bz);
  tr.m.position.copy(_a).lerp(_b, 0.5); tr.m.scale.z = _a.distanceTo(_b); tr.m.lookAt(_b); tr.m.visible = true; tr.t = 0.05;
  const pf = puffs[pfI++ % puffs.length]; pf.m.position.set(bx, by, bz); pf.m.material.color.set(blood ? '#a3261d' : '#cfc7b8'); pf.m.visible = true; pf.t = 0;
}
// first-person weapon
const vm = new THREE.Group(); camera.add(vm);
const vmGun = new THREE.Group(); vm.add(vmGun);
const flashMat = new THREE.MeshBasicMaterial({ color: '#ffcf80', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }); flashMat.color.multiplyScalar(4);
const flash = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), flashMat); vm.add(flash);
const flashLight = new THREE.PointLight('#ffb866', 0, 9); camera.add(flashLight); flashLight.position.set(0.15, -0.1, -0.8);
function buildViewModel(i) {
  vmGun.clear(); const w = WPN[i], L = w.len;
  const part = (sx, sy, sz, x, y, z, m = gunMat) => { const o = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); o.position.set(x, y, z); vmGun.add(o); };
  part(0.045, 0.07, L, 0, 0, -L / 2);                                   // receiver + barrel
  part(0.03, 0.03, L * 0.45, 0, 0.01, -L - L * 0.2);                    // muzzle
  part(0.04, 0.13, 0.06, 0, -0.09, -0.06);                              // grip
  if (i !== 4) part(0.05, 0.08, 0.26, 0, -0.01, 0.13, gearMat);         // stock
  if (i < 2) part(0.035, 0.16, 0.07, 0, -0.1, -L * 0.45);               // magazine
  if (i === 3) { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.3, 10), gunMat); s.rotation.x = Math.PI / 2; s.position.set(0, 0.075, -0.25); vmGun.add(s); }
  const hand = new THREE.Mesh(new THREE.CapsuleGeometry(0.032, 0.1, 3, 8), gearMat); hand.rotation.z = Math.PI / 2; hand.position.set(0, -0.055, -Math.min(L * 0.6, 0.42)); vmGun.add(hand);
  flash.position.set(0.16, -0.13, -0.38 - L * 1.25);
}

/* ---------- audio ---------- */
let AC = null, noiseBuf = null;
function audioInit() {
  if (AC) return; try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  noiseBuf = AC.createBuffer(1, AC.sampleRate * 0.6, AC.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}
function sndShot(wi, dist) {
  if (!AC) return; const w = WPN[wi] || WPN[0], t = AC.currentTime, vol = 0.5 / (1 + dist / 14);
  const src = AC.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 0.7 + w.pitch * 0.5;
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(5200 * w.pitch + 800, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.22);
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16 + 0.12 / w.pitch);
  src.connect(lp).connect(g).connect(AC.destination); src.start(t); src.stop(t + 0.4);
  const o = AC.createOscillator(), og = AC.createGain(); o.frequency.setValueAtTime(150 * w.pitch, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.1);
  og.gain.setValueAtTime(vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.connect(og).connect(AC.destination); o.start(t); o.stop(t + 0.13);
}
function sndBeep(f, dur = 0.06, vol = 0.12, type = 'square') {
  if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g).connect(AC.destination); o.start(t); o.stop(t + dur);
}

/* =====================================================================
   CLIENT — local player, replicated world, HUD
   ===================================================================== */
const me = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, cr: false, alive: false, hp: 100, w: 0, ammo: [], res: [], next: 0, reload: 0, draw: 0,
  lean: 0, eye: 1.62, bloom: 0, kickV: 0, ads: 0, deadT: 0, respawnIn: 0, trig: false };
const K = {}; let mouseL = false, mouseR = false, sens = 1, inGame = false;
const Client = {
  id: 0, mode: 'dm', roster: new Map(), ents: new Map(), flags: [], scores: [0, 0, 0], time: 0, phase: 'live', lastSeq: 0, stats: new Map(),
  onMsg(m) {
    switch (m.t) {
      case 'welcome': this.id = m.id; this.mode = m.mode; this.lastSeq = 0; enterGame(m.code); break;
      case 'roster': this.roster.clear(); for (const [id, name, team, bot] of m.list) this.roster.set(id, { name, team, bot }); this.syncEnts(); break;
      case 's': this.snap(m); break;
      case 'spawn': if (m.id === this.id) localSpawn(m); else { const e = this.ents.get(m.id); if (e) { e.x = e.tx = m.x; e.z = e.tz = m.z; e.y = e.ty = 0; } } break;
      case 'fire': this.remoteFire(m); break;
      case 'hurt': $('#dmg').style.opacity = 1; setTimeout(() => { $('#dmg').style.opacity = 0; }, 90); sndBeep(90, 0.12, 0.2, 'sawtooth'); break;
      case 'kill': this.onKill(m); break;
      case 'msg': announce(m.text, m.team); break;
    }
  },
  team(id) { const r = this.roster.get(id); return r ? r.team : 0; },
  name(id) { const r = this.roster.get(id); return r ? r.name : '?'; },
  hostile(id) { const t = this.team(id); return !t || t !== this.team(this.id); },
  syncEnts() {
    for (const [id, e] of this.ents) if (!this.roster.has(id)) { scene.remove(e.mesh); this.ents.delete(id); }
    for (const [id, r] of this.roster) {
      if (id === this.id) continue;
      let e = this.ents.get(id);
      if (!e) { e = { id, mesh: soldier(), x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0, tyaw: 0, pitch: 0, alive: false, cr: false, hp: 0, w: 0, walk: 0, tag: null }; e.mesh.visible = false; scene.add(e.mesh); this.ents.set(id, e); }
      const col = r.team ? TEAM_COL[r.team] : `hsl(${(id * 67) % 360},32%,42%)`;
      e.mesh.userData.cloth.color.set(col);
      if (e.tag) { e.mesh.remove(e.tag); e.tag = null; }
      if (r.team && r.team === this.team(this.id)) { e.tag = nameSprite(r.name, TEAM_COL[r.team]); e.mesh.add(e.tag); }
    }
  },
  snap(m) {
    if (m.q <= this.lastSeq) return; this.lastSeq = m.q;
    this.phase = m.ph; this.time = m.tm; this.scores = m.sc; this.flags = m.f;
    for (const a of m.p) {
      const [id, x, y, z, yaw, pitch, fl, hp, w, k, d] = a;
      this.stats.set(id, { k, d, alive: fl & 1 });
      if (id === this.id) { me.hp = hp; if (!(fl & 1) && me.alive) localDie(); continue; }
      const e = this.ents.get(id); if (!e) continue;
      if (!e.alive && (fl & 1)) { e.x = x; e.y = y; e.z = z; e.yaw = yaw; }
      e.tx = x; e.ty = y; e.tz = z; e.tyaw = yaw; e.pitch = pitch; e.alive = !!(fl & 1); e.cr = !!(fl & 2); e.hp = hp; e.w = w;
    }
  },
  remoteFire(m) {
    const e = this.ents.get(m.id); if (!e) return;
    const d = Math.hypot(e.x - me.x, e.z - me.z); sndShot(m.w, d);
    const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
    for (const p of m.es || []) tracer(e.x + fx * 0.6, e.y + (e.cr ? 0.95 : 1.3), e.z + fz * 0.6, p[0], p[1], p[2]);
  },
  onKill(m) {
    const a = m.a ? this.name(m.a) : '', v = this.name(m.v), el = document.createElement('div');
    el.innerHTML = (a ? `<span class="t${this.team(m.a)}">${esc(a)}</span> <span style="color:var(--dim)">[${WPN[m.w].s}${m.hs ? ' · headshot' : ''}]</span> ` : '') + `<span class="t${this.team(m.v)}">${esc(v)}</span>` + (a ? '' : ' <span style="color:var(--dim)">died</span>');
    const f = $('#feed'); f.prepend(el); while (f.children.length > 5) f.lastChild.remove(); setTimeout(() => el.remove(), 6000);
    if (m.v === this.id) { me.respawnIn = m.rs; me.killer = a; }
    if (m.a === this.id) sndBeep(880, 0.12, 0.12, 'sine');
  },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let msgTimer = 0;
function announce(text, team) { const el = $('#msg'); el.textContent = text; el.style.color = team ? TEAM_COL[team] : ''; el.style.opacity = 1; clearTimeout(msgTimer); msgTimer = setTimeout(() => { el.style.opacity = 0; }, 3200); }

function localSpawn(m) {
  Object.assign(me, { x: m.x, y: 0, z: m.z, vx: 0, vy: 0, vz: 0, yaw: m.yaw, pitch: 0, alive: true, hp: 100, reload: 0, bloom: 0, lean: 0, deadT: 0 });
  me.ammo = WPN.map((w) => w.mag); me.res = WPN.map((w) => w.res); setWeapon(0, true);
  $('#dead').style.display = 'none';
}
function localDie() { me.alive = false; me.deadT = 0; me.reload = 0; mouseL = false; sndBeep(60, 0.4, 0.25, 'sawtooth'); }
function setWeapon(i, force) { if (i === me.w && !force) return; me.w = i; me.reload = 0; me.draw = 0.3; buildViewModel(i); }

/* ---------- local movement ---------- */
const R = 0.32, STEP = 0.35;
function blockedAt(x, z, feet) { const lim = feet + STEP; return hAt(x - R, z - R) > lim || hAt(x + R, z - R) > lim || hAt(x - R, z + R) > lim || hAt(x + R, z + R) > lim; }
function groundAt(x, z, feet) { let g = 0; for (const [dx, dz] of [[-R, -R], [R, -R], [-R, R], [R, R]]) { const h = hAt(x + dx, z + dz); if (h <= feet + STEP && h > g) g = h; } return g; }
const locked = () => TEST || document.pointerLockElement === canvas;
function updateMe(dt) {
  const act = me.alive && locked();
  let f = 0, s = 0;
  if (act) { f = (K.w ? 1 : 0) - (K.s ? 1 : 0); s = (K.d ? 1 : 0) - (K.a ? 1 : 0); }
  me.cr = act && !!K.c;
  const sp = me.cr ? 2.6 : K.shift ? 3 : 5.6, sy = Math.sin(me.yaw), cy = Math.cos(me.yaw);
  let wx = -sy * f + cy * s, wz = -cy * f - sy * s; const wl = Math.hypot(wx, wz); if (wl > 0) { wx /= wl; wz /= wl; }
  const acc = Math.min(1, dt * (me.onGround ? 12 : 2.5));
  me.vx += (wx * sp - me.vx) * acc; me.vz += (wz * sp - me.vz) * acc;
  if (!me.alive) { me.vx = me.vz = 0; }
  if (act && K[' '] && me.onGround) { me.vy = 6.9; me.onGround = false; }
  const feet = me.y;
  const nx = me.x + me.vx * dt; if (!blockedAt(nx, me.z, me.y)) me.x = nx; else me.vx = 0;
  const nz = me.z + me.vz * dt; if (!blockedAt(me.x, nz, me.y)) me.z = nz; else me.vz = 0;
  me.vy = Math.max(-25, me.vy - 22 * dt); me.y += me.vy * dt;
  const g = groundAt(me.x, me.z, Math.max(feet, me.y));
  if (me.y <= g) { me.y = g; me.vy = 0; me.onGround = true; } else me.onGround = false;

  // camera
  const wantLean = act ? (K.e ? 1 : 0) - (K.q ? 1 : 0) : 0; me.lean += (wantLean - me.lean) * Math.min(1, dt * 10);
  me.eye += ((me.cr ? 1.05 : 1.62) - me.eye) * Math.min(1, dt * 12);
  let lx = cy * me.lean * 0.5, lz = -sy * me.lean * 0.5;
  if (hAt(me.x + lx * 1.3, me.z + lz * 1.3) > me.y + me.eye) { lx = lz = 0; }
  if (me.alive) { camera.position.set(me.x + lx, me.y + me.eye, me.z + lz); camera.rotation.set(me.pitch, me.yaw, -me.lean * 0.16); }
  else {
    me.deadT += dt; me.respawnIn = Math.max(0, me.respawnIn - dt);
    if (Client.mode === 'inf') { const k = Math.min(1, me.deadT / 1.2); camera.position.set(me.x, me.y + 1 + k * 26, me.z + 0.01); camera.rotation.set(-0.2 - k * 1.3, me.yaw, 0); }
    else { camera.position.set(me.x, me.y + Math.max(0.35, 1.5 - me.deadT * 3), me.z); camera.rotation.set(me.pitch * 0.5, me.yaw, Math.min(0.6, me.deadT * 2)); }
    const d = $('#dead'); d.style.display = 'block';
    d.innerHTML = (me.killer ? `Killed by <b>${esc(me.killer)}</b><br>` : '') + (Client.mode === 'inf' ? 'Spectating — you deploy next round' : `Respawning in ${Math.ceil(me.respawnIn)}`);
  }
  // aim / zoom
  const w = WPN[me.w]; me.ads += ((act && mouseR ? 1 : 0) - me.ads) * Math.min(1, dt * 14);
  const fov = 74 - me.ads * (w.scope ? 56 : 16); if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
  const scoped = w.scope && me.ads > 0.8 && me.alive; $('#scope').style.display = scoped ? 'block' : 'none';
  vm.visible = me.alive && !scoped; $('#cross').style.display = me.alive && !scoped && !(w.scope) ? 'block' : 'none';
  // weapon timers + firing
  me.next -= dt; me.draw = Math.max(0, me.draw - dt); me.bloom = Math.max(0, me.bloom - dt * 0.06); me.kickV *= Math.exp(-dt * 14);
  if (me.reload > 0) { me.reload -= dt; if (me.reload <= 0) { const n = Math.min(w.mag - me.ammo[me.w], me.res[me.w]); me.ammo[me.w] += n; me.res[me.w] -= n; sndBeep(1400, 0.03, 0.08); } }
  if (!mouseL) me.trig = false;
  if (act && mouseL && me.reload <= 0 && me.draw <= 0 && me.next <= 0 && (w.auto || !me.trig)) {
    if (me.ammo[me.w] > 0) fire(w); else { startReload(); me.trig = true; }
  }
  // view model pose
  const moving = Math.hypot(me.vx, me.vz), bob = me.onGround ? Math.sin(performance.now() * 0.011) * moving * 0.0035 : 0;
  const hip = new THREE.Vector3(0.16, -0.15 + bob - me.draw * 0.5 - (me.reload > 0 ? 0.12 : 0), -0.3 + me.kickV), aim = new THREE.Vector3(0, -0.085, -0.22 + me.kickV);
  vmGun.position.copy(hip).lerp(aim, me.ads); vmGun.rotation.set(me.kickV * 1.5 + (me.reload > 0 ? -0.5 : 0), 0, 0);
  flashMat.opacity *= Math.exp(-dt * 40); flashLight.intensity *= Math.exp(-dt * 40);
}
function startReload() { const w = WPN[me.w]; if (me.reload > 0 || me.ammo[me.w] >= w.mag || me.res[me.w] <= 0) return; me.reload = w.rel; sndBeep(500, 0.05, 0.08); }
function rayBox(o, d, min, max) {
  let t0 = 0, t1 = 1e9;
  for (let i = 0; i < 3; i++) { const inv = 1 / (d[i] || 1e-9); let a = (min[i] - o[i]) * inv, b = (max[i] - o[i]) * inv; if (a > b) [a, b] = [b, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return Infinity; }
  return t0;
}
function raySphere(o, d, c, r) { const x = o[0] - c[0], y = o[1] - c[1], z = o[2] - c[2], b = x * d[0] + y * d[1] + z * d[2], q = b * b - (x * x + y * y + z * z - r * r); if (q < 0) return Infinity; const t = -b - Math.sqrt(q); return t > 0 ? t : Infinity; }
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
function fire(w) {
  me.ammo[me.w]--; me.next = 60 / w.rpm; me.trig = true;
  camera.updateMatrixWorld(); camera.matrixWorld.extractBasis(_r, _u, _f); _f.negate();
  const moving = Math.hypot(me.vx, me.vz) > 1, scoped = w.scope && me.ads > 0.8;
  let spread = w.scope ? (scoped ? 0.0008 : w.spread) : w.spread * (moving ? 1.7 : 1) * (me.cr ? 0.7 : 1) * (me.onGround ? 1 : 2.5) * (1 - me.ads * 0.45) + me.bloom;
  const o = [camera.position.x, camera.position.y, camera.position.z], es = [], hits = new Map();
  const mz = _a.copy(camera.position).addScaledVector(_f, 0.7).addScaledVector(_r, 0.14 * (1 - me.ads)).addScaledVector(_u, -0.1);
  for (let i = 0; i < (w.pellets || 1); i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * spread;
    const d = _b.copy(_f).addScaledVector(_r, Math.cos(a) * rr).addScaledVector(_u, Math.sin(a) * rr).normalize(), dv = [d.x, d.y, d.z];
    let best = rayMap(o[0], o[1], o[2], d.x, d.y, d.z, 140), hitE = null, hs = false;
    for (const e of Client.ents.values()) {
      if (!e.alive || !Client.hostile(e.id)) continue;
      const h = e.cr ? 1.25 : 1.8;
      const th = raySphere(o, dv, [e.x, e.y + h - 0.13, e.z], 0.17), tb = rayBox(o, dv, [e.x - 0.3, e.y, e.z - 0.3], [e.x + 0.3, e.y + h - 0.28, e.z + 0.3]);
      const t = Math.min(th, tb); if (t < best) { best = t; hitE = e; hs = th <= tb; }
    }
    const ex = o[0] + d.x * best, ey = o[1] + d.y * best, ez = o[2] + d.z * best; es.push([r2(ex), r2(ey), r2(ez)]);
    tracer(mz.x, mz.y, mz.z, ex, ey, ez, !!hitE);
    if (hitE) { const h = hits.get(hitE.id) || { n: 0, hs: false }; h.n++; h.hs = h.hs || hs; hits.set(hitE.id, h); }
  }
  toHost({ t: 'fire', w: me.w, es });
  for (const [id, h] of hits) toHost({ t: 'hit', id, n: h.n, hs: h.hs ? 1 : 0, w: me.w });
  if (hits.size) { const hm = $('#hit'); hm.style.transition = 'none'; hm.style.opacity = 1; hm.classList.toggle('hs', [...hits.values()].some((h) => h.hs)); requestAnimationFrame(() => { hm.style.transition = ''; hm.style.opacity = 0; }); sndBeep(1900, 0.04, 0.1); }
  me.pitch = clamp(me.pitch + w.kick * (0.7 + Math.random() * 0.6), -1.5, 1.5); me.yaw += (Math.random() - 0.5) * w.kick * 0.6;
  me.bloom = Math.min(0.03, me.bloom + 0.003); me.kickV = Math.min(0.09, me.kickV + w.kick * 1.6);
  flashMat.opacity = 1; flashLight.intensity = 14; sndShot(me.w, 0);
  if (me.ammo[me.w] <= 0) startReload();
}

/* ---------- remote players + objectives ---------- */
function updateEnts(dt) {
  const k = Math.min(1, dt * 16);
  for (const e of Client.ents.values()) {
    const px = e.x, pz = e.z;
    e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k; e.z += (e.tz - e.z) * k;
    let da = e.tyaw - e.yaw; da = Math.atan2(Math.sin(da), Math.cos(da)); e.yaw += da * k;
    const m = e.mesh, u = m.userData; m.visible = e.alive;
    if (!e.alive) continue;
    m.position.set(e.x, e.y, e.z); m.rotation.y = e.yaw;
    const spd = Math.hypot(e.x - px, e.z - pz) / Math.max(dt, 0.001); e.walk += dt * spd * 2.4;
    const sw = Math.sin(e.walk) * Math.min(0.7, spd * 0.16);
    u.legL.rotation.x = sw; u.legR.rotation.x = -sw;
    u.upper.position.y = e.cr ? 0.55 : 0.9; u.legL.position.y = u.legR.position.y = e.cr ? 0.55 : 0.86; u.legL.scale.y = u.legR.scale.y = e.cr ? 0.6 : 1;
    u.upper.rotation.x = clamp(e.pitch, -0.9, 0.9) * 0.6;
  }
  const t = performance.now() / 1000;
  flagMeshes.forEach((fm, i) => {
    const f = Client.flags[i]; fm.visible = !!f; if (!f) return;
    const [s, x, y, z, c, team, isCase] = f, u = fm.userData;
    u.pole.visible = u.cloth.visible = !isCase; u.cs.visible = !!isCase;
    if (!isCase) { u.cloth.material.color.set(TEAM_COL[team]); u.cloth.material.emissive.set(TEAM_COL[team]); u.cloth.material.emissiveIntensity = 0.5; u.cloth.rotation.y = Math.sin(t * 3) * 0.18; }
    if (s === 1) { const mine = c === Client.id; fm.visible = !mine; fm.position.set(x, y + (isCase ? 0.75 : 0.25), z); fm.scale.setScalar(isCase ? 1 : 0.7); }
    else { fm.position.set(x, y + (isCase ? Math.sin(t * 2) * 0.06 + 0.1 : 0), z); fm.scale.setScalar(1); fm.rotation.y = isCase ? t : 0; }
  });
}
function updateFx(dt) {
  for (const tr of tracers) if (tr.m.visible) { tr.t -= dt; if (tr.t <= 0) tr.m.visible = false; }
  for (const p of puffs) if (p.m.visible) { p.t += dt * 2.6; const s = 0.12 + p.t * 0.6; p.m.scale.set(s, s, 1); p.m.material.opacity = Math.max(0, 0.7 * (1 - p.t)); p.m.position.y += dt * 0.3; if (p.t >= 1) p.m.visible = false; }
}

/* ---------- HUD ---------- */
const fmtTime = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
let hudAcc = 0;
function updateHud(dt) {
  hudAcc += dt; if (hudAcc < 0.1) return; hudAcc = 0;
  const C = Client, w = WPN[me.w];
  $('#hp').firstChild.textContent = me.alive ? me.hp : 0; $('#hpbar i').style.width = (me.alive ? me.hp : 0) + '%'; $('#hpbar i').style.background = me.hp > 35 ? 'var(--green)' : 'var(--red)';
  $('#ammo').innerHTML = me.reload > 0 ? `<small>RELOADING</small>` : `${me.ammo[me.w] ?? 0}<small> / ${me.res[me.w] ?? 0}</small>`;
  $('#wname').textContent = w.n; $('#wlist').innerHTML = WPN.map((x, i) => i === me.w ? `<b>${i + 1} ${x.s}</b>` : `${i + 1} ${x.s}`).join(' &nbsp;');
  let score = '', obj = ''; const myTeam = C.team(C.id);
  if (C.mode === 'dm') {
    const rows = [...C.stats].sort((a, b) => b[1].k - a[1].k), mine = C.stats.get(C.id);
    score = rows.length ? `${esc(C.name(rows[0][0]))} ${rows[0][1].k} <span style="color:var(--dim)">/ ${CFG.dm.limit}</span>` : ''; obj = mine ? `Your kills: ${mine.k}` : '';
  } else {
    score = `<span class="t1">${TEAM_NAME[1]} ${C.scores[1]}</span> <span style="color:var(--dim)">—</span> <span class="t2">${C.scores[2]} ${TEAM_NAME[2]}</span>`;
    const st = ['at base', 'taken', 'dropped'];
    if (C.mode === 'ctf') obj = C.flags.map((f) => `<span class="t${f[5]}">${TEAM_NAME[f[5]]} flag: ${f[0] === 1 ? 'taken by ' + esc(C.name(f[4])) : st[f[0]]}</span>`).join(' &nbsp;·&nbsp; ');
    else { const f = C.flags[0]; obj = (myTeam === 2 ? 'Steal the case from the red ring and carry it to the green ring' : 'Stop Blue from extracting the case') + (f && f[0] === 1 ? ` — <b>${esc(C.name(f[4]))} has the case</b>` : ''); }
    obj = `<span class="t${myTeam}">You are ${TEAM_NAME[myTeam]}</span> · ` + obj;
  }
  $('#score').innerHTML = score; $('#sub').textContent = MODE_NAME[C.mode] + ' · ' + fmtTime(C.time) + (C.phase !== 'live' ? ' · intermission' : ''); $('#obj').innerHTML = obj;
  baseMark[1].visible = baseMark[2].visible = C.mode !== 'dm';
  baseMark[2].userData.mat.color.set(C.mode === 'inf' ? '#6fdc6a' : TEAM_COL[2]);
  const showBoard = K.tab || C.phase === 'over'; $('#board').style.display = showBoard ? 'block' : 'none';
  if (showBoard) {
    const rows = [...C.roster].map(([id, r]) => ({ id, ...r, ...(C.stats.get(id) || { k: 0, d: 0, alive: 0 }) })).sort((a, b) => a.team - b.team || b.k - a.k);
    $('#board').innerHTML = `<table><tr><th>Player</th><th>Team</th><th class="n">Kills</th><th class="n">Deaths</th></tr>` +
      rows.map((r) => `<tr class="${r.id === C.id ? 'me' : ''}"><td>${esc(r.name)}${r.bot ? ' <span style="color:var(--dim)">bot</span>' : ''}${r.alive ? '' : ' <span style="color:var(--dim)">✕</span>'}</td><td class="t${r.team}">${r.team ? TEAM_NAME[r.team] : '—'}</td><td class="n">${r.k}</td><td class="n">${r.d}</td></tr>`).join('') + `</table>`;
  }
}

/* ---------- input ---------- */
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas || !me.alive) return;
  const k = 0.0022 * sens * (camera.fov / 74);
  me.yaw -= e.movementX * k; me.pitch = clamp(me.pitch - e.movementY * k, -1.5, 1.5);
});
canvas.addEventListener('mousedown', (e) => { if (!locked()) return; if (e.button === 0) mouseL = true; if (e.button === 2) mouseR = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) mouseL = false; if (e.button === 2) mouseR = false; });
window.addEventListener('contextmenu', (e) => { if (inGame) e.preventDefault(); });
window.addEventListener('wheel', (e) => { if (locked() && me.alive) setWeapon((me.w + (e.deltaY > 0 ? 1 : WPN.length - 1)) % WPN.length); });
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase(); K[k] = true;
  if (!inGame) return;
  if (k === 'tab' || k === ' ') e.preventDefault();
  if (!locked() || !me.alive) return;
  if (k >= '1' && k <= '5') setWeapon(+k - 1);
  if (k === 'r') startReload();
});
window.addEventListener('keyup', (e) => { K[e.key.toLowerCase()] = false; });
window.addEventListener('blur', () => { for (const k in K) K[k] = false; mouseL = mouseR = false; });
document.addEventListener('pointerlockchange', () => { if (!inGame) return; const on = document.pointerLockElement === canvas; $('#pause').style.display = on ? 'none' : 'grid'; if (!on) { mouseL = mouseR = false; for (const k in K) K[k] = false; } });

/* ---------- menus ---------- */
let pickMode = 'dm';
const status = (t) => { $('#status').textContent = t; };
try { $('#name').value = localStorage.getItem('coldline-name') || ''; } catch (e) {}
if (/^#[A-Za-z0-9]{5}$/.test(location.hash)) $('#code').value = location.hash.slice(1).toUpperCase();
const myName = () => { const n = $('#name').value.trim() || 'Operator' + ((Math.random() * 90 + 10) | 0); try { localStorage.setItem('coldline-name', n); } catch (e) {} return n; };
$('#modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; pickMode = b.dataset.m; document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x === b)); });
$('#createBtn').addEventListener('click', () => {
  audioInit(); status('Creating match…');
  netHost(() => Host.start(pickMode, +$('#bots').value, myName()), status);
});
function doJoin() {
  const code = $('#code').value.trim().toUpperCase(); if (code.length !== 5) { status('Enter the 5-character invite code.'); return; }
  audioInit(); status('Connecting…');
  netJoin(code, () => { const nm = myName(), go = () => { if (!inGame) { toHost({ t: 'join', name: nm }); setTimeout(go, 800); } }; go(); }, status);
}
$('#joinBtn').addEventListener('click', doJoin);
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
function enterGame(code) {
  inGame = true; $('#menu').style.display = 'none'; $('#hud').style.display = 'block'; $('#pause').style.display = TEST ? 'none' : 'grid';
  $('#codeTxt').textContent = code; $('#codeBig').textContent = code; $('#teamBtn').style.display = Client.mode === 'dm' ? 'none' : '';
  try { history.replaceState(null, '', '#' + code); } catch (e) {}
}
function leave(reason) {
  Host.stop(); try { if (Net.peer) Net.peer.destroy(); } catch (e) {}
  try { document.exitPointerLock(); } catch (e) {}
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  if (reason) { try { sessionStorage.setItem('coldline-note', reason); } catch (e) {} }
  location.reload();
}
try { const n = sessionStorage.getItem('coldline-note'); if (n) { status(n); sessionStorage.removeItem('coldline-note'); } } catch (e) {}
$('#resumeBtn').addEventListener('click', () => { audioInit(); const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); });
$('#leaveBtn').addEventListener('click', () => leave(''));
$('#teamBtn').addEventListener('click', () => toHost({ t: 'team' }));
$('#sens').addEventListener('input', (e) => { sens = +e.target.value; });
$('#gfx').addEventListener('change', (e) => { gfxHigh = e.target.value === 'high'; renderer.shadowMap.enabled = gfxHigh; sun.castShadow = gfxHigh; renderer.setPixelRatio(gfxHigh ? Math.min(window.devicePixelRatio || 1, 1.75) : 1); resize(); scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); });
$('#copyBtn').addEventListener('click', () => {
  const link = location.origin + location.pathname + '#' + Net.code;
  const ok = () => { $('#copied').textContent = 'Copied'; setTimeout(() => { $('#copied').textContent = ''; }, 1500); };
  try { navigator.clipboard.writeText(link).then(ok, () => { $('#copied').textContent = link; }); } catch (e) { $('#copied').textContent = link; }
});

if (Q.has('low')) { $('#gfx').value = 'low'; $('#gfx').dispatchEvent(new Event('change')); }

/* ---------- main loop ---------- */
let last = performance.now(), sendAcc = 0, menuT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (inGame) {
    updateMe(dt); updateEnts(dt); updateFx(dt); updateHud(dt);
    sendAcc += dt;
    if (sendAcc >= 0.05 && me.alive) { sendAcc = 0; toHost({ t: 'in', x: r2(me.x), y: r2(me.y), z: r2(me.z), yaw: r2(me.yaw), pitch: r2(me.pitch), cr: me.cr ? 1 : 0, w: me.w }); }
  } else { // slow orbit behind the menu
    menuT += dt * 0.05; camera.position.set(Math.cos(menuT) * 46, 20, Math.sin(menuT) * 46); camera.lookAt(0, 1, 0); vm.visible = false;
  }
  if (gfxHigh) composer.render(); else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__g = { Host, Client, Net, me, toHost, bfs, BASE, SPAWNS, toCx, toCz, WPN };
