import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createPartMesh, disposeGroup } from './parts.js';
import { SPACE_ALT } from './physics.js';

const MAX_PARTICLES = 1400;

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
    vec3 dir = normalize(vPos);
    float h = dir.y * 0.5 + 0.5;
    vec3 horizon = vec3(0.75, 0.82, 0.90);
    vec3 zenith = vec3(0.20, 0.42, 0.75);
    vec3 day = mix(horizon, zenith, pow(h, 0.6));
    vec3 space = vec3(0.005, 0.006, 0.012);
    vec3 col = mix(day, space, uSpace);
    // the sun, matched to the direction of the shadow light
    vec3 sunDir = normalize(vec3(0.47, 0.79, 0.31));
    float s = max(dot(dir, sunDir), 0.0);
    col += vec3(1.0, 0.95, 0.8) * (pow(s, 1500.0) * 4.0 + pow(s, 30.0) * 0.12) * (1.0 - uSpace * 0.3);
    gl_FragColor = vec4(col, 1.0);
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
    this.setupEnvironment();
    this.setupGround();
    this.setupScenery();
    this.setupClouds();
    this.setupParticles();

    // the environment map is there for the rocket's metal. tone it way
    // down on the terrain and buildings or the desert washes out white.
    // rocket parts are built later, so they keep the full reflections
    this.scene.traverse((o) => {
      if (o.isMesh && o.material && 'envMapIntensity' in o.material) {
        o.material.envMapIntensity = 0.2;
      }
    });

    // mild bloom so the flame, sun glint, and hot engine bells glow
    // instead of just being bright pixels
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.7, 0.85
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

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
    // hemisphere fill so shadowed sides are not pure black. kept low
    // because the environment map adds its own fill light
    this.hemi = new THREE.HemisphereLight(0xbfd4ea, 0x4a4238, 0.5);
    this.scene.add(this.hemi);

    // sun with shadows
    this.sun = new THREE.DirectionalLight(0xfff2df, 2.0);
    this.sun.position.set(18, 30, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    // wide enough to catch the buildings around the pad too
    this.sun.shadow.camera.left = -45;
    this.sun.shadow.camera.right = 45;
    this.sun.shadow.camera.top = 45;
    this.sun.shadow.camera.bottom = -45;
    this.sun.shadow.camera.far = 150;
    // normalBias fixes the striping on curved tank walls
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.03;
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

  setupEnvironment() {
    // a tiny fake outdoor scene baked into an environment map, so the
    // metal parts have a sky and ground to reflect. without this
    // MeshStandardMaterial metals look like gray plastic
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vPos;
        void main() {
          vec3 d = normalize(vPos);
          vec3 ground = vec3(0.33, 0.28, 0.20);
          vec3 horizon = vec3(0.85, 0.83, 0.78);
          vec3 zenith = vec3(0.30, 0.48, 0.85);
          vec3 sky = mix(horizon, zenith, pow(max(d.y, 0.0), 0.7));
          vec3 col = d.y > 0.0 ? sky : mix(horizon, ground, min(1.0, -d.y * 3.0));
          vec3 sunDir = normalize(vec3(0.45, 0.7, 0.3));
          col += vec3(1.0, 0.95, 0.85) * pow(max(dot(d, sunDir), 0.0), 250.0) * 6.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat);
    envScene.add(ball);
    this.scene.environment = pmrem.fromScene(envScene, 0.03).texture;
    ball.geometry.dispose();
    mat.dispose();
    pmrem.dispose();
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

    // crawlerway: twin gravel tracks from the assembly building to
    // the pad (the building sits at canvas 947,916)
    g.strokeStyle = 'rgba(200,194,176,0.7)';
    g.lineWidth = 6;
    for (const off of [-5, 5]) {
      g.beginPath();
      g.moveTo(1026 + off, 1030);
      g.lineTo(940 + off, 902);
      g.stroke();
    }
    g.strokeStyle = 'rgba(120,112,95,0.5)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(1026, 1030);
    g.lineTo(940, 902);
    g.stroke();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
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

    this.buildLaunchComplex();
  }

  makeConcreteTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#96958f';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 600; i++) {
      g.fillStyle = 'rgba(' + (Math.random() < 0.5 ? '60,58,52' : '210,208,200') + ',' + (Math.random() * 0.06).toFixed(3) + ')';
      g.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
    }
    // expansion joints
    g.strokeStyle = 'rgba(50,48,44,0.5)';
    g.lineWidth = 2;
    for (let p = 0; p <= 256; p += 64) {
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(256, p); g.stroke();
    }
    // weathering stains
    for (let i = 0; i < 14; i++) {
      g.fillStyle = 'rgba(70,64,54,' + (0.04 + Math.random() * 0.07).toFixed(3) + ')';
      g.beginPath();
      g.ellipse(Math.random() * 256, Math.random() * 256, 12 + Math.random() * 40, 8 + Math.random() * 24, 0, 0, Math.PI * 2);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  buildLaunchComplex() {
    // raised concrete platform with a flame trench through the middle,
    // like the real shuttle pads. the rocket sits on a launch table
    // that bridges the trench
    const complex = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ map: this.makeConcreteTexture(), roughness: 0.95 });
    const darkConcrete = new THREE.MeshStandardMaterial({ color: 0x45413c, roughness: 1 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8c3b2e, metalness: 0.5, roughness: 0.6 });
    const gray = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, metalness: 0.6, roughness: 0.5 });

    // two platform halves leave a trench running along x
    for (const side of [-1, 1]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(26, 2.4, 7), concrete);
      slab.position.set(0, 1.2, side * 5.5);
      slab.castShadow = true;
      slab.receiveShadow = true;
      complex.add(slab);
    }
    // sloped ramp up the back side
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(10, 0.6, 18), concrete);
    ramp.rotation.z = 0.19;
    ramp.position.set(-17.5, 1.15, 0);
    ramp.receiveShadow = true;
    complex.add(ramp);

    // trench floor and the wedge flame deflector under the engine
    const trenchFloor = new THREE.Mesh(new THREE.BoxGeometry(26, 0.3, 4), darkConcrete);
    trenchFloor.position.y = 0.15;
    const deflector = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 3.9), darkConcrete);
    deflector.rotation.z = Math.PI / 4;
    deflector.position.set(0, 0.35, 0);
    complex.add(trenchFloor, deflector);

    // launch table bridging the trench, open in the middle for exhaust
    for (const side of [-1, 1]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(7, 1.1, 2.2), gray);
      beam.position.set(0, 2.95, side * 2.0);
      beam.castShadow = true;
      beam.receiveShadow = true;
      const beam2 = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 1.8), gray);
      beam2.position.set(side * 2.4, 2.95, 0);
      beam2.castShadow = true;
      complex.add(beam, beam2);
    }
    // hold-down clamps around the rocket base
    for (const [cx, cz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
      const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.8, 0.28), darkConcrete);
      clamp.position.set(cx, 3.85, cz);
      clamp.castShadow = true;
      complex.add(clamp);
    }

    // fixed service structure: lattice tower with platforms, a crane,
    // a lightning mast, and swing arms that pull back at ignition
    const fss = new THREE.Group();
    const TW = 2.4;
    const H = 14;
    for (const [px, pz] of [[-TW / 2, -TW / 2], [TW / 2, -TW / 2], [-TW / 2, TW / 2], [TW / 2, TW / 2]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.26, H, 0.26), steel);
      post.position.set(px, H / 2, pz);
      post.castShadow = true;
      fss.add(post);
    }
    for (let ly = 1.6; ly < H; ly += 1.75) {
      for (const side of [-1, 1]) {
        const bx = new THREE.Mesh(new THREE.BoxGeometry(TW, 0.12, 0.12), steel);
        bx.position.set(0, ly, side * TW / 2);
        const bz = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, TW), steel);
        bz.position.set(side * TW / 2, ly, 0);
        // diagonal brace
        const dg = new THREE.Mesh(new THREE.BoxGeometry(TW * 1.35, 0.09, 0.09), steel);
        dg.position.set(0, ly + 0.85, side * TW / 2);
        dg.rotation.z = side * 0.62;
        fss.add(bx, bz, dg);
      }
    }
    // work platforms
    for (const ly of [4.2, 8.4, 12.4]) {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(TW + 0.7, 0.12, TW + 0.7), gray);
      deck.position.y = ly;
      deck.castShadow = true;
      fss.add(deck);
    }
    // hammerhead crane and lightning mast on top
    const craneBase = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 0.3), steel);
    craneBase.position.y = H + 1.1;
    const craneArm = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.32, 0.5), steel);
    craneArm.position.set(1.4, H + 2.1, 0);
    craneArm.castShadow = true;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.1, 5.5, 8),
      new THREE.MeshStandardMaterial({ color: 0xe8e8e6, metalness: 0.4, roughness: 0.5 })
    );
    mast.position.y = H + 4.9;
    fss.add(craneBase, craneArm, mast);

    // swing arms, stored so the renderer can retract them at ignition.
    // sized so the plate just kisses the hull instead of clipping it
    this.swingArms = [];
    for (const ay of [2.7, 4.6]) {
      const pivot = new THREE.Group();
      pivot.position.set(TW / 2, ay, TW / 2);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.28, 0.62), steel);
      arm.position.x = 1.2;
      arm.castShadow = true;
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 0.7), gray);
      plate.position.x = 2.55;
      pivot.add(arm, plate);
      pivot.rotation.y = -Math.PI / 4; // docked against the rocket
      pivot.userData.docked = -Math.PI / 4;
      pivot.userData.retracted = -Math.PI / 4 + 1.9;
      this.swingArms.push(pivot);
      fss.add(pivot);
    }
    fss.position.set(-3.6, 2.4, -3.6);
    complex.add(fss);

    // four lightning masts around the platform corners
    for (const [mx, mz] of [[-16, -12], [16, -12], [-16, 12], [16, 12]]) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.16, 20, 8),
        new THREE.MeshStandardMaterial({ color: 0xdadad6, metalness: 0.4, roughness: 0.5 })
      );
      pole.position.set(mx, 10, mz);
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xb03030, emissive: 0xb03030, emissiveIntensity: 0.7 })
      );
      tip.position.set(mx, 20.1, mz);
      complex.add(pole, tip);
    }

    // warm flicker light on the pad while the engine burns
    this.padLight = new THREE.PointLight(0xffb060, 0, 45, 2);
    this.padLight.position.set(0, 2.6, 0);
    complex.add(this.padLight);

    // soft dark blob on the launch table so the rocket feels planted
    const sc = document.createElement('canvas');
    sc.width = 128; sc.height = 128;
    const sg = sc.getContext('2d');
    const blobGrad = sg.createRadialGradient(64, 64, 6, 64, 64, 62);
    blobGrad.addColorStop(0, 'rgba(0,0,0,0.4)');
    blobGrad.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = blobGrad;
    sg.fillRect(0, 0, 128, 128);
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(sc),
        transparent: true,
        depthWrite: false,
      })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 3.52;
    complex.add(blob);

    this.pad = complex;
    this.scene.add(complex);
    this.padTop = 3.5;
  }

  makeVabMaterials() {
    // big hangar wall with a giant door outline and a flag-ish mark
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#d2d4d6';
    g.fillRect(0, 0, 256, 256);
    // dark corner columns
    g.fillStyle = '#3c4a63';
    g.fillRect(0, 0, 16, 256);
    g.fillRect(240, 0, 16, 256);
    // giant vehicle door with vertical segments
    g.fillStyle = '#82868c';
    g.fillRect(84, 76, 88, 180);
    g.strokeStyle = 'rgba(50,52,58,0.6)';
    g.lineWidth = 2;
    for (let x = 84; x <= 172; x += 11) {
      g.beginPath(); g.moveTo(x, 76); g.lineTo(x, 256); g.stroke();
    }
    // abstract flag block
    g.fillStyle = '#b23a35';
    for (let i = 0; i < 4; i++) g.fillRect(28, 30 + i * 8, 40, 4);
    g.fillStyle = '#2b3f66';
    g.fillRect(28, 30, 14, 16);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const wall = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
    const plain = new THREE.MeshStandardMaterial({ color: 0xc9cccf, roughness: 0.85 });
    // box faces: +x, -x, +y, -y, +z, -z ; door on +z and +x
    return [wall, plain, plain, plain, wall, plain];
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

    // floodlight towers well outside the platform
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff7d0, emissive: 0xfff2b8, emissiveIntensity: 0.8,
    });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.35, 14, 0.35), darkSteel);
      pole.position.set(Math.cos(a) * 24, 7, Math.sin(a) * 24);
      pole.castShadow = true;
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.5), lampMat);
      head.position.set(Math.cos(a) * 24, 14.2, Math.sin(a) * 24);
      head.lookAt(0, 4, 0);
      scenery.add(pole, head);
    }

    // windsock
    const sockPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 6), darkSteel);
    sockPole.position.set(19, 2, 18);
    const sock = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 1.6, 8, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xd96a2a, roughness: 0.8, side: THREE.DoubleSide })
    );
    sock.rotation.z = Math.PI / 2;
    sock.position.set(19.9, 3.9, 18);
    scenery.add(sockPole, sock);

    // water deluge tower
    const wtLegMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d2, metalness: 0.4, roughness: 0.55 });
    for (const [lx, lz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 11, 0.3), wtLegMat);
      leg.position.set(26 + lx, 5.5, -28 + lz);
      leg.castShadow = true;
      scenery.add(leg);
    }
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(3.4, 20, 14), wtLegMat);
    bowl.position.set(26, 12.6, -28);
    bowl.castShadow = true;
    const standpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 11, 10), wtLegMat);
    standpipe.position.set(26, 5.5, -28);
    scenery.add(bowl, standpipe);

    // giant assembly building on the horizon, at the end of the
    // crawlerway painted into the ground texture
    const vabY = this.hillHeight(-150, -210);
    const vab = new THREE.Group();
    const vabBody = new THREE.Mesh(new THREE.BoxGeometry(55, 46, 50), this.makeVabMaterials());
    vabBody.position.y = 23;
    const vabRoof = new THREE.Mesh(
      new THREE.BoxGeometry(57, 1.4, 52),
      new THREE.MeshStandardMaterial({ color: 0x6f747a, roughness: 0.8 })
    );
    vabRoof.position.y = 46.5;
    const vabAnnex = new THREE.Mesh(
      new THREE.BoxGeometry(20, 16, 24),
      new THREE.MeshStandardMaterial({ color: 0xc4c7ca, roughness: 0.8 })
    );
    vabAnnex.position.set(37, 8, 6);
    vab.add(vabBody, vabRoof, vabAnnex);
    vab.position.set(-150, vabY - 1, -210);
    vab.rotation.y = 0.62; // door faces down the crawlerway toward the pad
    scenery.add(vab);

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

  // solid flame column that sits inside the particle plume, so the
  // exhaust has a bright core instead of being all fuzz
  makeFlameColumn(topR, bottomR, length) {
    const geo = new THREE.CylinderGeometry(topR, bottomR, length, 16, 6, true);
    geo.translate(0, -length / 2, 0); // hangs down from the nozzle
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uT: { value: 0 }, uI: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uT;
        uniform float uI;
        void main() {
          float a = pow(vUv.y, 1.7) * uI;
          a *= 0.75 + 0.25 * sin(uT * 47.0 + vUv.y * 22.0);
          vec3 col = mix(vec3(1.0, 0.5, 0.12), vec3(1.0, 0.97, 0.88), pow(vUv.y, 2.2));
          gl_FragColor = vec4(col * 1.6, a);
        }`,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    return m;
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

    // collect nozzle materials so the bells can glow while firing
    this.glowMats = [];
    this.rocket.traverse((o) => {
      if (o.isMesh && o.userData.isNozzle) this.glowMats.push(o.material);
    });

    // one flame core per nozzle
    this.flameCols = [];
    if (design.engine) {
      const cluster = this.emitters.length > 1;
      for (const e of this.emitters) {
        const col = cluster
          ? this.makeFlameColumn(0.1, 0.3, 3.6)
          : this.makeFlameColumn(0.16, 0.48, 5);
        col.position.copy(e);
        col.userData.kind = 'main';
        this.rocket.add(col);
        this.flameCols.push(col);
      }
    }
    if (this.boosterEmitters) {
      for (const e of this.boosterEmitters) {
        const col = this.makeFlameColumn(0.07, 0.22, 2.6);
        col.position.copy(e);
        col.position.y += 0.08;
        col.userData.kind = 'booster';
        this.rocket.add(col);
        this.flameCols.push(col);
      }
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
    for (const col of this.flameCols || []) {
      this.rocket.remove(col);
      col.geometry.dispose();
      col.material.dispose();
    }
    this.flameCols = [];
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
    const focusY = this.padTop + Math.max(1.5, this.rocketHeight * 0.5);
    if (mode === 'build' || mode === 'title') {
      // coming back from a flight the camera can be stranded way up in
      // the sky, so drop it back near the pad
      if (this.camera.position.length() > 40) {
        this.camera.position.set(7, this.padTop + Math.max(3, this.rocketHeight * 0.6), 11);
      }
      this.camTarget.set(0, focusY, 0);
      // dock the swing arms again for the next launch
      for (const arm of this.swingArms || []) arm.rotation.y = arm.userData.docked;
    }
    if (mode === 'build') {
      this.controls.target.set(0, focusY, 0);
    }
    if (mode === 'title') this.titleAngle = 0;
  }

  update(dt, flight) {
    // sky and stars follow altitude
    const alt = flight ? flight.alt : 0;
    const space = THREE.MathUtils.clamp(alt / SPACE_ALT, 0, 1);
    this.skyUniforms.uSpace.value = space;
    this.starMat.opacity = THREE.MathUtils.smoothstep(space, 0.35, 0.9);
    this.hemi.intensity = 0.5 * (1 - space * 0.8);
    this.sun.intensity = 2.0 - space * 0.5;
    this.scene.fog.color.copy(this.fogDay).lerp(this.fogSpace, space);

    // clouds drift sideways and thin out once the air is basically gone
    for (const cl of this.clouds) {
      cl.position.x += cl.userData.drift * dt;
      if (cl.position.x > 110) cl.position.x = -110;
      cl.material.opacity = cl.userData.baseOpacity * (1 - space);
    }

    if (this.mode === 'title') {
      this.titleAngle += dt * 0.12;
      const r = 16;
      const goal = new THREE.Vector3(
        Math.cos(this.titleAngle) * r,
        this.padTop + 3.2 + Math.sin(this.titleAngle * 0.4) * 0.8,
        Math.sin(this.titleAngle) * r
      );
      this.camera.position.lerp(goal, 0.03);
      this.camera.lookAt(0, this.padTop + 2.2, 0);
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

    this.composer.render();
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
    // the bells heat up and glow while there is thrust
    for (const m of this.glowMats || []) m.emissiveIntensity = frac * 1.5;

    // flame cores flicker under each burning nozzle
    this.flameTime = (this.flameTime || 0) + dt;
    const mainOn = !flight.done && flight.fuel > 0 && !flight.engineCut && !flight.tumbling ? 1 : 0;
    const boostOn = !flight.done && flight.boostersAttached && flight.boosterFuel > 0 && !flight.tumbling ? 1 : 0;
    for (const col of this.flameCols || []) {
      const on = col.userData.kind === 'booster' ? boostOn : mainOn;
      col.visible = on > 0;
      col.material.uniforms.uT.value = this.flameTime;
      col.material.uniforms.uI.value = on * (0.8 + Math.random() * 0.25);
      col.scale.y = on ? 0.85 + Math.random() * 0.3 : 1;
    }

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
    // swing arms pull back once the engine lights
    for (const arm of this.swingArms || []) {
      arm.rotation.y += (arm.userData.retracted - arm.rotation.y) * Math.min(1, 1.6 * dt);
    }

    // the plume hits the deflector and pours out both ends of the
    // trench as steam during the first moments of flight
    if (frac > 0 && flight.alt < 25) {
      for (let i = 0; i < 5; i++) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        this.spawnParticle(
          new THREE.Vector3(dir * (2.5 + Math.random() * 9), 1.6, (Math.random() - 0.5) * 2.4),
          new THREE.Vector3(dir * (6 + Math.random() * 5), 0.5 + Math.random() * 1.6, (Math.random() - 0.5) * 2.5),
          1.0, 2.4, 4.5, 1
        );
      }
    }
    // warm flicker on the pad structures while the plume is close
    this.padLight.intensity =
      frac * 28 * THREE.MathUtils.clamp(1 - flight.alt / 50, 0, 1) * (0.85 + Math.random() * 0.3);
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
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
