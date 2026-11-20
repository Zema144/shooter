'use strict';

/* =====================================================================
   Top Down Shooter (веб-версія)
   - Симуляція рахується на "хості" (соло: ваш пристрій, паті: той, хто створив паті)
   - Інші гравці з'єднуються через WebRTC (PeerJS) і надсилають свої дії
   ===================================================================== */

const W = 1280, H = 720;
const MAX_PLAYERS = 4;
const COLORS = ['#d62828', '#1d4ed8', '#7c3aed', '#ea580c'];

const PEER_PREFIX = 'zshooter-';
const PEER_OPTS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Публічний безкоштовний TURN (запасний варіант для мобільних мереж)
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
};

/* =====================================================================
   БАЛАНС (усі числа тут)
   ===================================================================== */

const KILL_REWARD = 2;        // нагорода за зомбі = KILL_REWARD + хвиля // 2
const BOSS_REWARD = 50;       // нагорода за боса = BOSS_REWARD × номер боса

const BULLET_SPEED = 600, BULLET_R = 5, PLAYER_R = 25, ENEMY_R = 20;

const UPGRADES = {
  speed:  { name: 'Біг',                       max: 5, cost: 100, unit: '' },
  reload: { name: 'Перезарядка',               max: 5, cost: 100, unit: 'с' },
  health: { name: "Здоров'я",                  max: 5, cost: 100, unit: '' },
  damage: { name: 'Шкода куль',                max: 5, cost: 100, unit: '' },
  turret: { name: 'Швидкострільність турелей', max: 5, cost: 120, unit: 'с' },
};

const WEAPONS = {
  pistol:  { name: 'Пістолет', price: 0,   mag: 15, delay: 0.25, auto: false, pellets: 1, spread: 0 },
  smg:     { name: 'Автомат',  price: 400, mag: 30, delay: 0.09, auto: true,  pellets: 1, spread: 3 },
  shotgun: { name: 'Дробовик', price: 700, mag: 8,  delay: 0.7,  auto: false, pellets: 6, spread: 15 },
};

const MAX_TURRETS = 5, TURRET_RANGE = 350, TURRET_BASE_COST = 80, TURRET_COST_STEP = 40;

// Паті: більше гравців -> більше зомбі та міцніші боси
const coopFactor = n => 1 + 0.7 * (n - 1);

function upgradeValue(key, level) {
  switch (key) {
    case 'speed':  return 200 + 25 * level;
    case 'reload': return Math.round((3 - 0.4 * level) * 10) / 10;
    case 'health': return 100 + 25 * level;
    case 'damage': return 1 + level;
    case 'turret': return Math.round((1.2 - 0.15 * level) * 100) / 100;
  }
}
const upgradeCost = (key, level) => UPGRADES[key].cost * (level + 1);
const checkpointFor = w => Math.floor((w - 1) / 10) * 10 + 1;
const turretCostFor = count => TURRET_BASE_COST + TURRET_COST_STEP * count;

/* =====================================================================
   ДОПОМІЖНЕ
   ===================================================================== */

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* =====================================================================
   ПРОФІЛЬ (localStorage)
   ===================================================================== */

const PROFILE_KEY = 'tds_profile_v1';

function defaultProfile() {
  const p = { money: 0, owned: ['pistol'], weapon: 'pistol', checkpoint: 1, name: '' };
  for (const k in UPGRADES) p[k] = 0;
  return p;
}

function loadProfile() {
  const p = defaultProfile();
  try {
    const d = JSON.parse(localStorage.getItem(PROFILE_KEY));
    if (d && typeof d === 'object') {
      p.money = Math.max(0, Math.floor(Number(d.money) || 0));
      for (const k in UPGRADES) p[k] = clamp(Math.floor(Number(d[k]) || 0), 0, UPGRADES[k].max);
      const owned = Array.isArray(d.owned) ? d.owned.filter(w => WEAPONS[w]) : [];
      if (!owned.includes('pistol')) owned.unshift('pistol');
      p.owned = owned;
      if (owned.includes(d.weapon)) p.weapon = d.weapon;
      p.checkpoint = checkpointFor(Math.max(1, Math.floor(Number(d.checkpoint) || 1)));
      p.name = typeof d.name === 'string' ? d.name.slice(0, 12) : '';
    }
  } catch (e) { /* немає збережень */ }
  return p;
}

let profile = loadProfile();
function saveProfile() {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) { /* ігноруємо */ }
}

function playerStats() {
  return {
    speed: upgradeValue('speed', profile.speed),
    reloadTime: upgradeValue('reload', profile.reload),
    maxHp: upgradeValue('health', profile.health),
    dmg: upgradeValue('damage', profile.damage),
    turretDelay: upgradeValue('turret', profile.turret),
    weapon: profile.weapon,
  };
}

function makeLoadout() {
  const s = playerStats();
  return { maxHp: s.maxHp, dmg: s.dmg, turretDelay: s.turretDelay, weapon: s.weapon,
           money: profile.money, checkpoint: profile.checkpoint };
}

// Дані від інших гравців не довіряємо наосліп
function sanitizeLoadout(lo) {
  lo = lo && typeof lo === 'object' ? lo : {};
  return {
    maxHp: clamp(Number(lo.maxHp) || 100, 100, 225),
    dmg: clamp(Number(lo.dmg) || 1, 1, 6),
    turretDelay: clamp(Number(lo.turretDelay) || 1.2, 0.45, 1.2),
    weapon: WEAPONS[lo.weapon] ? lo.weapon : 'pistol',
    money: clamp(Math.floor(Number(lo.money) || 0), 0, 10000000),
    checkpoint: Math.max(1, Math.floor(Number(lo.checkpoint) || 1)),
  };
}

/* =====================================================================
   ЗВУК (синтез через WebAudio, файли не потрібні)
   ===================================================================== */

let audio = null, muted = false, noiseBuf = null;
const lastPlay = {};

