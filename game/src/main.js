// Dustline Yard — a round-based tactical FPS in three.js. Vanguard (the player plus two
// bots) defends the Foundry (A) and Depot (B) sites against four Raider bots. A round is
// won by eliminating the other team, by the Raiders planting and detonating the charge, or
// by the Vanguard defusing it or running the clock out. Money between rounds buys weapons
// and armour. First to 5 rounds takes the match. v3.1 adds a death-cam, aim-down-sights,
// a fifth weapon, bot callouts and a carrier escort, first-blood and multi-kill toasts,
// and a round-history line on the scoreboard.
// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's rate.
// ?shot=start|play|buy|end with &seed=N sets up a deterministic frame for a capture,
// renders it twice, then freezes it and sets window.__shotReady. ?fast=1 shortens timers
// for play-testing; ?nolock=1 starts without pointer lock.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld, SITES, SPAWNS } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createWeapon, WEAPONS } from './weapon.js';
import { createBots } from './bots.js';
import { createHud } from './hud.js';
import { createSounds } from './sounds.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
// Seeded only when a capture asks for it; a real match shuffles with the clock.
const seed = params.has('seed')
  ? Number.parseInt(params.get('seed') ?? '1', 10) || 1
  : (Date.now() % 2147483647) || 1;
const fast = params.has('fast');
const noLock = params.has('nolock') || !!shot;

const ROUND_TIME = fast ? 20 : 100;
const BUY_TIME = fast ? 3 : 12;
const BOMB_TIME = 35;
const WIN_ROUNDS = 5;
const MAX_ROUNDS = 9;
const KILL_REWARD = 300;
const WIN_REWARD = 325;
const LOSS_REWARD = 190;
const PLANT_REWARD = 300;
const DEFUSE_REWARD = 300;
const START_MONEY = 800;
const DEFUSE_SECONDS = 5;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#2b333d');
scene.fog = new THREE.Fog(new THREE.Color('#2b333d'), 26, 70);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 140);
scene.add(camera);

const world = createWorld(scene);
const bots = createBots(scene, world);
const weapon = createWeapon(camera);
const hud = createHud(world.minimapWalls);
const sounds = createSounds();
const player = createPlayer(world.colliders);
const input = createInput(renderer.domElement, onLockChange);

const raycaster = new THREE.Raycaster();
raycaster.far = 120;
const losRaycaster = new THREE.Raycaster();
losRaycaster.far = 60;
const direction = new THREE.Vector3();
const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.message || event.error)));

// An invisible box the bots shoot at: the player's body in the world.
const playerBox = new THREE.Mesh(
  new THREE.BoxGeometry(0.7, 1.72, 0.7),
  new THREE.MeshBasicMaterial({ visible: false }),
);
playerBox.userData.isPlayer = true;
scene.add(playerBox);

// Tracers: a small pool of fading lines, one per shot. Each tracer keeps its own
// material, so a shot's colour can say who fired it: gold for the player, the
// shooter's team colour for a bot. The pool is fixed at 24, so a long firefight
// reuses the oldest line instead of allocating mid-round.
const tracers = [];
for (let i = 0; i < 24; i += 1) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xf0a830, transparent: true, opacity: 0 }));
  line.visible = false;
  line.frustumCulled = false;
  scene.add(line);
  tracers.push({ line, life: 0 });
}
let tracerNext = 0;
function spawnTracer(from, to, color = 0xf0a830) {
  const cell = tracers[tracerNext];
  tracerNext = (tracerNext + 1) % tracers.length;
  const positions = cell.line.geometry.attributes.position.array;
  positions[0] = from.x;
  positions[1] = from.y;
  positions[2] = from.z;
  positions[3] = to.x;
  positions[4] = to.y;
  positions[5] = to.z;
  cell.line.geometry.attributes.position.needsUpdate = true;
  cell.line.material.color.setHex(color);
  cell.line.visible = true;
  cell.line.material.opacity = 0.9;
  cell.life = 0.07;
}

// The bomb: a small charge with a blinking lamp, placed where it was planted and
// hidden again the moment the round ends.
const bombGroup = new THREE.Group();
const bombCase = new THREE.Mesh(
  new THREE.BoxGeometry(0.5, 0.28, 0.34),
  new THREE.MeshStandardMaterial({ color: new THREE.Color('#3a2a22'), roughness: 0.6, metalness: 0.4 }),
);
const bombBeacon = new THREE.Mesh(
  new THREE.SphereGeometry(0.06, 10, 8),
  new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3b30') }),
);
bombBeacon.position.set(0.18, 0.18, 0);
bombGroup.add(bombCase, bombBeacon);
bombGroup.visible = false;
scene.add(bombGroup);

