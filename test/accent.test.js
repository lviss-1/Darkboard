/**
 * accent.test.js — property sweep over the accent derivation.
 *
 *   node test/accent.test.js
 *
 * The first test in this repo that is not a browser fixture, and the
 * departure earns itself: src/accent.js is pure, so it can be swept over
 * hundreds of colours in a second. A fixture can show you one ramp. This
 * shows you that the rules hold across the whole space a real institution
 * colour might land in — which is the only claim worth making, since the
 * schools it has to work for are ones nobody here can look at.
 *
 * The rule is: for every input, the ramp either meets EVERY constraint or is
 * explicitly rejected. There is no silent middle where something almost
 * readable ships.
 */

const fs = require('fs');
const path = require('path');

const A = require(path.join(__dirname, '..', 'src', 'accent.js'));
const { derive, contrast, SURFACES } = A;
const PAGE = SURFACES[0];

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };

/** Every constraint the stylesheet depends on, checked against one ramp. */
function check(label, base, ramp) {
  const on = ramp['--text-on-accent'];
  const pairs = [
    ['label on accent', contrast(on, ramp['--accent-primary']), 4.5],
    ['label on hover', contrast(on, ramp['--accent-hover']), 4.5],
    ['label on deep', contrast(on, ramp['--accent-deep']), 4.5],
    ['rim vs page', contrast(ramp['--accent-edge'], PAGE), 3],
  ];
  for (const s of SURFACES) {
    pairs.push(['ring vs ' + s, contrast(ramp['--border-focus'], s), 3]);
  }
  for (const [name, got, min] of pairs) {
    if (!(got >= min)) fail(`${label} (${base}): ${name} = ${got.toFixed(2)}, need ${min}`);
  }
  // A hover nobody can see is not a hover. Measured as a difference in OKLab
  // lightness, not a contrast ratio: ratio compresses at both ends, so it
  // scores a clearly visible step between two pale yellows at 1.00 and an
  // invisible one between two near-blacks at 1.10.
  const step = Math.abs(A.toLCH(ramp['--accent-hover']).L - A.toLCH(ramp['--accent-primary']).L);
  if (step < 0.04) fail(`${label} (${base}): hover only ${step.toFixed(3)} ΔL from the fill`);
  // Every emitted value has to be a colour the CSS parser will accept.
  for (const [k, v] of Object.entries(ramp)) {
    if (!/^(#[0-9a-f]{6}|rgba\(|0 2px 16px rgba\()/i.test(v)) {
      fail(`${label} (${base}): ${k} is not a usable value: ${v}`);
    }
  }
}

// ── 1. real university brand colours ──────────────────────────────────────
console.log('\nreal institution colours');
const SCHOOLS = {
  'Iona': '#6f2c3e', 'Harvard crimson': '#A51C30', 'Michigan blue': '#00274C',
  'UCLA blue': '#2774AE', 'Texas orange': '#BF5700', 'Oregon green': '#154733',
  'Navy': '#000080', 'Gold': '#FFD700', 'Sky blue': '#87CEEB',
  'Hot pink': '#FF69B4', 'Lime': '#32CD32', 'Deep purple': '#4B0082',
  'Teal': '#008080', 'Burnt sienna': '#8A3324',
};
for (const [name, hex] of Object.entries(SCHOOLS)) {
  const ramp = derive(hex);
  if (!ramp) { fail(`${name} (${hex}) was rejected but is a legitimate brand colour`); continue; }
  check(name, hex, ramp);
}
console.log(`  swept ${Object.keys(SCHOOLS).length}`);

// ── 2. the whole colour space ─────────────────────────────────────────────
// Walks hue, saturation and lightness rather than picking pleasant colours,
// because the input is whatever a university happens to have chosen.
console.log('\nhue / saturation / lightness sweep');
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
let derived = 0, rejected = 0;
for (let h = 0; h < 360; h += 10) {
  for (const s of [0.15, 0.35, 0.6, 0.85, 1.0]) {
    for (const l of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
      const hex = hslToHex(h, s, l);
      const ramp = derive(hex);
      if (!ramp) { rejected++; continue; }
      derived++;
      check(`h${h} s${s} l${l}`, hex, ramp);
    }
  }
}
console.log(`  swept ${derived + rejected}: ${derived} derived, ${rejected} rejected`);

// ── 3. inputs that must be rejected, never quietly passed through ─────────
console.log('\nrejections');
const MUST_REJECT = {
  'Blackboard default primary': '#262626',
  'pure black': '#000000',
  'pure white': '#ffffff',
  'mid grey': '#808080',
  'near-white': '#f5f5f5',
  'not a colour': 'rebeccapurple-ish',
  'empty': '',
  'null': null,
};
for (const [name, value] of Object.entries(MUST_REJECT)) {
  if (derive(value) !== null) fail(`${name} (${value}) should have been rejected`);
}
console.log(`  checked ${Object.keys(MUST_REJECT).length}`);

// ── 4. Iona must not move ─────────────────────────────────────────────────
// The acceptance test for this release: the mechanism goes in, the appearance
// does not.
//
// Drift is ΔE in OKLab — Euclidean distance in a perceptually uniform space.
// The first version of this check used a contrast ratio and passed
// #c02e5e → #9b5364 at "1.01", because two colours can share a luminance and
// look nothing alike. A drift check that cannot see a hue change is not a
// drift check.
const dE = (a, b) => {
  const x = A.toLCH(a), y = A.toLCH(b);
  const [ax, ay] = [x.C * Math.cos(x.H), x.C * Math.sin(x.H)];
  const [bx, by] = [y.C * Math.cos(y.H), y.C * Math.sin(y.H)];
  return Math.hypot(x.L - y.L, ax - bx, ay - by);
};
console.log('\nIona against the shipped ramp   (ΔE in OKLab; ~0.02 is a just-noticeable difference)');
const SHIPPED = {
  '--accent-primary': '#6f2c3e', '--accent-hover': '#8c3a50',
  '--accent-deep': '#421a26', '--accent-edge': '#c02e5e',
  '--border-focus': '#e8a0b4', '--text-on-accent': '#ffffff',
};
const iona = derive(A.baseFor('online.iona.edu'));
if (!iona) {
  fail('Iona derived nothing at all');
} else {
  for (const [token, shipped] of Object.entries(SHIPPED)) {
    const got = iona[token];
    const drift = dE(shipped, got);
    // The base and the label must be exact — those are the two the eye lands
    // on. The rest may move a little, since they are now solved against
    // thresholds rather than chosen by hand.
    const limit = (token === '--accent-primary' || token === '--text-on-accent') ? 0 : 0.10;
    const verdict = drift <= limit ? 'ok' : 'DRIFT';
    console.log(`  ${token.padEnd(18)} ${shipped} → ${got}  ΔE ${drift.toFixed(3)}  ${verdict}`);
    if (drift > limit) fail(`${token} drifted ΔE ${drift.toFixed(3)} from the shipped value`);
  }
}

// ── 5. the curated source ─────────────────────────────────────────────────
console.log('\nsource resolution');
if (A.baseFor('online.iona.edu') !== '#6f2c3e') fail('Iona is not pinned to #6f2c3e');
if (A.baseFor('blackboard.someother.edu') !== null) fail('an unknown host should resolve to null');
if (A.baseFor('constructor') !== null) fail('inherited Object properties leak through baseFor');
console.log('  checked 3');

// ── 6. the stylesheet and the module must agree on the surfaces ───────────
// The ring is only trustworthy if this list is the real ladder.
console.log('\nsurface list matches dark-mode.css');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'dark-mode.css'), 'utf8');
for (const [token, expected] of [
  ['--bg-primary', '#0a0a0c'], ['--bg-sidebar', '#131319'], ['--bg-secondary', '#1f1f27'],
  ['--bg-row-alt', '#26262f'], ['--bg-tertiary', '#2b2b35'], ['--bg-raised', '#383844'],
  ['--bg-hover', '#3f2b3e'],
]) {
  const m = new RegExp(token + ':\\s*(#[0-9a-f]{6})', 'i').exec(css);
  if (!m) { fail(`${token} not found in dark-mode.css`); continue; }
  if (m[1].toLowerCase() !== expected) fail(`${token} is ${m[1]} in CSS but ${expected} here`);
  if (!SURFACES.includes(expected)) fail(`${expected} missing from accent.js SURFACES`);
}
console.log('  checked 7');

console.log(failures === 0 ? '\nPASS — no failures\n' : `\nFAIL — ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