function initAudio() {
  try {
    if (!audio) {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (audio.state === 'suspended') audio.resume();
  } catch (e) { audio = null; }
}

function tone(f0, f1, dur, type, vol, delay = 0) {
  const t = audio.currentTime + delay;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(audio.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, vol, delay = 0) {
  const t = audio.currentTime + delay;
  const s = audio.createBufferSource(), g = audio.createGain();
  s.buffer = noiseBuf;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(g); g.connect(audio.destination);
  s.start(t, Math.random() * 0.5, dur + 0.02);
}

const SOUNDS = {
  shoot:  () => { noise(0.12, 0.22); tone(900, 120, 0.15, 'sawtooth', 0.16); },
  hit:    () => { tone(600, 200, 0.1, 'square', 0.1); noise(0.05, 0.1); },
  hurt:   () => { tone(180, 60, 0.28, 'sawtooth', 0.3); noise(0.18, 0.15); },
  reload: () => { noise(0.05, 0.2); tone(400, 250, 0.08, 'square', 0.1);
                  noise(0.07, 0.25, 0.5); tone(700, 300, 0.1, 'square', 0.12, 0.5); },
  boss:   () => { tone(90, 40, 0.9, 'sawtooth', 0.35); tone(120, 50, 0.9, 'square', 0.15); },
  turret: () => { tone(300, 600, 0.12, 'square', 0.12); },
};

function play(name) {
  if (muted || !audio) return;
  const now = performance.now();
  if (now - (lastPlay[name] || 0) < 45) return;
  lastPlay[name] = now;
  try { SOUNDS[name](); } catch (e) { /* ігноруємо */ }
}

/* =====================================================================
   СИМУЛЯЦІЯ (працює лише на хості)
   ===================================================================== */

function turretBlockReason(p, turrets, x, y) {
  if (!p || !p.alive) return 'Ви не можете цього зараз';
  const own = turrets.filter(t => t.o === p.id).length;
  if (own >= MAX_TURRETS) return 'Максимум турелей';
  const cost = turretCostFor(own);
  if (p.money < cost) return `Потрібно ${cost}$`;
  if (x < 20 || x > W - 20 || y < 20 || y > H - 20) return 'Надто близько до краю';
  if (Math.hypot(x - p.x, y - p.y) < 50) return 'Надто близько до вас';
  for (const t of turrets) if (Math.hypot(x - t.x, y - t.y) < 40) return 'Надто близько до турелі';
  return null;
}

class Sim {
  constructor(members, startWave) {
    this.players = new Map();
    this.enemies = []; this.bullets = []; this.turrets = []; this.events = [];
    this.nextId = 1; this.time = 0;
    this.wave = startWave; this.pause = 3; this.toSpawn = 0;
    this.spawnTimer = 0; this.spawnDelay = 1.8; this.over = false;

    members.forEach((m, i) => {
      const lo = m.loadout;
      this.players.set(m.id, {
        id: m.id, name: m.name, color: m.color,
        x: W / 2 + (i - (members.length - 1) / 2) * 90, y: H / 2,
        hp: lo.maxHp, maxHp: lo.maxHp, alive: true, money: lo.money,
        weapon: lo.weapon, dmg: lo.dmg, turretDelay: lo.turretDelay,
        aim: 0, nextShot: 0,
      });
    });
  }

  removePlayer(id) {
    this.players.delete(id);
    this.turrets = this.turrets.filter(t => t.o !== id);
    if (this.players.size === 0) this.over = true;
  }

  alivePlayers() {
    const out = [];
    for (const p of this.players.values()) if (p.alive) out.push(p);
    return out;
  }

  isBossWave(w = this.wave) { return w % 10 === 0; }

  startWave() {
    const w = this.wave, pf = coopFactor(this.players.size);
    this.toSpawn = Math.round((5 + 3 * w) * pf);
    this.spawnDelay = Math.max(0.25, (1.8 - 0.07 * w) / (1 + 0.4 * (this.players.size - 1)));
    this.spawnTimer = 0;
    if (this.isBossWave()) {
      this.toSpawn = Math.round((5 + w) * pf);   // охорона боса
      this.spawnEnemy(true);
    }
  }

  spawnEnemy(boss = false) {
    const side = Math.floor(Math.random() * 4);
    let x, y;
    if (side === 0)      { x = rnd(0, W); y = -30; }
    else if (side === 1) { x = rnd(0, W); y = H + 30; }
    else if (side === 2) { x = -30; y = rnd(0, H); }
    else                 { x = W + 30; y = rnd(0, H); }

    const w = this.wave;
    let e;
    if (boss) {
      const tier = Math.floor(w / 10);
      const hp = Math.round(40 * tier * coopFactor(this.players.size));
      e = { hp, mhp: hp, speed: 70 + 5 * tier, r: 50, dmg: 25, atkDelay: 0.8,
            reward: BOSS_REWARD * tier, boss: true };
      this.events.push(['b']);
    } else {
      const hp = 1 + Math.floor((w - 1) / 3);
      e = { hp, mhp: hp, speed: Math.min(100 + 5 * (w - 1), 230), r: ENEMY_R, dmg: 8,
            atkDelay: 0.5, reward: KILL_REWARD + Math.floor(w / 2), boss: false };
    }
    e.id = this.nextId++; e.x = x; e.y = y; e.atk = 0;
    this.enemies.push(e);
  }

  hurt(p, dmg) {
    if (!p.alive) return;
    p.hp -= dmg;
    this.events.push(['h', p.id]);
    if (p.hp <= 0) {
      p.hp = 0; p.alive = false;
      this.events.push(['d', p.id]);
    }
  }

  fire(pid, angle, x, y) {
    const p = this.players.get(pid);
    if (!p || !p.alive || !isFinite(angle)) return;
    const wp = WEAPONS[p.weapon];
    if (this.time < p.nextShot) return;
    p.nextShot = this.time + wp.delay * 0.7;   // невеликий допуск на затримку мережі
    if (isFinite(x) && isFinite(y)) { p.x = clamp(x, 25, W - 25); p.y = clamp(y, 25, H - 25); }
    p.aim = angle;
    for (let i = 0; i < wp.pellets; i++) {
      const a = angle + (wp.spread ? rnd(-wp.spread, wp.spread) * Math.PI / 180 : 0);
      this.bullets.push({ x: p.x, y: p.y, vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
                          a, dmg: p.dmg, o: p.id });
    }
    this.events.push(['f', p.id]);
  }

  placeTurret(pid, x, y) {
    const p = this.players.get(pid);
    const reason = turretBlockReason(p, this.turrets, x, y);
    if (reason) return reason;
    p.money -= turretCostFor(this.turrets.filter(t => t.o === pid).length);
    this.turrets.push({ id: this.nextId++, o: pid, x, y, cd: 0, aim: 0 });
    this.events.push(['t']);
    return null;
  }

  setPos(pid, x, y, aim) {
    const p = this.players.get(pid);
    if (!p || !p.alive) return;
    if (isFinite(x) && isFinite(y)) { p.x = clamp(x, 25, W - 25); p.y = clamp(y, 25, H - 25); }
    if (isFinite(aim)) p.aim = aim;
  }

  step(dt) {
    if (this.over) return;
    this.time += dt;

    // --- хвилі ---
    if (this.pause > 0) {
      this.pause -= dt;
      if (this.pause <= 0) this.startWave();
    } else if (this.toSpawn > 0) {
      this.spawnTimer += dt;
      if (this.spawnTimer >= this.spawnDelay) {
        this.spawnEnemy(false);
        this.toSpawn--;
        this.spawnTimer = 0;
      }
    } else if (this.enemies.length === 0) {
      this.wave++;
      this.pause = 3;
      this.onWaveCleared();
    }

    // --- вороги ---
    const alive = this.alivePlayers();
    const en = this.enemies;
    for (const e of en) {
      let tgt = null, bd = Infinity;
      for (const p of alive) {
        const d = (p.x - e.x) ** 2 + (p.y - e.y) ** 2;
        if (d < bd) { bd = d; tgt = p; }
      }
      e.atk -= dt;
      if (!tgt) continue;
      const dist = Math.sqrt(bd);
      if (dist > 0) {
        e.x += (tgt.x - e.x) / dist * e.speed * dt;
        e.y += (tgt.y - e.y) / dist * e.speed * dt;
      }
      if (dist < PLAYER_R + e.r && e.atk <= 0) {
        this.hurt(tgt, e.dmg);
        e.atk = e.atkDelay;
        if (dist > 0) { e.x -= (tgt.x - e.x) / dist * 14; e.y -= (tgt.y - e.y) / dist * 14; }
      }
    }

    // м'яке розштовхування, щоб зомбі не злипались в одну точку
    for (let i = 0; i < en.length; i++) {
      for (let j = i + 1; j < en.length; j++) {
        const a = en[i], b = en[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const minD = (a.r + b.r) * 0.85;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD * minD && d2 > 0.0001) {
          const d = Math.sqrt(d2), push = (minD - d) / 2;
          a.x -= dx / d * push; a.y -= dy / d * push;
          b.x += dx / d * push; b.y += dy / d * push;
        }
      }
    }

    // --- турелі ---
    for (const t of this.turrets) {
      t.cd -= dt;
      if (t.cd > 0) continue;
      const owner = this.players.get(t.o);
      if (!owner) continue;
      let target = null, best = TURRET_RANGE;
      for (const e of en) {
        const d = Math.hypot(e.x - t.x, e.y - t.y);
        if (d < best) { best = d; target = e; }
      }
      if (target && best > 0) {
        const a = Math.atan2(target.y - t.y, target.x - t.x);
        t.aim = a; t.cd = owner.turretDelay;
        this.bullets.push({ x: t.x, y: t.y, vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
                            a, dmg: owner.dmg, o: t.o });
        this.events.push(['tf']);
      }
    }

    // --- кулі ---
    for (const b of this.bullets) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) { b.dead = true; continue; }
      for (const e of en) {
        if (e.hp <= 0) continue;
        if (Math.hypot(b.x - e.x, b.y - e.y) < BULLET_R + e.r) {
          e.hp -= b.dmg;
          b.dead = true;
          if (e.hp <= 0) {
            const o = this.players.get(b.o);
            if (o) o.money += e.reward;
            this.events.push(['k']);
          }
          break;
        }
      }
    }
    this.bullets = this.bullets.filter(b => !b.dead);
    this.enemies = en.filter(e => e.hp > 0);

    if (this.players.size > 0 && this.alivePlayers().length === 0) this.over = true;
  }

  onWaveCleared() {
    let i = 0;
    for (const p of this.players.values()) {
      if (p.alive) {
        p.hp = Math.min(p.maxHp, p.hp + Math.ceil(p.maxHp * 0.25));     // відновлення між хвилями
      } else {
        p.alive = true;                                                // воскресіння товаришів
        p.hp = Math.ceil(p.maxHp * 0.5);
        p.x = W / 2 + (i - 1) * 60; p.y = H / 2;
      }
      i++;
    }
    if (this.wave % 10 === 1) this.events.push(['cp', this.wave]);     // бос пройдений
    this.events.push(['w', this.wave]);
  }

  snapshot() {
    const r = Math.round;
    return {
      t: 'snap', wv: this.wave, ps: Math.max(0, Math.ceil(this.pause)), ts: this.toSpawn,
      p: [...this.players.values()].map(p =>
        [p.id, r(p.x), r(p.y), Math.ceil(p.hp), p.maxHp, p.alive ? 1 : 0, p.money,
         Math.round(p.aim * 100) / 100, p.weapon]),
      e: this.enemies.map(e => [e.id, r(e.x), r(e.y), e.hp, e.mhp, e.r, e.boss ? 1 : 0]),
      b: this.bullets.map(b => [r(b.x), r(b.y), Math.round(b.a * 100) / 100]),
      u: this.turrets.map(t => [t.id, t.o, r(t.x), r(t.y), Math.round(t.aim * 100) / 100]),
    };
  }
}