const body = player.state;
const match = {
  phase: 'menu', // menu | buy | round | roundEnd | matchEnd
  round: 1,
  scoreV: 0,
  scoreR: 0,
  roundTime: ROUND_TIME,
  buyTime: BUY_TIME,
  bombState: 'none', // none | planted
  bombSite: null,
  bombPosition: null,
  bombTime: BOMB_TIME,
  beepAt: 0,
  roundEndAt: 0,
  roundEndReason: '',
};
const playerState = {
  health: 100,
  armor: 0,
  money: START_MONEY,
  alive: true,
  ownedWeapon: 'rifle',
  defuseProgress: 0,
  kills: 0,
  deaths: 0,
};
// Frags per actor name, for the scoreboard and the round's top fragger.
const frags = new Map();
function fragRow(name, team) {
  if (!frags.has(name)) frags.set(name, { name, team, kills: 0, deaths: 0 });
  return frags.get(name);
}
fragRow('You', 'vanguard');
for (const bot of bots.bots) fragRow(bot.name, bot.team);
// Death-cam: the living Vanguard bot the camera follows after the player falls.
let spectateBot = null;
let muted = false;
// Round flavour, reset every round: first blood, the player's kills this round,
// and the W/L history the scoreboard shows.
let firstBloodDone = false;
let roundKills = 0;
const roundHistory = [];
let elapsed = 0;
let frozen = false;
let started = false;
let accumulator = 0;
let lastTime = performance.now();
let lastShot = null;

const vanguardBots = bots.bots.filter((b) => b.team === 'vanguard');
const raiderBots = bots.bots.filter((b) => b.team === 'raider');

// What a bot can see: the player plus its Vanguard teammates for a Raider, the
// four Raiders for a Vanguard bot. The player is wrapped as an actor so the bot
// code treats all enemies the same way.
function playerActor() {
  return { isPlayer: true, position: body.position, alive: playerState.alive, name: 'You' };
}

function enemiesOf(bot) {
  if (bot.team === 'raider') return [playerActor(), ...vanguardBots];
  return raiderBots;
}

// Line of sight between two points: a ray from eye height to chest height, blocked
// by any shootable surface. The 0.6 m slack at the end keeps a ray that grazes a
// corner from counting as blocked.
function hasLineOfSight(fromPos, toPos) {
  const from = new THREE.Vector3(fromPos.x, fromPos.y + 1.5, fromPos.z);
  const to = new THREE.Vector3(toPos.x, toPos.y + 1.3, toPos.z);
  const dir = to.clone().sub(from);
  const dist = dir.length();
  if (dist < 0.01) return true;
  dir.normalize();
  losRaycaster.set(from, dir);
  losRaycaster.far = dist;
  const hit = losRaycaster.intersectObjects(world.shootables, false)[0];
  return !hit || hit.distance > dist - 0.6;
}

function syncCamera() {
  // Death-cam: after the player falls, the camera rides behind a living
  // Vanguard bot, so the round stays watchable instead of cutting to black.
  const spec = !playerState.alive ? spectateBot : null;
  if (spec && spec.alive) {
    const back = 3.2;
    camera.position.set(
      spec.position.x + Math.sin(spec.yaw) * back,
      spec.position.y + 2.4,
      spec.position.z + Math.cos(spec.yaw) * back,
    );
    camera.rotation.set(-0.18, spec.yaw, 0, 'YXZ');
  } else {
    camera.position.set(body.position.x, body.position.y + body.eye + body.bob, body.position.z);
    camera.rotation.set(body.pitch, body.yaw, 0, 'YXZ');
  }
  playerBox.position.set(body.position.x, body.position.y + 0.86, body.position.z);
}

function aimAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

// One hitscan shot from anyone: raycast, damage, tracer, sound. Returns the hit.
function fireHitscan(shooter, origin, dir, range, damage, headMult) {
  raycaster.set(origin, dir);
  raycaster.far = range;
  const solids = world.shootables.concat(bots.hitMeshes);
  if (shooter !== 'player') solids.push(playerBox);
  const hit = raycaster.intersectObjects(solids, false)[0];
  const impact = hit ? hit.point.clone() : origin.clone().add(dir.clone().multiplyScalar(range));
  const tint = shooter === 'player'
    ? 0xf0a830
    : shooter.team === 'vanguard' ? 0x3fc1a8 : 0xe4572e;
  spawnTracer(origin, impact, tint);
  if (!hit) return null;
  if (hit.object.userData.isPlayer) {
    if (shooter === 'player') return { kind: 'world', point: impact };
    damagePlayer(damage, origin);
    return { kind: 'player', point: impact };
  }
  const bot = hit.object.userData.bot;
  if (bot) {
    if (shooter !== 'player' && bot.team === shooter.team) return { kind: 'world', point: impact };
    const part = hit.object.userData.part || 'torso';
    const amount = part === 'head' ? damage * headMult : damage;
    const killed = bots.damage(bot, amount, part);
    if (shooter === 'player') {
      hud.hitMarker(killed, killed ? 4000 : 120, part === 'head');
      if (part === 'head') sounds.headshot();
      else sounds.hit();
      if (killed) onKill('You', bot, part === 'head');
    } else if (killed) {
      onKill(shooter.name, bot, part === 'head');
    }
    return { kind: 'bot', bot, part, point: impact, killed };
  }
  return { kind: 'world', point: impact };
}

