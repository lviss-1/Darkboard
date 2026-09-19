// WCAG relative luminance and contrast, shared by the fixtures.
// Computing ratios rather than asserting hardcoded colors means the checks keep
// their meaning if the palette is retuned.
(function () {
  function channel(v) {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  // Computed styles serialize to rgb(), but a custom property read back through
  // getPropertyValue keeps whatever spelling the author used, so hex is handled
  // too rather than forcing callers to convert.
  function parse(color) {
    const value = color.trim();

    const rgb = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];

    const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1].length === 3
        ? hex[1].split('').map(ch => ch + ch).join('')
        : hex[1];
      return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    }

    throw new Error('cannot parse color: ' + color);
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