/* =====================================================================
   СТАН ГРИ НА КЛІЄНТІ
   ===================================================================== */

let state = 'menu';             // menu | lobby | playing | over
let isHost = true;              // true у соло і для того, хто створив паті
let inParty = false;
let myId = 1;
let sim = null;                 // тільки на хості
let view = null;                // що малюємо (на хості - посилання на sim)
let roster = new Map();         // id -> {name,color}
let lastLobby = null;           // для клієнтів
let partyCode = '';
let peer = null, hostConn = null;
const lobby = { members: new Map() };    // тільки на хості
let netEvents = [];
let snapAcc = 0, inputAcc = 0;
let lastWave = 1;
let wakeLock = null;

const me = { x: W / 2, y: H / 2, aim: 0, ammo: 15, reloading: false, reloadT: 0, cd: 0,
             alive: true, hurt: 0 };

let touchMode = window.matchMedia && matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', touchMode);

/* =====================================================================
   КЕРУВАННЯ
   ===================================================================== */

const canvas = $('game');
const ctx = canvas.getContext('2d');

const keys = new Set();
const mouse = { x: W / 2, y: H / 2, down: false };
const touch = { move: null, aim: null };
const STICK_R = 90;

function resize() {
  const s = Math.min(window.innerWidth / W, window.innerHeight / H);
  canvas.style.width = Math.floor(W * s) + 'px';
  canvas.style.height = Math.floor(H * s) + 'px';
}
window.addEventListener('resize', resize);
resize();

function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
}

function touchButtons() {
  return [
    { id: 'reload', x: 1200, y: 600, r: 48, label: 'R', action: () => startReload(true) },
    { id: 'turret', x: 1070, y: 640, r: 48, label: 'T', action: () => {
        const a = me.aim;
        placeTurretAt(me.x + Math.cos(a) * 90, me.y + Math.sin(a) * 90);
      } },
  ];
}

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (state !== 'playing') return;
  e.preventDefault();
  const p = toLogical(e);

  if (e.pointerType === 'touch') {
    touchMode = true;
    document.body.classList.add('touch');
    for (const b of touchButtons()) {
      if (Math.hypot(p.x - b.x, p.y - b.y) <= b.r + 14) { b.action(); return; }
    }
    if (p.x < W / 2) {
      if (!touch.move) touch.move = { id: e.pointerId, bx: p.x, by: p.y, x: p.x, y: p.y };
    } else if (!touch.aim) {
      touch.aim = { id: e.pointerId, bx: p.x, by: p.y, x: p.x, y: p.y };
    }
  } else {
    mouse.x = p.x; mouse.y = p.y;
    if (e.button === 2) placeTurretAt(p.x, p.y);
    else if (e.button === 0) { mouse.down = true; tryFire(); }
  }
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ігноруємо */ }
});