function onKill(killerName, victimBot, headshot) {
  const killerTeam = killerName === 'You' ? 'vanguard' : victimBot.team === 'vanguard' ? 'raider' : 'vanguard';
  hud.addKill(killerName, victimBot.name, killerTeam, headshot);
  fragRow(killerName, killerTeam).kills += 1;
  fragRow(victimBot.name, victimBot.team).deaths += 1;
  if (!firstBloodDone && match.phase === 'round') {
    firstBloodDone = true;
    hud.addEvent(`First blood — ${killerName} × ${victimBot.name}.`);
  }
  if (killerName === 'You') {
    playerState.money += KILL_REWARD;
    playerState.kills += 1;
    roundKills += 1;
    hud.setMoney(playerState.money);
    if (roundKills === 2) hud.showToast('DOUBLE KILL');
    else if (roundKills >= 3) hud.showToast(`${roundKills}x KILL STREAK`);
    else hud.showToast(`${victimBot.name} eliminated${headshot ? ' — HEADSHOT' : ''}`);
    sounds.kill();
  }
  // The charge changes hands: when the carrier falls, a living Raider picks it up
  // and carries on to a site, so one lucky shot does not end the objective.
  if (victimBot.isCarrier && match.bombState === 'none') {
    victimBot.isCarrier = false;
    const next = raiderBots.find((b) => b.alive);
    if (next) {
      next.isCarrier = true;
      hud.addEvent('The charge changed hands — a Raider carries it now.');
    }
  }
  if (match.bombState !== 'planted') hud.setBomb('none', 0); // a channel died with its carrier
  checkRoundEnd();
}

function damagePlayer(amount, fromPos) {
  if (!playerState.alive || match.phase !== 'round') return;
  let remaining = amount;
  if (playerState.armor > 0) {
    const absorbed = Math.min(playerState.armor, remaining * 0.5);
    playerState.armor -= absorbed;
    remaining -= absorbed;
  }
  playerState.health -= remaining;
  hud.setHealth(playerState.health, playerState.armor);
  hud.damageFlash();
  // Direction indicator: the bearing the shot came from, relative to the
  // player's look direction, so the player knows where to turn.
  if (fromPos) {
    const worldAngle = Math.atan2(-(fromPos.x - body.position.x), -(fromPos.z - body.position.z));
    let relative = worldAngle - body.yaw;
    while (relative > Math.PI) relative -= Math.PI * 2;
    while (relative < -Math.PI) relative += Math.PI * 2;
    hud.damageDirection((relative * 180) / Math.PI);
  }
  sounds.hurt();
  if (playerState.health <= 0) {
    playerState.health = 0;
    playerState.alive = false;
    playerState.deaths += 1;
    spectateBot = vanguardBots.find((b) => b.alive) || null;
    hud.setHealth(0, playerState.armor);
    hud.setHint(spectateBot ? `Spectating ${spectateBot.name} — your squad fights on.` : 'You are down — your squad fights on.');
    if (document.pointerLockElement) document.exitPointerLock();
    checkRoundEnd();
  }
}

function shootPlayer(spread) {
  if (!weapon.takeRound()) {
    sounds.dryFire();
    return false;
  }
  const def = weapon.def();
  // The scattergun throws a cone of pellets: one trigger pull, several rays,
  // each with its own spread on top of the aim cone. Everything else fires one.
  let bestHit = null;
  for (let pellet = 0; pellet < def.pellets; pellet += 1) {
    camera.getWorldDirection(direction);
    direction.x += (random() * 2 - 1) * spread;
    direction.y += (random() * 2 - 1) * spread;
    direction.z += (random() * 2 - 1) * spread;
    direction.normalize();
    scene.updateMatrixWorld(true);
    const result = fireHitscan('player', camera.position.clone(), direction.clone(), def.range, def.damage, def.headMult);
    if (result && result.kind === 'bot' && (!bestHit || result.killed)) bestHit = result;
  }
  const result = bestHit ?? { kind: 'none' };
  lastShot = result ? { kind: result.kind, bot: result.bot?.name ?? null, part: result.part ?? null, killed: result.killed ?? false } : { kind: 'none' };
  weapon.pullTrigger();
  player.recoil(def.id === 'marksman' ? 0.03 : def.id === 'shotgun' ? 0.045 : 0.009 + random() * 0.004, (random() * 2 - 1) * 0.004);
  sounds.shot(def.id);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve, weapon.state.weaponId);
  return true;
}

