import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Chrome Fever: browser third-person shooter in a rainy cyberpunk night market.
 *
 * Single ES module, loaded by index.html. Three.js and its addons come from the
 * import map in index.html; there is no build step.
 *
 * Reading order (each section starts with a banner comment):
 *   1. Shared helpers, persistence, renderer, toon materials, geometry cache
 *   2. Audio: sound effects and the procedural synthwave sequencer
 *   3. World: static batching, smoke, the procedural night market, rain
 *   4. Post-processing and quality presets
 *   5. Effects: particles, stars, rings, afterimages, debris
 *   6. Characters: canvas-drawn anime sprites and primitive-built 3D rigs
 *   7. Game state, input, UI, run flow, abilities, spawning, collisions, combat
 *   8. Per-frame simulation, camera, 2D overlay, HUD and the main loop
 *
 * Conventions used throughout:
 *   - World units are metres. The playable arena is the square [-A, A] on x/z;
 *     y points up.
 *   - `rdt` is real (unscaled) frame time in seconds, capped at 50 ms.
 *     `dt` is game time, which Overclock slows down to 20 % of real time.
 *   - Hot paths use fixed-size pools and typed arrays instead of allocating
 *     per frame (particles, rain, smoke, bullets, debris, afterimages).
 *   - UI text is German on purpose; it is the game's localization.
 *   - Persistent settings live in localStorage via `store` (see docs/architecture.md).
 */

/* ================= helpers & persistence ================= */
/** Shorthand for `document.querySelector`. */
const $ = s => document.querySelector(s);
const cvs = $('#game'), fx = $('#fx'), octx = fx.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const TAU = Math.PI * 2;
/** Palette as hex numbers for Three.js (C) and CSS strings for Canvas 2D (CS). */
const C = { y:0xF7E733, m:0xFF2A8A, c:0x2CF6FF, r:0xFF3D3D, v:0x6E35FF, ink:0x07050c, w:0xFFF6E0, g:0x7dffb2 };
const CS = { y:'#F7E733', m:'#FF2A8A', c:'#2CF6FF', r:'#FF3D3D', ink:'#07050c', w:'#FFF6E0', g:'#7dffb2' };
/** Font stacks: display face (FD) and Japanese face (FJ) for canvas text. */
const FD = '"Big Shoulders Display", Impact, "Arial Narrow", sans-serif';
const FJ = '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif';
const A = 24; // arena half size
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const pad2 = n => String(n).padStart(2, '0');
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };
/** Deterministic linear congruential RNG; returns a function yielding [0, 1). */
function seeded(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

/** JSON wrapper around localStorage that never throws (private mode, quota). */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
let best = store.get('chromefever3d-best', 0);
let muted = store.get('chromefever-muted', false);
$('#bestMenu').textContent = best.toLocaleString('de-DE');

/* ================= renderer =================
 * WebGL renderer, scene, camera and viewport sizing. Fails with a
 * visible message in the menu when WebGL is unavailable.
 */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: cvs, antialias: !coarse, powerPreference: 'high-performance' });
} catch (e) {
  $('#menuHint').innerHTML = '<span class="err">Dein Browser kann kein WebGL darstellen. Aktiviere die Hardware-Beschleunigung oder probier einen anderen Browser.</span>';
  $('#btnStart').textContent = 'WebGL fehlt';
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.25 : 1.6));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0816);
scene.fog = new THREE.FogExp2(0x1a0d2a, 0.0115);
const camera = new THREE.PerspectiveCamera(68, 1, 0.15, 260);
let composer = null, bloomPass = null, fxPass = null, inkPass = null, moonLight = null, impactT = 0, speedT = 0;
let cssW = 0, cssH = 0, ODPR = 1;
/** Matches renderer, camera, overlay canvas and composer to the window size. */
function resize() {
  cssW = window.innerWidth; cssH = window.innerHeight;
  renderer.setSize(cssW, cssH, false);
  camera.aspect = cssW / cssH; camera.updateProjectionMatrix();
  ODPR = Math.min(2, window.devicePixelRatio || 1);
  fx.width = Math.round(cssW * ODPR); fx.height = Math.round(cssH * ODPR);
  if (composer) composer.setSize(cssW, cssH);
}

/* ================= materials & geometry =================
 * Anime toon shading, shared material factories, the geometry cache and
 * procedurally drawn canvas textures.
 */
/** Three-step gradient map that gives MeshToonMaterial its hard light bands. */
const gradMap = (() => { const t = new THREE.DataTexture(new Uint8Array([70, 150, 255]), 3, 1, THREE.RedFormat); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; })();
let RIM_ON = false;
const ANIME_U = { uAnimeT: { value: new THREE.Vector2(0.32, 1.0) }, uRim: { value: 0.55 } };
/**
 * Fragment shader patch for toon materials: three-tone anime shading with a
 * halftone dot pattern in shadows and an optional magenta/cyan rim light
 * (enabled through the ANIME_RIM define while `RIM_ON` is true).
 */
const ANIME_GLSL = `
  vec3 litA = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  vec3 baseA = max(diffuseColor.rgb, vec3(0.0005));
  vec3 lcA = litA / baseA;
  float llA = dot(lcA, vec3(0.299, 0.587, 0.114));
  vec3 hueA = mix(vec3(1.0), clamp(lcA / max(llA, 0.0001), 0.0, 2.2), 0.5);
  vec2 cellA = fract(gl_FragCoord.xy / 5.0) - 0.5;
  float dotA = step(length(cellA), 0.3);
  vec3 animeCol;
  if (llA < uAnimeT.x) animeCol = baseA * vec3(0.26, 0.2, 0.52) * mix(1.0, 0.7, dotA);
  else if (llA < uAnimeT.y) animeCol = baseA * hueA * 0.62;
  else animeCol = baseA * hueA * min(llA, 1.6) * 0.95;
  float fresA = 1.0 - max(dot(normalize(geometryNormal), geometryViewDir), 0.0);
  float rimA = smoothstep(0.6, 0.66, fresA);
  vec3 rimColA = mix(vec3(1.0, 0.16, 0.54), vec3(0.17, 0.96, 1.0), clamp(geometryNormal.x * 0.5 + 0.5, 0.0, 1.0));
  #ifdef ANIME_RIM
  animeCol += rimColA * rimA * uRim;
  #endif
  vec3 outgoingLight = animeCol + totalEmissiveRadiance;`;
/** Injects ANIME_GLSL into a material and keys its shader program cache. */
function animeify(m) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uAnimeT = ANIME_U.uAnimeT; sh.uniforms.uRim = ANIME_U.uRim;
    sh.fragmentShader = 'uniform vec2 uAnimeT;\nuniform float uRim;\n' + sh.fragmentShader.replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', ANIME_GLSL);
  };
  if (RIM_ON) m.defines = { ANIME_RIM: '' };
  const key = RIM_ON ? 'anime-rim' : 'anime-v1';
  m.customProgramCacheKey = () => key;
  return m;
}
/** Material factories: toon (lit, outlined look), basic (unlit), neon (HDR unlit that blooms). */
const toon = (col, opts = {}) => { const m = animeify(new THREE.MeshToonMaterial({ color: col, gradientMap: gradMap, ...opts })); m.userData.em = m.emissive.getHex(); return m; };
const basic = (col, opts = {}) => new THREE.MeshBasicMaterial({ color: col, ...opts });
const neon = (hex, k = 2.4) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: false });
/** Back-face material for inverted-hull outlines. */
const OUTLINE = new THREE.MeshBasicMaterial({ color: C.ink, side: THREE.BackSide });
/**
 * Geometry cache keyed by shape and size. `dims` is stored so `part()` can
 * scale an outline hull by a constant thickness.
 */
const geoCache = new Map();
function cached(key, make, dims) { if (!geoCache.has(key)) { const g = make(); g.userData.dims = dims; geoCache.set(key, g); } return geoCache.get(key); }
const box = (w, h, d) => cached(`b${w}_${h}_${d}`, () => new THREE.BoxGeometry(w, h, d), [w, h, d]);
const sph = (r, s = 14) => cached(`s${r}_${s}`, () => new THREE.SphereGeometry(r, s, Math.max(6, Math.round(s * 0.65))), [2 * r, 2 * r, 2 * r]);
const cyl = (rt, rb, h, s = 10) => cached(`c${rt}_${rb}_${h}_${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s), [2 * Math.max(rt, rb), h, 2 * Math.max(rt, rb)]);
const octa = r => cached(`o${r}`, () => new THREE.OctahedronGeometry(r), [2 * r, 2 * r, 2 * r]);
/**
 * Adds a mesh to `parent` with an optional inverted-hull outline.
 * @param {THREE.Object3D} parent
 * @param {THREE.BufferGeometry} geo - geometry from the cache (needs userData.dims)
 * @param {THREE.Material} mat
 * @param {number} [t=0.045] - outline thickness in metres; 0 disables it
 * @returns {THREE.Mesh}
 */
function part(parent, geo, mat, x = 0, y = 0, z = 0, t = 0.045) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = !!mat.isMeshToonMaterial;
  if (t > 0) { const o = new THREE.Mesh(geo, OUTLINE); const d = geo.userData.dims; o.scale.set(1 + 2 * t / d[0], 1 + 2 * t / d[1], 1 + 2 * t / d[2]); m.add(o); }
  parent.add(m); return m;
}
/**
 * Creates a texture by drawing into an offscreen canvas.
 * @param {number} w
 * @param {number} h
 * @param {(g: CanvasRenderingContext2D, w: number, h: number) => void} draw
 * @param {[number, number]} [repeat] - enables repeat wrapping with this tiling
 */
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
/** Shared procedural textures: soft dot, impact star and hazard stripes. */
const dotTex = canvasTex(64, 64, (g) => { const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); });
const starTex = canvasTex(128, 128, (g) => {
  g.translate(64, 64); g.beginPath();
  for (let i = 0; i < 20; i++) { const r = i % 2 ? 24 : 58, a = i / 20 * TAU; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fillStyle = CS.y; g.fill(); g.lineWidth = 7; g.strokeStyle = CS.ink; g.lineJoin = 'round'; g.stroke();
  g.fillStyle = CS.w; g.beginPath(); g.arc(0, 0, 16, 0, TAU); g.fill();
});
const hazardTex = canvasTex(64, 64, (g) => { g.fillStyle = CS.ink; g.fillRect(0, 0, 64, 64); g.fillStyle = CS.y; for (let i = -64; i < 128; i += 22) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 11, 0); g.lineTo(i - 53, 64); g.lineTo(i - 64, 64); g.fill(); } }, [2, 1]);

/* ================= audio =================
 * Web Audio sound effects. Every sound is synthesized from oscillators and
 * a shared white-noise buffer; there are no audio files.
 */
let AC = null, master = null, noiseBuf = null;
/** Creates the AudioContext lazily on the first user gesture (autoplay policy). */
function initAudio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = muted ? 0 : 0.32; master.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch (e) { AC = null; }
}
/**
 * Plays one oscillator note with an exponential decay.
 * @param {number} f - start frequency in Hz
 * @param {number} dur - seconds
 * @param {OscillatorType} [type]
 * @param {number} [vol]
 * @param {number} [slide=1] - end frequency as a multiple of `f`
 * @param {number} [delay=0] - seconds from now
 */
function tone(f, dur, type = 'square', vol = 0.2, slide = 1, delay = 0) {
  if (!AC || muted) return;
  const t = AC.currentTime + delay, o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (slide !== 1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f * slide), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.03);
}
/** Plays a band-passed burst of the shared noise buffer. */
function noise(dur, vol, freq = 1200, q = 1) {
  if (!AC || muted) return;
  const t = AC.currentTime, s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
  s.buffer = noiseBuf; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.03);
}
let lastShotSnd = 0, lastHitSnd = 0;
/** Named sound effects. `shoot` and `hit` are rate-limited to avoid clipping. */
const sfx = {
  shoot() { const n = performance.now(); if (n - lastShotSnd < 55) return; lastShotSnd = n; tone(rand(820, 980), 0.06, 'square', 0.035, 0.45); noise(0.04, 0.04, 4000, 1); },
  hit() { const n = performance.now(); if (n - lastHitSnd < 40) return; lastHitSnd = n; noise(0.05, 0.09, 2600, 2); },
  kill() { tone(rand(300, 360), 0.16, 'sawtooth', 0.09, 0.25); noise(0.14, 0.12, 900); },
  hurt() { tone(130, 0.28, 'sawtooth', 0.22, 0.45); noise(0.22, 0.22, 380); },
  dash() { noise(0.2, 0.14, 3200, 0.6); tone(240, 0.15, 'triangle', 0.08, 2.2); },
  oc() { tone(1400, 0.7, 'sawtooth', 0.1, 0.07); tone(700, 0.9, 'sine', 0.18, 0.12); noise(0.5, 0.12, 600, 0.5); },
  ocEnd() { tone(140, 0.35, 'sawtooth', 0.1, 6); },
  eshot() { tone(rand(480, 540), 0.08, 'triangle', 0.04, 0.6); },
  warn() { tone(880, 0.1, 'square', 0.08); tone(880, 0.1, 'square', 0.08, 1, 0.16); },
  boom() { noise(0.7, 0.35, 260, 0.5); tone(90, 0.7, 'sine', 0.35, 0.3); },
  boss() { tone(55, 1.3, 'sawtooth', 0.22, 0.8); tone(82, 1.3, 'square', 0.08, 0.8); noise(1.1, 0.16, 180); },
  wave() { tone(660, 0.12, 'square', 0.08); tone(990, 0.2, 'square', 0.08, 1, 0.09); },
  up() { [0, 4, 7, 12].forEach((s, i) => tone(440 * 2 ** (s / 12), 0.16, 'square', 0.07, 1, i * 0.06)); },
  heal() { tone(660, 0.1, 'sine', 0.12, 1.5); tone(990, 0.14, 'sine', 0.1, 1.3, 0.07); },
  shotgun() { noise(0.25, 0.3, 700, 0.7); tone(110, 0.2, 'sawtooth', 0.15, 0.4); },
  slash() { noise(0.16, 0.16, 5200, 0.8); tone(1600, 0.1, 'sine', 0.05, 0.4); },
  deflect() { tone(2400, 0.12, 'square', 0.06, 0.6); noise(0.06, 0.1, 6000, 2); },
  swap() { tone(520, 0.05, 'square', 0.05); tone(780, 0.06, 'square', 0.05, 1, 0.05); },
  spawn() { tone(200, 0.2, 'sawtooth', 0.04, 2.5); }
};

/* ================= music (procedural synthwave) =================
 * A 16-step, 4-bar synthwave loop scheduled ahead of time with a
 * look-ahead timer. Drums only play during combat; a low-pass filter
 * muffles the mix in menus, pause and Overclock.
 */
let musicOn = store.get('chromefever-music', true), musicGain = null, musicFilter = null, seqTimer = null, mStep = 0, mNext = 0, mTarget = 0;
/** Seconds per 16th note at 112 BPM, and the chord progression as MIDI notes. */
const SPB = 60 / 112 / 4;
const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
/** Starts the look-ahead sequencer: every 25 ms it schedules steps due in the next 120 ms. */
function startMusic() {
  if (!AC || seqTimer) return;
  musicFilter = AC.createBiquadFilter(); musicFilter.type = 'lowpass'; musicFilter.frequency.value = 2200; musicFilter.Q.value = 3;
  musicGain = AC.createGain(); musicGain.gain.value = musicOn ? 0.42 : 0;
  musicFilter.connect(musicGain); musicGain.connect(master);
  mStep = 0; mNext = AC.currentTime + 0.08;
  seqTimer = setInterval(() => { while (mNext < AC.currentTime + 0.12) { playStep(mStep, mNext); mNext += SPB; mStep = (mStep + 1) % 64; } }, 25);
}
function mnote(f, t, dur, type, vol) {
  const o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(musicFilter); o.start(t); o.stop(t + dur + 0.05);
}
function mnoise(t, dur, vol, freq, type = 'highpass') {
  const s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(musicFilter); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
}
/** Schedules all voices for one 16th-note step `s` at audio time `t`. */
function playStep(s, t) {
  if (!musicOn || muted) return;
  const bar = Math.floor(s / 16) % 4, i = s % 16, ch = PROG[bar];
  const fight = state === 'play' || state === 'dying';
  if (i % 4 === 0 && fight) { const o = AC.createOscillator(), g = AC.createGain(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12); g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25); o.connect(g); g.connect(musicFilter); o.start(t); o.stop(t + 0.3); }
  if ((i === 4 || i === 12) && fight) { mnoise(t, 0.18, 0.3, 1500, 'bandpass'); mnote(200, t, 0.1, 'triangle', 0.15); }
  if (i % 2 === 1) mnoise(t, 0.04, fight ? 0.1 : 0.04, 8000);
  if (i % 2 === 0) mnote(mtof(ch[0] - 24 + (i % 8 === 6 ? 12 : 0)), t, SPB * 1.8, 'sawtooth', 0.2);
  mnote(mtof(ch[i % 3] + 12 + (i % 8 >= 4 ? 12 : 0)), t, SPB * 0.9, 'square', 0.04);
  if (i === 0) ch.forEach(m => mnote(mtof(m), t, SPB * 15, 'sawtooth', 0.028));
  if (boss && !boss.dead && [0, 3, 6, 10].includes(i)) mnote(mtof(ch[i % 3] + 24), t, SPB * 2, 'sawtooth', 0.05);
}
/** Moves the music low-pass cutoff to match the current game state. */
function updateMusic() {
  if (!musicFilter) return;
  const target = state === 'pause' || state === 'upgrade' ? 900 : ocActive ? 480 : state === 'play' || state === 'dying' ? 5200 : 2200;
  if (target !== mTarget) { mTarget = target; musicFilter.frequency.setTargetAtTime(target, AC.currentTime, 0.15); }
}

/* ================= world =================
 * World-level registries for animated props, neon signs and flicker.
 * `OBST` holds the axis-aligned obstacle boxes used for collision.
 */
const OBST = []; // {x0,x1,z0,z1,h}
const SIGNS = ['ラーメン', '夜市', '電脳', '改造', 'チップ', '占い', '酒場', '薬局', '屋台', '修理', '寿司', '金魚'];
/** Draws a glowing neon sign texture with Japanese text, horizontal or vertical. */
function signTex(text, col, vertical) {
  const chars = [...text], n = chars.length;
  const w = vertical ? 140 : 110 * n + 60, h = vertical ? 112 * n + 60 : 150;
  return canvasTex(w, h, (g) => {
    g.fillStyle = '#0b0614'; g.fillRect(0, 0, w, h);
    g.strokeStyle = col; g.lineWidth = 6; g.shadowColor = col; g.shadowBlur = 18; g.strokeRect(10, 10, w - 20, h - 20);
    g.font = `900 92px ${FJ}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = col;
    for (let pass = 0; pass < 2; pass++) {
      if (vertical) chars.forEach((ch, i) => g.fillText(ch, w / 2, 30 + 56 + i * 112));
      else g.fillText(text, w / 2, h / 2 + 4);
      g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,.75)'; g.font = `900 86px ${FJ}`;
    }
  });
}
const NEON = ['#FF2A8A', '#2CF6FF', '#F7E733', '#9a6bff', '#ff6a3d'];
const FLICKER = [], CARS = [], FACADES = [], STALLS = [], STEAM = [], BANNERS = [], ADS = [], BIGHOLO = [], SEARCH = []; let holo = null, HW = null;
const SIGN_MATS = {};
/** Cached material for a sign; about a third of signs are registered to flicker. */
function signMat(txt, col, vert) { const k = txt + col + vert; return SIGN_MATS[k] || (SIGN_MATS[k] = flickerMat(basic(new THREE.Color(2.2, 2.2, 2.2), { map: signTex(txt, col, vert), toneMapped: false, side: THREE.DoubleSide }))); }
const blinkMat = neon(C.r, 3);
function flickerMat(m) { if (Math.random() < 0.35) FLICKER.push({ m, base: m.color.clone(), t: 0 }); return m; }
const mtxW = new THREE.Matrix4();
/** Animates ambient props: traffic, flicker, holograms, banners, ads, searchlights, splashes. */
function updateWorldAnim(rdt, dt) {
  for (const c of CARS) { const p = c.g.position; if (c.alongX) { p.x += c.v * dt; if (p.x > 90) p.x = -90; else if (p.x < -90) p.x = 90; } else { p.z += c.v * dt; if (p.z > 90) p.z = -90; else if (p.z < -90) p.z = 90; } }
  for (const f of FLICKER) { if (f.t > 0) { f.t -= rdt; f.m.color.copy(f.base).multiplyScalar(Math.random() < 0.5 ? 0.15 : 1); if (f.t <= 0) f.m.color.copy(f.base); } else if (Math.random() < rdt * 0.06) f.t = rand(0.1, 0.45); }
  if (holo) { holo.position.y = 4.6 + Math.sin(clock * 1.3) * 0.2; holo.material.rotation = Math.sin(clock * 1.6) * 0.07; holo.material.opacity = Math.random() < 0.04 ? 0.35 : 0.9; }
  muzzleLight.intensity *= Math.pow(0.0004, rdt);
  for (let i = 0; i < BANNERS.length; i++) { const b = BANNERS[i]; b.rotation.x = Math.sin(clock * 1.6 + i * 1.7) * 0.14 + Math.sin(clock * 3.1 + i) * 0.04; }
  for (const t of ADS) { t.offset.y = (t.offset.y + dt * 0.035) % 1; t.offset.x = Math.random() < 0.01 ? rand(-0.05, 0.05) : 0; }
  const on = Math.floor(clock * 1.3) % 2 === 0; blinkMat.color.setRGB(on ? 3 : 0.25, on ? 0.35 : 0.03, on ? 0.35 : 0.03);
  updateSmoke(dt);
  if (HW) { for (let i = 0; i < HW.cars.length; i++) { const c = HW.cars[i]; c.x += c.v * dt; if (c.x > 110) c.x = -110; else if (c.x < -110) c.x = 110; mtxW.makeTranslation(c.x, 24.6, c.z); HW.im.setMatrixAt(i, mtxW); } HW.im.instanceMatrix.needsUpdate = true; }
  for (const h of BIGHOLO) { h.material.opacity = Math.random() < 0.03 ? 0.3 : 0.85 + Math.sin(clock * 9) * 0.08; h.material.rotation = Math.random() < 0.02 ? rand(-0.03, 0.03) : 0; }
  for (const sl of SEARCH) { sl.m.rotation.x = 0.35 + Math.sin(clock * 0.31 + sl.ph) * 0.3; sl.m.rotation.y = clock * 0.18 + sl.ph; }
  if (state !== 'pause' && state !== 'upgrade') for (let i = 0; i < 3; i++) emit(camera.position.x + rand(-12, 12), 0.04, camera.position.z + rand(-12, 12), rand(-0.5, 0.5), rand(0.8, 1.6), rand(-0.5, 0.5), 0.16, 0x9fd8ff, 9, 0.7);
}

/* ================= static batching =================
 * Static decoration is collected per material and merged into one mesh per
 * material in `flushBatches()`, which keeps draw calls low.
 */
const BATCH = new Map();
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _eu = new THREE.Euler(), _p = new THREE.Vector3(), _sc = new THREE.Vector3();
/** Bakes a transform into `geo` and queues it for merging under `mat`. */
function addBatch(mat, geo, x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _eu.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_eu); _m4.compose(_p.set(x, y, z), _q, _sc.set(sx, sy, sz));
  geo.applyMatrix4(_m4);
  if (!BATCH.has(mat)) BATCH.set(mat, []);
  BATCH.get(mat).push(geo);
}
/** Batched static box, cylinder and sphere helpers, each with an optional outline hull. */
function sbox(w, h, d, mat, x, y, z, ry = 0, rx = 0, rz = 0, t = 0.04) {
  addBatch(mat, new THREE.BoxGeometry(w, h, d), x, y, z, ry, rx, rz);
  if (t > 0) addBatch(OUTLINE, new THREE.BoxGeometry(w + 2 * t, h + 2 * t, d + 2 * t), x, y, z, ry, rx, rz);
}
function scyl(rt, rb, h, seg, mat, x, y, z, ry = 0, rx = 0, rz = 0, t = 0.03) {
  addBatch(mat, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, ry, rx, rz);
  if (t > 0) addBatch(OUTLINE, new THREE.CylinderGeometry(rt + t, rb + t, h + 2 * t, seg), x, y, z, ry, rx, rz);
}
function ssph(r, mat, x, y, z, sy = 1, t = 0.03) {
  addBatch(mat, new THREE.SphereGeometry(r, 10, 7), x, y, z, 0, 0, 0, 1, sy, 1);
  if (t > 0) addBatch(OUTLINE, new THREE.SphereGeometry(r + t, 10, 7), x, y, z, 0, 0, 0, 1, sy, 1);
}
/** Merges every queued geometry per material into one static mesh. */
function flushBatches() {
  for (const [mat, geos] of BATCH) {
    const merged = mergeGeometries(geos, false);
    geos.forEach(g => g.dispose());
    if (!merged) continue;
    const m = new THREE.Mesh(merged, mat); m.matrixAutoUpdate = false; m.updateMatrix(); m.castShadow = m.receiveShadow = !!mat.isMeshToonMaterial; scene.add(m);
  }
  BATCH.clear();
}

/* ================= smoke =================
 * Steam from manholes and stalls: a pooled point cloud with additive blending.
 */