canvas.addEventListener('pointermove', e => {
  const p = toLogical(e);
  if (e.pointerType === 'touch') {
    for (const k of ['move', 'aim']) {
      if (touch[k] && touch[k].id === e.pointerId) { touch[k].x = p.x; touch[k].y = p.y; }
    }
  } else { mouse.x = p.x; mouse.y = p.y; }
});

function endPointer(e) {
  if (e.pointerType === 'touch') {
    for (const k of ['move', 'aim']) if (touch[k] && touch[k].id === e.pointerId) touch[k] = null;
  } else { mouse.down = false; }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

window.addEventListener('keydown', e => {
  if (e.target && e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (state !== 'playing') return;
  if (e.code === 'KeyR') startReload(true);
  if (e.code === 'KeyT') placeTurretAt(mouse.x, mouse.y);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); mouse.down = false; touch.move = touch.aim = null; });

/* =====================================================================
   ЛОКАЛЬНИЙ ГРАВЕЦЬ: рух, стрільба, перезарядка
   ===================================================================== */

let stats = playerStats();
const weaponDef = () => WEAPONS[stats.weapon];

function beginLocalRun() {
  stats = playerStats();
  me.x = W / 2; me.y = H / 2; me.aim = 0;
  me.ammo = weaponDef().mag; me.reloading = false; me.reloadT = 0; me.cd = 0;
  me.alive = true; me.hurt = 0;
  touch.move = touch.aim = null;
  mouse.down = false;
}

function startReload(manual) {
  if (!me.alive || me.reloading) return;
  if (manual && me.ammo >= weaponDef().mag) return;
  me.reloading = true; me.reloadT = 0;
  play('reload');
}

function tryFire() {
  if (!me.alive || me.cd > 0 || me.reloading) return;
  if (me.ammo <= 0) { startReload(false); return; }
  me.ammo--;
  me.cd = weaponDef().delay;
  play('shoot');
  if (isHost) sim.fire(myId, me.aim, me.x, me.y);
  else sendToHost({ t: 'f', a: me.aim, x: Math.round(me.x), y: Math.round(me.y) });
  if (me.ammo === 0) startReload(false);
}

function placeTurretAt(x, y) {
  if (state !== 'playing' || !me.alive) return;
  if (isHost) {
    const reason = sim.placeTurret(myId, x, y);
    if (reason) toast(reason);
  } else {
    sendToHost({ t: 'tur', x: Math.round(x), y: Math.round(y) });
  }
}

function myViewPlayer() { return view && view.players.get(myId); }

function updateLocal(dt) {
  const mp = myViewPlayer();
  if (mp) {
    if (mp.alive && !me.alive) {            // воскресіння
      me.x = mp.x; me.y = mp.y;
      me.ammo = weaponDef().mag; me.reloading = false; me.cd = 0;
    }
    me.alive = !!mp.alive;
  }
  if (me.hurt > 0) me.hurt -= dt;
  if (!me.alive) return;

  // рух
  let vx = 0, vy = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) vx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) vx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) vy -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) vy += 1;
  if (touch.move) {
    const dx = touch.move.x - touch.move.bx, dy = touch.move.y - touch.move.by;
    const d = Math.hypot(dx, dy);
    if (d > 8) { const k = Math.min(1, d / STICK_R); vx += dx / d * k; vy += dy / d * k; }
  }
  const len = Math.hypot(vx, vy);
  if (len > 1) { vx /= len; vy /= len; }
  me.x = clamp(me.x + vx * stats.speed * dt, 25, W - 25);
  me.y = clamp(me.y + vy * stats.speed * dt, 25, H - 25);

  // приціл і стрільба
  let wantFire = false;
  if (touch.aim) {
    const dx = touch.aim.x - touch.aim.bx, dy = touch.aim.y - touch.aim.by;
    if (Math.hypot(dx, dy) > 18) { me.aim = Math.atan2(dy, dx); wantFire = true; }
  } else if (!touchMode) {
    me.aim = Math.atan2(mouse.y - me.y, mouse.x - me.x);
    wantFire = mouse.down && weaponDef().auto;
  }

  if (me.cd > 0) me.cd -= dt;
  if (me.reloading) {
    me.reloadT += dt;
    if (me.reloadT >= stats.reloadTime) {
      me.reloading = false; me.reloadT = 0; me.ammo = weaponDef().mag;
    }
  }
  if (wantFire) tryFire();

  // позиція для хоста
  if (isHost) {
    sim.setPos(myId, me.x, me.y, me.aim);
  } else {
    inputAcc += dt;
    if (inputAcc >= 0.05) {
      inputAcc = 0;
      sendToHost({ t: 'in', x: Math.round(me.x), y: Math.round(me.y), a: Math.round(me.aim * 100) / 100 });
    }
  }
}

/* =====================================================================
   ПОДІЇ (звуки, чекпоінт)
   ===================================================================== */

function handleEvents(list) {
  for (const ev of list) {
    switch (ev[0]) {
      case 'f': if (ev[1] !== myId) play('shoot'); break;
      case 'k': play('hit'); break;
      case 'tf': play('turret'); break;
      case 'h': if (ev[1] === myId) { play('hurt'); me.hurt = 0.3; } break;
      case 'd': if (ev[1] === myId) toast('Ви загинули. Чекайте наступної хвилі', 3000); break;
      case 'b': play('boss'); toast('БОС!', 1500); break;
      case 'cp':
        if (ev[1] > profile.checkpoint) {
          profile.checkpoint = checkpointFor(ev[1]);
          saveProfile();
          toast(`Бос пройдений! Наступний старт: хвиля ${profile.checkpoint}`, 3500);
        }
        break;
    }
  }
}

/* =====================================================================
   МЕРЕЖА (PeerJS)
   ===================================================================== */

function sendToHost(msg) {
  if (hostConn && hostConn.open) hostConn.send(msg);
}

function sendTo(conn, msg) {
  try { if (conn && conn.open) conn.send(msg); } catch (e) { /* ігноруємо */ }
}

