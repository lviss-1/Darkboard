// Forces a genuine style resolution on an element before it is measured.
//
// Chrome defers style recalculation in a hidden tab, and the Browser pane is
// frequently hidden while these fixtures are driven from the console. The
// symptom is not a missing stylesheet — document.styleSheets is populated and
// element.matches() agrees the rule applies — it is getComputedStyle handing
// back the user-agent value for a node that existed before the stylesheet
// attached. Links read as rgb(0, 0, 238) and themed buttons as
// rgb(239, 239, 239) while the correct rule sits right there in the sheet.
//
// Nodes created after the stylesheet loads are styled correctly, which is the
// tell: it is a recalculation that never ran, not a cascade that lost. Toggling
// `display` is not enough, because an inherited property such as `color` is
// resolved against an ancestor the toggle never dirties. Removing the node and
// putting it straight back does force it, without changing its identity, its
// position, or anything a selector could key on.
//
// Every assertion that reads a computed style should go through this. An
// assertion that silently reads a stale value does not fail — it passes for
// the wrong reason, which is worse.
(function () {
  window.__restyle = function (el) {
    if (!el || !el.parentNode) return el;
    const next = el.nextSibling;
    const parent = el.parentNode;
    parent.removeChild(el);
    parent.insertBefore(el, next);
    return el;
  };

  // Most reads want the whole subtree settled, not one node — an inherited
  // value is only as fresh as the ancestor it descends from.
  window.__restyleTree = function (el) {
    let top = el;
    while (top.parentElement && top.parentElement !== document.body) {
      top = top.parentElement;
    }
    window.__restyle(top);
    return el;
  };

  // Reads a computed property after forcing that resolution.
  window.__computed = function (el, property) {
    window.__restyleTree(el);
    return getComputedStyle(el)[property];
  };
})();