// Spawn the teams for a round: Vanguard bots at the two site doors, Raiders split
// 3-and-1 across the sites, the carrier travelling with the three-bot main push.
function placeTeams() {
  // Vanguard bots hold the two site doors; Raiders split 3-and-1 across the sites.
  const pushSite = random() < 0.5 ? 'A' : 'B';
  const feintSite = pushSite === 'A' ? 'B' : 'A';
  vanguardBots[0].postNode = 10;
  vanguardBots[1].postNode = 11;
  bots.place(vanguardBots[0], -3, 17, 0);
  bots.place(vanguardBots[1], 3, 17, 0);
  vanguardBots[0].armor = 0;
  vanguardBots[1].armor = 0;
  // The carrier travels with the three-bot main push, not the solo lurker: the group
  // draws the defenders, and the carrier slips in behind the fight to plant.
  const carrier = raiderBots[Math.floor(random() * 3)];
  raiderBots.forEach((bot, index) => {
    const spawn = SPAWNS.raider[index % SPAWNS.raider.length];
    bots.place(bot, spawn.x, spawn.z, Math.PI);
    bot.targetSite = index < 3 ? pushSite : feintSite;
    bot.isCarrier = bot === carrier;
    bot.state = 'advance';
    bot.path = [];
  });
  return pushSite;
}

function startBuyPhase() {
  match.phase = 'buy';
  match.buyTime = BUY_TIME;
  match.bombState = 'none';
  match.bombSite = null;
  match.bombPosition = null;
  match.bombTime = BOMB_TIME;
  bombGroup.visible = false;
  playerState.defuseProgress = 0;
  spectateBot = null;
  firstBloodDone = false;
  roundKills = 0;
  // Fresh round: everyone back at spawn, full health, ammo refilled.
  body.position.set(0, 0, 16);
  body.velocity.set(0, 0, 0);
  body.yaw = 0;
  body.pitch = 0;
  playerState.health = 100;
  playerState.armor = 0;
  playerState.alive = true;
  weapon.equip(playerState.ownedWeapon);
  weapon.refill();
  placeTeams();
  hud.setHealth(100, 0);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve, weapon.state.weaponId);
  hud.setMoney(playerState.money);
  hud.setScore(match.scoreV, match.scoreR, match.round);
  hud.setTimer(ROUND_TIME);
  hud.setBomb('none', 0);
  hud.setHint('');
  hud.setPips(3, 4);
  hud.showBuy(playerState.money, match.buyTime, playerState.ownedWeapon, false);
  hud.showBanner(`ROUND ${match.round}`, 'Buy phase — spend your money, then deploy.', 2600);
  syncCamera();
}

function startRound() {
  match.phase = 'round';
  match.roundTime = ROUND_TIME;
  // The carrier holds at spawn for the first seconds of the round: its teammates
  // draw the defenders first, then it slips in behind the fight. Three seconds is
  // enough for the opening skirmish; any longer and the round can end by
  // elimination before the charge is ever planted.
  const carrier = raiderBots.find((b) => b.isCarrier);
  if (carrier) carrier.delayUntil = elapsed + 3;
  hud.hideBuy();
  hud.hideBanner();
  hud.showBanner(`ROUND ${match.round}`, 'Defend Foundry and Depot — stop the plant.', 2200);
  hud.setHint('');
  if (!noLock && !input.state.locked) input.requestLock();
}

function endRound(winner, reason) {
  if (match.phase !== 'round') return;
  match.phase = 'roundEnd';
  match.roundEndReason = reason;
  match.roundEndAt = elapsed + (fast ? 1.2 : 4);
  if (winner === 'vanguard') {
    match.scoreV += 1;
    playerState.money += WIN_REWARD;
    sounds.roundWin();
  } else {
    match.scoreR += 1;
    playerState.money += LOSS_REWARD;
    sounds.roundLose();
  }
  roundHistory.push(winner === 'vanguard' ? 'W' : 'L');
  hud.setScore(match.scoreV, match.scoreR, match.round);
  hud.setMoney(playerState.money);
  hud.setBomb('none', 0);
  const titles = {
    elimination: winner === 'vanguard' ? 'ROUND WON — RAIDERS ELIMINATED' : 'ROUND LOST — SQUAD ELIMINATED',
    detonation: 'ROUND LOST — CHARGE DETONATED',
    defuse: 'ROUND WON — CHARGE DEFUSED',
    time: 'ROUND WON — SITES HELD',
  };
  // Top fragger of the match so far rides under the banner: the round's story
  // in one line, and a reason to chase the next round's kills.
  const top = [...frags.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
  const topText = top && top.kills > 0 ? ` Top fragger: ${top.name} (${top.kills}).` : '';
  hud.addEvent(`Round ${match.round} — ${reason} (${winner === 'vanguard' ? 'Vanguard' : 'Raiders'}).`);
  hud.showBanner(titles[reason] || 'ROUND OVER', winner === 'vanguard' ? `+$${WIN_REWARD} — next round in a moment.${topText}` : `+$${LOSS_REWARD} — regroup and buy.${topText}`, fast ? 1200 : 4000);
  if (document.pointerLockElement) document.exitPointerLock();
}

function checkRoundEnd() {
  if (match.phase !== 'round') return;
  const vanguardAlive = (playerState.alive ? 1 : 0) + bots.aliveCount('vanguard');
  const raiderAlive = bots.aliveCount('raider');
  if (match.bombState === 'planted') {
    if (vanguardAlive === 0) endRound('raider', 'elimination');
    return; // A planted charge decides the round; elimination alone does not.
  }
  if (raiderAlive === 0) endRound('vanguard', 'elimination');
  else if (vanguardAlive === 0) endRound('raider', 'elimination');
}

function endMatch() {
  match.phase = 'matchEnd';
  const won = match.scoreV > match.scoreR;
  hud.hideBuy();
  hud.showOverlay('end', won
    ? `Vanguard takes the match ${match.scoreV}–${match.scoreR}. The yard is yours — ${playerState.kills} eliminations, ${playerState.deaths} deaths.`
    : `Raiders take the match ${match.scoreR}–${match.scoreV}. Run it back — ${playerState.kills} eliminations, ${playerState.deaths} deaths.`);
  if (document.pointerLockElement) document.exitPointerLock();
}

function resetMatch() {
  match.scoreV = 0;
  match.scoreR = 0;
  match.round = 1;
  roundHistory.length = 0;
  playerState.money = START_MONEY;
  playerState.ownedWeapon = 'rifle';
  playerState.kills = 0;
  playerState.deaths = 0;
  startBuyPhase();
}

function buyWeapon(weaponId) {
  if (match.phase !== 'buy') return;
  const def = WEAPONS[weaponId];
  if (!def) return;
  if (playerState.ownedWeapon === weaponId) {
    sounds.deny();
    return;
  }
  if (playerState.money < def.price) {
    sounds.deny();
    return;
  }
  playerState.money -= def.price;
  playerState.ownedWeapon = weaponId;
  weapon.equip(weaponId);
  weapon.refill();
  hud.setMoney(playerState.money);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve, weaponId);
  hud.showBuy(playerState.money, match.buyTime, playerState.ownedWeapon, playerState.armor > 0);
  sounds.buy();
}

