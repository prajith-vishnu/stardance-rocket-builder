import * as THREE from 'three';

// All gameplay stats are plain integers. Mass in kg-ish arcade units,
// thrust in newton-ish arcade units, fuel in abstract units.
// cost = points needed to unlock (0 = starter part).

export const PARTS = {
  'nose-standard': {
    name: 'Standard Cone', category: 'Nose Cone',
    mass: 10, drag: 5, cost: 0,
    desc: 'mass 10 / drag 5',
  },
  'nose-aero': {
    name: 'Aero Spike', category: 'Nose Cone',
    mass: 8, drag: 2, cost: 400,
    desc: 'mass 8 / drag 2',
  },
  'tank-small': {
    name: 'Small Tank', category: 'Fuel Tank',
    mass: 20, fuel: 100, cost: 0,
    desc: 'mass 20 / fuel 100',
  },
  'tank-medium': {
    name: 'Medium Tank', category: 'Fuel Tank',
    mass: 35, fuel: 220, cost: 250,
    desc: 'mass 35 / fuel 220',
  },
  'tank-large': {
    name: 'Large Tank', category: 'Fuel Tank',
    mass: 55, fuel: 400, cost: 800,
    desc: 'mass 55 / fuel 400',
  },
  'engine-basic': {
    name: 'Sparrow Engine', category: 'Engine',
    mass: 15, thrust: 900, burn: 20, cost: 0,
    desc: 'thrust 900 / burn 20 per s',
  },
  'engine-vector': {
    name: 'Kestrel Engine', category: 'Engine',
    mass: 22, thrust: 1600, burn: 30, cost: 500,
    desc: 'thrust 1600 / burn 30 per s',
  },
  'engine-heavy': {
    name: 'Condor Engine', category: 'Engine',
    mass: 40, thrust: 3000, burn: 55, cost: 1200,
    desc: 'thrust 3000 / burn 55 per s',
  },
  'fins-basic': {
    name: 'Flat Fins', category: 'Fins',
    mass: 6, stability: 3, cost: 0,
    desc: 'mass 6 / stability +3',
  },
  'fins-swept': {
    name: 'Swept Fins', category: 'Fins',
    mass: 5, stability: 5, cost: 300,
    desc: 'mass 5 / stability +5',
  },
  'booster-pair': {
    name: 'Strap-on Boosters', category: 'Boosters',
    mass: 30, thrust: 1000, fuel: 120, burn: 40, cost: 600,
    desc: 'thrust +1000 / own fuel 120',
  },
  'parachute': {
    name: 'Parachute', category: 'Recovery',
    mass: 5, cost: 200,
    desc: 'mass 5 / soft landings',
  },
};

export const CATEGORY_ORDER = ['Nose Cone', 'Fuel Tank', 'Engine', 'Fins', 'Boosters', 'Recovery'];

// ---- materials ----

// hull texture drawn on a canvas: panel seams, rivets, a roll-pattern
// stripe pair, an orange band, and grime streaks so it reads as a real
// flight vehicle instead of a solid color
let hullMap = null;
let hullRough = null;
let plainMap = null;

function drawSeams(g, size, vStep, hStep) {
  g.strokeStyle = 'rgba(52,58,68,0.5)';
  g.lineWidth = 2;
  for (let x = 0; x <= size; x += vStep) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, size); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.beginPath(); g.moveTo(x + 2, 0); g.lineTo(x + 2, size); g.stroke();
    g.strokeStyle = 'rgba(52,58,68,0.5)';
  }
  for (let y = 0; y <= size; y += hStep) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(size, y); g.stroke();
  }
  // rivets along the vertical seams
  g.fillStyle = 'rgba(60,64,72,0.55)';
  for (let x = 0; x <= size; x += vStep) {
    for (let y = 10; y < size; y += 26) {
      g.beginPath(); g.arc((x + 7) % size, y, 2, 0, Math.PI * 2); g.fill();
    }
  }
}

