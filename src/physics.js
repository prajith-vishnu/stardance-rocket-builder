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

// design = { nose, tanks: [], engine, fins, boosters, parachute }
export function computeStats(design) {
  let dryMass = 0, fuel = 0, thrust = 0, burn = 0, stability = 0, drag = 8;

  if (design.nose) {
    dryMass += PARTS[design.nose].mass;
    drag = PARTS[design.nose].drag;
  } else {
    drag = 14; // flat top is terrible aerodynamically
  }
  for (const t of design.tanks) {
    dryMass += PARTS[t].mass;
    fuel += PARTS[t].fuel;
  }
  if (design.engine) {
    dryMass += PARTS[design.engine].mass;
    thrust += PARTS[design.engine].thrust;
    burn += PARTS[design.engine].burn;
  }
  if (design.fins) {
    dryMass += PARTS[design.fins].mass;
    stability += PARTS[design.fins].stability;
  }
  if (design.boosters) {
    dryMass += PARTS['booster-pair'].mass;
  }
  if (design.parachute) {
    dryMass += PARTS['parachute'].mass;
  }

  const mass = dryMass + fuel * FUEL_MASS;
  // taller stacks need more fin authority
  const neededStability = 1 + design.tanks.length;
  const stabilityRating = stability - neededStability; // >= 0 is stable

  // TWR at liftoff, counting boosters
  let liftThrust = thrust;
  if (design.boosters) liftThrust += PARTS['booster-pair'].thrust;
  const twr = mass > 0 ? liftThrust / (mass * GRAVITY) : 0;
  const burnTime = burn > 0 ? fuel / burn : 0;

  return {
    mass: Math.round(mass),
    dryMass,
    fuel,
    thrust: liftThrust,
    burn,
    twr,
    burnTime,
    stability,
    neededStability,
    stabilityRating,
    drag,
  };
}

export function validateDesign(design) {
  if (!design.engine) return 'No engine attached.';
  if (design.tanks.length === 0) return 'No fuel tanks attached.';
  const s = computeStats(design);
  if (s.twr <= 1.0) return 'Thrust-to-weight is below 1. It will not lift off.';
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
    this.fuel = this.stats.fuel;
    this.fuelStart = this.stats.fuel;

    this.boosterFuel = design.boosters ? PARTS['booster-pair'].fuel : 0;
    this.boostersAttached = !!design.boosters;

    // tilt is a lean angle in radians plus a spin direction
    this.tilt = 0;
    this.tiltDir = Math.random() * Math.PI * 2;
    this.tumbling = false;
    this.everTumbled = false;

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

  // player can shut the main engine down early with the spacebar,
  // which saves fuel for the efficiency mission
  cutEngine() {
    if (this.done || this.held || this.engineCut || this.fuel <= 0 || !this.design.engine) return false;
    this.engineCut = true;
    this.graphMarks.push({ t: this.time, alt: this.alt, type: 'cutoff' });
    return true;
  }

  // 0..1, used for engine audio and particle intensity
  thrustFrac() {
    if (this.held) return 0;
    const max = this.stats.thrust || 1;
    return this.tumbling ? 0 : this.currentThrust() / max;
  }

  currentThrust() {
    let t = 0;
    if (this.fuel > 0 && this.design.engine && !this.engineCut) t += PARTS[this.design.engine].thrust;
    if (this.boostersAttached && this.boosterFuel > 0) t += PARTS['booster-pair'].thrust;
    return t;
  }

  currentMass() {
    let m = this.stats.dryMass + this.fuel * FUEL_MASS;
    // booster casings drop off at separation
    if (this.design.boosters && !this.boostersAttached) m -= PARTS['booster-pair'].mass;
    return Math.max(m, 1);
  }

  step(dt) {
    if (this.done || this.held) return;
    this.time += dt;
    this.events.length = 0;

    // burn fuel
    if (this.fuel > 0 && this.design.engine && !this.engineCut) {
      this.fuel = Math.max(0, this.fuel - PARTS[this.design.engine].burn * dt);
      if (this.fuel === 0) {
        this.events.push('burnout');
        this.graphMarks.push({ t: this.time, alt: this.alt, type: 'burnout' });
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
    const fuelUsed = Math.max(1, Math.round(this.fuelStart - this.fuel + (this.design.boosters ? PARTS['booster-pair'].fuel - this.boosterFuel : 0)));
    const maxAlt = Math.round(this.maxAlt);
    return {
      maxAlt, fuelUsed, landingSpeed: Math.round(landingSpeed), safe,
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
];

export { SPACE_ALT, SAFE_SPEED };