const SMN = 280;
const smPos = new Float32Array(SMN * 3), smCol = new Float32Array(SMN * 3), smVel = new Float32Array(SMN * 3), smLife = new Float32Array(SMN), smMax = new Float32Array(SMN);
for (let i = 0; i < SMN; i++) smPos[i * 3 + 1] = -999;
const smGeo = new THREE.BufferGeometry(); smGeo.setAttribute('position', new THREE.BufferAttribute(smPos, 3)); smGeo.setAttribute('color', new THREE.BufferAttribute(smCol, 3));
const smoke = new THREE.Points(smGeo, new THREE.PointsMaterial({ size: 1.7, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
smoke.frustumCulled = false; scene.add(smoke);
let smCursor = 0, smTimer = 0;
/** Emits new steam from `STEAM` sources and fades existing puffs. */
function updateSmoke(dt) {
  smTimer -= dt;
  if (smTimer <= 0) {
    smTimer = 0.09;
    for (const [x, y, z] of STEAM) { const i = smCursor; smCursor = (smCursor + 1) % SMN; const j = i * 3; smPos[j] = x + rand(-0.15, 0.15); smPos[j + 1] = y; smPos[j + 2] = z + rand(-0.15, 0.15); smVel[j] = rand(-0.2, 0.2) + 0.25; smVel[j + 1] = rand(0.7, 1.3); smVel[j + 2] = rand(-0.2, 0.2); smLife[i] = smMax[i] = rand(2.2, 3.4); }
  }
  for (let i = 0; i < SMN; i++) {
    if (smLife[i] <= 0) continue;
    const j = i * 3; smLife[i] -= dt;
    if (smLife[i] <= 0) { smPos[j + 1] = -999; continue; }
    smPos[j] += smVel[j] * dt; smPos[j + 1] += smVel[j + 1] * dt; smPos[j + 2] += smVel[j + 2] * dt;
    const k = smLife[i] / smMax[i], a = Math.sin(k * Math.PI) * 0.17;
    smCol[j] = 0.55 * a; smCol[j + 1] = 0.5 * a; smCol[j + 2] = 0.78 * a;
  }
  smGeo.attributes.position.needsUpdate = true; smGeo.attributes.color.needsUpdate = true;
}

/* ================= map detail =================
 * Procedural construction of the night market. `buildDetails()` adds sky,
 * skyline, facades and props; `buildWorld()` lays out lights, stalls,
 * obstacles and then flushes the static batches. A seeded RNG keeps the
 * layout identical on every load.
 */
/** Draws a vertical advertising billboard texture. */
function adTex(title, sub, a, b, accent) {
  return canvasTex(256, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, a); gr.addColorStop(1, b); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = accent; g.beginPath(); g.arc(w * 0.68, h * 0.2, 56, 0, TAU); g.fill();
    g.strokeStyle = '#fff6e0'; g.lineWidth = 5; g.beginPath(); g.arc(w * 0.68, h * 0.2, 70, 0, TAU); g.stroke();
    g.fillStyle = '#fff6e0'; g.font = `900 62px ${FJ}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    [...title].forEach((c, k) => g.fillText(c, w * 0.28, 70 + k * 74));
    g.save(); g.translate(w * 0.72, h * 0.62); g.rotate(Math.PI / 2); g.font = `900 40px ${FD}`; g.fillText(sub, 0, 0); g.restore();
    g.fillStyle = 'rgba(7,5,12,.28)'; for (let y = 0; y < h; y += 5) g.fillRect(0, y, w, 2);
  });
}
/**
 * Builds decorative world detail. Called once from `buildWorld()`.
 * @param {() => number} R - seeded RNG so the layout is stable
 * @param {THREE.Texture} winTex - lit-window texture reused for the skyline
 */
function buildDetails(R, winTex) {
  const M = {
    concrete: toon(0x2a2236), concrete2: toon(0x3a3048), metal: toon(0x4c4a60), darkM: toon(0x15101e), rust: toon(0x6a3a2a),
    white: toon(0xe0d8e8), orange: toon(0xff6a20), bag: toon(0x15181f), card: toon(0x8a6a4a), stool: toon(0xd8243a),
    neonM: NEON.map(c => neon(c, 1.8)), neonDim: NEON.map(c => neon(c, 0.5)),
    awn: [toon(0xd8243a), toon(0x2a5aa8), toon(0x1e6a4a), toon(0x8a2a8a)]
  };
  const bulb = neon(0xffd89a, 2.6), paper = [neon(0xff3d3d, 1.9), neon(0xff9a3d, 1.9), neon(0xffd36b, 1.7)];

  // sky dome, stars, moon
  const skyTex = canvasTex(16, 256, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#04020a'); gr.addColorStop(0.4, '#120926'); gr.addColorStop(0.5, '#3a1240'); gr.addColorStop(0.56, '#1a0d2a'); gr.addColorStop(1, '#0d0816'); g.fillStyle = gr; g.fillRect(0, 0, w, h); });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(190, 24, 16), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10; scene.add(sky);
  const stp = []; for (let i = 0; i < 360; i++) { const a = rand(0, TAU), el = rand(0.15, 1.3), r = 180; stp.push(Math.cos(a) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(a) * Math.cos(el) * r); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(stp, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcfc4ff, size: 1.3, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.7, depthWrite: false })));
  const moonTex = canvasTex(256, 256, (g) => { const gr = g.createRadialGradient(128, 128, 30, 128, 128, 128); gr.addColorStop(0, 'rgba(255,240,250,1)'); gr.addColorStop(0.42, 'rgba(255,200,235,.95)'); gr.addColorStop(0.47, 'rgba(255,120,200,.35)'); gr.addColorStop(1, 'rgba(255,42,138,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); });
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, fog: false, depthWrite: false, transparent: true, color: new THREE.Color(1.3, 1.2, 1.3), toneMapped: false }));
  moon.position.set(70, 75, -150); moon.scale.set(40, 40, 1); moon.renderOrder = -9; scene.add(moon);

  // distant skyline
  const skyWin = winTex.clone(); skyWin.wrapS = skyWin.wrapT = THREE.RepeatWrapping; skyWin.repeat.set(3, 9); skyWin.needsUpdate = true;
  const skyMat = basic(0xb8b0d0, { map: skyWin });
  for (let i = 0; i < 52; i++) {
    const a = rand(0, TAU), r = rand(62, 135), w = rand(8, 20), h = rand(25, 95), x = Math.cos(a) * r, z = Math.sin(a) * r;
    sbox(w, h, w * rand(0.7, 1.3), skyMat, x, h / 2, z, rand(0, 1.5), 0, 0, 0);
    if (R() < 0.45) sbox(w + 0.4, 0.5, w + 0.4, M.neonM[Math.floor(R() * NEON.length)], x, h, z, 0, 0, 0, 0);
  }
  const tx0 = -30, tz0 = -100;
  sbox(18, 140, 18, skyMat, tx0, 70, tz0, 0.3, 0, 0, 0);
  for (let k = 0; k < 6; k++) sbox(18.8, 0.7, 18.8, M.neonM[k % NEON.length], tx0, 20 + k * 22, tz0, 0.3, 0, 0, 0);
  scyl(0.5, 2, 28, 8, M.metal, tx0, 154, tz0, 0, 0, 0, 0);
  ssph(1.6, blinkMat, tx0, 169, tz0, 1, 0);

  // sidewalk ring
  for (const [x, z, w, d] of [[0, -A - 0.75, A * 2 + 3, 1.1], [0, A + 0.75, A * 2 + 3, 1.1], [-A - 0.75, 0, 1.1, A * 2 + 0.8], [A + 0.75, 0, 1.1, A * 2 + 0.8]]) sbox(w, 0.16, d, M.concrete2, x, 0.08, z, 0, 0, 0, 0.02);

  // facades
  for (const fc of FACADES) {
    const { sx, sz, a, w, h } = fc;
    if (Math.abs(a) > A + 8) continue;
    const nx = -sx, nz = -sz;
    const ry = sz === -1 ? 0 : sz === 1 ? Math.PI : sx === -1 ? Math.PI / 2 : -Math.PI / 2;
    const P = (al, out) => sz ? [al, sz * (A + 1) + nz * out] : [sx * (A + 1) + nx * out, al];
    let x, z;
    const ci = Math.floor(R() * NEON.length);
    [x, z] = P(a, 0.06); sbox(w * 0.62, 1.9, 0.08, M.neonDim[ci], x, 1.25, z, ry, 0, 0, 0);
    [x, z] = P(a, 0.12); sbox(w * 0.68, 0.18, 0.16, M.darkM, x, 2.28, z, ry, 0, 0, 0.02);
    for (let i = 0; i < 4; i++) { [x, z] = P(a, 0.12); sbox(w * 0.62, 0.05, 0.04, M.darkM, x, 0.55 + i * 0.42, z, ry, 0, 0, 0); }
    [x, z] = P(a, 0.72); sbox(w * 0.74, 0.1, 1.45, M.awn[Math.floor(R() * M.awn.length)], x, 2.8, z, ry, 0.22, 0, 0.04);
    [x, z] = P(a + (R() - 0.5) * w * 0.3, 0.12); sbox(Math.min(3.5, w * 0.4), 0.6, 0.12, M.neonM[(ci + 2) % NEON.length], x, 3.5, z, ry, 0, 0, 0.03);
    const nAC = 2 + Math.floor(R() * 5);
    for (let i = 0; i < nAC; i++) {
      const al = a + (R() - 0.5) * (w - 1.6), y = 4.6 + R() * (h - 7);
      [x, z] = P(al, 0.3); sbox(0.9, 0.6, 0.55, M.metal, x, y, z, ry, 0, 0, 0.03);
      [x, z] = P(al, 0.58); scyl(0.22, 0.22, 0.03, 12, M.darkM, x, y, z, ry, Math.PI / 2, 0, 0);
    }
    const nB = Math.floor(R() * 3);
    for (let i = 0; i < nB; i++) {
      const al = a + (R() - 0.5) * Math.max(0, w - 3), y = 6 + Math.floor(R() * Math.max(1, (h - 9) / 3)) * 3;
      [x, z] = P(al, 0.5); sbox(2.4, 0.12, 1.0, M.concrete, x, y, z, ry, 0, 0, 0.03);
      [x, z] = P(al, 0.98); sbox(2.4, 0.5, 0.04, M.metal, x, y + 0.3, z, ry, 0, 0, 0.02);
      if (R() < 0.5) { [x, z] = P(al, 0.06); sbox(0.9, 1.6, 0.05, M.neonDim[(ci + 1) % NEON.length], x, y + 0.9, z, ry, 0, 0, 0); }
    }
    [x, z] = P(a - w / 2 + 0.5, 0.15); scyl(0.09, 0.09, h, 8, M.rust, x, h / 2, z, 0, 0, 0, 0.02);
    if (R() < 0.6) { [x, z] = P(a + w / 2 - 0.4, 0.1); sbox(0.14, h * 0.55, 0.14, M.neonM[Math.floor(R() * NEON.length)], x, h * 0.5, z, ry, 0, 0, 0); }
    if (R() < 0.5) { [x, z] = P(a, 0.08); sbox(w * 0.9, 0.12, 0.1, M.neonM[Math.floor(R() * NEON.length)], x, 3.9 + R() * 1.5, z, ry, 0, 0, 0); }
    const [rx0, rz0] = P(a, -3);
    if (R() < 0.55) { scyl(0.9, 0.9, 1.6, 12, M.rust, rx0, h + 1.7, rz0, 0, 0, 0, 0.04); for (const o of [-0.6, 0.6]) scyl(0.06, 0.06, 0.9, 6, M.metal, rx0 + o, h + 0.45, rz0, 0, 0, 0, 0.02); }
    if (R() < 0.6) { const ah = 3 + R() * 6; scyl(0.05, 0.08, ah, 6, M.metal, rx0 + 1.5, h + ah / 2, rz0 + 0.5, 0, 0, 0, 0.02); ssph(0.16, blinkMat, rx0 + 1.5, h + ah, rz0 + 0.5, 1, 0); }
    if (h > 22 && ADS.length < 4 && Math.abs(a) < A - 4 && R() < 0.6) {
      const ads = [['ネオ酒', 'NEO-SAKE 99', '#ff2a8a', '#3a0d52', '#f7e733'], ['電脳茶', 'CYBER TEE', '#2cf6ff', '#0d1a52', '#ff2a8a'], ['夢見', 'DREAM OS', '#f7e733', '#5a1240', '#2cf6ff'], ['金龍', 'GOLD RYU', '#ff6a3d', '#2a0d3a', '#fff6e0']][ADS.length];
      const t = adTex(...ads); t.wrapT = THREE.RepeatWrapping; ADS.push(t);
      const ad = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 11), basic(new THREE.Color(1.5, 1.5, 1.5), { map: t, toneMapped: false }));
      const ay = Math.min(h * 0.55 + 2, 17);
      [x, z] = P(a, 0.2); ad.position.set(x, ay, z); ad.rotation.y = ry; scene.add(ad);
      [x, z] = P(a, 0.12); sbox(5.9, 11.4, 0.12, M.darkM, x, ay, z, ry, 0, 0, 0.03);
    }
  }

  // skywalks
  const wl = A * 2 + 4;
  sbox(wl, 0.45, 2.6, M.concrete, 0, 11, -6, 0, 0, 0, 0.05);
  for (const o of [-1.3, 1.3]) { sbox(wl, 0.08, 0.1, M.neonM[o < 0 ? 0 : 1], 0, 10.74, -6 + o, 0, 0, 0, 0); sbox(wl, 0.08, 0.06, M.metal, 0, 12.1, -6 + o, 0, 0, 0, 0.02); }
  for (let x = -A; x <= A; x += 3) for (const o of [-1.25, 1.25]) sbox(0.08, 0.9, 0.08, M.metal, x, 11.65, -6 + o, 0, 0, 0, 0.015);
  sbox(2.6, 0.45, wl, M.concrete, 10, 15, 0, 0, 0, 0, 0.05);
  for (const o of [-1.3, 1.3]) { sbox(0.1, 0.08, wl, M.neonM[o < 0 ? 2 : 4], 10 + o, 14.74, 0, 0, 0, 0, 0); sbox(0.06, 0.08, wl, M.metal, 10 + o, 16.1, 0, 0, 0, 0, 0.02); }
  for (let z = -A; z <= A; z += 3) for (const o of [-1.25, 1.25]) sbox(0.08, 0.9, 0.08, M.metal, 10 + o, 15.65, z, 0, 0, 0, 0.015);
  for (const [x, txt, col] of [[-14, 'ラーメン', '#FF2A8A'], [-2, '電脳', '#2CF6FF'], [16, '夜市', '#F7E733']]) {
    const sgn = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.95 * [...txt].length + 0.5), flickerMat(basic(new THREE.Color(2, 2, 2), { map: signTex(txt, col, true), toneMapped: false, side: THREE.DoubleSide })));
    sgn.position.set(x, 10.75 - (0.95 * [...txt].length + 0.5) / 2, -6); scene.add(sgn);
  }

  // street lamps
  const glowTex = canvasTex(128, 128, (g) => { const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); });
  const coneMat = basic(new THREE.Color(1, 0.7, 0.45), { transparent: true, opacity: 0.025, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const poolMat = basic(new THREE.Color(1, 0.7, 0.45), { map: glowTex, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const lampHead = neon(0xffd89a, 3);
  for (const [x, z, s] of [[-5, -10, 1], [5, 10, -1], [-12.5, -2, 1], [12.5, 2, -1], [-5, 14, 1], [5, -14, -1], [-20, -11.5, 1], [20, 11.5, -1]]) {
    scyl(0.08, 0.12, 5.2, 8, M.darkM, x, 2.6, z, 0, 0, 0, 0.03);
    sbox(1.2, 0.1, 0.1, M.darkM, x + s * 0.5, 5.15, z, 0, 0, 0, 0.03);
    sbox(0.5, 0.12, 0.3, lampHead, x + s * 1.0, 5.05, z, 0, 0, 0, 0.02);
    addBatch(coneMat, new THREE.ConeGeometry(1.7, 5, 20, 1, true), x + s * 1.0, 2.5, z);
    addBatch(poolMat, new THREE.CircleGeometry(2, 24), x + s * 1.0, 0.025, z, 0, -Math.PI / 2);
    OBST.push({ x0: x - 0.15, x1: x + 0.15, z0: z - 0.15, z1: z + 0.15, h: 5.2 });
  }

  // manholes with steam
  for (const [x, z] of [[-8, -3], [7, 4], [-2, 15], [14, -14], [-15, 12]]) {
    scyl(0.62, 0.62, 0.04, 16, M.darkM, x, 0.02, z, 0, 0, 0, 0.02);
    scyl(0.46, 0.46, 0.05, 16, M.metal, x, 0.03, z, 0, 0, 0, 0);
    STEAM.push([x, 0.15, z]);
  }
  // traffic cones
  for (const [x, z] of [[-13, 8.5], [-12.4, 9.6], [13, -8.5], [12.2, -9.6], [-2.6, -20.5], [2.6, 20.5]]) {
    sbox(0.42, 0.05, 0.42, M.orange, x, 0.025, z, 0.4, 0, 0, 0.02);
    scyl(0.04, 0.22, 0.6, 10, M.orange, x, 0.33, z, 0, 0, 0, 0.03);
    scyl(0.12, 0.15, 0.09, 10, M.white, x, 0.38, z, 0, 0, 0, 0);
  }
  // trash and boxes on the sidewalk
  for (let i = 0; i < 34; i++) {
    const side = Math.floor(R() * 4), al = (R() - 0.5) * (A * 2 - 2), out = A + 0.45 + R() * 0.5;
    const x = side === 0 ? al : side === 1 ? out : side === 2 ? al : -out, z = side === 0 ? -out : side === 1 ? al : side === 2 ? out : al;
    if (R() < 0.6) ssph(0.28 + R() * 0.18, M.bag, x, 0.28, z, 0.8, 0.03);
    else { const hb = 0.4 + R() * 0.3; sbox(0.55, hb, 0.55, M.card, x, 0.16 + hb / 2, z, R() * 2, 0, 0, 0.03); }
  }
  // motorbikes
  [[-21.5, 2, 0.3], [21.5, -1, -0.2], [8, 22.2, Math.PI / 2]].forEach(([x, z, ry], i) => {
    const c = Math.cos(ry), sn = Math.sin(ry), P2 = (lx, ly) => [x + c * lx, ly, z - sn * lx];
    const col = [toon(C.m), toon(C.c), toon(0xd8243a)][i];
    let q = P2(0, 0.62); sbox(1.5, 0.32, 0.34, col, q[0], q[1], q[2], ry, 0, 0, 0.03);
    q = P2(-0.2, 0.84); sbox(0.7, 0.12, 0.3, M.darkM, q[0], q[1], q[2], ry, 0, 0, 0.02);
    for (const lx of [-0.62, 0.66]) { q = P2(lx, 0.34); scyl(0.32, 0.32, 0.16, 14, M.darkM, q[0], q[1], q[2], ry, Math.PI / 2, 0, 0.03); }
    q = P2(0.75, 0.86); sbox(0.08, 0.5, 0.5, M.metal, q[0], q[1], q[2], ry, 0, 0.3, 0.02);
    q = P2(0.9, 0.95); sbox(0.06, 0.14, 0.22, lampHead, q[0], q[1], q[2], ry, 0, 0, 0);
    q = P2(0, 0.42); sbox(1.2, 0.04, 0.3, M.neonM[i], q[0], q[1], q[2], ry, 0, 0, 0);
    OBST.push({ x0: x - 0.85, x1: x + 0.85, z0: z - 0.85, z1: z + 0.85, h: 1.0 });
  });
  // stall dressing
  for (const st of STALLS) {
    const fx = Math.sin(st.rot), fz = Math.cos(st.rot), lx0 = Math.cos(st.rot), lz0 = -Math.sin(st.rot);
    const L = (lx, lz) => [st.x + lx0 * lx + fx * lz, st.z + lz0 * lx + fz * lz];
    let x, z;
    for (const lx of [-1.05, 1.05]) { [x, z] = L(lx, 1.2); scyl(0.17, 0.17, 0.42, 10, paper[(st.si + (lx > 0 ? 1 : 0)) % 3], x, 2.0, z, 0, 0, 0, 0.02); scyl(0.12, 0.12, 0.06, 10, M.darkM, x, 2.24, z, 0, 0, 0, 0); scyl(0.12, 0.12, 0.06, 10, M.darkM, x, 1.76, z, 0, 0, 0, 0); }
    for (let i = 0; i < 9; i++) { [x, z] = L(-1.8 + i * 0.45, 1.36); ssph(0.055, bulb, x, 2.66 - Math.sin(i / 8 * Math.PI) * 0.12, z, 1, 0); }
    for (const lx of [-0.8, 0.8]) { [x, z] = L(lx, 1.5); scyl(0.22, 0.22, 0.07, 12, M.stool, x, 0.62, z, 0, 0, 0, 0.02); scyl(0.04, 0.04, 0.6, 6, M.metal, x, 0.3, z, 0, 0, 0, 0.015); }
    if (st.si % 3 === 0) { [x, z] = L(-0.8, 0); scyl(0.28, 0.25, 0.35, 12, M.metal, x, 1.55, z, 0, 0, 0, 0.03); STEAM.push([x, 1.8, z]); [x, z] = L(0.6, 0); scyl(0.22, 0.2, 0.3, 12, M.metal, x, 1.52, z, 0, 0, 0, 0.03); }
    [x, z] = L((R() - 0.5) * 2, -1.25); sbox(0.55, 0.45, 0.55, M.card, x, 0.225, z, R(), 0, 0, 0.03);
    [x, z] = L(1.75, 0.1); sbox(0.06, 0.9, 0.7, M.darkM, x, 1.75, z, st.rot, 0, 0, 0.02);
  }

  // elevated highway with traffic
  const hwY = 24, hwZ = 11;
  sbox(220, 0.9, 7, M.concrete, 0, hwY, hwZ, 0, 0, 0, 0.06);
  for (const o of [-3.4, 3.4]) { sbox(220, 0.7, 0.3, M.concrete2, 0, hwY + 0.8, hwZ + o, 0, 0, 0, 0.03); sbox(220, 0.12, 0.12, M.neonM[o < 0 ? 1 : 0], 0, hwY - 0.5, hwZ + o, 0, 0, 0, 0); }
  for (const x of [-64, -38, 38, 64]) sbox(2.2, hwY, 2.2, M.concrete, x, hwY / 2, hwZ, 0, 0, 0, 0.05);
  const NC = 70, carIM = new THREE.InstancedMesh(box(1.1, 0.3, 0.5), neon(0xffffff, 1), NC), cc = new THREE.Color();
  HW = { im: carIM, cars: [] };
  for (let i = 0; i < NC; i++) { const lane = i % 2; HW.cars.push({ x: rand(-110, 110), z: hwZ + (lane ? 1.7 : -1.7), v: rand(16, 28) * (lane ? 1 : -1) }); carIM.setColorAt(i, cc.set(lane ? '#ffe2b8' : '#ff3d3d').multiplyScalar(2.6)); }
  scene.add(carIM);
  // giant anime hologram over the market
  const faceTex = canvasTex(512, 680, (g, w, h) => {
    g.translate(w / 2, h * 0.44); g.lineCap = 'round'; g.lineJoin = 'round';
    g.shadowBlur = 16; g.shadowColor = '#2cf6ff'; g.strokeStyle = '#2cf6ff'; g.lineWidth = 7;
    for (let i = 0; i < 6; i++) { const sx = i < 3 ? -1 : 1, k = i % 3; g.beginPath(); g.moveTo(sx * (120 + k * 25), -180 + k * 20); g.bezierCurveTo(sx * (190 + k * 30), -60, sx * (175 + k * 25), 120, sx * (150 + k * 40), 300); g.stroke(); }
    g.beginPath(); g.moveTo(-150, -40); g.bezierCurveTo(-200, -260, 200, -260, 150, -40); g.stroke();
    g.beginPath(); g.moveTo(-125, -50); g.bezierCurveTo(-135, 100, -60, 185, 0, 210); g.bezierCurveTo(60, 185, 135, 100, 125, -50); g.stroke();
    g.beginPath(); g.moveTo(-150, -60); for (let k = 0; k < 9; k++) g.lineTo(-150 + k * 37.5 + 18, -60 + (k % 2 ? -70 : 15)); g.lineTo(150, -60); g.stroke();
    for (const sx of [-1, 1]) {
      g.lineWidth = 6; g.beginPath(); g.ellipse(sx * 56, 18, 42, 24, sx * -0.1, 0, TAU); g.stroke();
      g.shadowColor = '#ff2a8a'; g.fillStyle = '#ff2a8a'; g.beginPath(); g.arc(sx * 52, 22, 17, 0, TAU); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(sx * 46, 14, 6, 0, TAU); g.fill();
      g.shadowColor = '#2cf6ff'; g.lineWidth = 10; g.beginPath(); g.moveTo(sx * 18, 2); g.quadraticCurveTo(sx * 56, -22, sx * 100, 8); g.stroke();
    }
    g.lineWidth = 5; g.beginPath(); g.moveTo(4, 70); g.lineTo(12, 100); g.stroke();
    g.shadowColor = '#ff2a8a'; g.strokeStyle = '#ff2a8a'; g.lineWidth = 8; g.beginPath(); g.moveTo(-34, 140); g.quadraticCurveTo(0, 125, 34, 140); g.quadraticCurveTo(0, 162, -34, 140); g.stroke();
    g.shadowColor = '#f7e733'; g.fillStyle = '#f7e733'; g.font = `900 58px ${FJ}`; g.textAlign = 'center'; g.fillText('ドリームOS', 0, 300);
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-out'; g.fillStyle = 'rgba(0,0,0,.45)'; for (let y = 0; y < h; y += 5) g.fillRect(0, y, w, 2);
  });
  const hf = new THREE.Sprite(new THREE.SpriteMaterial({ map: faceTex, color: new THREE.Color(1.5, 1.5, 1.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  hf.position.set(-9, 38, -15); hf.scale.set(22, 29, 1); scene.add(hf); BIGHOLO.push(hf);
  const vtTex = canvasTex(128, 640, (g, w, h) => { g.shadowBlur = 14; g.shadowColor = '#f7e733'; g.fillStyle = '#f7e733'; g.font = `900 92px ${FJ}`; g.textAlign = 'center'; [...'ナイトシティ'].forEach((c, k) => g.fillText(c, w / 2, 96 + k * 98)); });
  const vt = new THREE.Sprite(new THREE.SpriteMaterial({ map: vtTex, color: new THREE.Color(1.6, 1.4, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  vt.position.set(15, 30, 4); vt.scale.set(4.2, 21, 1); scene.add(vt); BIGHOLO.push(vt);
  // searchlights
  for (let i = 0; i < 5; i++) {
    const geo = new THREE.ConeGeometry(5, 110, 18, 1, true); geo.translate(0, 55, 0);
    const m = new THREE.Mesh(geo, basic(new THREE.Color(0.55, 0.65, 1.0), { transparent: true, opacity: 0.04, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    const a = i / 5 * TAU + 0.4; m.position.set(Math.cos(a) * 34, 55, Math.sin(a) * 34); m.rotation.order = 'YXZ'; scene.add(m); SEARCH.push({ m, ph: rand(0, TAU) });
  }

  // cable web
  const wpts = [];
  for (let i = 0; i < 28; i++) {
    let a, b; const y1 = rand(5, 14), y2 = rand(5, 14);
    if (i % 2) { const z1 = rand(-A, A); a = [-A - 1, y1, z1]; b = [A + 1, y2, z1 + rand(-8, 8)]; }
    else { const x1 = rand(-A, A); a = [x1, y1, -A - 1]; b = [x1 + rand(-8, 8), y2, A + 1]; }
    const sag = rand(0.8, 2.6);
    for (let k = 0; k < 16; k++) for (const tt of [k / 16, (k + 1) / 16]) wpts.push(a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt - Math.sin(tt * Math.PI) * sag, a[2] + (b[2] - a[2]) * tt);
  }
  const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wpts, 3));
  scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x07050c })));
  // hanging cloth banners
  for (let i = 0; i < 9; i++) {
    const txt = SIGNS[(i * 3 + 1) % SIGNS.length], col = NEON[i % NEON.length], red = i % 2 === 1;
    const tex = canvasTex(128, 384, (g) => { g.fillStyle = red ? '#c8203a' : '#120b1b'; g.fillRect(0, 0, 128, 384); g.strokeStyle = col; g.lineWidth = 6; g.strokeRect(8, 8, 112, 368); g.fillStyle = red ? '#fff6e0' : col; g.font = `900 78px ${FJ}`; g.textAlign = 'center'; g.textBaseline = 'middle'; [...txt].slice(0, 3).forEach((c, k) => g.fillText(c, 64, 82 + k * 110)); });
    const geo = new THREE.PlaneGeometry(1.1, 3.2); geo.translate(0, -1.6, 0);
    const m = new THREE.Mesh(geo, toon(0xffffff, { map: tex, side: THREE.DoubleSide }));
    m.position.set(rand(-17, 17), rand(8, 9.5), rand(-16, 16)); m.rotation.order = 'YXZ'; m.rotation.y = rand(0, TAU);
    scene.add(m); BANNERS.push(m);
  }
}

/** Builds the whole static night market, registers obstacles and merges batches. */
function buildWorld() {
  scene.add(new THREE.AmbientLight(0x8a6ac0, 0.95));
  moonLight = new THREE.DirectionalLight(0xa8d8ff, 2.2); moonLight.position.set(-18, 40, 16);
  { const sc = moonLight.shadow.camera; sc.left = -32; sc.right = 32; sc.top = 32; sc.bottom = -32; sc.near = 5; sc.far = 100; }
  moonLight.shadow.bias = -0.0008; moonLight.shadow.normalBias = 0.03; moonLight.shadow.mapSize.set(2048, 2048);
  scene.add(moonLight);
  const rim = new THREE.DirectionalLight(0xff3d9a, 0.9); rim.position.set(16, 10, -20); scene.add(rim);
  const PL = [[-13, 0, C.m], [13, 0, C.c], [0, -12, C.y], [0, 12, C.m], [-13, -12, C.c], [13, 12, 0xff6a3d], [0, 0, 0x9a6bff]];
  PL.forEach(([x, z, col]) => { const l = new THREE.PointLight(col, 40, 18, 1.4); l.position.set(x, 3.4, z); scene.add(l); });

  const R = seeded(11);
  const groundTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#120b1b'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { g.fillStyle = `hsl(${262 + R() * 20},22%,${14 + R() * 7}%)`; g.fillRect(x * 64 + 2, y * 64 + 2, 60, 60); }
    g.globalAlpha = 0.18;
    for (let i = 0; i < 60; i++) { g.fillStyle = R() < 0.5 ? '#ff2a8a' : '#2cf6ff'; g.fillRect(R() * w, R() * h, 10 + R() * 60, 2); }
    g.globalAlpha = 1;
  }, [14, 14]);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(A * 2 + 40, A * 2 + 40), toon(0xffffff, { map: groundTex }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const pudTex = canvasTex(128, 128, (g) => { const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(0.6, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); });
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basic(new THREE.Color(NEON[i % NEON.length]), { map: pudTex, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.rotation.x = -Math.PI / 2; m.position.set(rand(-A, A), 0.012, rand(-A, A)); const s = rand(2.5, 6); m.scale.set(s, s * rand(0.4, 0.8), 1); m.rotation.z = rand(0, TAU); scene.add(m);
  }
  const plaza = canvasTex(512, 512, (g) => {
    g.strokeStyle = 'rgba(247,231,51,.55)'; g.lineWidth = 10; g.beginPath(); g.arc(256, 256, 230, 0, TAU); g.stroke();
    g.lineWidth = 4; g.beginPath(); g.arc(256, 256, 200, 0, TAU); g.stroke();
    g.font = `900 200px ${FJ}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 5; g.strokeText('夜市', 256, 266);
  });
  const pz = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), basic(0xffffff, { map: plaza, transparent: true, opacity: 0.6, depthWrite: false }));
  pz.rotation.x = -Math.PI / 2; pz.position.y = 0.02; scene.add(pz);
  const edgeMat = toon(0xffffff, { map: hazardTex });
  [[0, -A - 0.2, A * 2 + 0.8, 0.4], [0, A + 0.2, A * 2 + 0.8, 0.4], [-A - 0.2, 0, 0.4, A * 2 + 0.8], [A + 0.2, 0, 0.4, A * 2 + 0.8]].forEach(([x, z, w, d]) => part(scene, box(w, 0.5, d), edgeMat, x, 0.25, z, 0.03));

  const winTex = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#0c0814'; g.fillRect(0, 0, w, h);
    for (let y = 12; y < h; y += 40) for (let x = 10; x < w; x += 32) {
      const lit = R() < 0.24; g.fillStyle = lit ? ['#ffd36b', '#2cf6ff', '#ff2a8a', '#9a7cff'][Math.floor(R() * 4)] : '#18111f';
      g.globalAlpha = lit ? 0.22 + R() * 0.4 : 1; g.fillRect(x, y, 18, 24);
    }
    g.globalAlpha = 1;
  });
  [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([sx, sz]) => {
    let t = -A - 8;
    while (t < A + 8) {
      const w = rand(6, 11), h = rand(40, 125), d = 8;
      const cx = sx ? sx * (A + 1 + d / 2) : t + w / 2, cz = sz ? sz * (A + 1 + d / 2) : t + w / 2;
      const bw = sx ? d : w, bd = sx ? w : d;
      const tex = winTex.clone(); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 12))); tex.needsUpdate = true;
      const b = new THREE.Mesh(box(bw, h, bd), basic(0xffffff, { map: tex })); b.position.set(cx, h / 2, cz); scene.add(b); FACADES.push({ sx, sz, a: t + w / 2, w, h });
      const roof = new THREE.Mesh(box(bw + 0.2, 0.25, bd + 0.2), neon(NEON[Math.floor(R() * NEON.length)], 1.8)); roof.position.set(cx, h, cz); scene.add(roof);
      if (R() < 0.75) {
        const col = NEON[Math.floor(R() * NEON.length)], txt = SIGNS[Math.floor(R() * SIGNS.length)];
        const vert = R() < 0.6, tx = signTex(txt, col, vert);
        const sw = vert ? 1.4 : Math.min(w - 1, 1.2 * [...txt].length + 0.6), sh = vert ? 1.15 * [...txt].length + 0.6 : 1.5;
        const s = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), flickerMat(basic(new THREE.Color(2.2, 2.2, 2.2), { map: tx, toneMapped: false })));
        if (sx) { s.position.set(sx * (A + 0.9), rand(4.5, 8), cz + rand(-w / 4, w / 4)); s.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2; }
        else { s.position.set(cx + rand(-w / 4, w / 4), rand(4.5, 8), sz * (A + 0.9)); s.rotation.y = sz > 0 ? Math.PI : 0; }
        scene.add(s);
      }
      const nS = 3 + Math.floor(R() * 4);
      for (let k = 0; k < nS; k++) {
        const col2 = NEON[Math.floor(R() * NEON.length)], txt2 = SIGNS[Math.floor(R() * SIGNS.length)], vert2 = R() < 0.75, perp = vert2 && R() < 0.5;
        const n2 = [...txt2].length, sw2 = vert2 ? 1.5 : 1.2 * n2 + 0.6, sh2 = vert2 ? 1.25 * n2 + 0.6 : 1.6, yy = 9 + R() * Math.min(55, h - 12);
        const s2 = new THREE.Mesh(new THREE.PlaneGeometry(sw2, sh2), signMat(txt2, col2, vert2));
        const al = (sx ? cz : cx) + rand(-w / 2.6, w / 2.6), out = perp ? sw2 / 2 + 0.25 : 0.12;
        if (sx) { s2.position.set(sx * (A + 1 - out), yy, al); s2.rotation.y = perp ? 0 : (sx > 0 ? -Math.PI / 2 : Math.PI / 2); }
        else { s2.position.set(al, yy, sz * (A + 1 - out)); s2.rotation.y = perp ? Math.PI / 2 : (sz > 0 ? Math.PI : 0); }
        scene.add(s2);
      }
      t += w + rand(0.2, 1.2);
    }
  });

  const wood = toon(0x3a2448), pole = toon(0x1b1426);
  const awn = ['#FF2A8A', '#2CF6FF', '#F7E733', '#ff6a3d'].map((c, i) => toon(0xffffff, { map: canvasTex(64, 64, (g) => { g.fillStyle = i === 1 ? '#0f2f3a' : '#fff6e0'; g.fillRect(0, 0, 64, 64); g.fillStyle = c; for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 8, 64); }, [3, 1]) }));
  const goods = [toon(C.y), toon(C.c), toon(C.m), toon(0x7dffb2), toon(0xff6a3d)];
  const lanternMat = neon(0xff3d3d, 2.6);
  let si = 0;
  for (const x of [-17, -9, 9, 17]) for (const z of [-16, -7, 7, 16]) {
    if (Math.abs(x) === 9 && Math.abs(z) === 7) continue;
    const rotated = Math.abs(x) === 17;
    const rot = rotated ? (x > 0 ? -Math.PI / 2 : Math.PI / 2) : (z > 0 ? Math.PI : 0);
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
    part(g, box(3.2, 1.3, 1.6), wood, 0, 0.65, 0, 0.05);
    part(g, box(3.3, 0.12, 1.7), pole, 0, 1.33, 0, 0.03);
    for (const px of [-1.5, 1.5]) for (const pzv of [-0.72, 0.72]) part(g, cyl(0.06, 0.06, 1.6), pole, px, 2.1, pzv, 0.03);
    const roof = part(g, box(3.8, 0.12, 2.3), awn[si % awn.length], 0, 2.95, 0.2, 0.05); roof.rotation.x = 0.16;
    for (let k = 0; k < 5; k++) part(g, k % 2 ? box(0.3, 0.3, 0.3) : sph(0.18, 10), goods[(si + k) % goods.length], -1.1 + k * 0.55, 1.55, rand(-0.3, 0.3), 0.03);
    const col = NEON[si % NEON.length], txt = SIGNS[(si * 5) % SIGNS.length];
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(3, 0.7 * [...txt].length + 0.4), 0.7), flickerMat(basic(new THREE.Color(2, 2, 2), { map: signTex(txt, col, false), toneMapped: false, side: THREE.DoubleSide })));
    sg.position.set(0, 2.45, 0.86); g.add(sg);
    for (const lx of [-1.6, 1.6]) { const l = part(g, sph(0.2, 10), lanternMat, lx, 2.45, 0.95, 0.03); l.scale.y = 1.25; }
    const hw = rotated ? 0.8 : 1.6, hd = rotated ? 1.6 : 0.8;
    OBST.push({ x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd, h: 1.4 });
    STALLS.push({ x, z, rot, si });
    si++;
  }
  const crateMat = toon(0x5a3a2a), crateMat2 = toon(0x2a4a5a);
  [[-4.5, -12], [4.5, 12], [-13, 4.5], [13, -4.5], [5.5, -3.6], [-5.5, 3.6]].forEach(([x, z], i) => {
    part(scene, box(1.3, 1.3, 1.3), i % 2 ? crateMat : crateMat2, x, 0.65, z, 0.05);
    if (i < 4) { const top = part(scene, box(1, 1, 1), i % 2 ? crateMat2 : crateMat, x + 0.1, 1.8, z - 0.1, 0.05); top.rotation.y = 0.4; }
    OBST.push({ x0: x - 0.65, x1: x + 0.65, z0: z - 0.65, z1: z + 0.65, h: i < 4 ? 2.3 : 1.3 });
  });

  // plaza hologram
  part(scene, cyl(1.1, 1.35, 0.5, 20), toon(0x1b1426), 0, 0.25, 0, 0.05);
  part(scene, cyl(0.85, 0.85, 0.08, 24), neon(C.c, 1.8), 0, 0.53, 0, 0.02);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 0.85, 7.5, 28, 1, true), basic(new THREE.Color(C.c).multiplyScalar(0.7), { transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  beam.position.y = 4.3; scene.add(beam);
  const koiTex = canvasTex(512, 320, (g, w, h) => {
    g.translate(w / 2, h / 2 - 20); g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = '#ff7ac8'; g.fillStyle = 'rgba(255,42,138,.35)'; g.lineWidth = 7; g.shadowColor = '#ff2a8a'; g.shadowBlur = 22;
    g.beginPath(); g.moveTo(-170, 0); g.bezierCurveTo(-120, -80, 60, -90, 120, -10); g.bezierCurveTo(140, 10, 120, 30, 100, 35); g.bezierCurveTo(40, 70, -120, 60, -170, 0); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(110, 0); g.lineTo(200, -70); g.quadraticCurveTo(180, 0, 205, 70); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-40, -60); g.quadraticCurveTo(0, -120, 40, -70); g.stroke();
    g.beginPath(); g.moveTo(-60, 45); g.quadraticCurveTo(-40, 100, 0, 55); g.stroke();
    g.fillStyle = '#2cf6ff'; g.beginPath(); g.arc(-125, -10, 9, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 3; for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(-60 + i * 35, -5, 18, -1.2, 1.2); g.stroke(); }
    g.shadowBlur = 14; g.shadowColor = '#2cf6ff'; g.fillStyle = '#2cf6ff'; g.font = `900 54px ${FJ}`; g.textAlign = 'center'; g.fillText('金魚ドリーム', 0, 130);
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-out'; g.fillStyle = 'rgba(0,0,0,.35)'; for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1.5);
  });
  holo = new THREE.Sprite(new THREE.SpriteMaterial({ map: koiTex, color: new THREE.Color(1.8, 1.8, 1.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  holo.scale.set(6.4, 4, 1); holo.position.set(0, 4.6, 0); scene.add(holo);
  OBST.push({ x0: -1.3, x1: 1.3, z0: -1.3, z1: 1.3, h: 0.6 });

  // torii gates
  const red = toon(0xd8243a), blk = toon(0x14101c);
  for (const sz of [-1, 1]) {
    const z = sz * (A - 0.9);
    for (const sx of [-1, 1]) { part(scene, cyl(0.28, 0.34, 6.6, 12), red, sx * 3.3, 3.3, z, 0.05); part(scene, cyl(0.42, 0.42, 0.4, 12), blk, sx * 3.3, 0.2, z, 0.04); OBST.push({ x0: sx * 3.3 - 0.36, x1: sx * 3.3 + 0.36, z0: z - 0.36, z1: z + 0.36, h: 7 }); }
    part(scene, box(8.2, 0.32, 0.5), red, 0, 5.3, z, 0.05);
    part(scene, box(9.6, 0.42, 0.75), red, 0, 6.65, z, 0.06);
    part(scene, box(10.2, 0.2, 0.9), blk, 0, 6.95, z, 0.04);
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 1.5), flickerMat(basic(new THREE.Color(2.2, 2.2, 2.2), { map: signTex('夜市', '#F7E733', true), toneMapped: false, side: THREE.DoubleSide })));
    plaque.position.set(0, 6.0, z - sz * 0.3); scene.add(plaque);
  }

  // vending machines
  const vendTex = canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#0b0614'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#2cf6ff'; g.font = `900 22px ${FJ}`; g.textAlign = 'center'; g.fillText('ドリンク', w / 2, 30);
    const cols = ['#FF2A8A', '#F7E733', '#2CF6FF', '#7dffb2', '#ff6a3d'];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { g.fillStyle = cols[(r * 4 + c) % cols.length]; g.fillRect(12 + c * 28, 48 + r * 40, 18, 30); g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(14 + c * 28, 50 + r * 40, 4, 26); }
    g.fillStyle = '#ff2a8a'; g.fillRect(14, 214, 100, 22);
  });
  const vendMat = basic(new THREE.Color(1.7, 1.7, 1.7), { map: vendTex, toneMapped: false });
  [[-A + 0.6, -5, 1], [-A + 0.6, 9, 1], [A - 0.6, 5, -1], [A - 0.6, -10, -1]].forEach(([x, z, f], i) => {
    part(scene, box(0.9, 2.3, 1.2), toon(i % 2 ? 0xd8243a : 0x2a5aa8), x, 1.15, z, 0.05);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 2.0), vendMat); pl.position.set(x + f * 0.46, 1.2, z); pl.rotation.y = f > 0 ? Math.PI / 2 : -Math.PI / 2; scene.add(pl);
    OBST.push({ x0: x - 0.45, x1: x + 0.45, z0: z - 0.6, z1: z + 0.6, h: 2.3 });
  });

  // flying cars
  const carBody = [toon(0x1d1630), toon(0x2a2a40), toon(0x3a1530)];
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group();
    part(g, box(2.8, 0.55, 1.3), carBody[i % 3], 0, 0, 0, 0.06);
    part(g, box(1.5, 0.45, 1.1), carBody[(i + 1) % 3], -0.2, 0.45, 0, 0.05);
    part(g, box(0.06, 0.18, 1.0), neon(0xffffff, 2.6), 1.42, 0.02, 0, 0);
    part(g, box(0.06, 0.16, 1.1), neon(C.r, 3), -1.42, 0.05, 0, 0);
    part(g, box(2.4, 0.04, 1.0), neon(NEON[i % NEON.length], 2), 0, -0.3, 0, 0);
    const dir = i % 2 ? 1 : -1, alongX = i % 3 !== 0;
    if (alongX) g.position.set(rand(-80, 80), rand(12, 24), rand(-30, 30));
    else { g.rotation.y = -Math.PI / 2; g.position.set(rand(-30, 30), rand(14, 26), rand(-80, 80)); }
    if (dir < 0) g.rotation.y += Math.PI;
    scene.add(g); CARS.push({ g, v: rand(9, 18) * dir, alongX });
  }

  buildDetails(R, winTex);
  const strings = [];
  for (const z of [-11.5, -2.5, 2.5, 11.5]) strings.push([[-A - 1, 6.2, z], [A + 1, 6.2, z + rand(-2, 2)]]);
  for (const x of [-13, 13]) strings.push([[x, 6.6, -A - 1], [x + rand(-2, 2), 6.6, A + 1]]);
  const per = 16, lanIM = new THREE.InstancedMesh(sph(0.15, 10), neon(0xffffff, 2.4), strings.length * per);
  const wireMat = new THREE.LineBasicMaterial({ color: 0x07050c });
  const mtx = new THREE.Matrix4(), col = new THREE.Color(); let li = 0;
  strings.forEach(([a, b]) => {
    const pts = [];
    for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * 1.6, a[2] + (b[2] - a[2]) * t)); }
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
    for (let i = 1; i <= per; i++) {
      const t = i / (per + 1), p = new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * 1.6 - 0.25, a[2] + (b[2] - a[2]) * t);
      mtx.makeScale(1, 1.3, 1); mtx.setPosition(p); lanIM.setMatrixAt(li, mtx);
      lanIM.setColorAt(li, col.set(['#ff3d3d', '#F7E733', '#FF2A8A', '#ff8a3d'][i % 4])); li++;
    }
  });
  scene.add(lanIM);
  flushBatches();
}

