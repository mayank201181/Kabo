// Sound effects synthesised with Web Audio (no files to download), plus
// vibration and a spoken "Kabo!".

let ctx = null;
let noiseBuf = null;
let muted = false;
try {
  muted = localStorage.getItem('kabo.muted') === '1';
} catch {}

export const isMuted = () => muted;

export function setMuted(on) {
  muted = on;
  try {
    localStorage.setItem('kabo.muted', on ? '1' : '0');
  } catch {}
}

// Browsers only allow audio after a tap, so call this from tap handlers.
export function unlockAudio() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
  } catch {}
}

function tone(freq, dur, { type = 'sine', vol = 0.12, at = 0, slide = null } = {}) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

function noise(dur, { vol = 0.2, at = 0, freq = 2000, q = 0.8 } = {}) {
  if (!ctx || muted) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

export const sfx = {
  draw: () => noise(0.16, { freq: 2600, vol: 0.2 }),
  place: () => noise(0.06, { freq: 1400, vol: 0.4 }),
  flip: () => noise(0.05, { freq: 4200, vol: 0.28 }),
  swap: () => {
    noise(0.13, { freq: 2200, vol: 0.2 });
    noise(0.13, { freq: 3000, vol: 0.2, at: 0.13 });
  },
  shuffle: () => {
    for (let i = 0; i < 7; i++) noise(0.05, { freq: 1600 + i * 180, vol: 0.22, at: i * 0.055 });
  },
  turn: () => {
    tone(660, 0.14, { vol: 0.13 });
    tone(990, 0.24, { vol: 0.13, at: 0.12 });
  },
  tick: () => tone(1500, 0.03, { type: 'square', vol: 0.035 }),
  cabo: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, { type: 'triangle', vol: 0.16, at: i * 0.09 })),
  oops: () => tone(200, 0.3, { type: 'sawtooth', vol: 0.07, slide: 110 }),
  error: () => tone(220, 0.14, { type: 'square', vol: 0.045 }),
  end: () => [784, 659, 523].forEach((f, i) => tone(f, 0.22, { vol: 0.12, at: i * 0.12 })),
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.28, { type: 'triangle', vol: 0.14, at: i * 0.1 })),
  ping: () => tone(880, 0.12, { vol: 0.08 }),
};

export function speak(text) {
  if (muted || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1.15;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

export function haptic(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}
