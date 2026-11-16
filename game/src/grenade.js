// Frag grenades clear a corner no rifle can; smoke grenades blind it. A thrown
// grenade flies an arc, bounces off the world, fuses for 1.4 s, then detonates: a
// frag bursts with blast damage that falls off with range and stops at walls, a
// smoke blooms into a grey cloud that blocks sight for 15 s — bots lose their
// target through it, and so does the player. The thrower names the owner, so a
// blast only hurts the other team. A fixed pool of six slots means a long round
// never allocates mid-flight — five Raiders can each hold a frag and the player
// can still throw — and every random number comes from the caller's seeded source,
import * as THREE from 'three';

const GRAVITY = 12;
const FUSE = 1.4;
const BLAST_RADIUS = 7;
const BLAST_CENTER = 130;
const BLAST_EDGE = 25;
const SMOKE_RADIUS = 4;
const SMOKE_SECONDS = 15;
const RADIUS = 0.12;
const RESTITUTION = 0.45;
const MAX_LIVE = 6;
const DEBRIS = 26;
const BURST_SECONDS = 0.6;

export function createGrenades(scene, world) {
  const colliders = world.colliders;
  const slots = [];

  function blocked(x, y, z) {
    for (const box of colliders) {
      if (x >= box.min.x - RADIUS && x <= box.max.x + RADIUS
        && y >= box.min.y - RADIUS && y <= box.max.y + RADIUS
        && z >= box.min.z - RADIUS && z <= box.max.z + RADIUS) return true;
    }
    return false;
  }

  for (let i = 0; i < MAX_LIVE; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshStandardMaterial({ color: new THREE.Color('#2c323a'), roughness: 0.5, metalness: 0.6, emissive: new THREE.Color('#ff5a1f'), emissiveIntensity: 0 }),
    );
    mesh.visible = false;
    scene.add(mesh);
    const burst = new THREE.Mesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff9a3c'), transparent: true, opacity: 0, depthWrite: false }),
    );
    burst.visible = false;
    scene.add(burst);
    const light = new THREE.PointLight(new THREE.Color('#ff8c2e'), 0, 18, 2);
    scene.add(light);
    const debrisGeo = new THREE.BufferGeometry();
    debrisGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DEBRIS * 3), 3));
    const debris = new THREE.Points(debrisGeo, new THREE.PointsMaterial({
      color: new THREE.Color('#ffb35c'), size: 0.09, transparent: true, opacity: 0, depthWrite: false,
    }));
    debris.visible = false;
    debris.frustumCulled = false;
    scene.add(debris);
    // The smoke cloud: one grey sphere per slot, scaled to the cloud radius when
    // a smoke detonates. Each slot owns its material, so fading one cloud never
    // touches another.
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#8f959c'), transparent: true, opacity: 0.5, depthWrite: false }),
    );
    smoke.visible = false;
    scene.add(smoke);
    slots.push({
      state: 'idle', mesh, burst, light, debris, smoke, kind: 'frag',
      position: new THREE.Vector3(), velocity: new THREE.Vector3(),
      fuse: 0, owner: null, age: 0, debrisVel: new Float32Array(DEBRIS * 3),
    });
  }

  function freeSlot() {
    return slots.find((slot) => slot.state === 'idle') || null;
  }

  // A lob that lands on the target after flightTime seconds: the arc is solved, not
  // guessed, so a bot's grenade and a capture's grenade land where they were aimed.
  function lob(origin, target, flightTime, owner, kind = 'frag') {
    const slot = freeSlot();
    if (!slot) return false;
    const t = Math.max(0.3, flightTime);
    slot.position.copy(origin);
    slot.velocity.set(
      (target.x - origin.x) / t,
      (target.y - origin.y + 0.5 * GRAVITY * t * t) / t,
      (target.z - origin.z) / t,
    );
    slot.fuse = FUSE;
    slot.owner = owner;
    slot.kind = kind;
    slot.state = 'flying';
    slot.mesh.visible = true;
    slot.mesh.position.copy(origin);
    return true;
  }

  // A free throw down the aim direction: fast and flat, for clearing the lane ahead.
  function toss(origin, direction, speed, owner, kind = 'frag') {
    const slot = freeSlot();
    if (!slot) return false;
    slot.position.copy(origin);
    slot.velocity.copy(direction).multiplyScalar(speed);
    slot.velocity.y += 3.5;
    slot.fuse = FUSE;
    slot.owner = owner;
    slot.kind = kind;
    slot.state = 'flying';
    slot.mesh.visible = true;
    slot.mesh.position.copy(origin);
    return true;
  }

  function detonate(slot, ctx) {
    slot.mesh.visible = false;
    slot.mesh.material.emissiveIntensity = 0;
    // A smoke blooms instead of bursting: no damage, no debris — just the cloud,
    // squashed flat so it hangs over the lane like a bank of fog.
    if (slot.kind === 'smoke') {
      slot.state = 'smoke';
      slot.age = 0;
      slot.smoke.position.copy(slot.position);
      slot.smoke.scale.set(SMOKE_RADIUS, SMOKE_RADIUS * 0.55, SMOKE_RADIUS);
      slot.smoke.material.opacity = 0.5;
      slot.smoke.visible = true;
      ctx.onSmoke?.(slot.position.clone());
      return;
    }
    slot.state = 'burst';
    slot.age = 0;
    slot.burst.position.copy(slot.position);
    slot.burst.visible = true;
    slot.light.position.copy(slot.position).y += 0.6;
    slot.light.intensity = 60;
    for (let i = 0; i < DEBRIS; i += 1) {
      const angle = ctx.random() * Math.PI * 2;
      const up = 0.4 + ctx.random() * 0.8;
      const speed = 3 + ctx.random() * 7;
      slot.debrisVel[i * 3] = Math.cos(angle) * speed;
      slot.debrisVel[i * 3 + 1] = up * speed;
      slot.debrisVel[i * 3 + 2] = Math.sin(angle) * speed;
    }
    slot.debris.visible = true;
    ctx.onDetonate(slot.position.clone(), slot.owner);
  }

  function stepSlot(slot, dt, ctx) {
    if (slot.state === 'flying') {
      slot.velocity.y -= GRAVITY * dt;
      const nextX = slot.position.x + slot.velocity.x * dt;
      if (blocked(nextX, slot.position.y, slot.position.z)) {
        slot.velocity.x *= -RESTITUTION;
        slot.velocity.y *= 0.8;
        slot.velocity.z *= 0.8;
      } else slot.position.x = nextX;
      const nextZ = slot.position.z + slot.velocity.z * dt;
      if (blocked(slot.position.x, slot.position.y, nextZ)) {
        slot.velocity.z *= -RESTITUTION;
        slot.velocity.x *= 0.8;
        slot.velocity.y *= 0.8;
      } else slot.position.z = nextZ;
      const nextY = slot.position.y + slot.velocity.y * dt;
      if (nextY < RADIUS) {
        slot.position.y = RADIUS;
        slot.velocity.y = Math.abs(slot.velocity.y) > 0.6 ? -slot.velocity.y * RESTITUTION : 0;
        slot.velocity.x *= 0.7;
        slot.velocity.z *= 0.7;
      } else if (blocked(slot.position.x, nextY, slot.position.z)) {
        slot.velocity.y *= -RESTITUTION;
        slot.velocity.x *= 0.8;
        slot.velocity.z *= 0.8;
      } else slot.position.y = nextY;
      slot.mesh.position.copy(slot.position);
      // The fuse blinks faster as it runs out: the last half-second strobes.
      slot.mesh.material.emissiveIntensity = slot.fuse < 0.5
        ? (Math.sin(slot.fuse * 40) > 0 ? 2.2 : 0.2)
        : 0.6;
      slot.fuse -= dt;
      if (slot.fuse <= 0) detonate(slot, ctx);
    } else if (slot.state === 'smoke') {
      // The cloud hangs, then thins out over its last three seconds.
      slot.age += dt;
      if (slot.age >= SMOKE_SECONDS) {
        slot.state = 'idle';
        slot.smoke.visible = false;
        return;
      }
      if (slot.age > SMOKE_SECONDS - 3) slot.smoke.material.opacity = 0.5 * (SMOKE_SECONDS - slot.age) / 3;
    } else if (slot.state === 'burst') {
      slot.age += dt;
      const t = slot.age / BURST_SECONDS;
      if (t >= 1) {
        slot.state = 'idle';
        slot.burst.visible = false;
        slot.debris.visible = false;
        slot.light.intensity = 0;
        return;
      }
      const scale = 1 + t * 12;
      slot.burst.scale.setScalar(scale);
      slot.burst.material.opacity = 0.85 * (1 - t);
      slot.light.intensity = 60 * (1 - t);
      const positions = slot.debris.geometry.attributes.position.array;
      for (let i = 0; i < DEBRIS; i += 1) {
        positions[i * 3] = slot.position.x + slot.debrisVel[i * 3] * slot.age;
        positions[i * 3 + 1] = Math.max(0.05, slot.position.y + slot.debrisVel[i * 3 + 1] * slot.age - 4.5 * slot.age * slot.age);
        positions[i * 3 + 2] = slot.position.z + slot.debrisVel[i * 3 + 2] * slot.age;
      }
      slot.debris.geometry.attributes.position.needsUpdate = true;
      slot.debris.material.opacity = 1 - t;
    }
  }

  return {
    lob,
    toss,
    get liveCount() {
      return slots.filter((slot) => slot.state !== 'idle').length;
    },
    // Live smoke clouds, for line-of-sight checks: a ray through a cloud is
    // blocked, so bots and blasts alike lose their target behind smoke.
    get smokeClouds() {
      return slots
        .filter((slot) => slot.state === 'smoke')
        .map((slot) => ({ x: slot.position.x, z: slot.position.z, radius: SMOKE_RADIUS }));
    },
    step(dt, ctx) {
      for (const slot of slots) stepSlot(slot, dt, ctx);
    },
    // Blast damage at a point: full at the centre, the edge value at the rim, and
    // nothing past the wall between the blast and the target.
    damageAt(position, target, hasLineOfSight) {
      const d = Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z);
      if (d >= BLAST_RADIUS) return 0;
      if (!hasLineOfSight(position, target)) return 0;
      return Math.round(BLAST_EDGE + (BLAST_CENTER - BLAST_EDGE) * (1 - d / BLAST_RADIUS));
    },
    get blastRadius() {
      return BLAST_RADIUS;
    },
    get blastCenter() {
      return BLAST_CENTER;
    },
  };
}
