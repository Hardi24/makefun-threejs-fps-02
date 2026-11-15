// Dustline Yard: an open-air industrial yard, 48 x 40 m, built from boxes and cylinders.
// Three lanes run south to north — West, Mid, East — from the Vanguard spawn to the two
// objective sites: Foundry (A, west) and Depot (B, east). Raiders spawn north, between
// the sites. Every solid is a collider for the player and the bots and a surface a bullet
// stops on. Site letters and signs are painted on canvas textures at runtime: no image
// files, no network. Waypoints are the bot navigation graph; every edge is a straight,
// wall-clear walk between two nodes (checked against the wall layout below). Dust motes
// drift over the yard and a warehouse skyline stands beyond the walls, so the horizon
// is a place too.
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

// A letter board texture: dark plate, coloured border, one big letter.
function letterPlate(letter, color) {
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

// A name sign texture: dark plate with one line of bold text.
function signPlate(text, color) {
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
  const sandMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#8a7a5c'), roughness: 1.0, metalness: 0.0 });

  const colliders = [];
  const shootables = [];
  // Flat [x1, z1, x2, z2] wall segments for the minimap.
  const minimapWalls = [];

  // A solid box: visible, casts and receives shadows, and — unless told otherwise —
  // blocks movement and stops bullets. Every wall, container and crate goes through it.
  function solid(width, height, depth, x, y, z, material, { collider = true, shadow = true } = {}) {
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

  // A wall running north–south (along z) at a fixed x.
  function wallNS(x, z1, z2, height = 3.4) {
    const len = z2 - z1;
    solid(0.6, height, len, x, height / 2, (z1 + z2) / 2, materials.surface);
    minimapWalls.push([x, z1, x, z2]);
  }

  // A wall running east–west (along x) at a fixed z.
  function wallEW(z, x1, x2, height = 3.4) {
    const len = x2 - x1;
    solid(len, height, 0.6, (x1 + x2) / 2, height / 2, z, materials.surface);
    minimapWalls.push([x1, z, x2, z]);
  }

  // The floor and the outer walls (48 x 40 m, 5 m high). The floor is pale concrete
  // so the yard reads in daylight; the walls keep the darker surface tone.
  const concrete = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3d444d'), roughness: 0.95, metalness: 0.02 });
  solid(48.6, 0.4, 40.6, 0, -0.2, 0, concrete);
  wallNS(-24, -20, 20, 5);
  wallNS(24, -20, 20, 5);
  wallEW(-20, -24, 24, 5);
  wallEW(20, -24, 24, 5);

  // The spawn divider (z = 2): three doors — west (-16..-12), mid (-6..6), east (12..16).
  wallEW(2, -24, -16);
  wallEW(2, -12, -6);
  wallEW(2, 6, 12);
  wallEW(2, 16, 24);

  // Lane dividers (x = -6 and x = 6, z -8..2) with a door at z -1..1.
  wallNS(-6, -8, -1);
  wallNS(-6, 1, 2);
  wallNS(6, -8, -1);
  wallNS(6, 1, 2);

  // The north cross wall (z = -8): a mid door at x -2..2, site doors at x -18..-16 and 16..18.
  wallEW(-8, -10, -2);
  wallEW(-8, 2, 10);
  wallEW(-8, -24, -18);
  wallEW(-8, -16, -10);
  wallEW(-8, 10, 16);
  wallEW(-8, 18, 24);

  // Site side walls (x = -10 / x = 10, z -20..-12) with a door at z -12..-8.
  wallNS(-10, -20, -12);
  wallNS(10, -20, -12);

  // Cover: containers, crates and barrels. None of them sits on a waypoint edge.
  solid(2.6, 2.4, 1.4, 2.2, 1.2, -3.5, containerTeal);      // mid cover
  solid(1.4, 1.4, 1.4, -3.5, 0.7, -5.5, containerRust);      // mid west crate
  solid(1.4, 1.4, 1.4, 3.5, 0.7, -5.5, containerGrey);       // mid east crate
  solid(4.0, 2.6, 2.0, -14, 1.3, -14.5, containerRust);      // Foundry container
  solid(1.4, 1.4, 1.4, -20.5, 0.7, -10.5, containerTeal);    // Foundry corner crate
  solid(1.2, 1.2, 1.2, -11.5, 0.6, -16.5, containerGrey);    // Foundry low crate
  solid(4.0, 2.6, 2.0, 14, 1.3, -14.5, containerTeal);       // Depot container
  solid(1.4, 1.4, 1.4, 20.5, 0.7, -10.5, containerRust);     // Depot corner crate
  solid(1.2, 1.2, 1.2, 11.5, 0.6, -16.5, containerGrey);     // Depot low crate
  solid(3.0, 2.4, 1.6, -19, 1.2, 8, containerGrey);          // west lane container
  solid(3.0, 2.4, 1.6, 19, 1.2, 8, containerTeal);           // east lane container
  solid(1.4, 1.4, 1.4, -9.5, 0.7, -4, containerRust);        // west mid crate
  solid(1.4, 1.4, 1.4, 9.5, 0.7, -4, containerGrey);         // east mid crate
  solid(2.0, 1.0, 1.0, 6, 0.5, 12, containerRust);           // spawn cover
  solid(1.2, 1.2, 1.2, -21, 0.6, 4, containerGrey);          // west south crate
  solid(1.2, 1.2, 1.2, 21, 0.6, 4, containerTeal);           // east south crate

  // Barrels: cylinders with box colliders approximated from their bounds.
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

  // Sandbag rows: low cover tucked against the walls, out of every lane and off
  // every waypoint edge. Waist-high, so they block feet but not bullets at chest height.
  for (const [x, z, w, d] of [[-23, 12, 1.0, 4.0], [23, 12, 1.0, 4.0], [-12, -19, 4.0, 1.0], [12, -19, 4.0, 1.0]]) {
    solid(w, 0.55, d, x, 0.28, z, sandMat);
  }

  // A watchtower in the south-east corner: four thin legs and a platform at 3.2 m.
  // The legs block movement; the platform is decoration — nobody climbs up there.
  for (const [lx, lz] of [[20.7, 16.7], [22.3, 16.7], [20.7, 18.3], [22.3, 18.3]]) {
    solid(0.15, 3.2, 0.15, lx, 1.6, lz, materials.ink);
  }
  solid(1.9, 0.15, 1.9, 21.5, 3.25, 17.5, materials.surface, { collider: false, shadow: false });
  solid(1.9, 0.5, 0.08, 21.5, 3.6, 18.45, materials.ink, { collider: false, shadow: false });

  // Cables strung between the floodlight poles: sagging lines, no colliders, just
  // something for the eye to follow across the dusk sky.
  const cableMat = new THREE.LineBasicMaterial({ color: new THREE.Color('#1a1d20') });
  for (const z of [18, -18]) {
    const points = [];
    for (let i = 0; i <= 12; i += 1) {
      const t = i / 12;
      const x = -22 + t * 44;
      const y = 7.5 - Math.sin(t * Math.PI) * 1.3;
      points.push(new THREE.Vector3(x, y, z));
    }
    const cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), cableMat);
    group.add(cable);
  }

  // The yard's name painted on the spawn floor: a flat, faded sign underfoot.
  const floorLogo = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 2.25),
    new THREE.MeshBasicMaterial({ map: signPlate('DUSTLINE YARD', PALETTE.ink), transparent: true, opacity: 0.32, side: THREE.DoubleSide }),
  );
  floorLogo.rotation.x = -Math.PI / 2;
  floorLogo.rotation.z = Math.PI;
  floorLogo.position.set(0, 0.025, 10);
  group.add(floorLogo);

  // Site ground markers: a flat coloured ring on the floor for each site.
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
      new THREE.MeshBasicMaterial({ map: letterPlate(site.letter, site.color) }),
    );
    board.position.set(site.center.x, 3.4, -19.6);
    group.add(board);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 1.25),
      new THREE.MeshBasicMaterial({ map: signPlate(`${site.letter} — ${site.name.toUpperCase()}`, site.color) }),
    );
    sign.position.set(site.center.x, 4.4, -8.4);
    sign.rotation.y = Math.PI;
    group.add(sign);
  }
  const yardSign = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 2),
    new THREE.MeshBasicMaterial({ map: signPlate('DUSTLINE YARD', PALETTE.ink) }),
  );
  yardSign.position.set(0, 4.2, 19.6);
  yardSign.rotation.y = Math.PI;
  group.add(yardSign);

  // The warehouse skyline beyond the walls: dark slabs that read as the district
  // around the yard. No colliders, no shadows — pure horizon, inside the fog's reach.
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

  // Floodlight poles at the four corners: tall masts with a warm lamp head that
  // glows against the dusk sky. Decoration only — the yard's real light is the
  // sun rig below — but they sell the hour and give the lanes vertical rhythm.
  const poleMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#22262c'), roughness: 0.6, metalness: 0.5 });
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffe6b0') });
  for (const [x, z] of [[-22, 18], [22, 18], [-22, -18], [22, -18]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 7.5, 8), poleMat);
    pole.position.set(x, 3.75, z);
    pole.castShadow = true;
    group.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 0.4), poleMat);
    head.position.set(x, 7.5, z);
    head.rotation.y = Math.atan2(-x, -z);
    group.add(head);
    const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.18), lampMat);
    lamp.position.set(x - Math.sin(Math.atan2(-x, -z)) * 0.22, 7.42, z - Math.cos(Math.atan2(-x, -z)) * 0.22);
    lamp.rotation.y = Math.atan2(-x, -z);
    group.add(lamp);
  }

  // A tower crane over the north-east corner: a mast, a jib reaching over the Depot
  // site and a hanging hook block. A silhouette against the sky, nothing more.
  const craneMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#1f242a') });
  const craneMast = new THREE.Mesh(new THREE.BoxGeometry(0.9, 16, 0.9), craneMat);
  craneMast.position.set(26, 8, -24);
  group.add(craneMast);
  const craneJib = new THREE.Mesh(new THREE.BoxGeometry(14, 0.7, 0.7), craneMat);
  craneJib.position.set(19, 15.5, -24);
  group.add(craneJib);
  const craneHook = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5), craneMat);
  craneHook.position.set(13, 12.5, -24);
  group.add(craneHook);

  // Hazard chevrons at the site doors: flat amber stripes on the floor that mark
  // the threshold where a push becomes a plant.
  const hazardMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  for (const [x, z, rot] of [[-17, -8, 0], [17, -8, 0], [0, -8, Math.PI / 2]]) {
    for (let i = -2; i <= 2; i += 1) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 1.6), hazardMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.rotation.z = rot + (i % 2 === 0 ? 0.5 : -0.5);
      stripe.position.set(x + (rot === 0 ? i * 0.7 : 0), 0.02, z + (rot === 0 ? 0 : i * 0.7));
      group.add(stripe);
    }
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