function getHullTextures() {
  if (hullMap) return { map: hullMap, rough: hullRough };
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#d3d6db';
  g.fillRect(0, 0, 512, 512);
  // brushed metal streaks running the length of the hull
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 512;
    g.strokeStyle = 'rgba(' + (Math.random() < 0.5 ? '255,255,255' : '18,22,30') + ',' + (Math.random() * 0.05).toFixed(3) + ')';
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + (Math.random() - 0.5) * 8, 512);
    g.stroke();
  }
  drawSeams(g, 512, 128, 170);
  // roll pattern: two black stripes on opposite sides of the hull
  g.fillStyle = 'rgba(22,24,29,0.92)';
  g.fillRect(116, 0, 24, 512);
  g.fillRect(372, 0, 24, 512);
  // thin international-orange band near the top of each section
  g.fillStyle = '#c04a2a';
  g.fillRect(0, 22, 512, 13);
  // grime streaks bleeding down from the horizontal seams
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 512;
    const y = 170 * (1 + Math.floor(Math.random() * 2));
    const len = 24 + Math.random() * 60;
    const streak = g.createLinearGradient(0, y, 0, y + len);
    streak.addColorStop(0, 'rgba(48,44,38,0.16)');
    streak.addColorStop(1, 'rgba(48,44,38,0)');
    g.fillStyle = streak;
    g.fillRect(x, y, 2 + Math.random() * 3, len);
  }
  hullMap = new THREE.CanvasTexture(c);
  hullMap.colorSpace = THREE.SRGBColorSpace;

  // roughness variation: streaky so highlights break up like worn metal
  const rc = document.createElement('canvas');
  rc.width = 256; rc.height = 256;
  const rg = rc.getContext('2d');
  rg.fillStyle = '#8c8c8c';
  rg.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * 256;
    rg.strokeStyle = 'rgba(' + (Math.random() < 0.5 ? '230,230,230' : '90,90,90') + ',' + (0.05 + Math.random() * 0.1).toFixed(3) + ')';
    rg.beginPath();
    rg.moveTo(x, 0);
    rg.lineTo(x + (Math.random() - 0.5) * 20, 256);
    rg.stroke();
  }
  hullRough = new THREE.CanvasTexture(rc);
  return { map: hullMap, rough: hullRough };
}

// plain white-painted panels for the boosters
function getPlainTexture() {
  if (plainMap) return plainMap;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#e2e3e6';
  g.fillRect(0, 0, 256, 256);
  drawSeams(g, 256, 128, 128);
  plainMap = new THREE.CanvasTexture(c);
  plainMap.colorSpace = THREE.SRGBColorSpace;
  return plainMap;
}

function tankMaterial() {
  const t = getHullTextures();
  return new THREE.MeshStandardMaterial({
    map: t.map,
    roughnessMap: t.rough,
    bumpMap: t.map,
    bumpScale: 0.01,
    metalness: 0.85,
    roughness: 0.7,
  });
}

function boosterMaterial() {
  return new THREE.MeshStandardMaterial({
    map: getPlainTexture(),
    metalness: 0.45,
    roughness: 0.45,
  });
}

function paintedMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color, metalness: 0.3, roughness: 0.55,
  });
}

function darkMetal() {
  return new THREE.MeshStandardMaterial({
    color: 0x3a3d42, metalness: 0.9, roughness: 0.4,
  });
}

function copperPipe() {
  return new THREE.MeshStandardMaterial({
    color: 0x8a5a3a, metalness: 0.9, roughness: 0.35,
  });
}

function nozzleMaterial() {
  // DoubleSide so the inside of the bell shows, emissive is driven by
  // the renderer while the engine is firing
  return new THREE.MeshStandardMaterial({
    color: 0x24262b,
    metalness: 0.95,
    roughness: 0.28,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(0xff5a1f),
    emissiveIntensity: 0,
  });
}

// ---- mesh builders ----
// Each returns a THREE.Group. group.userData.height is the stacking height,
// so the rocket assembler knows how far to move up for the next part.

// shared body radius so parts line up. kept slim: real rockets are
// 8-15x longer than they are wide, and a fat body reads as a toy
const R = 0.32;

