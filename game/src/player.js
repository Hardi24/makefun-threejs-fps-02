// Player movement: acceleration, friction, gravity, crouch and jump, resolved as a
// box against the world's colliders one axis at a time, so a wall never swallows the
// player. Aiming down the sights slows the walk to a careful pace, and crouching slows
// it further while dropping the eye to a lower line. A small head bob rides on ground
// speed, so walking reads in the camera without touching the aim. The step exposes two
// events the sound layer uses: a footstep each stride and a landing thud when a jump
// comes down.
import * as THREE from 'three';

const RADIUS = 0.34;
const STAND_HEIGHT = 1.72;
const CROUCH_HEIGHT = 1.12;
const STAND_EYE = 1.6;
const CROUCH_EYE = 1.02;
const WALK_SPEED = 5.2;
const CROUCH_SPEED = 2.4;
const ADS_SPEED = 2.9;
const GROUND_ACCEL = 42;
const AIR_ACCEL = 9;
const FRICTION = 9;
const GRAVITY = 20;
const JUMP_SPEED = 6.2;
const STRIDE_LENGTH = 2.3;

export function createPlayer(colliders) {
  const player = {
    position: new THREE.Vector3(0, 0, 9.5),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    eye: STAND_EYE,
    onGround: true,
    crouching: false,
    aiming: false,
    height: STAND_HEIGHT,
    bobPhase: 0,
    bob: 0,
    stride: 0,
    stepped: false,
    landed: false,
  };
  const probe = new THREE.Box3();
  const move = new THREE.Vector3();

  // lift keeps the feet and the crown out of the horizontal tests, so standing on
  // the floor is not read as walking into a wall.
  function overlaps(x, y, z, height, lift) {
    probe.min.set(x - RADIUS, y + lift, z - RADIUS);
    probe.max.set(x + RADIUS, y + height - lift, z + RADIUS);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return collider;
    return null;
  }

  function look(dx, dy, sensitivity = 0.0022) {
    player.yaw -= dx * sensitivity;
    player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - dy * sensitivity));
  }

  function recoil(pitchKick, yawKick) {
    player.pitch = Math.min(1.45, player.pitch + pitchKick);
    player.yaw += yawKick;
  }

  function step(dt, keys, aiming = false) {
    player.stepped = false;
    player.landed = false;
    player.aiming = aiming;
    const crouching = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    if (crouching && !player.crouching) {
      player.crouching = true;
      player.height = CROUCH_HEIGHT;
    } else if (!crouching && player.crouching && !overlaps(player.position.x, player.position.y, player.position.z, STAND_HEIGHT, 0.02)) {
      player.crouching = false;
      player.height = STAND_HEIGHT;
    }
    const eyeTarget = player.crouching ? CROUCH_EYE : STAND_EYE;
    player.eye += (eyeTarget - player.eye) * Math.min(1, dt * 12);

    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    move.set(0, 0, 0);
    if (forward || strafe) {
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      move.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe).normalize();
    }

    const speed = player.crouching ? CROUCH_SPEED : player.aiming ? ADS_SPEED : WALK_SPEED;
    const blend = Math.min(1, (player.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt / speed);
    player.velocity.x += (move.x * speed - player.velocity.x) * blend;
    player.velocity.z += (move.z * speed - player.velocity.z) * blend;
    if (player.onGround && !move.lengthSq()) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      player.velocity.x *= damp;
      player.velocity.z *= damp;
    }

    const wasAirborne = !player.onGround;
    if (keys.has('Space') && player.onGround) {
      player.velocity.y = JUMP_SPEED;
      player.onGround = false;
    }
    player.velocity.y -= GRAVITY * dt;

    const nextX = player.position.x + player.velocity.x * dt;
    if (!overlaps(nextX, player.position.y, player.position.z, player.height, 0.04)) player.position.x = nextX;
    else player.velocity.x = 0;
    const nextZ = player.position.z + player.velocity.z * dt;
    if (!overlaps(player.position.x, player.position.y, nextZ, player.height, 0.04)) player.position.z = nextZ;
    else player.velocity.z = 0;

    player.position.y += player.velocity.y * dt;
    player.onGround = false;
    const hit = overlaps(player.position.x, player.position.y, player.position.z, player.height, 0);
    if (hit && player.velocity.y <= 0) {
      player.position.y = hit.max.y;
      player.velocity.y = 0;
      player.onGround = true;
    } else if (hit) {
      player.position.y = hit.min.y - player.height;
      player.velocity.y = 0;
    }
    if (player.position.y < 0) {
      player.position.y = 0;
      player.velocity.y = 0;
      player.onGround = true;
    }
    player.velocity.y = Math.max(-30, player.velocity.y);
    if (wasAirborne && player.onGround) player.landed = true;

    // Head bob and footsteps: two steps per cycle, scaled by ground speed, fading
    // out in the air. A stride is one full step cycle.
    const groundSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    if (player.onGround && groundSpeed > 0.5) {
      player.bobPhase += dt * groundSpeed * 1.9;
      player.bob = Math.sin(player.bobPhase) * 0.028 * Math.min(1, groundSpeed / WALK_SPEED);
      player.stride += groundSpeed * dt;
      if (player.stride >= STRIDE_LENGTH) {
        player.stride -= STRIDE_LENGTH;
        player.stepped = true;
      }
    } else {
      player.bob *= Math.max(0, 1 - dt * 8);
    }
  }

  return {
    state: player,
    step,
    look,
    recoil,
    groundSpeed() {
      return Math.hypot(player.velocity.x, player.velocity.z);
    },
  };
}
