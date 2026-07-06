import { PARTS, CATEGORY_ORDER } from './parts.js';
import { computeStats, validateDesign, MISSIONS } from './physics.js';
import { audio } from './audio.js';

const $ = (id) => document.getElementById(id);

// ---- persistent state ----

export function loadSave() {
  let save;
  try {
    save = JSON.parse(localStorage.getItem('srb-save')) || {};
  } catch {
    save = {};
  }
  return {
    points: save.points ?? 0,
    unlocked: save.unlocked ?? [],
    best: save.best ?? { altitude: 0, landing: 0, efficiency: 0 },
  };
}

export function storeSave(save) {
  localStorage.setItem('srb-save', JSON.stringify(save));
}

export function isUnlocked(save, id) {
  return PARTS[id].cost === 0 || save.unlocked.includes(id);
}

// ---- screen switching ----

const SCREENS = ['title-screen', 'build-ui', 'launch-ui', 'results-screen', 'unlocks-screen'];

export function showScreen(name) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== name);
}

// ---- build mode UI ----

export function renderPalette(save, design, onAdd) {
  const list = $('palette-list');
  list.innerHTML = '';
  for (const cat of CATEGORY_ORDER) {
    const label = document.createElement('div');
    label.className = 'part-category';
    label.textContent = cat;
    list.appendChild(label);
    for (const [id, p] of Object.entries(PARTS)) {
      if (p.category !== cat) continue;
      const btn = document.createElement('button');
      btn.className = 'part-btn';
      const owned = isUnlocked(save, id);
      const active =
        design.nose === id || design.engine === id || design.fins === id ||
        (id === 'booster-pair' && design.boosters) ||
        (id === 'parachute' && design.parachute);
      if (active) btn.classList.add('active');
      btn.innerHTML =
        '<span>' + p.name + '</span>' +
        '<span class="part-sub">' + (owned ? p.desc : 'locked - ' + p.cost + ' pts') + '</span>';
      if (owned) {
        btn.addEventListener('click', () => { audio.click(); onAdd(id); });
        btn.addEventListener('mouseenter', () => audio.hover());
      } else {
        btn.classList.add('locked');
      }
      list.appendChild(btn);
    }
  }
}

export function renderStack(design, onRemove) {
  const list = $('stack-list');
  list.innerHTML = '';
  const rows = [];
  if (design.nose) rows.push({ key: 'nose', label: PARTS[design.nose].name });
  design.tanks.forEach((t, i) => rows.push({ key: 'tank:' + i, label: PARTS[t].name }));
  if (design.engine) rows.push({ key: 'engine', label: PARTS[design.engine].name });
  if (design.fins) rows.push({ key: 'fins', label: PARTS[design.fins].name });
  if (design.boosters) rows.push({ key: 'boosters', label: PARTS['booster-pair'].name });
  if (design.parachute) rows.push({ key: 'parachute', label: PARTS['parachute'].name });

  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Empty pad. Add parts from the left.';
    list.appendChild(p);
    return;
  }
  for (const row of rows) {
    const btn = document.createElement('button');
    btn.className = 'stack-item';
    btn.textContent = row.label;
    btn.addEventListener('click', () => { audio.click(); onRemove(row.key); });
    list.appendChild(btn);
  }
}

export function renderStats(design) {
  const s = computeStats(design);
  $('stat-mass').textContent = s.mass + ' kg';
  $('stat-thrust').textContent = s.thrust + ' N';

  const twrEl = $('stat-twr');
  twrEl.textContent = s.twr.toFixed(2);
  twrEl.className = s.twr > 1 ? 'stat-good' : 'stat-bad';

  $('stat-burn').textContent = s.burnTime > 0 ? s.burnTime.toFixed(1) + ' s' : '-';

  const stEl = $('stat-stability');
  if (s.stabilityRating >= 2) { stEl.textContent = 'Stable'; stEl.className = 'stat-good'; }
  else if (s.stabilityRating >= 0) { stEl.textContent = 'Marginal'; stEl.className = ''; }
  else { stEl.textContent = 'Unstable'; stEl.className = 'stat-bad'; }

  const warning = validateDesign(design);
  $('build-warning').textContent = warning ?? '';
  $('btn-launch').disabled = !!warning;
}

export function renderMissionPicker(current, onPick) {
  const box = $('mission-picker');
  box.innerHTML = '';
  for (const [id, m] of Object.entries(MISSIONS)) {
    const btn = document.createElement('button');
    btn.className = 'mission-btn' + (id === current ? ' active' : '');
    btn.innerHTML = '<span>' + m.name + '</span><span class="part-sub">' + m.desc + '</span>';
    btn.addEventListener('click', () => { audio.click(); onPick(id); });
    box.appendChild(btn);
  }
}

// ---- launch readout ----

export function updateFlightReadout(flight) {
  $('fl-alt').textContent = Math.max(0, Math.round(flight.alt)) + ' m';
  $('fl-vel').textContent = Math.round(flight.vel) + ' m/s';
  const frac = flight.fuelStart > 0 ? flight.fuel / flight.fuelStart : 0;
  $('fl-fuel').textContent = Math.round(frac * 100) + '%';
  $('fuel-bar-fill').style.width = (frac * 100) + '%';
}

let eventTimer = null;
export function flashEvent(text) {
  const el = $('flight-event');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(eventTimer);
  eventTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---- results ----

export function renderResults(mission, result, score, earned, save, isBest) {
  $('results-heading').textContent = result.safe ? 'Touchdown' : 'Flight Over';
  $('res-alt').textContent = result.maxAlt + ' m';
  $('res-fuel').textContent = result.fuelUsed + ' units';
  $('res-landing').textContent = result.safe
    ? 'Soft (' + result.landingSpeed + ' m/s)'
    : 'Crashed (' + result.landingSpeed + ' m/s)';
  $('res-mission').textContent = MISSIONS[mission].name;
  $('res-score').textContent = String(score);
  $('res-best').textContent = isBest
    ? 'New best for this mission.'
    : 'Best for this mission: ' + save.best[mission];
  $('res-points').textContent = 'Points earned: ' + earned + ' (total ' + save.points + ')';
}

// ---- unlocks ----

export function renderUnlocks(save, onBuy) {
  $('unlock-points').textContent = save.points + ' points available';
  const list = $('unlock-list');
  list.innerHTML = '';
  for (const [id, p] of Object.entries(PARTS)) {
    if (p.cost === 0) continue;
    const row = document.createElement('div');
    row.className = 'unlock-row';
    const info = document.createElement('div');
    info.innerHTML = '<div>' + p.name + '</div><span class="part-sub">' + p.desc + '</span>';
    row.appendChild(info);
    if (save.unlocked.includes(id)) {
      const tag = document.createElement('span');
      tag.className = 'unlock-owned';
      tag.textContent = 'Unlocked';
      row.appendChild(tag);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = p.cost + ' pts';
      btn.disabled = save.points < p.cost;
      btn.addEventListener('click', () => { audio.click(); onBuy(id); });
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}

export function updateTitleBest(save) {
  const b = save.best;
  const any = b.altitude > 0 || b.landing > 0 || b.efficiency > 0;
  $('title-best').textContent = any
    ? 'Best altitude score: ' + b.altitude + ' / points: ' + save.points
    : '';
}