// painted white with a dark anti-glare tip and an orange band, drawn
// once onto a canvas and wrapped around the lathe
let noseTex = null;
function getNoseTexture() {
  if (noseTex) return noseTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#eae8e2';
  g.fillRect(0, 0, 128, 256);
  // faint paint streaks
  for (let i = 0; i < 120; i++) {
    g.strokeStyle = 'rgba(120,118,110,' + (Math.random() * 0.05).toFixed(3) + ')';
    const x = Math.random() * 128;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke();
  }
  // dark tip (canvas top = tip of the cone)
  g.fillStyle = '#35383d';
  g.fillRect(0, 0, 128, 40);
  // orange band near the base
  g.fillStyle = '#c04a2a';
  g.fillRect(0, 225, 128, 13);
  noseTex = new THREE.CanvasTexture(c);
  noseTex.colorSpace = THREE.SRGBColorSpace;
  return noseTex;
}

function buildNoseStandard() {
  const g = new THREE.Group();
  // lathe profile: tangent ogive, much finer than a rounded dome
  const pts = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    pts.push(new THREE.Vector2(Math.max(R * Math.pow(1 - t, 0.68), 0.001), 1.6 * t));
  }
  // clearcoat gives the paint that waxy aerospace-gloss look
  const mat = new THREE.MeshPhysicalMaterial({
    map: getNoseTexture(), metalness: 0.2, roughness: 0.42,
    clearcoat: 0.55, clearcoatRoughness: 0.25,
  });
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), mat);
  g.add(mesh);
  g.userData.height = 1.6;
  return g;
}

function buildNoseAero() {
  const g = new THREE.Group();
  // long ogive with a needle spike, bare polished aluminum
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    pts.push(new THREE.Vector2(Math.max(R * (1 - t * t), 0.001), 2.2 * t));
  }
  const body = new THREE.Mesh(
    new THREE.LatheGeometry(pts, 48),
    new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 0.75, roughness: 0.3 })
  );
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.5, 8), darkMetal());
  spike.position.y = 2.4;
  g.add(body, spike);
  g.userData.height = 2.65;
  return g;
}

function buildTank(height) {
  const g = new THREE.Group();
  const mat = tankMaterial();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, height, 40), mat);
  body.position.y = height / 2;
  // end rings so stacked tanks read as separate sections
  const ringGeo = new THREE.TorusGeometry(R, 0.035, 10, 48);
  const ringTop = new THREE.Mesh(ringGeo, darkMetal());
  ringTop.rotation.x = Math.PI / 2;
  ringTop.position.y = height - 0.02;
  const ringBot = ringTop.clone();
  ringBot.position.y = 0.02;
  // cable raceway conduit running up the hull between the stripes
  const raceway = new THREE.Mesh(new THREE.BoxGeometry(0.045, height * 0.94, 0.075), darkMetal());
  const ra = Math.PI / 4;
  raceway.position.set(Math.cos(ra) * (R + 0.02), height / 2, Math.sin(ra) * (R + 0.02));
  raceway.rotation.y = -ra;
  g.add(body, ringTop, ringBot, raceway);
  g.userData.height = height;
  return g;
}

function buildEngine(id) {
  const g = new THREE.Group();
  if (id === 'engine-basic') {
    // simple bell with a gimbal ring and two feed lines
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.26, 0.5, 36, 1, true), nozzleMaterial());
    bell.position.y = 0.25;
    bell.userData.isNozzle = true;
    const gimbal = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 8, 24), darkMetal());
    gimbal.rotation.x = Math.PI / 2;
    gimbal.position.y = 0.52;
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.8, 0.25, 32), darkMetal());
    mount.position.y = 0.62;
    g.add(bell, gimbal, mount);
    for (const side of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 8), copperPipe());
      pipe.position.set(side * 0.14, 0.44, 0);
      pipe.rotation.z = side * -0.5;
      g.add(pipe);
    }
    g.userData.height = 0.75;
    g.userData.nozzleY = 0.05;
  } else if (id === 'engine-vector') {
    // longer bell with a gimbal collar and feed lines around it
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      pts.push(new THREE.Vector2(0.1 + 0.19 * t * t, 0.7 * (1 - t)));
    }
    const bell = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), nozzleMaterial());
    bell.userData.isNozzle = true;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.045, 10, 28), darkMetal());
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.72;
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.75, 0.3, 32), darkMetal());
    mount.position.y = 0.92;
    g.add(bell, collar, mount);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 8), copperPipe());
      pipe.position.set(Math.cos(a) * 0.19, 0.62, Math.sin(a) * 0.19);
      g.add(pipe);
    }
    g.userData.height = 1.07;
    g.userData.nozzleY = 0.05;
  } else {
    // heavy: cluster of three bells under a wide skirt
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.1, 0.4, 36), darkMetal());
    skirt.position.y = 0.75;
    const manifold = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 8, 32), copperPipe());
    manifold.rotation.x = Math.PI / 2;
    manifold.position.y = 0.52;
    g.add(skirt, manifold);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, 0.55, 28, 1, true), nozzleMaterial());
      bell.position.set(Math.cos(a) * 0.16, 0.3, Math.sin(a) * 0.16);
      bell.userData.isNozzle = true;
      g.add(bell);
    }
    g.userData.height = 0.95;
    g.userData.nozzleY = 0.05;
    g.userData.cluster = true;
  }
  return g;
}

