import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPartMesh, disposeGroup } from './parts.js';
import { SPACE_ALT } from './physics.js';

const MAX_PARTICLES = 900;

// each engine tier gets its own flame character
const FLAME_STYLES = {
  'engine-basic':  { perFrame: 2, speed: 9,  spread: 2.4, size: 3.0, life: 0.40 },
  'engine-vector': { perFrame: 3, speed: 15, spread: 1.3, size: 2.6, life: 0.50 },
  'engine-heavy':  { perFrame: 2, speed: 11, spread: 2.9, size: 3.8, life: 0.55 },
};

// sky dome shader: blends a daytime gradient to black based on a
// uniform driven by altitude
const skyVertex = `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const skyFragment = `
  varying vec3 vPos;
  uniform float uSpace; // 0 = ground, 1 = space
  void main() {
    float h = normalize(vPos).y * 0.5 + 0.5;
    vec3 horizon = vec3(0.75, 0.82, 0.90);
    vec3 zenith = vec3(0.20, 0.42, 0.75);
    vec3 day = mix(horizon, zenith, pow(h, 0.6));
    vec3 space = vec3(0.005, 0.006, 0.012);
    gl_FragColor = vec4(mix(day, space, uSpace), 1.0);
  }
`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 4000);
    this.camera.position.set(6, 3, 8);

    this.mode = 'title';
    this.titleAngle = 0;
    this.camTarget = new THREE.Vector3(0, 2, 0);
    this.camGoal = new THREE.Vector3(6, 3, 8);

    this.rocket = new THREE.Group();
    this.scene.add(this.rocket);
    this.rocketParts = []; // groups currently in the rocket
    this.boosterGroup = null;
    this.detachedBoosters = [];
    this.chuteMesh = null;
    this.emitters = []; // local-space nozzle positions on the rocket

    this.setupLights();
    this.setupSky();
    this.setupGround();
    this.setupScenery();
    this.setupClouds();
    this.setupParticles();

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 25;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(0, 2, 0);
    this.controls.enabled = false;

    window.addEventListener('resize', () => this.onResize());
  }

  setupLights() {
    // hemisphere fill so shadowed sides are not pure black
    this.hemi = new THREE.HemisphereLight(0xbfd4ea, 0x4a4238, 0.7);
    this.scene.add(this.hemi);

    // sun with shadows
    this.sun = new THREE.DirectionalLight(0xfff2df, 2.2);
    this.sun.position.set(18, 30, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // wide enough to catch the buildings around the pad too
    this.sun.shadow.camera.left = -45;
    this.sun.shadow.camera.right = 45;
    this.sun.shadow.camera.top = 45;
    this.sun.shadow.camera.bottom = -45;
    this.sun.shadow.camera.far = 150;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // cool rim light from behind so the rocket edge catches
    this.rim = new THREE.DirectionalLight(0x88aaff, 0.6);
    this.rim.position.set(-10, 8, -14);
    this.scene.add(this.rim);
  }

  setupSky() {
    this.skyUniforms = { uSpace: { value: 0 } };
    const skyGeo = new THREE.SphereGeometry(1800, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.skyDome = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.skyDome);

    // starfield, hidden during the day, fades in with altitude
    const starCount = 1200;
    const pos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(1600);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = Math.abs(v.y); // keep stars above the horizon
      pos[i * 3 + 2] = v.z;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 2.2, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.scene.add(this.stars);
  }

  // cheap layered sine noise for the terrain. flat near the pad so the
  // launch site sits on level ground, hills further out
  hillHeight(x, z) {
    const h =
      Math.sin(x * 0.008) * Math.cos(z * 0.006) * 10 +
      Math.sin(x * 0.02 + 3) * Math.sin(z * 0.017 + 1) * 5 +
      Math.sin((x + z) * 0.004) * 12;
    const d = Math.sqrt(x * x + z * z);
    return h * THREE.MathUtils.smoothstep(d, 80, 260);
  }

  makeGroundTexture() {
    // one big hand-painted map: tonal patches, dirt roads, a dry lake.
    // landmarks like these are what make the climb feel fast
    const c = document.createElement('canvas');
    c.width = 2048; c.height = 2048;
    const g = c.getContext('2d');
    g.fillStyle = '#817757';
    g.fillRect(0, 0, 2048, 2048);

    const tones = ['#75694c', '#8c855f', '#665f45', '#877c58', '#7b7154'];
    for (let i = 0; i < 70; i++) {
      g.fillStyle = tones[i % tones.length];
      g.globalAlpha = 0.05 + Math.random() * 0.06;
      g.beginPath();
      g.ellipse(
        Math.random() * 2048, Math.random() * 2048,
        60 + Math.random() * 260, 40 + Math.random() * 200,
        Math.random() * Math.PI, 0, Math.PI * 2
      );
      g.fill();
    }
    g.globalAlpha = 1;

    // speckle
    g.fillStyle = 'rgba(40,36,28,0.08)';
    for (let i = 0; i < 3500; i++) {
      g.fillRect(Math.random() * 2048, Math.random() * 2048, 2, 2);
    }

    // dry lakebed off to the northeast
    const lake = g.createRadialGradient(1420, 660, 30, 1420, 660, 230);
    lake.addColorStop(0, 'rgba(178,168,132,0.9)');
    lake.addColorStop(1, 'rgba(178,168,132,0)');
    g.fillStyle = lake;
    g.beginPath();
    g.ellipse(1420, 660, 230, 150, 0.4, 0, Math.PI * 2);
    g.fill();

    // dirt roads out from the launch site
    g.strokeStyle = 'rgba(66,60,48,0.8)';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(1024, 1024);
    g.quadraticCurveTo(700, 1100, 250, 980);
    g.stroke();
    g.beginPath();
    g.moveTo(1024, 1024);
    g.quadraticCurveTo(1250, 1350, 1500, 1800);
    g.stroke();
    g.beginPath();
    g.moveTo(1024, 1024);
    g.quadraticCurveTo(1150, 800, 1380, 690);
    g.stroke();

    // darker apron right around the pad
    g.fillStyle = 'rgba(70,66,56,0.45)';
    g.fillRect(1014, 1014, 20, 20);

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  setupGround() {
    // haze so the terrain fades into the horizon instead of ending
    this.fogDay = new THREE.Color(0xbdd0e2);
    this.fogSpace = new THREE.Color(0x02030a);
    this.scene.fog = new THREE.Fog(0xbdd0e2, 400, 3200);
    this.starMat.fog = false;

    const geo = new THREE.PlaneGeometry(4000, 4000, 96, 96);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.hillHeight(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const groundMat = new THREE.MeshStandardMaterial({
      map: this.makeGroundTexture(),
      roughness: 1,
    });
    this.ground = new THREE.Mesh(geo, groundMat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // concrete pad with scorch mark
    const pad = new THREE.Group();
    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(3, 3.4, 0.3, 32),
      new THREE.MeshStandardMaterial({ color: 0x9a9a98, roughness: 0.9 })
    );
    slab.position.y = 0.15;
    slab.receiveShadow = true;
    slab.castShadow = true;
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 24),
      new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 1 })
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = 0.301;
    scorch.receiveShadow = true;
    pad.add(slab, scorch);

    // simple gantry tower off to the side
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xb33a2b, metalness: 0.5, roughness: 0.6 });
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.35, 7, 0.35), towerMat);
    tower.position.set(-2.2, 3.5, 0);
    tower.castShadow = true;
    pad.add(tower);
    for (let y = 1.5; y < 7; y += 1.5) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.12), towerMat);
      arm.position.set(-1.55, y, 0);
      arm.castShadow = true;
      pad.add(arm);
    }
    this.pad = pad;
    this.scene.add(pad);
    this.padTop = 0.3;
  }

  setupScenery() {
    const scenery = new THREE.Group();

    // mountain ring on the horizon, hazed out by the fog
    const mountainMat = new THREE.MeshStandardMaterial({
      color: 0x75705f, roughness: 1, flatShading: true,
    });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
      const r = 1350 + Math.random() * 350;
      const h = 40 + Math.random() * 70;
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(120 + Math.random() * 150, h, 5 + Math.floor(Math.random() * 3)),
        mountainMat
      );
      m.position.set(Math.cos(a) * r, h / 2 - 12, Math.sin(a) * r);
      m.rotation.y = Math.random() * Math.PI;
      // stretch them around so they read as ridges, not pyramids
      m.scale.set(1 + Math.random() * 1.6, 1, 1 + Math.random() * 0.7);
      scenery.add(m);
    }

    const concrete = new THREE.MeshStandardMaterial({ color: 0x9d9c94, roughness: 0.9 });
    const whiteMetal = new THREE.MeshStandardMaterial({ color: 0xdcdcd4, metalness: 0.4, roughness: 0.5 });
    const darkSteel = new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.7, roughness: 0.5 });

    // assembly hangar with a big door facing the pad
    const hangar = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(16, 9, 11), whiteMetal);
    body.position.y = 4.5;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(17, 0.7, 12), darkSteel);
    roof.position.y = 9.3;
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.2, 7, 7), darkSteel);
    door.position.set(8.05, 3.5, 0);
    hangar.add(body, roof, door);
    hangar.position.set(-36, 0, 14);
    hangar.rotation.y = 0.35;
    hangar.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scenery.add(hangar);

    // fuel tank farm
    for (let i = 0; i < 3; i++) {
      const tank = new THREE.Group();
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 5.5, 18), whiteMetal);
      barrel.position.y = 2.75;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(2.2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), whiteMetal);
      cap.position.y = 5.5;
      tank.add(barrel, cap);
      tank.position.set(20 + i * 5.5, 0, -16);
      tank.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      scenery.add(tank);
    }

    // tracking dish
    const dishGroup = new THREE.Group();
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 2.6, 10), darkSteel);
    pedestal.position.y = 1.3;
    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(3, 18, 8, 0, Math.PI * 2, 0, Math.PI / 3),
      new THREE.MeshStandardMaterial({ color: 0xc9c9c2, roughness: 0.6, side: THREE.DoubleSide })
    );
    dish.position.y = 3.4;
    dish.rotation.x = Math.PI; // bowl opens skyward
    dish.rotation.z = 0.5;
    dishGroup.add(pedestal, dish);
    dishGroup.position.set(-16, 0, -26);
    dishGroup.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scenery.add(dishGroup);

    // low bunker with an antenna
    const bunker = new THREE.Mesh(new THREE.BoxGeometry(5, 2.2, 4), concrete);
    bunker.position.set(26, 1.1, 22);
    bunker.castShadow = true;
    bunker.receiveShadow = true;
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5, 6), darkSteel);
    antenna.position.set(26, 4.7, 22);
    scenery.add(bunker, antenna);

    // floodlight towers around the pad
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff7d0, emissive: 0xfff2b8, emissiveIntensity: 0.8,
    });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.35, 12, 0.35), darkSteel);
      pole.position.set(Math.cos(a) * 13, 6, Math.sin(a) * 13);
      pole.castShadow = true;
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.5), lampMat);
      head.position.set(Math.cos(a) * 13, 12.2, Math.sin(a) * 13);
      head.lookAt(0, 2, 0);
      scenery.add(pole, head);
    }

    // windsock
    const sockPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 6), darkSteel);
    sockPole.position.set(12, 2, -9);
    const sock = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 1.6, 8, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xd96a2a, roughness: 0.8, side: THREE.DoubleSide })
    );
    sock.rotation.z = Math.PI / 2;
    sock.position.set(12.9, 3.9, -9);
    scenery.add(sockPole, sock);

    // dirt road strips leading away from the pad apron
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x4c4438, roughness: 1 });
    const road1 = new THREE.Mesh(new THREE.PlaneGeometry(30, 2.4), roadMat);
    road1.rotation.x = -Math.PI / 2;
    road1.position.set(-19, 0.03, 8);
    road1.rotation.z = 0.18;
    const road2 = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 26), roadMat);
    road2.rotation.x = -Math.PI / 2;
    road2.position.set(14, 0.03, 12);
    road2.receiveShadow = true;
    road1.receiveShadow = true;
    scenery.add(road1, road2);

    // scattered rocks and scrub bushes out to the hills
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x7b7266, roughness: 1, flatShading: true });
    const bushGeo = new THREE.IcosahedronGeometry(0.7, 0);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x4f5438, roughness: 1, flatShading: true });
    for (let i = 0; i < 70; i++) {
      const isRock = i % 2 === 0;
      const m = new THREE.Mesh(isRock ? rockGeo : bushGeo, isRock ? rockMat : bushMat);
      const a = Math.random() * Math.PI * 2;
      const r = 16 + Math.random() * 320;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const s = isRock ? 0.3 + Math.random() * 1.4 : 0.5 + Math.random() * 0.9;
      m.scale.set(s, s * (isRock ? 0.7 : 0.8), s);
      m.position.set(x, this.hillHeight(x, z) + s * 0.3, z);
      m.rotation.y = Math.random() * Math.PI;
      if (r < 40) m.castShadow = true;
      scenery.add(m);
    }

    this.scene.add(scenery);
  }

  setupClouds() {
    // soft billboard clouds between roughly 180m and 500m, so the rocket
    // punches through the layer on the way up
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    const blob = (x, y, r) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.85)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    };
    blob(64, 70, 52);
    blob(40, 62, 34);
    blob(90, 60, 36);
    blob(64, 52, 30);
    const tex = new THREE.CanvasTexture(c);

    this.clouds = [];
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: 0.3 + Math.random() * 0.25,
      });
      const s = new THREE.Sprite(mat);
      const a = Math.random() * Math.PI * 2;
      const r = 20 + Math.random() * 75;
      s.position.set(Math.cos(a) * r, 45 + Math.random() * 85, Math.sin(a) * r);
      const w = 24 + Math.random() * 26;
      s.scale.set(w, w * 0.32, 1);
      s.userData.drift = 0.4 + Math.random() * 1.1;
      s.userData.baseOpacity = mat.opacity;
      this.clouds.push(s);
      this.scene.add(s);
    }

    // faint high cirrus, a second layer way up for the climb to pass
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: 0.08 + Math.random() * 0.08,
      });
      const s = new THREE.Sprite(mat);
      const a = Math.random() * Math.PI * 2;
      const r = 80 + Math.random() * 450;
      s.position.set(Math.cos(a) * r, 190 + Math.random() * 130, Math.sin(a) * r);
      const w = 70 + Math.random() * 60;
      s.scale.set(w, w * 0.16, 1);
      s.userData.drift = 0.15 + Math.random() * 0.3;
      s.userData.baseOpacity = mat.opacity;
      this.clouds.push(s);
      this.scene.add(s);
    }

    // daytime moon, gets brighter as the sky darkens
    const mc = document.createElement('canvas');
    mc.width = 128; mc.height = 128;
    const mg = mc.getContext('2d');
    const moonGrad = mg.createRadialGradient(64, 64, 20, 64, 64, 62);
    moonGrad.addColorStop(0, 'rgba(240,242,248,1)');
    moonGrad.addColorStop(0.8, 'rgba(230,234,242,0.9)');
    moonGrad.addColorStop(1, 'rgba(230,234,242,0)');
    mg.fillStyle = moonGrad;
    mg.fillRect(0, 0, 128, 128);
    // a few dark maria blotches
    mg.fillStyle = 'rgba(160,168,184,0.5)';
    mg.beginPath(); mg.arc(48, 52, 14, 0, Math.PI * 2); mg.fill();
    mg.beginPath(); mg.arc(78, 74, 10, 0, Math.PI * 2); mg.fill();
    mg.beginPath(); mg.arc(66, 38, 7, 0, Math.PI * 2); mg.fill();
    this.moonMat = new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(mc),
      transparent: true,
      depthWrite: false,
      fog: false,
      opacity: 0.35,
    });
    this.moon = new THREE.Sprite(this.moonMat);
    this.moon.scale.set(110, 110, 1);
    this.scene.add(this.moon);
  }

  setupParticles() {
    // one pooled particle system for engine exhaust, boosters, pad steam
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pColor = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.pAlpha = new Float32Array(MAX_PARTICLES);
    // cpu-side state
    this.pVel = new Float32Array(MAX_PARTICLES * 3);
    this.pAge = new Float32Array(MAX_PARTICLES);
    this.pLife = new Float32Array(MAX_PARTICLES);
    this.pBaseSize = new Float32Array(MAX_PARTICLES);
    this.pType = new Uint8Array(MAX_PARTICLES); // 0 = flame, 1 = steam
    this.pAge.fill(999);
    this.pLife.fill(1);

    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pColor, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.pAlpha, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (120.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor, a * vAlpha);
        }
      `,
      vertexColors: true,
    });
    this.particles = new THREE.Points(geo, mat);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
    this.nextParticle = 0;
  }

  spawnParticle(origin, baseVel, spread, life, size, type = 0) {
    const i = this.nextParticle;
    this.nextParticle = (this.nextParticle + 1) % MAX_PARTICLES;
    this.pPos[i * 3] = origin.x + (Math.random() - 0.5) * 0.15;
    this.pPos[i * 3 + 1] = origin.y;
    this.pPos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.15;
    this.pVel[i * 3] = baseVel.x + (Math.random() - 0.5) * spread;
    this.pVel[i * 3 + 1] = baseVel.y + (Math.random() - 0.5) * spread;
    this.pVel[i * 3 + 2] = baseVel.z + (Math.random() - 0.5) * spread;
    this.pAge[i] = 0;
    this.pLife[i] = life * (0.7 + Math.random() * 0.6);
    this.pBaseSize[i] = size;
    this.pSize[i] = size;
    this.pType[i] = type;
  }

  updateParticles(dt) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pAge[i] >= this.pLife[i]) {
        this.pSize[i] = 0;
        continue;
      }
      this.pAge[i] += dt;
      const t = Math.min(this.pAge[i] / this.pLife[i], 1);
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      if (this.pType[i] === 1) {
        // pad steam: pale gray puffs that billow out and thin away
        const g = 0.42 * (1 - t * 0.5);
        this.pColor[i * 3] = g; this.pColor[i * 3 + 1] = g; this.pColor[i * 3 + 2] = g * 1.05;
        this.pSize[i] = this.pBaseSize[i] * (1 + t * 1.8);
        this.pAlpha[i] = 0.4 * (1 - t);
      } else {
        // flame: white-hot core to orange to a dim red tail
        if (t < 0.2) {
          this.pColor[i * 3] = 1.0; this.pColor[i * 3 + 1] = 0.95; this.pColor[i * 3 + 2] = 0.8;
        } else if (t < 0.6) {
          this.pColor[i * 3] = 1.0; this.pColor[i * 3 + 1] = 0.45; this.pColor[i * 3 + 2] = 0.1;
        } else {
          const f = 1 - t;
          this.pColor[i * 3] = 0.6 * f; this.pColor[i * 3 + 1] = 0.22 * f; this.pColor[i * 3 + 2] = 0.1 * f;
        }
        this.pSize[i] = this.pBaseSize[i] * (1 - t * 0.55);
        this.pAlpha[i] = 1 - t * t;
      }
    }
    const g = this.particles.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
  }

  // ---- rocket assembly ----

  buildRocket(design) {
    this.clearRocket();

    let y = 0;
    // engine goes at the bottom
    if (design.engine) {
      const g = createPartMesh(design.engine);
      g.position.y = y;
      this.rocket.add(g);
      this.rocketParts.push(g);
      this.flameStyle = FLAME_STYLES[design.engine] || FLAME_STYLES['engine-basic'];
      this.emitters.push(new THREE.Vector3(0, g.userData.nozzleY ?? 0, 0));
      if (g.userData.cluster) {
        // heavy engine gets two extra emitters for its side bells
        this.emitters.push(new THREE.Vector3(0.24, 0.05, 0));
        this.emitters.push(new THREE.Vector3(-0.24, 0.05, 0));
      }
      y += g.userData.height;
    }
    const finY = y; // fins sit at the bottom of the first tank
    for (const t of design.tanks) {
      const g = createPartMesh(t);
      g.position.y = y;
      this.rocket.add(g);
      this.rocketParts.push(g);
      y += g.userData.height;
    }
    const topY = y;
    if (design.nose) {
      const g = createPartMesh(design.nose);
      g.position.y = y;
      this.rocket.add(g);
      this.rocketParts.push(g);
      y += g.userData.height;
    }
    if (design.fins) {
      const g = createPartMesh(design.fins);
      g.position.y = finY;
      this.rocket.add(g);
      this.rocketParts.push(g);
    }
    if (design.boosters) {
      const g = createPartMesh('booster-pair');
      g.position.y = finY;
      this.rocket.add(g);
      this.rocketParts.push(g);
      this.boosterGroup = g;
      // booster nozzle emitter positions
      this.boosterEmitters = [
        new THREE.Vector3(0.74, finY, 0),
        new THREE.Vector3(-0.74, finY, 0),
      ];
    }
    if (design.parachute) {
      const g = createPartMesh('parachute');
      g.position.y = topY - 0.2;
      this.rocket.add(g);
      this.rocketParts.push(g);
      this.chuteAnchorY = topY;
    }

    this.rocketHeight = y;
    this.rocket.position.set(0, this.padTop, 0);
    this.rocket.rotation.set(0, 0, 0);
    this.rocket.visible = this.rocketParts.length > 0;
    return y;
  }

  clearRocket() {
    for (const g of this.rocketParts) {
      this.rocket.remove(g);
      disposeGroup(g);
    }
    this.rocketParts = [];
    this.emitters = [];
    this.boosterGroup = null;
    this.boosterEmitters = null;
    for (const b of this.detachedBoosters) {
      this.scene.remove(b.mesh);
      disposeGroup(b.mesh);
    }
    this.detachedBoosters = [];
    if (this.chuteMesh) {
      this.rocket.remove(this.chuteMesh);
      disposeGroup(this.chuteMesh);
      this.chuteMesh = null;
    }
  }

  // ---- flight events ----

  separateBoosters() {
    if (!this.boosterGroup) return;
    // move each booster into world space and let it tumble away
    const boosters = [...this.boosterGroup.children];
    for (const b of boosters) {
      const worldPos = new THREE.Vector3();
      b.getWorldPosition(worldPos);
      const worldQuat = new THREE.Quaternion();
      b.getWorldQuaternion(worldQuat);
      this.boosterGroup.remove(b);
      this.scene.add(b);
      b.position.copy(worldPos);
      b.quaternion.copy(worldQuat);
      this.detachedBoosters.push({
        mesh: b,
        vel: new THREE.Vector3(b.userData.side * 3.5, 2, (Math.random() - 0.5) * 2),
        spin: (Math.random() - 0.5) * 3,
        age: 0,
      });
    }
    const idx = this.rocketParts.indexOf(this.boosterGroup);
    if (idx >= 0) this.rocketParts.splice(idx, 1);
    this.rocket.remove(this.boosterGroup);
    this.boosterGroup = null;
    this.boosterEmitters = null;
  }

  deployParachute() {
    if (this.chuteMesh) return;
    // half-sphere canopy plus shroud lines, scales up over time
    const g = new THREE.Group();
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(1.6, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xd6a13a, roughness: 0.85, side: THREE.DoubleSide,
      })
    );
    canopy.position.y = 2.2;
    g.add(canopy);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.8 });
    const linePts = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      linePts.push(new THREE.Vector3(0, 0, 0));
      linePts.push(new THREE.Vector3(Math.cos(a) * 1.4, 2.2, Math.sin(a) * 1.4));
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    g.add(new THREE.LineSegments(lineGeo, lineMat));
    g.position.y = this.chuteAnchorY ?? this.rocketHeight;
    g.scale.setScalar(0.01);
    this.rocket.add(g);
    this.chuteMesh = g;
    this.chuteScale = 0.01;
  }

  crashBurst() {
    const p = this.rocket.position;
    for (let i = 0; i < 120; i++) {
      this.spawnParticle(
        new THREE.Vector3(p.x, p.y + 0.3, p.z),
        new THREE.Vector3((Math.random() - 0.5) * 10, Math.random() * 8, (Math.random() - 0.5) * 10),
        3, 1.2, 4
      );
    }
    this.rocket.visible = false;
  }

  // ---- per-frame update ----

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode === 'build';
    if (mode === 'build' || mode === 'title') {
      // coming back from a flight the camera can be stranded way up in
      // the sky, so drop it back near the pad
      if (this.camera.position.length() > 30) {
        this.camera.position.set(6, Math.max(3, this.rocketHeight * 0.6), 9);
      }
      this.camTarget.set(0, Math.max(2, this.rocketHeight * 0.5), 0);
    }
    if (mode === 'build') {
      this.controls.target.set(0, Math.max(2, this.rocketHeight * 0.5), 0);
    }
    if (mode === 'title') this.titleAngle = 0;
  }

  update(dt, flight) {
    // sky and stars follow altitude
    const alt = flight ? flight.alt : 0;
    const space = THREE.MathUtils.clamp(alt / SPACE_ALT, 0, 1);
    this.skyUniforms.uSpace.value = space;
    this.starMat.opacity = THREE.MathUtils.smoothstep(space, 0.35, 0.9);
    this.hemi.intensity = 0.7 * (1 - space * 0.8);
    this.sun.intensity = 2.2 - space * 0.6;
    this.scene.fog.color.copy(this.fogDay).lerp(this.fogSpace, space);

    // clouds drift sideways and thin out once the air is basically gone
    for (const cl of this.clouds) {
      cl.position.x += cl.userData.drift * dt;
      if (cl.position.x > 110) cl.position.x = -110;
      cl.material.opacity = cl.userData.baseOpacity * (1 - space);
    }

    if (this.mode === 'title') {
      this.titleAngle += dt * 0.12;
      const r = 9;
      const goal = new THREE.Vector3(
        Math.cos(this.titleAngle) * r,
        3 + Math.sin(this.titleAngle * 0.4) * 0.8,
        Math.sin(this.titleAngle) * r
      );
      this.camera.position.lerp(goal, 0.03);
      this.camera.lookAt(0, 2.2, 0);
    } else if (this.mode === 'build') {
      this.controls.update();
    } else if (this.mode === 'launch' && flight) {
      this.updateFlightVisuals(dt, flight);
    }

    this.updateParticles(dt);
    this.updateDetachedBoosters(dt);

    // keep sky dome, stars, and moon anchored to the camera so they
    // read as infinitely far away
    this.skyDome.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
    this.moon.position.set(
      this.camera.position.x - 620,
      this.camera.position.y + 780,
      this.camera.position.z - 980
    );
    this.moonMat.opacity = 0.35 + space * 0.6;

    this.renderer.render(this.scene, this.camera);
  }

  updateFlightVisuals(dt, flight) {
    // rocket vertical position; the world scale is 1 unit = 4 meters
    const y = this.padTop + flight.alt / 4;
    this.rocket.position.y = y;

    // lean and tumble come from the physics tilt angle, eased a little
    // so chute deploys and shakes do not snap the model around
    const dir = flight.tiltDir;
    const k = Math.min(1, 8 * dt);
    this.rocket.rotation.z += (Math.cos(dir) * flight.tilt - this.rocket.rotation.z) * k;
    this.rocket.rotation.x += (Math.sin(dir) * flight.tilt - this.rocket.rotation.x) * k;

    // engine exhaust while burning, flavored per engine tier
    const frac = flight.thrustFrac();
    const st = this.flameStyle || FLAME_STYLES['engine-basic'];
    if (frac > 0 && flight.fuel > 0) {
      for (const e of this.emitters) {
        const world = e.clone();
        this.rocket.localToWorld(world);
        for (let i = 0; i < st.perFrame; i++) {
          this.spawnParticle(
            world,
            new THREE.Vector3(0, -st.speed - Math.random() * 4, 0),
            st.spread, st.life, st.size
          );
        }
      }
    }
    // steam and dust billowing off the pad for the first moments
    if (frac > 0 && flight.alt < 20) {
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2;
        const dx = Math.cos(a), dz = Math.sin(a);
        this.spawnParticle(
          new THREE.Vector3(dx * 0.9, this.padTop + 0.1, dz * 0.9),
          new THREE.Vector3(dx * (2.5 + Math.random() * 3), 0.4 + Math.random(), dz * (2.5 + Math.random() * 3)),
          0.8, 1.6, 3.5, 1
        );
      }
    }
    // booster exhaust
    if (this.boosterEmitters && flight.boostersAttached && flight.boosterFuel > 0) {
      for (const e of this.boosterEmitters) {
        const world = e.clone();
        this.rocket.localToWorld(world);
        for (let i = 0; i < 2; i++) {
          this.spawnParticle(world, new THREE.Vector3(0, -8, 0), 1.8, 0.4, 2.2);
        }
      }
    }

    // parachute unfurl
    if (this.chuteMesh && this.chuteScale < 1) {
      this.chuteScale = Math.min(1, this.chuteScale + dt * 1.8);
      // slight overshoot then settle reads like cloth snapping open
      const s = this.chuteScale < 0.85
        ? this.chuteScale * 1.25
        : 1 + (1 - this.chuteScale) * 0.4;
      this.chuteMesh.scale.setScalar(s);
    }

    // chase camera: sits behind and slightly above, pulls back with
    // speed and climbs higher as altitude grows so the ground visibly
    // falls away below the rocket
    const back = 8 + Math.min(Math.abs(flight.vel) * 0.03, 6);
    const rise = 2.5 + Math.min(flight.alt * 0.012, 10);
    const goal = new THREE.Vector3(back * 0.8, y + rise, back);
    this.camera.position.lerp(goal, 1 - Math.pow(0.001, dt));
    this.camTarget.lerp(new THREE.Vector3(0, y + this.rocketHeight * 0.4, 0), 1 - Math.pow(0.0005, dt));
    this.camera.lookAt(this.camTarget);
  }

  updateDetachedBoosters(dt) {
    for (let i = this.detachedBoosters.length - 1; i >= 0; i--) {
      const b = this.detachedBoosters[i];
      b.age += dt;
      b.vel.y -= 6 * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.z += b.spin * dt;
      b.mesh.rotation.x += b.spin * 0.6 * dt;
      if (b.age > 6) {
        this.scene.remove(b.mesh);
        disposeGroup(b.mesh);
        this.detachedBoosters.splice(i, 1);
      }
    }
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
