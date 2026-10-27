const http = require('http');
const { WebSocketServer } = require('ws');

// #=wallpaper  S=furniture  P=pillar  T=candle wall  G=generator  E=exit gate
const MAP = [
  '####T######EE######T####',
  '#.......#......#.......#',
  '#.SS....#......#....SS.#',
  '#......................#',
  '#.S..................S.#',
  '#.......#......#.......#',
  '#...S...#......#...S...#',
  '#.......#......#.......#',
  '###..####......####..###',
  '#.......#P....P#.......#',
  '#..S....#......#....S..#',
  '#..........GG..........#',
  '#..........GG..........#',
  '#..S....#......#....S..#',
  '#.......#P....P#.......#',
  '###..####......####..###',
  '#.......#......#.......#',
  '#...S...#......#...S...#',
  '#.......#......#.......#',
  '#.S..................S.#',
  '#......................#',
  '#.SS....#......#....SS.#',
  '#.......#......#.......#',
  '####T##############T####',
];
const PORT = process.env.PORT || 8080;
const NEED = 4;
const FUSE_SPOTS = [[1.5, 6.5], [21.5, 1.5], [1.5, 21.5], [22.5, 21.5], [1.5, 12.5], [22.5, 12.5], [11.5, 2.5], [13.5, 17.5]];
const BAT_SPOTS = [[7.5, 3.5], [3.5, 8.5], [20.5, 15.5], [6.5, 10.5], [17.5, 13.5], [9.5, 5.5], [14.5, 18.5], [5.5, 20.5]];
const N = MAP.length;
const free = (x, y) => MAP[y | 0]?.[x | 0] === '.';
const DT = .05;

const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end('ok'); });
const wss = new WebSocketServer({ server: srv });
const P = new Map();
let nid = 1, ev = [], G, M, items;

const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(v => v[1]);
function reset(p) {
  Object.assign(p, { x: 10.5 + Math.random() * 3, y: 21.5, hp: 2, st: 0, cy: 0, lt: 0, inv: 0, rev: 0, bt: 0, act: 0, rv: 0 });
}
function newRound() {
  G = { st: 'p', fu: 0, open: 0, t: 0 };
  M = { x: 3.5, y: 6.5, a: 0, stun: 0, mode: 'patrol', dest: null, seen: 0, tx: 0, ty: 0 };
  items = [];
  shuffle(FUSE_SPOTS).slice(0, NEED).forEach(([x, y]) => items.push({ k: 'f', x, y }));
  BAT_SPOTS.forEach(([x, y]) => items.push({ k: 'b', x, y }));
  for (const p of P.values()) reset(p);
}
newRound();

function los(ax, ay, bx, by) {
  const d = Math.hypot(bx - ax, by - ay), n = Math.ceil(d / .25);
  for (let i = 1; i < n; i++) if (!free(ax + (bx - ax) * i / n, ay + (by - ay) * i / n)) return false;
  return true;
}
// distance field from the target cell, so the Warden can path around walls
function field(tx, ty) {
  const d = new Int16Array(N * N).fill(-1), q = [[tx | 0, ty | 0]];
  d[(ty | 0) * N + (tx | 0)] = 0;
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = x + dx, b = y + dy;
      if (MAP[b]?.[a] === '.' && d[b * N + a] < 0) { d[b * N + a] = d[y * N + x] + 1; q.push([a, b]); }
    }
  }
  return d;
}
function pathPoint(tx, ty) {
  const d = field(tx, ty), cx = M.x | 0, cy = M.y | 0, cur = d[cy * N + cx];
  if (cur <= 0) return [tx, ty];
  let best = [tx, ty], bv = cur;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const v = d[(cy + dy) * N + cx + dx];
    if (v >= 0 && v < bv) { bv = v; best = [cx + dx + .5, cy + dy + .5]; }
  }
  return best;
}
function stepTo(x, y, sp) {
  const dx = x - M.x, dy = y - M.y, d = Math.hypot(dx, dy) || 1, s = Math.min(d, sp * DT);
  M.x += dx / d * s; M.y += dy / d * s; M.a = Math.atan2(dy, dx);
}
function randomFloor() {
  for (;;) { const x = 1 + Math.random() * (N - 2) | 0, y = 1 + Math.random() * (N - 2) | 0; if (MAP[y][x] === '.') return [x + .5, y + .5]; }
}

