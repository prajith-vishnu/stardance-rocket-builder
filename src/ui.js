import { PARTS, CATEGORY_ORDER } from './parts.js';
import { computeStats, validateDesign, MISSIONS, ACHIEVEMENTS } from './physics.js';
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
    bestAlt: save.bestAlt ?? 0,
    achievements: save.achievements ?? [],
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
        design.nose === id || design.fins === id ||
        design.stack.includes(id) ||
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
  if (design.parachute) rows.push({ key: 'parachute', label: PARTS['parachute'].name });
  // the stack is stored bottom-up, the list reads top-down
  for (let i = design.stack.length - 1; i >= 0; i--) {
    rows.push({ key: 'stack:' + i, label: PARTS[design.stack[i]].name });
  }
  if (design.fins) rows.push({ key: 'fins', label: PARTS[design.fins].name });
  if (design.boosters) rows.push({ key: 'boosters', label: PARTS['booster-pair'].name });

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

export function renderStats(design, wind) {
  const s = computeStats(design);
  const windEl = $('stat-wind');
  windEl.textContent = wind + ' m/s';
  windEl.className = wind >= 6 ? 'stat-bad' : wind <= 2 ? 'stat-good' : '';
  $('stat-mass').textContent = s.mass + ' kg';
  $('stat-thrust').textContent = s.thrust + ' N';

  const twrEl = $('stat-twr');
  twrEl.textContent = s.twr.toFixed(2);
  twrEl.className = s.twr >= 1.3 ? 'stat-good' : s.twr > 1 ? '' : 'stat-bad';

  $('stat-burn').textContent = s.burnTime > 0 ? s.burnTime.toFixed(1) + ' s' : '-';
  $('stat-stages').textContent = String(s.stageCount);

  const stEl = $('stat-stability');
  if (s.stabilityRating >= 2) { stEl.textContent = 'Stable'; stEl.className = 'stat-good'; }
  else if (s.stabilityRating >= 0) { stEl.textContent = 'Marginal'; stEl.className = ''; }
  else { stEl.textContent = 'Unstable'; stEl.className = 'stat-bad'; }

  const warning = validateDesign(design);
  const warnEl = $('build-warning');
  if (warning) {
    warnEl.textContent = warning;
    warnEl.classList.remove('advice');
  } else if (s.twr < 1.3) {
    // legal but sluggish: warn without blocking the launch
    warnEl.textContent = 'Heavy for this engine - it will climb slowly.';
    warnEl.classList.add('advice');
  } else {
    warnEl.textContent = '';
    warnEl.classList.remove('advice');
  }
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

export function setBestReadout(bestAlt) {
  $('fl-best').textContent = bestAlt > 0 ? bestAlt + ' m' : '-';
}

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

// altitude-over-time telemetry plot. amber line, dots for events:
// red = burnout/cutoff, gray = booster sep, green = chute
function drawFlightGraph(result) {
  const canvas = $('res-graph');
  if (!canvas) return;
  const track = result.track;
  if (!track || track.length < 2) {
    canvas.classList.add('hidden');
    return;
  }
  canvas.classList.remove('hidden');
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);

  const tMax = Math.max(track[track.length - 1][0], 1);
  const aMax = Math.max(result.maxAlt, 10);
  const L = 8, R = 8, T = 16, B = 8;
  const X = (t) => L + (t / tMax) * (W - L - R);
  const Y = (a) => H - B - (a / aMax) * (H - T - B);

  // faint gridlines, printed-chart style
  g.strokeStyle = 'rgba(26,27,29,0.14)';
  g.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = T + ((H - T - B) / 4) * i;
    g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
  }
  // ground
  g.strokeStyle = 'rgba(26,27,29,0.5)';
  g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(W - R, Y(0)); g.stroke();

  // altitude curve in red ink
  g.strokeStyle = '#d8451f';
  g.lineWidth = 2;
  g.beginPath();
  track.forEach(([t, a], i) => (i ? g.lineTo(X(t), Y(a)) : g.moveTo(X(t), Y(a))));
  g.stroke();

  // event dots
  const colors = { burnout: '#1a1b1d', cutoff: '#1a1b1d', relight: '#d8451f', sep: '#6f6a5a', chute: '#2e7d4a' };
  for (const m of result.marks || []) {
    g.fillStyle = colors[m.type] || '#1a1b1d';
    g.beginPath();
    g.arc(X(m.t), Y(Math.max(0, m.alt)), 3, 0, Math.PI * 2);
    g.fill();
  }

  // apogee label
  let peak = track[0];
  for (const p of track) if (p[1] > peak[1]) peak = p;
  g.fillStyle = '#1a1b1d';
  g.font = '10px ui-monospace, Menlo, Consolas, monospace';
  const label = Math.round(peak[1]) + ' m';
  const lx = Math.min(Math.max(X(peak[0]) - 12, L), W - R - g.measureText(label).width);
  g.fillText(label, lx, Math.max(Y(peak[1]) - 6, 10));
}

export function renderResults(mission, result, score, earned, save, isBest, newAchievements) {
  drawFlightGraph(result);
  const achBox = $('res-achievements');
  achBox.innerHTML = '';
  for (const a of newAchievements || []) {
    const el = document.createElement('div');
    el.className = 'ach-stamp';
    el.innerHTML = '<span>' + a.name + '</span><span class="part-sub">' + a.desc + '</span>';
    achBox.appendChild(el);
  }
  $('results-heading').textContent = result.safe ? 'Touchdown' : 'Flight Over';
  $('res-alt').textContent = result.maxAlt + ' m';
  $('res-fuel').textContent = result.fuelUsed + ' units';
  $('res-landing').textContent = result.safe
    ? 'Soft (' + result.landingSpeed + ' m/s' + (result.relit && !result.chuteUsed ? ', propulsive' : '') + ')'
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

  const achList = $('achievement-list');
  achList.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const earned = save.achievements.includes(a.id);
    const row = document.createElement('div');
    row.className = 'ach-row' + (earned ? ' earned' : '');
    row.innerHTML =
      '<div><div>' + a.name + '</div><span class="part-sub">' + a.desc + '</span></div>' +
      '<span class="ach-state">' + (earned ? 'Earned' : 'Locked') + '</span>';
    achList.appendChild(row);
  }
}

export function updateTitleBest(save) {
  const b = save.best;
  const any = b.altitude > 0 || b.landing > 0 || b.efficiency > 0;
  $('title-best').textContent = any
    ? 'Best altitude score: ' + b.altitude + ' / points: ' + save.points
    : '';
}