/* ================= rain =================
 * Rain as pooled line segments that follow the camera, so only a box around
 * the viewer needs drops. The drop count is set by the quality preset.
 */
/** Maximum rain drops; `rainCount` is the active number from the quality preset. */
const RAIN_N = 1300; let rainCount = RAIN_N;
const rainPos = new Float32Array(RAIN_N * 6);
const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rainMat = new THREE.LineBasicMaterial({ color: 0xa8dcff, transparent: true, opacity: 0.32, depthWrite: false });
const rainLines = new THREE.LineSegments(rainGeo, rainMat); rainLines.frustumCulled = false; scene.add(rainLines);
const rainD = [];
for (let i = 0; i < RAIN_N; i++) rainD.push({ x: rand(-24, 24), y: rand(0, 16), z: rand(-24, 24), s: rand(18, 26) });
/** Moves drops and wraps them inside a 48 m box centred on (cx, cz). */
function updateRain(dt, cx, cz) {
  for (let i = 0; i < rainCount; i++) {
    const d = rainD[i]; d.y -= d.s * dt; d.x += 2.5 * dt;
    if (d.y < 0) { d.y = 16; d.x = rand(-24, 24); d.z = rand(-24, 24); }
    if (d.x > 24) d.x -= 48;
    const x = cx + d.x, z = cz + d.z, j = i * 6;
    rainPos[j] = x; rainPos[j + 1] = d.y; rainPos[j + 2] = z; rainPos[j + 3] = x - 0.12; rainPos[j + 4] = d.y + 0.55; rainPos[j + 5] = z;
  }
  rainGeo.attributes.position.needsUpdate = true;
}

/* ================= post-processing =================
 * Custom passes: `InkShader` draws depth-based outlines, `FXShader` adds
 * chromatic aberration, Overclock grading, hurt tint, vignette and grain.
 * `QUALITY` presets decide which passes, shadows and how much rain run.
 */
const InkShader = {
  uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.15 }, uFar: { value: 260 }, uThick: { value: 1.0 }, uStr: { value: 0.92 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform vec2 uRes; uniform float uNear; uniform float uFar; uniform float uThick; uniform float uStr; varying vec2 vUv;
    float invD(vec2 uv){ float z = texture2D(tDepth, uv).x * 2.0 - 1.0; float lin = (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); return 1.0 / lin; }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 o = uThick / uRes;
      float w0 = invD(vUv);
      float lap = abs(invD(vUv - vec2(o.x, 0.0)) + invD(vUv + vec2(o.x, 0.0)) - 2.0 * w0) + abs(invD(vUv + vec2(0.0, o.y)) + invD(vUv - vec2(0.0, o.y)) - 2.0 * w0);
      float e = lap / max(w0, 1e-6);
      float edge = smoothstep(0.035, 0.11, e);
      edge *= 1.0 - smoothstep(50.0, 140.0, 1.0 / max(w0, 1e-6)) * 0.55;
      c.rgb = mix(c.rgb, vec3(0.027, 0.02, 0.047), edge * uStr);
      gl_FragColor = c;
    }`
};
const FXShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uOC: { value: 0 }, uHurt: { value: 0 }, uAb: { value: 0.0025 }, uImpact: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform float uOC; uniform float uHurt; uniform float uAb; uniform float uImpact; varying vec2 vUv;
    float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 hueShift(vec3 c, float a){ vec3 k = vec3(0.57735); float ca = cos(a); return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca); }
    void main(){
      vec2 d = vUv - 0.5; float r = dot(d, d);
      float ab = uAb * (0.4 + r * 4.0) + uOC * 0.05 * r + uHurt * 0.012;
      vec3 col = vec3(texture2D(tDiffuse, vUv + d * ab).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d * ab).b);
      if (uOC > 0.001) {
        vec3 h = hueShift(col, uTime * 4.0 + r * 10.0);
        col = mix(col, h, uOC * smoothstep(0.04, 0.3, r));
        col *= 1.0 + 0.12 * uOC;
        col *= 1.0 - 0.08 * uOC * step(0.5, fract(gl_FragCoord.y * 0.33));
      }
      col *= mix(1.0, 0.5, smoothstep(0.12, 0.5, r));
      col = mix(col, vec3(1.0, 0.12, 0.2), uHurt * smoothstep(0.08, 0.45, r) * 0.7);
      float lumF = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lumF), col, 1.2);
      col = mix(col * vec3(0.88, 0.9, 1.15) + vec3(0.01, 0.0, 0.03), col * vec3(1.05, 1.0, 0.95), smoothstep(0.15, 0.7, lumF));
      if (uImpact > 0.0) { float t = step(0.38, lumF); col = mix(col, mix(vec3(0.03, 0.02, 0.05), vec3(1.0, 0.96, 0.86), t), uImpact); }
      col += (rnd(vUv * 731.0 + fract(uTime)) - 0.5) * 0.032;
      gl_FragColor = vec4(col, 1.0);
    }`
};
/** Quality presets (keys are the German labels shown in the menu). pr = max pixel ratio. */
const QUALITY = {
  ultra: { pr: 1.6, bloom: true, fx: true, ink: true, rain: 1300, shadow: 2048 },
  hoch: { pr: 1.4, bloom: true, fx: true, ink: true, rain: 1100, shadow: 1024 },
  mittel: { pr: 1.15, bloom: true, fx: true, ink: true, rain: 800, shadow: 0 },
  niedrig: { pr: 1, bloom: false, fx: false, ink: false, rain: 450, shadow: 0 }
};
let quality = store.get('chromefever3d-quality2', coarse ? 'mittel' : 'ultra'); if (!QUALITY[quality]) quality = 'ultra';
renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;
/** (Re)builds the post-processing chain and shadow settings for the current quality preset. */
function setupComposer() {
  const q = QUALITY[quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pr));
  renderer.setSize(cssW, cssH, false);
  if (composer) { composer.dispose(); composer = null; bloomPass = null; fxPass = null; inkPass = null; }
  if (q.bloom || q.fx || q.ink) {
    const rt = new THREE.WebGLRenderTarget(cssW, cssH, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(cssW, cssH) });
    composer = new EffectComposer(renderer, rt);
    composer.renderTarget2.depthTexture = new THREE.DepthTexture(cssW, cssH);
    composer.addPass(new RenderPass(scene, camera));
    if (q.ink) { inkPass = new ShaderPass(InkShader); inkPass.uniforms.tDepth.value = composer.renderTarget1.depthTexture; composer.addPass(inkPass); }
    if (q.bloom) { bloomPass = new UnrealBloomPass(new THREE.Vector2(cssW, cssH), 0.7, 0.35, 1.02); composer.addPass(bloomPass); }
    composer.addPass(new OutputPass());
    if (q.fx) { fxPass = new ShaderPass(FXShader); composer.addPass(fxPass); }
    composer.setSize(cssW, cssH);
  }
  const wantShadow = q.shadow > 0 && !!moonLight;
  if (moonLight && (renderer.shadowMap.enabled !== wantShadow || (wantShadow && moonLight.shadow.mapSize.x !== q.shadow))) {
    renderer.shadowMap.enabled = wantShadow; moonLight.castShadow = wantShadow;
    if (wantShadow) { moonLight.shadow.mapSize.set(q.shadow, q.shadow); if (moonLight.shadow.map) { moonLight.shadow.map.dispose(); moonLight.shadow.map = null; } }
    scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
  }
  rainCount = q.rain; rainGeo.setDrawRange(0, rainCount * 2);
}

/* ================= particles =================
 * Pooled GPU particles (sparks, bursts) plus sprite stars and ground rings.
 * Each pool is a ring buffer: the oldest slot is reused when full.
 */
const PN = 1000;
const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3), pBase = new Float32Array(PN * 3), pVel = new Float32Array(PN * 3), pLife = new Float32Array(PN), pMax = new Float32Array(PN), pGrav = new Float32Array(PN);
for (let i = 0; i < PN; i++) pPos[i * 3 + 1] = -999;
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3)); pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const pMat = new THREE.PointsMaterial({ size: 0.22, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const points = new THREE.Points(pGeo, pMat); points.frustumCulled = false; scene.add(points);
let pCursor = 0; const tmpCol = new THREE.Color();
/**
 * Spawns one particle from the ring buffer.
 * @param {number} life - seconds
 * @param {number} hex - colour
 * @param {number} [grav=9] - downward acceleration
 * @param {number} [k=2.2] - HDR brightness multiplier (drives bloom)
 */
function emit(x, y, z, vx, vy, vz, life, hex, grav = 9, k = 2.2) {
  const i = pCursor; pCursor = (pCursor + 1) % PN; const j = i * 3;
  pPos[j] = x; pPos[j + 1] = y; pPos[j + 2] = z; pVel[j] = vx; pVel[j + 1] = vy; pVel[j + 2] = vz;
  tmpCol.setHex(hex); pBase[j] = tmpCol.r * k; pBase[j + 1] = tmpCol.g * k; pBase[j + 2] = tmpCol.b * k;
  pLife[i] = life; pMax[i] = life; pGrav[i] = grav;
}
/** Spawns `n` particles in random directions at up to `speed`. */
function burst(x, y, z, n, speed, hex, life = 0.5, grav = 9) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), u = rand(-0.3, 1), s = rand(0.3, 1) * speed, h = Math.sqrt(1 - u * u);
    emit(x, y, z, Math.cos(a) * h * s, u * s, Math.sin(a) * h * s, rand(life * 0.5, life), Math.random() < 0.4 ? C.y : hex, grav);
  }
}
/** Integrates particles and fades their colour over their lifetime. */
function updateParticles(dt) {
  const fr = Math.pow(0.08, dt);
  for (let i = 0; i < PN; i++) {
    if (pLife[i] <= 0) continue;
    const j = i * 3; pLife[i] -= dt;
    if (pLife[i] <= 0) { pPos[j + 1] = -999; continue; }
    pVel[j + 1] -= pGrav[i] * dt; pVel[j] *= fr; pVel[j + 2] *= fr;
    pPos[j] += pVel[j] * dt; pPos[j + 1] += pVel[j + 1] * dt; pPos[j + 2] += pVel[j + 2] * dt;
    if (pPos[j + 1] < 0.03) { pPos[j + 1] = 0.03; pVel[j + 1] *= -0.3; }
    const k = pLife[i] / pMax[i]; pCol[j] = pBase[j] * k; pCol[j + 1] = pBase[j + 1] * k; pCol[j + 2] = pBase[j + 2] * k;
  }
  pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
}
const starMat = new THREE.SpriteMaterial({ map: starTex, depthTest: false, transparent: true });
const stars = [];
for (let i = 0; i < 24; i++) { const s = new THREE.Sprite(starMat); s.visible = false; s.renderOrder = 10; scene.add(s); stars.push({ s, life: 0, max: 0.14, size: 1 }); }
let starIdx = 0;
/** Shows a pooled anime impact star sprite. */
function star(x, y, z, size) { const st = stars[starIdx]; starIdx = (starIdx + 1) % stars.length; st.s.position.set(x, y, z); st.life = st.max; st.size = size; st.s.visible = true; }
const rings = [];
for (let i = 0; i < 16; i++) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), basic(0xffffff, { transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m); rings.push({ m, life: 0, max: 0.4, r0: 0.2, r1: 3 });
}
let ringIdx = 0;
/** Shows a pooled expanding ground ring from radius r0 to r1. */
function ring(x, y, z, r0, r1, hex, life = 0.4) { const r = rings[ringIdx]; ringIdx = (ringIdx + 1) % rings.length; r.m.position.set(x, y, z); r.m.material.color.setHex(hex).multiplyScalar(2); r.life = r.max = life; r.r0 = r0; r.r1 = r1; r.m.visible = true; }
/** Ages stars, rings and the katana slash arc. */
function updateFxObjects(rdt, dt) {
  for (const st of stars) { if (!st.s.visible) continue; st.life -= rdt; if (st.life <= 0) { st.s.visible = false; continue; } const sc = st.size * (0.7 + (1 - st.life / st.max) * 0.6); st.s.scale.set(sc, sc, 1); }
  for (const r of rings) { if (!r.m.visible) continue; r.life -= dt; if (r.life <= 0) { r.m.visible = false; continue; } const k = r.life / r.max, s = r.r0 + (r.r1 - r.r0) * (1 - k * k); r.m.scale.set(s, s, s); r.m.material.opacity = k; }
}

/* ================= anime sprite characters (drawn in code) =================
 * Human characters are 2D sprites drawn with Canvas 2D at load time. `SPEC`
 * describes proportions and colours per character; `makeFrames()` renders
 * every animation frame once into textures; `animSprite()` picks the frame
 * for the current movement and action each tick.
 */