function broadcast(msg) {
  for (const m of lobby.members.values()) if (m.conn) sendTo(m.conn, msg);
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function playerName() {
  const n = ($('name').value || '').trim().slice(0, 12);
  return n || 'Гравець';
}

function resetLobby() {
  lobby.members.clear();
  lobby.members.set(1, { id: 1, name: playerName(), color: COLORS[0], conn: null, loadout: makeLoadout() });
}

function lobbyList() {
  return [...lobby.members.values()].map(m => ({ id: m.id, name: m.name, color: m.color }));
}

function broadcastLobby() {
  broadcast({ t: 'lobby', code: partyCode, list: lobbyList() });
  renderLobby();
}

/* ---------- Хост паті ---------- */

function hostParty(retry = 0) {
  if (typeof Peer === 'undefined') { toast('Мережа недоступна (немає зв\'язку з інтернетом)'); return; }
  closeNet();
  isHost = true; inParty = true; myId = 1;
  partyCode = genCode();
  resetLobby();

  toast('Створюємо паті...');
  peer = new Peer(PEER_PREFIX + partyCode, PEER_OPTS);

  peer.on('open', () => {
    showPanel('lobby');
    state = 'lobby';
    renderLobby();
  });
  peer.on('connection', onGuestConnect);
  peer.on('error', err => {
    if (err.type === 'unavailable-id' && retry < 5) { hostParty(retry + 1); return; }
    toast('Помилка мережі: ' + err.type, 3500);
    leaveToMenu();
  });
}

function onGuestConnect(conn) {
  let id = null;
  conn.on('data', msg => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') {
      if (id !== null) return;
      if (sim && state === 'playing') { sendTo(conn, { t: 'err', m: 'Гра вже триває. Спробуйте, коли вона завершиться.' }); setTimeout(() => conn.close(), 300); return; }
      for (let i = 2; i <= MAX_PLAYERS; i++) if (!lobby.members.has(i)) { id = i; break; }
      if (id === null) { sendTo(conn, { t: 'err', m: 'Паті заповнене (макс. ' + MAX_PLAYERS + ')' }); setTimeout(() => conn.close(), 300); return; }
      const name = String(msg.name || 'Гравець').slice(0, 12);
      lobby.members.set(id, { id, name, color: COLORS[id - 1], conn, loadout: sanitizeLoadout(msg.lo) });
      sendTo(conn, { t: 'welcome', id, code: partyCode });
      broadcastLobby();
      return;
    }
    if (id === null) return;
    const m = lobby.members.get(id);
    if (!m) return;
    switch (msg.t) {
      case 'lo': m.loadout = sanitizeLoadout(msg.lo); break;
      case 'in': if (sim) sim.setPos(id, msg.x, msg.y, msg.a); break;
      case 'f': if (sim) sim.fire(id, msg.a, msg.x, msg.y); break;
      case 'tur': if (sim) { const r = sim.placeTurret(id, Number(msg.x), Number(msg.y)); if (r) sendTo(conn, { t: 'note', m: r }); } break;
    }
  });
  conn.on('close', () => {
    if (id === null) return;
    lobby.members.delete(id);
    if (sim) sim.removePlayer(id);
    toast('Гравець вийшов з паті');
    if (inParty) broadcastLobby();
  });
}

/* ---------- Приєднання до паті ---------- */

function joinParty() {
  if (typeof Peer === 'undefined') { toast('Мережа недоступна (немає зв\'язку з інтернетом)'); return; }
  const code = ($('code').value || '').trim().toUpperCase();
  if (code.length !== 4) { toast('Введіть код паті з 4 символів'); return; }
  closeNet();
  isHost = false; inParty = true; partyCode = code;
  toast('Підключення...', 6000);

  let connected = false;
  const timer = setTimeout(() => {
    if (!connected) { toast('Не вдалося підключитись. Перевірте код або мережу.', 4000); leaveToMenu(); }
  }, 15000);

  peer = new Peer(undefined, PEER_OPTS);
  peer.on('open', () => {
    hostConn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    hostConn.on('open', () => {
      connected = true; clearTimeout(timer);
      sendToHost({ t: 'join', name: playerName(), lo: makeLoadout() });
    });
    hostConn.on('data', onHostMessage);
    hostConn.on('close', () => {
      if (inParty && !isHost) { toast('Зв\'язок з хостом втрачено', 3500); leaveToMenu(); }
    });
  });
  peer.on('error', err => {
    clearTimeout(timer);
    toast(err.type === 'peer-unavailable' ? 'Паті з таким кодом не знайдено' : 'Помилка мережі: ' + err.type, 3500);
    leaveToMenu();
  });
}

function onHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'welcome':
      myId = msg.id;
      state = 'lobby';
      toast('Ви в паті!');
      break;
    case 'err':
      toast(msg.m, 4000);
      leaveToMenu();
      break;
    case 'lobby':
      lastLobby = msg;
      partyCode = msg.code;
      if (state === 'lobby' || state === 'menu') { state = 'lobby'; showPanel('lobby'); }
      renderLobby();
      break;
    case 'start': startRunAsClient(msg); break;
    case 'snap': applySnapshot(msg); break;
    case 'over': endRun(msg.wave); break;
    case 'note': toast(msg.m); break;
  }
}

function closeNet() {
  try { if (isHost) broadcast({ t: 'err', m: 'Хост закрив паті' }); } catch (e) { /* ігноруємо */ }
  try { if (hostConn) hostConn.close(); } catch (e) { /* ігноруємо */ }
  try { if (peer) peer.destroy(); } catch (e) { /* ігноруємо */ }
  peer = null; hostConn = null;
}

/* =====================================================================
   ПОЧАТОК І КІНЕЦЬ ГРИ
   ===================================================================== */

function startSolo() {
  closeNet();
  isHost = true; inParty = false; myId = 1;
  resetLobby();
  hostStartRun();
}

function hostStartRun() {
  const members = [...lobby.members.values()];
  members[0].loadout = makeLoadout();
  const startWave = Math.min(...members.map(m => m.loadout.checkpoint));

  sim = new Sim(members, startWave);
  view = sim;
  roster = new Map(members.map(m => [m.id, { name: m.name, color: m.color }]));
  for (const p of sim.players.values()) { p.name = roster.get(p.id).name; p.color = roster.get(p.id).color; }

  for (const m of members) {
    if (m.conn) {
      sendTo(m.conn, { t: 'start', id: m.id, wave: startWave,
                       roster: members.map(x => ({ id: x.id, name: x.name, color: x.color })) });
    }
  }
  netEvents = []; snapAcc = 0;
  enterPlaying();
}

function startRunAsClient(msg) {
  myId = msg.id;
  roster = new Map(msg.roster.map(m => [m.id, { name: m.name, color: m.color }]));
  view = { wave: msg.wave, pause: 3, toSpawn: 0, players: new Map(), enemies: [], bullets: [],
           turrets: [], snapAt: performance.now(), enemyMap: new Map() };
  sim = null;
  enterPlaying();
}

function enterPlaying() {
  state = 'playing';
  lastWave = view.wave;
  beginLocalRun();
  showPanel(null);
  document.body.classList.add('playing');
  $('hud-buttons').classList.remove('hidden');
  $('btn-full').classList.toggle('hidden', !document.documentElement.requestFullscreen);
  requestWakeLock();
}

