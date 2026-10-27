const http = require('http');
const { WebSocketServer } = require('ws');

// Courtyard: only the top-left quarter is written out, the rest is mirrored so every spawn is fair.
// #=brick  S=stone  H=hedge  P=marble pillar  T=torch wall  B=banner  F=fountain
const HALF = [
  '####T#####BB',
  '#...........',
  '#.PP..HHHH..',
  '#.P.........',
  '#...S....S..',
  '#...S.......',
  '#..HH.......',
  '#.S.........',
  '#.....T.....',
  '#..SS.......',
  '#.........FF',
  '#.........FF',
];
const MAP = [...HALF, ...[...HALF].reverse()].map(r => r + [...r].reverse().join(''));
const PORT = process.env.PORT || 8080;
const free = (x, y) => MAP[y | 0]?.[x | 0] === '.';

// Position of a player at a past time, interpolated from their recent history (lag compensation)
function posAt(o, t) {
  const h = o.h, L = h.length;
  if (t >= h[L - 1].t) return h[L - 1];
  if (t <= h[0].t) return h[0];
  for (let i = L - 1; i > 0; i--) {
    if (h[i - 1].t <= t) {
      const a = h[i - 1], b = h[i], k = (t - a.t) / (b.t - a.t || 1);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return h[0];
}

// Render health check + keep-alive target
const srv = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/plain' });
  r.end('ok');
});
const wss = new WebSocketServer({ server: srv });
const P = new Map();
let nid = 1;
let ev = [];

function spawn() {
  for (;;) {
    const x = 1 + Math.random() * (MAP.length - 2), y = 1 + Math.random() * (MAP.length - 2);
    if (free(x, y) && free(x + .3, y + .3) && free(x - .3, y - .3)) return [x, y];
  }
}
function wallDist(o, a) {
  for (let d = 0; d < 40; d += .05)
    if (!free(o.x + Math.cos(a) * d, o.y + Math.sin(a) * d)) return d;
  return 40;
}

wss.on('connection', ws => {
  let me = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !me) {
      const [x, y] = spawn();
      me = { id: nid++, name: String(m.name || 'Marine').slice(0, 12), x, y, a: 0, hp: 100, sc: 0, d: 0, last: 0, dead: 0, h: [{ t: Date.now(), x, y }] };
      P.set(ws, me);
      ws.send(JSON.stringify({ t: 'init', id: me.id, map: MAP, x, y }));
    } else if (!me) {
      return;
    } else if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', c: m.c }));
    } else if (m.t === 'move' && !me.dead) {
      if (free(m.x, m.y) && Math.hypot(m.x - me.x, m.y - me.y) < 2) { me.x = m.x; me.y = m.y; }
      const now = Date.now();
      me.h.push({ t: now, x: me.x, y: me.y });
      while (me.h.length > 1 && now - me.h[0].t > 1000) me.h.shift();
      if (isFinite(m.a)) me.a = m.a;
    } else if (m.t === 'shoot' && !me.dead) {
      const n = Date.now();
      if (n - me.last < 300) return;
      me.last = n;
      const rewind = n - Math.min(350, Math.max(0, +m.lag || 0));
      if (isFinite(m.a)) me.a = m.a;
      ev.push(['f', me.id]);
      let best = null, bd = wallDist(me, me.a);
      const c = Math.cos(me.a), s = Math.sin(me.a);
      for (const o of P.values()) {
        if (o === me || o.dead) continue;
        const q = posAt(o, rewind);
        const dx = q.x - me.x, dy = q.y - me.y;
        const along = dx * c + dy * s, side = Math.abs(-dx * s + dy * c);
        if (along > 0 && along < bd && side < .3) { best = o; bd = along; }
      }
      if (best) {
        best.hp -= 25;
        if (best.hp <= 0) {
          best.dead = Date.now() + 3000;
          best.d++; me.sc++;
          ev.push(['k', me.name, best.name]);
        }
      }
    }
  });
  ws.on('close', () => P.delete(ws));
});

setInterval(() => {
  const n = Date.now();
  for (const o of P.values()) {
    if (o.dead && n > o.dead) {
      [o.x, o.y] = spawn();
      o.hp = 100; o.dead = 0; o.h = [{ t: n, x: o.x, y: o.y }];
      ev.push(['r', o.id, o.x, o.y]);
    }
  }
  const msg = JSON.stringify({
    t: 's',
    p: [...P.values()].map(o => [o.id, o.name, o.x, o.y, o.a, Math.max(0, o.hp), o.sc, o.d]),
    e: ev,
  });
  ev = [];
  for (const ws of P.keys()) if (ws.readyState === 1) ws.send(msg);
}, 50);

srv.listen(PORT, () => console.log('Doomish server on', PORT));