function buyArmor() {
  if (match.phase !== 'buy' || playerState.armor > 0 || playerState.money < 400) {
    sounds.deny();
    return;
  }
  playerState.money -= 400;
  playerState.armor = 50;
  hud.setMoney(playerState.money);
  hud.setHealth(playerState.health, playerState.armor);
  hud.showBuy(playerState.money, match.buyTime, playerState.ownedWeapon, true);
  sounds.buy();
}

hud.onPlay(() => {
  if (shot) return;
  sounds.unlock();
  if (match.phase === 'matchEnd' || (match.phase === 'menu' && !started)) {
    started = true;
    hud.hideOverlay();
    resetMatch();
    return;
  }
  if (match.phase === 'menu') {
    started = true;
    hud.hideOverlay();
    resetMatch();
    return;
  }
  if (!noLock) input.requestLock();
});

hud.onBuy(buyWeapon);
hud.onBuyArmor(buyArmor);

renderer.domElement.addEventListener('click', () => {
  if (shot) return;
  if (match.phase === 'round' && playerState.alive && !input.state.locked && !noLock) input.requestLock();
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    hud.hideOverlay();
  } else if (match.phase === 'round' && playerState.alive && !noLock) {
    hud.showOverlay('paused');
  }
}

// The buy phase: count the clock down, take buy keys, and let the player walk the
// spawn while the shop is open. Mute works here too, so the player can silence the
// game before the first round starts.
function stepBuy(dt) {
  match.buyTime -= dt;
  hud.showBuy(playerState.money, Math.max(0, match.buyTime), playerState.ownedWeapon, playerState.armor > 0);
  for (const code of input.takePressed()) {
    if (code === 'Digit1') buyWeapon('pistol');
    else if (code === 'Digit2') buyWeapon('smg');
    else if (code === 'Digit3') buyWeapon('rifle');
    else if (code === 'Digit4') buyWeapon('shotgun');
    else if (code === 'Digit5') buyWeapon('marksman');
    else if (code === 'Digit6') buyArmor();
    else if (code === 'KeyM') {
      muted = sounds.setMuted(!muted);
      hud.showToast(muted ? 'Sound muted (M to unmute)' : 'Sound on');
    }
  }
  if (match.buyTime <= 0) startRound();
  player.step(dt, input.state.keys, input.state.aiming);
  weapon.step(dt);
}

