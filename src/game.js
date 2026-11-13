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
  on: false, players: new Map(), mode: 'dm', map: 'campus', scores: [0, 0, 0], time: 0, phase: 'live', phaseT: 0, flags: [], seq: 0, snapAcc: 0, last: 0,
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
    p.hp = 100; p.alive = true; p.ai.path = null; p.ai.target = null;
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
    else if (m.t === 'team') { if (this.mode !== 'dm') { if (p.alive) this.kill(p, null, 0, 0); p.team = 3 - p.team; this.roster(); this.say(p.name + ' switched to ' + TEAM_NAME[p.team]); } }
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
function gunMesh(i) {
  const g = new THREE.Group(), w = WPN[i], L = w.len;
  const part = (sx, sy, sz, x, y, z, m = gunMat) => { const o = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
  part(0.045, 0.07, L, 0, 0, -L / 2);                                   // receiver + barrel
  part(0.03, 0.03, L * 0.45, 0, 0.01, -L - L * 0.2);                    // muzzle
  part(0.04, 0.13, 0.06, 0, -0.09, -0.06);                              // grip
  if (i !== 4) part(0.05, 0.08, 0.26, 0, -0.01, 0.13, gearMat);         // stock
  if (i < 2) part(0.035, 0.16, 0.07, 0, -0.1, -L * 0.45);               // magazine
  if (i === 3) { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.3, 10), gunMat); s.rotation.x = Math.PI / 2; s.position.set(0, 0.075, -0.25); g.add(s); }
  return g;
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
      case 'welcome': this.id = m.id; this.mode = m.mode; this.lastSeq = 0; loadMap(m.map); enterGame(m.code); break;
      case 'roster': this.roster.clear(); for (const [id, name, team, bot] of m.list) this.roster.set(id, { name, team, bot }); this.syncEnts(); break;
      case 's': this.snap(m); break;
      case 'spawn': if (m.id === this.id) localSpawn(m); else { const e = this.ents.get(m.id); if (e) { e.x = e.tx = m.x; e.z = e.tz = m.z; e.y = e.ty = m.y || 0; } } break;
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
      if (!e) { e = { id, mesh: soldier(), x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0, tyaw: 0, pitch: 0, alive: false, cr: false, hp: 0, w: 0, spd: 0, tag: null }; e.mesh.visible = false; scene.add(e.mesh); this.ents.set(id, e); }
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
  Object.assign(me, { x: m.x, y: m.y || 0, z: m.z, vx: 0, vy: 0, vz: 0, yaw: m.yaw, pitch: 0, alive: true, hp: 100, reload: 0, bloom: 0, lean: 0, deadT: 0 });
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

  // camera
  const wantLean = act ? (K.e ? 1 : 0) - (K.q ? 1 : 0) : 0; me.lean += (wantLean - me.lean) * Math.min(1, dt * 10);
  me.eye += ((me.cr ? 1.05 : 1.62) - me.eye) * Math.min(1, dt * 12);
  let lx = cy * me.lean * 0.5, lz = -sy * me.lean * 0.5;
  if (M.solidAt(me.x + lx * 1.3, me.y + me.eye, me.z + lz * 1.3)) { lx = lz = 0; }
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
    let best = M.rayMap(o[0], o[1], o[2], d.x, d.y, d.z, 140), hitE = null, hs = false;
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
window.__g = { Host, Client, Net, me, toHost, get M() { return M; }, WPN, loadMap };