function endRun(wave) {
  if (state === 'over') return;
  state = 'over';
  document.body.classList.remove('playing');
  $('hud-buttons').classList.add('hidden');
  touch.move = touch.aim = null; mouse.down = false;

  const mp = myViewPlayer();
  if (mp) { profile.money = mp.money; saveProfile(); }

  $('over-text').innerHTML =
    `Ви дійшли до хвилі <b>${wave}</b>.<br>` +
    `Гроші: <b>${profile.money}$</b><br>` +
    `Наступний старт: хвиля <b>${profile.checkpoint}</b>`;

  const canRestart = isHost;
  $('b-again').classList.toggle('hidden', !canRestart);
  $('b-again').textContent = inParty ? 'Грати знову (для всіх)' : 'Грати знову';
  if (!canRestart) $('over-text').innerHTML += '<br><span class="hint">Чекаємо, поки хост почне нову гру...</span>';
  showPanel('over');
  releaseWakeLock();
  if (inParty && isHost) broadcastLobby();
}

function leaveToMenu() {
  closeNet();
  inParty = false; isHost = true; sim = null; view = null; hostConn = null;
  state = 'menu';
  document.body.classList.remove('playing');
  $('hud-buttons').classList.add('hidden');
  releaseWakeLock();
  showPanel('menu');
}

async function requestWakeLock() {
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ігноруємо */ }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* ігноруємо */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state === 'playing') requestWakeLock();
});

/* ---------- Знімки стану (клієнт) ---------- */

function applySnapshot(m) {
  if (state !== 'playing' || !view || isHost) return;
  view.wave = m.wv; view.pause = m.ps; view.toSpawn = m.ts; view.snapAt = performance.now();

  const seen = new Set();
  for (const a of m.p) {
    const [id, x, y, hp, mhp, alive, money, aim, weapon] = a;
    seen.add(id);
    let p = view.players.get(id);
    if (!p) {
      const r = roster.get(id) || { name: 'Гравець', color: COLORS[(id - 1) % 4] };
      p = { id, name: r.name, color: r.color, rx: x, ry: y };
      view.players.set(id, p);
    }
    p.x = x; p.y = y; p.hp = hp; p.maxHp = mhp; p.alive = !!alive; p.money = money; p.aim = aim; p.weapon = weapon;
  }
  for (const id of [...view.players.keys()]) if (!seen.has(id)) view.players.delete(id);

  const ids = new Set();
  for (const a of m.e) {
    const [id, x, y, hp, mhp, r, boss] = a;
    ids.add(id);
    let e = view.enemyMap.get(id);
    if (!e) { e = { id, rx: x, ry: y }; view.enemyMap.set(id, e); }
    e.x = x; e.y = y; e.hp = hp; e.mhp = mhp; e.r = r; e.boss = !!boss;
  }
  for (const id of [...view.enemyMap.keys()]) if (!ids.has(id)) view.enemyMap.delete(id);
  view.enemies = [...view.enemyMap.values()];

  view.bullets = m.b.map(([x, y, a]) => ({ x, y, vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED, a }));
  view.turrets = m.u.map(([id, o, x, y, aim]) => ({ id, o, x, y, aim }));

  const mp = view.players.get(myId);
  if (mp && mp.money !== profile.money) { profile.money = mp.money; saveProfile(); }
  if (m.ev && m.ev.length) handleEvents(m.ev);
}

function smoothClient(dt) {
  if (isHost || !view) return;
  const k = Math.min(1, dt * 14);
  for (const e of view.enemies) { e.rx += (e.x - e.rx) * k; e.ry += (e.y - e.ry) * k; }
  for (const p of view.players.values()) {
    if (p.rx === undefined) { p.rx = p.x; p.ry = p.y; }
    p.rx += (p.x - p.rx) * k; p.ry += (p.y - p.ry) * k;
  }
}

/* =====================================================================
   ГОЛОВНИЙ ЦИКЛ
   ===================================================================== */

let lastTs = performance.now();

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  if (state === 'playing' && view) {
    updateLocal(dt);

    if (isHost) {
      sim.step(dt);
      const ev = sim.events; sim.events = [];
      if (ev.length) { handleEvents(ev); netEvents.push(...ev); }

      snapAcc += dt;
      if (inParty && snapAcc >= 0.05) {
        snapAcc = 0;
        const snap = sim.snapshot();
        snap.ev = netEvents; netEvents = [];
        for (const m of lobby.members.values()) {
          if (!m.conn || !m.conn.open) continue;
          const dc = m.conn.dataChannel;
          if (dc && dc.bufferedAmount > 200000) continue;      // не засмічуємо повільні з'єднання
          sendTo(m.conn, snap);
        }
      }
      if (sim.wave !== lastWave) lastWave = sim.wave;
      if (sim.over) {
        const mp = sim.players.get(myId);
        if (mp) { profile.money = mp.money; saveProfile(); }
        if (inParty) broadcast({ t: 'over', wave: sim.wave });
        endRun(sim.wave);
      }
    } else {
      smoothClient(dt);
    }
  }
  render();
}
requestAnimationFrame(frame);

/* =====================================================================
   МАЛЮВАННЯ
   ===================================================================== */