// The live round: clock, bomb beeps and detonation, the player's movement, aim,
// shooting and defusing, then the bots' turn. Crouching steadies the aim on top of
// aiming down the sights, so a still, low player shoots the tightest groups.
function stepRound(dt) {
  match.roundTime -= dt;
  hud.setTimer(Math.max(0, match.roundTime));
  if (match.roundTime <= 0 && match.bombState !== 'planted') {
    endRound('vanguard', 'time');
  }
  if (match.bombState === 'planted') {
    match.bombTime -= dt;
    hud.setBomb('planted', Math.max(0, match.bombTime));
    bombBeacon.material.color.setHex(Math.sin(elapsed * 10) > 0 ? 0xff3b30 : 0x551512);
    const interval = match.bombTime > 20 ? 1.0 : match.bombTime > 10 ? 0.55 : 0.3;
    if (elapsed >= match.beepAt) {
      match.beepAt = elapsed + interval;
      sounds.beep(match.bombTime <= 5);
    }
    if (match.bombTime <= 0) {
      bombGroup.visible = false;
      sounds.explosion();
      endRound('raider', 'detonation');
    }
  }

  if (playerState.alive) {
    player.step(dt, input.state.keys, input.state.aiming);
    if (body.stepped) sounds.footstep();
    if (body.landed) sounds.land();
    // Aim down the sights: narrower field of view, tighter spread, slower feet.
    // The zoom is the weapon's own: the marksman pulls in tight, the scattergun
    // barely narrows at all.
    const aiming = input.state.aiming;
    const targetFov = aiming ? weapon.def().adsFov : 74;
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
      camera.updateProjectionMatrix();
    }
    hud.setAiming(aiming);
    for (const code of input.takePressed()) {
      if (code === 'KeyF') weapon.inspect();
      else if (code === 'KeyM') {
        muted = sounds.setMuted(!muted);
        hud.showToast(muted ? 'Sound muted (M to unmute)' : 'Sound on');
      }
    }
    const spread = weapon.spread(player.groundSpeed()) * (aiming ? 0.55 : 1) * (body.crouching ? 0.8 : 1);
    if (input.state.firing && weapon.ready()) {
      shootPlayer(shot ? 0 : spread);
    } else if (input.state.firing && weapon.state.mag === 0 && weapon.state.reloadLeft === 0) {
      weapon.reload();
      sounds.reload();
    }
    if (input.state.keys.has('KeyR') && weapon.reload()) sounds.reload();
    // Defuse: hold E beside a planted charge.
    if (match.bombState === 'planted' && input.state.keys.has('KeyE')) {
      const d = Math.hypot(match.bombPosition.x - body.position.x, match.bombPosition.z - body.position.z);
      if (d < 2.6) {
        playerState.defuseProgress += dt;
        hud.setHint(`DEFUSING… ${playerState.defuseProgress.toFixed(1)}s / ${DEFUSE_SECONDS}s — hold E, stay close.`);
        if (playerState.defuseProgress >= DEFUSE_SECONDS) {
          playerState.defuseProgress = 0;
          playerState.money += DEFUSE_REWARD;
          hud.setMoney(playerState.money);
          match.bombState = 'none';
          bombGroup.visible = false;
          sounds.defuse();
          endRound('vanguard', 'defuse');
        }
      } else {
        playerState.defuseProgress = 0;
        hud.setHint('');
      }
    } else if (playerState.defuseProgress > 0) {
      playerState.defuseProgress = 0;
      hud.setHint('');
    }
  }
  weapon.step(dt);

  // Bots fight the round.
  bots.step(dt, {
    time: elapsed,
    random,
    enemiesOf,
    hasLineOfSight,
    bombState: match.bombState,
    bombSite: match.bombSite,
    bombPosition: match.bombPosition || new THREE.Vector3(),
    fireHitscan: (bot, origin, dir, range) => {
      // Bots hit softer than the player's rifle: bot duels last long enough for
      // a push to develop, and two bots focusing the player do not melt them.
      const result = fireHitscan(bot, origin, dir, range, 24, 2.5);
      const dist = origin.distanceTo(body.position);
      if (dist < 30) sounds.distantShot();
      return result;
    },
    onChannelStart: (bot, kind) => {
      if (kind === 'plant') hud.setBomb('planting', 0);
    },
    onChannelProgress: (bot, kind, progress) => {
      if (kind === 'plant') hud.setBomb('planting', 0);
    },
    onChannelStop: () => {
      if (match.bombState !== 'planted') hud.setBomb('none', 0);
    },
    onPlanted: (bot, site) => {
      match.bombState = 'planted';
      match.bombSite = site;
      match.bombPosition = SITES[site].center.clone();
      match.bombTime = BOMB_TIME;
      match.beepAt = elapsed;
      bombGroup.position.set(match.bombPosition.x, 0.16, match.bombPosition.z);
      bombGroup.visible = true;
      hud.setBomb('planted', BOMB_TIME);
      hud.addEvent(`<span class="raider">Raiders</span> planted the charge at Site ${site} — defuse it or lose the round.`);
      hud.showBanner('CHARGE PLANTED', `Raiders planted at Site ${site} — defuse it or lose the round.`, 3000);
      sounds.plant();
    },
    onDefused: (bot) => {
      match.bombState = 'none';
      bombGroup.visible = false;
      hud.addEvent(`<span class="vanguard">${bot.name}</span> defused the charge.`);
      sounds.defuse();
      endRound('vanguard', 'defuse');
    },
  });

  hud.setPips((playerState.alive ? 1 : 0) + bots.aliveCount('vanguard'), bots.aliveCount('raider'));
  hud.setCrosshairSpread(weapon.spread(player.groundSpeed()));
}

