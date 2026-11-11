/**
 * course-cards.js — overall grade and upcoming work on the course list
 *
 * Adds two things to each card on /ultra/course:
 *   - a badge on the banner with the overall grade, as Ultra itself shows it
 *     inside the course (a letter when the grading schema has one, otherwise
 *     the percentage to two places);
 *   - a "Due" list under the card: overdue first, then soonest, at most three,
 *     from the next two weeks.
 *
 * Everything comes from the endpoints Ultra's own pages already call, made
 * same-origin with the student's session: one for every course's due items,
 * one for the user id, two per visible course for the grade. Results live
 * for ten minutes in this tab's sessionStorage on Blackboard's own origin,
 * which already holds the same data, and never leave the browser.
 *
 * Independent of dark mode: its own preference (courseCardsEnabled, absent
 * means on), its own stylesheet for light mode, section 37 of dark-mode.css
 * for dark.
 *
 * Wrapped in a function because content scripts share one lexical scope: a
 * top-level const here that collides with one in content.js would throw at
 * load and take both scripts down.
 */
(() => {
  'use strict';

  if (window.top !== window) return;
  // executeScript into a tab the registration already covers would run this
  // a second time; a second observer would decorate every card twice.
  if (window.__darkboardCourseCards) return;
  window.__darkboardCourseCards = true;

  const PREF_KEY = 'courseCardsEnabled';
  const MARK = 'data-darkboard-card';
  const CARD_SELECTOR = 'article[id^="course-list-course-"]';
  // Ultra also renders cards whose id is a bare "course-list-course-"; they
  // have no course behind them and are skipped.
  const COURSE_ID = /^course-list-course-(_\d+_\d+)$/;
  const BETTERCAMPUS = '[class*="bettercampus-card-grade"], [class*="bettercampus-grade-anchor"]';
  const OVERALL_NAME = /overall|total|final/i;

  const CACHE_KEY = 'darkboard.cards.v1';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  // A network error or timeout is retried sooner than a real answer expires,
  // but not on the next mutation: Ultra mutates the DOM constantly, and an
  // entry that never became fresh would refetch on every one of them.
  const RETRY_MS = 60 * 1000;
  const DUE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const DUE_LIMIT = 3;
  const CONCURRENCY = 3;
  const FETCH_TIMEOUT_MS = 8000;

  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

  let enabled = false;
  let observer = null;
  let controller = null;
  let refreshing = null;
  let refreshQueued = false;
  let rafPending = false;
  let cache = readCache();
  const reported = new Set();

  // ─── Cache ──────────────────────────────────────────────────────────────
  // Entries carry their own timestamps, so a course that scrolls into a new
  // term later is fetched without throwing away the ones already known.

  function emptyCache() {
    return { userId: null, due: null, grades: {} };
  }

  function fresh(entry) {
    return !!entry && Date.now() < entry.expires;
  }

  function expiry(result) {
    return Date.now() + (result.transient ? RETRY_MS : CACHE_TTL_MS);
  }

  function readCache() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (parsed && typeof parsed === 'object' && parsed.grades) return parsed;
    } catch (e) {}
    return emptyCache();
  }

  function writeCache() {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {}
  }

  // ─── Network ────────────────────────────────────────────────────────────

  // 403 is routine (closed and organisation courses refuse gradebook reads),
  // so failures are logged once per endpoint shape and otherwise mean "show
  // nothing".
  function report(path, reason) {
    const shape = path.replace(/_\d+_\d+/g, '_ID_').split('?')[0];
    if (reported.has(shape)) return;
    reported.add(shape);
    console.debug(`[DarkBoard] course cards: ${shape} → ${reason}`);
  }

  // `transient` separates "try again soon" (network, timeout, 5xx, a body
  // that is not JSON) from an answer that holds for the TTL (4xx).
  async function fetchJson(path, signal) {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(location.origin + path, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!response.ok) {
        report(path, response.status);
        return { body: null, transient: response.status >= 500 };
      }
      return { body: await response.json(), transient: false };
    } catch (err) {
      if (!signal.aborted) report(path, timeout.aborted ? 'timeout' : err.name);
      return { body: null, transient: true };
    }
  }

  async function loadUserId(signal) {
    if (cache.userId) return cache.userId;
    const { body } = await fetchJson('/learn/api/public/v1/users/me', signal);
    if (body && typeof body.id === 'string') {
      cache.userId = body.id;
      writeCache();
    }
    return cache.userId;
  }

  // The endpoint rejects a `since` in the past with a 400; it works out which
  // items are overdue itself.
  async function loadDue(signal) {
    if (fresh(cache.due)) return;

    const since = new Date();
    const until = new Date(since.getTime() + DUE_WINDOW_MS);
    const result = await fetchJson(
      '/learn/api/v1/calendars/todo/studentItems' +
        `?since=${encodeURIComponent(since.toISOString())}` +
        `&until=${encodeURIComponent(until.toISOString())}`,
      signal
    );
    if (signal.aborted) return;

    const body = result.body || {};
    const byCourse = {};
    const add = (items, state) => {
      for (const item of Array.isArray(items) ? items : []) {
        const courseId = item && item.column && item.column.courseId;
        const due = item && Date.parse(item.dueDate);
        if (!courseId || !Number.isFinite(due)) continue;
        const title = item.title || item.column.effectiveColumnName || item.column.columnName;
        if (!title) continue;
        (byCourse[courseId] ||= []).push({ title, due, state });
      }
    };
    add(body.overdueItems, 'overdue');
    add(body.dueTodayItems, 'today');
    add(body.futureDueItems, 'upcoming');

    const rank = { overdue: 0, today: 1, upcoming: 2 };
    for (const list of Object.values(byCourse)) {
      list.sort((a, b) => rank[a.state] - rank[b.state] || a.due - b.due);
      list.length = Math.min(list.length, DUE_LIMIT);
    }

    cache.due = { expires: expiry(result), byCourse };
    writeCache();
  }

  // An external grade is what the instructor marked as the overall grade.
  // Without one, a single calculated column is what Ultra shows in its place.
  // Anything more ambiguous shows nothing: no badge is better than a category
  // subtotal presented as the course grade.
  function pickOverallColumn(columns) {
    if (!Array.isArray(columns)) return null;
    const visible = columns.filter((c) => c && c.visible !== false);

    const external = visible.filter((c) => c.externalGrade === true);
    if (external.length) return external.length === 1 ? external[0] : null;

    const calculated = visible.filter(
      (c) => c.calculationType && c.calculationType !== 'NON_CALCULATED'
    );
    if (calculated.length === 1) return calculated[0];

    const named = calculated.filter((c) => OVERALL_NAME.test(c.columnName || c.effectiveColumnName || ''));
    return named.length === 1 ? named[0] : null;
  }

  // displayGrade.score is the percentage (it ran 2.3× pointsPossible on a live
  // course), and Ultra prints it to two places. displayGrade.grade only exists
  // when the column's schema maps the score to a letter, and Ultra shows the
  // letter then.
  function gradeFrom(column, row) {
    if (!column || column.gradesReleased === false) return null;
    if (!row || row.isExempt) return null;

    const display = row.displayGrade;
    if (!display || typeof display.score !== 'number' || !Number.isFinite(display.score)) return null;

    const percent = `${display.score.toFixed(2)}%`;
    const letter = typeof display.grade === 'string' ? display.grade.trim() : '';
    const status = typeof statusForPercent === 'function' ? statusForPercent(display.score) : null;
    return { text: letter || percent, percent, status };
  }

  async function loadGrade(courseId, userId, signal) {
    let result = await fetchJson(
      `/learn/api/v1/courses/${courseId}/gradebook/columns?includeInvisible=false`,
      signal
    );
    if (signal.aborted) return;

    const column = pickOverallColumn(result.body && result.body.results);
    let grade = null;
    if (column) {
      result = await fetchJson(
        `/learn/api/v1/courses/${courseId}/gradebook/grades?limit=100&userId=${encodeURIComponent(userId)}`,
        signal
      );
      if (signal.aborted) return;
      const rows = result.body && Array.isArray(result.body.results) ? result.body.results : [];
      grade = gradeFrom(column, rows.find((r) => r && r.columnId === column.id));
    }

    // A miss is cached too, so a course that refuses (403) is not asked again
    // on every re-render of the list.
    cache.grades[courseId] = { expires: expiry(result), grade };
    writeCache();
  }

  // Without a user id there is nothing to ask for, but the courses still have
  // to stop counting as missing, or every mutation would retry.
  function deferGrades(courseIds) {
    const expires = Date.now() + RETRY_MS;
    for (const id of courseIds) {
      if (!fresh(cache.grades[id])) cache.grades[id] = { expires, grade: null };
    }
    writeCache();
  }

  // Switching the cards off aborts what is in flight; the check here is what
  // stops the courses still queued behind it from being asked for at all.
  async function runLimited(tasks, signal) {
    const queue = tasks.slice();
    const worker = async () => {
      while (queue.length && !signal.aborted) await queue.shift()();
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  function courseIdOf(article) {
    const match = COURSE_ID.exec(article.id);
    return match ? match[1] : null;
  }

  function eligibleCards() {
    return [...document.querySelectorAll(CARD_SELECTOR)].filter((a) => courseIdOf(a));
  }

  // The card opens its course on click and on Enter. Our links and the
  // summary have their own job, so neither event may reach the card.
  function isolate(el) {
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
    });
  }

  function buildBadge(courseId, grade) {
    const badge = document.createElement('a');
    badge.className = 'darkboard-card-grade darkboard-pill';
    badge.setAttribute(MARK, 'grade');
    if (grade.status) badge.dataset.gradeStatus = grade.status;
    badge.href = `/ultra/courses/${courseId}/grades`;
    badge.textContent = grade.text;
    const label = grade.text === grade.percent
      ? `Overall grade ${grade.percent}`
      : `Overall grade ${grade.text}, ${grade.percent}`;
    badge.setAttribute('aria-label', label);
    badge.title = label;
    isolate(badge);
    return badge;
  }

  function whenLabel(item) {
    if (item.state === 'overdue') return 'Overdue';
    if (item.state === 'today') return 'Today';
    return dateFormat.format(item.due);
  }

  function buildDue(courseId, items) {
    const section = document.createElement('section');
    section.className = 'darkboard-card-due';
    section.setAttribute(MARK, 'due');
    section.setAttribute('aria-label', 'Due soon');

    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = 'Due';
    isolate(summary);
    details.appendChild(summary);

    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'darkboard-card-due__item';
      li.dataset.state = item.state;

      const link = document.createElement('a');
      link.href = `/ultra/courses/${courseId}/outline`;
      link.textContent = item.title;
      link.title = item.title;
      isolate(link);

      const time = document.createElement('time');
      time.dateTime = new Date(item.due).toISOString();
      time.textContent = whenLabel(item);

      li.append(link, time);
      list.appendChild(li);
    }
    details.appendChild(list);
    section.appendChild(details);
    return section;
  }

  function removeFrom(root) {
    for (const el of root.querySelectorAll(`[${MARK}]`)) el.remove();
  }

  // Synchronous and idempotent: draws whatever the cache already knows onto
  // cards that lack it, and reports whether any card is still missing data.
  function render() {
    let missing = false;

    for (const article of eligibleCards()) {
      const courseId = courseIdOf(article);

      if (article.querySelector(BETTERCAMPUS)) {
        removeFrom(article);
        continue;
      }

      const gradeEntry = cache.grades[courseId];
      if (!fresh(gradeEntry)) missing = true;
      if (!fresh(cache.due)) missing = true;

      const banner = article.querySelector('.course-banner');
      if (gradeEntry && gradeEntry.grade && !article.querySelector(`[${MARK}="grade"]`)) {
        const badge = buildBadge(courseId, gradeEntry.grade);
        // List view has no banner; the badge then leads the details instead.
        if (banner) {
          banner.prepend(badge);
        } else {
          badge.classList.add('darkboard-card-grade--inline');
          (article.querySelector('.element-details') || article).prepend(badge);
        }
      }

      const items = cache.due && cache.due.byCourse[courseId];
      if (items && items.length && !article.querySelector(`[${MARK}="due"]`)) {
        (article.querySelector('.element-details') || article).appendChild(buildDue(courseId, items));
      }
    }

    return missing;
  }

  // Our own insertions are exactly what the observer watches, so it is
  // disconnected around every render.
  function renderQuietly() {
    if (observer) observer.disconnect();
    const missing = render();
    if (observer && enabled) observer.observe(document.body, { childList: true, subtree: true });
    return missing;
  }

  async function refresh() {
    if (refreshing) {
      refreshQueued = true;
      return refreshing;
    }

    const signal = controller.signal;
    refreshing = (async () => {
      // A card BetterCampus owns is never drawn on, so its grade is not asked for.
      const courseIds = [...new Set(
        eligibleCards().filter((a) => !a.querySelector(BETTERCAMPUS)).map(courseIdOf)
      )];
      const userId = await loadUserId(signal);
      if (signal.aborted) return;

      const tasks = [() => loadDue(signal)];
      if (userId) {
        for (const id of courseIds) {
          if (!fresh(cache.grades[id])) tasks.push(() => loadGrade(id, userId, signal));
        }
      } else {
        deferGrades(courseIds);
      }
      await runLimited(tasks, signal);
      if (!signal.aborted && enabled) renderQuietly();
    })();

    try {
      await refreshing;
    } finally {
      refreshing = null;
    }

    if (refreshQueued && enabled) {
      refreshQueued = false;
      if (renderQuietly()) refresh();
    }
  }

  function onMutations() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!enabled) return;
      if (renderQuietly()) refresh();
    });
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  function start() {
    if (enabled || !document.body) return;
    enabled = true;
    controller = new AbortController();
    observer = new MutationObserver(onMutations);
    if (renderQuietly()) refresh();
  }

  function stop() {
    if (!enabled) return;
    enabled = false;
    if (observer) observer.disconnect();
    observer = null;
    if (controller) controller.abort();
    controller = null;
    refreshQueued = false;
    removeFrom(document);
  }

  function apply(value) {
    if (value !== false) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
      } else {
        start();
      }
    } else {
      stop();
    }
  }

  // Storage changes reach content scripts directly, so unlike the dark-mode
  // toggle this needs no relay through the background worker.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && PREF_KEY in changes) apply(changes[PREF_KEY].newValue);
  });

  chrome.storage.local.get(PREF_KEY, (result) => apply(result && result[PREF_KEY]));
})();
