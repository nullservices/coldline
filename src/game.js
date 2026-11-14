import * as THREE from 'three';
import { Peer } from 'peerjs';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { compile } from './map.js';
import { MAPS, mapById } from './maps/index.js';

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
let M = null; // the compiled map of the current match (see loadMap)

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
  on: false, players: new Map(), mode: 'dm', map: 'campus', nades: [], scores: [0, 0, 0], time: 0, phase: 'live', phaseT: 0, flags: [], seq: 0, snapAcc: 0, last: 0,
  nextId: 2, nextBot: 100, clock: 0, roundAge: 0,
  send(id, m) { if (id === 1) Client.onMsg(m); else { const c = Net.conns.get(id); if (c && c.open) c.send(m); } },
  all(m) { for (const c of Net.conns.values()) if (c.open) c.send(m); Client.onMsg(m); },
  say(text, team = 0) { this.all({ t: 'msg', text, team }); },
  start(mode, bots, name, map) {
    this.map = mapById(map).id; loadMap(this.map);
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
    if (!bot) this.send(id, { t: 'welcome', id, mode: this.mode, map: this.map, code: Net.code });
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
    let pts = p.team ? M.SPAWNS[p.team] : M.SPAWNS.all, best = pts[(Math.random() * pts.length) | 0];
    if (!p.team) { // deathmatch: prefer points far from everyone else
      let bs = -1;
      for (const s of pts) { let m = 1e9; for (const o of this.players.values()) if (o.alive && o !== p) m = Math.min(m, Math.hypot(o.x - s.x, o.z - s.z)); m += Math.random() * 8; if (m > bs) { bs = m; best = s; } }
    }
    p.x = best.x + (Math.random() - 0.5) * 0.8; p.z = best.z + (Math.random() - 0.5) * 0.8; p.y = best.y || 0; p.yaw = Math.atan2(p.x, p.z); p.pitch = 0;
    p.hp = 100; p.alive = true; p.nades = 3; p.ai.path = null; p.ai.target = null;
    this.all({ t: 'spawn', id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r2(p.yaw) });
  },
  setupFlags() {
    const mk = (team, isCase) => ({ team, s: 0, x: M.BASE[team].x, y: 0, z: M.BASE[team].z, c: 0, dt: 0, isCase });
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
  dropFlags(p) { for (const f of this.flags) if (f.s === 1 && f.c === p.id) { f.s = 2; f.c = 0; f.x = p.x; f.y = M.groundAt(p.x, p.z, p.y, 0.3); f.z = p.z; f.dt = 25; this.say((f.isCase ? 'The case' : TEAM_NAME[f.team] + ' flag') + ' was dropped'); } },
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
    else if (m.t === 'hit') { if (p.alive && this.canHit(p, this.players.get(m.id), m.o)) { const w = WPN[m.w | 0] || WPN[0]; this.damage(m.id, id, w.dmg * clamp(m.n | 0, 1, w.pellets || 1) * (m.hs ? 2 : 1), m.hs, m.w | 0); } }
    else if (m.t === 'nade') { if (p.alive && Array.isArray(m.o) && Array.isArray(m.v) && Math.hypot(m.o[0] - p.x, m.o[2] - p.z) < 2.5) this.throwNade(p, m.o.map(Number), m.v.map(Number)); }
    else if (m.t === 'team') { if (this.mode !== 'dm') { if (p.alive) this.kill(p, null, 0, 0); p.team = 3 - p.team; this.roster(); this.say(p.name + ' switched to ' + TEAM_NAME[p.team]); } }
  },
  throwNade(p, o, v) {
    if (p.nades <= 0) return; p.nades--;
    this.all({ t: 'nade', id: p.id, o, v });
    this.nades.push({ owner: p.id, x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2], t: 0, acc: 0, spin: 0, done: false });
  },
  tickNades(dt) {
    for (const n of this.nades) {
      n.acc += dt;
      while (n.acc >= 1 / 120 && !n.done) {
        n.acc -= 1 / 120; n.t += 1 / 120; nadeStep(n, 1 / 120);
        if (n.t >= NADE.fuse) {
          n.done = true; const ox = n.x, oy = n.y + 0.3, oz = n.z;
          for (const v of this.players.values()) {
            if (!v.alive) continue;
            const d = Math.hypot(v.x - ox, v.y + 0.9 - oy, v.z - oz); if (d > NADE.radius) continue;
            if (!M.los(ox, oy, oz, v.x, v.y + 0.9, v.z) && !M.los(ox, oy, oz, v.x, v.y + 0.2, v.z) && !M.los(ox, oy, oz, v.x, v.y + 1.5, v.z)) continue;
            this.damage(v.id, n.owner, NADE.dmg * Math.pow(1 - d / NADE.radius, 1.1), false, 5);
          }
        }
      }
    }
    this.nades = this.nades.filter((n) => !n.done);
  },
  // a hit counts only if the victim is visible from the shooter's eye (which must be near the shooter's known position)
  canHit(a, v, o) {
    if (!v || !v.alive) return false;
    let ex = a.x, ey = a.y + (a.cr ? 1.05 : 1.62), ez = a.z;
    if (o && o.length === 3 && Math.hypot(o[0] - ex, o[1] - ey, o[2] - ez) < 1.3) { ex = +o[0]; ey = +o[1]; ez = +o[2]; }
    const h = v.cr ? 1.25 : 1.8;
    for (const f of [0.92, 0.55, 0.15]) for (const [dx, dz] of [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) if (M.los(ex, ey, ez, v.x + dx, v.y + h * f, v.z + dz)) return true;
    return false;
  },
  tickFlags(dt) {
    for (const f of this.flags) {
      if (f.s === 1) {
        const c = this.players.get(f.c);
        if (!c || !c.alive) { f.s = 2; f.c = 0; f.dt = 25; continue; }
        f.x = c.x; f.y = c.y; f.z = c.z;
        if (f.isCase) { if (Math.hypot(c.x - M.BASE[2].x, c.z - M.BASE[2].z) < 2.2) { this.roundWin(2, 'case extracted'); return; } }
        else {
          const own = this.flags.find((o) => o.team === c.team);
          if (own.s === 0 && Math.hypot(c.x - M.BASE[c.team].x, c.z - M.BASE[c.team].z) < 2) {
            this.scores[c.team]++; f.s = 0; f.c = 0; f.x = M.BASE[f.team].x; f.y = 0; f.z = M.BASE[f.team].z;
            this.say(c.name + ' captured the ' + TEAM_NAME[f.team] + ' flag', c.team);
            if (this.scores[c.team] >= CFG.ctf.limit) { this.endMatch(TEAM_NAME[c.team] + ' team wins the match'); return; }
          }
        }
        continue;
      }
      if (f.s === 2 && !f.isCase) { f.dt -= dt; if (f.dt <= 0) { f.s = 0; f.x = M.BASE[f.team].x; f.y = 0; f.z = M.BASE[f.team].z; this.say(TEAM_NAME[f.team] + ' flag returned'); continue; } }
      for (const p of this.players.values()) {
        if (!p.alive || Math.hypot(p.x - f.x, p.z - f.z) > 1.5 || Math.abs(p.y - f.y) > 2) continue;
        if (p.team !== f.team) { f.s = 1; f.c = p.id; this.say(p.name + (f.isCase ? ' has the case' : ' took the ' + TEAM_NAME[f.team] + ' flag'), p.team); break; }
        else if (f.s === 2 && !f.isCase) { f.s = 0; f.x = M.BASE[f.team].x; f.y = 0; f.z = M.BASE[f.team].z; this.say(p.name + ' returned the ' + TEAM_NAME[f.team] + ' flag', p.team); break; }
      }
    }
  },
  botGoal(b) {
    const rnd = () => M.SPAWNS.all[(Math.random() * M.SPAWNS.all.length) | 0];
    if (this.mode === 'ctf') {
      const mine = this.flags.find((f) => f.team === b.team), theirs = this.flags.find((f) => f.team !== b.team);
      if (theirs.s === 1 && theirs.c === b.id) return M.BASE[b.team];
      if (mine.s === 2 && Math.random() < 0.6) return mine;
      if (theirs.s === 1) return Math.random() < 0.5 ? M.BASE[b.team] : rnd();
      return Math.random() < 0.75 ? theirs : rnd();
    }
    if (this.mode === 'inf') {
      const f = this.flags[0];
      if (b.team === 2) return f.s === 1 && f.c === b.id ? M.BASE[2] : f.s === 1 ? M.BASE[2] : f;
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
        if (M.los(b.x, b.y + 1.5, b.z, e.x, e.y + (e.cr ? 0.8 : 1.2), e.z)) { best = e; bd = d; }
      }
      if (best !== ai.target) { ai.target = best; ai.react = 0.3 + Math.random() * 0.35; ai.burst = 0; }
      ai.goalT -= 0.25;
      if (!ai.path || ai.pi >= ai.path.length || ai.goalT <= 0) {
        const g = this.botGoal(b);
        ai.path = M.findPath(b.x, b.y, b.z, g.x, g.y, g.z); ai.pi = 0; ai.goalT = 5 + Math.random() * 5;
        if (!ai.path) { const s = M.SPAWNS.all[(Math.random() * M.SPAWNS.all.length) | 0]; ai.path = M.findPath(b.x, b.y, b.z, s.x, s.y, s.z) || []; }
      }
    }
    const tgt = ai.target && ai.target.alive ? ai.target : null;
    let mvYaw = b.yaw, climbing = false;
    if (ai.path && ai.pi < ai.path.length) {
      const wp = ai.path[ai.pi], dx = wp.x - b.x, dz = wp.z - b.z, d = Math.hypot(dx, dz), sp = (tgt ? 2.4 : 4.6) * dt;
      if (d <= Math.max(sp, 0.25)) { if (wp.y > b.y + 0.6 && !wp.stair) { climbing = true; b.y = Math.min(wp.y, b.y + 3.2 * dt); } else ai.pi++; }
      else { b.x += dx / d * sp; b.z += dz / d * sp; mvYaw = Math.atan2(-dx, -dz); }
    }
    const want = tgt ? Math.atan2(-(tgt.x - b.x), -(tgt.z - b.z)) : mvYaw;
    let da = want - b.yaw; da = Math.atan2(Math.sin(da), Math.cos(da)); b.yaw += da * Math.min(1, dt * 9);
    if (!climbing) { // bots step/hop up to 1.45 and otherwise fall — unless heading to a waypoint at this height (stepping off a ladder top)
      const g = M.groundAt(b.x, b.z, b.y, 0.25, 1.45), wp = ai.path && ai.path[ai.pi];
      if (g >= b.y) b.y = g; else if (!(wp && Math.abs(wp.y - b.y) < 0.6 && wp.y > g + 0.5)) b.y = Math.max(g, b.y - 9 * dt);
    }
    b.cr = TEST && Q.has('crouch');
    if (tgt) {
      const d = Math.hypot(tgt.x - b.x, tgt.z - b.z), ty = tgt.y + (tgt.cr ? 0.75 : 1.15);
      b.pitch = Math.atan2(ty - (b.y + 1.5), d);
      if (b.nades > 0 && d > 9 && d < 26 && Math.random() < dt * 0.09 && M.los(b.x, b.y + 1.5, b.z, tgt.x, ty, tgt.z)) { // lob a grenade now and then
        const dx = (tgt.x - b.x) / d, dz = (tgt.z - b.z) / d, sp = clamp(d * 0.75, 8, 15);
        this.throwNade(b, [r2(b.x + dx * 0.5), r2(b.y + 1.4), r2(b.z + dz * 0.5)], [r2(dx * sp), r2(5 + Math.max(0, tgt.y - b.y) * 0.8), r2(dz * sp)]);
      }
      ai.react -= dt;
      if (ai.react <= 0 && this.clock >= ai.next && !M.los(b.x, b.y + 1.5, b.z, tgt.x, ty, tgt.z)) { ai.target = null; ai.next = this.clock + 0.2; }
      else if (ai.react <= 0 && this.clock >= ai.next) {
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
      this.tickFlags(dt); this.tickNades(dt);
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
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.55;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, 1, 0.05, 1200);
camera.rotation.order = 'YXZ'; scene.add(camera);

// sky + sun + image-based lighting; the numbers come from the map theme (applyTheme)
const sky = new Sky(); sky.scale.setScalar(1000); scene.add(sky);
const sunDir = new THREE.Vector3(0, 1, 0);
const sun = new THREE.DirectionalLight('#ffe2b8', 2.6);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -62, right: 62, top: 62, bottom: -62, near: 10, far: 200 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
const hemi = new THREE.HemisphereLight('#cfd6de', '#6a635a', 0.3);
scene.add(sun, hemi);
scene.fog = new THREE.FogExp2('#b4bac0', 0.0028);
function applyTheme(t) {
  const [el, az] = t.sun || [40, 150];
  sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(el), THREE.MathUtils.degToRad(az));
  const [turb, ray] = t.sky || [5, 1.4], u = sky.material.uniforms;
  u.turbidity.value = turb; u.rayleigh.value = ray; u.mieCoefficient.value = 0.006; u.mieDirectionalG.value = 0.82; u.sunPosition.value.copy(sunDir);
  sun.color.set(t.sunColor || '#ffe2b8'); sun.intensity = t.sunI ?? 2.6; sun.position.copy(sunDir).multiplyScalar(90);
  const [hs, hg, hi] = t.hemi || ['#cfd6de', '#6a635a', 0.3]; hemi.color.set(hs); hemi.groundColor.set(hg); hemi.intensity = hi;
  const [fc, fd] = t.fog || ['#b4bac0', 0.0028]; scene.fog.color.set(fc); scene.fog.density = fd;
  renderer.toneMappingExposure = t.exposure ?? 0.55;
  // image-based lighting from a copy of the sky without the sun's glare, so white interiors are not blown out
  const pm = new THREE.PMREMGenerator(renderer), s2 = new THREE.Scene(), sk2 = new Sky(); sk2.scale.setScalar(1000); s2.add(sk2);
  const u2 = sk2.material.uniforms; u2.turbidity.value = 8; u2.rayleigh.value = 1.0; u2.mieCoefficient.value = 0.0005; u2.mieDirectionalG.value = 0.3; u2.sunPosition.value.copy(sunDir);
  if (scene.environment) scene.environment.dispose();
  scene.environment = pm.fromScene(s2, 0, 0.1, 1100).texture; scene.environmentIntensity = t.env ?? 0.12; pm.dispose();
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, 2, 2); gtao.output = GTAOPass.OUTPUT.Default;
gtao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1, thickness: 1, scale: 1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
gtao.blendIntensity = 0.85; composer.addPass(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.4, 1.0); composer.addPass(bloom);
composer.addPass(new OutputPass());
let gfxHigh = true;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

/* ---------- materials: photo-scanned CC0 PBR sets (assets/tex, from ambientcg.com) ---------- */
function hash2(x, y) { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const TL = new THREE.TextureLoader();
const NO_AO = new Set(['roof', 'plaster', 'asphalt', 'marble', 'steel', 'metal', 'rooftile', 'stucco', 'wood', 'rust', 'concrete3', 'facade', 'tiles']);
function pbr(name, o = {}, repeat = 1) {
  const load = (suf, srgb) => { const t = TL.load(`assets/tex/${name}_${suf}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.repeat.set(repeat, repeat); t.channel = 0; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const m = new THREE.MeshStandardMaterial({ map: load('c', true), normalMap: load('n'), roughnessMap: load('r'), roughness: 1, metalness: 0, ...o });
  if (!NO_AO.has(name)) { m.aoMap = load('ao'); m.aoMapIntensity = 0.7; }
  return m;
}
const P = {}; const mp = (n, o, rep = 1) => P[n + '@' + rep] || (P[n + '@' + rep] = pbr(n, o, rep));
const TINT = { plaster: { color: '#c9c4bb' }, stucco: { color: '#c4b59a' }, metal: { color: '#6a6f74', metalness: 0.9, roughness: 0.55 }, steel: { metalness: 0.8, roughness: 0.7 }, corrugated: { metalness: 0.35 }, rust: { metalness: 0.5, roughness: 0.8 } };
const tex = (n) => mp(n, TINT[n]);
// slab kinds: [+x, -x, top, bottom, +z, -z]
const COMPOSITE = {
  floor: ['concrete2', 'concrete2', 'carpet', 'ceiling', 'concrete2', 'concrete2'], floor2: ['stucco', 'stucco', 'planks2', 'wood', 'stucco', 'stucco'], floor3: ['concrete2', 'concrete2', 'concrete3', 'concrete', 'concrete2', 'concrete2'],
  floor4: ['stone', 'stone', 'tiles', 'wood', 'stone', 'stone'],
  deck: ['concrete2', 'concrete2', 'paving2', 'concrete2', 'concrete2', 'concrete2'], deck2: ['steel', 'steel', 'steel', 'steel', 'steel', 'steel'], deck3: ['wood', 'wood', 'planks2', 'wood', 'wood', 'wood'],
  roof: ['concrete2', 'concrete2', 'roof', 'ceiling', 'concrete2', 'concrete2'], roof2: ['stucco', 'stucco', 'rooftile', 'wood', 'stucco', 'stucco'], roof3: ['concrete2', 'concrete2', 'snow', 'concrete', 'concrete2', 'concrete2'],
};
const SPECIAL = {
  glass: () => ({ m: new THREE.MeshPhysicalMaterial({ color: '#7fa3b4', transparent: true, opacity: 0.22, roughness: 0.03, metalness: 0.1, envMapIntensity: 2.2, side: THREE.DoubleSide, depthWrite: false }), ts: 1 }),
  container: () => ({ m: tex('corrugated'), ts: 2.5, tint: ['#3d6e8f', '#8c4a3a', '#56704a', '#b08a3c', '#5b5f66'] }),
  crate: () => ({ m: tex('planks'), ts: 1.25 }), desk: () => ({ m: tex('planks'), ts: 1.25 }), grate: () => ({ m: tex('steel'), ts: 1.25 }),
  step: () => ({ m: tex('concrete2'), ts: 2.5 }), barrier: () => ({ m: tex('concrete2'), ts: 2.5 }), barrier2: () => ({ m: tex('concrete3'), ts: 2.5 }), planter: () => ({ m: tex('concrete2'), ts: 2.5 }),
  metal: () => ({ m: tex('metal'), ts: 1 }), hvac: () => ({ m: tex('steel'), ts: 1.25, tint: ['#8d9399', '#6e7479', '#9aa0a5', '#7b8286'] }),
  lamp: () => ({ m: new THREE.MeshStandardMaterial({ color: '#fff3dc', emissive: '#ffe9c4', emissiveIntensity: 3.5, roughness: 0.6 }), ts: 1 }),
  awning: () => ({ m: new THREE.MeshStandardMaterial({ color: '#8a3b2f', roughness: 0.95, side: THREE.DoubleSide }), ts: 1, tint: ['#8a3b2f', '#2f5a7a', '#6d6a3a', '#7a2f4a'] }),
};
const MATS = {};
function matFor(kind) {
  if (MATS[kind]) return MATS[kind];
  const k = SPECIAL[kind] ? SPECIAL[kind]() : COMPOSITE[kind] ? { m: COMPOSITE[kind].map(tex), ts: 2.5 } : { m: tex(kind), ts: 2.5 };
  return (MATS[kind] = k);
}

/* ---------- build the level ---------- */
// unit box whose UVs repeat once every `ts` metres on every face, so one texture serves every box size
function boxGeo(sx, sy, sz, ts) {
  const g = new THREE.BoxGeometry(sx, sy, sz), uv = g.attributes.uv, dims = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { const j = f * 4 + i; uv.setXY(j, uv.getX(j) * dims[f][0] / ts, uv.getY(j) * dims[f][1] / ts); }
  return g;
}
let world = null;
function buildWorld() {
  if (world) { scene.remove(world); world.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
  world = new THREE.Group(); scene.add(world);
  const T = M.theme, { MW, MH, CS } = M, d = new THREE.Object3D(), col = new THREE.Color();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(MW * CS, MH * CS), mp(T.ground || 'paving', TINT[T.ground], MW * CS / 2.5));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; world.add(floor);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), mp(T.outer || 'asphalt', TINT[T.outer], 300));
  outer.rotation.x = -Math.PI / 2; outer.position.y = T.outerY ?? -0.05; outer.receiveShadow = true; world.add(outer);
  if (T.outerY < -1) { // a building under a rooftop map: facade walls from the map edge down to the street
    const h = -T.outerY, fac = new THREE.Mesh(boxGeo(MW * CS + 0.2, h, MH * CS + 0.2, 3), mp('facade', { color: '#9aa0a8', roughness: 0.6, metalness: 0.2 })); fac.position.y = -h / 2 - 0.01; world.add(fac);
  }
  // group identical boxes (kind + size) into instanced meshes
  const groups = new Map();
  for (const b of M.boxes) { const key = `${b.kind}|${b.sx.toFixed(2)}|${b.sy.toFixed(2)}|${b.sz.toFixed(2)}`; (groups.get(key) || groups.set(key, []).get(key)).push(b); }
  for (const list of groups.values()) {
    const b0 = list[0], k = matFor(b0.kind);
    const im = new THREE.InstancedMesh(boxGeo(b0.sx, b0.sy, b0.sz, k.ts), k.m, list.length);
    im.castShadow = im.receiveShadow = b0.kind !== 'glass';
    list.forEach((b, i) => {
      d.position.set(b.x, b.y, b.z); d.updateMatrix(); im.setMatrixAt(i, d.matrix);
      if (k.tint) im.setColorAt(i, col.set(k.tint[(hash2(Math.round(b.x * 7), Math.round(b.z * 7)) * k.tint.length) | 0]));
    });
    world.add(im);
  }
  for (const l of M.lamps) { const pl = new THREE.PointLight('#ffe6c4', 10, 12, 1.7); pl.position.set(l.x, l.y - 0.3, l.z); world.add(pl); }
  if (T.skyline === 'city') { // distant blocks so the map does not float in emptiness
    const geos = [];
    for (let i = 0; i < 46; i++) {
      const a = i / 46 * Math.PI * 2 + hash2(i, 5) * 0.1, r = 85 + hash2(i, 1) * 60, w = 10 + hash2(i, 2) * 22, h = 8 + hash2(i, 3) * 30, g = boxGeo(w, h, 10 + hash2(i, 4) * 16, 3);
      d.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r); d.rotation.set(0, a, 0); d.scale.set(1, 1, 1); d.updateMatrix(); g.applyMatrix4(d.matrix); geos.push(g);
    }
    world.add(new THREE.Mesh(mergeGeometries(geos), mp('facade', { color: '#c3c8ce', roughness: 0.7, metalness: 0.15 })));
  } else if (T.skyline === 'hills') {
    const im = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7), new THREE.MeshStandardMaterial({ color: T.hillColor || '#55604c', roughness: 1 }), 28);
    for (let i = 0; i < 28; i++) {
      const a = i / 28 * Math.PI * 2 + hash2(i, 6) * 0.2, r = 150 + hash2(i, 1) * 90, w = 60 + hash2(i, 2) * 90, h = 18 + hash2(i, 3) * 40;
      d.position.set(Math.cos(a) * r, h / 2 - 1, Math.sin(a) * r); d.rotation.set(0, hash2(i, 7) * 6, 0); d.scale.set(w, h, w); d.updateMatrix(); im.setMatrixAt(i, d.matrix);
    }
    world.add(im);
  }
}

/* ---------- objective markers ---------- */
function ringMesh(color) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.9, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.03; g.add(disc); g.userData.mat = disc.material; return g;
}
const baseMark = { 1: ringMesh(TEAM_COL[1]), 2: ringMesh(TEAM_COL[2]) };
for (const t of [1, 2]) scene.add(baseMark[t]);
function loadMap(id) {
  const def = mapById(id); if (M && M.id === def.id) return;
  M = compile(def); applyTheme(M.theme); buildWorld();
  const ext = Math.max(M.MW, M.MH) * M.CS / 2 + 6; Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext }); sun.shadow.camera.updateProjectionMatrix();
  for (const t of [1, 2]) baseMark[t].position.set(M.BASE[t].x, 0, M.BASE[t].z);
}
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

/* ---------- soldiers: rigged, animated character (assets/models/soldier.glb, Mixamo "Vanguard") ---------- */
const gunMat = new THREE.MeshStandardMaterial({ color: '#17191c', roughness: 0.55, metalness: 0.35 });
const gearMat = new THREE.MeshStandardMaterial({ color: '#2b2e2a', roughness: 0.85 });
const steelMat = new THREE.MeshStandardMaterial({ color: '#3a3d42', roughness: 0.35, metalness: 0.85 });
const woodMat = new THREE.MeshStandardMaterial({ color: '#5a3b22', roughness: 0.7, metalness: 0 });
const lensMat = new THREE.MeshPhysicalMaterial({ color: '#1a3a66', roughness: 0.05, metalness: 0.2, clearcoat: 1 });
// weapon models built from primitives: receiver / handguard / barrel / sights / magazine / grip / stock per class (local z- is the muzzle)
function gunMesh(i) {
  const g = new THREE.Group(), w = WPN[i], L = w.len;
  const box = (sx, sy, sz, x, y, z, m = gunMat, rx = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); o.position.set(x, y, z); o.rotation.x = rx; o.castShadow = true; g.add(o); return o; };
  const cyl = (r, len, x, y, z, m = gunMat, along = 'z', r2 = r) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r2, len, 12), m); if (along === 'z') o.rotation.x = Math.PI / 2; else if (along === 'x') o.rotation.z = Math.PI / 2; o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
  const grip = (x, y, z, h = 0.11) => box(0.03, h, 0.045, x, y, z, gearMat, -0.3);
  const guard = (z) => box(0.03, 0.006, 0.07, 0, -0.045, z);
  const sights = (front, rear) => { box(0.008, 0.025, 0.008, 0, 0.05, front); box(0.03, 0.018, 0.015, 0, 0.047, rear); box(0.012, 0.012, 0.015, 0, 0.055, rear); };
  if (i === 0) { // assault rifle: railed handguard, flash hider, curved magazine, charging handle, collapsible stock
    box(0.05, 0.072, 0.26, 0, 0, -0.13); box(0.024, 0.012, 0.2, 0, 0.042, -0.14, steelMat);
    box(0.048, 0.05, 0.3, 0, -0.002, -0.41, gearMat); for (let k = 0; k < 6; k++) box(0.052, 0.008, 0.012, 0, 0.012, -0.3 - k * 0.045, steelMat);
    cyl(0.011, 0.22, 0, 0.004, -0.66); cyl(0.015, 0.06, 0, 0.004, -0.78, steelMat); box(0.016, 0.03, 0.03, 0, 0.004, -0.6, steelMat);
    box(0.034, 0.17, 0.065, 0, -0.1, -0.2, gearMat, 0.28); grip(0, -0.09, -0.02); guard(-0.1); sights(-0.55, -0.02);
    box(0.03, 0.01, 0.03, 0, 0.03, 0.02, steelMat); cyl(0.014, 0.2, 0, 0.0, 0.1, gearMat); box(0.04, 0.075, 0.1, 0, -0.01, 0.22, gearMat); box(0.045, 0.1, 0.025, 0, -0.02, 0.28, gearMat);
  } else if (i === 1) { // SMG: compact receiver, straight magazine, vertical foregrip, folding stock
    box(0.05, 0.07, 0.3, 0, 0, -0.12); box(0.03, 0.016, 0.24, 0, 0.04, -0.12, steelMat);
    cyl(0.013, 0.16, 0, 0.004, -0.34); cyl(0.02, 0.05, 0, 0.004, -0.42, steelMat);
    box(0.03, 0.14, 0.04, 0, -0.095, -0.12, gearMat, 0.1); grip(0, -0.09, 0.02); box(0.028, 0.08, 0.03, 0, -0.07, -0.22, gearMat); guard(-0.06); sights(-0.25, -0.02);
    box(0.012, 0.012, 0.22, 0.022, 0.0, 0.12, steelMat); box(0.012, 0.012, 0.22, -0.022, 0.0, 0.12, steelMat); box(0.045, 0.06, 0.02, 0, 0, 0.23, gearMat);
  } else if (i === 2) { // pump shotgun: long barrel over a tube magazine, wooden pump and stock
    box(0.05, 0.065, 0.22, 0, 0, -0.1, steelMat); cyl(0.013, 0.6, 0, 0.012, -0.5); cyl(0.013, 0.5, 0, -0.02, -0.46); cyl(0.016, 0.04, 0, 0.012, -0.79, steelMat);
    box(0.045, 0.045, 0.16, 0, -0.012, -0.36, woodMat); for (let k = 0; k < 5; k++) box(0.047, 0.047, 0.006, 0, -0.012, -0.3 - k * 0.03, gearMat);
    guard(-0.05); box(0.03, 0.01, 0.1, 0, -0.04, -0.05, steelMat); box(0.008, 0.012, 0.008, 0, 0.032, -0.78);
    box(0.04, 0.07, 0.12, 0, -0.025, 0.1, woodMat, 0.12); box(0.042, 0.1, 0.16, 0, -0.045, 0.24, woodMat, 0.12); box(0.045, 0.11, 0.02, 0, -0.05, 0.33, gearMat, 0.12);
  } else if (i === 3) { // bolt-action rifle: heavy barrel, scope, bolt handle, bipod, full stock
    box(0.045, 0.06, 0.3, 0, 0, -0.1, steelMat); cyl(0.014, 0.75, 0, 0.004, -0.6, steelMat, 'z', 0.011); cyl(0.018, 0.06, 0, 0.004, -0.98, steelMat);
    box(0.04, 0.05, 0.75, 0, -0.03, -0.55, gearMat); box(0.045, 0.1, 0.3, 0, -0.04, 0.17, gearMat, 0.08); box(0.045, 0.11, 0.02, 0, -0.05, 0.32, gearMat); grip(0, -0.1, 0.0, 0.12); guard(-0.06);
    box(0.03, 0.012, 0.3, 0, 0.034, -0.12, steelMat); cyl(0.022, 0.26, 0, 0.078, -0.12, gunMat); cyl(0.03, 0.06, 0, 0.078, -0.26, gunMat); cyl(0.028, 0.05, 0, 0.078, 0.02, gunMat);
    cyl(0.026, 0.004, 0, 0.078, -0.292, lensMat); cyl(0.024, 0.004, 0, 0.078, 0.047, lensMat); for (const z of [-0.2, 0.0]) box(0.016, 0.03, 0.02, 0, 0.055, z, steelMat);
    cyl(0.007, 0.06, 0.035, 0.012, 0.0, steelMat, 'x'); cyl(0.012, 0.02, 0.07, 0.012, 0.0, gearMat, 'x');
    for (const s of [-1, 1]) { const leg = cyl(0.005, 0.16, s * 0.03, -0.11, -0.72, steelMat); leg.rotation.x = 0; leg.rotation.z = s * 0.25; }
    box(0.03, 0.17, 0.05, 0, -0.1, -0.1, gearMat);
  } else { // pistol: slide over the frame, magazine in the grip, trigger guard
    box(0.036, 0.04, 0.2, 0, 0.015, -0.08, steelMat); box(0.034, 0.03, 0.17, 0, -0.012, -0.07, gearMat); cyl(0.008, 0.03, 0, 0.018, -0.19, steelMat);
    box(0.03, 0.12, 0.04, 0, -0.07, 0.0, gearMat, -0.25); box(0.03, 0.006, 0.045, 0, -0.03, -0.04); box(0.008, 0.012, 0.004, 0, 0.04, -0.17); box(0.03, 0.012, 0.012, 0, 0.04, 0.0);
    for (let k = 0; k < 5; k++) box(0.038, 0.016, 0.004, 0, 0.02, 0.0 - k * 0.008, gunMat);
  }
  return g;
}
// hand grenade: body, fuse head and spoon
function nadeMesh() {
  const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: '#3d4a2c', roughness: 0.6, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.033, 0.045, 3, 10), m); g.add(body);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8), steelMat); head.position.y = 0.065; g.add(head);
  const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.07, 0.016), steelMat); spoon.position.set(0.02, 0.03, 0); g.add(spoon);
  g.traverse((o) => { o.castShadow = true; }); return g;
}
let soldierAsset = null; const soldierQueue = [];
new GLTFLoader().load('assets/models/soldier.glb', (g) => { soldierAsset = g; soldierQueue.splice(0).forEach(dressSoldier); }, undefined, (e) => console.warn('soldier model failed to load', e));
function soldier() { const g = new THREE.Group(); g.userData = { team: '#888', ready: false }; if (soldierAsset) dressSoldier(g); else soldierQueue.push(g); return g; }
const GUN_POS = [8, 12, 4], GUN_ROT = [-1.4, 0.2, 1.5]; // in the hand bone's frame (centimetres)
function holdGun(u, i) {
  const hand = u.hand; if (!hand) return;
  if (u.gun) hand.remove(u.gun);
  u.gun = gunMesh(i); u.gun.scale.setScalar(100); u.gun.position.fromArray(GUN_POS); u.gun.rotation.fromArray(GUN_ROT); hand.add(u.gun); u.w = i;
}
function dressSoldier(g) {
  const model = SkeletonUtils.clone(soldierAsset.scene); model.rotation.y = Math.PI;
  const mats = {};
  model.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); mats[o.material.name] = o.material; o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  const mixer = new THREE.AnimationMixer(model), act = {};
  for (const c of soldierAsset.animations) if (c.name !== 'TPose') { const a = mixer.clipAction(c); a.play(); a.setEffectiveWeight(c.name === 'Idle' ? 1 : 0); act[c.name] = a; }
  mixer.update(Math.random() * 2); // desynchronise identical bots
  const bone = (n) => model.getObjectByName('mixamorig' + n);
  g.add(model);
  Object.assign(g.userData, { model, mixer, act, hand: bone('RightHand'), spine: bone('Spine1'), spine2: bone('Spine2'), hips: bone('Hips'), legs: ['Left', 'Right'].map((s) => [bone(s + 'UpLeg'), bone(s + 'Leg')]), body: mats.VanguardBodyMat, visor: mats.Vanguard_VisorMat, ready: true });
  holdGun(g.userData, g.userData.w || 0);
  applyTeam(g);
}
const _c = new THREE.Color();
function applyTeam(g, col) {
  const u = g.userData; if (col) u.team = col; if (!u.ready) return;
  _c.set(u.team);
  if (u.body) u.body.color.copy(_c).lerp(new THREE.Color('#ffffff'), 0.3); // uniform takes the team colour
  if (u.visor) { u.visor.color.copy(_c); u.visor.emissive.copy(_c); u.visor.emissiveIntensity = 1.4; }
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
// bullet holes (small dark decals on the hit face), impact sparks and dust by material, ejected casings
const holeTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 32; const c = cv.getContext('2d'); const gr = c.createRadialGradient(16, 16, 2, 16, 16, 16); gr.addColorStop(0, 'rgba(10,10,10,0.95)'); gr.addColorStop(0.5, 'rgba(20,20,20,0.7)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gr; c.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(cv); })();
const holes = Array.from({ length: 96 }, () => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), new THREE.MeshBasicMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })); m.visible = false; scene.add(m); return m; });
let holeI = 0; const _n = new THREE.Vector3();
const SURF = { carpet: 'carpet', floor: 'carpet', wood: 'wood', planks: 'wood', planks2: 'wood', siding: 'wood', crate: 'wood', desk: 'wood', floor2: 'wood', deck3: 'wood', grass: 'grass', dirt: 'grass', snow: 'snow', roof3: 'snow', steel: 'metal', metal: 'metal', deck2: 'metal', container: 'metal', hvac: 'metal', grate: 'metal', rust: 'metal', corrugated: 'metal', glass: 'glass' };
const surf = (kind) => kind === 'ground' ? (SURF[M.theme.ground] || 'concrete') : (SURF[kind] || 'concrete');
const IMPACT_COL = { concrete: '#d9d2c4', wood: '#9c7a4e', metal: '#ffd27a', carpet: '#b8a890', grass: '#8a7a4a', snow: '#ffffff', glass: '#cfe8ff' };
function impact(x, y, z, hi, vol = 0.5) {
  if (!hi || hi.kind === 'none') return;
  const s = surf(hi.kind), pos = [x, y, z];
  if (s !== 'glass') { const h = holes[holeI++ % holes.length]; h.position.set(x + hi.nx * 0.006, y + hi.ny * 0.006, z + hi.nz * 0.006); _n.set(x + hi.nx, y + hi.ny, z + hi.nz); h.lookAt(_n); h.rotation.z = Math.random() * 6.28; h.visible = true; }
  const pf = puffs[pfI++ % puffs.length]; pf.m.position.set(x + hi.nx * 0.05, y + hi.ny * 0.05, z + hi.nz * 0.05); pf.m.material.color.set(IMPACT_COL[s]); pf.m.visible = true; pf.t = s === 'metal' ? 0.5 : 0;
  if (s === 'metal') for (let k = 0; k < 3; k++) spark(x, y, z, hi);
  play('hit_' + (s === 'carpet' || s === 'grass' || s === 'snow' ? 'concrete' : s), { pos, vol: vol * (s === 'metal' ? 0.6 : 0.8), rate: s === 'snow' ? 0.8 : 1, ref: 5, max: 60 });
}
const sparkMat = new THREE.MeshBasicMaterial({ color: '#ffd080', transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }); sparkMat.color.multiplyScalar(3);
const sparks = Array.from({ length: 48 }, () => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.09), sparkMat); m.visible = false; scene.add(m); return { m, v: new THREE.Vector3(), t: 0 }; });
let spI = 0;
function spark(x, y, z, hi) {
  const s = sparks[spI++ % sparks.length]; s.m.position.set(x, y, z); s.m.visible = true; s.t = 0.25 + Math.random() * 0.2;
  s.v.set(hi.nx + (Math.random() - 0.5) * 1.6, hi.ny + Math.random() * 1.2, hi.nz + (Math.random() - 0.5) * 1.6).normalize().multiplyScalar(4 + Math.random() * 5);
}
const brassMat = new THREE.MeshStandardMaterial({ color: '#c9a24a', roughness: 0.3, metalness: 0.9 }), shellMat = new THREE.MeshStandardMaterial({ color: '#b8362a', roughness: 0.6 });
const casings = Array.from({ length: 32 }, () => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.032, 6), brassMat); m.visible = false; scene.add(m); return { m, v: new THREE.Vector3(), t: 0, g: 0 }; });
let caI = 0;
function ejectCasing(x, y, z, rx, rz, shotgun) {
  const c = casings[caI++ % casings.length]; c.m.material = shotgun ? shellMat : brassMat; c.m.scale.setScalar(shotgun ? 1.8 : 1);
  c.m.position.set(x, y, z); c.m.rotation.set(Math.random() * 3, Math.random() * 3, 0); c.m.visible = true; c.t = 1.4; c.g = Math.max(0, M.groundAt(x, z, y, 0.05) );
  c.v.set(rx * 2.2 + (Math.random() - 0.5), 1.6 + Math.random() * 0.8, rz * 2.2 + (Math.random() - 0.5));
}
// grenades: every peer simulates the same fixed-step physics from the same throw, so explosions agree without network updates
const NADE = { fuse: 3.2, radius: 7.5, dmg: 115, speed: 15 };
const nades = [];
function nadeStep(n, h) { // h = fixed step
  n.vy -= 20 * h; let bounced = 0;
  const nx = n.x + n.vx * h; if (M.blockedAt(nx, n.z, n.y + 0.02, 0.14, 0.07, 0)) { n.vx *= -0.45; n.vz *= 0.85; bounced = Math.abs(n.vx); } else n.x = nx;
  const nz = n.z + n.vz * h; if (M.blockedAt(n.x, nz, n.y + 0.02, 0.14, 0.07, 0)) { n.vz *= -0.45; n.vx *= 0.85; bounced = Math.max(bounced, Math.abs(n.vz)); } else n.z = nz;
  n.y += n.vy * h;
  if (n.vy > 0) { const c = M.ceilingAt(n.x, n.z, n.y, 0.07, 0); if (n.y + 0.16 > c) { n.y = c - 0.16; n.vy *= -0.4; bounced = Math.max(bounced, 1); } }
  const g = M.groundAt(n.x, n.z, n.y + 0.35, 0.07, 0);
  if (n.y <= g) { n.y = g; if (n.vy < -1.6) { bounced = Math.max(bounced, -n.vy); n.vy *= -0.42; n.vx *= 0.75; n.vz *= 0.75; } else { n.vy = 0; const f = Math.pow(0.03, h); n.vx *= f; n.vz *= f; } }
  n.spin += (Math.abs(n.vx) + Math.abs(n.vz)) * h * 6;
  return bounced;
}
function spawnNade(owner, o, v) {
  const n = { owner, x: o[0], y: o[1], z: o[2], vx: v[0], vy: v[1], vz: v[2], t: 0, acc: 0, spin: 0, mesh: nadeMesh(), done: false };
  scene.add(n.mesh); nades.push(n); play('click', { pos: o, vol: 0.5, rate: 1.5 }); return n;
}
function updateNades(dt) {
  for (const n of nades) {
    n.acc += dt;
    while (n.acc >= 1 / 120 && !n.done) {
      n.acc -= 1 / 120; n.t += 1 / 120;
      const b = nadeStep(n, 1 / 120); if (b > 2.5) play('nade_bounce', { pos: [n.x, n.y, n.z], vol: Math.min(1, b / 10), ref: 4, max: 50 });
      if (n.t >= NADE.fuse) { n.done = true; explode(n.x, n.y + 0.1, n.z); }
    }
    n.mesh.position.set(n.x, n.y + 0.06, n.z); n.mesh.rotation.set(n.spin, n.spin * 0.7, 0.3);
  }
  for (let i = nades.length - 1; i >= 0; i--) if (nades[i].done) { scene.remove(nades[i].mesh); nades.splice(i, 1); }
}
const boomMat = () => new THREE.SpriteMaterial({ color: '#f0a040', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
const booms = Array.from({ length: 6 }, () => { const m = new THREE.Sprite(boomMat()); m.visible = false; scene.add(m); return { m, t: 1 }; });
const smokes = Array.from({ length: 24 }, () => { const m = new THREE.Sprite(puffMat()); m.visible = false; scene.add(m); return { m, t: 1, v: new THREE.Vector3() }; });
let boI = 0, smI = 0, shake = 0;
const boomLight = new THREE.PointLight('#ffb060', 0, 18, 1.5); scene.add(boomLight);
function explode(x, y, z) {
  const b = booms[boI++ % booms.length]; b.m.position.set(x, y + 0.4, z); b.m.visible = true; b.t = 0;
  for (let k = 0; k < 8; k++) { const s = smokes[smI++ % smokes.length]; s.m.position.set(x, y + 0.3, z); s.m.material.color.set(k < 3 ? '#6e6a62' : '#3a3836'); s.m.visible = true; s.t = -k * 0.03; s.v.set((Math.random() - 0.5) * 5, 2 + Math.random() * 3, (Math.random() - 0.5) * 5); }
  for (let k = 0; k < 10; k++) spark(x, y + 0.2, z, { nx: (Math.random() - 0.5), ny: 1, nz: (Math.random() - 0.5) });
  for (let k = 0; k < 4; k++) { const h = holes[holeI++ % holes.length]; h.position.set(x + (Math.random() - 0.5) * 1.2, M.groundAt(x, z, y + 0.3, 0.1) + 0.01, z + (Math.random() - 0.5) * 1.2); h.rotation.set(-Math.PI / 2, 0, Math.random() * 6); h.scale.setScalar(4 + Math.random() * 3); h.visible = true; }
  boomLight.position.set(x, y + 0.6, z); boomLight.intensity = 90;
  const d = Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z);
  shake = Math.max(shake, clamp(1 - d / 28, 0, 1) * 0.9);
  play('explode', { pos: [x, y, z], vol: 1.3, ref: 14, max: 260, rate: 0.9 });
  if (AC) { const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(25, t + 0.5); g.gain.setValueAtTime(clamp(1.2 - d / 40, 0, 1.2), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7); o.connect(g).connect(master); o.start(t); o.stop(t + 0.7); }
}
function throwNade() {
  if (!me.alive || me.nades <= 0 || me.throwT > 0 || me.reload > 0) return;
  camera.updateMatrixWorld(); camera.matrixWorld.extractBasis(_r, _u, _f); _f.negate();
  const o = [r2(camera.position.x + _f.x * 0.5), r2(camera.position.y + _f.y * 0.5 - 0.1), r2(camera.position.z + _f.z * 0.5)];
  const v = [r2(_f.x * NADE.speed + me.vx * 0.5), r2(_f.y * NADE.speed + 3), r2(_f.z * NADE.speed + me.vz * 0.5)];
  me.nades--; me.throwT = 0.9; me.draw = Math.max(me.draw, 0.45);
  toHost({ t: 'nade', o, v });
}
// first-person weapon
const vm = new THREE.Group(); camera.add(vm);
const vmGun = new THREE.Group(); vm.add(vmGun);
const flashMat = new THREE.MeshBasicMaterial({ color: '#ffcf80', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }); flashMat.color.multiplyScalar(4);
const flash = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), flashMat); vm.add(flash);
const flashLight = new THREE.PointLight('#ffb866', 0, 9); camera.add(flashLight); flashLight.position.set(0.15, -0.1, -0.8);
function buildViewModel(i) {
  vmGun.clear(); const w = WPN[i], L = w.len;
  vmGun.add(gunMesh(i));
  const hand = new THREE.Mesh(new THREE.CapsuleGeometry(0.032, 0.1, 3, 8), gearMat); hand.rotation.z = Math.PI / 2; hand.position.set(0, -0.055, -Math.min(L * 0.6, 0.42)); vmGun.add(hand);
  flash.position.set(0.16, -0.13, -0.38 - L * 1.25);
}

/* ---------- audio: recorded CC0 effects (assets/sfx) played through a 3D panner, with synthesized fallbacks ---------- */
let AC = null, noiseBuf = null, master = null;
const SFX = {}; // name -> AudioBuffer[]
const SFX_SETS = { rifle: 2, smg: 3, shotgun: 2, sniper: 2, pistol: 2, step_concrete: 4, step_wood: 4, step_grass: 4, step_snow: 4, step_carpet: 4, hit_concrete: 3, hit_metal: 3, hit_wood: 3, hit_glass: 3, hit_flesh: 3, nade_bounce: 3, click: 3, explode: 3 };
const WPN_SFX = ['rifle', 'smg', 'shotgun', 'sniper', 'pistol'];
function audioInit() {
  if (AC) return; try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  master = AC.createGain(); master.gain.value = 0.9; master.connect(AC.destination);
  noiseBuf = AC.createBuffer(1, AC.sampleRate * 0.6, AC.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  for (const [n, k] of Object.entries(SFX_SETS)) { SFX[n] = []; for (let i = 0; i < k; i++) fetch(`assets/sfx/${n}${i}.m4a`).then((r) => r.arrayBuffer()).then((b) => AC.decodeAudioData(b)).then((buf) => { SFX[n][i] = buf; }).catch(() => {}); }
}
// play a sample; pos = [x,y,z] places it in the world (null = at the listener)
function play(name, { pos = null, vol = 1, rate = 1, ref = 6, max = 90, delay = 0 } = {}) {
  if (!AC) return null; const set = SFX[name], bufs = set && set.filter(Boolean); if (!bufs || !bufs.length) return null;
  const src = AC.createBufferSource(); src.buffer = bufs[(Math.random() * bufs.length) | 0]; src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
  const g = AC.createGain(); g.gain.value = vol;
  if (pos) {
    const p = AC.createPanner(); p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = ref; p.maxDistance = max; p.rolloffFactor = 1.2;
    if (p.positionX) { p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2]; } else p.setPosition(pos[0], pos[1], pos[2]);
    src.connect(g).connect(p).connect(master);
  } else src.connect(g).connect(master);
  src.start(AC.currentTime + delay); return src;
}
const _lf = new THREE.Vector3(), _lu = new THREE.Vector3(), _lr = new THREE.Vector3();
function updateListener() {
  if (!AC) return; const l = AC.listener, p = camera.position; camera.matrixWorld.extractBasis(_lr, _lu, _lf); _lf.negate();
  if (l.positionX) { l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z; l.forwardX.value = _lf.x; l.forwardY.value = _lf.y; l.forwardZ.value = _lf.z; l.upX.value = _lu.x; l.upY.value = _lu.y; l.upZ.value = _lu.z; }
  else { l.setPosition(p.x, p.y, p.z); l.setOrientation(_lf.x, _lf.y, _lf.z, _lu.x, _lu.y, _lu.z); }
}
function footstep(x, y, z, vol, pos) {
  const s = surf(M.groundKindAt(x, z, y, 0.2)), base = s === 'metal' || s === 'glass' ? 'step_concrete' : 'step_' + s;
  play(base, { pos, vol, rate: s === 'metal' ? 1.15 : 1, ref: 3, max: 40 });
  if (s === 'metal') play('hit_metal', { pos, vol: vol * 0.35, rate: 1.7, ref: 3, max: 40 });
}
function sndShot(wi, dist, pos) {
  if (play(WPN_SFX[wi] || 'rifle', { pos, vol: pos ? 1 : 0.75, ref: 10, max: 200, rate: wi === 3 ? 0.95 : 1 })) return;
  if (!AC) return; const w = WPN[wi] || WPN[0], t = AC.currentTime, vol = 0.5 / (1 + dist / 14);
  const src = AC.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 0.7 + w.pitch * 0.5;
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(5200 * w.pitch + 800, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.22);
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16 + 0.12 / w.pitch);
  src.connect(lp).connect(g).connect(master); src.start(t); src.stop(t + 0.4);
  const o = AC.createOscillator(), og = AC.createGain(); o.frequency.setValueAtTime(150 * w.pitch, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.1);
  og.gain.setValueAtTime(vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.connect(og).connect(master); o.start(t); o.stop(t + 0.13);
}
function sndBeep(f, dur = 0.06, vol = 0.12, type = 'square') {
  if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g).connect(master); o.start(t); o.stop(t + dur);
}

/* =====================================================================
   CLIENT — local player, replicated world, HUD
   ===================================================================== */
const me = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, cr: false, alive: false, hp: 100, w: 0, ammo: [], res: [], next: 0, reload: 0, draw: 0,
  lean: 0, eye: 1.62, bloom: 0, kickV: 0, ads: 0, deadT: 0, respawnIn: 0, trig: false, stride: 0, wasGround: true, fallV: 0, nades: 3, throwT: 0 };
const K = {}; let mouseL = false, mouseR = false, sens = 1, inGame = false;
const Client = {
  id: 0, mode: 'dm', roster: new Map(), ents: new Map(), flags: [], scores: [0, 0, 0], time: 0, phase: 'live', lastSeq: 0, stats: new Map(),
  onMsg(m) {
    switch (m.t) {
      case 'welcome': this.id = m.id; this.mode = m.mode; this.lastSeq = 0; loadMap(m.map); enterGame(m.code); break;
      case 'roster': this.roster.clear(); for (const [id, name, team, bot] of m.list) this.roster.set(id, { name, team, bot }); this.syncEnts(); break;
      case 's': this.snap(m); break;
      case 'spawn': if (m.id === this.id) localSpawn(m); else { const e = this.ents.get(m.id); if (e) { e.x = e.tx = m.x; e.z = e.tz = m.z; e.y = e.ty = m.y || 0; } } break;
      case 'fire': this.remoteFire(m); break;
      case 'nade': spawnNade(m.id, m.o, m.v); break;
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
      if (!e) { e = { id, mesh: soldier(), x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0, tyaw: 0, pitch: 0, alive: false, cr: false, hp: 0, w: 0, spd: 0, tag: null, stride: 0 }; e.mesh.visible = false; scene.add(e.mesh); this.ents.set(id, e); }
      const col = r.team ? TEAM_COL[r.team] : `hsl(${(id * 67) % 360},32%,42%)`;
      applyTeam(e.mesh, col);
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
    const d = Math.hypot(e.x - me.x, e.z - me.z), ey = e.y + (e.cr ? 0.95 : 1.3); sndShot(m.w, d, [e.x, ey, e.z]);
    const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
    ejectCasing(e.x + fx * 0.3 + fz * 0.25, ey + 0.05, e.z + fz * 0.3 - fx * 0.25, fz, -fx, m.w === 2);
    for (const p of m.es || []) {
      const ox = e.x + fx * 0.6, oz = e.z + fz * 0.6, dx = p[0] - ox, dy = p[1] - ey, dz = p[2] - oz, L = Math.hypot(dx, dy, dz) || 1;
      tracer(ox, ey, oz, p[0], p[1], p[2]);
      if (M.rayMap(ox, ey, oz, dx / L, dy / L, dz / L, L + 0.4) >= L + 0.3) play('hit_flesh', { pos: p, vol: 0.5, ref: 4, max: 40 }); else impact(p[0], p[1], p[2], M.hitInfo(), 0.4);
    }
  },
  onKill(m) {
    const a = m.a ? this.name(m.a) : '', v = this.name(m.v), el = document.createElement('div');
    el.innerHTML = (a ? `<span class="t${this.team(m.a)}">${esc(a)}</span> <span style="color:var(--dim)">[${m.w === 5 ? 'Grenade' : WPN[m.w].s}${m.hs ? ' · headshot' : ''}]</span> ` : '') + `<span class="t${this.team(m.v)}">${esc(v)}</span>` + (a ? '' : ' <span style="color:var(--dim)">died</span>');
    const f = $('#feed'); f.prepend(el); while (f.children.length > 5) f.lastChild.remove(); setTimeout(() => el.remove(), 6000);
    if (m.v === this.id) { me.respawnIn = m.rs; me.killer = a; }
    if (m.a === this.id) sndBeep(880, 0.12, 0.12, 'sine');
  },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let msgTimer = 0;
function announce(text, team) { const el = $('#msg'); el.textContent = text; el.style.color = team ? TEAM_COL[team] : ''; el.style.opacity = 1; clearTimeout(msgTimer); msgTimer = setTimeout(() => { el.style.opacity = 0; }, 3200); }

function localSpawn(m) {
  Object.assign(me, { x: m.x, y: m.y || 0, z: m.z, vx: 0, vy: 0, vz: 0, yaw: m.yaw, pitch: 0, alive: true, hp: 100, reload: 0, bloom: 0, lean: 0, deadT: 0, nades: 3, throwT: 0, stride: 0 });
  me.ammo = WPN.map((w) => w.mag); me.res = WPN.map((w) => w.res); setWeapon(0, true);
  if (TEST && Q.get('pos')) { const [x, y, z, yaw, pitch] = Q.get('pos').split(',').map(Number); Object.assign(me, { x, y, z, yaw: yaw || 0, pitch: pitch || 0 }); }
  $('#dead').style.display = 'none';
}
function localDie() { me.alive = false; me.deadT = 0; me.reload = 0; mouseL = false; sndBeep(60, 0.4, 0.25, 'sawtooth'); }
function setWeapon(i, force) { if (i === me.w && !force) return; me.w = i; me.reload = 0; me.draw = 0.3; buildViewModel(i); }

/* ---------- local movement ---------- */
const R = 0.32, H_STAND = 1.75, H_CROUCH = 1.15;
const locked = () => TEST || document.pointerLockElement === canvas;
function updateMe(dt) {
  const act = me.alive && locked();
  let f = 0, s = 0;
  if (act) { f = (K.w ? 1 : 0) - (K.s ? 1 : 0); s = (K.d ? 1 : 0) - (K.a ? 1 : 0); }
  // crouch on request, and stay crouched while something is too low to stand under (window sills, under stairs)
  me.cr = (act && !!K.c) || (me.cr && me.alive && M.ceilingAt(me.x, me.z, me.y, R) < me.y + H_STAND + 0.05);
  const bh = me.cr ? H_CROUCH : H_STAND;
  const sp = me.cr ? 2.6 : K.shift ? 3 : 5.6, sy = Math.sin(me.yaw), cy = Math.cos(me.yaw);
  let wx = -sy * f + cy * s, wz = -cy * f - sy * s; const wl = Math.hypot(wx, wz); if (wl > 0) { wx /= wl; wz /= wl; }
  // ladders: grab when facing the rungs (or already part-way up); W climbs, S descends
  const lad = act ? M.ladderAt(me.x, me.z) : null;
  const onLad = !!lad && me.y <= lad.y1 + 0.02 && (me.y > lad.y0 + 0.2 || (-sy * lad.nx - cy * lad.nz) > 0.4);
  const acc = Math.min(1, dt * (me.onGround ? 12 : 2.5));
  me.vx += (wx * sp - me.vx) * acc; me.vz += (wz * sp - me.vz) * acc;
  if (!me.alive) { me.vx = me.vz = 0; }
  if (act && K[' '] && me.onGround && !onLad) { me.vy = 6.9; me.onGround = false; }
  const feet = me.y;
  const nx = me.x + me.vx * dt; if (!M.blockedAt(nx, me.z, me.y, bh, R)) me.x = nx; else me.vx = 0;
  const nz = me.z + me.vz * dt; if (!M.blockedAt(me.x, nz, me.y, bh, R)) me.z = nz; else me.vz = 0;
  if (onLad) { me.vy = f > 0 ? 3.4 : f < 0 ? -3.4 : 0; me.onGround = true; }
  else me.vy = Math.max(-25, me.vy - 22 * dt);
  me.y += me.vy * dt;
  if (me.vy > 0) { const c = M.ceilingAt(me.x, me.z, feet, R); if (me.y + bh > c) { me.y = Math.max(feet, c - bh); me.vy = 0; } }
  const g = M.groundAt(me.x, me.z, Math.max(feet, me.y), R);
  if (me.y <= g) { me.y = g; if (me.vy < 0) me.vy = 0; me.onGround = true; } else if (!onLad) me.onGround = false;
  // footsteps by surface and pace; a heavy double step when landing from a fall
  if (me.alive) {
    const hs2 = Math.hypot(me.vx, me.vz);
    if (me.onGround && !onLad && hs2 > 0.6) { me.stride += hs2 * dt; if (me.stride >= (me.cr ? 0.9 : 1.3)) { me.stride = 0; footstep(me.x, me.y, me.z, me.cr ? 0.22 : K.shift ? 0.4 : 0.7, null); } }
    if (me.onGround && !me.wasGround && me.fallV < -3) { footstep(me.x, me.y, me.z, 0.9, null); play('click', { vol: 0.15, rate: 0.6, delay: 0.06 }); }
    if (!me.onGround) me.fallV = me.vy; me.wasGround = me.onGround;
  }

  // camera
  const wantLean = act ? (K.e ? 1 : 0) - (K.q ? 1 : 0) : 0; me.lean += (wantLean - me.lean) * Math.min(1, dt * 10);
  me.eye += ((me.cr ? 1.05 : 1.62) - me.eye) * Math.min(1, dt * 12);
  let lx = cy * me.lean * 0.5, lz = -sy * me.lean * 0.5;
  if (M.solidAt(me.x + lx * 1.3, me.y + me.eye, me.z + lz * 1.3)) { lx = lz = 0; }
  shake *= Math.exp(-dt * 5);
  if (me.alive) { camera.position.set(me.x + lx, me.y + me.eye, me.z + lz); camera.rotation.set(me.pitch + (Math.random() - 0.5) * shake * 0.12, me.yaw + (Math.random() - 0.5) * shake * 0.12, -me.lean * 0.16 + (Math.random() - 0.5) * shake * 0.08); }
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
  if (me.reload > 0) { me.reload -= dt; if (me.reload <= 0) { const n = Math.min(w.mag - me.ammo[me.w], me.res[me.w]); me.ammo[me.w] += n; me.res[me.w] -= n; } }
  me.throwT = Math.max(0, me.throwT - dt);
  if (!mouseL) me.trig = false;
  if (act && mouseL && me.reload <= 0 && me.draw <= 0 && me.next <= 0 && (w.auto || !me.trig)) {
    if (me.ammo[me.w] > 0) fire(w); else { if (me.res[me.w] <= 0) play('click', { vol: 0.4, rate: 0.7 }); startReload(); me.trig = true; }
  }
  // view model pose
  const moving = Math.hypot(me.vx, me.vz), bob = me.onGround ? Math.sin(performance.now() * 0.011) * moving * 0.0035 : 0;
  const hip = new THREE.Vector3(0.16, -0.15 + bob - me.draw * 0.5, -0.3 + me.kickV), aim = new THREE.Vector3(0, -0.085, -0.22 + me.kickV);
  const rp = me.reload > 0 ? 1 - me.reload / w.rel : 0, rs = Math.sin(rp * Math.PI);
  vmGun.position.copy(hip).lerp(aim, me.ads); vmGun.position.y -= rs * 0.08; vmGun.position.x += rs * 0.03;
  vmGun.rotation.set(me.kickV * 1.5 - rs * 0.55, rs * 0.25 + (me.throwT > 0 ? -0.4 * Math.sin(me.throwT / 0.9 * Math.PI) : 0), rs * 0.35);
  flashMat.opacity *= Math.exp(-dt * 40); flashLight.intensity *= Math.exp(-dt * 40);
}
function startReload() {
  const w = WPN[me.w]; if (me.reload > 0 || me.ammo[me.w] >= w.mag || me.res[me.w] <= 0) return; me.reload = w.rel;
  play('click', { vol: 0.5, rate: 0.8 }); play('click', { vol: 0.6, rate: 1.1, delay: w.rel * 0.55 }); play('hit_metal', { vol: 0.35, rate: 1.4, delay: w.rel * 0.85 });
}
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
    let best = M.rayMap(o[0], o[1], o[2], d.x, d.y, d.z, 140), hitE = null, hs = false; const hi = { ...M.hitInfo() };
    for (const e of Client.ents.values()) {
      if (!e.alive || !Client.hostile(e.id)) continue;
      const h = e.cr ? 1.25 : 1.8;
      const th = raySphere(o, dv, [e.x, e.y + h - 0.13, e.z], 0.17), tb = rayBox(o, dv, [e.x - 0.3, e.y, e.z - 0.3], [e.x + 0.3, e.y + h - 0.28, e.z + 0.3]);
      const t = Math.min(th, tb); if (t < best) { best = t; hitE = e; hs = th <= tb; }
    }
    const ex = o[0] + d.x * best, ey = o[1] + d.y * best, ez = o[2] + d.z * best; es.push([r2(ex), r2(ey), r2(ez)]);
    tracer(mz.x, mz.y, mz.z, ex, ey, ez, !!hitE);
    if (hitE) { const h = hits.get(hitE.id) || { n: 0, hs: false }; h.n++; h.hs = h.hs || hs; hits.set(hitE.id, h); if (i === 0) play('hit_flesh', { pos: [ex, ey, ez], vol: 0.6, ref: 4, max: 40 }); }
    else if (i === 0 || w.pellets) impact(ex, ey, ez, hi, i === 0 ? 0.5 : 0.15);
  }
  ejectCasing(camera.position.x + _r.x * 0.22 + _f.x * 0.3, camera.position.y - 0.08, camera.position.z + _r.z * 0.22 + _f.z * 0.3, _r.x, _r.z, !!w.pellets);
  toHost({ t: 'fire', w: me.w, es });
  for (const [id, h] of hits) toHost({ t: 'hit', id, n: h.n, hs: h.hs ? 1 : 0, w: me.w, o: [r2(o[0]), r2(o[1]), r2(o[2])] });
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
    const spd = Math.hypot(e.x - px, e.z - pz) / Math.max(dt, 0.001); e.spd += (spd - e.spd) * Math.min(1, dt * 8);
    if (e.spd > 0.8) { e.stride += e.spd * dt; if (e.stride >= (e.cr ? 0.9 : 1.3)) { e.stride = 0; footstep(e.x, e.y, e.z, e.cr ? 0.25 : e.spd > 4 ? 0.8 : 0.45, [e.x, e.y, e.z]); } }
    if (!u.ready) continue;
    if (u.w !== e.w) holdGun(u, e.w);
    // blend idle / walk / run by speed, then layer aim pitch and crouch on top of the animation
    const run = clamp((e.spd - 2.6) / 2.4, 0, 1), walk = clamp(e.spd / 1.2, 0, 1) * (1 - run);
    u.act.Idle.setEffectiveWeight(1 - Math.max(walk, run)); u.act.Walk.setEffectiveWeight(walk); u.act.Run.setEffectiveWeight(run);
    u.act.Walk.setEffectiveTimeScale(clamp(e.spd / 1.7, 0.6, 1.4)); u.act.Run.setEffectiveTimeScale(clamp(e.spd / 5.4, 0.7, 1.3));
    u.mixer.update(dt);
    const pitch = clamp(e.pitch, -0.9, 0.9);
    if (u.spine) u.spine.rotation.x -= pitch * 0.45; if (u.spine2) u.spine2.rotation.x -= pitch * 0.35;
    if (e.cr) { u.hips.position.y -= 42; u.hips.rotation.x += 0.35; for (const [up, low] of u.legs) { if (up) up.rotation.x -= 1.0; if (low) low.rotation.x += 1.7; } }
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
  updateNades(dt);
  for (const s of sparks) if (s.m.visible) { s.t -= dt; s.v.y -= 12 * dt; s.m.position.addScaledVector(s.v, dt); _n.copy(s.m.position).add(s.v); s.m.lookAt(_n); if (s.t <= 0) s.m.visible = false; }
  for (const c of casings) if (c.m.visible) { c.t -= dt; c.v.y -= 14 * dt; c.m.position.addScaledVector(c.v, dt); c.m.rotation.x += dt * 14; if (c.m.position.y < c.g + 0.01) { c.m.position.y = c.g + 0.01; if (c.v.y < -0.8) { c.v.y *= -0.35; c.v.x *= 0.6; c.v.z *= 0.6; play('click', { pos: [c.m.position.x, c.m.position.y, c.m.position.z], vol: 0.08, rate: 2.2, ref: 2, max: 12 }); } else { c.v.set(0, 0, 0); } } if (c.t <= 0) c.m.visible = false; }
  for (const b of booms) if (b.m.visible) { b.t += dt * 3.2; const s = 1.2 + b.t * 5; b.m.scale.set(s, s, 1); b.m.material.opacity = Math.max(0, 1.4 * (1 - b.t)); if (b.t >= 1) b.m.visible = false; }
  for (const s of smokes) if (s.m.visible) { s.t += dt * 0.55; if (s.t < 0) continue; s.v.y = Math.max(0.4, s.v.y - dt * 1.5); s.v.x *= 0.98; s.v.z *= 0.98; s.m.position.addScaledVector(s.v, dt); const sc = 1 + s.t * 5; s.m.scale.set(sc, sc, 1); s.m.material.opacity = Math.max(0, 0.75 * (1 - s.t)); if (s.t >= 1) s.m.visible = false; }
  boomLight.intensity *= Math.exp(-dt * 7);
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
  $('#ammo').innerHTML = (me.reload > 0 ? `<small>RELOADING</small>` : `${me.ammo[me.w] ?? 0}<small> / ${me.res[me.w] ?? 0}</small>`) + `<small> &nbsp;·&nbsp; G ×${me.nades}</small>`;
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
  $('#score').innerHTML = score; $('#sub').textContent = MODE_NAME[C.mode] + ' · ' + M.name + ' · ' + fmtTime(C.time) + (C.phase !== 'live' ? ' · intermission' : ''); $('#obj').innerHTML = obj;
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
  if (k === 'g') throwNade();
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
$('#map').innerHTML = MAPS.map((m) => `<option value="${m.id}">${m.name} — ${m.desc}</option>`).join('');
$('#map').addEventListener('change', (e) => { if (!inGame) loadMap(e.target.value); });
$('#modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; pickMode = b.dataset.m; document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x === b)); });
$('#createBtn').addEventListener('click', () => {
  audioInit(); status('Creating match…');
  netHost(() => Host.start(pickMode, +$('#bots').value, myName(), $('#map').value), status);
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
// ?test[&mode=ctf&bots=4&pos=x,y,z,yaw,pitch] — offline practice match (no matchmaking), also used for screenshots
if (TEST) { Net.isHost = true; Net.code = 'TEST0'; Host.start(Q.get('mode') || 'dm', +(Q.get('bots') ?? 4), 'Tester', Q.get('map')); }
else loadMap(MAPS[0].id);

/* ---------- main loop ---------- */
let last = performance.now(), sendAcc = 0, menuT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (inGame) {
    updateMe(dt); updateEnts(dt); updateFx(dt); updateHud(dt); updateListener();
    sendAcc += dt;
    if (sendAcc >= 0.05 && me.alive) { sendAcc = 0; toHost({ t: 'in', x: r2(me.x), y: r2(me.y), z: r2(me.z), yaw: r2(me.yaw), pitch: r2(me.pitch), cr: me.cr ? 1 : 0, w: me.w }); }
  } else { // slow orbit behind the menu
    updateFx(dt);
    menuT += dt * 0.05; camera.position.set(Math.cos(menuT) * 46, 20, Math.sin(menuT) * 46); camera.lookAt(0, 1, 0); vm.visible = false;
  }
  if (gfxHigh) composer.render(); else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__g = { Host, Client, Net, me, toHost, get M() { return M; }, WPN, loadMap };