function render() {
  ctx.fillStyle = '#ecfc0f';
  ctx.fillRect(0, 0, W, H);
  if (!view || (state !== 'playing' && state !== 'over')) return;

  const age = isHost ? 0 : Math.min(0.15, (performance.now() - view.snapAt) / 1000);

  // турелі
  for (const t of view.turrets) {
    const owner = roster.get(t.o);
    ctx.fillStyle = '#6e6e78';
    ctx.beginPath(); ctx.arc(t.x, t.y, 16, 0, 7); ctx.fill();
    ctx.strokeStyle = '#282832'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(t.x, t.y);
    ctx.lineTo(t.x + Math.cos(t.aim) * 22, t.y + Math.sin(t.aim) * 22); ctx.stroke();
    ctx.strokeStyle = owner ? owner.color : '#3c3c46'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(t.x, t.y, 16, 0, 7); ctx.stroke();
  }

  // підказка для нової турелі (на комп'ютері)
  const mp = myViewPlayer();
  if (state === 'playing' && !touchMode && me.alive && mp) {
    const reason = turretBlockReason({ id: myId, alive: true, money: mp.money, x: me.x, y: me.y },
                                     view.turrets, mouse.x, mouse.y);
    ctx.strokeStyle = reason ? '#c83c3c' : '#3c8c3c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 16, 0, 7); ctx.stroke();
  }

  // вороги
  for (const e of view.enemies) {
    const ex = e.rx !== undefined ? e.rx : e.x, ey = e.ry !== undefined ? e.ry : e.y;
    ctx.fillStyle = e.boss ? 'rgb(120,20,140)' : `rgb(0,${Math.max(80, 200 - 15 * (e.mhp - 1))},0)`;
    ctx.beginPath(); ctx.arc(ex, ey, e.r, 0, 7); ctx.fill();
    if (e.mhp > 1) {
      const bw = e.r * 2, bx = ex - e.r, by = ey - e.r - 12;
      ctx.fillStyle = '#960000'; ctx.fillRect(bx, by, bw, 6);
      ctx.fillStyle = '#00c800'; ctx.fillRect(bx, by, bw * Math.max(0, e.hp) / e.mhp, 6);
    }
  }

  // кулі
  ctx.fillStyle = '#000';
  for (const b of view.bullets) {
    ctx.beginPath(); ctx.arc(b.x + b.vx * age, b.y + b.vy * age, BULLET_R, 0, 7); ctx.fill();
  }

  // гравці
  ctx.textAlign = 'center';
  ctx.font = 'bold 16px system-ui, sans-serif';
  for (const p of view.players.values()) {
    const isMe = p.id === myId;
    const px = isMe ? me.x : (p.rx !== undefined ? p.rx : p.x);
    const py = isMe ? me.y : (p.ry !== undefined ? p.ry : p.y);
    const aim = isMe ? me.aim : p.aim;
    ctx.globalAlpha = p.alive ? 1 : 0.35;
    ctx.fillStyle = p.alive ? (p.color || '#d62828') : '#666';
    ctx.beginPath(); ctx.arc(px, py, PLAYER_R, 0, 7); ctx.fill();
    if (p.alive) {
      ctx.strokeStyle = '#000'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(aim) * 36, py + Math.sin(aim) * 36); ctx.stroke();
    }
    if (inParty) {
      ctx.fillStyle = '#000';
      ctx.fillText(p.name || '', px, py - PLAYER_R - 8);
    }
    ctx.globalAlpha = 1;
  }

  if (me.hurt > 0) {
    ctx.fillStyle = `rgba(220,0,0,${me.hurt})`;
    ctx.fillRect(0, 0, W, H);
  }

  drawHud(mp);
  if (touchMode && state === 'playing') drawTouchControls();
}

function drawHud(mp) {
  ctx.textAlign = 'left';
  ctx.fillStyle = '#000';
  ctx.font = 'bold 26px system-ui, sans-serif';

  if (mp) {
    // здоров'я
    ctx.fillStyle = '#333'; ctx.fillRect(20, 20, 260, 24);
    ctx.fillStyle = '#d02020'; ctx.fillRect(20, 20, 260 * Math.max(0, mp.hp) / mp.maxHp, 24);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText(`${mp.hp} / ${mp.maxHp}`, 28, 38);

    ctx.fillStyle = '#000'; ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.fillText(`${mp.money}$`, 20, 76);

    const own = view.turrets.filter(t => t.o === myId).length;
    ctx.font = 'bold 20px system-ui, sans-serif';
    const tl = own < MAX_TURRETS
      ? `Турелі: ${own}/${MAX_TURRETS} (${touchMode ? 'кнопка T' : 'ПКМ / T'}: ${turretCostFor(own)}$)`
      : `Турелі: ${own}/${MAX_TURRETS}`;
    ctx.fillText(tl, 20, 138);
  }

  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillText(`Хвиля: ${view.wave}`, 20, 108);
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText(`Залишилось ворогів: ${view.toSpawn + view.enemies.length}`, 20, 164);

  // інші гравці
  if (inParty) {
    ctx.textAlign = 'right';
    ctx.font = 'bold 16px system-ui, sans-serif';
    let y = 70;
    for (const p of view.players.values()) {
      if (p.id === myId) continue;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(W - 190, y - 5, 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#000';
      ctx.fillText(p.name, W - 20, y);
      ctx.fillStyle = '#333'; ctx.fillRect(W - 170, y + 4, 150, 8);
      ctx.fillStyle = p.alive ? '#d02020' : '#777';
      ctx.fillRect(W - 170, y + 4, 150 * Math.max(0, p.hp) / p.maxHp, 8);
      y += 38;
    }
  }

  // патрони
  ctx.textAlign = 'right';
  ctx.fillStyle = '#000';
  ctx.font = 'bold 22px system-ui, sans-serif';
  const wd = weaponDef();
  ctx.fillText(wd.name, W - 20, H - 44);
  ctx.fillText(me.reloading ? 'Перезарядка...' : `Ammo: ${me.ammo} / ${wd.mag}`, W - 20, H - 18);
  if (me.reloading) {
    ctx.fillStyle = '#333'; ctx.fillRect(W - 200, H - 36, 180, 6);
    ctx.fillStyle = '#2f8f46'; ctx.fillRect(W - 200, H - 36, 180 * Math.min(1, me.reloadT / stats.reloadTime), 6);
  }

  // банер хвилі
  ctx.textAlign = 'center';
  if (view.pause > 0) {
    const boss = view.wave % 10 === 0;
    ctx.fillStyle = boss ? '#961e96' : '#000';
    ctx.font = 'bold 72px system-ui, sans-serif';
    ctx.fillText(boss ? 'БОС!' : `Хвиля ${view.wave}`, W / 2, 170);
  }
  if (!me.alive && state === 'playing') {
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.fillText('Ви загинули. Чекайте наступної хвилі...', W / 2, H / 2 - 100);
  }
}

function drawStick(s, color) {
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(s.bx, s.by, STICK_R, 0, 7); ctx.fill();
  const dx = s.x - s.bx, dy = s.y - s.by, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / STICK_R);
  ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.arc(s.bx + dx / d * k * STICK_R, s.by + dy / d * k * STICK_R, 38, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;
}

function drawTouchControls() {
  if (touch.move) drawStick(touch.move, '#222');
  if (touch.aim) drawStick(touch.aim, '#a00');

  if (!touch.move && !touch.aim) {
    ctx.globalAlpha = 0.45; ctx.fillStyle = '#000';
    ctx.font = '20px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Ліворуч: рух', 260, H - 40);
    ctx.fillText('Праворуч: приціл і стрільба', 860, H - 40);
    ctx.globalAlpha = 1;
  }

  for (const b of touchButtons()) {
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
    ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(b.label, b.x, b.y + 11);
    ctx.globalAlpha = 1;
  }
}

/* =====================================================================
   ІНТЕРФЕЙС: меню, лобі, магазин
   ===================================================================== */

let panelBeforeShop = 'menu';

function showPanel(name) {
  for (const id of ['menu', 'lobby', 'shop', 'over']) $('p-' + id).classList.toggle('hidden', id !== name);
}

