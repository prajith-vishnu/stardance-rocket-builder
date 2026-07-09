import { PARTS } from './parts.js';

// Arcade physics, not textbook physics. Everything is tuned by feel.
const GRAVITY = 9.8;
const FUEL_MASS = 0.05;      // each fuel unit weighs a little
const DRAG_SCALE = 0.00012;  // base drag coefficient scale
const SPACE_ALT = 800;       // where "space" starts for the sky fade
const CHUTE_DEPLOY_ALT = 220;
const SAFE_SPEED = 12;

export const MISSIONS = {
  altitude: {
    name: 'Max Altitude',
    desc: 'score = height reached',
  },
  landing: {
    name: 'Safe Landing',
    desc: 'touch down under ' + SAFE_SPEED + ' m/s',
  },
  efficiency: {
    name: 'Efficiency',
    desc: 'most altitude per fuel unit',
  },
};

// design = { stack: [], nose, fins, boosters, parachute }
// the stack is an ordered bottom-up list of engines, tanks, and at
// most one decoupler. stage 0 is the bottom stage and burns first
export function parseStages(design) {
  const segs = [[]];
  for (const id of design.stack) {
    if (id === 'decoupler') segs.push([]);
    else segs[segs.length - 1].push(id);
  }
  return segs.map((ids) => {
    const s = { engine: null, tanks: 0, dry: 0, fuel: 0, thrust: 0, burn: 0 };
    for (const id of ids) {
      const p = PARTS[id];
      s.dry += p.mass;
      if (id.startsWith('engine')) { s.engine = id; s.thrust = p.thrust; s.burn = p.burn; }
      if (id.startsWith('tank')) { s.tanks += 1; s.fuel += p.fuel; }
    }
    return s;
  });
}

export function computeStats(design) {
  const stages = parseStages(design);
  let dryMass = 0, fuel = 0, burnTime = 0, tanks = 0;
  for (const s of stages) {
    dryMass += s.dry;
    fuel += s.fuel;
    tanks += s.tanks;
    if (s.burn > 0) burnTime += s.fuel / s.burn;
  }
  if (design.stack.includes('decoupler')) dryMass += PARTS['decoupler'].mass;

  let drag = 8;
  let stability = 0;
  if (design.nose) {
    dryMass += PARTS[design.nose].mass;
    drag = PARTS[design.nose].drag;
  } else {
    drag = 14; // flat top is terrible aerodynamically
  }
  if (design.fins) {
    dryMass += PARTS[design.fins].mass;
    stability += PARTS[design.fins].stability;
  }
  if (design.boosters) dryMass += PARTS['booster-pair'].mass;
  if (design.parachute) dryMass += PARTS['parachute'].mass;

  const mass = dryMass + fuel * FUEL_MASS;
  // taller stacks need more fin authority; a second stage adds height
  const neededStability = 1 + tanks + (stages.length > 1 ? 1 : 0);
  const stabilityRating = stability - neededStability; // >= 0 is stable

  // TWR at liftoff: stage one plus boosters
  let liftThrust = stages[0].thrust;
  if (design.boosters) liftThrust += PARTS['booster-pair'].thrust;
  const twr = mass > 0 ? liftThrust / (mass * GRAVITY) : 0;

  return {
    mass: Math.round(mass),
    dryMass,
    fuel,
    thrust: liftThrust,
    twr,
    burnTime,
    stability,
    neededStability,
    stabilityRating,
    drag,
    stages,
    stageCount: stages.length,
  };
}

