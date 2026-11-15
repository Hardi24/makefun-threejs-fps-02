// Dustline Yard: an open-air industrial yard, 48 x 40 m, built from boxes and cylinders.
// Three lanes run south to north — West, Mid, East — from the Vanguard spawn to the two
// objective sites: Foundry (A, west) and Depot (B, east). Raiders spawn north, between the
// sites. Every box is a collider for the player and the bots and a surface a bullet stops
// on. Site letters and signs are drawn on canvas textures at runtime: no image files, no
// network. Waypoints are the bot navigation graph; every edge is a straight, wall-clear
// walk between two nodes (checked against the wall layout below). Dust motes drift over the
// yard and a warehouse skyline stands beyond the walls, so the horizon is a place too.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// Waypoint nodes: [x, z]. Edges are index pairs; the graph is symmetric.
export const WAYPOINTS = [
  [0, 16],      // 0  vanguard spawn
  [-14, 14],    // 1  vanguard west
  [14, 14],     // 2  vanguard east
  [0, 7],       // 3  mid south
  [-15, 5],     // 4  west south
  [15, 5],      // 5  east south
  [0, -1],      // 6  mid centre
  [-15, -4],    // 7  west mid
  [15, -4],     // 8  east mid
  [0, -6],      // 9  mid north
  [-17, -7],    // 10 foundry door
  [17, -7],     // 11 depot door
  [-17, -13],   // 12 site A (Foundry)
  [17, -13],    // 13 site B (Depot)
  [0, -11],     // 14 raider mid
  [-7, -11],    // 15 raider west
  [7, -11],     // 16 raider east
  [0, -17],     // 17 raider spawn
  [-8, 0],      // 18 west door
  [8, 0],       // 19 east door
];

export const WAYPOINT_EDGES = [
  [0, 1], [0, 2], [0, 3],
  [1, 4], [2, 5], [3, 4], [3, 5], [3, 6],
  [4, 7], [5, 8],
  [6, 9], [6, 18], [6, 19],
  [7, 10], [7, 18], [8, 11], [8, 19],
  [9, 14],
  [10, 12], [11, 13],
  [12, 15], [13, 16],
  [14, 15], [14, 16], [14, 17],
  [15, 17], [16, 17],
];

export const SITES = {
  A: { name: 'Foundry', letter: 'A', center: new THREE.Vector3(-17, 0, -13), radius: 4.5, color: PALETTE.siteA },
  B: { name: 'Depot', letter: 'B', center: new THREE.Vector3(17, 0, -13), radius: 4.5, color: PALETTE.siteB },
};

export const SPAWNS = {
  vanguard: [
    new THREE.Vector3(0, 0, 16),
    new THREE.Vector3(-3, 0, 17),
    new THREE.Vector3(3, 0, 17),
  ],
  raider: [
    new THREE.Vector3(0, 0, -17),
    new THREE.Vector3(-4, 0, -17.5),
    new THREE.Vector3(4, 0, -17.5),
    new THREE.Vector3(-7, 0, -14),
    new THREE.Vector3(7, 0, -14),
  ],
};

