/* Port Technology Watch — front end.
 * Data: batches imported in this browser (localStorage, tied to the project database version)
 *       > window.PORT_RADAR_HISTORY (data/history.js) > fetch ../data/history.json (when served).
 * Batch merging mirrors scripts/techwatch.py (deduplication + threading).
 */
(() => {
  "use strict";

  const LS_KEY = "port-tech-radar-db-v2";
  const VESSELS_ENABLED = false;   // set to true to show CMA CGM vessels (data/vessels.js)
  const AUTO_LINK_MAX_DAYS = 540;
  const LOCALE = "en-GB";

  // Reader-facing labels. Internal values (critical / major / watch) stay unchanged.
  const LEVELS = {
    critical: { label: "Critical", color: "#c8372d", rank: 3 },
    major: { label: "Important", color: "#e07b22", rank: 2 },
    watch: { label: "To watch", color: "#e2b52b", rank: 1 },
  };
  const TOPICS = {
    automation: "Automation",
    electrification: "Electrification",
    alternative_fuels: "Alternative fuels",
    digital_ai: "Digital & AI",
    connectivity: "Connectivity",
    cybersecurity: "Cybersecurity",
    equipment: "Equipment",
    infrastructure: "Infrastructure",
    safety_security: "Safety & security",
    regulation: "Regulation",
    other: "Other",
  };
  const STATUS = {
    announcement: "Announcement", study: "Study", pilot: "Pilot", contract: "Contract",
    deployment: "Deployment", operational: "In operation", incident: "Incident", discontinued: "Discontinued",
  };

  // Operator logos (assets/logos). Matched against stakeholders and the terminal name.
  const LOGO_DIR = "../assets/logos/";
  const OPERATORS = [
    { name: "CMA CGM", file: "cma-cgm.png", ratio: 157 / 96, re: /\bCMA[\s-]?CGM\b|\bCMA Terminals\b/i },
    { name: "DP World", file: "dp-world.png", ratio: 155 / 96, re: /\bDP World\b/i },
    { name: "MSC", file: "msc.png", ratio: 109 / 96, re: /\bMSC\b|\bMediterranean Shipping\b/i },
    { name: "Maersk", file: "maersk.png", ratio: 432 / 96, re: /\bMaersk\b|\bA\.\s?P\.\s?Moller\b/i },
    { name: "APM Terminals", file: "apm-terminals.png", ratio: 420 / 96, re: /\bAPM Terminals\b/i },
    { name: "PSA", file: "psa.png", ratio: 199 / 96, re: /\bPSA\b/ },
    { name: "Hutchison Ports", file: "hutchison-ports.png", ratio: 548 / 96, re: /\bHutchison\b/i },
    { name: "COSCO Shipping", file: "cosco-shipping.svg", ratio: 74.9 / 48.5, re: /\bCOSCO\b/i },
    { name: "ICTSI", file: "ictsi.png", ratio: 455 / 96, re: /\bICTSI\b|\bInternational Container Terminal Services\b/i },
    { name: "SSA Marine", file: "ssa-marine.png", ratio: 458 / 96, re: /\bSSA Marine\b/i },
    { name: "EUROGATE", file: "eurogate.png", ratio: 227 / 96, re: /\bEUROGATE\b/i },
    { name: "Evergreen", file: "evergreen.png", ratio: 542 / 96, re: /^Evergreen\b|\bEvergreen (Marine|Line)\b/i },
  ];

  // Articles about the same port are drawn as one point (see buildSites).
  const SITE_MAX_KM = 40;
  const PRECISION_RANK = { port: 4, terminal: 3, city: 2, country: 1, global: 0 };

  const state = {
    db: emptyDb(),
    week: null,            // null = latest week, "all" = every week
    levels: new Set(Object.keys(LEVELS)),
    topic: "",
    q: "",
    openId: null,
    site: null,            // site key when the list is narrowed to one map point
  };

  let map, layer;
  const markers = new Map();   // site key -> marker
  let sites = { stamp: "", byArticle: new Map(), byKey: new Map() };
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ helpers
  function emptyDb() { return { schema_version: "2.0", updated_at: null, demo: false, weeks: [], articles: [] }; }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

  function normUrl(u) {
    if (!u) return "";
    try {
      const p = new URL(u.trim());
      const q = [...p.searchParams].filter(([k]) => !/^(utm_|fbclid|gclid|mc_|ref)/i.test(k)).sort();
      const qs = new URLSearchParams(q).toString();
      return p.host.toLowerCase().replace(/^www\./, "") + p.pathname.replace(/\/+$/, "") + (qs ? "?" + qs : "");
    } catch { return u.trim().toLowerCase(); }
  }
  function slugify(t, max = 50) {
    return (t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max).replace(/-$/, "") || "article";
  }
  const normName = (t) => (t && t.trim() ? slugify(t, 80) : "");
  const toDate = (s) => { const d = new Date(String(s).slice(0, 10) + "T00:00:00Z"); return isNaN(d) ? null : d; };
  const daysBetween = (a, b) => Math.round((b - a) / 86400000);
  const pushTo = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);

  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear();
    const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
    return `${y}-W${String(w).padStart(2, "0")}`;
  }
  function weekMonday(week) {
    const m = /^(\d{4})-W(\d{2})$/.exec(week || "");
    if (!m) return null;
    const jan4 = new Date(Date.UTC(+m[1], 0, 4));
    const day = jan4.getUTCDay() || 7;
    return new Date(jan4.getTime() + ((1 - day) + (+m[2] - 1) * 7) * 86400000);
  }
  function fmtDate(s, withYear = true) {
    const d = s instanceof Date ? s : toDate(s);
    if (!d) return s || "";
    return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
  }
  function place(loc, long = false) {
    if (!loc) return "";
    const site = loc.terminal || loc.port || loc.city;
    const parts = long ? [loc.terminal, loc.port !== loc.terminal ? loc.port : null, loc.country] : [site, loc.country];
    return [...new Set(parts.filter(Boolean))].join(", ");
  }
  const levelOf = (a) => LEVELS[a.criticality] || LEVELS.watch;
  const topicOf = (a) => TOPICS[a.category] || TOPICS.other;

  function operatorsOf(a) {
    const texts = [...(a.stakeholders || []), a.location?.terminal].filter(Boolean);
    return OPERATORS.filter((o) => texts.some((t) => o.re.test(t)));
  }
  function logoHtml(o) {
    // same visual weight for wide and compact logos
    const h = Math.round(Math.min(28, Math.max(14, Math.sqrt(1500 / o.ratio))));
    return `<img class="org" src="${LOGO_DIR}${o.file}" alt="${esc(o.name)}" title="${esc(o.name)}" height="${h}" width="${Math.round(h * o.ratio)}">`;
  }

  // ------------------------------------------------------------ sites (one map point per port)
  function km(a, b) {
    const r = Math.PI / 180;
    const h = Math.sin((b.lat - a.lat) * r / 2) ** 2
      + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  function mostFrequent(values) {
    const counts = new Map();
    for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
    let best = null, n = 0;
    for (const [v, c] of counts) if (c > n) { best = v; n = c; }
    return best;
  }

  /**
   * Groups articles that refer to the same port into one site. Two articles share a site when they
   * have the same UN/LOCODE, or the same country and a common port, terminal or city name, and are
   * less than SITE_MAX_KM apart. Global news (headquarters pins) only groups with global news.
   * The site point is the most frequent port-level position, then terminal, then city.
   */
  function buildSites(articles) {
    const parent = articles.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const pts = articles.map((a) => ({ lat: Number(a.location.lat), lon: Number(a.location.lon) }));
    const byName = new Map();
    articles.forEach((a, i) => {
      const l = a.location;
      const scope = `${l.precision === "global" ? "g" : "p"}|${l.country_code || ""}|`;
      const names = new Set([l.port, l.terminal, l.city].map(normName).filter(Boolean).map((n) => scope + n));
      if (l.unlocode) names.add("locode|" + String(l.unlocode).toUpperCase().replace(/\s+/g, ""));
      for (const n of names) pushTo(byName, n, i);
    });
    for (const [name, idx] of byName) {
      for (let x = 1; x < idx.length; x++) {
        for (let y = 0; y < x; y++) {
          if (name.startsWith("locode|") || km(pts[idx[x]], pts[idx[y]]) <= SITE_MAX_KM) {
            parent[find(idx[x])] = find(idx[y]);
            break;
          }
        }
      }
    }
    const groups = new Map();
    articles.forEach((a, i) => pushTo(groups, find(i), a));

    const byArticle = new Map(), byKey = new Map();
    for (const members of groups.values()) {
      const rank = Math.max(...members.map((a) => PRECISION_RANK[a.location.precision] ?? 0));
      const best = members.filter((a) => (PRECISION_RANK[a.location.precision] ?? 0) === rank);
      const pos = mostFrequent(best.map((a) => `${Number(a.location.lat).toFixed(4)},${Number(a.location.lon).toFixed(4)}`));
      const [lat, lon] = pos.split(",").map(Number);
      const ref = best.find((a) => `${Number(a.location.lat).toFixed(4)},${Number(a.location.lon).toFixed(4)}` === pos);
      const name = mostFrequent(members.map((a) => a.location.port))
        || mostFrequent(members.map((a) => a.location.city)) || ref.location.country;
      const base = `${ref.location.country_code || ""}-${slugify(name, 40)}`;
      let key = base, n = 2;
      while (byKey.has(key)) key = `${base}-${n++}`;
      const site = { key, name, country: ref.location.country || "", lat, lon, unlocode: ref.location.unlocode || null };
      byKey.set(key, site);
      for (const a of members) byArticle.set(a.id, site);
    }
    return { byArticle, byKey };
  }
  function ensureSites() {
    const stamp = `${state.db.updated_at}|${state.db.articles.length}`;
    if (sites.stamp === stamp) return;
    sites = { stamp, ...buildSites(state.db.articles) };
    if (state.site && !sites.byKey.has(state.site)) state.site = null;
  }
  const siteOf = (a) => sites.byArticle.get(a.id);
  function selectedSiteKey() {
    if (state.openId) {
      const a = state.db.articles.find((x) => x.id === state.openId);
      return a ? siteOf(a)?.key : null;
    }
    return state.site;
  }

  // ------------------------------------------------------------ merge (mirrors techwatch.py)
  function validateArticle(a) {
    const errs = [];
    for (const k of ["title", "published_date", "source", "link", "location", "summary", "category", "criticality"]) {
      if (a[k] == null || a[k] === "") errs.push(`missing field: ${k}`);
    }
    if (errs.length) return errs;
    if (!/^https?:\/\//.test(a.link)) errs.push("invalid link");
    if (!toDate(a.published_date)) errs.push("invalid date");
    if (!LEVELS[a.criticality]) errs.push(`unknown criticality: ${a.criticality}`);
    const lat = Number(a.location.lat), lon = Number(a.location.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) errs.push("invalid coordinates");
    return errs;
  }

  function findAutoLink(a, articles) {
    const loc = a.location;
    const term = normName(loc.terminal), port = normName(loc.port);
    if (!(term || port) || loc.precision === "global") return null;
    const d = toDate(a.published_date);
    const techs = new Set((a.technologies || []).map(normName));
    let best = null;
    for (const b of articles) {
      const bl = b.location;
      if (bl.country_code !== loc.country_code) continue;
      if (term) { if (normName(bl.terminal) !== term) continue; }
      else if (normName(bl.port) !== port || bl.terminal) continue;
      const sameTopic = b.category === a.category || (b.technologies || []).some((t) => techs.has(normName(t)));
      const bd = toDate(b.published_date);
      if (!sameTopic || !bd || bd > d || daysBetween(bd, d) > AUTO_LINK_MAX_DAYS) continue;
      if (!best || bd > toDate(best.published_date)) best = b;
    }
    return best;
  }

  function mergeBatch(db, batch) {
    const report = { added: 0, duplicates: 0, rejected: [], linked: 0, orphans: [] };
    if (!batch || !Array.isArray(batch.articles)) throw new Error("this file has no \"articles\" list");
    const articles = db.articles;
    const byLink = new Map(articles.map((a) => [normUrl(a.link), a]));
    const ids = new Set(articles.map((a) => a.id));
    const threads = new Map();
    for (const a of articles) pushTo(threads, a.thread_id, a);

    const now = new Date();
    const week = isoWeek(toDate(batch.period?.from) || toDate(batch.generated_at) || now);
    if (batch.demo) db.demo = true;

    const incoming = [...batch.articles].sort((x, y) => String(x.published_date).localeCompare(String(y.published_date)));
    for (const raw of incoming) {
      const a = JSON.parse(JSON.stringify(raw));
      const errs = validateArticle(a);
      if (errs.length) { report.rejected.push(`${a.title || a.id || "Untitled"}: ${errs.join(", ")}`); continue; }
      if (!TOPICS[a.category]) a.category = "other";
      const key = normUrl(a.link);
      if (byLink.has(key)) { report.duplicates++; continue; }

      const base = a.id || `${a.published_date}-${slugify(a.location.city || a.location.country, 20)}-${slugify(a.title, 40)}`;
      let uid = base, n = 2;
      while (ids.has(uid)) uid = `${base}-${n++}`;
      a.id = uid;
      a.week = a.week || week;
      a.added_at = a.added_at || now.toISOString();

      const prev = a.previous_link ? byLink.get(normUrl(a.previous_link)) : null;
      if (a.previous_link && !prev) report.orphans.push(a.title);

      if (prev) {
        a.thread_id = prev.thread_id; a.chaining = a.chaining || "agent"; report.linked++;
      } else if (a.thread_id && threads.has(a.thread_id)) {
        const earlier = threads.get(a.thread_id).filter((b) => b.published_date <= a.published_date)
          .sort((x, y) => x.published_date.localeCompare(y.published_date));
        if (earlier.length && !a.previous_link) a.previous_link = earlier[earlier.length - 1].link;
        a.chaining = a.chaining || "agent"; report.linked++;
      } else {
        const cand = a.previous_link ? null : findAutoLink(a, articles);
        if (cand) {
          a.thread_id = cand.thread_id; a.previous_link = cand.link; a.chaining = "auto"; report.linked++;
        } else {
          a.thread_id = a.thread_id || `thread-${uid}`; a.chaining = a.chaining || "new";
          if (a.previous_link === undefined) a.previous_link = null;
        }
      }
      articles.push(a);
      byLink.set(key, a); ids.add(uid);
      pushTo(threads, a.thread_id, a);
      report.added++;
    }

    // weekly text: agent batch (weekly_digest) or a backup file (weeks)
    const digests = batch.weekly_digest ? [{ week, period: batch.period, ...batch.weekly_digest }] : (batch.weeks || []);
    for (const d of digests) {
      db.weeks = db.weeks.filter((x) => x.week !== d.week);
      db.weeks.push(d);
    }
    db.weeks.sort((x, y) => x.week.localeCompare(y.week));
    articles.sort((x, y) => (x.published_date + x.id).localeCompare(y.published_date + y.id));
    db.updated_at = now.toISOString();
    return report;
  }

  /** Quality checks mirroring techwatch.py validate (SKILL.md sections 7 to 9). */
  function qualityWarnings(batch) {
    const w = [];
    const arts = batch.articles || [];
    const noPort = arts.filter((a) => a.location?.precision !== "global" && !(a.location?.port || "").trim()).length;
    if (noPort) w.push(`${noPort} article(s) have no port: their pins may sit in city centres and they cannot be linked to earlier news`);
    const counts = new Map();
    for (const a of arts) {
      const r = (a.criticality_rationale || "").trim().toLowerCase();
      if (r) counts.set(r, (counts.get(r) || 0) + 1);
    }
    const reused = [...counts.values()].filter((n) => n > 1).reduce((s, n) => s + n, 0);
    if (reused) w.push(`${reused} article(s) share the same importance rationale`);
    if (arts.length >= 8) {
      const share = (c) => arts.filter((a) => a.criticality === c).length / arts.length;
      if (share("critical") > 0.15) w.push(`${Math.round(share("critical") * 100)}% rated critical (about 10% expected)`);
      if (share("major") > 0.5) w.push(`${Math.round(share("major") * 100)}% rated important (30 to 45% expected)`);
      const cached = arts.filter((a) => a.source_access === "cached").length / arts.length;
      if (cached > 0.3) w.push(`${Math.round(cached * 100)}% read from cached copies`);
    }
    const from = toDate(batch.period?.from), to = toDate(batch.period?.to);
    if (from && to && daysBetween(from, to) > 8) w.push(`the batch covers ${daysBetween(from, to)} days instead of one week`);
    for (const n of batch.run_notes || []) w.push(`Agent note: ${n}`);
    return w;
  }

  // ------------------------------------------------------------ storage
  // Browser imports are stored with the version of the project database they were
  // built on. If data/history.js changes (Python merge), the project database wins.
  let projectBase = null;
  const baseStamp = () => (projectBase ? `${projectBase.updated_at}|${projectBase.articles.length}` : "none");

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ base: baseStamp(), db: state.db })); } catch { /* storage unavailable */ }
  }
  async function loadProjectBase() {
    if (window.PORT_RADAR_HISTORY) return structuredClone(window.PORT_RADAR_HISTORY);
    try {
      const r = await fetch("../data/history.json", { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch { /* page opened without a server */ }
    return null;
  }
  async function load() {
    projectBase = await loadProjectBase();
    let db = null;
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (saved?.db && saved.base === baseStamp()) db = saved.db;
      else localStorage.removeItem(LS_KEY);
    } catch { /* ignore */ }
    db = db || (projectBase ? structuredClone(projectBase) : emptyDb());
    db.weeks ||= [];
    db.articles ||= [];
    return db;
  }

  /** Extract the JSON object even if the agent wrote text around it. */
  function parseAgentJson(text) {
    text = text.replace(/^﻿/, "");
    try { return JSON.parse(text); } catch (e) {
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("this file is not valid JSON");
      return JSON.parse(text.slice(start, end + 1));
    }
  }

  // ------------------------------------------------------------ selection
  function threadsMap(articles) {
    const m = new Map();
    for (const a of articles) pushTo(m, a.thread_id, a);
    for (const list of m.values()) list.sort((x, y) => x.published_date.localeCompare(y.published_date));
    return m;
  }
  function weeksAvailable() {
    return [...new Set(state.db.articles.map((a) => a.week).filter(Boolean))].sort().reverse();
  }
  function currentWeek() {
    if (state.week === "all") return "all";
    const weeks = weeksAvailable();
    return weeks.includes(state.week) ? state.week : (weeks[0] || null);
  }
  function weekLabel(week) {
    const d = state.db.weeks.find((w) => w.week === week);
    const from = toDate(d?.period?.from), to = toDate(d?.period?.to);
    if (from && to) {
      const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
      return `${fmtDate(from, !sameYear)} – ${fmtDate(to)}`;
    }
    const mon = weekMonday(week);
    return mon ? `Week of ${fmtDate(mon)}` : week;
  }
  /** Articles in scope (week + search), before the importance and topic filters. */
  function scoped() {
    const week = currentWeek();
    let arts = state.db.articles;
    if (state.q) {
      const q = slugify(state.q, 200);
      arts = arts.filter((a) => slugify([a.title, a.summary, a.source, place(a.location, true), a.location.city,
        ...(a.technologies || []), ...(a.stakeholders || []), ...(a.tags || []), topicOf(a)].join(" "), 100000).includes(q));
    } else if (week !== "all") {
      arts = arts.filter((a) => a.week === week);
    }
    return arts;
  }
  const filtered = (arts) => arts.filter((a) => state.levels.has(a.criticality) && (!state.topic || a.category === state.topic));
  const byImportance = (x, y) => levelOf(y).rank - levelOf(x).rank || (y.score || 0) - (x.score || 0) || y.published_date.localeCompare(x.published_date);

  // ------------------------------------------------------------ rendering
  function render() {
    ensureSites();
    const inScope = scoped();
    const visible = filtered(inScope);
    renderHeader();
    renderEdition();
    renderFilters(inScope);
    renderSiteBar();
    renderList(state.site ? visible.filter((a) => siteOf(a)?.key === state.site) : visible);
    renderMarkers(visible);
    if (state.openId) renderDetail(state.openId);
  }

  function renderSiteBar() {
    const s = state.site && sites.byKey.get(state.site);
    $("siteBar").hidden = !s;
    if (s) {
      $("siteBar").innerHTML = `<span class="site-bar__name">${esc([s.name, s.country].filter(Boolean).join(", "))}</span>
        <button class="text-btn" id="clearSite">Show all locations</button>`;
    }
  }

  function renderHeader() {
    $("updated").textContent = state.db.updated_at ? `Updated ${fmtDate(state.db.updated_at.slice(0, 10))}` : "";
    $("demoNote").hidden = !state.db.demo;
  }

  function renderEdition() {
    const el = $("edition");
    const weeks = weeksAvailable();
    if (!weeks.length) {
      el.innerHTML = `<h1 class="edition__title">No articles yet</h1>
        <p class="edition__text">Import the agent's JSON file from the menu at the top right, or drop it on the page.</p>`;
      return;
    }
    const week = currentWeek();
    const options = weeks.map((w) => `<option value="${esc(w)}" ${w === week ? "selected" : ""}>${esc(weekLabel(w))}</option>`).join("")
      + `<option value="all" ${week === "all" ? "selected" : ""}>All weeks</option>`;
    const select = `<select class="week-select" id="weekSelect" aria-label="Week">${options}</select>`;

    if (state.q) {
      el.innerHTML = `${select}<h1 class="edition__title">Search results</h1>`;
      return;
    }
    const d = week === "all" ? null : state.db.weeks.find((w) => w.week === week);
    const title = week === "all" ? "All articles" : (d?.headline || weekLabel(week));
    const text = d?.editorial || "";
    el.innerHTML = `${select}
      <h1 class="edition__title">${esc(title)}</h1>
      ${text ? `<p class="edition__text ${text.length > 200 ? "is-clamped" : ""}" id="editionText">${esc(text)}</p>` : ""}
      ${text.length > 200 ? `<button class="text-btn" id="moreBtn">Read more</button>` : ""}`;
  }

  function renderFilters(inScope) {
    $("levels").innerHTML = Object.entries(LEVELS).map(([k, v]) => {
      const n = inScope.filter((a) => a.criticality === k).length;
      return `<button class="level" data-level="${k}" aria-pressed="${state.levels.has(k)}"><i class="dot dot--${k}"></i>${v.label} <span>${n}</span></button>`;
    }).join("");
    const present = new Set(state.db.articles.map((a) => a.category));
    $("topic").innerHTML = `<option value="">All topics</option>` + Object.entries(TOPICS)
      .filter(([k]) => present.has(k))
      .map(([k, label]) => `<option value="${k}" ${state.topic === k ? "selected" : ""}>${label}</option>`).join("");
  }

  function itemHtml(a, threads) {
    const isUpdate = (threads.get(a.thread_id) || []).indexOf(a) > 0;
    const meta = [place(a.location), topicOf(a), fmtDate(a.published_date, false), isUpdate ? "Update" : null].filter(Boolean).join(" · ");
    return `<li><button class="item ${state.openId === a.id ? "is-active" : ""}" data-id="${esc(a.id)}">
      <i class="dot dot--${esc(a.criticality)}" title="${levelOf(a).label}"></i>
      <span><span class="item__title">${esc(a.title)}</span><span class="item__meta">${esc(meta)}</span></span>
    </button></li>`;
  }

  function renderList(visible) {
    const el = $("list");
    if (!state.db.articles.length) { el.innerHTML = ""; return; }
    if (!visible.length) {
      el.innerHTML = `<p class="empty">No articles match these filters.</p>`;
      return;
    }
    const threads = threadsMap(state.db.articles);
    if (currentWeek() === "all" || state.q) {
      const groups = new Map();
      for (const a of visible) pushTo(groups, a.week || "", a);
      el.innerHTML = [...groups.keys()].sort().reverse().map((w) =>
        `<h2 class="group">${esc(weekLabel(w))}</h2><ul class="list">${groups.get(w).sort(byImportance).map((a) => itemHtml(a, threads)).join("")}</ul>`).join("");
    } else {
      el.innerHTML = `<ul class="list">${[...visible].sort(byImportance).map((a) => itemHtml(a, threads)).join("")}</ul>`;
    }
  }

  function renderMarkers(visible) {
    layer.clearLayers();
    markers.clear();
    const allThreads = threadsMap(state.db.articles);
    // one marker per site; each story (thread) is represented by its latest visible article
    const bySite = new Map();
    for (const list of threadsMap(visible).values()) {
      const a = list.at(-1);
      const s = siteOf(a);
      if (s) pushTo(bySite, s.key, a);
    }
    // most important drawn last (on top)
    const groups = [...bySite].map(([key, arts]) => ({ site: sites.byKey.get(key), arts: arts.sort(byImportance) }))
      .sort((x, y) => levelOf(x.arts[0]).rank - levelOf(y.arts[0]).rank);
    const selected = selectedSiteKey();
    const taken = new Map();
    for (const { site, arts } of groups) {
      const top = arts[0], count = arts.length;
      let lat = site.lat, lon = site.lon;
      const k = `${lat.toFixed(1)}|${lon.toFixed(1)}`;
      const n = taken.get(k) || 0;
      taken.set(k, n + 1);
      if (n) { const ang = n * 2.4, r = 0.08 * Math.ceil(n / 6); lat += r * Math.sin(ang); lon += r * Math.cos(ang); }
      const size = count > 1 ? 19 : (allThreads.get(top.thread_id)?.length || 1) > 1 ? 15 : 13;
      const icon = L.divIcon({
        className: "marker-icon", iconSize: [size, size],
        html: `<div class="marker ${count > 1 ? "marker--multi" : ""} ${selected === site.key ? "is-selected" : ""}" style="--c:${levelOf(top).color}">${count > 1 ? count : ""}</div>`,
      });
      const tip = count === 1
        ? `<div class="tip__title">${esc(top.title)}</div><div class="tip__place">${esc(place(top.location))}</div>`
        : `<div class="tip__title">${esc([site.name, site.country].filter(Boolean).join(", "))}</div>
           <div class="tip__place">${count} stories</div>
           <ul class="tip__list">${arts.slice(0, 3).map((a) => `<li><i class="dot dot--${esc(a.criticality)}"></i>${esc(a.title)}</li>`).join("")}</ul>
           ${count > 3 ? `<div class="tip__place">and ${count - 3} more</div>` : ""}`;
      const m = L.marker([lat, lon], { icon, riseOnHover: true, zIndexOffset: levelOf(top).rank * 100, title: "" })
        .bindTooltip(tip, { className: "tip", direction: "top", offset: [0, -size / 2 - 2], opacity: 1 })
        .on("click", () => (count === 1 ? openArticle(top.id, false) : openSite(site.key)));
      m.addTo(layer);
      markers.set(site.key, m);
    }
  }

  function highlightMarker(key) {
    document.querySelectorAll(".marker.is-selected").forEach((m) => m.classList.remove("is-selected"));
    if (key) markers.get(key)?.getElement()?.querySelector(".marker")?.classList.add("is-selected");
  }

  /** Narrow the list to the stories of one map point. */
  function openSite(key) {
    state.site = key;
    state.openId = null;
    $("detailView").hidden = true;
    $("listView").hidden = false;
    render();
    $("siteBar").scrollIntoView({ block: "nearest" });
  }
  function clearSite() {
    state.site = null;
    render();
  }

  // ------------------------------------------------------------ detail
  function renderDetail(id) {
    const a = state.db.articles.find((x) => x.id === id);
    if (!a) return closeDetail();
    const thread = threadsMap(state.db.articles).get(a.thread_id) || [a];
    const lv = levelOf(a);
    const meta = [place(a.location, true), fmtDate(a.published_date), a.source].filter(Boolean).join(" · ");
    const kind = [lv.label, topicOf(a), STATUS[a.status]].filter(Boolean).join(" · ");
    const orgs = operatorsOf(a);
    const backTo = (state.site && sites.byKey.get(state.site)?.name) || "All articles";
    $("detailView").innerHTML = `
      <button class="back" id="backBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
        ${esc(backTo)}
      </button>
      <div class="detail__level"><i class="dot dot--${esc(a.criticality)}"></i>${esc(kind)}</div>
      <h2 class="detail__title">${esc(a.title)}</h2>
      <p class="detail__meta">${esc(meta)}</p>
      ${orgs.length ? `<div class="orgs">${orgs.map(logoHtml).join("")}</div>` : ""}
      <p class="detail__summary">${esc(a.summary)}</p>
      ${(a.key_points || []).length ? `<ul class="detail__points">${a.key_points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      <a class="detail__link" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer">Read the article on ${esc(a.source)}</a>
      ${thread.length > 1 ? `
        <section class="timeline">
          <h3>Timeline</h3>
          <ol>${thread.map((t) => `
            <li class="tl ${t.id === a.id ? "is-current" : ""}">
              <div class="tl__date">${fmtDate(t.published_date)}${STATUS[t.status] ? ` · ${STATUS[t.status]}` : ""}</div>
              <button class="tl__title" data-id="${esc(t.id)}" ${t.id === a.id ? "disabled" : ""}>${esc(t.title)}</button>
            </li>`).join("")}
          </ol>
        </section>` : ""}`;
  }

  function openArticle(id, fly = true) {
    const a = state.db.articles.find((x) => x.id === id);
    if (!a) return;
    const s = siteOf(a);
    if (state.site && state.site !== s?.key) { state.site = null; render(); }
    state.openId = id;
    $("listView").hidden = true;
    $("detailView").hidden = false;
    renderDetail(id);
    $("panel").scrollTop = 0;
    highlightMarker(s?.key);
    const m = s && markers.get(s.key);
    const ll = m ? m.getLatLng() : L.latLng(a.location.lat, a.location.lon);
    if (fly) map.flyTo(ll, Math.max(map.getZoom(), 5), { duration: 0.6 });
  }

  function closeDetail() {
    const wasOpen = state.openId;
    state.openId = null;
    $("detailView").hidden = true;
    $("listView").hidden = false;
    highlightMarker(state.site);
    if (wasOpen) {
      document.querySelectorAll(".item.is-active").forEach((i) => i.classList.remove("is-active"));
      const item = document.querySelector(`.item[data-id="${CSS.escape(wasOpen)}"]`);
      item?.classList.add("is-active");
      item?.scrollIntoView({ block: "nearest" });
    }
  }

  // ------------------------------------------------------------ data menu
  let toastTimer;
  function toast(html, ms = 5000) {
    const t = $("toast");
    t.innerHTML = html;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-on"), ms);
  }

  async function importFiles(files) {
    const lines = [], notes = [];
    let ok = false;
    for (const f of files) {
      try {
        const data = parseAgentJson(await f.text());
        if (state.db.demo && !data.demo && state.db.articles.length) state.db = emptyDb();   // first real data replaces the demo
        const r = mergeBatch(state.db, data);
        ok = true;
        const extra = [r.linked ? `${r.linked} linked to earlier news` : "", r.duplicates ? `${r.duplicates} already present` : ""].filter(Boolean).join(", ");
        lines.push(`${r.added} article${r.added === 1 ? "" : "s"} added${extra ? ` (${extra})` : ""}.`);
        if (data.weekly_digest || data.run_notes) notes.push(...qualityWarnings(data));
        notes.push(...r.rejected.map((x) => `Not imported: ${x}`), ...r.orphans.map((x) => `Earlier article not found for: ${x}`));
      } catch (e) {
        lines.push(`${esc(f.name)} could not be imported: ${esc(e.message)}.`);
      }
    }
    if (ok) { save(); state.week = null; state.site = null; closeDetail(); render(); }
    toast(lines.join("<br>") + (notes.length
      ? `<details><summary>${notes.length} remark${notes.length === 1 ? "" : "s"} on this batch</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`
      : ""), notes.length ? 15000 : 5000);
  }

  function buildContext(db) {
    const threads = [];
    for (const [tid, arts] of threadsMap(db.articles)) {
      const last = arts.at(-1);
      if (daysBetween(toDate(last.published_date), new Date()) > 550) continue;
      const loc = last.location;
      const s = siteOf(last);
      threads.push({
        thread_id: tid,
        terminal: loc.terminal ?? null, port: loc.port ?? null,
        country: loc.country ?? null, country_code: loc.country_code ?? null,
        site: s ? { name: s.name, lat: s.lat, lon: s.lon, unlocode: s.unlocode } : null,
        category: last.category,
        technologies: [...new Set(arts.flatMap((x) => x.technologies || []))].sort(),
        article_count: arts.length,
        history: arts.slice(-4).map((x) => `${x.published_date} [${x.status || "?"}] ${x.title}`),
        latest_article: { title: last.title, link: last.link, date: last.published_date, status: last.status ?? null },
      });
    }
    threads.sort((a, b) => b.latest_article.date.localeCompare(a.latest_article.date));
    return {
      generated_at: new Date().toISOString(),
      instructions: "Known news threads. To extend a thread: copy thread_id and put latest_article.link in previous_link (see SKILL.md section 6). For any article at a port listed here, reuse site.lat and site.lon exactly (SKILL.md section 7).",
      threads,
    };
  }

  function download(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function menuAction(action) {
    if (action === "context") {
      download(buildContext(state.db), "thread_context.json");
      toast("Agent context downloaded. Give it to the agent with the skill and the schema.");
    } else if (action === "backup") {
      download(state.db, `port-technology-watch-backup-${new Date().toISOString().slice(0, 10)}.json`);
      toast("Backup downloaded. Import it to restore the data.");
    } else if (action === "reset") {
      if (!confirm("Delete every batch imported in this browser?\n\nDownload a backup first if you want to keep them.")) return;
      try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
      state.db = await load();
      state.week = null;
      state.site = null;
      closeDetail();
      render();
      toast("Data reset.");
    }
  }

  function setMenu(open) {
    $("menu").hidden = !open;
    $("menuBtn").setAttribute("aria-expanded", String(open));
  }

  // ------------------------------------------------------------ events
  function bind() {
    $("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); setMenu($("menu").hidden); });
    document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) setMenu(false); });
    $("menu").addEventListener("click", (e) => {
      const b = e.target.closest("[data-action]");
      if (b) { setMenu(false); menuAction(b.dataset.action); }
    });
    $("fileInput").addEventListener("change", (e) => { setMenu(false); importFiles([...e.target.files]); e.target.value = ""; });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("menu").hidden) setMenu(false);
      else if (state.openId) closeDetail();
      else if (state.site) clearSite();
    });
    $("siteBar").addEventListener("click", (e) => { if (e.target.id === "clearSite") clearSite(); });

    let qTimer;
    $("search").addEventListener("input", (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 150);
    });
    $("topic").addEventListener("change", (e) => { state.topic = e.target.value; render(); });
    $("levels").addEventListener("click", (e) => {
      const b = e.target.closest("[data-level]");
      if (!b) return;
      const k = b.dataset.level;
      if (state.levels.has(k) && state.levels.size > 1) state.levels.delete(k); else state.levels.add(k);
      render();
    });

    $("edition").addEventListener("change", (e) => {
      if (e.target.id === "weekSelect") { state.week = e.target.value; render(); }
    });
    $("edition").addEventListener("click", (e) => {
      if (e.target.id === "moreBtn") {
        const p = $("editionText");
        const clamped = p.classList.toggle("is-clamped");
        e.target.textContent = clamped ? "Read more" : "Show less";
      }
    });

    $("list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (b) openArticle(b.dataset.id);
    });
    $("detailView").addEventListener("click", (e) => {
      if (e.target.closest("#backBtn")) return closeDetail();
      const b = e.target.closest(".tl__title[data-id]");
      if (b && !b.disabled) openArticle(b.dataset.id);
    });

    // drag and drop import
    let depth = 0;
    const dz = $("dropzone");
    window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { depth++; dz.classList.add("is-on"); } });
    window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; dz.classList.remove("is-on"); } });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault(); depth = 0; dz.classList.remove("is-on");
      const files = [...(e.dataTransfer?.files || [])].filter((f) => /json$/i.test(f.name) || f.type.includes("json"));
      if (files.length) importFiles(files);
    });
  }

  function initMap() {
    map = L.map("map", { worldCopyJump: true, minZoom: 2, zoomControl: false }).setView([25, 15], 2.4);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics", maxZoom: 18,
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }

  // ------------------------------------------------------------ optional: CMA CGM vessels
  function initVessels() {
    const SHIP_SVG = '<svg viewBox="0 0 12 28" width="9" height="21" aria-hidden="true"><path d="M6 0 L11 8 L11 26 Q11 28 9 28 L3 28 Q1 28 1 26 L1 8 Z" fill="#fff" stroke="#04246a" stroke-width="1.5"/></svg>';
    map.createPane("ships").style.zIndex = 450;
    const shipLayer = L.layerGroup().addTo(map);
    const draw = () => {
      shipLayer.clearLayers();
      for (const v of window.PORT_RADAR_VESSELS?.vessels || []) {
        if (!isFinite(v.lat) || !isFinite(v.lon)) continue;
        const ageH = v.timestamp ? (Date.now() - new Date(v.timestamp)) / 3600000 : 0;
        L.marker([v.lat, v.lon], {
          pane: "ships", keyboard: false,
          icon: L.divIcon({ className: "ship-icon", iconSize: [22, 22], html: `<div class="ship ${ageH > 6 ? "ship--stale" : ""}" style="transform:rotate(${Number(v.heading) || 0}deg)">${SHIP_SVG}</div>` }),
        }).bindTooltip(`<div class="tip__title">${esc(v.name)}</div><div class="tip__place">${esc([v.status, v.destination && `to ${v.destination}`].filter(Boolean).join(" · "))}</div>`,
          { className: "tip", direction: "top", offset: [0, -10] }).addTo(shipLayer);
      }
    };
    const load = () => {
      const s = document.createElement("script");
      s.src = `../data/vessels.js?t=${Date.now()}`;
      s.onload = () => { draw(); s.remove(); };
      s.onerror = () => s.remove();
      document.body.appendChild(s);
    };
    load();
    setInterval(load, 5 * 60 * 1000);
  }

  async function init() {
    if (!window.L) {
      document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">The map library could not be loaded. Check your internet connection or proxy.</p>';
      return;
    }
    initMap();
    bind();
    if (VESSELS_ENABLED) initVessels();
    state.db = await load();
    render();
  }

  init();
})();