export function validateDesign(design) {
  const stages = parseStages(design);
  if (stages.length > 2) return 'Only two stages are supported.';
  for (let i = 0; i < stages.length; i++) {
    const label = stages.length > 1 ? 'Stage ' + (i + 1) : 'The rocket';
    if (!stages[i].engine) return label + ' needs an engine.';
    if (stages[i].tanks === 0) return label + ' needs a fuel tank.';
  }
  // engines have to sit at the bottom of their stage, one per stage
  const segs = [[]];
  for (const id of design.stack) {
    if (id === 'decoupler') segs.push([]);
    else segs[segs.length - 1].push(id);
  }
  for (const seg of segs) {
    if (seg.filter((id) => id.startsWith('engine')).length > 1) return 'One engine per stage.';
    if (seg.length && !seg[0].startsWith('engine')) return 'Engines go at the bottom of a stage.';
  }
  const s = computeStats(design);
  if (s.twr <= 1.0) return 'Too heavy to lift off. Remove a tank or fit a stronger engine.';
  return null;
}

// rolled fresh every time the player goes to the pad
export function rollWind() {
  return Math.round(1 + Math.random() * 7);
}

export class Flight {
  constructor(design, wind = 0) {
    this.design = design;
    this.wind = wind;
    this.stats = computeStats(design);

    this.alt = 0;
    this.vel = 0;
    // fuel tracks the stage that is currently burning
    this.stages = this.stats.stages;
    this.stage = 0;
    this.stageTimer = 0;
    this.droppedMass = 0;
    this.fuel = this.stages[0].fuel;
    this.fuelStart = this.stages[0].fuel;
    this.fuelBurned = 0;

    this.boosterFuel = design.boosters ? PARTS['booster-pair'].fuel : 0;
    this.boostersAttached = !!design.boosters;

    // tilt is a lean angle in radians plus a spin direction
    this.tilt = 0;
    this.tiltDir = Math.random() * Math.PI * 2;
    this.tumbling = false;
    this.everTumbled = false;
    this.everRelit = false;

    this.chuteDeployed = false;
    this.engineCut = false;
    this.held = false; // true while the countdown is running
    this.maxAlt = 0;
    this.time = 0;
    this.done = false;
    this.events = []; // renderer/audio consume these each step
    this.result = null;

    // altitude samples + event markers for the results graph
    this.track = [[0, 0]];
    this.lastSample = 0;
    this.graphMarks = [];
  }

  // spacebar toggles the main engine: cut it early to save fuel, or
  // relight it on the way down and try to land on the plume
  toggleEngine() {
    if (this.done || this.held || this.fuel <= 0 || !this.stages[this.stage].engine) return false;
    if (this.stageTimer > 0) return false; // mid-staging, hands off
    if (!this.engineCut) {
      this.engineCut = true;
      this.graphMarks.push({ t: this.time, alt: this.alt, type: 'cutoff' });
      return 'cut';
    }
    this.engineCut = false;
    this.everRelit = true;
    this.graphMarks.push({ t: this.time, alt: this.alt, type: 'relight' });
    return 'relight';
  }

  // 0..1, used for engine audio and particle intensity
  thrustFrac() {
    if (this.held) return 0;
    const max = this.stats.thrust || 1;
    return this.tumbling ? 0 : this.currentThrust() / max;
  }

  currentThrust() {
    let t = 0;
    const st = this.stages[this.stage];
    if (this.fuel > 0 && st.thrust > 0 && !this.engineCut && this.stageTimer <= 0) t += st.thrust;
    if (this.boostersAttached && this.boosterFuel > 0) t += PARTS['booster-pair'].thrust;
    return t;
  }

  currentMass() {
    // fuel waiting in upper stages still counts until they fire
    let pending = 0;
    for (let i = this.stage + 1; i < this.stages.length; i++) pending += this.stages[i].fuel;
    let m = this.stats.dryMass - this.droppedMass + (this.fuel + pending) * FUEL_MASS;
    // booster casings drop off at separation
    if (this.design.boosters && !this.boostersAttached) m -= PARTS['booster-pair'].mass;
    return Math.max(m, 1);
  }