const INK = '#07050c';
const shadeHex = (hex, k) => { const c = new THREE.Color(hex); c.r *= k; c.g *= k; c.b *= k; return '#' + c.getHexString(); };
/** Canvas helpers for sprite drawing: tapered limbs, ink strokes and two-tone cel fills. */
function capPath(g, ax, ay, bx, by, w1, w2) {
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, a0 = Math.atan2(ny, nx);
  g.beginPath(); g.moveTo(ax + nx * w1, ay + ny * w1); g.lineTo(bx + nx * w2, by + ny * w2);
  g.arc(bx, by, w2, a0, a0 - Math.PI, true); g.lineTo(ax - nx * w1, ay - ny * w1); g.arc(ax, ay, w1, a0 + Math.PI, a0, true); g.closePath();
}
function inkStroke(g, lw) { g.lineWidth = lw; g.strokeStyle = INK; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke(); }
function fillShade(g, path, fill, shadow, split, lw) {
  path(); g.fillStyle = fill; g.fill();
  if (shadow) {
    g.save(); path(); g.clip(); g.fillStyle = shadow;
    if (typeof split === 'number') g.fillRect(split, -9999, 99999, 99999); else if (split) { split(); g.fill(); }
    g.restore();
  }
  if (lw) { path(); inkStroke(g, lw); }
}
const poly = (g, pts) => () => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); };
const ell = (g, x, y, rx, ry, rot = 0) => () => { g.beginPath(); g.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, TAU); };
function limb2(g, a, b, w1, w2, fill, shadow, lw) {
  w1 *= 1.45; w2 *= 1.45;
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; let nx = -dy / L, ny = dx / L; if (nx < 0) { nx = -nx; ny = -ny; }
  const ux = dx / L, uy = dy / L, k = Math.max(w1, w2);
  fillShade(g, () => capPath(g, a[0], a[1], b[0], b[1], w1, w2), fill, shadow, () => {
    g.beginPath(); g.moveTo(a[0] + nx * w1 * 0.25 - ux * k, a[1] + ny * w1 * 0.25 - uy * k); g.lineTo(b[0] + nx * w2 * 0.25 + ux * k, b[1] + ny * w2 * 0.25 + uy * k);
    g.lineTo(b[0] + nx * k * 3 + ux * k, b[1] + ny * k * 3 + uy * k); g.lineTo(a[0] + nx * k * 3 - ux * k, a[1] + ny * k * 3 - uy * k); g.closePath();
  }, lw);
}
function glowDot(g, x, y, r, col) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r * 2.2); gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.25, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 2.2, 0, TAU); g.fill();
}
function blade(g, hand, elbow, len, w, edge, lw) {
  const dx = hand[0] - elbow[0], dy = hand[1] - elbow[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const base = [hand[0] - ux * w * 0.6, hand[1] - uy * w * 0.6], tip = [hand[0] + ux * len, hand[1] + uy * len];
  fillShade(g, poly(g, [[base[0] + nx * w, base[1] + ny * w], [tip[0], tip[1]], [base[0] - nx * w * 0.5, base[1] - ny * w * 0.5]]), '#f4f8ff', '#9fb0d8', base[0], lw);
  g.save(); g.shadowColor = edge; g.shadowBlur = lw * 4; g.strokeStyle = edge; g.lineWidth = lw * 0.9;
  g.beginPath(); g.moveTo(base[0] + nx * w * 0.85, base[1] + ny * w * 0.85); g.lineTo(tip[0], tip[1]); g.stroke(); g.restore();
}
/** Draws anime eyes for the front view; `mood` changes the expression. */
function eyesFront(g, hx, hy, hs, S, lw, mood) {
  for (const i of [-1, 1]) {
    const ex = hx + i * hs * 0.42, ey = hy + hs * 0.14;
    if ((S.cyberEye && i < 0) || S.glowEyes) {
      g.fillStyle = INK; g.beginPath(); g.ellipse(ex, ey, hs * 0.24, hs * 0.13, i * -0.15, 0, TAU); g.fill();
      glowDot(g, ex, ey, hs * 0.11, S.eye);
    } else {
      const white = ell(g, ex, ey, hs * 0.25, hs * 0.16, i * -0.1);
      white(); g.fillStyle = '#fff6e0'; g.fill();
      g.save(); white(); g.clip();
      g.fillStyle = S.eye; g.beginPath(); g.ellipse(ex - i * hs * 0.03, ey + hs * 0.02, hs * 0.13, hs * 0.18, 0, 0, TAU); g.fill();
      g.fillStyle = shadeHex(S.eye, 0.45); g.fillRect(ex - hs * 0.3, ey - hs * 0.2, hs * 0.6, hs * 0.1);
      g.fillStyle = INK; g.beginPath(); g.ellipse(ex - i * hs * 0.03, ey + hs * 0.03, hs * 0.055, hs * 0.09, 0, 0, TAU); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(ex - hs * 0.07, ey - hs * 0.03, hs * 0.045, 0, TAU); g.fill();
      g.restore();
    }
    g.lineWidth = lw * 1.5; g.strokeStyle = INK; g.lineCap = 'round';
    g.beginPath(); g.moveTo(ex - i * hs * 0.27, ey - hs * 0.01); g.quadraticCurveTo(ex, ey - hs * 0.25, ex + i * hs * 0.33, ey - hs * 0.06); g.stroke();
    g.lineWidth = lw * 1.25; const dip = mood === 'angry' ? hs * 0.13 : mood === 'crazy' ? -hs * 0.06 : 0;
    g.beginPath(); g.moveTo(ex + i * hs * 0.3, ey - hs * 0.44); g.lineTo(ex - i * hs * 0.24, ey - hs * 0.37 + dip); g.stroke();
  }
}
function faceShape(g, hx, hy, hs) {
  return () => {
    g.beginPath(); g.moveTo(hx - hs, hy - hs * 0.15);
    g.bezierCurveTo(hx - hs * 1.02, hy - hs * 1.3, hx + hs * 1.02, hy - hs * 1.3, hx + hs, hy - hs * 0.15);
    g.bezierCurveTo(hx + hs * 0.95, hy + hs * 0.55, hx + hs * 0.42, hy + hs * 0.98, hx, hy + hs * 1.12);
    g.bezierCurveTo(hx - hs * 0.42, hy + hs * 0.98, hx - hs * 0.95, hy + hs * 0.55, hx - hs, hy - hs * 0.15); g.closePath();
  };
}
function spikyCap(g, hx, hy, hs, n, rIn, rOut, a0, a1, lowY) {
  const pts = [];
  for (let k = 0; k <= n; k++) { const a = a0 + (a1 - a0) * k / n, r = (k % 2 ? rIn : rOut) * hs; pts.push([hx + Math.cos(a) * r, hy + Math.sin(a) * r * 1.05]); }
  if (lowY !== undefined) { pts.push([hx + hs * 0.9, lowY]); pts.push([hx - hs * 0.9, lowY]); }
  return poly(g, pts);
}

/**
 * Sprite specs per character: canvas size (W, H), height in world units
 * (worldH), size factor, colours and proportions. Derived fields (ppu, u, cx,
 * gy) are filled in below.
 */
const SPEC = {
  merc:   { W: 200, H: 360, worldH: 2.3, sz: 1.0, skin: '#f6cba8', hair: '#ff2a8a', top: '#F7E733', pants: '#1c1530', shoe: '#e8f6ff', accent: '#2CF6FF', eye: '#2CF6FF', shW: 0.23, headS: 0.138 },
  ganger: { W: 170, H: 300, worldH: 2.25, sz: 1.0, skin: '#c8b4f0', hair: '#F7E733', top: '#FF2A8A', pants: '#241a34', shoe: '#2a2236', accent: '#2CF6FF', eye: '#FF3D3D', shW: 0.21, headS: 0.132, cyberEye: true },
  gunner: { W: 170, H: 300, worldH: 2.25, sz: 1.02, skin: '#e0b090', hair: '#221a30', top: '#e8323a', pants: '#221a30', shoe: '#120c1d', accent: '#F7E733', eye: '#F7E733', shW: 0.25, headS: 0.13 },
  brute:  { W: 240, H: 380, worldH: 3.05, sz: 1.42, skin: '#8a7aa8', hair: '#1b1426', top: '#6E35FF', pants: '#1b1426', shoe: '#120c1d', accent: '#F7E733', eye: '#FF3D3D', shW: 0.33, headS: 0.1, glowEyes: true },
  razor:  { W: 300, H: 470, worldH: 4.4, sz: 2.05, skin: '#efe4ff', hair: '#3a1a5a', top: '#FF2A8A', pants: '#170f22', shoe: '#120c1d', accent: '#fff6e0', eye: '#FF3D3D', shW: 0.2, headS: 0.12, glowEyes: true }
};
for (const k in SPEC) { const S = SPEC[k]; S.type = k; S.ppu = S.H / S.worldH; S.u = S.ppu * S.sz; S.cx = S.W / 2; S.gy = S.H - 5; }

/**
 * Draws one character pose into a canvas.
 * @param {CanvasRenderingContext2D} g
 * @param {object} S - entry from SPEC
 * @param {object} pose - phase, movement and action flags (aim, slash, hurt, air, ...)
 * @param {'front'|'back'|'side'} view - player is seen from the back, enemies from the front
 */
function drawChar(g, S, pose, view) {
  const u = S.u, cx = S.cx, gy = S.gy, T = S.type, ph = pose.ph || 0, mv = pose.move || 0;
  const sh = c => shadeHex(c, 0.56), lw = Math.max(2, u * 0.016);
  if (view === 'side') return drawSide(g, S, pose, lw);
  const crouch = pose.crouch || 0;
  const bob = -Math.abs(Math.sin(ph)) * 0.035 * u * mv + Math.sin(pose.breath || 0) * 0.006 * u + crouch * 0.13 * u;
  const hipY = gy - 0.95 * u + bob, shY = hipY - 0.5 * u + crouch * 0.03 * u, neckY = shY - 0.035 * u;
  const lean = (pose.lean || 0) * u, shW = S.shW * u, hs = S.headS * u;
  const tx = cx + lean, hx = cx + lean * 1.25, hy = neckY - hs * 1.02 + (pose.hurt ? 0.03 * u : 0);
  const back = view === 'back';

  // ---------- back hair / coat behind ----------
  if (T === 'razor') {
    fillShade(g, spikyCap(g, hx, hy + hs * 0.2, hs, 16, 1.5, 2.3, Math.PI * 0.75, Math.PI * 2.25), S.hair, sh(S.hair), hx + hs * 0.3, lw);
  }
  // ---------- legs ----------
  const legs = [];
  for (const i of [-1, 1]) {
    const lift = pose.air ? 0.5 : Math.max(0, Math.sin(ph + (i > 0 ? Math.PI : 0))) * mv;
    const sp = (pose.spread || 0) * u;
    const hip = [cx + i * 0.095 * u, hipY];
    const knee = [hip[0] + i * (0.018 * u + sp * 0.5), hipY + 0.45 * u * (1 - 0.34 * lift) - crouch * 0.05 * u];
    const ank = [knee[0] + i * sp * 0.6 - i * 0.008 * u, Math.min(gy - 0.04 * u, knee[1] + 0.43 * u * (1 - 0.62 * lift))];
    legs.push([hip, knee, ank]);
  }
  for (const [hip, knee, ank] of legs) {
    const pw = T === 'brute' ? 1.35 : 1;
    limb2(g, hip, knee, 0.08 * u * pw, 0.064 * u * pw, S.pants, sh(S.pants), lw);
    limb2(g, knee, ank, 0.063 * u * pw, 0.047 * u * pw, S.pants, sh(S.pants), lw);
    if (T === 'gunner' || T === 'brute') fillShade(g, ell(g, knee[0], knee[1], 0.06 * u * pw, 0.05 * u * pw), shadeHex(S.top, 0.8), sh(S.top), knee[0] + 0.01 * u, lw);
    fillShade(g, ell(g, ank[0], ank[1] + 0.03 * u, 0.078 * u * pw, 0.047 * u * pw), S.shoe, sh(S.shoe), ank[0] + 0.02 * u, lw);
    if (T === 'merc') { g.fillStyle = S.accent; g.fillRect(ank[0] - 0.065 * u, ank[1] + 0.058 * u, 0.13 * u, 0.012 * u); }
  }
  if (T === 'razor') {
    const hem = hipY + 0.42 * u, pts = [[tx - shW * 1.05, shY + 0.02 * u], [tx + shW * 1.05, shY + 0.02 * u], [cx + 0.2 * u, hem]];
    for (let k = 1; k < 8; k++) pts.push([cx + 0.2 * u - k * 0.4 * u / 8, hem + (k % 2 ? 0.08 * u : 0)]);
    pts.push([cx - 0.2 * u, hem]);
    fillShade(g, poly(g, pts), S.top, sh(S.top), tx + 0.03 * u, lw);
  }

  // ---------- arms behind the body (aiming forward from behind) ----------
  const armPose = (i) => {
    const s = [tx + i * shW * 0.9, shY + 0.035 * u];
    let el, hd;
    if (pose.armsUp) { el = [s[0] + i * 0.13 * u, s[1] - 0.19 * u]; hd = [el[0] + i * 0.03 * u, el[1] - 0.25 * u]; }
    else if (pose.strike) { el = [s[0] + i * 0.02 * u, s[1] + 0.2 * u]; hd = [cx - i * 0.07 * u, s[1] + 0.34 * u]; }
    else if (pose.aim && back) { el = [s[0] + i * 0.11 * u, s[1] + 0.13 * u]; hd = [cx + 0.06 * u, s[1] + 0.06 * u]; }
    else if (pose.aim) { el = [s[0] + i * 0.03 * u, s[1] + 0.18 * u]; hd = [cx + i * 0.04 * u, s[1] + 0.2 * u]; }
    else if (pose.slash === 1) { el = [s[0] - 0.05 * u, s[1] - 0.12 * u]; hd = [cx - 0.2 * u, s[1] - 0.22 * u]; }
    else if (pose.slash === 2) { el = [s[0] + i * 0.06 * u, s[1] + 0.2 * u]; hd = [cx + 0.24 * u, s[1] + 0.3 * u]; }
    else if (pose.dash) { el = [s[0] + i * 0.1 * u, s[1] + 0.22 * u]; hd = [el[0] + i * 0.12 * u, el[1] + 0.12 * u]; }
    else {
      const sw = Math.sin(ph + (i > 0 ? 0 : Math.PI)) * mv;
      const bw = T === 'brute' ? 0.09 : 0.045;
      el = [s[0] + i * bw * u, s[1] + 0.3 * u * (1 - 0.22 * Math.abs(sw))];
      hd = [el[0] + i * 0.012 * u, el[1] + 0.28 * u * (1 - 0.32 * Math.max(0, sw))];
    }
    return [s, el, hd];
  };
  const arms = [armPose(-1), armPose(1)];
  const sleeve = T === 'ganger' ? S.skin : T === 'razor' ? S.top : S.top;
  const fore = i => (T === 'merc' && i > 0) ? '#c8d4ff' : (T === 'ganger' || T === 'razor') ? S.skin : T === 'brute' ? shadeHex(S.top, 0.75) : S.top;
  const aw = T === 'brute' ? 1.6 : T === 'razor' ? 0.9 : 1;
  const drawArm = (k) => {
    const [s, el, hd] = arms[k], i = k ? 1 : -1;
    limb2(g, s, el, 0.062 * u * aw, 0.052 * u * aw, sleeve, sh(sleeve), lw);
    const fc = fore(i); limb2(g, el, hd, 0.052 * u * aw, 0.043 * u * aw, fc, sh(fc), lw);
    if (T === 'merc' && i > 0) { g.strokeStyle = S.accent; g.lineWidth = lw; g.beginPath(); g.moveTo(el[0] + (hd[0] - el[0]) * 0.35 - 0.04 * u, el[1] + (hd[1] - el[1]) * 0.35); g.lineTo(el[0] + (hd[0] - el[0]) * 0.35 + 0.04 * u, el[1] + (hd[1] - el[1]) * 0.35); g.stroke(); }
    const hr = (T === 'brute' ? 0.085 : 0.042) * u;
    fillShade(g, ell(g, hd[0], hd[1], hr, hr * 1.05), T === 'brute' ? '#3a3050' : (T === 'merc' && i > 0) ? '#b0bce8' : (T === 'gunner' ? '#221a30' : S.skin), T === 'brute' ? '#1b1426' : sh(S.skin), hd[0] + hr * 0.3, lw);
    if (T === 'ganger') blade(g, hd, el, 0.42 * u, 0.035 * u, S.accent, lw);
    if (T === 'razor') blade(g, hd, el, 0.55 * u, 0.04 * u, '#ff2a8a', lw);
  };
  const armsBehind = back && (pose.aim || pose.slash);
  if (armsBehind) { drawArm(0); drawArm(1); }

  // ---------- torso ----------
  if (T === 'merc') {
    const w0 = shW + 0.035 * u, hem = hipY - 0.03 * u;
    fillShade(g, () => { g.beginPath(); g.moveTo(tx - w0, shY + 0.01 * u); g.quadraticCurveTo(tx, shY - 0.05 * u, tx + w0, shY + 0.01 * u); g.quadraticCurveTo(tx + w0 + 0.03 * u, shY + 0.22 * u, cx + 0.19 * u, hem); g.lineTo(cx - 0.19 * u, hem); g.quadraticCurveTo(tx - w0 - 0.03 * u, shY + 0.22 * u, tx - w0, shY + 0.01 * u); g.closePath(); }, S.top, sh(S.top), tx + 0.06 * u, lw);
    fillShade(g, poly(g, [[cx - 0.18 * u, hem - 0.06 * u], [cx + 0.18 * u, hem - 0.06 * u], [cx + 0.17 * u, hem + 0.02 * u], [cx - 0.17 * u, hem + 0.02 * u]]), '#d6b50a', '#9a7e06', cx + 0.06 * u, lw);
    g.strokeStyle = INK; g.lineWidth = lw * 0.5; for (let k = -6; k <= 6; k++) { g.beginPath(); g.moveTo(cx + k * 0.026 * u, hem - 0.055 * u); g.lineTo(cx + k * 0.026 * u, hem + 0.015 * u); g.stroke(); }
    if (back) {
      g.strokeStyle = shadeHex(S.top, 0.6); g.lineWidth = lw * 0.8; g.beginPath(); g.moveTo(tx, shY + 0.02 * u); g.lineTo(cx, hem - 0.07 * u); g.stroke();
      fillShade(g, ell(g, tx, shY + 0.17 * u, 0.07 * u, 0.07 * u), '#120c1d', null, 0, lw);
      g.save(); g.shadowColor = '#ff2a8a'; g.shadowBlur = 8; g.fillStyle = '#ff2a8a'; g.font = `900 ${Math.round(0.09 * u)}px ${FJ}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('狼', tx, shY + 0.175 * u); g.restore();
      g.fillStyle = S.accent; g.fillRect(tx - 0.12 * u, shY + 0.3 * u, 0.24 * u, 0.012 * u);
    }
  } else if (T === 'ganger') {
    fillShade(g, poly(g, [[tx - shW * 0.75, shY + 0.02 * u], [tx + shW * 0.75, shY + 0.02 * u], [cx + 0.13 * u, hipY - 0.14 * u], [cx + 0.14 * u, hipY + 0.04 * u], [cx - 0.14 * u, hipY + 0.04 * u], [cx - 0.13 * u, hipY - 0.14 * u]]), S.top, sh(S.top), tx + 0.04 * u, lw);
    fillShade(g, poly(g, [[tx - shW, shY + 0.03 * u], [tx - shW * 0.6, shY - 0.01 * u], [tx - shW * 0.55, shY + 0.1 * u], [tx - shW * 1.05, shY + 0.12 * u]]), '#2a2236', '#120c1d', tx, lw);
    g.save(); g.shadowColor = S.accent; g.shadowBlur = 8; g.strokeStyle = S.accent; g.lineWidth = lw; g.beginPath(); g.moveTo(tx - 0.1 * u, shY + 0.16 * u); g.lineTo(tx + 0.1 * u, shY + 0.2 * u); g.stroke(); g.restore();
    fillShade(g, poly(g, [[cx - 0.15 * u, hipY - 0.03 * u], [cx + 0.15 * u, hipY - 0.03 * u], [cx + 0.15 * u, hipY + 0.03 * u], [cx - 0.15 * u, hipY + 0.03 * u]]), '#120c1d', null, 0, lw);
    g.strokeStyle = '#F7E733'; g.lineWidth = lw * 0.8; g.beginPath(); g.moveTo(cx - 0.1 * u, hipY + 0.03 * u); g.quadraticCurveTo(cx + 0.02 * u, hipY + 0.12 * u, cx + 0.13 * u, hipY + 0.02 * u); g.stroke();
  } else if (T === 'gunner') {
    fillShade(g, poly(g, [[tx - shW * 0.85, shY], [tx + shW * 0.85, shY], [cx + 0.15 * u, hipY - 0.12 * u], [cx + 0.15 * u, hipY + 0.05 * u], [cx - 0.15 * u, hipY + 0.05 * u], [cx - 0.15 * u, hipY - 0.12 * u]]), S.top, sh(S.top), tx + 0.05 * u, lw);
    fillShade(g, poly(g, [[tx - 0.12 * u, shY + 0.06 * u], [tx + 0.12 * u, shY + 0.06 * u], [tx + 0.1 * u, shY + 0.26 * u], [tx - 0.1 * u, shY + 0.26 * u]]), shadeHex(S.top, 1.25), shadeHex(S.top, 0.8), tx + 0.03 * u, lw);
    for (const i of [-1, 1]) fillShade(g, ell(g, tx + i * shW * 0.9, shY + 0.03 * u, 0.1 * u, 0.075 * u, i * 0.3), shadeHex(S.top, 1.1), sh(S.top), tx + i * shW * 0.9 + 0.02 * u, lw);
    g.fillStyle = S.accent; g.fillRect(tx - 0.08 * u, shY + 0.12 * u, 0.16 * u, 0.012 * u);
    for (const i of [-1, 0, 1]) fillShade(g, poly(g, [[cx + i * 0.09 * u - 0.04 * u, hipY - 0.06 * u], [cx + i * 0.09 * u + 0.04 * u, hipY - 0.06 * u], [cx + i * 0.09 * u + 0.04 * u, hipY + 0.02 * u], [cx + i * 0.09 * u - 0.04 * u, hipY + 0.02 * u]]), '#221a30', null, 0, lw * 0.8);
  } else if (T === 'brute') {
    fillShade(g, () => { g.beginPath(); g.moveTo(tx - shW, shY + 0.05 * u); g.quadraticCurveTo(tx, shY - 0.12 * u, tx + shW, shY + 0.05 * u); g.quadraticCurveTo(tx + shW + 0.04 * u, shY + 0.3 * u, cx + 0.19 * u, hipY + 0.04 * u); g.lineTo(cx - 0.19 * u, hipY + 0.04 * u); g.quadraticCurveTo(tx - shW - 0.04 * u, shY + 0.3 * u, tx - shW, shY + 0.05 * u); g.closePath(); }, S.top, sh(S.top), tx + 0.06 * u, lw);
    g.save(); poly(g, [[tx - shW * 0.8, shY + 0.16 * u], [tx + shW * 0.8, shY + 0.16 * u], [tx + shW * 0.78, shY + 0.26 * u], [tx - shW * 0.78, shY + 0.26 * u]])(); g.clip();
    g.fillStyle = '#F7E733'; g.fillRect(tx - shW, shY + 0.15 * u, shW * 2, 0.12 * u); g.fillStyle = INK;
    for (let k = -8; k < 8; k++) { g.beginPath(); g.moveTo(tx + k * 0.06 * u, shY + 0.15 * u); g.lineTo(tx + k * 0.06 * u + 0.03 * u, shY + 0.15 * u); g.lineTo(tx + k * 0.06 * u - 0.06 * u, shY + 0.28 * u); g.lineTo(tx + k * 0.06 * u - 0.09 * u, shY + 0.28 * u); g.fill(); }
    g.restore();
    for (const i of [-1, 1]) fillShade(g, ell(g, tx + i * shW * 0.95, shY + 0.04 * u, 0.12 * u, 0.1 * u, i * 0.3), shadeHex(S.top, 0.8), sh(S.top), tx + i * shW * 0.95 + 0.03 * u, lw);
  } else if (T === 'razor') {
    fillShade(g, poly(g, [[tx - 0.07 * u, shY + 0.02 * u], [tx + 0.07 * u, shY + 0.02 * u], [cx + 0.09 * u, hipY + 0.05 * u], [cx - 0.09 * u, hipY + 0.05 * u]]), '#170f22', null, 0, lw);
    g.save(); g.shadowColor = '#ff2a8a'; g.shadowBlur = 10; g.strokeStyle = '#ff2a8a'; g.lineWidth = lw; for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(tx - 0.05 * u, shY + (0.12 + k * 0.1) * u); g.lineTo(tx + 0.05 * u, shY + (0.14 + k * 0.1) * u); g.stroke(); } g.restore();
  }

  // ---------- head ----------
  limb2(g, [hx, neckY + 0.04 * u], [hx, hy + hs * 0.7], 0.042 * u * (T === 'brute' ? 1.6 : 1), 0.038 * u, S.skin, sh(S.skin), lw);
  if (back) {
    fillShade(g, faceShape(g, hx, hy, hs), S.skin, sh(S.skin), hx + hs * 0.3, lw);
    fillShade(g, spikyCap(g, hx, hy - hs * 0.1, hs, 14, 1.12, 1.4, Math.PI * 0.92, Math.PI * 2.08, hy + hs * 0.95), S.hair, sh(S.hair), hx + hs * 0.25, lw);
    const jag = []; for (let k = 0; k <= 8; k++) jag.push([hx - hs * 1.1 + k * hs * 2.2 / 8, hy + hs * (k % 2 ? 1.3 : 0.85)]);
    fillShade(g, poly(g, [[hx - hs * 1.15, hy + hs * 0.2], [hx + hs * 1.15, hy + hs * 0.2], ...jag.reverse()]), S.hair, sh(S.hair), hx + hs * 0.25, lw);
    g.strokeStyle = shadeHex(S.hair, 1.5); g.lineWidth = lw; for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(hx - hs * 0.2, hy - hs * 0.2, hs * (0.55 + k * 0.18), Math.PI * 1.15, Math.PI * 1.45); g.stroke(); }
  } else if (T === 'gunner') {
    fillShade(g, faceShape(g, hx, hy, hs), S.skin, sh(S.skin), hx + hs * 0.3, lw);
    fillShade(g, () => { g.beginPath(); g.moveTo(hx - hs * 1.15, hy + hs * 0.35); g.bezierCurveTo(hx - hs * 1.25, hy - hs * 1.5, hx + hs * 1.25, hy - hs * 1.5, hx + hs * 1.15, hy + hs * 0.35); g.lineTo(hx + hs * 0.8, hy + hs * 0.45); g.lineTo(hx - hs * 0.8, hy + hs * 0.45); g.closePath(); }, '#2a2236', '#140e1e', hx + hs * 0.35, lw);
    g.save(); g.shadowColor = S.eye; g.shadowBlur = 12; fillShade(g, poly(g, [[hx - hs * 0.95, hy - hs * 0.05], [hx + hs * 0.95, hy - hs * 0.05], [hx + hs * 0.85, hy + hs * 0.3], [hx - hs * 0.85, hy + hs * 0.3]]), S.eye, null, 0, 0); g.restore();
    poly(g, [[hx - hs * 0.95, hy - hs * 0.05], [hx + hs * 0.95, hy - hs * 0.05], [hx + hs * 0.85, hy + hs * 0.3], [hx - hs * 0.85, hy + hs * 0.3]])(); inkStroke(g, lw);
    g.fillStyle = '#fff6e0'; g.fillRect(hx - hs * 0.7, hy + hs * 0.05, hs * 0.5, hs * 0.06);
    fillShade(g, poly(g, [[hx - hs * 0.55, hy + hs * 0.55], [hx + hs * 0.55, hy + hs * 0.55], [hx + hs * 0.35, hy + hs * 1.05], [hx - hs * 0.35, hy + hs * 1.05]]), '#221a30', null, 0, lw);
  } else if (T === 'brute') {
    fillShade(g, ell(g, hx, hy + hs * 0.2, hs * 1.05, hs * 1.15), '#3a3050', '#1b1426', hx + hs * 0.3, lw);
    g.save(); g.shadowColor = S.eye; g.shadowBlur = 12; g.fillStyle = S.eye; g.fillRect(hx - hs * 0.75, hy + hs * 0.05, hs * 1.5, hs * 0.22); g.restore();
    fillShade(g, poly(g, [[hx - hs * 0.7, hy + hs * 0.55], [hx + hs * 0.7, hy + hs * 0.55], [hx + hs * 0.5, hy + hs * 1.2], [hx - hs * 0.5, hy + hs * 1.2]]), '#9aa4c8', '#5a6080', hx + hs * 0.2, lw);
  } else {
    fillShade(g, faceShape(g, hx, hy, hs), S.skin, sh(S.skin), hx + hs * 0.35, lw);
    eyesFront(g, hx, hy, hs, S, lw, T === 'razor' ? 'crazy' : 'angry');
    g.strokeStyle = INK; g.lineWidth = lw * 0.8; g.beginPath(); g.moveTo(hx + hs * 0.02, hy + hs * 0.4); g.lineTo(hx + hs * 0.08, hy + hs * 0.55); g.stroke();
    if (T === 'razor') {
      fillShade(g, poly(g, [[hx - hs * 0.6, hy + hs * 0.62], [hx + hs * 0.6, hy + hs * 0.62], [hx + hs * 0.4, hy + hs * 1.05], [hx - hs * 0.4, hy + hs * 1.05]]), '#c8d0e8', '#7a80a0', hx + hs * 0.15, lw);
      g.strokeStyle = INK; g.lineWidth = lw * 0.7; for (let k = -3; k <= 3; k++) { g.beginPath(); g.moveTo(hx + k * hs * 0.13, hy + hs * 0.66); g.lineTo(hx + k * hs * 0.11, hy + hs * 1.0); g.stroke(); }
      g.beginPath(); g.moveTo(hx - hs * 0.55, hy + hs * 0.82); g.lineTo(hx + hs * 0.55, hy + hs * 0.82); g.stroke();
      fillShade(g, spikyCap(g, hx, hy - hs * 0.2, hs, 13, 1.0, 1.55, Math.PI * 1.02, Math.PI * 1.98), S.hair, sh(S.hair), hx + hs * 0.3, lw);
    } else {
      g.lineWidth = lw; g.beginPath(); g.moveTo(hx - hs * 0.28, hy + hs * 0.74); g.quadraticCurveTo(hx, hy + hs * 0.66, hx + hs * 0.3, hy + hs * 0.78); g.stroke();
      fillShade(g, poly(g, [[hx - hs * 0.2, hy + hs * 0.72], [hx + hs * 0.22, hy + hs * 0.74], [hx + hs * 0.18, hy + hs * 0.8], [hx - hs * 0.18, hy + hs * 0.78]]), '#fff6e0', null, 0, lw * 0.6);
      g.fillStyle = shadeHex(S.skin, 0.8); g.fillRect(hx - hs * 0.95, hy - hs * 0.55, hs * 1.9, hs * 0.08);
      const mh = []; for (let k = 0; k <= 8; k++) { const t = k / 8; mh.push([hx - hs * 0.22 + t * hs * 0.44, hy - hs * (k % 2 ? 1.05 : 1.85 - Math.abs(t - 0.5) * 0.9)]); }
      fillShade(g, poly(g, [[hx - hs * 0.24, hy - hs * 0.75], ...mh, [hx + hs * 0.24, hy - hs * 0.75]]), S.hair, sh(S.hair), hx + hs * 0.04, lw);
    }
  }
  if (T === 'merc') {
    fillShade(g, poly(g, [[hx - 0.15 * u, neckY + 0.06 * u], [hx - 0.13 * u, neckY - 0.08 * u], [hx, neckY - 0.03 * u], [hx + 0.13 * u, neckY - 0.08 * u], [hx + 0.15 * u, neckY + 0.06 * u]]), S.top, sh(S.top), hx + 0.05 * u, lw);
    g.fillStyle = INK; g.fillRect(hx - 0.1 * u, neckY + 0.01 * u, 0.2 * u, 0.012 * u);
  }

  // ---------- arms in front ----------
  if (!armsBehind) { drawArm(0); drawArm(1); }
  if (T === 'gunner') {
    if (pose.aim) {
      const mz = [cx + 0.02 * u, shY + 0.2 * u];
      fillShade(g, poly(g, [[mz[0] - 0.07 * u, mz[1] - 0.05 * u], [mz[0] + 0.07 * u, mz[1] - 0.05 * u], [mz[0] + 0.06 * u, mz[1] + 0.07 * u], [mz[0] - 0.06 * u, mz[1] + 0.07 * u]]), '#221a30', '#120c1d', mz[0], lw);
      fillShade(g, ell(g, mz[0], mz[1], 0.04 * u, 0.04 * u), '#120c1d', null, 0, lw);
      if (pose.flash) { g.save(); g.translate(mz[0], mz[1]); g.fillStyle = '#F7E733'; g.beginPath(); for (let k = 0; k < 16; k++) { const a = k / 16 * TAU, r = (k % 2 ? 0.05 : 0.13) * u; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill(); inkStroke(g, lw); g.restore(); }
    } else {
      const a = [cx - 0.22 * u, hipY - 0.02 * u], b = [cx + 0.26 * u, shY + 0.05 * u];
      limb2(g, a, b, 0.035 * u, 0.03 * u, '#221a30', '#120c1d', lw);
      g.fillStyle = S.accent; g.fillRect(cx - 0.05 * u, shY + 0.22 * u, 0.1 * u, 0.012 * u);
    }
  }
  if (T === 'merc' && !pose.kat) {
    if (pose.aim) {
      const gp = [tx + shW * 0.65, shY - 0.04 * u];
      fillShade(g, poly(g, [[gp[0] - 0.03 * u, gp[1] + 0.06 * u], [gp[0] + 0.03 * u, gp[1] + 0.06 * u], [gp[0] + 0.05 * u, gp[1] - 0.06 * u], [gp[0] - 0.01 * u, gp[1] - 0.08 * u]]), '#241a34', '#120c1d', gp[0], lw);
      g.fillStyle = S.accent; g.fillRect(gp[0] - 0.005 * u, gp[1] - 0.05 * u, 0.012 * u, 0.09 * u);
    } else {
      const hd = arms[1][2];
      fillShade(g, poly(g, [[hd[0] - 0.025 * u, hd[1] - 0.03 * u], [hd[0] + 0.03 * u, hd[1] - 0.03 * u], [hd[0] + 0.035 * u, hd[1] + 0.16 * u], [hd[0] - 0.015 * u, hd[1] + 0.16 * u]]), '#241a34', '#120c1d', hd[0] + 0.01 * u, lw);
      g.fillStyle = S.accent; g.fillRect(hd[0] + 0.01 * u, hd[1], 0.01 * u, 0.12 * u);
    }
  }
  if (T === 'merc' && pose.kat) {
    const hd = arms[1][2];
    let tip;
    if (pose.slash === 1) tip = [hd[0] - 0.3 * u, hd[1] - 0.55 * u];
    else if (pose.slash === 2) tip = [hd[0] + 0.55 * u, hd[1] + 0.35 * u];
    else tip = [hd[0] + 0.22 * u, hd[1] + 0.6 * u];
    const dx = tip[0] - hd[0], dy = tip[1] - hd[1], L = Math.hypot(dx, dy), nx = -dy / L * 0.022 * u, ny = dx / L * 0.022 * u;
    if (pose.slash === 2) {
      g.save(); g.globalAlpha = 0.55; g.fillStyle = '#fff6e0'; g.beginPath(); g.moveTo(hd[0], hd[1]); g.quadraticCurveTo(hd[0] + 0.1 * u, hd[1] - 0.7 * u, hd[0] - 0.3 * u, hd[1] - 0.55 * u); g.quadraticCurveTo(hd[0] + 0.5 * u, hd[1] - 0.3 * u, tip[0], tip[1]); g.closePath(); g.fill(); g.restore();
    }
    fillShade(g, poly(g, [[hd[0] + nx, hd[1] + ny], [tip[0], tip[1]], [hd[0] - nx, hd[1] - ny]]), '#f4f8ff', '#a8b0d0', hd[0], lw);
    g.save(); g.shadowColor = '#ff2a8a'; g.shadowBlur = 10; g.strokeStyle = '#ff2a8a'; g.lineWidth = lw * 0.8; g.beginPath(); g.moveTo(hd[0] + nx, hd[1] + ny); g.lineTo(tip[0], tip[1]); g.stroke(); g.restore();
    limb2(g, [hd[0] - dx / L * 0.09 * u, hd[1] - dy / L * 0.09 * u], hd, 0.018 * u, 0.018 * u, '#241a34', null, lw * 0.8);
  }
  if (pose.hurt) { g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(0, 0, S.W, S.H); g.restore(); }
}

/** Side view used for enemies moving across the screen. */
function drawSide(g, S, pose, lw) {
  const u = S.u, cx = S.cx, gy = S.gy, T = S.type, ph = pose.ph || 0, mv = pose.move || 0, sh = c => shadeHex(c, 0.56);
  const bob = -Math.abs(Math.sin(ph)) * 0.035 * u * mv;
  const hipY = gy - 0.95 * u + bob, shY = hipY - 0.5 * u, hs = S.headS * u, hip = [cx, hipY], shp = [cx + 0.02 * u, shY + 0.04 * u];
  const pw = T === 'brute' ? 1.35 : 1, aw = T === 'brute' ? 1.6 : T === 'razor' ? 0.9 : 1;
  const leg = (off, dk) => {
    const a = Math.sin(ph + off) * 0.6 * mv, bend = Math.max(0, -Math.cos(ph + off)) * 1.0 * mv + 0.1;
    const knee = [hip[0] + Math.sin(a) * 0.45 * u, hip[1] + Math.cos(a) * 0.45 * u], ank = [knee[0] + Math.sin(a - bend) * 0.43 * u, Math.min(gy - 0.04 * u, knee[1] + Math.cos(a - bend) * 0.43 * u)];
    const col = dk ? shadeHex(S.pants, 0.7) : S.pants;
    limb2(g, hip, knee, 0.08 * u * pw, 0.064 * u * pw, col, sh(col), lw); limb2(g, knee, ank, 0.063 * u * pw, 0.047 * u * pw, col, sh(col), lw);
    fillShade(g, ell(g, ank[0] + 0.045 * u, ank[1] + 0.03 * u, 0.095 * u * pw, 0.045 * u * pw), dk ? shadeHex(S.shoe, 0.7) : S.shoe, sh(S.shoe), ank[0] + 0.07 * u, lw);
  };
  const arm = (off, dk) => {
    let a = -Math.sin(ph + off) * 0.5 * mv, bnd = 0.35;
    if (T === 'gunner') { a = -1.2; bnd = -0.1; }
    const el = [shp[0] + Math.sin(a) * 0.3 * u, shp[1] + Math.cos(a) * 0.3 * u], hd = [el[0] + Math.sin(a + bnd) * 0.28 * u, el[1] + Math.cos(a + bnd) * 0.28 * u];
    const sl = T === 'ganger' ? S.skin : S.top, col = dk ? shadeHex(sl, 0.7) : sl;
    limb2(g, shp, el, 0.062 * u * aw, 0.052 * u * aw, col, sh(col), lw);
    const fc = (T === 'ganger' || T === 'razor') ? S.skin : T === 'brute' ? shadeHex(S.top, 0.75) : S.top;
    limb2(g, el, hd, 0.052 * u * aw, 0.043 * u * aw, dk ? shadeHex(fc, 0.7) : fc, sh(fc), lw);
    const hr = (T === 'brute' ? 0.085 : 0.042) * u;
    fillShade(g, ell(g, hd[0], hd[1], hr, hr), T === 'brute' ? '#3a3050' : S.skin, sh(S.skin), hd[0] + hr * 0.3, lw);
    if (T === 'ganger') blade(g, hd, el, 0.42 * u, 0.035 * u, S.accent, lw);
    if (T === 'razor') blade(g, hd, el, 0.55 * u, 0.04 * u, '#ff2a8a', lw);
    return hd;
  };
  if (T !== 'gunner') arm(0, true);
  leg(Math.PI, true);
  const bw = S.shW * u * 0.55;
  if (T === 'razor') fillShade(g, poly(g, [[cx - bw, shY], [cx + bw, shY], [cx + 0.12 * u, hipY + 0.42 * u], [cx - 0.22 * u, hipY + 0.46 * u]]), S.top, sh(S.top), cx, lw);
  fillShade(g, poly(g, [[cx - bw * 0.9, shY], [cx + bw, shY], [cx + bw * 0.85, hipY - 0.15 * u], [cx + bw * 0.7, hipY + 0.05 * u], [cx - bw * 0.7, hipY + 0.05 * u], [cx - bw * 0.8, hipY - 0.15 * u]]), T === 'razor' ? '#170f22' : S.top, sh(S.top), cx + bw * 0.2, lw);
  if (T === 'brute') { g.save(); poly(g, [[cx - bw * 0.9, shY + 0.15 * u], [cx + bw, shY + 0.15 * u], [cx + bw, shY + 0.26 * u], [cx - bw * 0.9, shY + 0.26 * u]])(); g.clip(); g.fillStyle = '#F7E733'; g.fillRect(cx - bw, shY + 0.15 * u, bw * 2, 0.11 * u); g.restore(); }
  leg(0, false);
  const hx = cx + 0.05 * u, hy = shY - 0.035 * u - hs * 1.02;
  limb2(g, [cx + 0.02 * u, shY + 0.02 * u], [hx, hy + hs * 0.7], 0.04 * u, 0.036 * u, S.skin, sh(S.skin), lw);
  const prof = () => { g.beginPath(); g.moveTo(hx - hs * 0.95, hy); g.bezierCurveTo(hx - hs, hy - hs * 1.3, hx + hs * 1.0, hy - hs * 1.25, hx + hs * 0.95, hy - hs * 0.1); g.lineTo(hx + hs * 1.12, hy + hs * 0.35); g.lineTo(hx + hs * 0.95, hy + hs * 0.45); g.quadraticCurveTo(hx + hs * 0.9, hy + hs * 0.95, hx + hs * 0.3, hy + hs * 1.08); g.quadraticCurveTo(hx - hs * 0.7, hy + hs * 0.9, hx - hs * 0.95, hy); g.closePath(); };
  if (T === 'brute') { fillShade(g, ell(g, hx, hy + hs * 0.2, hs * 1.05, hs * 1.15), '#3a3050', '#1b1426', hx, lw); g.save(); g.shadowColor = S.eye; g.shadowBlur = 12; g.fillStyle = S.eye; g.fillRect(hx + hs * 0.2, hy + hs * 0.05, hs * 0.8, hs * 0.2); g.restore(); }
  else {
    fillShade(g, prof, S.skin, sh(S.skin), hx - hs * 0.2, lw);
    if (T === 'gunner') {
      fillShade(g, () => { g.beginPath(); g.moveTo(hx - hs * 1.1, hy + hs * 0.4); g.bezierCurveTo(hx - hs * 1.2, hy - hs * 1.5, hx + hs * 1.2, hy - hs * 1.4, hx + hs * 1.05, hy + hs * 0.1); g.lineTo(hx - hs * 0.2, hy + hs * 0.2); g.closePath(); }, '#2a2236', '#140e1e', hx - hs * 0.2, lw);
      g.save(); g.shadowColor = S.eye; g.shadowBlur = 12; g.fillStyle = S.eye; g.fillRect(hx + hs * 0.3, hy - hs * 0.02, hs * 0.8, hs * 0.26); g.restore();
    } else {
      if (S.glowEyes || S.cyberEye) glowDot(g, hx + hs * 0.6, hy + hs * 0.12, hs * 0.1, S.eye);
      else { g.fillStyle = '#fff6e0'; g.beginPath(); g.ellipse(hx + hs * 0.62, hy + hs * 0.12, hs * 0.14, hs * 0.14, 0, 0, TAU); g.fill(); g.fillStyle = S.eye; g.fillRect(hx + hs * 0.62, hy + hs * 0.02, hs * 0.1, hs * 0.2); }
      g.strokeStyle = INK; g.lineWidth = lw * 1.3; g.beginPath(); g.moveTo(hx + hs * 0.45, hy - hs * 0.05); g.lineTo(hx + hs * 0.82, hy + hs * 0.02); g.stroke();
      if (T === 'ganger') { const mh = []; for (let k = 0; k <= 8; k++) mh.push([hx - hs * 0.7 + k * hs * 1.3 / 8, hy - hs * (k % 2 ? 0.95 : 1.75)]); fillShade(g, poly(g, [[hx - hs * 0.8, hy - hs * 0.6], ...mh, [hx + hs * 0.6, hy - hs * 0.75]]), S.hair, sh(S.hair), hx, lw); }
      else fillShade(g, spikyCap(g, hx - hs * 0.1, hy - hs * 0.15, hs, 13, 1.0, 1.5, Math.PI * 0.6, Math.PI * 1.85), S.hair, sh(S.hair), hx, lw);
    }
  }
  if (T === 'gunner') {
    const hd = arm(0, false);
    limb2(g, [hd[0] - 0.12 * u, hd[1] + 0.02 * u], [hd[0] + 0.42 * u, hd[1] - 0.02 * u], 0.035 * u, 0.028 * u, '#221a30', '#120c1d', lw);
  } else arm(Math.PI, false);
}

const SPRITES = {};
/** Renders one pose into its own canvas texture. */
function mkFrame(S, pose, view) {
  const c = document.createElement('canvas'); c.width = S.W; c.height = S.H;
  drawChar(c.getContext('2d'), S, pose, view);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
/** Pre-renders every animation set for a character type. Runs once per type. */
function makeFrames(type) {
  const S = SPEC[type], F = {};
  const seq = (n, f, view) => Array.from({ length: n }, (_, k) => mkFrame(S, f(k), view));
  if (type === 'merc') {
    for (const kat of [false, true]) {
      const set = {};
      set.walk = seq(6, k => ({ ph: k / 6 * TAU, move: 1, kat }), 'back');
      set.idle = seq(2, k => ({ breath: k * Math.PI, kat }), 'back');
      set.dash = [mkFrame(S, { ph: 1.2, move: 1.3, dash: true, spread: 0.08, lean: 0.02, kat }, 'back')];
      if (kat) set.slash = [mkFrame(S, { slash: 1, kat, spread: 0.05 }, 'back'), mkFrame(S, { slash: 2, kat, spread: 0.07, lean: 0.03 }, 'back')];
      else { set.shoot = [mkFrame(S, { aim: true }, 'back')]; set.walkAim = seq(6, k => ({ ph: k / 6 * TAU, move: 1, aim: true }), 'back'); }
      F[kat ? 'kat' : 'gun'] = set;
    }
  } else {
    F.walk = seq(6, k => ({ ph: k / 6 * TAU, move: 1 }), 'front');
    F.side = seq(6, k => ({ ph: k / 6 * TAU, move: 1 }), 'side');
    F.idle = seq(2, k => ({ breath: k * Math.PI }), 'front');
    F.hurt = [mkFrame(S, { hurt: true, lean: -0.03 }, 'front')];
    F.air = [mkFrame(S, { air: true, armsUp: type !== 'gunner' }, 'front')];
    F.wind = [mkFrame(S, { armsUp: true, crouch: 0.6, spread: 0.06 }, 'front')];
    F.strike = [mkFrame(S, { strike: true, spread: 0.1, lean: 0.03 }, 'front')];
    F.shoot = [mkFrame(S, { aim: true, flash: true }, 'front')];
    F.aim = [mkFrame(S, { aim: true }, 'front')];
  }
  return F;
}
/** Creates a billboard sprite rig for a character type. */
function buildSpriteRig(type) {
  const S = SPEC[type], F = SPRITES[type] || (SPRITES[type] = makeFrames(type));
  const first = type === 'merc' ? F.gun.idle[0] : F.idle[0];
  const mat = new THREE.SpriteMaterial({ map: first, alphaTest: 0.5, transparent: false, toneMapped: false });
  const sp = new THREE.Sprite(mat); sp.center.set(0.5, 0.012); sp.scale.set(S.W / S.ppu, S.H / S.ppu, 1);
  const g = new THREE.Group(); g.add(sp);
  return { g, sprite: sp, F, S, base: sp.scale.clone(), mats: [], gun: new THREE.Object3D(), kat: new THREE.Object3D(), swing: 0, recoil: 0, aimT: 0, flip: 1 };
}
/** Chooses the sprite frame for an enemy from its movement, attack and hit state. */
function animSprite(e, dt, rdt) {
  const r = e.rig, F = r.F, sp = r.sprite;
  const speed = Math.hypot(e.vx, e.vz);
  let set = F.idle, idx = Math.floor(clock * 2), flip = 1;
  if (e.y > 0.05) set = F.air;
  else if (e.flinch > 0.08) set = F.hurt;
  else if (e.type === 'ganger' && e.atk === 'wind') set = F.wind;
  else if (e.type === 'ganger' && e.atk === 'strike') set = F.strike;
  else if ((e.type === 'brute' || e.type === 'razor') && e.mode === 'wind') set = F.wind;
  else if ((e.type === 'brute' || e.type === 'razor') && e.mode === 'charge') set = F.strike;
  else if (e.type === 'gunner' && e.kick > 0.14) set = F.shoot;
  else if (speed > 0.6) {
    const rx = -Math.cos(yaw), rz = Math.sin(yaw), fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lat = e.vx * rx + e.vz * rz, tow = -(e.vx * fx + e.vz * fz);
    e.ph += dt * (2.5 + speed * 1.7);
    idx = Math.floor((e.ph % TAU) / TAU * 6);
    if (Math.abs(lat) > Math.abs(tow) * 1.15) { set = F.side; flip = lat < 0 ? -1 : 1; } else set = F.walk;
  } else if (e.type === 'gunner') set = F.aim;
  const tex = set[((idx % set.length) + set.length) % set.length];
  if (sp.material.map !== tex) sp.material.map = tex;
  const sq = e.squash > 0 ? e.squash / 0.25 : 0; e.squash = Math.max(0, e.squash - rdt);
  sp.scale.set(r.base.x * flip * (1 + sq * 0.25), r.base.y * (1 - sq * 0.3), 1);
  sp.material.rotation = e.flinch * 0.6 * (e.kx > 0 ? -1 : 1);
  e.mesh.position.y = e.y;
  if (e.type === 'brute' && e.mode === 'wind') e.mesh.position.x += rand(-0.04, 0.04);
}

/* ================= characters =================
 * Primitive-built 3D characters (drone and the HYDRA-7 boss) and
 * the pooled Overclock afterimages ("ghosts").
 */
const SHADOW_MAT = basic(0x000000, { transparent: true, opacity: 0.45, depthWrite: false });
const SHADOW_GEO = new THREE.CircleGeometry(1, 20);
/** Adds a soft blob shadow on the ground and returns it. */
function addShadow(r) { const s = new THREE.Mesh(SHADOW_GEO, SHADOW_MAT); s.rotation.x = -Math.PI / 2; s.scale.set(r, r, r); s.position.y = 0.015; scene.add(s); return s; }
/** Primitive-built 3D rig for the flying drone. */
function buildDrone() {
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const M = { shell: toon(C.c), dark: toon(0x121a2c), eye: neon(C.r, 3) };
  const sh = part(g, box(0.62, 0.16, 0.62), M.shell, 0, 0, 0, 0.04); sh.rotation.y = Math.PI / 4;
  part(g, sph(0.26, 12), M.dark, 0, 0.02, 0, 0.035);
  part(g, sph(0.09, 8), M.eye, 0, 0, 0.25, 0.02);
  const rotors = [];
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; rotors.push(part(g, cyl(0.2, 0.2, 0.03, 12), M.dark, Math.cos(a) * 0.45, 0.1, Math.sin(a) * 0.45, 0.03)); }
  return { g, rotors, mats: [M.shell, M.dark] };
}
function buildHydra() {
  const g = new THREE.Group();
  const M = { core: toon(C.c), dark: toon(0x141022), pod: toon(C.m), eye: neon(C.r, 3), y: neon(C.y, 2) };
  part(g, octa(1.25), M.core, 0, 0, 0, 0.07);
  part(g, sph(0.55, 14), M.dark, 0, 0, 0.75, 0.05);
  part(g, sph(0.32, 12), M.eye, 0, 0, 1.08, 0.03);
  const podG = new THREE.Group(); g.add(podG);
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Group(); arm.rotation.y = i / 3 * TAU; podG.add(arm);
    part(arm, box(0.18, 0.18, 1.6), M.dark, 0, 0, 1.0, 0.04);
    part(arm, sph(0.55, 14), M.pod, 0, 0, 1.95, 0.06);
    part(arm, sph(0.18, 8), M.y, 0, 0, 2.42, 0.03);
  }
  return { g, podG, mats: [M.core, M.dark, M.pod] };
}
function buildGhost() {
  const m = new THREE.SpriteMaterial({ transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const g = new THREE.Sprite(m); g.center.set(0.5, 0.012); g.visible = false; scene.add(g); return { g, m, life: 0, max: 0.4, hasMap: false };
}
const ghosts = []; for (let i = 0; i < 18; i++) ghosts.push(buildGhost());
let ghostIdx = 0;
/** Leaves an afterimage of the player (cyan for dash, rainbow during Overclock). */
function addGhost(rainbow) {
  if (!player) return;
  const gh = ghosts[ghostIdx]; ghostIdx = (ghostIdx + 1) % ghosts.length;
  gh.g.position.set(player.x, 0, player.z); gh.g.visible = true;
  if (rig && rig.sprite) { gh.m.map = rig.sprite.material.map; gh.m.rotation = rig.sprite.material.rotation; gh.g.scale.copy(rig.sprite.scale); if (!gh.hasMap) { gh.hasMap = true; gh.m.needsUpdate = true; } }
  gh.max = gh.life = rainbow ? 0.45 : 0.22;
  gh.m.color.setHSL(rainbow ? (clock * 2) % 1 : 0.51, 1, 0.55).multiplyScalar(1.5);
}
function updateGhosts(rdt) { for (const gh of ghosts) { if (!gh.g.visible) continue; gh.life -= rdt; if (gh.life <= 0) { gh.g.visible = false; continue; } gh.m.opacity = gh.life / gh.max * 0.55; } }

/* ================= projectiles =================
 * Mesh pools for player bullets and enemy bullets (one pool per colour/size).
 */
const PB_MAT = neon(0xfff4a0, 3);
const PB_GLOW = basic(new THREE.Color(C.y).multiplyScalar(1.6), { transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
const pbPool = [];
/** Takes a player bullet mesh from the pool or creates one. */
function pbMesh() { let m = pbPool.pop(); if (!m) { m = new THREE.Mesh(box(0.06, 0.06, 0.9), PB_MAT); m.add(new THREE.Mesh(box(0.16, 0.16, 1.1), PB_GLOW)); } scene.add(m); return m; }
const EB_MATS = {}; const ebPools = {};
/** Takes an enemy bullet mesh of the given colour and radius from its pool. */
function ebMesh(hex, r) {
  const key = hex + '_' + r; const pool = ebPools[key] || (ebPools[key] = []);
  let m = pool.pop();
  if (!m) {
    const mat = EB_MATS[hex] || (EB_MATS[hex] = neon(hex, 2.2));
    m = part(new THREE.Group(), sph(r, 10), mat, 0, 0, 0, 0.06);
    m.add(new THREE.Mesh(sph(r * 0.45, 8), neon(0xffffff, 2.5)));
    m.userData.key = key; m.removeFromParent();
  }
  scene.add(m); return m;
}
const pickMat = toon(C.g, { emissive: 0x2a8a50 }), pickMat2 = neon(0xffffff, 2);

/* ================= debris, muzzle light, slash, weapons =================
 * Death debris, the shared muzzle flash light, the katana slash arc and the
 * three weapon definitions. Weapon `rate` is shots per second before upgrades.
 */
const debMats = {}; const debMat = hex => debMats[hex] || (debMats[hex] = toon(hex));
const debPool = []; let debris = [];
/** Throws `n` physical debris cubes that bounce and settle. */
function spawnDebris(x, y, z, hex, n, size, speed) {
  for (let i = 0; i < n; i++) {
    let m = debPool.pop();
    if (!m) { m = part(new THREE.Group(), box(1, 1, 1), debMat(hex), 0, 0, 0, 0.14); m.removeFromParent(); }
    m.material = debMat(Math.random() < 0.35 ? 0x1b1426 : hex);
    const sc = size * rand(0.5, 1.2); m.scale.set(sc, sc * rand(0.5, 1.3), sc * rand(0.6, 1.4));
    m.position.set(x + rand(-0.3, 0.3), y + rand(-0.3, 0.3), z + rand(-0.3, 0.3)); m.rotation.set(rand(0, TAU), rand(0, TAU), 0);
    scene.add(m);
    const a = rand(0, TAU), sp = rand(0.35, 1) * speed;
    debris.push({ m, vx: Math.cos(a) * sp, vy: rand(0.5, 1.2) * speed, vz: Math.sin(a) * sp, rx: rand(-14, 14), rz: rand(-14, 14), life: rand(1.3, 2), s: m.scale.clone() });
  }
  while (debris.length > 140) { const d = debris.shift(); d.m.removeFromParent(); debPool.push(d.m); }
}
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i]; d.life -= dt;
    if (d.life <= 0) { d.m.removeFromParent(); debPool.push(d.m); debris.splice(i, 1); continue; }
    d.vy -= 18 * dt; d.m.position.x += d.vx * dt; d.m.position.y += d.vy * dt; d.m.position.z += d.vz * dt;
    const floor = d.s.y * 0.5;
    if (d.m.position.y < floor) { d.m.position.y = floor; d.vy *= -0.35; d.vx *= 0.65; d.vz *= 0.65; d.rx *= 0.6; d.rz *= 0.6; }
    d.m.rotation.x += d.rx * dt; d.m.rotation.z += d.rz * dt;
    if (d.life < 0.4) { const k = d.life / 0.4; d.m.scale.set(d.s.x * k, d.s.y * k, d.s.z * k); }
  }
}
function clearDebris() { for (const d of debris) { d.m.removeFromParent(); debPool.push(d.m); } debris = []; }
const muzzleLight = new THREE.PointLight(0xffc860, 0, 9, 2); scene.add(muzzleLight);
const slashMat = basic(new THREE.Color(2.2, 1.2, 2.4), { transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
const slashG = new THREE.Group(); scene.add(slashG);
const slashGeo = new THREE.RingGeometry(0.9, 3.1, 40, 1, -Math.PI / 2 - 1.05, 2.1); slashGeo.rotateX(-Math.PI / 2);
const slashMesh = new THREE.Mesh(slashGeo, slashMat); slashG.add(slashMesh);
let slashT = 0, slashDir = 1;
/** Weapons: SMG (1), shotgun (2) and katana (3). */
const WEAPONS = [
  { id: 'smg', name: 'TENSHI-SMG', jp: '天使', rate: 9.5, dmg: 7, pellets: 1, spread: 0.05, spd: 64, life: 1.1, kick: 0.004, knock: 1 },
  { id: 'shotgun', name: 'ONI-SCHROT', jp: '鬼', rate: 1.6, dmg: 9, pellets: 8, spread: 0.12, spd: 54, life: 0.42, kick: 0.035, knock: 3 },
  { id: 'katana', name: 'KAGE-KATANA', jp: '影', rate: 2.8, dmg: 42, melee: true, reach: 3.1, arc: 1.05 }
];
let weaponIdx = 0;

/* ================= state =================
 * Mutable run state. `state` is one of: loading, menu, play, pause, upgrade,
 * dying, over. `stats` holds the player's upgradeable values for the run;
 * `UPG` lists the cyberware cards offered after each wave.
 */
let state = 'loading';
let player = null, rig = null, stats = null, owned = {};
let bullets = [], ebullets = [], enemies = [], texts = [], pickups = [], hurtMarks = [];
let wave = 0, queue = [], spawnT = 0, spawnEvery = 1, waveDone = false, clearT = 0;
let score = 0, kills = 0, combo = 0, comboT = 0, oc = 0, ocT = 0, ocActive = false, playTime = 0;
let shakeAmt = 0, hitstop = 0, hurtFlash = 0, ocFlash = 0, banner = null, boss = null, dashId = 0, dyingT = 0, clock = 0;
let yaw = Math.PI, pitch = -0.14, fov = 68, bossBarY = 90;
let currentCards = [];
const camPv = new THREE.Vector3(); let camSnap = true;

const UPG = [
  { id:'dmg',   jp:'弾', tag:'WAFFE',     name:'Hartplasma-Munition', desc:'+25 % Schaden pro Treffer.', apply:s => { s.dmg *= 1.25; } },
  { id:'rate',  jp:'速', tag:'WAFFE',     name:'Doppelkern-Abzug',    desc:'+20 % Feuerrate.', apply:s => { s.rate *= 1.2; } },
  { id:'shots', jp:'散', tag:'WAFFE',     name:'Split-Kammer',        desc:'SMG +1 Projektil, Schrot +2 Kugeln, Katana +15 % Reichweite.', max:4, apply:s => { s.shots++; } },
  { id:'pierce',jp:'貫', tag:'WAFFE',     name:'Durchschlag-Kern',    desc:'Kugeln durchbohren einen weiteren Gegner.', max:3, apply:s => { s.pierce++; } },
  { id:'ric',   jp:'跳', tag:'WAFFE',     name:'Querschläger-Chip',   desc:'Kugeln prallen einmal mehr von Wänden und Ständen ab.', max:2, apply:s => { s.ricochet++; } },
  { id:'crit',  jp:'眼', tag:'OPTIK',     name:'Zielsuch-Optik',      desc:'+12 % Chance auf kritische Treffer mit 2,5-fachem Schaden.', max:4, apply:s => { s.crit += 0.12; } },
  { id:'hp',    jp:'鎧', tag:'KÖRPER',    name:'Subdermale Panzerung',desc:'+30 maximale HP und sofort volle Heilung.', apply:(s, p) => { s.maxHp += 30; p.hp = s.maxHp; } },
  { id:'regen', jp:'癒', tag:'KÖRPER',    name:'Nano-Reparatur',      desc:'Regeneriert 1,5 HP pro Sekunde.', max:3, apply:s => { s.regen += 1.5; } },
  { id:'speed', jp:'脚', tag:'KÖRPER',    name:'Reflex-Booster',      desc:'+12 % Laufgeschwindigkeit.', max:4, apply:s => { s.speed *= 1.12; } },
  { id:'dash',  jp:'翔', tag:'MOBILITÄT', name:'Dash-Servos',         desc:'Dash lädt 30 % schneller und schneidet durch Gegner.', max:3, apply:s => { s.dashCd *= 0.7; s.dashDmg += 45; } },
  { id:'oc',    jp:'脳', tag:'NEURAL',    name:'Neuro-Overclock',     desc:'Overclock hält 1,5 s länger und lädt 25 % schneller.', max:3, apply:s => { s.ocDur += 1.5; s.ocGain *= 1.25; } }
];
/** Boss banner text. RAZORBACK appears on waves 5, 15, ...; HYDRA-7 on 10, 20, ... */
const BOSSES = { razor: { name:'RAZORBACK', jp:'カミソリ', sub:'Cyberpsycho · Klasse A' }, hydra: { name:'HYDRA-7', jp:'ヒュドラ', sub:'Militärische Kampfdrohne' } };

/* ================= input =================
 * Keyboard, mouse (pointer lock) and touch input. On touch screens the left
 * half is a floating move stick and the right half is look-and-fire.
 */
const keys = new Set();
const mouse = { down: false };
let moveStick = null, lookTouch = null, isTouch = coarse, lockWanted = false;
const locked = () => document.pointerLockElement === cvs;
/** Requests pointer lock for mouse look. Losing it during play pauses the game. */
function requestLock() {
  if (isTouch || !cvs.requestPointerLock) return;
  lockWanted = true;
  try { const r = cvs.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) {}
}
function releaseLock() { lockWanted = false; if (locked()) { try { document.exitPointerLock(); } catch (e) {} } }
document.addEventListener('pointerlockchange', () => { if (!locked() && lockWanted && state === 'play') { lockWanted = false; pauseGame(); } });

addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (state === 'play' && [' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  keys.add(k);
  if (e.repeat) return;
  if (state === 'play') {
    if (k === ' ' || k === 'q' || k === 'e') activateOC();
    if (k === 'shift') dash();
    if (k === '1' || k === '2' || k === '3') setWeapon(+k - 1);
    if (k === 'p' || k === 'escape') pauseGame();
  } else if (state === 'pause' && k === 'p') resume();
  else if (state === 'upgrade' && ['1', '2', '3'].includes(k)) choose(+k - 1);
  else if ((state === 'menu' || state === 'over') && k === 'enter') { e.preventDefault(); startRun(); }
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); mouse.down = false; if (state === 'play') pauseGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'play') pauseGame(); });

/** Mouse look sensitivity in radians per pixel. */
const SENS = 0.0024;
cvs.addEventListener('pointerdown', e => {
  if (state !== 'play') return;
  initAudio();
  if (e.pointerType === 'mouse') {
    isTouch = false;
    if (!locked()) requestLock();
    if (e.button === 0) mouse.down = true;
    if (e.button === 2) activateOC();
    return;
  }
  e.preventDefault(); setTouch(true);
  try { cvs.setPointerCapture(e.pointerId); } catch (err) {}
  if (e.clientX < cssW / 2) { if (!moveStick) moveStick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY }; }
  else if (!lookTouch) lookTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') {
    if (state !== 'play') return;
    if (locked() || mouse.down) { yaw -= e.movementX * SENS; pitch = clamp(pitch - e.movementY * SENS, -0.75, 0.38); }
    return;
  }
  if (moveStick && moveStick.id === e.pointerId) { moveStick.x = e.clientX; moveStick.y = e.clientY; }
  if (lookTouch && lookTouch.id === e.pointerId) {
    yaw -= (e.clientX - lookTouch.x) * 0.0072; pitch = clamp(pitch - (e.clientY - lookTouch.y) * 0.0055, -0.75, 0.38);
    lookTouch.x = e.clientX; lookTouch.y = e.clientY;
  }
});
const endPointer = e => {
  if (e.pointerType === 'mouse') { if (e.button === 0) mouse.down = false; return; }
  if (moveStick && moveStick.id === e.pointerId) moveStick = null;
  if (lookTouch && lookTouch.id === e.pointerId) lookTouch = null;
};
addEventListener('pointerup', endPointer);
addEventListener('pointercancel', endPointer);
cvs.addEventListener('contextmenu', e => e.preventDefault());
/** Normalised vector of a floating touch stick (radius 56 px); drags the origin along. */
function stickVec(st) {
  const R = 56; let dx = st.x - st.ox, dy = st.y - st.oy; const m = Math.hypot(dx, dy);
  if (m > R) { st.ox = st.x - dx / m * R; st.oy = st.y - dy / m * R; dx = dx / m * R; dy = dy / m * R; }
  return { x: dx / R, y: dy / R, m: Math.min(1, m / R) };
}
function setTouch(v) { isTouch = v; $('#touchBtns').hidden = !(v && state === 'play'); }
$('#tDash').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); initAudio(); dash(); });
$('#tOC').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); initAudio(); activateOC(); });
$('#tWeap').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); setWeapon((weaponIdx + 1) % 3); });
addEventListener('wheel', e => { if (state === 'play') setWeapon((weaponIdx + (e.deltaY > 0 ? 1 : 2)) % 3); }, { passive: true });
/** Switches weapon by index and updates the rig and HUD. */
function setWeapon(i) {
  if (!player || player.dead || i === weaponIdx || state !== 'play') return;
  weaponIdx = i; const W = WEAPONS[i];
  rig.gun.visible = !W.melee; rig.kat.visible = !!W.melee;
  player.fireCd = 0.12; sfx.swap(); updateWeaponHud();
  texts.push({ x: player.x, y: 2.5, z: player.z, s: W.name, life: 0.7, max: 0.7, col: CS.y, small: true });
}
function updateWeaponHud() {
  const W = WEAPONS[weaponIdx]; $('#weapJp').textContent = W.jp; $('#weapName').textContent = W.name;
  document.querySelectorAll('#weapSlots i').forEach((n, j) => n.classList.toggle('on', j === weaponIdx));
}

/* ================= UI =================
 * DOM buttons and settings toggles. Settings persist through `store`.
 */
$('#btnStart').addEventListener('click', startRun);
$('#btnAgain').addEventListener('click', startRun);
$('#btnMenu').addEventListener('click', toMenu);
$('#btnResume').addEventListener('click', resume);
$('#btnQuit').addEventListener('click', toMenu);
$('#btnPause').addEventListener('click', () => { if (state === 'play') pauseGame(); });
const btnMute = $('#btnMute');
function syncMute() { btnMute.textContent = muted ? 'TON AUS' : 'TON AN'; if (master) master.gain.value = muted ? 0 : 0.32; }
btnMute.addEventListener('click', () => { initAudio(); muted = !muted; store.set('chromefever-muted', muted); syncMute(); });
syncMute();
function syncQuality() { document.querySelectorAll('#qSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.q === quality))); }
document.querySelectorAll('#qSeg button').forEach(b => b.addEventListener('click', () => { quality = b.dataset.q; store.set('chromefever3d-quality2', quality); setupComposer(); syncQuality(); }));
const btnMusic = $('#btnMusic');
function syncMusic() { btnMusic.textContent = musicOn ? 'Musik an' : 'Musik aus'; btnMusic.setAttribute('aria-pressed', String(musicOn)); if (musicGain) musicGain.gain.value = musicOn ? 0.42 : 0; }
btnMusic.addEventListener('click', () => { initAudio(); musicOn = !musicOn; store.set('chromefever-music', musicOn); startMusic(); syncMusic(); });
/** Shows one overlay panel by selector, or none when `id` is null. */
function show(id) { ['#menu', '#upgrade', '#pause', '#over'].forEach(s => { $(s).hidden = s !== id; }); }

/* ================= run flow =================
 * Run lifecycle: start, waves, upgrade choice, pause, game over and menu.
 */
/** Removes enemies, bullets, pickups and floating texts from the scene. */
function clearWorldEntities() {
  for (const e of enemies) removeEnemy(e);
  for (const c of corpses) removeEnemy(c.e); corpses = [];
  for (const b of bullets) { b.mesh.removeFromParent(); pbPool.push(b.mesh); }
  for (const b of ebullets) releaseEB(b);
  for (const k of pickups) k.mesh.removeFromParent();
  enemies = []; bullets = []; ebullets = []; pickups = []; texts = []; hurtMarks = [];
}
/** Resets stats and state and starts wave 1. */
function startRun() {
  if (state === 'loading') return;
  initAudio(); startMusic();
  clearWorldEntities();
  stats = { dmg: 10, rate: 6.5, shots: 1, spread: 0.06, bspd: 62, pierce: 0, ricochet: 0, crit: 0.08,
            regen: 0, speed: 7.2, maxHp: 100, dashCd: 1.3, dashDmg: 0, ocDur: 4, ocGain: 1 };
  if (!rig) { rig = buildSpriteRig('merc'); scene.add(rig.g); rig.shadow = addShadow(0.55); }
  rig.g.visible = true; rig.shadow.visible = true;
  weaponIdx = 0; rig.gun.visible = true; rig.kat.visible = false; clearDebris(); updateWeaponHud(); rig.sprite.material.rotation = 0; rig.g.position.y = 0;
  player = { x: 0, z: 6, r: 0.42, hp: 100, fireCd: 0, inv: 0, dashCd: 0, dashT: 0, dvx: 0, dvz: 0, vx: 0, vz: 0, ghostT: 0, dead: false, walk: 0 };
  yaw = Math.PI; pitch = -0.2; camSnap = true;
  owned = {}; wave = 0; score = 0; kills = 0; combo = 0; comboT = 0; oc = 0; ocActive = false; ocT = 0; playTime = 0;
  shakeAmt = 0; hitstop = 0; hurtFlash = 0; ocFlash = 0; banner = null; boss = null; clearT = 0; waveDone = false;
  moveStick = lookTouch = null; mouse.down = false;
  show(null); $('#hud').hidden = false; $('#touchBtns').hidden = !isTouch;
  cvs.classList.add('playing');
  state = 'play';
  bossBarY = $('#hud').getBoundingClientRect().bottom + 16;
  requestLock();
  startWave();
}
function toMenu() {
  releaseLock();
  state = 'menu'; ocActive = false; clearWorldEntities(); clearDebris(); boss = null; banner = null;
  if (rig) { rig.g.visible = false; rig.shadow.visible = false; }
  player = null;
  $('#hud').hidden = true; $('#touchBtns').hidden = true; cvs.classList.remove('playing');
  $('#bestMenu').textContent = best.toLocaleString('de-DE');
  show('#menu');
}
/** Builds the spawn queue for wave `n`; tougher enemy types join from waves 2, 3, 4 and 7. */
function buildQueue(n) {
  const q = [], count = Math.min(60, 6 + n * 4);
  for (let i = 0; i < count; i++) {
    const pool = ['ganger', 'ganger'];
    if (n >= 2) pool.push('drone', 'drone');
    if (n >= 3) pool.push('gunner');
    if (n >= 4) pool.push('brute');
    if (n >= 7) pool.push('gunner', 'brute');
    q.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return q;
}
/** Starts the next wave. Every fifth wave is a boss wave with a shorter escort queue. */
function startWave() {
  wave++; waveDone = false; clearT = 0;
  const isBoss = wave % 5 === 0;
  queue = buildQueue(wave);
  spawnEvery = Math.max(0.3, 1.15 - wave * 0.07);
  spawnT = 0.5;
  if (isBoss) {
    const kind = (wave / 5) % 2 === 1 ? 'razor' : 'hydra';
    queue = [kind, ...queue.slice(0, Math.floor(queue.length * 0.4))];
    const b = BOSSES[kind]; showBanner(b.name, b.jp, CS.m, 2.4, b.sub); sfx.boss();
  } else {
    showBanner('Welle ' + pad2(wave), 'ウェーブ' + toKanjiNum(wave), CS.y, 1.8, wave === 1 ? 'Überleb die Nacht' : null); sfx.wave();
  }
}
function toKanjiNum(n) { const d = '〇一二三四五六七八九'; return String(n).split('').map(x => d[+x]).join(''); }
function showBanner(text, jp, col, dur, sub) {
  const lines = []; for (let i = 0; i < 22; i++) lines.push({ y: rand(-1.4, 1.4), x: rand(0, 1), l: rand(0.08, 0.35), w: rand(1, 3) });
  banner = { text, jp, col, dur, sub, t: 0, lines };
}
/** Heals 10 HP, then shows three random cyberware cards that are not yet maxed. */
function waveCleared() {
  waveDone = true;
  player.hp = Math.min(stats.maxHp, player.hp + 10);
  for (const b of ebullets) releaseEB(b); ebullets = [];
  if (ocActive) endOC();
  state = 'upgrade'; releaseLock();
  moveStick = lookTouch = null; mouse.down = false;
  $('#touchBtns').hidden = true; cvs.classList.remove('playing');
  $('#upEyebrow').innerHTML = '<span class="jp">クリア</span>Welle ' + pad2(wave) + ' geschafft';
  const avail = UPG.filter(u => !u.max || (owned[u.id] || 0) < u.max), pick = [];
  while (pick.length < 3 && avail.length) pick.push(avail.splice(Math.floor(Math.random() * avail.length), 1)[0]);
  currentCards = pick;
  const wrap = $('#cards'); wrap.innerHTML = '';
  pick.forEach((u, i) => {
    const lv = (owned[u.id] || 0) + 1, b = document.createElement('button');
    b.type = 'button'; b.className = 'card';
    b.innerHTML = `<span class="kanji" aria-hidden="true">${u.jp}</span><span class="tag"><span class="key">${i + 1}</span>${u.tag}</span>` +
      `<span class="name">${u.name}</span><span class="desc">${u.desc}</span><span class="lvl">${u.max ? 'STUFE ' + lv + ' / ' + u.max : 'STUFE ' + lv}</span>`;
    b.addEventListener('click', () => choose(i));
    wrap.appendChild(b);
  });
  show('#upgrade');
  setTimeout(() => { const f = wrap.querySelector('.card'); if (f && !isTouch) f.focus({ preventScroll: true }); }, 50);
}
/** Applies the chosen upgrade card and starts the next wave. */
function choose(i) {
  if (state !== 'upgrade' || !currentCards[i]) return;
  const u = currentCards[i]; u.apply(stats, player); owned[u.id] = (owned[u.id] || 0) + 1;
  sfx.up(); show(null); state = 'play'; cvs.classList.add('playing'); $('#touchBtns').hidden = !isTouch;
  requestLock(); startWave();
}
function wareList() {
  const ids = Object.keys(owned);
  if (!ids.length) return '<p class="ware-empty">Noch keine. Überleb die erste Welle.</p>';
  return '<ul class="ware">' + ids.map(id => { const u = UPG.find(x => x.id === id); return `<li>${u.name}${owned[id] > 1 ? ' ×' + owned[id] : ''}</li>`; }).join('') + '</ul>';
}
function pauseGame() {
  if (state !== 'play') return;
  state = 'pause'; mouse.down = false; moveStick = lookTouch = null; releaseLock();
  $('#pauseWare').innerHTML = wareList(); show('#pause'); cvs.classList.remove('playing');
}
function resume() { if (state !== 'pause') return; show(null); state = 'play'; cvs.classList.add('playing'); requestLock(); }
/** Starts the death sequence; `showOver()` follows after `dyingT`. */
function gameOver() {
  state = 'dying'; dyingT = 1.6; ocActive = false; releaseLock();
  player.dead = true;
  burst(player.x, 1.2, player.z, 70, 9, C.y, 0.9); burst(player.x, 1.2, player.z, 40, 6, C.c, 0.8);
  star(player.x, 1.3, player.z, 3); spawnDebris(player.x, 1.2, player.z, C.y, 12, 0.22, 7); ring(player.x, 0.1, player.z, 0.3, 6, C.y, 0.6);
  addShake(28); sfx.boom();
  $('#touchBtns').hidden = true; cvs.classList.remove('playing');
}
/** Shows the result screen and stores a new best score. */
function showOver() {
  state = 'over';
  const isBest = score > best; if (isBest) { best = score; store.set('chromefever3d-best', best); }
  $('#newBest').hidden = !isBest;
  $('#oScore').textContent = score.toLocaleString('de-DE'); $('#oWave').textContent = wave; $('#oKills').textContent = kills;
  $('#oTime').textContent = Math.floor(playTime / 60) + ':' + pad2(Math.floor(playTime % 60));
  $('#bestOver').textContent = best.toLocaleString('de-DE'); $('#overWare').innerHTML = wareList();
  $('#hud').hidden = true; show('#over');
}

/* ================= abilities =================
 * Player movement input, dash and Overclock.
 */
/** Returns the camera-relative move direction from keys or the touch stick. */
function moveInput() {
  let ix = 0, iz = 0;
  if (moveStick) { const v = stickVec(moveStick); ix = v.x; iz = -v.y; }
  else {
    if (keys.has('w') || keys.has('arrowup')) iz += 1; if (keys.has('s') || keys.has('arrowdown')) iz -= 1;
    if (keys.has('a') || keys.has('arrowleft')) ix -= 1; if (keys.has('d') || keys.has('arrowright')) ix += 1;
  }
  const m = Math.hypot(ix, iz); if (m > 1) { ix /= m; iz /= m; }
  const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
  return { x: fx * iz + rx * ix, z: fz * iz + rz * ix, m: Math.min(1, m) };
}
/** Short invulnerable dash in the move direction (or forward). */
function dash() {
  const p = player; if (!p || p.dead || p.dashCd > 0 || p.dashT > 0 || state !== 'play') return;
  let v = moveInput();
  if (v.m < 0.2) v = { x: Math.sin(yaw), z: Math.cos(yaw), m: 1 };
  const l = Math.hypot(v.x, v.z) || 1;
  p.dvx = v.x / l * 22; p.dvz = v.z / l * 22; p.dashT = 0.18; p.dashCd = stats.dashCd; dashId++;
  sfx.dash(); addShake(3); fov += 8; speedT = 0.28;
  for (let i = 0; i < 16; i++) emit(p.x, rand(0.2, 1.6), p.z, -p.dvx * rand(0.05, 0.25) + rand(-2, 2), rand(0, 2), -p.dvz * rand(0.05, 0.25) + rand(-2, 2), 0.35, C.c, 0);
  ring(p.x, 0.08, p.z, 0.3, 2.2, C.c, 0.3);
}
/** Starts Overclock when the meter is full: world time slows, the player does not. */
function activateOC() {
  if (!player || player.dead || ocActive || oc < 100 || state !== 'play') return;
  ocActive = true; ocT = stats.ocDur; oc = 0; ocFlash = 0.35; impactT = 0.06; speedT = 0.5;
  sfx.oc(); addShake(6);
  texts.push({ x: player.x, y: 2.6, z: player.z, s: 'OVERCLOCK', big: true, life: 0.9, max: 0.9, col: CS.y });
  ring(player.x, 0.1, player.z, 0.5, 30, C.m, 0.7);
}
function endOC() { ocActive = false; sfx.ocEnd(); }

/* ================= spawning =================
 * Enemy archetypes and spawning. Stats scale with the wave number; bosses
 * scale with how many boss waves have passed.
 */
/**
 * Enemy archetypes. r = collision radius, hy/hr = hit sphere height and
 * radius, fly = hover height for flying types, score = base points.
 */
const TYPES = {
  ganger: { r: 0.45, hy: 1.05, hr: 0.62, hp: 22,  speed: 4.3, dmg: 12, score: 100, col: C.m, build: () => buildSpriteRig('ganger') },
  drone:  { r: 0.45, hy: 0,    hr: 0.58, hp: 12,  speed: 6.6, dmg: 8,  score: 80,  col: C.c, build: buildDrone, fly: 2.4 },
  gunner: { r: 0.5,  hy: 1.1,  hr: 0.68, hp: 34,  speed: 3.0, dmg: 10, score: 160, col: C.r, build: () => buildSpriteRig('gunner') },
  brute:  { r: 0.95, hy: 1.6,  hr: 1.1,  hp: 140, speed: 2.4, dmg: 26, score: 320, col: C.v, build: () => buildSpriteRig('brute') },
  razor:  { r: 1.25, hy: 2.4,  hr: 1.7,  hp: 1100,speed: 4.4, dmg: 30, score: 6000,col: C.m, build: () => buildSpriteRig('razor'), boss: true },
  hydra:  { r: 1.6,  hy: 0,    hr: 2.0,  hp: 1700,speed: 3.0, dmg: 25, score: 9000,col: C.c, build: buildHydra, boss: true, fly: 4.8 }
};
/** Picks an edge position at least 15 m from the player when possible. */
function spawnPos() {
  let x = 0, z = 0;
  for (let i = 0; i < 8; i++) {
    const side = Math.floor(Math.random() * 4), t = rand(-A + 2, A - 2), e = A - 1.2;
    x = side === 0 ? t : side === 1 ? e : side === 2 ? t : -e; z = side === 0 ? -e : side === 1 ? t : side === 2 ? e : t;
    if (!player || Math.hypot(x - player.x, z - player.z) > 15) break;
  }
  return [x, z];
}
/**
 * Spawns an enemy. Ground enemies drop in from the rooftops.
 * @param {keyof TYPES} type
 * @param {[number, number]} [at] - fixed position (used for boss summons)
 */
function spawn(type, at) {
  const T = TYPES[type];
  const sc = 1 + (wave - 1) * 0.13, bossSc = T.boss ? 1 + (Math.floor(wave / 5) - 1) * 0.7 : sc;
  const [x, z] = at || spawnPos();
  RIM_ON = true; const r = T.build(); RIM_ON = false;
  scene.add(r.g);
  const e = { type, x, z, y: T.fly ? (at ? 2.4 : T.fly + 2) : 0, vx: 0, vz: 0, r: T.r, hy: T.hy, hr: T.hr, fly: T.fly || 0,
    hp: T.hp * bossSc, maxHp: T.hp * bossSc, speed: T.speed * (T.boss ? 1 : Math.min(1.45, 1 + (wave - 1) * 0.03)),
    dmg: T.dmg, score: T.score, col: T.col, boss: !!T.boss, t: rand(0, 10), seed: rand(0, TAU), cd: rand(0.8, 1.8), cd2: 2, cd3: 5,
    flash: 0, flashOn: false, mode: 'chase', mt: 2.4, cAng: 0, spin: 0, dir: Math.random() < 0.5 ? -1 : 1, dashHit: -1, dead: false,
    face: Math.atan2(-x, -z), ph: rand(0, 6), flinch: 0, squash: 0, kick: 0, atk: null, atkT: 0, vy: 0, kx: 0, kz: 0, rig: r, mesh: r.g, mats: r.mats, shadow: addShadow(T.r * 1.1), tele: null };
  if (type === 'brute' || type === 'razor') {
    const w = T.r * 2, len = T.boss ? 30 : 13;
    const g = new THREE.PlaneGeometry(w, len); g.translate(0, len / 2, 0); g.rotateX(Math.PI / 2);
    e.tele = new THREE.Mesh(g, basic(C.r, { transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }));
    e.tele.position.y = 0.04; e.tele.visible = false; scene.add(e.tele);
  }
  if (!T.fly && !at) { e.y = T.boss ? 16 : 7.5; const l = Math.hypot(x, z) || 1; e.vx = -x / l * 2.5; e.vz = -z / l * 2.5; }
  e.mesh.position.set(x, e.y, z); e.mesh.rotation.y = e.face;
  enemies.push(e);
  if (!at) { ring(x, 0.08, z, 0.2, 2.5, T.col, 0.45); for (let i = 0; i < 10; i++) emit(x, 0.2, z, rand(-1, 1), rand(3, 7), rand(-1, 1), 0.5, T.col, 6); sfx.spawn(); }
  if (e.boss) boss = e;
  return e;
}
/** Removes an enemy's objects from the scene and frees its materials. */
function removeEnemy(e) {
  e.mesh.removeFromParent(); e.shadow.removeFromParent();
  if (e.tele) { e.tele.removeFromParent(); e.tele.geometry.dispose(); e.tele.material.dispose(); }
  for (const m of e.mats) m.dispose();
  if (e.rig && e.rig.sprite) e.rig.sprite.material.dispose();
}

/* ================= collisions =================
 * Circle-vs-AABB collision against `OBST` and the arena walls.
 */
/**
 * Pushes a circle at (o.x, o.z) with radius r out of obstacles and arena walls.
 * @returns {{nx: number, nz: number} | null} last contact normal, used for ricochets
 */
function collide(o, r) {
  let hit = null;
  for (const b of OBST) {
    const cx = clamp(o.x, b.x0, b.x1), cz = clamp(o.z, b.z0, b.z1), dx = o.x - cx, dz = o.z - cz, d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-8) { const d = Math.sqrt(d2), pu = r - d; o.x += dx / d * pu; o.z += dz / d * pu; hit = { nx: dx / d, nz: dz / d }; }
      else {
        const l = o.x - b.x0, rr = b.x1 - o.x, t = o.z - b.z0, bt = b.z1 - o.z, m = Math.min(l, rr, t, bt);
        if (m === l) { o.x = b.x0 - r; hit = { nx: -1, nz: 0 }; } else if (m === rr) { o.x = b.x1 + r; hit = { nx: 1, nz: 0 }; }
        else if (m === t) { o.z = b.z0 - r; hit = { nx: 0, nz: -1 }; } else { o.z = b.z1 + r; hit = { nx: 0, nz: 1 }; }
      }
    }
  }
  const lim = A - r;
  if (o.x < -lim) { o.x = -lim; hit = { nx: 1, nz: 0 }; } if (o.x > lim) { o.x = lim; hit = { nx: -1, nz: 0 }; }
  if (o.z < -lim) { o.z = -lim; hit = { nx: 0, nz: 1 }; } if (o.z > lim) { o.z = lim; hit = { nx: 0, nz: -1 }; }
  return hit;
}
/** Returns the obstacle containing the point (below its height), or null. */
function inObstacle(x, y, z, pad = 0) {
  for (const b of OBST) if (y < b.h && x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return b;
  return null;
}

/* ================= combat =================
 * Shooting, melee, damage, kills, pickups and player damage.
 */
function addShake(v) { shakeAmt = Math.min(30, shakeAmt + (reduceMotion ? v * 0.25 : v)); }
/** Score multiplier: +0.5 per 8 combo kills, capped at x5. */
function comboMult() { return 1 + Math.min(4, Math.floor(combo / 8) * 0.5); }
/** Fires one enemy bullet towards direction (ax, az). */
function shootE(x, y, z, ax, az, spd, col, dmg, r = 0.22, vy = 0) {
  const l = Math.hypot(ax, az) || 1;
  ebullets.push({ x, y, z, vx: ax / l * spd, vy, vz: az / l * spd, r, dmg, life: 7, mesh: ebMesh(col, r) });
}
/** Enemy patterns: aimed fan of `n` bullets and a full radial ring. */
function fan(e, y, n, step, spd, col, dmg = 12) {
  const base = Math.atan2(player.x - e.x, player.z - e.z);
  for (let i = 0; i < n; i++) { const a = base + (i - (n - 1) / 2) * step; shootE(e.x, y, e.z, Math.sin(a), Math.cos(a), spd, col, dmg); }
  sfx.eshot();
}
function radial(e, y, n, spd, col) { const o = rand(0, TAU); for (let i = 0; i < n; i++) { const a = o + i / n * TAU; shootE(e.x, y, e.z, Math.sin(a), Math.cos(a), spd, col, 14, 0.26); } }
function releaseEB(b) { b.mesh.removeFromParent(); (ebPools[b.mesh.userData.key] || (ebPools[b.mesh.userData.key] = [])).push(b.mesh); }

const tmpV = new THREE.Vector3(), camDir = new THREE.Vector3();
/** Ray-casts from the camera to the nearest enemy hit sphere or the ground. */
function aimPoint() {
  const o = camera.position; camera.getWorldDirection(camDir); const d = camDir;
  let bestT = 90;
  for (const e of enemies) {
    if (e.dead) continue;
    const ox = e.x - o.x, oy = e.y + e.hy - o.y, oz = e.z - o.z, t = ox * d.x + oy * d.y + oz * d.z;
    if (t < 2) continue;
    const d2 = ox * ox + oy * oy + oz * oz - t * t, rr = e.hr * 1.15;
    if (d2 < rr * rr && t < bestT) bestT = t;
  }
  if (d.y < -0.001) { const tg = -o.y / d.y; if (tg > 2 && tg < bestT) bestT = tg; }
  return { x: o.x + d.x * bestT, y: o.y + d.y * bestT, z: o.z + d.z * bestT };
}
/** World position of the gun muzzle relative to the player. */
function muzzle() {
  const lx = 0.3, ly = 1.44, lz = 1.02, c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: player.x + lx * c + lz * s, y: ly, z: player.z - lx * s + lz * c };
}
function spawnPB(x, y, z, vx, vy, vz, life, dmg, knock) {
  const mesh = pbMesh(); mesh.position.set(x, y, z); tmpV.set(x + vx, y + vy, z + vz); mesh.lookAt(tmpV);
  bullets.push({ x, y, z, vx, vy, vz, life, dmg, knock, pierce: stats.pierce, ric: stats.ricochet, hit: new Set(), mesh });
}
/** Fires the current weapon; the katana delegates to `slash()`. */
function fire() {
  const W = WEAPONS[weaponIdx], mul = stats.dmg / 10;
  if (W.melee) { slash(W, mul); return; }
  const m = muzzle(), t = aimPoint();
  let dx = t.x - m.x, dy = t.y - m.y, dz = t.z - m.z;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  if (dx * fx + dz * fz < 0.5) { camera.getWorldDirection(camDir); dx = camDir.x; dy = camDir.y; dz = camDir.z; }
  const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
  const shotgun = W.id === 'shotgun', n = W.pellets + (stats.shots - 1) * (shotgun ? 2 : 1);
  for (let i = 0; i < n; i++) {
    const a = shotgun ? rand(-W.spread, W.spread) : (i - (n - 1) / 2) * W.spread + rand(-0.012, 0.012), c = Math.cos(a), sn = Math.sin(a);
    const spd = W.spd * (shotgun ? rand(0.85, 1.1) : 1);
    spawnPB(m.x, m.y, m.z, (dx * c + dz * sn) * spd, (dy + (shotgun ? rand(-0.06, 0.06) : rand(-0.01, 0.01))) * spd, (-dx * sn + dz * c) * spd, W.life, W.dmg * mul, W.knock);
  }
  for (let i = 0; i < (shotgun ? 10 : 3); i++) emit(m.x, m.y, m.z, dx * rand(3, 8) + rand(-1.5, 1.5), dy * 4 + rand(-1, 1.5), dz * rand(3, 8) + rand(-1.5, 1.5), 0.12, C.y, 0);
  muzzleLight.position.set(m.x, m.y, m.z); muzzleLight.intensity = shotgun ? 60 : 28;
  pitch = clamp(pitch + W.kick, -0.75, 0.38); rig.recoil = Math.min(1.2, rig.recoil + (shotgun ? 1 : 0.22)); rig.aimT = 0.4;
  if (shotgun) { sfx.shotgun(); addShake(5); } else { sfx.shoot(); addShake(0.5); }
}
/** Katana: damages every enemy within reach and the forward arc. */
function slash(W, mul) {
  const p = player, reach = W.reach * (1 + (stats.shots - 1) * 0.15);
  slashT = 0.2; slashDir = -slashDir; rig.swing = 0.2;
  let hits = 0;
  for (const e of enemies) {
    if (e.dead || (e.fly && e.y > 2.9)) continue;
    const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz) || 1;
    if (d > reach + e.r) continue;
    if (Math.abs(angDiff(yaw, Math.atan2(dx, dz))) > W.arc + 0.15) continue;
    const crit = Math.random() < stats.crit;
    damageEnemy(e, W.dmg * mul * (crit ? 2.5 : 1), crit, dx / d * 2.2, dz / d * 2.2, e.x, e.y + e.hy, e.z);
    hits++;
  }
  sfx.slash();
  if (hits) { hitstop = Math.max(hitstop, 0.05); addShake(4); }
}
/** Applies damage, knockback, a damage number and Overclock gain for boss hits. */
function damageEnemy(e, dmg, crit, kx, kz, hx, hy, hz) {
  if (e.dead) return;
  e.hp -= dmg; e.flash = 0.07; e.flinch = e.boss ? 0.06 : 0.16; e.kx = kx; e.kz = kz;
  if (!e.boss) { const k = e.type === 'brute' ? 1 : 3.5; e.vx += kx * k; e.vz += kz * k; }
  texts.push({ x: e.x + rand(-0.3, 0.3), y: e.y + e.hy + e.hr + 0.2, z: e.z, s: String(Math.round(dmg)) + (crit ? '!' : ''), crit, life: 0.6, max: 0.6, col: crit ? CS.y : CS.w });
  for (let i = 0; i < (crit ? 8 : 4); i++) emit(hx, hy, hz, -kx * rand(1, 5) + rand(-3, 3), rand(0, 4), -kz * rand(1, 5) + rand(-3, 3), 0.3, crit ? C.y : e.col, 9);
  if (e.boss && !ocActive) oc = Math.min(100, oc + 0.35 * stats.ocGain);
  sfx.hit();
  if (e.hp <= 0) killEnemy(e);
}
/** Scores a kill with the combo multiplier and may drop a healing injector. */
function killEnemy(e) {
  e.dead = true; kills++; combo++; comboT = 2.6;
  const gained = Math.round(e.score * comboMult()); score += gained;
  if (!ocActive) oc = Math.min(100, oc + (e.boss ? 45 : 5.5) * stats.ocGain);
  const cy = e.y + e.hy, size = e.boss ? 3 : e.type === 'brute' ? 1.6 : 1;
  star(e.x, cy, e.z, 1.6 * size); ring(e.x, 0.08, e.z, 0.3, 3 * size, e.col, 0.4);
  burst(e.x, cy, e.z, 8, 4, e.col, 0.3);
  texts.push({ x: e.x, y: cy + e.hr + 0.6, z: e.z, s: '+' + gained, life: 0.8, max: 0.8, col: CS.c, small: true });
  sfx.kill(); addShake(e.boss ? 26 : e.type === 'brute' ? 7 : 2.5);
  if (e.boss || e.type === 'brute') impactT = e.boss ? 0.09 : 0.05;
  if (e.boss) {
    hitstop = 0.4; for (const b of ebullets) releaseEB(b); ebullets = []; sfx.boom(); boss = null;
    showBanner('Zerstört', '撃破', CS.c, 1.6, '+' + gained.toLocaleString('de-DE') + ' Punkte');
    for (let i = 0; i < 3; i++) addPickup(e.x + rand(-2, 2), e.z + rand(-2, 2));
  } else if (Math.random() < (e.type === 'brute' ? 0.3 : 0.05)) addPickup(e.x, e.z);
}
/** Places a healing injector that expires after 14 s. */
function addPickup(x, z) {
  const o = { x, z }; collide(o, 0.4);
  const g = new THREE.Group(); part(g, cyl(0.16, 0.16, 0.6, 10), pickMat, 0, 0, 0, 0.04); part(g, box(0.34, 0.08, 0.08), pickMat2, 0, 0, 0.17, 0.02); part(g, box(0.08, 0.34, 0.08), pickMat2, 0, 0, 0.17, 0.02);
  g.position.set(o.x, 0.7, o.z); scene.add(g);
  pickups.push({ x: o.x, z: o.z, life: 14, t: rand(0, 6), mesh: g });
}
/** Damages the player unless invulnerable or dashing; halves the combo. */
function hurtPlayer(d, sx, sz) {
  const p = player;
  if (p.inv > 0 || p.dashT > 0 || state !== 'play' || p.dead) return;
  p.hp -= d; p.inv = 0.85; hurtFlash = 0.4; if (d >= 20) impactT = 0.05; addShake(12); sfx.hurt();
  combo = Math.floor(combo / 2);
  burst(p.x, 1.2, p.z, 14, 5, C.r, 0.4);
  texts.push({ x: p.x, y: 2.4, z: p.z, s: '-' + d, life: 0.7, max: 0.7, col: CS.r });
  if (sx !== undefined) hurtMarks.push({ a: Math.atan2(sx - p.x, sz - p.z), life: 1, max: 1 });
  if (p.hp <= 0) { p.hp = 0; gameOver(); }
}

/* ================= update =================
 * Per-frame simulation: player, spawning, enemy AI, boss patterns, bullets,
 * pickups and dying enemies ("corpses").
 */
let corpses = [];
/** Updates an enemy's visual pose (sprite frame, tilt, squash) from its state. */
function animateEnemy(e, dt, rdt, d) {
  const r = e.rig;
  e.flinch = Math.max(0, e.flinch - rdt); e.kick = Math.max(0, e.kick - rdt * 4);
  if (r.sprite) { animSprite(e, dt, rdt); return; }
  if (r.rotors) {
    for (const ro of r.rotors) ro.rotation.y += rdt * 30;
    const fx = Math.sin(e.face), fz = Math.cos(e.face), vf = e.vx * fx + e.vz * fz, vs = e.vx * -fz + e.vz * fx;
    e.mesh.rotation.x += (clamp(vf * 0.06, -0.45, 0.45) - e.mesh.rotation.x) * Math.min(1, rdt * 8);
    e.mesh.rotation.z += (clamp(-vs * 0.07, -0.55, 0.55) - e.mesh.rotation.z) * Math.min(1, rdt * 8);
    return;
  }
  if (r.podG) { r.podG.rotation.y = e.spin * 0.6; r.podG.children.forEach((a, i) => { a.children[1].position.z = 1.95 + Math.max(0, Math.sin(clock * 5 + i * 2.1)) * 0.3; }); return; }
}
/** Plays death animations and removes enemies when they finish. */
function updateCorpses(dt) {
  for (let i = corpses.length - 1; i >= 0; i--) {
    const c = corpses[i], e = c.e; c.t -= dt;
    const k = 1 - Math.max(0, c.t) / c.max;
    if (!e.boss) {
      e.x += e.kx * 7 * dt; e.z += e.kz * 7 * dt; c.vy -= 25 * dt; e.y = Math.max(0, e.y + c.vy * dt);
      e.mesh.rotation.x += c.spin * dt * 0.6; e.mesh.rotation.z += c.spin * dt * 0.4; e.mesh.position.set(e.x, e.y, e.z);
    } else {
      e.mesh.position.x = e.x + rand(-0.15, 0.15); c.boomT -= dt;
      if (c.boomT <= 0) { c.boomT = 0.1; const ox = rand(-1.5, 1.5), oy = rand(0.5, 3.5), oz = rand(-1.5, 1.5); star(e.x + ox, e.y + oy, e.z + oz, 2); burst(e.x + ox, e.y + oy, e.z + oz, 14, 6, e.col, 0.5); sfx.hit(); addShake(4); }
    }
    e.shadow.position.set(e.x, 0.015, e.z);
    const sc = 1 + k * 0.25; e.rig.g.scale.set(sc, sc, sc);
    const fl = Math.floor(k * 12) % 2 === 0; for (const m of e.mats) m.emissive.setHex(fl ? 0xffffff : 0xff2a8a);
    if (e.rig.sprite) { e.rig.sprite.material.color.setScalar(fl ? 4 : 1.4); e.rig.sprite.material.rotation += c.spin * dt * 0.5; }
    if (c.t <= 0) {
      const cy = e.y + e.hy, size = e.boss ? 3 : e.type === 'brute' ? 1.6 : 1;
      burst(e.x, cy, e.z, Math.round(26 * size), 7 * Math.sqrt(size), e.col, 0.7);
      spawnDebris(e.x, cy, e.z, e.col, e.boss ? 26 : e.type === 'brute' ? 12 : 7, e.boss ? 0.55 : e.type === 'brute' ? 0.32 : 0.2, e.boss ? 11 : 6.5);
      ring(e.x, 0.08, e.z, 0.3, 3 * size, e.col, 0.4); star(e.x, cy, e.z, 1.2 * size);
      if (e.boss) { sfx.boom(); addShake(26); }
      removeEnemy(e); corpses.splice(i, 1);
    }
  }
}
/** Eases an enemy's velocity towards (tx, tz) with responsiveness `k`. */
function steer(e, tx, tz, dt, k) { const f = Math.min(1, dt * k); e.vx += (tx - e.vx) * f; e.vz += (tz - e.vz) * f; }
/**
 * One simulation step during play. The player moves in real time (`rdt`);
 * enemies and their bullets use game time (`dt`), which Overclock slows.
 */
function update(rdt) {
  if (hitstop > 0) { hitstop -= rdt; return; }
  playTime += rdt;
  const ts = ocActive ? 0.2 : 1, dt = rdt * ts;
  if (ocActive) { ocT -= rdt; if (ocT <= 0) endOC(); }
  const p = player;

  const mv = moveInput();
  if (p.dashT > 0) {
    p.dashT -= rdt; p.x += p.dvx * rdt; p.z += p.dvz * rdt;
    p.ghostT -= rdt; if (p.ghostT <= 0) { addGhost(false); p.ghostT = 0.025; }
  } else {
    const sp = stats.speed * (ocActive ? 1.3 : 1), f = Math.min(1, rdt * 12);
    p.vx += (mv.x * sp - p.vx) * f; p.vz += (mv.z * sp - p.vz) * f;
    p.x += p.vx * rdt; p.z += p.vz * rdt;
  }
  collide(p, p.r);
  p.walk += rdt * Math.hypot(p.vx, p.vz) * 1.6;

  if (isTouch && lookTouch) {
    let bestA = 0.22, tgt = null;
    for (const e of enemies) { if (e.dead) continue; const d = Math.hypot(e.x - p.x, e.z - p.z); if (d > 30) continue; const a = angDiff(yaw, Math.atan2(e.x - p.x, e.z - p.z)); if (Math.abs(a) < bestA) { bestA = Math.abs(a); tgt = a; } }
    if (tgt !== null) yaw += tgt * Math.min(1, rdt * 5);
  }

  const firing = mouse.down || (isTouch && !!lookTouch);
  p.fireCd = Math.max(0, p.fireCd - rdt);
  if (firing && p.fireCd === 0) { fire(); p.fireCd = 1 / (WEAPONS[weaponIdx].rate * stats.rate / 6.5); }
  if (stats.regen && p.hp < stats.maxHp) p.hp = Math.min(stats.maxHp, p.hp + stats.regen * rdt);
  p.inv = Math.max(0, p.inv - rdt); p.dashCd = Math.max(0, p.dashCd - rdt);
  if (ocActive) { p.ghostT -= rdt; if (p.ghostT <= 0) { addGhost(true); p.ghostT = 0.04; } }

  if (!banner || banner.t > 0.7) {
    spawnT -= dt;
    if (spawnT <= 0 && queue.length) {
      const t = queue.shift();
      spawn(t);
      if (!TYPES[t].boss) {
        const extra = Math.floor(Math.random() * Math.min(3, 1 + wave / 3));
        for (let i = 0; i < extra && queue.length && !TYPES[queue[0]].boss; i++) spawn(queue.shift());
      }
      spawnT = boss && !boss.dead ? spawnEvery * 2.2 : spawnEvery;
    }
  }
  updateEnemies(dt, rdt);
  updateBullets(rdt);
  updateEBullets(dt);
  updatePickups(rdt);
  if (combo > 0) { comboT -= rdt; if (comboT <= 0) combo = 0; }
  if (state === 'play' && !waveDone && !queue.length && !enemies.length) {
    if (clearT <= 0) clearT = 1.1; else { clearT -= rdt; if (clearT <= 0.0001) { clearT = 0; waveCleared(); } }
  }
}

/** Enemy AI per archetype: chase, telegraphed charges, ranged bursts, hover. */
function updateEnemies(dt, rdt) {
  const p = player;
  for (const e of enemies) {
    if (e.dead) continue;
    e.t += dt; e.flash = Math.max(0, e.flash - rdt);
    if (!e.fly && e.y > 0) {
      e.vy -= 26 * dt; e.y += e.vy * dt; e.x += e.vx * dt; e.z += e.vz * dt;
      if (e.y <= 0) {
        e.y = 0; e.vy = 0; e.squash = 0.25;
        ring(e.x, 0.06, e.z, 0.3, e.boss ? 9 : 2.2, e.boss ? C.m : 0x9a8cb4, 0.35); burst(e.x, 0.1, e.z, e.boss ? 40 : 8, e.boss ? 8 : 3, 0x9a8cb4, 0.4);
        if (e.boss) { addShake(22); sfx.boom(); impactT = 0.08; speedT = 0.4; } else if (Math.hypot(e.x - p.x, e.z - p.z) < 10) addShake(1.5);
      }
      collide(e, e.r);
      e.face = Math.atan2(p.x - e.x, p.z - e.z); e.mesh.rotation.y = e.face; e.mesh.position.set(e.x, e.y, e.z);
      e.shadow.position.set(e.x, 0.015, e.z); e.shadow.scale.setScalar(e.r * 1.1 * (1 - Math.min(0.7, e.y / 14)));
      animateEnemy(e, dt, rdt, 99);
      continue;
    }
    const dx = p.x - e.x, dz = p.z - e.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
    switch (e.type) {
      case 'ganger':
        if (e.atk) {
          e.atkT -= dt;
          if (e.atk === 'wind') { steer(e, ux * 1.5, uz * 1.5, dt, 6); if (e.atkT <= 0) { e.atk = 'strike'; e.atkT = 0.14; e.vx = ux * 11; e.vz = uz * 11; e.hitDone = false; sfx.slash(); } }
          else { if (!e.hitDone && d < 1.8 && !p.dead) { e.hitDone = true; hurtPlayer(e.dmg, e.x, e.z); } if (e.atkT <= 0) { e.atk = null; e.cd = rand(0.8, 1.4); } }
        } else {
          steer(e, ux * e.speed, uz * e.speed, dt, 5); e.cd -= dt;
          if (d < 2.6 && e.cd <= 0) { e.atk = 'wind'; e.atkT = 0.3; }
        }
        break;
      case 'drone': {
        const a = Math.atan2(dx, dz) + Math.sin(e.t * 3 + e.seed) * 0.9;
        steer(e, Math.sin(a) * e.speed, Math.cos(a) * e.speed, dt, 4);
        const ty = d < 5 ? 1.15 : 2.4; e.y += (ty - e.y) * Math.min(1, dt * 3);
        break;
      }
      case 'gunner': {
        let tx, tz;
        if (d > 12) { tx = ux; tz = uz; } else if (d < 7) { tx = -ux; tz = -uz; } else { tx = -uz * e.dir; tz = ux * e.dir; }
        steer(e, tx * e.speed, tz * e.speed, dt, 4);
        e.cd -= dt;
        if (e.cd <= 0) {
          e.cd = rand(1.5, 2.3); e.kick = 0.3; star(e.x + Math.sin(e.face) * 0.95, 1.32, e.z + Math.cos(e.face) * 0.95, 0.55);
          if (wave >= 8) fan(e, 1.35, 3, 0.14, 11, C.r, 10); else { shootE(e.x, 1.35, e.z, dx, dz, 11, C.r, 10); sfx.eshot(); }
        }
        break;
      }
      case 'brute':
        if (e.mode === 'chase') {
          steer(e, ux * e.speed, uz * e.speed, dt, 3); e.cd -= dt;
          if (e.cd <= 0 && d < 13) { e.mode = 'wind'; e.mt = 0.75; e.cAng = Math.atan2(dx, dz); }
        } else if (e.mode === 'wind') {
          steer(e, 0, 0, dt, 8); e.mt -= dt;
          if (e.mt <= 0) { e.mode = 'charge'; e.mt = 0.6; e.vx = Math.sin(e.cAng) * 17; e.vz = Math.cos(e.cAng) * 17; }
        } else { e.mt -= dt; if (e.mt <= 0) { e.mode = 'chase'; e.cd = rand(2.5, 4); } }
        break;
      case 'razor': bossRazor(e, dt, dx, dz, ux, uz); break;
      case 'hydra': bossHydra(e, dt); break;
    }
    e.x += e.vx * dt; e.z += e.vz * dt;
    if (e.type === 'hydra') e.y += (e.fly - e.y) * Math.min(1, dt * 1.5);
    else if (e.fly && e.y > 2.6) e.y += (2.4 - e.y) * Math.min(1, dt * 2);
    let h = null;
    if (e.fly && e.y > 1.6) { const lim = A - e.r; e.x = clamp(e.x, -lim, lim); e.z = clamp(e.z, -lim, lim); }
    else h = collide(e, e.r);
    if (h) {
      if (e.mode === 'charge') {
        addShake(e.boss ? 10 : 4); burst(e.x, 1, e.z, 12, 6, C.y, 0.4);
        if (e.type === 'brute') { e.mode = 'chase'; e.cd = rand(2.5, 4); }
        else { const dot = e.vx * h.nx + e.vz * h.nz; e.vx -= 2 * dot * h.nx; e.vz -= 2 * dot * h.nz; }
      } else {
        let tx = -h.nz, tz = h.nx; if (tx * ux + tz * uz < 0) { tx = -tx; tz = -tz; }
        e.vx += tx * e.speed * 0.6; e.vz += tz * e.speed * 0.6;
      }
    }
    if (!p.dead && e.type !== 'hydra') {
      const reach = e.r + p.r - 0.05, yOk = !e.fly || e.y < 1.9;
      if (d < reach && yOk) {
        if (p.dashT > 0 && stats.dashDmg > 0 && e.dashHit !== dashId) { e.dashHit = dashId; damageEnemy(e, stats.dashDmg + stats.dmg * 2, true, -ux, -uz, e.x, e.y + e.hy, e.z); }
        else if (e.type === 'ganger') { const o = reach - d; e.x -= ux * o; e.z -= uz * o; }
        else if (p.inv <= 0 && p.dashT <= 0) {
          hurtPlayer(e.dmg, e.x, e.z);
          if (!e.boss) { e.vx = -ux * 9; e.vz = -uz * 9; }
          p.vx += ux * 10; p.vz += uz * 10;
        }
      }
    }
    const want = e.mode === 'wind' || e.mode === 'charge' ? e.cAng : Math.atan2(dx, dz);
    e.face += angDiff(e.face, want) * Math.min(1, rdt * 10);
    e.mesh.position.set(e.x, e.y + (e.fly ? Math.sin(e.t * 4 + e.seed) * 0.12 : 0), e.z);
    e.mesh.rotation.y = e.face;
    e.shadow.position.set(e.x, 0.015, e.z);
    animateEnemy(e, dt, rdt, d);
    if (e.tele) { e.tele.visible = e.mode === 'wind'; if (e.tele.visible) { e.tele.position.set(e.x, 0.04, e.z); e.tele.rotation.y = e.cAng; e.tele.material.opacity = 0.22 + 0.18 * Math.sin(clock * 30); } }
    const fl = e.flash > 0;
    if (fl !== e.flashOn) { e.flashOn = fl; for (const m of e.mats) m.emissive.setHex(fl ? 0xffffff : m.userData.em); if (e.rig.sprite) e.rig.sprite.material.color.setScalar(fl ? 4 : 1); }
    if (e.boss && e.hp < e.maxHp * 0.5 && !fl) { const on = Math.floor(clock * 6) % 2 === 0; if (e.mats.length) e.mats[0].emissive.setHex(on ? 0x550010 : e.mats[0].userData.em); if (e.rig.sprite) e.rig.sprite.material.color.setRGB(on ? 1.7 : 1, on ? 0.55 : 1, on ? 0.7 : 1); }
  }
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i]; if (a.dead || a.boss) continue;
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j]; if (b.dead || b.boss || (a.fly > 0) !== (b.fly > 0)) continue;
      const dx = b.x - a.x, dz = b.z - a.z, rr = a.r + b.r, d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-4) { const d = Math.sqrt(d2), o = (rr - d) / 2, nx = dx / d, nz = dz / d; a.x -= nx * o; a.z -= nz * o; b.x += nx * o; b.z += nz * o; }
    }
  }
  if (enemies.some(e => e.dead)) enemies = enemies.filter(e => { if (e.dead) { if (e.tele) e.tele.visible = false; corpses.push({ e, t: e.boss ? 0.8 : 0.22, max: e.boss ? 0.8 : 0.22, vy: e.boss ? 0 : 5, spin: rand(-8, 8), boomT: 0 }); return false; } return true; });
}

/** RAZORBACK pattern: dash charges with a telegraph plus bullet fans. */
function bossRazor(e, dt, dx, dz, ux, uz) {
  const enr = e.hp < e.maxHp * 0.5;
  e.spin += dt * (e.mode === 'charge' ? 22 : 5);
  e.mt -= dt;
  if (e.mode === 'chase') {
    steer(e, ux * e.speed * (enr ? 1.3 : 1), uz * e.speed * (enr ? 1.3 : 1), dt, 3);
    e.cd -= dt;
    if (e.cd <= 0) { e.cd = enr ? 0.85 : 1.25; fan(e, 1.4, enr ? 7 : 5, 0.16, 9.5, C.m); }
    if (e.mt <= 0) { e.mode = 'wind'; e.mt = 0.85; e.cAng = Math.atan2(dx, dz); sfx.warn(); }
  } else if (e.mode === 'wind') {
    steer(e, 0, 0, dt, 10);
    e.cAng += angDiff(e.cAng, Math.atan2(dx, dz)) * Math.min(1, dt * 2.2);
    if (e.mt <= 0) { e.mode = 'charge'; e.mt = 0.75; e.vx = Math.sin(e.cAng) * 26; e.vz = Math.cos(e.cAng) * 26; addShake(8); }
  } else if (e.mode === 'charge') {
    emit(e.x, rand(0.5, 3), e.z, -e.vx * 0.2 + rand(-2, 2), rand(0, 2), -e.vz * 0.2 + rand(-2, 2), 0.35, C.m, 2);
    if (e.mt <= 0) { e.mode = 'chase'; e.mt = enr ? 1.8 : 2.7; radial(e, 1.3, enr ? 28 : 18, 7.5, C.y); e.vx *= 0.15; e.vz *= 0.15; addShake(10); sfx.boom(); ring(e.x, 0.1, e.z, 0.5, 7, C.y, 0.5); }
  }
}
/** HYDRA-7 pattern: radial rings, spirals and drone summons. */
function bossHydra(e, dt) {
  const enr = e.hp < e.maxHp * 0.5;
  const tx = Math.cos(e.t * 0.42) * 10, tz = Math.sin(e.t * 0.84) * 7;
  steer(e, (tx - e.x) * 1.2, (tz - e.z) * 1.2, dt, 2);
  e.spin += dt * (enr ? 1.5 : 1.05);
  if (e.y < e.fly - 0.6) return;
  const spiralOn = Math.sin(e.t * 0.9) > -0.35;
  e.cd -= dt;
  if (e.cd <= 0 && spiralOn) {
    e.cd = enr ? 0.11 : 0.14;
    const arms = enr ? 3 : 2;
    for (let k = 0; k < arms; k++) { const a = e.spin + k * TAU / arms; shootE(e.x, e.y - 1, e.z, Math.sin(a), Math.cos(a), 6.5, C.m, 12, 0.24, -1.6); }
  }
  e.cd2 -= dt;
  if (e.cd2 <= 0) { e.cd2 = enr ? 1.8 : 2.6; const b0 = Math.atan2(player.x - e.x, player.z - e.z); for (let i = -1; i <= 1; i++) { const a = b0 + i * 0.16; shootE(e.x, e.y - 1, e.z, Math.sin(a), Math.cos(a), 11, C.c, 12, 0.24, -2.4); } sfx.eshot(); }
  e.cd3 -= dt;
  if (e.cd3 <= 0) { e.cd3 = enr ? 5 : 7; for (let i = 0; i < 3; i++) { const d = spawn('drone', [e.x + rand(-1.5, 1.5), e.z + rand(-1.5, 1.5)]); d.y = e.y - 1; d.vx = rand(-6, 6); d.vz = rand(-6, 6); } }
}

/** Moves player bullets with segment tests against enemies, obstacles and ricochets. */
function updateBullets(rdt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const ox = b.x, oy = b.y, oz = b.z;
    b.x += b.vx * rdt; b.y += b.vy * rdt; b.z += b.vz * rdt; b.life -= rdt;
    let dead = b.life <= 0;
    if (b.y < 0.02) { dead = true; burst(b.x, 0.05, b.z, 3, 3, C.y, 0.2); }
    const ob = !dead && inObstacle(b.x, b.y, b.z);
    const wall = !dead && (Math.abs(b.x) > A || Math.abs(b.z) > A);
    if (ob || wall) {
      if (b.ric > 0) {
        b.ric--; b.hit.clear(); b.life = Math.max(b.life, 0.5);
        if (wall) { if (Math.abs(b.x) > A) b.vx *= -1; else b.vz *= -1; }
        else if (ox > ob.x0 && ox < ob.x1) b.vz *= -1; else b.vx *= -1;
        b.x = ox; b.y = oy; b.z = oz;
        for (let k = 0; k < 4; k++) emit(b.x, b.y, b.z, rand(-3, 3), rand(0, 3), rand(-3, 3), 0.2, C.c, 6);
      } else { dead = true; for (let k = 0; k < 4; k++) emit(ox, oy, oz, rand(-3, 3), rand(0, 3), rand(-3, 3), 0.2, C.y, 6); }
    }
    if (!dead) {
      for (const e of enemies) {
        if (e.dead || b.hit.has(e)) continue;
        const cx = e.x, cy = e.y + e.hy, cz = e.z, r = e.hr;
        const sx = b.x - ox, sy = b.y - oy, sz = b.z - oz, L2 = sx * sx + sy * sy + sz * sz || 1;
        const t = clamp(((cx - ox) * sx + (cy - oy) * sy + (cz - oz) * sz) / L2, 0, 1);
        const qx = ox + sx * t - cx, qy = oy + sy * t - cy, qz = oz + sz * t - cz;
        if (qx * qx + qy * qy + qz * qz < r * r) {
          b.hit.add(e);
          const crit = Math.random() < stats.crit, hl = Math.hypot(b.vx, b.vz) || 1;
          damageEnemy(e, b.dmg * (crit ? 2.5 : 1), crit, b.vx / hl * (b.knock || 1), b.vz / hl * (b.knock || 1), ox + sx * t, oy + sy * t, oz + sz * t);
          if (b.pierce > 0) b.pierce--; else { dead = true; break; }
        }
      }
    }
    if (dead) { b.mesh.removeFromParent(); pbPool.push(b.mesh); bullets.splice(i, 1); }
    else { b.mesh.position.set(b.x, b.y, b.z); tmpV.set(b.x + b.vx, b.y + b.vy, b.z + b.vz); b.mesh.lookAt(tmpV); }
  }
}
/** Moves enemy bullets; the katana can reflect them. */
function updateEBullets(dt) {
  const p = player;
  for (let i = ebullets.length - 1; i >= 0; i--) {
    const b = ebullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; b.life -= dt;
    if (b.y < 1.2 && b.vy < 0) { b.y = 1.2; b.vy = 0; }
    let dead = b.life <= 0 || Math.abs(b.x) > A + 1 || Math.abs(b.z) > A + 1;
    if (!dead && inObstacle(b.x, b.y, b.z)) { dead = true; for (let k = 0; k < 3; k++) emit(b.x, b.y, b.z, rand(-2, 2), rand(0, 2), rand(-2, 2), 0.2, C.m, 6); }
    if (!dead && slashT > 0 && WEAPONS[weaponIdx].melee && !p.dead) {
      const ddx = b.x - p.x, ddz = b.z - p.z, dd = Math.hypot(ddx, ddz);
      if (dd < 3.4 && Math.abs(angDiff(yaw, Math.atan2(ddx, ddz))) < 1.25) {
        camera.getWorldDirection(camDir);
        spawnPB(b.x, Math.max(1, b.y), b.z, camDir.x * 50, camDir.y * 50, camDir.z * 50, 1, 18 * stats.dmg / 10, 1.5);
        for (let k = 0; k < 6; k++) emit(b.x, b.y, b.z, rand(-4, 4), rand(0, 4), rand(-4, 4), 0.25, C.c, 6);
        texts.push({ x: b.x, y: b.y + 0.5, z: b.z, s: 'REFLEKT', life: 0.5, max: 0.5, col: CS.c, small: true });
        sfx.deflect(); releaseEB(b); ebullets.splice(i, 1); continue;
      }
    }
    if (!dead && !p.dead) {
      const dx = b.x - p.x, dz = b.z - p.z, dy = b.y - clamp(b.y, 0.2, 1.9), rr = b.r + 0.36;
      if (dx * dx + dz * dz + dy * dy < rr * rr && p.inv <= 0 && p.dashT <= 0) { hurtPlayer(b.dmg, b.x - b.vx, b.z - b.vz); dead = true; }
    }
    if (dead) { releaseEB(b); ebullets.splice(i, 1); }
    else b.mesh.position.set(b.x, b.y, b.z);
  }
}
/** Bobs pickups and heals the player on contact. */
function updatePickups(rdt) {
  const p = player;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const k = pickups[i]; k.life -= rdt; k.t += rdt;
    const dx = p.x - k.x, dz = p.z - k.z, d = Math.hypot(dx, dz);
    if (d < 4 && d > 0.01) { k.x += dx / d * 8 * rdt; k.z += dz / d * 8 * rdt; }
    k.mesh.position.set(k.x, 0.75 + Math.sin(k.t * 4) * 0.15, k.z); k.mesh.rotation.y += rdt * 3; k.mesh.rotation.z = 0.5;
    k.mesh.visible = !(k.life < 3 && Math.floor(k.life * 8) % 2);
    if (d < 1) {
      p.hp = Math.min(stats.maxHp, p.hp + 15); sfx.heal();
      texts.push({ x: p.x, y: 2.4, z: p.z, s: '+15 HP', life: 0.8, max: 0.8, col: CS.g });
      ring(p.x, 0.1, p.z, 0.3, 1.6, C.g, 0.3);
      k.mesh.removeFromParent(); pickups.splice(i, 1);
    } else if (k.life <= 0) { k.mesh.removeFromParent(); pickups.splice(i, 1); }
  }
}

/* ================= camera & player visuals =================
 * Third-person camera and the player sprite rig.
 */
/** Positions the player sprite and picks its animation frame. */
function updatePlayerRig(rdt) {
  if (!player || !rig) return;
  const p = player, W = WEAPONS[weaponIdx], sp = rig.sprite, F = W.melee ? rig.F.kat : rig.F.gun;
  rig.g.position.x = p.x; rig.g.position.z = p.z;
  rig.shadow.position.set(p.x, 0.015, p.z);
  if (slashT > 0) { slashT -= rdt; const k = Math.max(0, slashT / 0.2); slashG.position.set(p.x, 1.25, p.z); slashG.rotation.y = yaw + slashDir * (k - 0.5) * 0.8; slashMesh.rotation.z = slashDir * 0.35; slashMat.opacity = k * 0.95; slashMesh.scale.setScalar(0.7 + (1 - k) * 0.45); } else slashMat.opacity = 0;
  if (p.dead) {
    rig.g.visible = true; if (sp.material.map !== F.idle[0]) sp.material.map = F.idle[0];
    sp.material.rotation += (1.45 - sp.material.rotation) * Math.min(1, rdt * 5); rig.g.position.y += (-0.3 - rig.g.position.y) * Math.min(1, rdt * 5);
    return;
  }
  const fx = Math.sin(yaw), fz = Math.cos(yaw), ref = stats.speed;
  const vf = (p.vx * fx + p.vz * fz) / ref, vs = (p.vx * -fz + p.vz * fx) / ref, amt = Math.min(1.2, Math.hypot(vf, vs));
  p.walk += rdt * (2 + amt * 10);
  rig.recoil *= Math.exp(-rdt * 14); rig.aimT = Math.max(0, rig.aimT - rdt); if (rig.swing > 0) rig.swing -= rdt;
  const moving = amt > 0.15, wi = Math.floor((p.walk % TAU) / TAU * 6) % 6;
  let tex;
  if (p.dashT > 0) tex = F.dash[0];
  else if (W.melee && rig.swing > 0) tex = F.slash[rig.swing > 0.1 ? 0 : 1];
  else if (!W.melee && rig.aimT > 0) tex = moving ? F.walkAim[wi] : F.shoot[0];
  else if (moving) tex = F.walk[wi];
  else tex = F.idle[Math.floor(clock * 1.6) % 2];
  if (sp.material.map !== tex) sp.material.map = tex;
  const tilt = clamp(-vs * 0.08, -0.12, 0.12) + (p.dashT > 0 ? 0.1 * Math.sign(-vs || 1) : 0);
  sp.material.rotation += (tilt - sp.material.rotation) * Math.min(1, rdt * 10);
  const kick = rig.recoil * 0.03; sp.scale.set(rig.base.x * (1 + kick), rig.base.y * (1 - kick * 0.5), 1);
  rig.g.position.y = 0;
  rig.g.visible = !(p.inv > 0 && Math.floor(clock * 20) % 2);
}
/** Over-the-shoulder camera with smoothing, shake and FOV kick; orbits in the menu. */
function updateCamera(rdt) {
  let px = 0, pz = 0;
  if (player) { px = player.x; pz = player.z; }
  const attract = state === 'menu' || state === 'loading';
  if (attract) { yaw += rdt * 0.08; pitch = -0.22; px = Math.sin(clock * 0.1) * 4; pz = Math.cos(clock * 0.13) * 4; }
  if (state === 'dying') yaw += rdt * 0.5;
  const cp = Math.cos(pitch), f = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
  const rx = -Math.cos(yaw), rz = Math.sin(yaw), sh = 0.9;
  const tpx = px + rx * sh, tpz = pz + rz * sh;
  if (camSnap || attract) { camPv.set(tpx, 2.1, tpz); camSnap = false; }
  else { const kk = 1 - Math.exp(-rdt * 18); camPv.x += (tpx - camPv.x) * kk; camPv.z += (tpz - camPv.z) * kk; }
  const pvx = camPv.x, pvy = 2.1 + (rig && player && !player.dead ? rig.g.position.y * 0.3 : 0), pvz = camPv.z;
  const dist = attract ? 9 : cssW < cssH ? 6.4 : 5.4;
  let cx = 0, cy = 0, cz = 0;
  for (let d = dist; d > 1.2; d -= 0.25) {
    cx = pvx - f.x * d; cy = Math.max(0.35, pvy - f.y * d); cz = pvz - f.z * d;
    if (!inObstacle(cx, cy, cz, 0.25) && Math.abs(cx) < A + 0.6 && Math.abs(cz) < A + 0.6) break;
  }
  const s = shakeAmt * 0.012;
  camera.position.set(cx + rand(-s, s), cy + rand(-s, s), cz + rand(-s, s));
  camera.lookAt(pvx + f.x * 14, pvy + f.y * 14, pvz + f.z * 14);
  const targetFov = ocActive ? 78 : 68;
  fov += (targetFov - fov) * Math.min(1, rdt * 6);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

/* ================= overlay (2D) =================
 * The `#fx` canvas drawn on top of WebGL: damage numbers, wave banners,
 * boss bar, crosshair, radar, hit direction markers and the touch stick.
 */
const proj = new THREE.Vector3();
/** Projects a world point to overlay pixels; null when behind the camera. */
function toScreen(x, y, z) { proj.set(x, y, z).project(camera); if (proj.z > 1) return null; return { x: (proj.x + 1) / 2 * cssW, y: (1 - proj.y) / 2 * cssH }; }
function oink(lw) { octx.lineWidth = lw; octx.strokeStyle = CS.ink; octx.lineJoin = 'round'; }
/** Draws floating damage numbers and labels. */
function drawTexts() {
  octx.textAlign = 'center'; octx.textBaseline = 'middle';
  for (const t of texts) {
    const s = toScreen(t.x, t.y + (1 - t.life / t.max) * 0.8, t.z); if (!s) continue;
    const k = t.life / t.max; octx.globalAlpha = Math.min(1, k * 2.5);
    const size = t.big ? 46 : t.crit ? 26 : t.small ? 15 : 19, pop = t.big ? 1 + (1 - k) * 0.3 : 1;
    octx.font = `900 ${size * pop}px ${FD}`; oink(t.big ? 7 : 4);
    if (t.big) { octx.fillStyle = CS.m; octx.fillText(t.s, s.x + 3, s.y + 3); }
    octx.strokeText(t.s, s.x, s.y); octx.fillStyle = t.col; octx.fillText(t.s, s.x, s.y);
  }
  octx.globalAlpha = 1;
}
/** Draws the slanted anime wave/boss banner with speed lines. */
function drawBanner() {
  const b = banner, t = b.t, d = b.dur, inT = 0.24, outT = 0.3, ease = x => 1 - Math.pow(1 - x, 3);
  let off = 0;
  if (t < inT) off = -(1 - ease(t / inT)) * cssW * 1.1; else if (t > d - outT) off = ease((t - (d - outT)) / outT) * cssW * 1.1;
  const cy = cssH * 0.38, h = clamp(cssW * 0.17, 70, 120), tilt = Math.min(30, cssW * 0.03);
  octx.save(); octx.translate(off, 0);
  octx.fillStyle = CS.w; octx.globalAlpha = 0.85;
  for (const l of b.lines) octx.fillRect(((l.x + t * 2.2) % 1.3 - 0.2) * cssW, cy + l.y * h, l.l * cssW, l.w);
  octx.globalAlpha = 1;
  octx.beginPath(); octx.moveTo(-30, cy - h / 2 + tilt / 2); octx.lineTo(cssW + 30, cy - h / 2 - tilt / 2); octx.lineTo(cssW + 30, cy + h / 2 - tilt / 2); octx.lineTo(-30, cy + h / 2 + tilt / 2); octx.closePath();
  octx.fillStyle = CS.ink; octx.save(); octx.translate(8, 8); octx.fill(); octx.restore();
  octx.fillStyle = b.col; octx.fill(); oink(5); octx.stroke();
  octx.save(); octx.translate(cssW / 2, cy); octx.rotate(-Math.atan2(tilt, cssW + 60));
  octx.font = `900 ${h * 0.78}px ${FD}`; octx.textAlign = 'center'; octx.textBaseline = 'middle';
  const txt = b.text.toUpperCase();
  octx.fillStyle = b.col === CS.y ? CS.m : CS.y; octx.fillText(txt, 4, 4); octx.fillStyle = CS.ink; octx.fillText(txt, 0, 0);
  octx.font = `900 ${Math.round(h * 0.26)}px ${FJ}`;
  const jw = octx.measureText(b.jp).width + 20, jh = h * 0.36;
  octx.fillStyle = CS.ink; octx.fillRect(-cssW * 0.32 - jw / 2, -h / 2 - jh * 0.75, jw, jh);
  octx.fillStyle = CS.r; octx.fillText(b.jp, -cssW * 0.32, -h / 2 - jh * 0.75 + jh / 2 + 1);
  if (b.sub) {
    octx.font = `700 ${Math.round(clamp(h * 0.2, 13, 20))}px "Chakra Petch", sans-serif`;
    const sub = b.sub.toUpperCase(), sw = octx.measureText(sub).width + 24, sh = h * 0.3;
    octx.fillStyle = CS.ink; octx.fillRect(cssW * 0.18 - sw / 2, h / 2 + 4, sw, sh);
    octx.fillStyle = CS.w; octx.fillText(sub, cssW * 0.18, h / 2 + 4 + sh / 2 + 1);
  }
  octx.restore(); octx.restore();
}
function drawBossBar() {
  const e = boss; if (!e || e.dead) return;
  const w = Math.min(520, cssW - 32), x = (cssW - w) / 2, y = bossBarY, h = 14, info = BOSSES[e.type];
  octx.font = `900 22px ${FD}`; octx.textAlign = 'left'; octx.textBaseline = 'bottom';
  oink(4); octx.strokeText(info.name, x, y - 2); octx.fillStyle = CS.w; octx.fillText(info.name, x, y - 2);
  octx.font = `900 14px ${FJ}`; octx.textAlign = 'right'; octx.fillStyle = CS.m; octx.strokeText(info.jp, x + w, y - 4); octx.fillText(info.jp, x + w, y - 4);
  const sk = 8, k = Math.max(0, e.hp / e.maxHp);
  const para = (px, pw) => { octx.beginPath(); octx.moveTo(px + sk, y); octx.lineTo(px + pw, y); octx.lineTo(px + pw - sk, y + h); octx.lineTo(px, y + h); octx.closePath(); };
  para(x, w); octx.fillStyle = 'rgba(7,5,12,0.85)'; octx.fill();
  if (k > 0) { para(x, Math.max(sk + 2, w * k)); octx.fillStyle = k < 0.5 ? CS.r : CS.m; octx.fill(); }
  octx.fillStyle = 'rgba(7,5,12,0.6)'; for (let i = 1; i < 10; i++) octx.fillRect(x + w * i / 10, y, 2, h);
  para(x, w); oink(3); octx.stroke();
}
function drawCrosshair() {
  const x = cssW / 2, y = cssH / 2, r = 11 + (mouse.down || lookTouch ? 0 : 3);
  octx.save(); octx.translate(x, y); octx.rotate(clock * 1.5);
  for (const [lw, col] of [[5, CS.ink], [2.5, CS.y]]) { octx.lineWidth = lw; octx.strokeStyle = col; for (let i = 0; i < 4; i++) { octx.beginPath(); octx.arc(0, 0, r, i * Math.PI / 2 + 0.25, i * Math.PI / 2 + 1.3); octx.stroke(); } }
  octx.restore(); octx.fillStyle = CS.m; octx.fillRect(x - 2, y - 2, 4, 4);
  if (player && stats && player.dashCd > 0) { octx.strokeStyle = 'rgba(44,246,255,.8)'; octx.lineWidth = 3; octx.beginPath(); octx.arc(x, y, r + 9, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - player.dashCd / stats.dashCd)); octx.stroke(); }
}
/** Draws the radar in the bottom-right corner, rotated with the camera. */
function drawRadar() {
  if (!player) return;
  const R = isTouch ? 50 : 64, cx = cssW - R - 16, cy = cssH - R - (isTouch ? 110 : 24), range = 30;
  octx.save();
  octx.fillStyle = 'rgba(7,5,12,.72)'; octx.beginPath(); octx.arc(cx, cy, R, 0, TAU); octx.fill();
  oink(3); octx.stroke(); octx.strokeStyle = 'rgba(44,246,255,.35)'; octx.lineWidth = 1; octx.beginPath(); octx.arc(cx, cy, R * 0.5, 0, TAU); octx.stroke();
  octx.beginPath(); octx.moveTo(cx, cy); octx.arc(cx, cy, R, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); octx.closePath(); octx.fillStyle = 'rgba(44,246,255,.12)'; octx.fill();
  const fx2 = Math.sin(yaw), fz2 = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
  octx.save(); octx.beginPath(); octx.arc(cx, cy, R - 2, 0, TAU); octx.clip();
  for (const e of enemies) {
    const dx = e.x - player.x, dz = e.z - player.z, lx = dx * rx + dz * rz, lf = dx * fx2 + dz * fz2;
    let sx = lx / range * R, sy = -lf / range * R; const m = Math.hypot(sx, sy); if (m > R - 5) { sx *= (R - 5) / m; sy *= (R - 5) / m; }
    octx.fillStyle = '#' + e.col.toString(16).padStart(6, '0'); octx.beginPath(); octx.arc(cx + sx, cy + sy, e.boss ? 6 : 3, 0, TAU); octx.fill();
  }
  for (const k of pickups) { const dx = k.x - player.x, dz = k.z - player.z; octx.fillStyle = CS.g; octx.fillRect(cx + (dx * rx + dz * rz) / range * R - 2, cy - (dx * fx2 + dz * fz2) / range * R - 2, 4, 4); }
  octx.restore();
  octx.fillStyle = CS.y; octx.beginPath(); octx.moveTo(cx, cy - 6); octx.lineTo(cx + 4.5, cy + 4); octx.lineTo(cx - 4.5, cy + 4); octx.closePath(); octx.fill();
  octx.font = `700 10px "Chakra Petch", sans-serif`; octx.textAlign = 'center'; octx.textBaseline = 'middle'; octx.fillStyle = CS.w; octx.fillText('RADAR', cx, cy + R + 10);
  octx.restore();
}
/** Draws red markers pointing to where recent damage came from. */
function drawHurtMarks(rdt) {
  const cx = cssW / 2, cy = cssH / 2, R = Math.min(cssW, cssH) * 0.3;
  for (let i = hurtMarks.length - 1; i >= 0; i--) {
    const h = hurtMarks[i]; h.life -= rdt; if (h.life <= 0) { hurtMarks.splice(i, 1); continue; }
    const rel = angDiff(yaw, h.a), a = -Math.PI / 2 - rel;
    octx.globalAlpha = h.life / h.max; octx.fillStyle = CS.r;
    octx.beginPath(); octx.arc(cx, cy, R + 14, a - 0.28, a + 0.28); octx.arc(cx, cy, R, a + 0.22, a - 0.22, true); octx.closePath(); octx.fill(); oink(2); octx.stroke();
  }
  octx.globalAlpha = 1;
}
function drawStick(st, col) {
  const v = stickVec(st);
  octx.globalAlpha = 0.35; octx.strokeStyle = col; octx.lineWidth = 3; octx.beginPath(); octx.arc(st.ox, st.oy, 56, 0, TAU); octx.stroke();
  octx.globalAlpha = 0.75; octx.fillStyle = col; octx.beginPath(); octx.arc(st.ox + v.x * 56, st.oy + v.y * 56, 24, 0, TAU); octx.fill(); oink(3); octx.stroke(); octx.globalAlpha = 1;
}
function drawSpeedLines(a) {
  const cx = cssW / 2, cy = cssH / 2, R0 = Math.min(cssW, cssH) * 0.3, R1 = Math.hypot(cssW, cssH) * 0.62;
  octx.save(); octx.globalAlpha = a; octx.fillStyle = CS.w;
  for (let i = 0; i < 70; i++) {
    const ang = rand(0, TAU), w = rand(0.004, 0.013), r0 = R0 * rand(0.9, 1.5);
    octx.beginPath(); octx.moveTo(cx + Math.cos(ang - w) * R1, cy + Math.sin(ang - w) * R1); octx.lineTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0); octx.lineTo(cx + Math.cos(ang + w) * R1, cy + Math.sin(ang + w) * R1); octx.fill();
  }
  octx.restore();
}
let scanPat = null;
/** Redraws the whole 2D overlay for this frame. */
function overlay(rdt) {
  octx.setTransform(ODPR, 0, 0, ODPR, 0, 0);
  octx.clearRect(0, 0, cssW, cssH);
  if (!scanPat) { const sc = document.createElement('canvas'); sc.width = 4; sc.height = 4; const g = sc.getContext('2d'); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, 4, 1); scanPat = octx.createPattern(sc, 'repeat'); }
  if (state === 'play' || state === 'pause' || state === 'upgrade' || state === 'dying') drawTexts();
  if (ocActive && !fxPass) {
    const hue = (clock * 240) % 360, ew = Math.min(110, cssW * 0.14);
    octx.fillStyle = `hsla(${hue},100%,60%,0.07)`; octx.fillRect(0, 0, cssW, cssH);
    const edge = (x0, y0, x1, y1, h2) => { const g = octx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, `hsla(${h2},100%,60%,0.45)`); g.addColorStop(1, `hsla(${h2},100%,60%,0)`); return g; };
    octx.fillStyle = edge(0, 0, ew, 0, hue); octx.fillRect(0, 0, ew, cssH);
    octx.fillStyle = edge(cssW, 0, cssW - ew, 0, hue + 120); octx.fillRect(cssW - ew, 0, ew, cssH);
    octx.fillStyle = edge(0, 0, 0, ew, hue + 60); octx.fillRect(0, 0, cssW, ew);
    octx.fillStyle = edge(0, cssH, 0, cssH - ew, hue + 200); octx.fillRect(0, cssH - ew, cssW, ew);
    octx.fillStyle = scanPat; octx.fillRect(0, 0, cssW, cssH);
  }
  if (ocFlash > 0) { octx.fillStyle = `rgba(255,255,255,${ocFlash * 1.6})`; octx.fillRect(0, 0, cssW, cssH); }
  const vig = (a) => { const g = octx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35, cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.72); g.addColorStop(0, 'rgba(255,61,61,0)'); g.addColorStop(1, `rgba(255,61,61,${a})`); octx.fillStyle = g; octx.fillRect(0, 0, cssW, cssH); };
  if (hurtFlash > 0 && !fxPass) vig(hurtFlash);
  if (player && stats && !player.dead && player.hp / stats.maxHp < 0.3 && state === 'play') vig(0.18 + 0.12 * Math.sin(clock * 6));
  if (speedT > 0 && !reduceMotion) drawSpeedLines(Math.min(0.55, speedT * 2));
  if (state === 'play') { drawHurtMarks(rdt); drawCrosshair(); drawRadar(); if (moveStick) drawStick(moveStick, CS.c); }
  if (state === 'play' || state === 'pause' || state === 'upgrade') drawBossBar();
  if (banner) drawBanner();
}