function monster() {
  if (M.stun > 0) { M.stun -= DT; return; }
  let best = null, bd = 99;
  for (const p of P.values()) {
    if (p.st) continue;
    const d = Math.hypot(p.x - M.x, p.y - M.y), r = p.lt ? 11 : 5.5; // a lit flashlight gives you away
    if (d < r && d < bd && los(M.x, M.y, p.x, p.y)) { best = p; bd = d; }
  }
  const patrol = 1.7 + G.fu * .25, chase = 3.1 + G.fu * .2;
  if (best) { if (M.mode !== 'chase') ev.push(['roar']); M.mode = 'chase'; M.seen = 5; M.tx = best.x; M.ty = best.y; }
  else if (M.mode === 'chase' && (M.seen -= DT) <= 0) { M.mode = 'patrol'; M.dest = null; }
  if (M.mode === 'chase') {
    if (best && bd < 4) stepTo(best.x, best.y, chase);
    else { const [x, y] = pathPoint(M.tx, M.ty); stepTo(x, y, chase); }
    if (!best && Math.hypot(M.tx - M.x, M.ty - M.y) < .7) M.seen = Math.min(M.seen, 1.5);
  } else {
    if (!M.dest || Math.hypot(M.dest[0] - M.x, M.dest[1] - M.y) < .6) M.dest = randomFloor();
    const [x, y] = pathPoint(M.dest[0], M.dest[1]); stepTo(x, y, patrol);
  }
  for (const p of P.values()) {
    if (p.st || p.inv > 0 || Math.hypot(p.x - M.x, p.y - M.y) > .85) continue;
    p.hp--; p.inv = 2; M.stun = 1.4; ev.push(['hit', p.id]);
    if (p.hp <= 0) {
      p.st = 1; p.bt = 40; p.rev = 0;
      if (p.cy) { p.cy = 0; items.push({ k: 'f', x: p.x, y: p.y }); }
      ev.push(['down', p.name]);
    }
  }
}

function pickups(p) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (Math.hypot(it.x - p.x, it.y - p.y) > .7 || (it.k === 'f' && p.cy)) continue;
    items.splice(i, 1);
    if (it.k === 'f') p.cy = 1;
    ev.push(['pick', it.k, p.id, p.name]);
  }
  if (p.cy && Math.hypot(p.x - 12, p.y - 12) < 2.3) {
    p.cy = 0; G.fu++; ev.push(['fuse', G.fu, p.name]);
    if (G.fu >= NEED) { G.open = 1; ev.push(['open']); }
  }
  if (G.open && p.st === 0 && p.y < 1.8 && Math.abs(p.x - 12) < 2.6) { p.st = 3; ev.push(['esc', p.name]); }
}

wss.on('connection', ws => {
  let me = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !me) {
      if (!P.size) newRound();
      me = { id: nid++, name: String(m.name || 'Survivor').slice(0, 12), a: 0 };
      reset(me); P.set(ws, me);
      ws.send(JSON.stringify({ t: 'init', id: me.id, map: MAP, x: me.x, y: me.y }));
    } else if (!me) return;
    else if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: m.c }));
    else if (m.t === 'act') me.act = m.on ? 1 : 0;
    else if (m.t === 'move') {
      if (isFinite(m.a)) me.a = m.a;
      me.lt = m.lt ? 1 : 0;
      if (me.st === 0 && G.st === 'p' && free(m.x, m.y) && Math.hypot(m.x - me.x, m.y - me.y) < 2) {
        me.x = m.x; me.y = m.y; pickups(me);
      }
    }
  });
  ws.on('close', () => { P.delete(ws); });
});

function end(s) { G.st = s; G.t = 8; ev.push([s === 'w' ? 'win' : 'lose']); }

setInterval(() => {
  const ps = [...P.values()];
  if (G.st === 'p' && ps.length) {
    monster();
    ps.forEach(p => { p.rv = 0; if (p.inv > 0) p.inv -= DT; });
    ps.forEach(p => {
      if (p.st === 1 && (p.bt -= DT) <= 0) { p.st = 2; ev.push(['dead', p.name]); }
      if (p.st || !p.act) return;
      const v = ps.find(q => q.st === 1 && Math.hypot(q.x - p.x, q.y - p.y) < 1.5);
      if (v) {
        v.rv = 1; v.rev += DT;
        if (v.rev >= 3) { v.st = 0; v.hp = 1; v.inv = 3; v.rev = 0; ev.push(['rev', v.name]); }
      }
    });
    ps.forEach(p => { if (p.st === 1 && !p.rv) p.rev = Math.max(0, p.rev - DT); });
    if (!ps.some(p => p.st === 0)) end(ps.some(p => p.st === 3) ? 'w' : 'l');
  } else if (G.st !== 'p' && (G.t -= DT) <= 0) newRound();

  const msg = JSON.stringify({
    t: 's',
    p: [[0, 'WARDEN', M.x, M.y, M.a, 1, 0, 0, 0, 0, 0],
      ...ps.map(o => [o.id, o.name, o.x, o.y, o.a, o.hp, o.st, o.lt, o.cy, o.st === 1 ? o.rev / 3 : 0, Math.ceil(o.bt)])],
    it: items.map(i => [i.k, i.x, i.y]),
    g: [G.st, G.fu, NEED, G.open, Math.ceil(G.t), M.mode === 'chase' ? 1 : 0],
    e: ev,
  });
  ev = [];
  for (const ws of P.keys()) if (ws.readyState === 1) ws.send(msg);
}, DT * 1000);

srv.listen(PORT, () => console.log('Hollowmere server on', PORT));