  step(dt) {
    if (this.done || this.held) return;
    this.time += dt;
    this.events.length = 0;

    // stage-two ignition happens a beat after separation
    if (this.stageTimer > 0) {
      this.stageTimer -= dt;
      if (this.stageTimer <= 0) this.events.push('stage2');
    }

    // burn fuel in the stage that is currently lit
    const st = this.stages[this.stage];
    if (this.fuel > 0 && st.burn > 0 && !this.engineCut && this.stageTimer <= 0) {
      const burn = Math.min(this.fuel, st.burn * dt);
      this.fuel -= burn;
      this.fuelBurned += burn;
      if (this.fuel <= 0) {
        this.fuel = 0;
        if (this.stage < this.stages.length - 1) {
          // drop the empty stage and light the next one after a beat
          this.droppedMass += st.dry + PARTS['decoupler'].mass;
          if (this.boostersAttached) {
            this.boostersAttached = false;
            this.events.push('separation');
          }
          this.stage += 1;
          this.fuel = this.stages[this.stage].fuel;
          this.fuelStart = this.stages[this.stage].fuel;
          this.engineCut = false;
          this.stageTimer = 0.8;
          this.events.push('stage-sep');
          this.graphMarks.push({ t: this.time, alt: this.alt, type: 'sep' });
        } else {
          this.events.push('burnout');
          this.graphMarks.push({ t: this.time, alt: this.alt, type: 'burnout' });
        }
      }
    }
    if (this.boostersAttached && this.boosterFuel > 0) {
      this.boosterFuel = Math.max(0, this.boosterFuel - PARTS['booster-pair'].burn * dt);
      if (this.boosterFuel === 0) {
        this.boostersAttached = false;
        this.events.push('separation');
        this.graphMarks.push({ t: this.time, alt: this.alt, type: 'sep' });
      }
    }

    const mass = this.currentMass();
    let thrust = this.currentThrust();

    // instability: not enough fin authority makes the rocket lean more
    // and more while under thrust, which bleeds vertical thrust away
    if (thrust > 0) {
      const lack = -this.stats.stabilityRating;
      if (lack > 0) {
        this.tilt += lack * 0.12 * dt * (1 + this.vel * 0.004);
      } else {
        this.tilt = Math.max(0, this.tilt - this.tilt * 1.5 * dt);
      }
      // wind leans the rocket over; fin authority fights it back
      const finGrip = Math.max(0.35, 1 - this.stats.stabilityRating * 0.2);
      this.tilt += this.wind * 0.02 * finGrip * dt;
      // small random shake either way, worse when unstable
      this.tilt += (Math.random() - 0.5) * 0.01;
      if (this.tilt < 0) this.tilt = 0;
    }
    if (this.tilt > 1.2 && !this.tumbling) {
      this.tumbling = true;
      this.everTumbled = true;
      this.events.push('tumble');
    }
    if (this.tumbling) {
      this.tilt += 2.5 * dt; // just keeps rotating, thrust is wasted
    }

    const effectiveThrust = this.tumbling ? 0 : thrust * Math.cos(this.tilt);

    // drag rises with speed squared, thins out with altitude
    const airDensity = Math.max(0, 1 - this.alt / SPACE_ALT * 0.8);
    let dragForce = DRAG_SCALE * this.stats.drag * this.vel * Math.abs(this.vel) * airDensity;

    // parachute auto-deploys on the way down, low enough
    if (
      this.design.parachute && !this.chuteDeployed &&
      this.vel < 0 && this.alt < CHUTE_DEPLOY_ALT && this.alt > 5
    ) {
      this.chuteDeployed = true;
      this.tumbling = false;
      this.tilt = 0;
      this.events.push('chute');
      this.graphMarks.push({ t: this.time, alt: this.alt, type: 'chute' });
    }
    const accel = (effectiveThrust - dragForce) / mass - GRAVITY;
    this.vel += accel * dt;

    // parachute descent: ease toward a slow terminal velocity instead of
    // a raw drag force, which stays stable even when opened at high speed
    if (this.chuteDeployed && this.vel < -8) {
      this.vel += (-8 - this.vel) * Math.min(1, 6 * dt);
    }

    this.alt += this.vel * dt;

    if (this.alt > this.maxAlt) this.maxAlt = this.alt;

    // sample altitude for the results graph
    if (this.time - this.lastSample >= 0.25 && this.track.length < 1200) {
      this.lastSample = this.time;
      this.track.push([this.time, Math.max(0, this.alt)]);
    }

    // touchdown
    if (this.alt <= 0 && this.time > 0.5) {
      this.alt = 0;
      this.track.push([this.time, 0]);
      const speed = Math.abs(this.vel);
      const safe = speed <= SAFE_SPEED;
      this.events.push(safe ? 'landed' : 'crashed');
      this.done = true;
      this.result = this.buildResult(speed, safe);
    }
  }