/* ================= HUD =================
 * DOM HUD updates. `setText()` skips writes when the value is unchanged.
 */
const el = { hpFill: $('#hpFill'), hpText: $('#hpText'), hpBar: $('#hpBar'), ocFill: $('#ocFill'), ocLabel: $('#ocLabel'), ocBar: $('#ocBar'), score: $('#scoreEl'), combo: $('#comboEl'), wave: $('#waveEl'), tOC: $('#tOC'), tDash: $('#tDash') };
const hudCache = {};
function setText(node, key, v) { if (hudCache[key] !== v) { hudCache[key] = v; node.textContent = v; } }
/** Writes HP, Overclock, score, combo and wave into the DOM HUD. */
function hud() {
  if (!player || !stats) return;
  const hpK = player.hp / stats.maxHp;
  el.hpFill.style.width = (hpK * 100).toFixed(1) + '%'; el.hpBar.classList.toggle('low', hpK < 0.3);
  setText(el.hpText, 'hp', Math.ceil(player.hp) + ' / ' + stats.maxHp);
  const ready = !ocActive && oc >= 100;
  el.ocFill.style.width = (ocActive ? ocT / stats.ocDur * 100 : oc).toFixed(1) + '%';
  el.ocBar.classList.toggle('ready', ready); el.ocBar.classList.toggle('active', ocActive);
  setText(el.ocLabel, 'oc', ocActive ? 'OVERCLOCK AKTIV · ' + ocT.toFixed(1) + ' s' : ready ? 'OVERCLOCK BEREIT · ' + (isTouch ? 'OC TIPPEN' : 'LEERTASTE') : 'OVERCLOCK ' + Math.floor(oc) + ' %');
  setText(el.score, 'score', score.toLocaleString('de-DE'));
  el.combo.hidden = combo < 2; setText(el.combo, 'combo', combo + ' KILLS · ×' + comboMult().toFixed(1));
  setText(el.wave, 'wave', (wave % 5 === 0 ? 'BOSS · ' : '') + 'WELLE ' + pad2(wave));
  el.tOC.classList.toggle('ready', ready); el.tDash.classList.toggle('cool', player.dashCd > 0);
}