function renderLobby() {
  $('lobby-code').textContent = partyCode;
  const list = isHost ? lobbyList() : (lastLobby ? lastLobby.list : []);
  $('lobby-list').innerHTML = list.map(m =>
    `<li><span class="dot" style="background:${m.color}"></span>${escapeHtml(m.name)}` +
    `${m.id === 1 ? ' <small>(хост)</small>' : ''}${m.id === myId ? ' <small>(ви)</small>' : ''}</li>`).join('');
  $('b-start').classList.toggle('hidden', !isHost);
  $('lobby-info').textContent = isHost
    ? `Надішліть друзям код або посилання. Гравців: ${list.length}/${MAX_PLAYERS}. Старт з хвилі, яку пройшли всі.`
    : 'Чекаємо, поки хост почне гру...';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openShop(from) {
  panelBeforeShop = from;
  renderShop();
  showPanel('shop');
}

function renderShop() {
  $('shop-money').textContent = `Гроші: ${profile.money}$   |   Старт з хвилі ${profile.checkpoint}`;

  $('shop-up').innerHTML = Object.keys(UPGRADES).map(key => {
    const up = UPGRADES[key], lvl = profile[key], maxed = lvl >= up.max;
    const now = upgradeValue(key, lvl), nxt = upgradeValue(key, lvl + 1);
    const price = maxed ? 'МАКС' : `${upgradeCost(key, lvl)}$`;
    const info = maxed ? `${now}${up.unit}` : `${now}${up.unit} → ${nxt}${up.unit}`;
    return `<button class="shop-row ${maxed ? 'max' : ''}" data-up="${key}" ${maxed ? 'disabled' : ''}>
      <span>${up.name} <small>рівень ${lvl}/${up.max}: ${info}</small></span><span class="price">${price}</span></button>`;
  }).join('');

  $('shop-weap').innerHTML = Object.keys(WEAPONS).map(key => {
    const w = WEAPONS[key], owned = profile.owned.includes(key), eq = profile.weapon === key;
    const price = eq ? 'Обрано' : owned ? 'Обрати' : `${w.price}$`;
    return `<button class="shop-row ${eq ? 'equipped' : ''}" data-weap="${key}" ${eq ? 'disabled' : ''}>
      <span>${w.name} <small>магазин ${w.mag}${w.auto ? ', автоогонь' : ''}${w.pellets > 1 ? `, ${w.pellets} куль` : ''}</small></span>
      <span class="price">${price}</span></button>`;
  }).join('');
}

function afterPurchase() {
  saveProfile();
  renderShop();
  if (inParty && !isHost) sendToHost({ t: 'lo', lo: makeLoadout() });
  if (inParty && isHost) lobby.members.get(1).loadout = makeLoadout();
}

$('shop-up').addEventListener('click', e => {
  const btn = e.target.closest('[data-up]');
  if (!btn) return;
  const key = btn.dataset.up, lvl = profile[key], cost = upgradeCost(key, lvl);
  if (lvl >= UPGRADES[key].max) return;
  if (profile.money < cost) { toast('Недостатньо грошей'); return; }
  profile.money -= cost; profile[key]++;
  afterPurchase();
});

$('shop-weap').addEventListener('click', e => {
  const btn = e.target.closest('[data-weap]');
  if (!btn) return;
  const key = btn.dataset.weap, w = WEAPONS[key];
  if (profile.owned.includes(key)) { profile.weapon = key; afterPurchase(); return; }
  if (profile.money < w.price) { toast('Недостатньо грошей'); return; }
  profile.money -= w.price; profile.owned.push(key); profile.weapon = key;
  afterPurchase();
});

/* ---------- Кнопки ---------- */

function persistName() {
  profile.name = ($('name').value || '').trim().slice(0, 12);
  saveProfile();
}

$('b-solo').onclick = () => { initAudio(); persistName(); startSolo(); };
$('b-host').onclick = () => { initAudio(); persistName(); hostParty(); };
$('b-join').onclick = () => { initAudio(); persistName(); joinParty(); };
$('b-shop-menu').onclick = () => openShop('menu');
$('b-shop-lobby').onclick = () => openShop('lobby');
$('b-shop-over').onclick = () => openShop('over');
$('b-shop-close').onclick = () => {
  if (inParty && !isHost) sendToHost({ t: 'lo', lo: makeLoadout() });
  showPanel(panelBeforeShop);
  if (panelBeforeShop === 'lobby') renderLobby();
};

$('b-start').onclick = () => { initAudio(); hostStartRun(); };
$('b-again').onclick = () => {
  initAudio();
  if (!inParty) { startSolo(); return; }
  hostStartRun();
};
$('b-leave').onclick = leaveToMenu;
$('b-menu').onclick = leaveToMenu;

$('btn-menu').onclick = () => {
  if (confirm('Вийти з гри? Гроші та покращення збережуться.')) {
    const mp = myViewPlayer();
    if (mp) { profile.money = mp.money; saveProfile(); }
    leaveToMenu();
  }
};

$('btn-mute').onclick = () => {
  muted = !muted;
  $('btn-mute').innerHTML = muted ? '&#128263;' : '&#128266;';
};

$('btn-full').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }
  } catch (e) { /* ігноруємо */ }
};

$('b-copy').onclick = async () => {
  const link = location.origin + location.pathname + '?room=' + partyCode;
  try { await navigator.clipboard.writeText(link); toast('Посилання скопійовано'); }
  catch (e) { window.prompt('Скопіюйте посилання:', link); }
};

$('b-share').onclick = async () => {
  const link = location.origin + location.pathname + '?room=' + partyCode;
  if (navigator.share) {
    try { await navigator.share({ title: 'Top Down Shooter', text: 'Грай зі мною! Код паті: ' + partyCode, url: link }); } catch (e) { /* скасовано */ }
  } else {
    try { await navigator.clipboard.writeText(link); toast('Посилання скопійовано'); } catch (e) { window.prompt('Скопіюйте посилання:', link); }
  }
};

/* ---------- Запуск ---------- */

$('name').value = profile.name;
$('controls-hint').textContent = touchMode
  ? 'Телефон: лівий палець - рух, правий - приціл і стрільба. Кнопка T - турель, R - перезарядка.'
  : 'Комп\'ютер: WASD або стрілки - рух, миша - приціл і стрільба, ПКМ або T - турель, R - перезарядка.';

const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  $('code').value = urlRoom.toUpperCase().slice(0, 4);
  toast('Введіть ім\'я та натисніть «Приєднатись»', 4000);
}

if (typeof Peer === 'undefined') {
  $('b-host').disabled = true;
  $('b-join').disabled = true;
  $('controls-hint').textContent += ' (Паті недоступні: немає зв\'язку з сервером PeerJS.)';
}

showPanel('menu');

// Для налагодження в консолі
window.__game = { get sim() { return sim; }, get view() { return view; }, me, get state() { return state; }, profile: () => profile };
