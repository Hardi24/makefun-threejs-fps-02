// The armoury: four hitscan weapons, each with its own view model, magazine, fire rate,
// damage and spread. Accuracy counts more than speed: spread grows with movement and with
// sustained fire, and the first shot from still is the truest. Headshots pay: a hit on the
// head multiplies damage (3x, 2.5x on the marksman). The weapon owns the numbers;
// main.js owns the ray and the damage.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 Sidearm', price: 0, magSize: 12, reserve: 48,
    fireGap: 0.16, reloadTime: 1.3, damage: 26, headMult: 3,
    spreadStill: 0.004, spreadMoving: 0.03, auto: false, range: 60,
  },
  smg: {
    id: 'smg', name: 'Hornet SMG', price: 600, magSize: 28, reserve: 84,
    fireGap: 0.075, reloadTime: 1.7, damage: 22, headMult: 3,
    spreadStill: 0.007, spreadMoving: 0.036, auto: true, range: 50,
  },
  rifle: {
    id: 'rifle', name: 'VK-47 Rifle', price: 1000, magSize: 30, reserve: 90,
    fireGap: 0.096, reloadTime: 1.9, damage: 34, headMult: 3,
    spreadStill: 0.0022, spreadMoving: 0.028, auto: true, range: 80,
  },
  marksman: {
    id: 'marksman', name: 'Longbow DMR', price: 1500, magSize: 5, reserve: 20,
    fireGap: 0.85, reloadTime: 2.6, damage: 80, headMult: 2.5,
    spreadStill: 0.0008, spreadMoving: 0.05, auto: false, range: 100,
  },
};

export const WEAPON_ORDER = ['pistol', 'smg', 'rifle', 'marksman'];

const MOVE_REFERENCE = 5.2;

export function createWeapon(camera) {
  const grip = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.2 });
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.45, metalness: 0.2 });

  const model = new THREE.Group();
  camera.add(model);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.3, -0.26, -1.2);
  flash.visible = false;
  camera.add(flash);

  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  flashLight.position.set(0.3, -0.24, -0.9);
  camera.add(flashLight);

  let def = WEAPONS.rifle;
  const state = {
    weaponId: 'rifle', mag: def.magSize, reserve: def.reserve,
    cooldown: 0, reloadLeft: 0, flash: 0, kick: 0, bloom: 0,
  };

  function buildModel() {
    while (model.children.length) {
      const child = model.children.pop();
      child.geometry?.dispose?.();
    }
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), body);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.4), grip);
    barrel.position.set(0, 0.025, -0.38);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.22), grip);
    stock.position.set(0, -0.02, 0.18);
    model.add(receiver, barrel, stock);
    if (def.id === 'pistol') {
      barrel.scale.set(0.8, 0.8, 0.5);
      barrel.position.z = -0.28;
      stock.visible = false;
    } else if (def.id === 'smg') {
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.08), accent);
      mag.position.set(0, -0.14, -0.05);
      model.add(mag);
    } else if (def.id === 'marksman') {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10), accent);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.09, -0.05);
      model.add(scope);
      barrel.scale.set(1, 1, 1.5);
      barrel.position.z = -0.5;
    } else {
      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.03), accent);
      sight.position.set(0, 0.08, -0.1);
      model.add(sight);
    }
    // Pushed out and shrunk: a view model this close to the camera reads as a wall
    // of metal. At 0.75 m with a 0.65 scale the receiver sits in the lower-right
    // corner the way a held rifle should.
    model.position.set(0.3, -0.28, -0.75);
    model.scale.setScalar(0.65);
    model.rotation.set(0, 0, 0);
  }

  buildModel();

  function step(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    state.bloom = Math.max(0, state.bloom - dt * 0.06);
    model.position.z = -0.75 + state.kick;
    model.rotation.x = state.kick * 2.2;
    flash.visible = state.flash > 0;
    flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      model.rotation.x = -0.55 * Math.min(1, (def.reloadTime - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const need = def.magSize - state.mag;
        const take = Math.min(need, state.reserve);
        state.mag += take;
        state.reserve -= take;
      }
    }
  }

  return {
    state,
    def() {
      return def;
    },
    step,
    ready() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    pullTrigger() {
      state.cooldown = def.fireGap;
      state.flash = 0.06;
      state.kick = def.id === 'marksman' ? 0.11 : 0.055;
      state.bloom = Math.min(0.05, state.bloom + (def.id === 'smg' ? 0.004 : 0.007));
    },
    takeRound() {
      if (state.mag <= 0) return false;
      state.mag -= 1;
      return true;
    },
    reload() {
      if (state.reloadLeft > 0 || state.mag === def.magSize || state.reserve === 0) return false;
      state.reloadLeft = def.reloadTime;
      return true;
    },
    spread(speed) {
      const moving = def.spreadStill + Math.min(1, speed / MOVE_REFERENCE) * def.spreadMoving;
      return moving + state.bloom;
    },
    equip(weaponId, keepAmmo = false) {
      if (!WEAPONS[weaponId] || weaponId === state.weaponId) return false;
      def = WEAPONS[weaponId];
      state.weaponId = weaponId;
      state.mag = def.magSize;
      state.reserve = def.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.bloom = 0;
      buildModel();
      return true;
    },
    refill() {
      state.mag = def.magSize;
      state.reserve = def.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
      state.bloom = 0;
    },
  };
}
