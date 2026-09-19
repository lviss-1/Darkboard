// WCAG relative luminance and contrast, shared by the fixtures.
// Computing ratios rather than asserting hardcoded colors means the checks keep
// their meaning if the palette is retuned.
(function () {
  function channel(v) {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function parse(color) {
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) throw new Error('cannot parse color: ' + color);
    return [+m[1], +m[2], +m[3]];
  }

  function luminance(color) {
    const [r, g, b] = parse(color);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  window.__contrast = function (a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
  };
})();