// Between rounds: wait out the banner, then either end the match or buy again.
function stepRoundEnd(dt) {
  weapon.step(dt);
  if (elapsed >= match.roundEndAt) {
    if (match.scoreV >= WIN_ROUNDS || match.scoreR >= WIN_ROUNDS || match.round >= MAX_ROUNDS) {
      endMatch();
    } else {
      match.round += 1;
      startBuyPhase();
    }
  }
}

// The minimap and the scoreboard, refreshed every frame the game is live. Ghost dots
// mark where a Vanguard bot last saw an enemy: stale intel, but better than a blank
// lane. The scoreboard shows while Tab is held, with the round history on top.
function updateOverlays() {
  if (match.phase === 'round' || match.phase === 'buy') {
    const actors = bots.bots.map((b) => ({ position: b.position, alive: b.alive, team: b.team, isPlayer: false, yaw: b.yaw }));
    actors.push({ position: body.position, alive: playerState.alive, team: 'vanguard', isPlayer: true, yaw: body.yaw });
    const ghosts = vanguardBots.filter((b) => b.alive && b.lastSeen).map((b) => ({ x: b.lastSeen.x, z: b.lastSeen.z }));
    hud.drawMinimap(actors, match.bombState === 'planted' ? match.bombPosition : null, ghosts);
  }
  if (input.state.keys.has('Tab') && (match.phase === 'round' || match.phase === 'buy' || match.phase === 'roundEnd')) {
    const rows = [{ name: 'You', team: 'vanguard', kills: playerState.kills, deaths: playerState.deaths, alive: playerState.alive }];
    for (const bot of bots.bots) {
      const row = fragRow(bot.name, bot.team);
      rows.push({ name: bot.name, team: bot.team, kills: row.kills, deaths: row.deaths, alive: bot.alive });
    }
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    hud.showScoreboard(rows, roundHistory);
  } else {
    hud.hideScoreboard();
  }
}

function step(dt) {
  elapsed += dt;
  world.stepDust(elapsed);
  for (const tracer of tracers) {
    if (tracer.life > 0) {
      tracer.life -= dt;
      tracer.line.material.opacity = Math.max(0, tracer.life / 0.07) * 0.9;
      if (tracer.life <= 0) tracer.line.visible = false;
    }
  }

  if (match.phase === 'buy') stepBuy(dt);
  else if (match.phase === 'round') stepRound(dt);
  else if (match.phase === 'roundEnd') stepRoundEnd(dt);

  updateOverlays();
  syncCamera();
}

// The render loop: look first, then run the simulation in fixed steps (up to five
// per frame, so a slow frame never spirals), then render. The camera is synced after
// the steps so the frame shows the newest state.
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

// Step the simulation a fixed number of times without rendering: the captures use
// this to let the bots push before the frame is taken.
function settle(steps) {
  for (let index = 0; index < steps; index += 1) step(FIXED_STEP);
}

// Render twice, then freeze and signal readiness: the capture driver waits for
// window.__shotReady, and two painted frames mean the scene is fully up (shadows,
// sprites, HUD) before the screenshot lands.
function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

