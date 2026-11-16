// The bots: four Vanguard defenders (the player is the fifth) against five Raider
// attackers. Each bot walks the waypoint graph on breadth-first routes, holds a post
// or pushes a site, and fights when it can see an enemy: sight is a real raycast,
// aim error shrinks the longer it holds a target, and fire comes in bursts with
// pauses, so a bot is dangerous but beatable. Taking a hit breaks a bot's aim. Bots
// call out what they see: a sighting is shared with living teammates as a last-seen
// mark, so the squad rotates to a push one bot spotted. The Raider carrying the
// charge plants it at a site while one teammate walks escort; a Vanguard bot defuses
// a planted charge if it can reach it. Bots never see through walls and never hit
// what they cannot see.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { WAYPOINTS, WAYPOINT_EDGES, SITES } from './world.js';

const BOT_RADIUS = 0.34;
const BOT_HEIGHT = 1.72;
const BOT_SPEED = 4.3;
const BOT_HEALTH = 100;
const PERCEIVE_EVERY = 0.12;
const SIGHT_RANGE = 46;
const SIGHT_HALF_FOV = 1.05; // ~60 degrees each side
const BURST_MIN = 3;
const BURST_MAX = 5;
const SHOT_GAP = 0.13;
const AIM_ERROR_START = 0.055;
const AIM_ERROR_MIN = 0.014;
const PLANT_SECONDS = 3;
const DEFUSE_SECONDS = 5;
// A callout stays useful for this long; older marks are dropped so the squad does
// not keep rotating to a fight that ended a minute ago.
const CALLOUT_FRESH_SECONDS = 4;

const NAMES = {
  vanguard: ['Rook', 'Heron', 'Wren', 'Kestrel'],
  raider: ['Vex', 'Mako', 'Sable', 'Pike', 'Onyx'],
};

const ADJACENCY = WAYPOINTS.map(() => []);
for (const [a, b] of WAYPOINT_EDGES) {
  ADJACENCY[a].push(b);
  ADJACENCY[b].push(a);
}

