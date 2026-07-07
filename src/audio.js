// All sounds are generated with the Web Audio API, no audio files.

let ctx = null;
let master = null;
let muted = localStorage.getItem('srb-muted') === '1';

// engine rumble nodes, kept around while a launch is running
let rumble = null;

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
  }
  // browsers suspend audio until a user gesture
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noiseBuffer(seconds) {
  const c = ensureCtx();
  const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export const audio = {
  get muted() { return muted; },

  setMuted(m) {
    muted = m;
    localStorage.setItem('srb-muted', m ? '1' : '0');
    if (master) master.gain.value = m ? 0 : 1;
  },

  toggleMute() {
    this.setMuted(!muted);
    return muted;
  },

  // short filtered blip for buttons
  click() {
    const c = ensureCtx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = 660;
    g.gain.setValueAtTime(0.06, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.06);
    o.connect(g).connect(master);
    o.start();
    o.stop(c.currentTime + 0.07);
  },

  hover() {
    const c = ensureCtx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.02, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.04);
    o.connect(g).connect(master);
    o.start();
    o.stop(c.currentTime + 0.05);
  },

  // big noise swell plus a falling sine thump
  ignition() {
    const c = ensureCtx();
    const t = c.currentTime;

    const src = c.createBufferSource();
    src.buffer = noiseBuffer(1.5);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(200, t);
    f.frequency.exponentialRampToValueAtTime(1800, t + 0.4);
    const g = c.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.15, t + 1.2);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + 1.5);

    const o = c.createOscillator();
    const og = c.createGain();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.8);
    og.gain.setValueAtTime(0.25, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(og).connect(master);
    o.start(t);
    o.stop(t + 1);
  },

  // two looping noise layers at different filter bands; gain follows thrust
  startEngine() {
    const c = ensureCtx();
    if (rumble) this.stopEngine();

    const makeLayer = (freq, gain) => {
      const src = c.createBufferSource();
      src.buffer = noiseBuffer(2);
      src.loop = true;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = freq;
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g);
      src.start();
      return { src, f, g };
    };

    const low = makeLayer(120, 0.35);
    const mid = makeLayer(600, 0.12);
    const out = c.createGain();
    out.gain.value = 0;
    low.g.connect(out);
    mid.g.connect(out);

    // slow wobble on the low layer so it does not sound static
    const lfo = c.createOscillator();
    lfo.frequency.value = 7;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 30;
    lfo.connect(lfoGain).connect(low.f.frequency);
    lfo.start();

    out.connect(master);
    rumble = { low, mid, out, lfo };
  },

  // called every frame with thrust fraction 0..1
  setEngineLevel(frac) {
    if (!rumble || !ctx) return;
    const target = Math.max(0, Math.min(1, frac)) * 0.6;
    rumble.out.gain.setTargetAtTime(target, ctx.currentTime, 0.1);
  },

  stopEngine() {
    if (!rumble || !ctx) return;
    const r = rumble;
    rumble = null;
    r.out.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    setTimeout(() => {
      r.low.src.stop(); r.mid.src.stop(); r.lfo.stop();
    }, 600);
  },

  // bright little ping for altitude milestones
  ping() {
    const c = ensureCtx();
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1150, t);
    o.frequency.exponentialRampToValueAtTime(1500, t + 0.07);
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.18);
  },

  // dull valve-shut thunk for manual engine cutoff
  cutoff() {
    const c = ensureCtx();
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.3);

    const src = c.createBufferSource();
    src.buffer = noiseBuffer(0.2);
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2500;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.08, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    src.connect(f).connect(ng).connect(master);
    src.start(t);
    src.stop(t + 0.2);
  },

  // sharp band-passed pop for booster separation
  separation() {
    const c = ensureCtx();
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(0.4);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 1.5;
    const g = c.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + 0.4);
  },

  crash() {
    const c = ensureCtx();
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(1.4);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2500, t);
    f.frequency.exponentialRampToValueAtTime(80, t + 1.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + 1.4);
  },

  // soft double thud
  land() {
    const c = ensureCtx();
    const t = c.currentTime;
    for (const [dt, vol] of [[0, 0.25], [0.12, 0.1]]) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.setValueAtTime(70, t + dt);
      o.frequency.exponentialRampToValueAtTime(40, t + dt + 0.15);
      g.gain.setValueAtTime(vol, t + dt);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.2);
      o.connect(g).connect(master);
      o.start(t + dt);
      o.stop(t + dt + 0.25);
    }
  },

  // chute pop: quick high noise burst
  chute() {
    const c = ensureCtx();
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(0.3);
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1200;
    const g = c.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + 0.3);
  },
};