  buildResult(landingSpeed, safe) {
    const fuelUsed = Math.max(1, Math.round(this.fuelBurned + (this.design.boosters ? PARTS['booster-pair'].fuel - this.boosterFuel : 0)));
    const maxAlt = Math.round(this.maxAlt);
    return {
      maxAlt, fuelUsed, landingSpeed: Math.round(landingSpeed), safe,
      chuteUsed: this.chuteDeployed, relit: this.everRelit,
      track: this.track, marks: this.graphMarks,
    };
  }
}

export function scoreFlight(mission, result) {
  let score = 0;
  // cutting the engine on the pad should not count as a safe landing
  const actuallyFlew = result.maxAlt >= 50;
  if (mission === 'altitude') {
    score = Math.round(result.maxAlt / 2);
  } else if (mission === 'landing') {
    score = Math.round(result.maxAlt / 10);
    if (result.safe && actuallyFlew) score += 500;
  } else if (mission === 'efficiency') {
    score = Math.round((result.maxAlt / result.fuelUsed) * 40);
  }
  if (result.safe && actuallyFlew) score += 50; // small bonus on any mission
  // landing on the engine with no chute is the hardest trick in the game
  if (result.safe && actuallyFlew && result.relit && !result.chuteUsed) score += 250;
  return Math.max(0, score);
}

// one-time badges, checked against the flight after every landing
export const ACHIEVEMENTS = [
  {
    id: 'first-flight', name: 'Off the Ground',
    desc: 'complete a flight past 10 m',
    test: (r) => r.maxAlt >= 10,
  },
  {
    id: 'above-the-air', name: 'Where the Sky Ends',
    desc: 'climb above ' + SPACE_ALT + ' m',
    test: (r) => r.maxAlt >= SPACE_ALT,
  },
  {
    id: 'soft-touch', name: 'Soft Touch',
    desc: 'touch down under 5 m/s',
    test: (r) => r.safe && r.landingSpeed <= 5,
  },
  {
    id: 'no-fins', name: 'Who Needs Fins',
    desc: 'reach 300 m with no fins fitted',
    test: (r, f) => !f.design.fins && r.maxAlt >= 300,
  },
  {
    id: 'lawn-dart', name: 'Lawn Dart',
    desc: 'hit the desert faster than 150 m/s',
    test: (r) => !r.safe && r.landingSpeed >= 150,
  },
  {
    id: 'heavy-metal', name: 'Heavy Metal',
    desc: 'get a rocket over 300 kg past 100 m',
    test: (r, f) => f.stats.mass >= 300 && r.maxAlt >= 100,
  },
  {
    id: 'fumes', name: 'Running on Fumes',
    desc: 'land safely with under 5 percent fuel left',
    test: (r, f) => r.safe && f.fuelStart > 0 && f.fuel <= f.fuelStart * 0.05,
  },
  {
    id: 'tumbler', name: 'Regained Composure',
    desc: 'lose control mid-flight and still land safely',
    test: (r, f) => f.everTumbled && r.safe,
  },
  {
    id: 'hoverslam', name: 'Hoverslam',
    desc: 'relight the engine and land with no parachute',
    test: (r) => r.safe && r.relit && !r.chuteUsed && r.maxAlt >= 50,
  },
  {
    id: 'proper-rocket', name: 'Proper Rocket',
    desc: 'fly a two-stage rocket past 800 m',
    test: (r, f) => f.stages.length > 1 && r.maxAlt >= 800,
  },
];

export { SPACE_ALT, SAFE_SPEED };
