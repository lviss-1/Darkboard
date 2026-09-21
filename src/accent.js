/**
 * accent.js — derives the theme's accent ramp from one institution colour.
 *
 * The theme used to carry a hand-tuned maroon: --accent-primary plus six
 * values eyeballed from it. That is fine for one university and wrong for the
 * next, whose brand colour this would fight on every page. This turns the
 * whole ramp into a function of a single base colour.
 *
 * Deliberately pure — no DOM, no chrome.*, no side effects — so the maths can
 * be swept over hundreds of colours in Node rather than eyeballed in a
 * browser. See test/accent.test.js. Every rule below exists because a simpler
 * version of it was written first and then failed that sweep.
 *
 * Loaded as a content script before content.js, and read directly by the test
 * through the same global. No module system, because the extension has no
 * build step and should not grow one for this.
 */

const DarkboardAccent = (() => {
  // ─── sRGB ↔ OKLab ───────────────────────────────────────────────────────
  // OKLCH rather than HSL because lightness steps have to look even across
  // hues. An HSL step of 6% is a different perceptual distance at yellow than
  // at navy, and the ramp needs one rule that works for both. This is the same
  // reasoning that put the surface ladder in CIE L*.
  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  function parseHex(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }

  const toHex = (rgb) =>
    '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

  function rgbToOklab([r, g, b]) {
    r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }

  function oklabToRgb([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
      linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    ];
  }

  function toLCH(hex) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    const [L, a, b] = rgbToOklab(rgb);
    return { L, C: Math.hypot(a, b), H: Math.atan2(b, a) };
  }

  const fromLCH = ({ L, C, H }) =>
    toHex(oklabToRgb([L, C * Math.cos(H), C * Math.sin(H)]));

  // ─── WCAG ───────────────────────────────────────────────────────────────
  function luminance(hex) {
    const [r, g, b] = parseHex(hex).map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    const hi = Math.max(x, y), lo = Math.min(x, y);
    return (hi + 0.05) / (lo + 0.05);
  }

  // The surface ladder from dark-mode.css section 1. The focus ring has to
  // clear every one of these, because it can be drawn on any of them.
  const SURFACES = ['#0a0a0c', '#131319', '#1f1f27', '#26262f', '#2b2b35', '#383844', '#3f2b3e'];
  const PAGE = SURFACES[0];
  const WHITE = '#ffffff';
  const NEAR_BLACK = '#0a0a0c';

  // Targets sit above the WCAG floor on purpose. Deriving to exactly 3.00
  // leaves a value one rounding error from failing, and it produced a visibly
  // dimmer rim and ring than the hand-tuned ones it replaced.
  const LABEL_MIN = 4.5;
  const BOUNDARY_MIN = 3;
  const RIM_TARGET = 3.5;
  const RING_TARGET = 4.5;

  // The smallest OKLab lightness move that reads as a deliberate state change
  // rather than a rendering artefact. In the same units as the surface ladder's
  // steps, which is the point of measuring here rather than in contrast ratio.
  const MIN_STEP_L = 0.045;

  // The rim is lightened AND saturated; see where it is derived below.
  // MAX_CHROMA keeps the boost inside a range sRGB can actually render, so a
  // colour that is already vivid does not get clipped into a different hue.
  const RIM_CHROMA_BOOST = 1.8;
  const MAX_CHROMA = 0.37;

  // Below this chroma there is no hue to build a ramp from — a near-black or
  // near-white "brand colour" is not an accent. Blackboard's own default
  // --palette-primary-main (#262626) lands here, which is why it cannot be
  // used as a source.
  const MIN_CHROMA = 0.035;

  /** Whichever of white / near-black reads better on this fill. */
  const labelFor = (fill) => (contrast(WHITE, fill) >= contrast(NEAR_BLACK, fill) ? WHITE : NEAR_BLACK);

  /**
   * Derives the full accent ramp from a base colour.
   * Returns null when the colour cannot produce an accessible ramp, so the
   * caller falls back to the stylesheet's own values rather than shipping
   * something unreadable.
   */
  function derive(base) {
    const lch = toLCH(base);
    if (!lch || !Number.isFinite(lch.L)) return null;
    if (lch.C < MIN_CHROMA) return null;

    const { C, H } = lch;
    const at = (L) => fromLCH({ L: Math.max(0.05, Math.min(0.97, L)), C, H });

    // Fit the fill by searching, not by clamping to a guessed range: start
    // from the institution's own lightness and only move if its own colour
    // cannot carry a label.
    let accent = null, accentL = null;
    const candidates = [lch.L].concat(Array.from({ length: 60 }, (_, i) => 0.25 + i * 0.01));
    for (const L of candidates) {
      const hex = at(L);
      if (contrast(labelFor(hex), hex) >= LABEL_MIN) { accent = hex; accentL = L; break; }
    }
    if (!accent) return null;

    const onAccent = labelFor(accent);

    // Hover prefers to lighten: on a dark canvas a control under the pointer
    // should advance, not recede. It gives that up for two reasons — when
    // lightening would cost the label its contrast (a mid-light fill like
    // UCLA blue), and when the fill is already so light there is no headroom
    // left and the "step" clamps to no movement at all. A near-white fill
    // produced a hover identical to itself until the sweep caught it.
    //
    // Distinctness is measured as a difference in OKLab lightness, not as a
    // contrast ratio. Ratio compresses at both ends of the range, so it calls
    // a clearly visible step between two pale yellows 1.00 while calling an
    // invisible one between two near-blacks 1.10. The whole reason this module
    // is in OKLCH is that its lightness is perceptually even; the threshold
    // should be too.
    const stepped = (magnitude, preferLighter) => {
      for (const dir of preferLighter ? [1, -1] : [-1, 1]) {
        const L = accentL + dir * magnitude;
        const hex = at(L);
        const moved = Math.abs(toLCH(hex).L - toLCH(accent).L);
        if (moved < MIN_STEP_L) continue;              // clamped, or too close to see
        if (contrast(onAccent, hex) < LABEL_MIN) continue;
        return hex;
      }
      return null;
    };
    const hover = stepped(0.06, true);
    const deep = stepped(0.12, false);
    if (!hover || !deep) return null;

    // A rim only earns its place when the fill is not already its own
    // boundary. WCAG 1.4.11 wants 3:1 for the edge of a control; a light
    // accent on this canvas clears that unaided and a rim would just be noise.
    //
    // Where one is needed it gains chroma as well as lightness. Lightening at
    // constant chroma washes the rim out — on Iona it derived a muted mauve
    // where the hand-tuned value was vivid, a visible downgrade on every
    // primary button. Measuring the shipped rim showed why: it carried nearly
    // twice the base's chroma. With the boost the derived value lands ΔE 0.011
    // from it, inside a just-noticeable difference. A rim exists to be seen.
    let edge = accent;
    if (contrast(accent, PAGE) < BOUNDARY_MIN) {
      edge = null;
      const rimC = Math.min(C * RIM_CHROMA_BOOST, MAX_CHROMA);
      for (let d = 0.04; d <= 0.65; d += 0.01) {
        const hex = fromLCH({ L: Math.min(accentL + d, 0.97), C: rimC, H });
        if (contrast(hex, PAGE) >= RIM_TARGET) { edge = hex; break; }
      }
      if (!edge) return null;
    }

    // The ring is measured against the surfaces and not against the fill,
    // because outline-offset draws it outside the control. Requiring it to
    // clear the fill as well made light accents unsolvable for no benefit.
    let ring = null;
    for (let L = 0.70; L <= 0.98; L += 0.01) {
      const hex = fromLCH({ L, C: Math.min(C, 0.09), H });
      if (Math.min.apply(null, SURFACES.map((s) => contrast(hex, s))) >= RING_TARGET) { ring = hex; break; }
    }
    if (!ring) return null;

    const [r, g, b] = parseHex(accent).map((v) => Math.round(v * 255));
    return {
      '--accent-primary': accent,
      '--accent-hover': hover,
      '--accent-deep': deep,
      '--accent-edge': edge,
      '--text-on-accent': onAccent,
      '--border-focus': ring,
      '--accent-glow': `rgba(${r}, ${g}, ${b}, 0.25)`,
      '--shadow-maroon': `0 2px 16px rgba(${r}, ${g}, ${b}, 0.3)`,
    };
  }

  // ─── Source ─────────────────────────────────────────────────────────────
  // Curated for now. The eventual source is the institution's navigation logo,
  // which is same-origin on every Blackboard host and quantises cleanly — on
  // Iona it yields #681838 and #f8a818, the university's own two colours. That
  // needs an image load and a per-origin cache, so it lands with the
  // multi-institution release and slots in ahead of this map without the ramp
  // above changing at all.
  //
  // Iona is pinned rather than extracted so the appearance does not move for
  // the users already on it.
  const INSTITUTIONS = {
    'online.iona.edu': '#6f2c3e',
  };

  const baseFor = (hostname) =>
    Object.prototype.hasOwnProperty.call(INSTITUTIONS, hostname) ? INSTITUTIONS[hostname] : null;

  return { derive, baseFor, contrast, toLCH, fromLCH, labelFor, SURFACES, INSTITUTIONS };
})();

// Read by test/accent.test.js, which evaluates this file directly. Guarded so
// the same source works unchanged as a content script, where module is absent.
if (typeof module !== 'undefined' && module.exports) module.exports = DarkboardAccent;
