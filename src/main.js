import { Renderer } from './render.js';
import { PARTS } from './parts.js';
import { Flight, scoreFlight, validateDesign, rollWind, ACHIEVEMENTS } from './physics.js';
import { audio } from './audio.js';
import * as ui from './ui.js';

const renderer = new Renderer(document.getElementById('scene'));

let save = ui.loadSave();
let mission = 'altitude';
let state = 'title'; // title | build | launch | results | unlocks
let flight = null;
let unlocksReturnTo = 'title';
let wind = rollWind();
// per-flight altitude callouts
const MILESTONES = [100, 250, 500, 1000, 1500, 2000, 3000, 5000];
let hitMilestones = new Set();
let beatBest = false;
// t-minus clock, > 0 while a countdown is running
let countdown = 0;
let countdownTick = 0;

// current rocket design, seeded with the free starter parts so the
// first visit to the pad is not an empty scene
const design = {
  nose: 'nose-standard',
  tanks: ['tank-small'],
  engine: 'engine-basic',
  fins: 'fins-basic',
  boosters: false,
  parachute: false,
};

// a decent-looking default so the title screen has something on the pad
const titleDesign = {
  nose: 'nose-standard',
  tanks: ['tank-small', 'tank-small'],
  engine: 'engine-basic',
  fins: 'fins-basic',
  boosters: false,
  parachute: false,
};

// ---- design edits ----

function addPart(id) {
  if (id.startsWith('nose')) {
    design.nose = design.nose === id ? null : id; // click again to remove
  } else if (id.startsWith('tank')) {
    if (design.tanks.length >= 4) return; // keep stacks sane
    design.tanks.push(id);
  } else if (id.startsWith('engine')) {
    design.engine = design.engine === id ? null : id;
  } else if (id.startsWith('fins')) {
    design.fins = design.fins === id ? null : id;
  } else if (id === 'booster-pair') {
    design.boosters = !design.boosters;
  } else if (id === 'parachute') {
    design.parachute = !design.parachute;
  }
  refreshBuild();
}

function removePart(key) {
  if (key === 'nose') design.nose = null;
  else if (key === 'engine') design.engine = null;
  else if (key === 'fins') design.fins = null;
  else if (key === 'boosters') design.boosters = false;
  else if (key === 'parachute') design.parachute = false;
  else if (key.startsWith('tank:')) {
    // removing a middle tank just closes the gap
    design.tanks.splice(Number(key.split(':')[1]), 1);
  }
  refreshBuild();
}

function clearDesign() {
  design.nose = null;
  design.tanks = [];
  design.engine = null;
  design.fins = null;
  design.boosters = false;
  design.parachute = false;
  refreshBuild();
}

function refreshBuild() {
  renderer.buildRocket(design);
  ui.renderPalette(save, design, addPart);
  ui.renderStack(design, removePart);
  ui.renderStats(design, wind);
  ui.renderMissionPicker(mission, (m) => {
    mission = m;
    refreshBuild();
  });
}

// ---- state transitions ----

function goTitle() {
  state = 'title';
  flight = null;
  renderer.buildRocket(titleDesign);
  renderer.setMode('title');
  ui.updateTitleBest(save);
  ui.showScreen('title-screen');
}

function goBuild() {
  state = 'build';
  flight = null;
  audio.stopEngine();
  // fresh weather every time you come back to the pad
  wind = rollWind();
  refreshBuild();
  renderer.setMode('build');
  ui.showScreen('build-ui');
}

function goLaunch() {
  if (state === 'launch' || validateDesign(design)) return;
  // drop focus so spacebar goes to engine cutoff, not the button
  document.activeElement?.blur?.();
  state = 'launch';
  flight = new Flight(design, wind);
  flight.held = true; // countdown owns the clock until t-zero
  countdown = 5.999;
  countdownTick = 6;
  hitMilestones = new Set();
  beatBest = false;
  renderer.buildRocket(design);
  renderer.setMode('launch');
  ui.showScreen('launch-ui');
  ui.setBestReadout(save.bestAlt);
}

function goResults() {
  state = 'results';
  audio.stopEngine();

  const result = flight.result;
  const score = scoreFlight(mission, result);
  const isBest = score > save.best[mission];
  if (isBest) save.best[mission] = score;
  if (result.maxAlt > save.bestAlt) save.bestAlt = result.maxAlt;
  save.points += score;

  // hand out any achievements this flight earned
  const newAchievements = [];
  for (const a of ACHIEVEMENTS) {
    if (!save.achievements.includes(a.id) && a.test(result, flight)) {
      save.achievements.push(a.id);
      newAchievements.push(a);
    }
  }
  ui.storeSave(save);

  ui.renderResults(mission, result, score, score, save, isBest, newAchievements);
  ui.showScreen('results-screen');
}