function letterTexture(letter, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d');
  g.fillStyle = '#1e2228';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = color;
  g.lineWidth = 10;
  g.strokeRect(10, 10, 236, 236);
  g.fillStyle = color;
  g.font = 'bold 150px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, 128, 138);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function signTexture(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = '#14161a';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = color;
  g.font = 'bold 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'accent' || name === 'ink' ? 0.55 : 0.92,
      metalness: 0.03,
    });
  }
  // Warm container paint and cool concrete, so the yard reads as a place, not a grey box.
  const containerTeal = new THREE.MeshStandardMaterial({ color: new THREE.Color('#2e6f66'), roughness: 0.8, metalness: 0.15 });
  const containerRust = new THREE.MeshStandardMaterial({ color: new THREE.Color('#7a4a28'), roughness: 0.85, metalness: 0.1 });
  const containerGrey = new THREE.MeshStandardMaterial({ color: new THREE.Color('#4a525c'), roughness: 0.8, metalness: 0.2 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#5c5142'), roughness: 0.7, metalness: 0.3 });

  const colliders = [];
  const shootables = [];
  // Flat [x1, z1, x2, z2] wall segments for the minimap.
  const minimapWalls = [];

  function box(width, height, depth, x, y, z, material, { collider = true, shadow = true } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collider) {
      colliders.push(new THREE.Box3().setFromObject(mesh));
      shootables.push(mesh);
    }
    return mesh;
  }

  function wallX(x, z1, z2, height = 3.4) {
    // Wall running along z at fixed x.
    const len = z2 - z1;
    box(0.6, height, len, x, height / 2, (z1 + z2) / 2, materials.surface);
    minimapWalls.push([x, z1, x, z2]);
  }

  function wallZ(z, x1, x2, height = 3.4) {
    // Wall running along x at fixed z.
    const len = x2 - x1;
    box(len, height, 0.6, (x1 + x2) / 2, height / 2, z, materials.surface);
    minimapWalls.push([x1, z, x2, z]);
  }

  // Ground and outer walls (48 x 40 m, 5 m high). The floor is pale concrete so the
  // yard reads in daylight; the walls stay the darker surface tone.
  const concrete = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3d444d'), roughness: 0.95, metalness: 0.02 });
  box(48.6, 0.4, 40.6, 0, -0.2, 0, concrete);
  wallX(-24, -20, 20, 5);
  wallX(24, -20, 20, 5);
  wallZ(-20, -24, 24, 5);
  wallZ(20, -24, 24, 5);

  // Spawn divider (z = 2): three doors — west (-16..-12), mid (-6..6), east (12..16).
  wallZ(2, -24, -16);
  wallZ(2, -12, -6);
  wallZ(2, 6, 12);
  wallZ(2, 16, 24);

  // Lane dividers (x = -6 and x = 6, z -8..2) with a door at z -1..1.
  wallX(-6, -8, -1);
  wallX(-6, 1, 2);
  wallX(6, -8, -1);
  wallX(6, 1, 2);

  // North cross wall (z = -8): mid door at x -2..2, site doors at x -18..-16 and 16..18.
  wallZ(-8, -10, -2);
  wallZ(-8, 2, 10);
  wallZ(-8, -24, -18);
  wallZ(-8, -16, -10);
  wallZ(-8, 10, 16);
  wallZ(-8, 18, 24);

  // Site side walls (x = -10 / x = 10, z -20..-12) with a door at z -12..-8.
  wallX(-10, -20, -12);
  wallX(10, -20, -12);

  // Cover: containers, crates and barrels. None of them sits on a waypoint edge.
  box(2.6, 2.4, 1.4, 2.2, 1.2, -3.5, containerTeal);      // mid cover
  box(1.4, 1.4, 1.4, -3.5, 0.7, -5.5, containerRust);      // mid west crate
  box(1.4, 1.4, 1.4, 3.5, 0.7, -5.5, containerGrey);       // mid east crate
  box(4.0, 2.6, 2.0, -14, 1.3, -14.5, containerRust);      // Foundry container
  box(1.4, 1.4, 1.4, -20.5, 0.7, -10.5, containerTeal);    // Foundry corner crate
  box(1.2, 1.2, 1.2, -11.5, 0.6, -16.5, containerGrey);    // Foundry low crate
  box(4.0, 2.6, 2.0, 14, 1.3, -14.5, containerTeal);       // Depot container
  box(1.4, 1.4, 1.4, 20.5, 0.7, -10.5, containerRust);     // Depot corner crate
  box(1.2, 1.2, 1.2, 11.5, 0.6, -16.5, containerGrey);     // Depot low crate
  box(3.0, 2.4, 1.6, -19, 1.2, 8, containerGrey);          // west lane container
  box(3.0, 2.4, 1.6, 19, 1.2, 8, containerTeal);           // east lane container
  box(1.4, 1.4, 1.4, -9.5, 0.7, -4, containerRust);        // west mid crate
  box(1.4, 1.4, 1.4, 9.5, 0.7, -4, containerGrey);         // east mid crate
  box(2.0, 1.0, 1.0, 6, 0.5, 12, containerRust);           // spawn cover
  box(1.2, 1.2, 1.2, -21, 0.6, 4, containerGrey);          // west south crate
  box(1.2, 1.2, 1.2, 21, 0.6, 4, containerTeal);           // east south crate

  // Barrels (cylinders, box colliders approximated).
  const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 1.1, 12);
  for (const [x, z] of [[-5, -6.5], [5, -6.5], [-19, -16], [19, -16], [-8, 13], [8, 13]]) {
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.position.set(x, 0.55, z);
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    group.add(barrel);
    colliders.push(new THREE.Box3().setFromObject(barrel));
    shootables.push(barrel);
  }

  // Site ground markers: a flat coloured zone ring on the floor.
  for (const site of Object.values(SITES)) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.radius - 0.35, site.radius, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(site.color), transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.center.x, 0.02, site.center.z);
    group.add(ring);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(site.radius - 0.4, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(site.color), transparent: true, opacity: 0.07, side: THREE.DoubleSide }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(site.center.x, 0.015, site.center.z);
    group.add(disc);
  }

  // Site letter boards on the north wall and name signs above the site doors.
  for (const site of Object.values(SITES)) {
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 3),
      new THREE.MeshBasicMaterial({ map: letterTexture(site.letter, site.color) }),
    );
    board.position.set(site.center.x, 3.4, -19.6);
    group.add(board);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 1.25),
      new THREE.MeshBasicMaterial({ map: signTexture(`${site.letter} — ${site.name.toUpperCase()}`, site.color) }),
    );
    sign.position.set(site.center.x, 4.4, -8.4);
    sign.rotation.y = Math.PI;
    group.add(sign);
  }
  const yardSign = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 2),
    new THREE.MeshBasicMaterial({ map: signTexture('DUSTLINE YARD', PALETTE.ink) }),
  );
  yardSign.position.set(0, 4.2, 19.6);
  yardSign.rotation.y = Math.PI;
  group.add(yardSign);

  // Warehouse skyline beyond the walls: dark slabs that read as the district around
  // the yard. No colliders, no shadows — pure horizon, inside the fog's reach.
  const skylineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#232a32') });
  const skylineMatFar = new THREE.MeshBasicMaterial({ color: new THREE.Color('#2b333d') });
  for (const [w, h, d, x, z, far] of [
    [10, 9, 6, -30, -14, false], [8, 12, 6, -32, 4, true], [12, 7, 6, -30, 16, false],
    [9, 11, 6, 30, -12, true], [11, 8, 6, 32, 6, false], [7, 13, 6, 30, 18, true],
    [14, 8, 6, -12, -30, false], [9, 12, 6, 6, -31, true], [12, 9, 6, 20, -29, false],
    [10, 7, 6, -14, 30, true], [8, 10, 6, 12, 31, false],
  ]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), far ? skylineMatFar : skylineMat);
    slab.position.set(x, h / 2 - 0.5, z);
    group.add(slab);
  }

  // Dust motes: a few hundred pale points drifting over the yard on fixed,
  // deterministic paths (a seeded shuffle, no Math.random at runtime), so the air
  // has texture without costing a frame or breaking a deterministic capture.
  const DUST_COUNT = 220;
  const dustBase = new Float32Array(DUST_COUNT * 3);
  const dustPhase = new Float32Array(DUST_COUNT);
  let dustSeed = 20261115;
  const dustRand = () => {
    dustSeed = (dustSeed * 1103515245 + 12345) & 0x7fffffff;
    return dustSeed / 0x7fffffff;
  };
  for (let i = 0; i < DUST_COUNT; i += 1) {
    dustBase[i * 3] = -23 + dustRand() * 46;
    dustBase[i * 3 + 1] = 0.3 + dustRand() * 4.6;
    dustBase[i * 3 + 2] = -19 + dustRand() * 38;
    dustPhase[i] = dustRand() * Math.PI * 2;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustBase.slice(), 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: new THREE.Color('#d8c9a3'), size: 0.05, transparent: true, opacity: 0.55, depthWrite: false,
  }));
  dust.frustumCulled = false;
  group.add(dust);
  function stepDust(time) {
    const positions = dustGeo.attributes.position.array;
    for (let i = 0; i < DUST_COUNT; i += 1) {
      positions[i * 3] = dustBase[i * 3] + Math.sin(time * 0.12 + dustPhase[i]) * 0.7;
      positions[i * 3 + 1] = dustBase[i * 3 + 1] + Math.sin(time * 0.2 + dustPhase[i] * 2) * 0.25;
      positions[i * 3 + 2] = dustBase[i * 3 + 2] + Math.cos(time * 0.1 + dustPhase[i]) * 0.7;
    }
    dustGeo.attributes.position.needsUpdate = true;
  }

  // Light: a warm key from the south-east, a cool fill from the north, sky/ground gradient.
  // The yard is lit like late afternoon, not night: the ground bounce is light enough
  // that the floor and the low cover read from across the map.
  const sky = new THREE.HemisphereLight(new THREE.Color('#aab8c8'), new THREE.Color('#4a5158'), 1.5);
  scene.add(sky);
  const key = new THREE.DirectionalLight(new THREE.Color('#fff2d8'), 2.8);
  key.position.set(14, 18, 12);
  key.target.position.set(0, 0, -4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -28;
  key.shadow.camera.right = 28;
  key.shadow.camera.top = 28;
  key.shadow.camera.bottom = -28;
  key.shadow.camera.far = 60;
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.muted), 0.8);
  fill.position.set(-10, 10, -14);
  scene.add(fill);

  return { colliders, shootables, group, minimapWalls, stepDust };
}