/* ================= loop =================
 * Main loop and start-up. Fonts are awaited briefly so canvas-drawn signs
 * use the right typefaces, then the world is built and the menu unlocks.
 */
let last = performance.now();
/** requestAnimationFrame callback: simulate, animate effects, render, draw overlay. */
function frame(now) {
  const rdt = Math.min(0.05, (now - last) / 1000); last = now;
  clock += rdt;
  if (state === 'play') update(rdt);
  if (state === 'dying') { dyingT -= rdt; updateEnemies(rdt * 0.15, rdt * 0.15); updateEBullets(rdt * 0.15); if (dyingT <= 0) showOver(); }
  const frozen = state === 'pause' || state === 'upgrade';
  if (!frozen) {
    const fxDt = (ocActive ? 0.25 : 1) * (state === 'dying' ? 0.5 : 1) * rdt;
    if (banner) { banner.t += rdt; if (banner.t > banner.dur) banner = null; }
    updateParticles(fxDt); updateFxObjects(rdt, fxDt); updateGhosts(rdt); updateDebris(fxDt); updateCorpses(fxDt); updateWorldAnim(rdt, fxDt);
    for (let i = texts.length - 1; i >= 0; i--) { texts[i].life -= rdt; if (texts[i].life <= 0) texts.splice(i, 1); }
    shakeAmt = Math.max(0, shakeAmt - rdt * 40); hurtFlash = Math.max(0, hurtFlash - rdt); ocFlash = Math.max(0, ocFlash - rdt);
    updateRain(fxDt, camera.position.x, camera.position.z);
    rainMat.color.setHex(ocActive ? 0xff7ac8 : 0xa8dcff);
    updatePlayerRig(rdt); updateCamera(rdt);
  }
  if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
  if (inkPass) { const pr = renderer.getPixelRatio(); inkPass.uniforms.uRes.value.set(cssW * pr, cssH * pr); inkPass.uniforms.uThick.value = Math.max(1.2, pr * 1.3); }
  impactT = Math.max(0, impactT - rdt); speedT = Math.max(0, speedT - rdt);
  if (composer) {
    if (inkPass) inkPass.uniforms.tDepth.value = composer.readBuffer.depthTexture;
    if (fxPass) { const u = fxPass.uniforms; u.uTime.value = clock; u.uImpact.value = impactT > 0 ? 1 : 0; u.uOC.value += ((ocActive ? 1 : 0) - u.uOC.value) * Math.min(1, rdt * 8); u.uHurt.value = Math.min(1, hurtFlash * 2); }
    composer.render(rdt);
  } else renderer.render(scene, camera);
  updateMusic();
  overlay(rdt);
  if (state === 'play' || state === 'dying') hud();
  requestAnimationFrame(frame);
}

addEventListener('resize', resize);
resize();
setupComposer(); syncQuality(); syncMusic();
const fontsReady = document.fonts ? Promise.race([Promise.all([document.fonts.load('900 40px "Noto Sans JP"', '夜市電脳'), document.fonts.load('900 40px "Big Shoulders Display"')]), new Promise(r => setTimeout(r, 2500))]) : Promise.resolve();
fontsReady.catch(() => {}).finally(() => {
  buildWorld(); setupComposer();
  for (const k of Object.keys(SPEC)) if (!SPRITES[k]) SPRITES[k] = makeFrames(k);
  state = 'menu';
  const b = $('#btnStart'); b.disabled = false; b.textContent = 'Run starten';
});
requestAnimationFrame(frame);