function goUnlocks(returnTo) {
  unlocksReturnTo = returnTo;
  state = 'unlocks';
  ui.renderUnlocks(save, buyPart);
  ui.showScreen('unlocks-screen');
}

function buyPart(id) {
  if (save.unlocked.includes(id)) return;
  if (save.points < PARTS[id].cost) return;
  save.points -= PARTS[id].cost;
  save.unlocked.push(id);
  ui.storeSave(save);
  ui.renderUnlocks(save, buyPart);
}

// ---- flight loop hooks ----

function handleFlightEvents() {
  for (const ev of flight.events) {
    if (ev === 'burnout') ui.flashEvent('Main engine burnout');
    else if (ev === 'separation') {
      ui.flashEvent('Booster separation');
      renderer.separateBoosters();
      audio.separation();
    } else if (ev === 'chute') {
      ui.flashEvent('Parachute deployed');
      renderer.deployParachute();
      audio.chute();
    } else if (ev === 'tumble') {
      ui.flashEvent('Losing control');
    } else if (ev === 'crashed') {
      renderer.crashBurst();
      audio.crash();
    } else if (ev === 'landed') {
      audio.land();
    }
  }
}

// ---- buttons ----

document.getElementById('btn-start').addEventListener('click', () => { audio.click(); goBuild(); });
document.getElementById('btn-unlocks').addEventListener('click', () => { audio.click(); goUnlocks('title'); });
document.getElementById('btn-unlocks-back').addEventListener('click', () => {
  audio.click();
  if (unlocksReturnTo === 'build') goBuild(); else goTitle();
});
document.getElementById('btn-launch').addEventListener('click', () => { audio.click(); goLaunch(); });
document.getElementById('btn-clear').addEventListener('click', () => { audio.click(); clearDesign(); });
document.getElementById('btn-title').addEventListener('click', () => { audio.click(); goTitle(); });
document.getElementById('btn-again').addEventListener('click', () => { audio.click(); goBuild(); });

// spacebar shuts the main engine down mid-flight
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  if (state !== 'launch' || !flight || flight.done) return;
  e.preventDefault();
  if (flight.cutEngine()) {
    audio.cutoff();
    ui.flashEvent('Engine cutoff');
  }
});

const muteBtn = document.getElementById('btn-mute');
function refreshMuteLabel() {
  muteBtn.textContent = audio.muted ? 'Sound: Off' : 'Sound: On';
}
muteBtn.addEventListener('click', () => {
  audio.toggleMute();
  refreshMuteLabel();
  audio.click();
});
refreshMuteLabel();

// ---- main loop ----

let last = performance.now();
let resultsDelay = 0;

function frame(now) {
  requestAnimationFrame(frame);
  // clamp dt so a background tab does not fast-forward the physics
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (state === 'launch' && flight) {
    // run the t-minus sequence before releasing the rocket
    if (flight.held) {
      countdown -= dt;
      const tick = Math.ceil(countdown);
      if (tick < countdownTick && tick > 0) {
        countdownTick = tick;
        ui.flashEvent('T-' + tick);
        audio.ping();
        if (tick === 3) renderer.armsRetracting = true;
        if (tick === 2) renderer.preSteam = true;
      }
      if (countdown <= 0) {
        flight.held = false;
        renderer.preSteam = false;
        audio.ignition();
        audio.startEngine();
        ui.flashEvent('Liftoff');
      }
    }
    if (!flight.done) {
      // parachute drift is slow to watch, so time runs double until
      // the rocket is close to the ground
      const steps = flight.chuteDeployed && flight.alt > 40 ? 2 : 1;
      for (let s = 0; s < steps && !flight.done; s++) {
        flight.step(dt);
        handleFlightEvents();
      }
      ui.updateFlightReadout(flight);
      // altitude callouts on the way up
      for (const m of MILESTONES) {
        if (flight.alt >= m && !hitMilestones.has(m)) {
          hitMilestones.add(m);
          ui.flashEvent(m + ' m');
          audio.ping();
        }
      }
      if (!beatBest && save.bestAlt > 50 && flight.alt > save.bestAlt) {
        beatBest = true;
        ui.flashEvent('New best altitude');
        audio.ping();
      }
      audio.setEngineLevel(flight.fuel > 0 || (flight.boostersAttached && flight.boosterFuel > 0) ? flight.thrustFrac() : 0);
      if (flight.done) {
        audio.stopEngine();
        resultsDelay = 1.8; // linger on the outcome for a moment
      }
    } else {
      resultsDelay -= dt;
      if (resultsDelay <= 0) goResults();
    }
  }

  // keep passing the finished flight during the results screen so the
  // sky, camera, and particles do not snap back to daytime behind it
  renderer.update(dt, flight);
}

goTitle();
requestAnimationFrame(frame);
window.__gameBooted = true;