// A capture setup: start, buy, play or end. Each one stages a deterministic frame
// of the game — positions, money, score and HUD — then paints it twice and freezes.
function runShot(name) {
  hud.hideOverlay();
  hud.hideBuy();
  started = true;
  if (name === 'start') {
    body.position.set(0, 0, 16);
    body.yaw = 0;
    body.pitch = 0;
    placeTeams();
    bots.bots.forEach((b) => {
      b.group.position.y = 0;
    });
    syncCamera();
    hud.showOverlay('start');
    hud.setScore(0, 0, 1);
    hud.setTimer(ROUND_TIME);
    hud.setMoney(START_MONEY);
    hud.setHealth(100, 0);
    hud.setAmmo(30, 90, 'rifle');
    hud.setPips(3, 4);
    hud.drawMinimap(
      bots.bots.map((b) => ({ position: b.position, alive: b.alive, team: b.team, isPlayer: false, yaw: b.yaw }))
        .concat([{ position: body.position, alive: true, team: 'vanguard', isPlayer: true, yaw: body.yaw }]),
      null,
    );
  } else if (name === 'buy') {
    playerState.money = 2400;
    match.round = 2;
    match.scoreV = 1;
    match.scoreR = 1;
    startBuyPhase();
    match.buyTime = 9;
    body.position.set(0, 0, 16);
    body.yaw = 0.3;
    syncCamera();
    hud.drawMinimap(
      bots.bots.map((b) => ({ position: b.position, alive: b.alive, team: b.team, isPlayer: false, yaw: b.yaw }))
        .concat([{ position: body.position, alive: true, team: 'vanguard', isPlayer: true, yaw: body.yaw }]),
      null,
    );
  } else if (name === 'play') {
    match.round = 3;
    match.scoreV = 2;
    match.scoreR = 1;
    playerState.money = 1400;
    startBuyPhase();
    startRound();
    // Let the bots push for a second and a half, then step up to Mid for the frame:
    // the two Vanguard bots stay behind the camera instead of blocking it, and the
    // Raiders are close enough to read. Patch the player back to full health first:
    // the Raiders can land shots down Mid during the settle, and the capture is of
    // a live firefight, not of a death. Then take the shot, re-aiming at the moving
    // Raider each time: three rifle rounds drop one, which puts a kill in the feed.
    settle(90);
    playerState.health = 100;
    playerState.alive = true;
    hud.setHealth(100, playerState.armor);
    hud.setHint('');
    body.position.set(0, 0, 4);
    body.velocity.set(0, 0, 0);
    // Nearest living Raider the player can actually see: the nearest by distance
    // can stand behind the north cross wall, and five aimed rounds through a wall
    // prove nothing. Fall back to the nearest living Raider if none is visible.
    let mark = null;
    let closest = Infinity;
    for (const bot of raiderBots) {
      if (!bot.alive) continue;
      const d = Math.hypot(bot.position.x - body.position.x, bot.position.z - body.position.z);
      if (d < closest && hasLineOfSight(body.position, bot.position)) {
        closest = d;
        mark = bot;
      }
    }
    mark = mark || raiderBots.find((b) => b.alive) || raiderBots[0];
    for (let round = 0; round < 5 && mark.alive; round += 1) {
      const point = new THREE.Vector3(mark.position.x, mark.position.y + 1.3, mark.position.z);
      aimAt(point);
      shootPlayer(0);
      settle(8);
    }
    settle(12);
    // Pin the kill evidence to the frame: under a slow software renderer the
    // 6 s killfeed line and the hitmarker can lapse between the shot and the
    // capture. Re-show them with long holds (only if the feed is empty, so a
    // fast capture never shows the same kill twice).
    if (playerState.kills > 0) {
      hud.hitMarker(true, 60000);
      if (document.querySelectorAll('#killfeed .kill-line').length === 0) {
        hud.addKill('You', mark.name, 'vanguard', false, 60000);
      }
    }
    hud.setMoney(playerState.money);
    hud.setScore(match.scoreV, match.scoreR, match.round);
    hud.setTimer(62);
  } else if (name === 'end') {
    match.round = 5;
    match.scoreV = 3;
    match.scoreR = 1;
    playerState.money = 1750;
    startBuyPhase();
    startRound();
    settle(30);
    endRound('vanguard', 'elimination');
    // Stand inside the Foundry site, looking across its ring at the container, so the
    // banner sits over the objective instead of over a wall.
    body.position.set(-17, 0, -10);
    aimAt(new THREE.Vector3(-14, 1.0, -15));
    hud.setScore(match.scoreV, match.scoreR, match.round);
    hud.setMoney(playerState.money);
    hud.setHealth(64, 25);
    hud.setAmmo(18, 60, 'rifle');
    hud.setPips(2, 0);
    hud.setTimer(41);
    // Re-show the banner here: its hide timer starts at endRound, and a slow software
    // renderer can take longer than that to reach the capture.
    hud.showBanner('ROUND WON — RAIDERS ELIMINATED', `+$${WIN_REWARD} — next round in a moment.`, 60000);
    hud.drawMinimap(
      bots.bots.map((b) => ({ position: b.position, alive: b.alive, team: b.team, isPlayer: false, yaw: b.yaw }))
        .concat([{ position: body.position, alive: true, team: 'vanguard', isPlayer: true, yaw: body.yaw }]),
      null,
    );
  }
  paintTwiceThenReady();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Test and automation hooks: the state a play-tester reads, and the look control a
// headless driver uses when pointer lock is unavailable. Nothing here affects a
// real match; it only exposes what the game already knows.
window.__game = {
  get phase() { return match.phase; },
  get round() { return match.round; },
  get score() { return [match.scoreV, match.scoreR]; },
  get playerHealth() { return playerState.health; },
  get playerAlive() { return playerState.alive; },
  get money() { return playerState.money; },
  get bombState() { return match.bombState; },
  get vanguardAlive() { return (playerState.alive ? 1 : 0) + bots.aliveCount('vanguard'); },
  get raiderAlive() { return bots.aliveCount('raider'); },
  get roundTime() { return match.roundTime; },
  get errors() { return errors; },
  get botPositions() { return bots.bots.map((b) => [b.name, b.team, b.alive, +b.position.x.toFixed(1), +b.position.z.toFixed(1)]); },
  get lastShot() { return lastShot; },
  get kills() { return playerState.kills; },
  get history() { return [...roundHistory]; },
  look(dx, dy) { player.look(dx, dy); syncCamera(); },
  start() { hud.hideOverlay(); started = true; resetMatch(); },
  deploy() { if (match.phase === 'buy') startRound(); },
};

syncCamera();
hud.setScore(0, 0, 1);
hud.setTimer(ROUND_TIME);
hud.setMoney(START_MONEY);
hud.setHealth(100, 0);
hud.setAmmo(30, 90, 'rifle');
hud.setPips(3, 4);
if (shot) runShot(shot);
else requestAnimationFrame(frame);