function nearestNodeIndex(pos) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < WAYPOINTS.length; i += 1) {
    const dx = WAYPOINTS[i][0] - pos.x;
    const dz = WAYPOINTS[i][1] - pos.z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// Breadth-first route across the waypoint graph. Returns the nodes from the start
// node to the target, inclusive; if the target is unreachable it falls back to a
// direct two-node hop so the caller still has somewhere to walk.
function findPath(from, to) {
  if (from === to) return [to];
  const prev = new Array(WAYPOINTS.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length) {
    const current = queue.shift();
    if (current === to) break;
    for (const next of ADJACENCY[current]) {
      if (prev[next] === -1) {
        prev[next] = current;
        queue.push(next);
      }
    }
  }
  if (prev[to] === -1) return [from, to];
  const path = [from];
  let node = to;
  const tail = [];
  while (node !== from) {
    tail.unshift(node);
    node = prev[node];
  }
  return path.concat(tail);
}

function nameSprite(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = 'rgba(20,22,26,0.72)';
  g.fillRect(0, 8, 256, 48);
  g.fillStyle = color;
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, 128, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}

// A bot's visible body: dark legs, a team-coloured torso and helmet, a gun held low
// and a floating name tag. Torso and head carry the bot reference and a part label,
// which is how a hitscan ray knows what it hit and who it hit.
function buildBody(scene, team, name) {
  const color = team === 'vanguard' ? PALETTE.vanguard : PALETTE.raider;
  const group = new THREE.Group();
  const vest = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.7, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.6 });

  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.78, 0.22), dark);
  legs.position.y = 0.39;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.72, 0.3), vest);
  torso.position.y = 1.14;
  torso.userData.part = 'torso';
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), skin);
  head.position.y = 1.66;
  head.userData.part = 'head';
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.175, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), vest);
  helmet.position.y = 1.68;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.62), dark);
  gun.position.set(0.2, 1.25, -0.3);
  group.add(legs, torso, head, helmet, gun);
  group.traverse((mesh) => {
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  const tag = nameSprite(name, color);
  tag.position.y = 2.05;
  group.add(tag);
  scene.add(group);
  return { group, torso, head, tag };
}

export function createBots(scene, world) {
  const colliders = world.colliders;
  const probe = new THREE.Box3();
  const bots = [];
  const hitMeshes = [];
  let createdCount = 0;

  function overlaps(x, y, z, height, lift) {
    probe.min.set(x - BOT_RADIUS, y + lift, z - BOT_RADIUS);
    probe.max.set(x + BOT_RADIUS, y + height - lift, z + BOT_RADIUS);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return true;
    return false;
  }

  function makeBot(team, name) {
    const body = buildBody(scene, team, name);
    const bot = {
      id: `${team}-${name.toLowerCase()}`,
      name,
      team,
      group: body.group,
      torso: body.torso,
      head: body.head,
      tag: body.tag,
      position: new THREE.Vector3(0, 0, 0),
      yaw: 0,
      health: BOT_HEALTH,
      armor: 0,
      alive: false,
      state: 'hold',
      path: [],
      pathTarget: null,
      postNode: 0,
      targetSite: 'A',
      isCarrier: false,
      // Staggered perception, deterministically: a Math.random() here would make
      // the seeded capture modes play out differently on every load.
      perceiveAt: ((createdCount * 0.037) % PERCEIVE_EVERY),
      visibleEnemy: null,
      lastSeen: null,
      lastSeenAt: -99,
      lastCalloutAt: -99, // last radio callout this bot made, throttled in perceive
      aimTime: 0,
      burstLeft: 0,
      shotAt: 0,
      pauseUntil: 0,
      strafeDir: 1,
      strafeAt: 0,
      channel: null, // { kind: 'plant'|'defuse', progress: seconds }
      grenades: 1, // one frag per round: lobbed at a last-seen mark it cannot see
      grenadeAt: 0, // earliest time it may throw again
      stuckAt: 0,
      stuckPos: new THREE.Vector3(),
      detourUntil: 0,
      detourDir: 1,
      repathAt: 0,
      delayUntil: 0,
      fall: 0,
      walkPhase: 0,
    };
    body.torso.userData.bot = bot;
    body.head.userData.bot = bot;
    hitMeshes.push(body.torso, body.head);
    bots.push(bot);
    createdCount += 1;
    return bot;
  }

  for (const name of NAMES.vanguard) makeBot('vanguard', name);
  for (const name of NAMES.raider) makeBot('raider', name);

  function place(bot, x, z, yaw) {
    bot.position.set(x, 0, z);
    bot.yaw = yaw;
    bot.group.position.copy(bot.position);
    bot.group.rotation.set(0, yaw, 0);
    bot.group.visible = true;
    bot.tag.visible = true;
    bot.health = BOT_HEALTH;
    bot.armor = 0;
    bot.alive = true;
    bot.fall = 0;
    bot.channel = null;
    bot.grenades = 1;
    bot.grenadeAt = 0;
    bot.delayUntil = 0;
    bot.visibleEnemy = null;
    bot.lastSeen = null;
    bot.lastCalloutAt = 0;
    bot.aimTime = 0;
    bot.burstLeft = 0;
    bot.pauseUntil = 0;
    bot.path = [];
  }

  function moveBot(bot, dt, wishX, wishZ) {
    const len = Math.hypot(wishX, wishZ);
    if (len < 0.001) return;
    const velX = (wishX / len) * BOT_SPEED;
    const velZ = (wishZ / len) * BOT_SPEED;
    const nextX = bot.position.x + velX * dt;
    if (!overlaps(nextX, 0, bot.position.z, BOT_HEIGHT, 0.04)) bot.position.x = nextX;
    const nextZ = bot.position.z + velZ * dt;
    if (!overlaps(bot.position.x, 0, nextZ, BOT_HEIGHT, 0.04)) bot.position.z = nextZ;
    bot.walkPhase += dt * 9;
    bot.group.position.y = Math.abs(Math.sin(bot.walkPhase)) * 0.03;
  }

  // Straight-line clearance for a bot-sized body: sample the segment every 0.3 m.
  // A path leg is only usable when the whole leg is clear; a leg that clips a wall
  // pins the bot against it forever, because the stuck handler would replan the
  // same leg. Used to pick a first node the bot can actually walk to.
  function clearSegment(sx, sz, ex, ez) {
    const dist = Math.hypot(ex - sx, ez - sz);
    const steps = Math.max(1, Math.ceil(dist / 0.3));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      if (overlaps(sx + (ex - sx) * t, 0, sz + (ez - sz) * t, BOT_HEIGHT, 0.04)) return false;
    }
    return true;
  }

  function setPath(bot, toNode) {
    // First step: the nearest node the bot can walk to in a straight line. The
    // nearest node by distance can sit behind a wall after a fight drifted the bot
    // sideways, so try nodes nearest-first until one has a clear leg.
    const order = WAYPOINTS.map((_, i) => i).sort((a, b) => {
      const da = (WAYPOINTS[a][0] - bot.position.x) ** 2 + (WAYPOINTS[a][1] - bot.position.z) ** 2;
      const db = (WAYPOINTS[b][0] - bot.position.x) ** 2 + (WAYPOINTS[b][1] - bot.position.z) ** 2;
      return da - db;
    });
    let firstNode = order[0];
    for (const node of order) {
      if (clearSegment(bot.position.x, bot.position.z, WAYPOINTS[node][0], WAYPOINTS[node][1])) {
        firstNode = node;
        break;
      }
    }
    bot.path = findPath(firstNode, toNode);
    bot.pathTarget = null;
    bot.repathAt = 0;
  }

  function followPath(bot, dt, time) {
    if (bot.pathTarget === null) {
      if (!bot.path.length) return true;
      bot.pathTarget = bot.path[0];
    }
    const [gx, gz] = WAYPOINTS[bot.pathTarget];
    const dx = gx - bot.position.x;
    const dz = gz - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.9) {
      bot.path.shift();
      bot.pathTarget = null;
      return followPath(bot, dt, time);
    }
    if (time < bot.detourUntil) {
      // Sidestep along the wall instead of pushing into it: sliding sideways is
      // what finds the door gap the straight leg could not see.
      moveBot(bot, dt, -dz * bot.detourDir, dx * bot.detourDir);
      return false;
    }
    const targetYaw = Math.atan2(-dx, -dz);
    let dyaw = targetYaw - bot.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    bot.yaw += Math.max(-3.2 * dt, Math.min(3.2 * dt, dyaw));
    moveBot(bot, dt, dx, dz);
    return false;
  }

  function syncGroup(bot) {
    bot.group.position.set(bot.position.x, bot.group.position.y, bot.position.z);
    bot.group.rotation.y = bot.yaw;
  }

  // Perception, run at most every PERCEIVE_EVERY seconds per bot: scan for the
  // nearest visible enemy in the view cone (or closer than 6 m in any direction),
  // confirm the raycast, and remember where it was seen. A sighting is shared with
  // living teammates as a callout: their last-seen marks update, so the squad
  // rotates to a push one bot spotted instead of waiting to see it themselves.
  function perceive(bot, ctx, time, dt) {
    bot.perceiveAt -= dt;
    if (bot.perceiveAt > 0) return;
    bot.perceiveAt = PERCEIVE_EVERY;
    bot.visibleEnemy = null;
    let target = null;
    let bestRange = Infinity;
    for (const enemy of ctx.enemiesOf(bot)) {
      if (!enemy.alive) continue;
      const ox = enemy.position.x - bot.position.x;
      const oy = (enemy.position.y + 1.3) - (bot.position.y + 1.5);
      const oz = enemy.position.z - bot.position.z;
      const dist = Math.hypot(ox, oy, oz);
      if (dist > SIGHT_RANGE) continue;
      const bearing = Math.atan2(-ox, -oz);
      let off = bearing - bot.yaw;
      while (off > Math.PI) off -= Math.PI * 2;
      while (off < -Math.PI) off += Math.PI * 2;
      if (Math.abs(off) > SIGHT_HALF_FOV && dist > 6) continue;
      if (!ctx.hasLineOfSight(bot.position, enemy.position)) continue;
      const score = dist + (enemy.isPlayer ? 0 : 4);
      if (score < bestRange) {
        bestRange = score;
        target = enemy;
      }
    }
    if (target) {
      bot.visibleEnemy = target;
      const seen = new THREE.Vector3(target.position.x, target.position.y + 1.3, target.position.z);
      bot.lastSeen = seen;
      bot.lastSeenAt = time;
      for (const mate of bots) {
        if (mate === bot || mate.team !== bot.team || !mate.alive) continue;
        if (!mate.lastSeen || time - mate.lastSeenAt > 2) {
          mate.lastSeen = seen.clone();
          mate.lastSeenAt = time;
        }
      }
      // The radio callout: at most one line per bot every six seconds, so the feed
      // talks without spamming.
      if (ctx.onCallout && time - bot.lastCalloutAt > 6) {
        bot.lastCalloutAt = time;
        ctx.onCallout(bot, seen);
      }
    } else if (bot.lastSeen && time - bot.lastSeenAt > CALLOUT_FRESH_SECONDS) {
      bot.lastSeen = null;
    }
  }

  // Plant / defuse channels. Returns true when the bot is busy channeling and the
  // rest of the step should wait; the caller cancels a stale channel when the
  // conditions below stop holding (an enemy appears, the bot walks off the site).
  function channel(bot, ctx, dt) {
    const enemy = bot.visibleEnemy;
    if (bot.isCarrier && bot.team === 'raider' && ctx.bombState === 'none') {
      const site = SITES[bot.targetSite];
      const d = Math.hypot(site.center.x - bot.position.x, site.center.z - bot.position.z);
      // Plant under distant fire: a defender 18 m out cannot stop a 3 s channel,
      // so the carrier plants instead of duelling at range. A close enemy still
      // pulls the carrier into a fight — planting face-to-face is suicide.
      const enemyDist = enemy ? Math.hypot(enemy.position.x - bot.position.x, enemy.position.z - bot.position.z) : Infinity;
      if (d < site.radius && enemyDist > 18) {
        if (!bot.channel || bot.channel.kind !== 'plant') {
          bot.channel = { kind: 'plant', progress: 0 };
          ctx.onChannelStart?.(bot, 'plant');
        }
        bot.channel.progress += dt;
        ctx.onChannelProgress?.(bot, 'plant', bot.channel.progress / PLANT_SECONDS);
        if (bot.channel.progress >= PLANT_SECONDS) {
          bot.channel = null;
          ctx.onPlanted?.(bot, bot.targetSite);
        }
        return true;
      }
    }
    if (bot.team === 'vanguard' && ctx.bombState === 'planted' && !enemy) {
      const d = Math.hypot(ctx.bombPosition.x - bot.position.x, ctx.bombPosition.z - bot.position.z);
      if (d < 2.6) {
        if (!bot.channel || bot.channel.kind !== 'defuse') {
          bot.channel = { kind: 'defuse', progress: 0 };
          ctx.onChannelStart?.(bot, 'defuse');
        }
        bot.channel.progress += dt;
        ctx.onChannelProgress?.(bot, 'defuse', bot.channel.progress / DEFUSE_SECONDS);
        if (bot.channel.progress >= DEFUSE_SECONDS) {
          bot.channel = null;
          ctx.onDefused?.(bot);
        }
        return true;
      }
    }
    if (bot.channel) {
      bot.channel = null;
      ctx.onChannelStop?.(bot);
    }
    return false;
  }

  // Combat: turn to face the enemy, strafe sideways, close in past 14 m, and fire
  // in bursts. Aim error grows with range: a bot is deadly up close, but at 30 m
  // and beyond its bursts spread wide enough to survive behind cover.
  function combat(bot, enemy, ctx, dt, time) {
    const ox = enemy.position.x - bot.position.x;
    const oy = (enemy.position.y + 1.3) - (bot.position.y + 1.5);
    const oz = enemy.position.z - bot.position.z;
    const faceYaw = Math.atan2(-ox, -oz);
    let dyaw = faceYaw - bot.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    bot.yaw += Math.max(-6 * dt, Math.min(6 * dt, dyaw));
    if (time > bot.strafeAt) {
      bot.strafeAt = time + 0.7 + ctx.random() * 0.9;
      bot.strafeDir = ctx.random() < 0.5 ? -1 : 1;
    }
    const dist = Math.hypot(ox, oz);
    const closing = dist > 14 ? 1 : 0;
    const fwdX = -Math.sin(bot.yaw);
    const fwdZ = -Math.cos(bot.yaw);
    const sideX = Math.cos(bot.yaw) * bot.strafeDir;
    const sideZ = -Math.sin(bot.yaw) * bot.strafeDir;
    moveBot(bot, dt, fwdX * closing + sideX * 0.55, fwdZ * closing + sideZ * 0.55);
    if (time >= bot.pauseUntil) {
      if (bot.burstLeft <= 0) bot.burstLeft = BURST_MIN + Math.floor(ctx.random() * (BURST_MAX - BURST_MIN + 1));
      if (time >= bot.shotAt) {
        bot.shotAt = time + SHOT_GAP;
        bot.burstLeft -= 1;
        if (bot.burstLeft <= 0) bot.pauseUntil = time + 0.7 + ctx.random() * 0.6;
        const error = Math.max(AIM_ERROR_MIN, AIM_ERROR_START - bot.aimTime * 0.02) + dist * 0.0012;
        const aim = new THREE.Vector3(ox, oy, oz).normalize();
        aim.x += (ctx.random() * 2 - 1) * error;
        aim.y += (ctx.random() * 2 - 1) * error * 0.7;
        aim.z += (ctx.random() * 2 - 1) * error;
        aim.normalize();
        const origin = new THREE.Vector3(bot.position.x, bot.position.y + 1.45, bot.position.z);
        ctx.fireHitscan(bot, origin, aim, 60);
      }
    }
  }

  // The objective half of a step, for a bot with no visible enemy. Raiders push
  // their site, guard a planted charge, or walk escort beside the carrier; Vanguard
  // bots rotate to a planted charge, investigate a fresh sighting near their post,
  // or hold the post and scan. Paths are refreshed every 1.5 s while walking: a
  // path planned before a fight goes stale the moment the bot strafes sideways, and
  // a stale first leg is what pins bots to walls.
  function workObjective(bot, ctx, dt, time) {
    const objectiveNode = bot.targetSite === 'A' ? 12 : 13;
    if (bot.team === 'raider') {
      if (ctx.bombState === 'planted') {
        // Guard the planted charge: hold near the site.
        const site = SITES[ctx.bombSite];
        if (Math.hypot(site.center.x - bot.position.x, site.center.z - bot.position.z) > 3) {
          if (bot.state !== 'advance' || !bot.path.length || time >= bot.repathAt) {
            setPath(bot, objectiveNode);
            bot.state = 'advance';
            bot.repathAt = time + 1.5;
          }
        } else {
          bot.state = 'hold';
          bot.yaw += dt * 0.5;
        }
        if (bot.state === 'advance') followPath(bot, dt, time);
        return;
      }
      const carrier = bots.find((b) => b.isCarrier && b.alive);
      // One escort walks beside the carrier: the first living non-carrier Raider.
      // The rest push the site or hold overwatch, so the plant is covered without
      // turning the whole push into a single file behind the carrier. The escort
      // only falls in once the carrier starts moving: while the carrier holds at
      // spawn, the escort pushes with the rest, so the opening is three Raiders
      // strong instead of two.
      const escort = carrier ? bots.find((b) => b.team === 'raider' && b.alive && !b.isCarrier) : null;
      if (escort === bot && carrier && time >= carrier.delayUntil) {
        const escortGap = Math.hypot(carrier.position.x - bot.position.x, carrier.position.z - bot.position.z);
        if (escortGap > 4) {
          const node = nearestNodeIndex(carrier.position);
          if (!bot.path.length || time >= bot.repathAt) {
            setPath(bot, node);
            bot.repathAt = time + 1.5;
          }
          followPath(bot, dt, time);
        } else {
          bot.yaw = carrier.yaw;
        }
        return;
      }
      if (!bot.isCarrier && carrier) {
        // Overwatch: a Raider that reaches the site first holds the door and
        // covers the carrier's plant, instead of crowding the plant spot.
        const site = SITES[bot.targetSite];
        const doorDist = Math.hypot(site.center.x - bot.position.x, site.center.z - bot.position.z);
        if (doorDist < site.radius + 1.5) {
          bot.state = 'hold';
          bot.yaw += dt * 0.8;
          return;
        }
      }
      if (bot.state !== 'advance' || !bot.path.length || time >= bot.repathAt) {
        setPath(bot, objectiveNode);
        bot.state = 'advance';
        bot.repathAt = time + 1.5;
      }
      followPath(bot, dt, time);
      return;
    }
    // Vanguard.
    if (ctx.bombState === 'planted') {
      const targetNode = ctx.bombSite === 'A' ? 12 : 13;
      if (bot.state !== 'advance' || !bot.path.length || time >= bot.repathAt) {
        setPath(bot, targetNode);
        bot.state = 'advance';
        bot.repathAt = time + 1.5;
      }
      followPath(bot, dt, time);
      return;
    }
    if (bot.lastSeen && time - bot.lastSeenAt < CALLOUT_FRESH_SECONDS) {
      // Only chase a sighting near the post: a defender that runs across
      // the map leaves its site open, and the plant walks in behind it.
      const [px, pz] = WAYPOINTS[bot.postNode];
      const nearPost = Math.hypot(px - bot.lastSeen.x, pz - bot.lastSeen.z) < 14;
      if (!nearPost) {
        bot.lastSeen = null;
        bot.state = 'hold';
      } else {
        const node = nearestNodeIndex(bot.lastSeen);
        if (bot.state !== 'investigate' || !bot.path.length || time >= bot.repathAt) {
          setPath(bot, node);
          bot.state = 'investigate';
          bot.repathAt = time + 1.5;
        }
        if (followPath(bot, dt, time)) {
          bot.lastSeen = null;
          bot.state = 'hold';
        }
      }
      return;
    }
    if (bot.state !== 'hold' || !bot.path.length || time >= bot.repathAt) {
      setPath(bot, bot.postNode);
      bot.state = 'hold';
      bot.repathAt = time + 1.5;
    }
    if (followPath(bot, dt, time)) {
      bot.yaw += Math.sin(time * 0.6 + bot.postNode) * dt * 0.7;
    }
  }

  // A Raider with a fresh last-seen mark it cannot see lobs its frag at the mark
  // instead of walking into the corner blind: the blast clears the hold, and the
  // bang tells every bot nearby where the fight is. Only when the mark is close
  // enough to be worth the grenade and the thrower has one left.
  function maybeThrowGrenade(bot, ctx, time) {
    if (bot.team !== 'raider' || bot.grenades <= 0 || !ctx.throwGrenade) return;
    if (!bot.lastSeen || time - bot.lastSeenAt > 4 || time < bot.grenadeAt) return;
    const d = Math.hypot(bot.lastSeen.x - bot.position.x, bot.lastSeen.z - bot.position.z);
    if (d < 4 || d > 16) return;
    if (ctx.throwGrenade(bot, bot.lastSeen)) {
      bot.grenades -= 1;
      bot.grenadeAt = time + 14 + ctx.random() * 8;
    }
  }

  // Stuck? Sidestep along the wall for a beat, then replan from wherever the bot
  // actually is. Replanning the same leg without the sidestep is what used to keep
  // bots pinned to a wall for a whole round.
  function handleStuck(bot, ctx, time) {
    const moved = Math.hypot(bot.position.x - bot.stuckPos.x, bot.position.z - bot.stuckPos.z);
    if (moved < 0.15) {
      if (time - bot.stuckAt > 1.0) {
        const goal = ctx.bombState === 'planted'
          ? (ctx.bombSite === 'A' ? 12 : 13)
          : bot.team === 'raider' ? (bot.targetSite === 'A' ? 12 : 13) : bot.postNode;
        setPath(bot, goal);
        bot.detourUntil = time + 0.9;
        bot.detourDir = ctx.random() < 0.5 ? -1 : 1;
        bot.stuckAt = time;
        bot.stuckPos.copy(bot.position);
      }
    } else {
      bot.stuckAt = time;
      bot.stuckPos.copy(bot.position);
    }
  }

  return {
    bots,
    hitMeshes,
    place,
    setPath,
    nearestNodeIndex,
    // Damage a bot: armour absorbs half the hit first, a hit breaks the bot's aim,
    // and a lethal hit starts the fall. Returns true when the bot died.
    damage(bot, amount, part) {
      if (!bot.alive) return false;
      let remaining = amount;
      if (bot.armor > 0) {
        const absorbed = Math.min(bot.armor, remaining * 0.5);
        bot.armor -= absorbed;
        remaining -= absorbed;
      }
      bot.health -= remaining;
      // A hit breaks the bot's aim: its aim error resets, so the first shot in a
      // duel is worth more than the damage alone.
      bot.aimTime = 0;
      if (bot.health > 0) return false;
      bot.alive = false;
      bot.health = 0;
      bot.channel = null;
      bot.fall = 0;
      return true;
    },
    aliveCount(team) {
      return bots.filter((b) => b.team === team && b.alive).length;
    },
    step(dt, ctx) {
      const time = ctx.time;
      for (const bot of bots) {
        if (!bot.alive) {
          if (bot.fall < 1) {
            bot.fall = Math.min(1, bot.fall + dt / 0.4);
            bot.group.rotation.x = -bot.fall * 1.5;
            bot.group.position.y = -bot.fall * 0.1;
          }
          continue;
        }
        // The carrier holds at spawn for the first seconds of the round: its
        // teammates draw the defenders first, then it slips in behind the fight.
        if (bot.delayUntil && time < bot.delayUntil) {
          syncGroup(bot);
          continue;
        }
        perceive(bot, ctx, time, dt);
        const enemy = bot.visibleEnemy;
        if (enemy) bot.aimTime += dt;
        else bot.aimTime = 0;
        if (channel(bot, ctx, dt)) {
          syncGroup(bot);
          continue;
        }
        if (enemy) {
          combat(bot, enemy, ctx, dt, time);
          syncGroup(bot);
          continue;
        }
        maybeThrowGrenade(bot, ctx, time);
        workObjective(bot, ctx, dt, time);
        handleStuck(bot, ctx, time);
        syncGroup(bot);
      }
    },
  };
}
