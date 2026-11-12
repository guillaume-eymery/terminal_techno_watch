#!/usr/bin/env python3
"""Port technology watch tools (standard library only).

Commands:
  validate <batch.json> [...]  Check a batch produced by the Mistral agent.
  merge <batch.json> [...]     Merge one or more batches into data/history.json
                               (deduplication, threading), then regenerate
                               data/history.js and agent/thread_context.json.
  context                      Regenerate agent/thread_context.json (agent input).
  export-js                    Regenerate data/history.js (lets the front end run without a server).
  reset                        Empty the database (a backup is saved in data/samples/).

The first merge of a real (non-demo) batch automatically removes demo data
(backup in data/samples/history_demo_backup.json; use --keep-demo to keep it).
Any text the agent writes around the JSON (progress messages, ```json fences) is ignored.

Weekly cycle:
  python scripts/techwatch.py context
  (run the Mistral agent with SKILL.md + agent/thread_context.json -> data/inbox/batch.json)
  python scripts/techwatch.py merge data/inbox/batch.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

ROOT = Path(__file__).resolve().parent.parent
HISTORY = ROOT / "data" / "history.json"
HISTORY_JS = ROOT / "data" / "history.js"
CONTEXT = ROOT / "agent" / "thread_context.json"

SCHEMA_VERSION = "2.0"
CRITICALITY = ("critical", "major", "watch")
SCORE_BOUNDS = {"critical": (70, 100), "major": (40, 69), "watch": (1, 39)}
CATEGORIES = ("automation", "electrification", "alternative_fuels", "digital_ai", "connectivity",
              "cybersecurity", "equipment", "infrastructure", "safety_security", "regulation", "other")
STATUSES = ("announcement", "study", "pilot", "contract", "deployment", "operational",
            "incident", "discontinued")
PRECISIONS = ("terminal", "port", "city", "country", "global")
SOURCE_ACCESS = ("live", "cached", "secondary")
REQUIRED = ("title", "published_date", "source", "link", "location", "summary",
            "category", "criticality")
AUTO_LINK_MAX_DAYS = 540   # window for automatic threading
CONTEXT_MAX_DAYS = 550     # maximum age of threads passed to the agent
TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "mc_", "ref")


# ---------------------------------------------------------------- helpers
def load_json(path: Path) -> dict:
    """Read JSON, tolerating text the agent sometimes adds around it."""
    text = path.read_text(encoding="utf-8-sig")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise
        print(f"  i {path.name}: ignored non-JSON text ({start} characters before, "
              f"{len(text) - end - 1} after)")
        return json.loads(text[start:end + 1])


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def norm_url(url: str | None) -> str:
    """URL comparison key: no scheme, no www, no tracking parameters."""
    if not url:
        return ""
    p = urlsplit(url.strip())
    host = p.netloc.lower().removeprefix("www.")
    query = urlencode(sorted((k, v) for k, v in parse_qsl(p.query)
                             if not k.lower().startswith(TRACKING_PARAMS)))
    return f"{host}{p.path.rstrip('/')}" + (f"?{query}" if query else "")


def slugify(text: str, max_len: int = 50) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text[:max_len].rstrip("-") or "article"


def norm_name(text: str | None) -> str:
    # empty stays empty (slugify would return the "article" fallback and make
    # every unnamed port match every other one)
    return slugify(text, 80) if text and text.strip() else ""


def parse_date(s) -> dt.date | None:
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def iso_week(d: dt.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def empty_history() -> dict:
    return {"schema_version": SCHEMA_VERSION, "updated_at": None, "demo": False,
            "weeks": [], "articles": []}


# ---------------------------------------------------------------- validation
def validate_article(a: dict) -> tuple[list[str], list[str]]:
    errors, warnings = [], []
    for k in REQUIRED:
        if a.get(k) in (None, "", [], {}):
            errors.append(f"missing required field: {k}")
    if errors:
        return errors, warnings
    if not str(a["link"]).startswith(("http://", "https://")):
        errors.append(f"invalid link: {a['link']}")
    if not parse_date(a["published_date"]):
        errors.append(f"invalid published_date: {a['published_date']}")
    if a["criticality"] not in CRITICALITY:
        errors.append(f"unknown criticality: {a['criticality']}")
    loc = a["location"]
    try:
        lat, lon = float(loc.get("lat")), float(loc.get("lon"))
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            errors.append(f"coordinates out of range: {lat}, {lon}")
    except (TypeError, ValueError):
        errors.append("location.lat / lon missing or not numeric")
    if a["category"] not in CATEGORIES:
        warnings.append(f"unknown category '{a['category']}' -> replaced with 'other'")
    if a.get("status") and a["status"] not in STATUSES:
        warnings.append(f"unknown status: {a['status']}")
    if loc.get("precision") and loc["precision"] not in PRECISIONS:
        warnings.append(f"unknown precision: {loc['precision']}")
    score = a.get("score")
    if isinstance(score, int) and a["criticality"] in SCORE_BOUNDS:
        lo, hi = SCORE_BOUNDS[a["criticality"]]
        if not lo <= score <= hi:
            warnings.append(f"score {score} inconsistent with criticality '{a['criticality']}'")
    if len(a.get("summary", "")) > 600:
        warnings.append("summary too long (> 600 characters)")
    # quality checks (SKILL.md sections 7 to 9)
    if loc.get("precision") != "global" and not (loc.get("port") or "").strip():
        warnings.append("location.port is empty (required for non-global news)")
    if loc.get("precision") in ("city", "country") and (loc.get("port") or "").strip():
        warnings.append(f"precision '{loc['precision']}' although a port is given: pin should be on the port/terminal")
    if a.get("source_access") not in SOURCE_ACCESS:
        warnings.append(f"source_access missing or unknown: {a.get('source_access')!r}")
    noisy = [t for t in a.get("tags") or [] if len(t) > 40 or ";" in t or "fetch" in t.lower() or "cache" in t.lower()]
    if noisy:
        warnings.append(f"process notes in tags: {noisy}")
    return errors, warnings


def validate_batch(batch: dict) -> tuple[list[str], list[str]]:
    errors, warnings = [], []
    if not isinstance(batch.get("articles"), list):
        return ["'articles' key missing or invalid"], []
    if batch.get("schema_version") != SCHEMA_VERSION:
        warnings.append(f"schema_version is {batch.get('schema_version')!r}, expected {SCHEMA_VERSION!r}")
    seen_ids, seen_links = set(), set()
    for i, a in enumerate(batch["articles"]):
        tag = f"articles[{i}] ({a.get('id') or str(a.get('title', '?'))[:40]})"
        e, w = validate_article(a)
        errors += [f"{tag}: {x}" for x in e]
        warnings += [f"{tag}: {x}" for x in w]
        if a.get("id") in seen_ids:
            errors.append(f"{tag}: duplicate id")
        if norm_url(a.get("link")) in seen_links:
            warnings.append(f"{tag}: duplicate link in batch")
        seen_ids.add(a.get("id"))
        seen_links.add(norm_url(a.get("link")))
    # batch-level quality checks
    arts = batch["articles"]
    if "run_notes" not in batch:
        warnings.append("run_notes missing (list of notes on the run, may be empty)")
    rationales: dict[str, int] = {}
    for a in arts:
        r = (a.get("criticality_rationale") or "").strip().lower()
        if r:
            rationales[r] = rationales.get(r, 0) + 1
    for r, n in rationales.items():
        if n > 1:
            warnings.append(f"criticality_rationale reused {n} times (must be article-specific): \"{r[:70]}...\"")
    if len(arts) >= 8:
        share = lambda c: sum(a.get("criticality") == c for a in arts) / len(arts)
        if share("critical") > 0.15:
            warnings.append(f"{share('critical'):.0%} of articles are critical (target about 10%)")
        if share("major") > 0.5:
            warnings.append(f"{share('major'):.0%} of articles are major (target 30-45%)")
        cached = sum(a.get("source_access") == "cached" for a in arts) / len(arts)
        if cached > 0.3:
            warnings.append(f"{cached:.0%} of articles read from cached copies: check reliability")
    try:
        span = (parse_date(batch["period"]["to"]) - parse_date(batch["period"]["from"])).days
        if span > 8:
            warnings.append(f"period covers {span} days (weekly batches expected)")
    except (KeyError, TypeError):
        pass

    digest = batch.get("weekly_digest") or {}
    refs = list(digest.get("must_read") or [])
    if (digest.get("key_figure") or {}).get("article_id"):
        refs.append(digest["key_figure"]["article_id"])
    for r in refs:
        if r not in seen_ids:
            warnings.append(f"weekly_digest references an unknown id: {r}")
    return errors, warnings


# ---------------------------------------------------------------- merge
def find_auto_link(a: dict, articles: list[dict]) -> dict | None:
    """Cautious automatic threading: same terminal (or same port when no terminal
    is given) + same category or a shared technology, within the time window."""
    loc = a["location"]
    term, port, country = norm_name(loc.get("terminal")), norm_name(loc.get("port")), loc.get("country_code")
    if not (term or port) or loc.get("precision") == "global":
        return None
    d = parse_date(a["published_date"])
    techs = {norm_name(t) for t in a.get("technologies") or []}
    best = None
    for b in articles:
        bl = b["location"]
        if bl.get("country_code") != country:
            continue
        if term:
            if norm_name(bl.get("terminal")) != term:
                continue
        elif norm_name(bl.get("port")) != port or bl.get("terminal"):
            continue
        same_topic = b["category"] == a["category"] or techs & {norm_name(t) for t in b.get("technologies") or []}
        bd = parse_date(b["published_date"])
        if not same_topic or not bd or bd > d or (d - bd).days > AUTO_LINK_MAX_DAYS:
            continue
        if best is None or bd > parse_date(best["published_date"]):
            best = b
    return best


def merge_batch(history: dict, batch: dict, now: dt.datetime) -> dict:
    report = {"added": 0, "duplicates": 0, "rejected": [], "linked_by_agent": 0,
              "linked_auto": 0, "orphan_links": [], "warnings": []}
    articles = history["articles"]
    by_link = {norm_url(a["link"]): a for a in articles}
    ids = {a["id"] for a in articles}
    threads: dict[str, list[dict]] = {}
    for a in articles:
        threads.setdefault(a["thread_id"], []).append(a)

    ref = parse_date((batch.get("period") or {}).get("from", "")) \
        or parse_date(batch.get("generated_at", "")) or now.date()
    week = iso_week(ref)
    if batch.get("demo"):
        history["demo"] = True

    incoming = sorted(batch.get("articles", []), key=lambda x: str(x.get("published_date", "")))
    for raw in incoming:
        a = json.loads(json.dumps(raw))  # deep copy
        errors, warnings = validate_article(a)
        label = a.get("id") or a.get("title", "?")
        if errors:
            report["rejected"].append({"article": label, "errors": errors})
            continue
        report["warnings"] += [f"{label}: {w}" for w in warnings]
        if a["category"] not in CATEGORIES:
            a["category"] = "other"
        key = norm_url(a["link"])
        if key in by_link:
            report["duplicates"] += 1
            continue

        loc = a["location"]
        base_id = a.get("id") or f"{a['published_date']}-{slugify(loc.get('city') or loc.get('country'), 20)}-{slugify(a['title'], 40)}"
        uid, n = base_id, 2
        while uid in ids:
            uid, n = f"{base_id}-{n}", n + 1
        a["id"] = uid
        a["week"] = week
        a["added_at"] = now.isoformat(timespec="seconds")

        prev = by_link.get(norm_url(a.get("previous_link"))) if a.get("previous_link") else None
        if a.get("previous_link") and not prev:
            report["orphan_links"].append(f"{uid} -> {a['previous_link']}")

        if prev:
            a["thread_id"] = prev["thread_id"]
            a["chaining"] = "agent"
            report["linked_by_agent"] += 1
        elif a.get("thread_id") in threads:
            earlier = [b for b in threads[a["thread_id"]] if b["published_date"] <= a["published_date"]]
            if earlier and not a.get("previous_link"):
                a["previous_link"] = max(earlier, key=lambda b: b["published_date"])["link"]
            a["chaining"] = "agent"
            report["linked_by_agent"] += 1
        else:
            cand = None if a.get("previous_link") else find_auto_link(a, articles)
            if cand:
                a["thread_id"] = cand["thread_id"]
                a["previous_link"] = cand["link"]
                a["chaining"] = "auto"
                a["chaining_rationale"] = a.get("chaining_rationale") or \
                    "Automatic link: same site and same topic."
                report["linked_auto"] += 1
            else:
                a["thread_id"] = a.get("thread_id") or f"thread-{uid}"
                a["chaining"] = "new"
                a.setdefault("previous_link", None)

        articles.append(a)
        by_link[key] = a
        ids.add(uid)
        threads.setdefault(a["thread_id"], []).append(a)
        report["added"] += 1

    if batch.get("weekly_digest"):
        history["weeks"] = [w for w in history["weeks"] if w.get("week") != week]
        history["weeks"].append({"week": week, "period": batch.get("period"), **batch["weekly_digest"]})
        history["weeks"].sort(key=lambda w: w["week"])
    articles.sort(key=lambda x: (x["published_date"], x["id"]))
    history["updated_at"] = now.isoformat(timespec="seconds")
    return report


# ---------------------------------------------------------------- outputs
def build_context(history: dict, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    threads: dict[str, list[dict]] = {}
    for a in history["articles"]:
        threads.setdefault(a["thread_id"], []).append(a)
    out = []
    for tid, arts in threads.items():
        arts.sort(key=lambda x: x["published_date"])
        last = arts[-1]
        d = parse_date(last["published_date"])
        if d and (today - d).days > CONTEXT_MAX_DAYS:
            continue
        loc = last["location"]
        out.append({
            "thread_id": tid,
            "terminal": loc.get("terminal"), "port": loc.get("port"),
            "country": loc.get("country"), "country_code": loc.get("country_code"),
            "site": {"name": loc.get("port") or loc.get("city"), "lat": loc.get("lat"), "lon": loc.get("lon"),
                     "unlocode": loc.get("unlocode")},
            "category": last["category"],
            "technologies": sorted({t for x in arts for t in x.get("technologies") or []}),
            "article_count": len(arts),
            "history": [f"{x['published_date']} [{x.get('status', '?')}] {x['title']}" for x in arts[-4:]],
            "latest_article": {"title": last["title"], "link": last["link"],
                               "date": last["published_date"], "status": last.get("status")},
        })
    out.sort(key=lambda t: t["latest_article"]["date"], reverse=True)
    return {"generated_at": dt.datetime.now().isoformat(timespec="seconds"),
            "instructions": "Known news threads. To extend a thread: copy thread_id and put "
                            "latest_article.link in previous_link (see SKILL.md section 6). For any article "
                            "at a port listed here, reuse site.lat and site.lon exactly (SKILL.md section 7).",
            "threads": out}


def export_js(history: dict) -> None:
    HISTORY_JS.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_JS.write_text("// Generated by scripts/techwatch.py - do not edit by hand.\n"
                          "window.PORT_RADAR_HISTORY = " + json.dumps(history, ensure_ascii=False) + ";\n",
                          encoding="utf-8")


def load_history() -> dict:
    return load_json(HISTORY) if HISTORY.exists() else empty_history()


def write_all(history: dict) -> None:
    save_json(HISTORY, history)
    export_js(history)
    save_json(CONTEXT, build_context(history))


# ---------------------------------------------------------------- CLI
def cmd_validate(args) -> int:
    code = 0
    for p in args.files:
        errors, warnings = validate_batch(load_json(Path(p)))
        print(f"\n== {p}")
        for w in warnings:
            print(f"  ! {w}")
        for e in errors:
            print(f"  x {e}")
        print("  OK, valid" if not errors else f"  {len(errors)} error(s)")
        code |= bool(errors)
    return code


def cmd_merge(args) -> int:
    history = load_history()
    now = dt.datetime.now().astimezone()
    for p in args.files:
        batch = load_json(Path(p))
        if history.get("demo") and not batch.get("demo") and not args.keep_demo:
            if not args.dry_run:
                dest = ROOT / "data" / "samples" / "history_demo_backup.json"
                save_json(dest, history)
                print(f"  i demo data removed (backup: {dest.relative_to(ROOT)})")
            history = empty_history()
        report = merge_batch(history, batch, now)
        print(f"\n== {p}")
        print(f"  + {report['added']} added · {report['duplicates']} duplicate(s) skipped · "
              f"{report['linked_by_agent']} linked by the agent · {report['linked_auto']} linked automatically")
        for r in report["rejected"]:
            print(f"  x rejected {r['article']}: {'; '.join(r['errors'])}")
        for o in report["orphan_links"]:
            print(f"  ! previous_link not found in history: {o}")
        for w in report["warnings"]:
            print(f"  ! {w}")
    if args.dry_run:
        print("\n(dry run: nothing written)")
        return 0
    write_all(history)
    print(f"\nDatabase: {len(history['articles'])} articles -> {HISTORY.relative_to(ROOT)}, "
          f"{HISTORY_JS.relative_to(ROOT)}, {CONTEXT.relative_to(ROOT)}")
    return 0


def cmd_reset(args) -> int:
    history = load_history()
    if history["articles"]:
        dest = ROOT / "data" / "samples" / f"history_backup_{dt.datetime.now():%Y%m%d_%H%M%S}.json"
        save_json(dest, history)
        print(f"Previous database backed up: {dest.relative_to(ROOT)}")
    write_all(empty_history())
    print("Database emptied.")
    return 0


def cmd_context(args) -> int:
    ctx = build_context(load_history())
    save_json(CONTEXT, ctx)
    print(f"{len(ctx['threads'])} thread(s) -> {CONTEXT.relative_to(ROOT)}")
    return 0


def cmd_export_js(args) -> int:
    export_js(load_history())
    print(f"-> {HISTORY_JS.relative_to(ROOT)}")
    return 0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("validate"); s.add_argument("files", nargs="+"); s.set_defaults(fn=cmd_validate)
    s = sub.add_parser("merge"); s.add_argument("files", nargs="+")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--keep-demo", action="store_true", help="do not remove demo data")
    s.set_defaults(fn=cmd_merge)
    sub.add_parser("reset", help="empty the database (with backup)").set_defaults(fn=cmd_reset)
    sub.add_parser("context").set_defaults(fn=cmd_context)
    sub.add_parser("export-js").set_defaults(fn=cmd_export_js)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