function buildFins(id) {
  const g = new THREE.Group();
  // dark fins on a white body, like most sounding rockets
  const mat = paintedMaterial(id === 'fins-swept' ? 0x2c3340 : 0x24272c);
  // thin extruded fin profile, four around the body
  // small thin fins: full-diameter slabs are a model-rocket-kit look
  const shape = new THREE.Shape();
  if (id === 'fins-swept') {
    shape.moveTo(0, 0);
    shape.lineTo(0.34, -0.24);
    shape.lineTo(0.34, -0.04);
    shape.lineTo(0, 0.55);
    shape.lineTo(0, 0);
  } else {
    shape.moveTo(0, 0);
    shape.lineTo(0.3, 0.03);
    shape.lineTo(0.3, 0.25);
    shape.lineTo(0, 0.5);
    shape.lineTo(0, 0);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.024, bevelEnabled: false });
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(geo, mat);
    const a = (i / 4) * Math.PI * 2;
    fin.position.set(Math.cos(a) * R * 0.95, 0.1, Math.sin(a) * R * 0.95);
    fin.rotation.y = -a;
    g.add(fin);
  }
  g.userData.height = 0; // attachment, adds no stack height
  return g;
}

function buildBoosterPair() {
  const g = new THREE.Group();
  const mat = boosterMaterial();
  for (const side of [-1, 1]) {
    const booster = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 2.2, 24), mat);
    body.position.y = 1.35;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.5, 24), paintedMaterial(0xb0472a));
    cone.position.y = 2.7;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 0.25, 20, 1, true), nozzleMaterial());
    nozzle.position.y = 0.08;
    nozzle.userData.isNozzle = true;
    booster.add(body, cone, nozzle);
    booster.position.x = side * (R + 0.16);
    booster.userData.isBooster = true;
    booster.userData.side = side;
    g.add(booster);
  }
  g.userData.height = 0;
  return g;
}

function buildParachuteBox() {
  // packed chute: a small band near the nose. The canopy itself is
  // created by the renderer at deploy time.
  const g = new THREE.Group();
  const band = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.03, R + 0.03, 0.18, 24), paintedMaterial(0xd6a13a));
  band.position.y = 0.09;
  g.add(band);
  g.userData.height = 0;
  return g;
}

export function createPartMesh(id) {
  let g;
  if (id === 'nose-standard') g = buildNoseStandard();
  else if (id === 'nose-aero') g = buildNoseAero();
  else if (id === 'tank-small') g = buildTank(1.5);
  else if (id === 'tank-medium') g = buildTank(2.5);
  else if (id === 'tank-large') g = buildTank(3.7);
  else if (id.startsWith('engine')) g = buildEngine(id);
  else if (id.startsWith('fins')) g = buildFins(id);
  else if (id === 'booster-pair') g = buildBoosterPair();
  else if (id === 'parachute') g = buildParachuteBox();
  else g = new THREE.Group();

  g.userData.partId = id;
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

// free GPU memory when a part is removed or the rocket is rebuilt
export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      // shared textures (panel lines) stay cached on purpose
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
}
