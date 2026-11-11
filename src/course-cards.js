/**
 * course-cards.js — overall grade and upcoming work on the course list
 *
 * Adds two things to each card on /ultra/course:
 *   - a badge on the banner with the overall grade, as Ultra itself shows it
 *     inside the course (a letter when the grading schema has one, otherwise
 *     the percentage to two places);
 *   - a collapsible "Due" section under the card, closed until the student
 *     opens it, remembered per course. Its header carries the count and any
 *     overdue work, so a closed section still says whether to look.
 *
 * Everything comes from the endpoints Ultra's own pages already call, made
 * same-origin with the student's session: one for every course's due items,
 * one for the user id, two per visible course for the grade. Results live
 * for ten minutes in this tab's sessionStorage on Blackboard's own origin,
 * which already holds the same data, and never leave the browser.
 *
 * Always on, and independent of dark mode: course-cards.css styles it for
 * light, section 37 of dark-mode.css for dark.
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

  const MARK = 'data-darkboard-card';
  const CARD_SELECTOR = 'article[id^="course-list-course-"]';
  // Ultra also renders cards whose id is a bare "course-list-course-"; they
  // have no course behind them and are skipped.
  const COURSE_ID = /^course-list-course-(_\d+_\d+)$/;
  const BETTERCAMPUS = '[class*="bettercampus-card-grade"], [class*="bettercampus-grade-anchor"]';
  const OVERALL_NAME = /overall|total|final/i;

  const CACHE_KEY = 'darkboard.cards.v3';
  const OPEN_KEY = 'darkboard.cards.dueOpen';
  const CACHE_TTL_MS = 10 * 60 * 1000;
  // A network error or timeout is retried sooner than a real answer expires,
  // but not on the next mutation: Ultra mutates the DOM constantly, and an
  // entry that never became fresh would refetch on every one of them.
  const RETRY_MS = 60 * 1000;
  const DUE_WINDOW_DAYS = 14;
  const DUE_WINDOW_MS = DUE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const DUE_LIMIT = 3;
  const CONCURRENCY = 3;
  const FETCH_TIMEOUT_MS = 8000;

  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

  let observer = null;
  let refreshing = null;
  let refreshQueued = false;
  let rafPending = false;
  let cache = readCache();
  const reported = new Set();

  // ─── Storage ────────────────────────────────────────────────────────────
  // Both keys live on Blackboard's origin. Storage that cannot be read (a
  // private window, blocked site data) costs the cache and the remembered
  // open sections, nothing else.

  function readJson(storage, key) {
    try {
      return JSON.parse(storage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  function writeJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  // Entries carry their own expiry, so a course that scrolls into a new term
  // later is fetched without throwing away the ones already known.
  function readCache() {
    const parsed = readJson(sessionStorage, CACHE_KEY);
    if (parsed && typeof parsed === 'object' && parsed.grades) return parsed;
    return { userId: null, due: null, grades: {} };
  }

  function writeCache() {
    writeJson(sessionStorage, CACHE_KEY, cache);
  }

  function fresh(entry) {
    return !!entry && Date.now() < entry.expires;
  }

  function expiry(result) {
    return Date.now() + (result.transient ? RETRY_MS : CACHE_TTL_MS);
  }

  function openCourses() {
    const list = readJson(localStorage, OPEN_KEY);
    return new Set(Array.isArray(list) ? list : []);
  }

  function rememberOpen(courseId, open) {
    const set = openCourses();
    if (open === set.has(courseId)) return;
    if (open) set.add(courseId);
    else set.delete(courseId);
    writeJson(localStorage, OPEN_KEY, [...set]);
  }

  // ─── URLs ───────────────────────────────────────────────────────────────
  // Ultra sets <base href> to its CDN, so a relative href on the page resolves
  // there: "/ultra/courses/…/outline" opened an S3 "NoSuchKey" page. Every
  // link we draw is made absolute against the page's own origin, which
  // new URL() takes from its second argument and not from <base>.

  function ultraUrl(path) {
    return new URL(path, location.origin).href;
  }

  function outlineUrl(courseId) {
    return ultraUrl(`/ultra/courses/${courseId}/outline`);
  }

  // The "User Interface View" link Blackboard's public API gives every content
  // item: /ultra/redirect?…&contentId=…&parentId=…, the deep link its own
  // notifications use, which routes to the right view for any item type. It
  // is accepted only on this origin and under /ultra/, so whatever the field
  // holds cannot become a javascript: URL or a link off the site.
  function alternateLink(body) {
    const links = body && Array.isArray(body.links) ? body.links : [];
    const alternate = links.find((l) => l && l.rel === 'alternate' && typeof l.href === 'string');
    if (!alternate) return null;
    let url;
    try {
      url = new URL(alternate.href, location.origin);
    } catch (e) {
      return null;
    }
    return url.origin === location.origin && url.pathname.startsWith('/ultra/') ? url.href : null;
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
  async function fetchJson(path) {
    try {
      const response = await fetch(location.origin + path, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        report(path, response.status);
        return { body: null, transient: response.status >= 500 };
      }
      return { body: await response.json(), transient: false };
    } catch (err) {
      report(path, err.name === 'TimeoutError' ? 'timeout' : err.name);
      return { body: null, transient: true };
    }
  }

  async function loadUserId() {
    if (cache.userId) return cache.userId;
    const { body } = await fetchJson('/learn/api/public/v1/users/me');
    if (body && typeof body.id === 'string') {
      cache.userId = body.id;
      writeCache();
    }
    return cache.userId;
  }

  // The endpoint rejects a `since` in the past with a 400; it works out which
  // items are overdue itself. Counts are taken before the list is capped, so
  // the header reports everything in the window and not just what is shown.
  async function loadDue() {
    if (fresh(cache.due)) return;

    const since = new Date();
    const until = new Date(since.getTime() + DUE_WINDOW_MS);
    const result = await fetchJson(
      '/learn/api/v1/calendars/todo/studentItems' +
        `?since=${encodeURIComponent(since.toISOString())}` +
        `&until=${encodeURIComponent(until.toISOString())}`
    );

    // A failed fetch must not read as "nothing due" on every card.
    if (!result.body) {
      cache.due = { expires: expiry(result), failed: true, byCourse: {} };
      writeCache();
      return;
    }

    const byCourse = {};
    const add = (items, state) => {
      for (const item of Array.isArray(items) ? items : []) {
        const courseId = item && item.column && item.column.courseId;
        const due = item && Date.parse(item.dueDate);
        if (!courseId || !Number.isFinite(due)) continue;
        const title = item.title || item.column.effectiveColumnName || item.column.columnName;
        if (!title) continue;
        const contentId = typeof item.column.contentId === 'string' ? item.column.contentId : null;
        (byCourse[courseId] ||= []).push({ title, due, state, contentId });
      }
    };
    add(result.body.overdueItems, 'overdue');
    add(result.body.dueTodayItems, 'today');
    add(result.body.futureDueItems, 'upcoming');

    const rank = { overdue: 0, today: 1, upcoming: 2 };
    const summarised = {};
    for (const [courseId, list] of Object.entries(byCourse)) {
      list.sort((a, b) => rank[a.state] - rank[b.state] || a.due - b.due);
      summarised[courseId] = {
        total: list.length,
        overdue: list.filter((item) => item.state === 'overdue').length,
        items: list.slice(0, DUE_LIMIT),
      };
    }

    cache.due = { expires: expiry(result), fetchedAt: Date.now(), byCourse: summarised };
    writeCache();
  }

  function linksFresh(entry) {
    return !entry.items.length || (!!entry.linksExpires && Date.now() < entry.linksExpires);
  }

  // One request per item actually shown (at most three per course), only for
  // courses with a card on screen. parentId is part of the link and is not in
  // the to-do response, so the link is fetched rather than built. An item
  // without a usable link falls back to its course outline; one that failed
  // transiently is asked again after RETRY_MS.
  async function resolveLinks(courseId) {
    const entry = cache.due && cache.due.byCourse[courseId];
    if (!entry || linksFresh(entry)) return;

    let transient = false;
    for (const item of entry.items) {
      if (item.url && !item.retry) continue;
      const result = item.contentId
        ? await fetchJson(`/learn/api/public/v1/courses/${courseId}/contents/${item.contentId}`)
        : { body: null, transient: false };
      const link = alternateLink(result.body);
      item.url = link || outlineUrl(courseId);
      item.retry = !link && result.transient;
      transient = transient || item.retry;
    }

    entry.linksExpires = Date.now() + (transient ? RETRY_MS : CACHE_TTL_MS);
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

  async function loadGrade(courseId, userId) {
    let result = await fetchJson(
      `/learn/api/v1/courses/${courseId}/gradebook/columns?includeInvisible=false`
    );

    const column = pickOverallColumn(result.body && result.body.results);
    let grade = null;
    if (column) {
      result = await fetchJson(
        `/learn/api/v1/courses/${courseId}/gradebook/grades?limit=100&userId=${encodeURIComponent(userId)}`
      );
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

  async function runLimited(tasks) {
    const queue = tasks.slice();
    const worker = async () => {
      while (queue.length) await queue.shift()();
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  function courseIdOf(article) {
    const match = COURSE_ID.exec(article.id);
    return match ? match[1] : null;
  }

  function ownCards() {
    return [...document.querySelectorAll(CARD_SELECTOR)].filter(
      (a) => courseIdOf(a) && !a.querySelector(BETTERCAMPUS)
    );
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
    badge.href = ultraUrl(`/ultra/courses/${courseId}/grades`);
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

  function span(className, text) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function buildSummary(entry) {
    const summary = document.createElement('summary');
    summary.append(span('darkboard-card-due__label', 'Due'), span('darkboard-card-due__count', ` · ${entry.total}`));
    if (entry.overdue) summary.append(span('darkboard-card-due__overdue', ` · ${entry.overdue} overdue`));

    // The middots are for the eye; a screen reader gets the sentence.
    const items = entry.total === 1 ? '1 item' : `${entry.total} items`;
    summary.setAttribute('aria-label', entry.overdue
      ? `Due soon: ${items}, ${entry.overdue} overdue`
      : `Due soon: ${items}`);
    isolate(summary);
    return summary;
  }

  function buildDue(courseId, entry, stamp) {
    const section = document.createElement('section');
    section.className = 'darkboard-card-due';
    section.setAttribute(MARK, 'due');
    section.dataset.stamp = stamp;

    const details = document.createElement('details');
    details.open = openCourses().has(courseId);
    details.addEventListener('toggle', () => rememberOpen(courseId, details.open));
    details.appendChild(buildSummary(entry));

    if (!entry.items.length) {
      const empty = document.createElement('p');
      empty.className = 'darkboard-card-due__empty';
      empty.textContent = `Nothing due in the next ${DUE_WINDOW_DAYS / 7} weeks`;
      details.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      for (const item of entry.items) {
        const li = document.createElement('li');
        li.className = 'darkboard-card-due__item';
        li.dataset.state = item.state;

        const link = document.createElement('a');
        link.href = item.url || outlineUrl(courseId);
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
    }

    section.appendChild(details);
    return section;
  }

  const NO_DUE = { total: 0, overdue: 0, items: [] };

  function removeFrom(root) {
    for (const el of root.querySelectorAll(`[${MARK}]`)) el.remove();
  }

  // Synchronous and idempotent: draws whatever the cache already knows onto
  // cards that lack it, replaces a Due section drawn from older data, and
  // reports whether any card is still missing data.
  function render() {
    let missing = false;

    for (const article of document.querySelectorAll(CARD_SELECTOR)) {
      if (article.querySelector(BETTERCAMPUS)) removeFrom(article);
    }

    for (const article of ownCards()) {
      const courseId = courseIdOf(article);
      const details = article.querySelector('.element-details') || article;

      const gradeEntry = cache.grades[courseId];
      if (!fresh(gradeEntry)) missing = true;
      if (!fresh(cache.due)) missing = true;

      if (gradeEntry && gradeEntry.grade && !article.querySelector(`[${MARK}="grade"]`)) {
        const badge = buildBadge(courseId, gradeEntry.grade);
        const banner = article.querySelector('.course-banner');
        // List view has no banner; the badge then leads the details instead.
        if (banner) {
          banner.prepend(badge);
        } else {
          badge.classList.add('darkboard-card-grade--inline');
          details.prepend(badge);
        }
      }

      // A section is drawn only once its links are known, so a link never
      // points somewhere it will later stop pointing. The stamp covers both
      // the due data and the links, so newer either replaces the section.
      if (cache.due && !cache.due.failed) {
        const entry = cache.due.byCourse[courseId] || NO_DUE;
        if (!linksFresh(entry)) missing = true;
        if (entry === NO_DUE || entry.linksExpires) {
          const stamp = `${cache.due.fetchedAt}:${entry.linksExpires || 0}`;
          const existing = article.querySelector(`[${MARK}="due"]`);
          if (!existing || existing.dataset.stamp !== stamp) {
            const section = buildDue(courseId, entry, stamp);
            if (existing) existing.replaceWith(section);
            else details.appendChild(section);
          }
        }
      }
    }

    return missing;
  }

  // Our own insertions are exactly what the observer watches, so it is
  // disconnected around every render.
  function renderQuietly() {
    observer.disconnect();
    const missing = render();
    observer.observe(document.body, { childList: true, subtree: true });
    return missing;
  }

  async function refresh() {
    if (refreshing) {
      refreshQueued = true;
      return refreshing;
    }

    refreshing = (async () => {
      const courseIds = [...new Set(ownCards().map(courseIdOf))];
      const userId = await loadUserId();

      const tasks = [() => loadDue()];
      if (userId) {
        for (const id of courseIds) {
          if (!fresh(cache.grades[id])) tasks.push(() => loadGrade(id, userId));
        }
      } else {
        deferGrades(courseIds);
      }
      await runLimited(tasks);
      // Links need the due items, so they resolve in a second wave.
      await runLimited(courseIds.map((id) => () => resolveLinks(id)));
      renderQuietly();
    })();

    try {
      await refreshing;
    } finally {
      refreshing = null;
    }

    if (refreshQueued) {
      refreshQueued = false;
      if (renderQuietly()) refresh();
    }
  }

  function onMutations() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (renderQuietly()) refresh();
    });
  }

  function start() {
    if (observer || !document.body) return;
    observer = new MutationObserver(onMutations);
    if (renderQuietly()) refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
