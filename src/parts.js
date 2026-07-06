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

// panel-line texture drawn on a canvas so tanks are not just flat color
let panelTexture = null;
function getPanelTexture() {
  if (panelTexture) return panelTexture;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#d8d8dc';
  g.fillRect(0, 0, 256, 256);
  // subtle brushed streaks
  for (let i = 0; i < 500; i++) {
    const y = Math.random() * 256;
    g.strokeStyle = 'rgba(0,0,0,' + (Math.random() * 0.04) + ')';
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y + (Math.random() - 0.5) * 4);
    g.stroke();
  }
  // vertical panel seams
  g.strokeStyle = 'rgba(40,45,55,0.55)';
  g.lineWidth = 2;
  for (let x = 0; x <= 256; x += 64) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke();
  }
  // horizontal seams
  for (let y = 0; y <= 256; y += 128) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  // rivets along seams
  g.fillStyle = 'rgba(60,64,72,0.6)';
  for (let x = 0; x <= 256; x += 64) {
    for (let y = 8; y < 256; y += 24) {
      g.beginPath(); g.arc((x + 6) % 256, y, 1.5, 0, Math.PI * 2); g.fill();
    }
  }
  panelTexture = new THREE.CanvasTexture(c);
  panelTexture.wrapS = THREE.RepeatWrapping;
  panelTexture.wrapT = THREE.RepeatWrapping;
  return panelTexture;
}

function tankMaterial() {
  return new THREE.MeshStandardMaterial({
    map: getPanelTexture(),
    color: 0xffffff,
    metalness: 0.75,
    roughness: 0.35,
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

function nozzleMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x22242a, metalness: 0.95, roughness: 0.3,
  });
}

// ---- mesh builders ----
// Each returns a THREE.Group. group.userData.height is the stacking height,
// so the rocket assembler knows how far to move up for the next part.

const R = 0.5; // shared body radius so parts line up

function buildNoseStandard() {
  const g = new THREE.Group();
  // lathe profile: rounded cone
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(R * Math.cos(t * Math.PI * 0.5), 1.2 * Math.sin(t * Math.PI * 0.5)));
  }
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), paintedMaterial(0xc94f30));
  g.add(mesh);
  g.userData.height = 1.2;
  return g;
}

function buildNoseAero() {
  const g = new THREE.Group();
  // long ogive with a needle spike
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(new THREE.Vector2(R * (1 - t * t), 1.6 * t));
  }
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), paintedMaterial(0xdfe2e6));
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.5, 8), darkMetal());
  spike.position.y = 1.8;
  g.add(body, spike);
  g.userData.height = 2.05;
  return g;
}

function buildTank(height) {
  const g = new THREE.Group();
  const mat = tankMaterial();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, height, 24), mat);
  body.position.y = height / 2;
  // end rings so stacked tanks read as separate sections
  const ringGeo = new THREE.TorusGeometry(R, 0.035, 8, 24);
  const ringTop = new THREE.Mesh(ringGeo, darkMetal());
  ringTop.rotation.x = Math.PI / 2;
  ringTop.position.y = height - 0.02;
  const ringBot = ringTop.clone();
  ringBot.position.y = 0.02;
  g.add(body, ringTop, ringBot);
  g.userData.height = height;
  return g;
}

function buildEngine(id) {
  const g = new THREE.Group();
  if (id === 'engine-basic') {
    // simple bell
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.38, 0.5, 20, 1, true), nozzleMaterial());
    bell.position.y = 0.25;
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.8, 0.25, 20), darkMetal());
    mount.position.y = 0.62;
    g.add(bell, mount);
    g.userData.height = 0.75;
    g.userData.nozzleY = 0.05;
  } else if (id === 'engine-vector') {
    // longer bell with a gimbal collar
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push(new THREE.Vector2(0.16 + 0.3 * t * t, 0.7 * (1 - t)));
    }
    const bell = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), nozzleMaterial());
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.06, 8, 20), darkMetal());
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.72;
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.75, 0.3, 20), darkMetal());
    mount.position.y = 0.92;
    g.add(bell, collar, mount);
    g.userData.height = 1.07;
    g.userData.nozzleY = 0.05;
  } else {
    // heavy: cluster of three bells under a wide skirt
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.1, 0.4, 24), darkMetal());
    skirt.position.y = 0.75;
    g.add(skirt);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.24, 0.55, 16, 1, true), nozzleMaterial());
      bell.position.set(Math.cos(a) * 0.24, 0.3, Math.sin(a) * 0.24);
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
  const mat = paintedMaterial(id === 'fins-swept' ? 0x2c3340 : 0xc94f30);
  // thin extruded fin profile, four around the body
  const shape = new THREE.Shape();
  if (id === 'fins-swept') {
    shape.moveTo(0, 0);
    shape.lineTo(0.55, -0.35);
    shape.lineTo(0.55, -0.05);
    shape.lineTo(0, 0.7);
    shape.lineTo(0, 0);
  } else {
    shape.moveTo(0, 0);
    shape.lineTo(0.5, 0);
    shape.lineTo(0.5, 0.35);
    shape.lineTo(0, 0.6);
    shape.lineTo(0, 0);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false });
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
  const mat = tankMaterial();
  for (const side of [-1, 1]) {
    const booster = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.6, 16), mat);
    body.position.y = 0.9;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.4, 16), paintedMaterial(0xc94f30));
    cone.position.y = 1.9;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.16, 0.25, 12, 1, true), nozzleMaterial());
    nozzle.position.y = 0.08;
    booster.add(body, cone, nozzle);
    booster.position.x = side * (R + 0.24);
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
  else if (id === 'tank-small') g = buildTank(1.0);
  else if (id === 'tank-medium') g = buildTank(1.8);
  else if (id === 'tank-large') g = buildTank(2.8);
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
