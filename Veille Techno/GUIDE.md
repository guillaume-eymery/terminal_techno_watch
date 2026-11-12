# Port Tech Radar — user guide

## Project layout

```
agent/port-tech-watch/SKILL.md    Mistral agent skill (mission, sources, criticality, threading, output format)
agent/thread_context.json         Known news threads -> give it to the agent on every run (generated)
schema/batch.schema.json          JSON schema of the weekly batch produced by the agent
scripts/techwatch.py              validate / merge / context / export-js / reset (standard library only)
scripts/vessels.py                CMA CGM fleet positions (aisstream.io AIS feed)
data/history.json                 Cumulative database of all articles (generated)
data/history.js                   Same database, loadable by the front end without a server (generated)
data/vessels.json / vessels.js    Latest vessel positions (generated)
data/samples/                     Sample batches
front/                            Interactive map (index.html, styles.css, app.js)
```

## Weekly cycle (front end only, no Python)

1. Open `front/index.html`, open the menu (three dots, top right) and choose **Download agent context**: this downloads `thread_context.json`.
2. Run the agent with three files: `agent/port-tech-watch/SKILL.md`, `thread_context.json` and `schema/batch.schema.json`.
3. Save its answer as a `.json` file and drop it on the page (or menu > **Import JSON file**).
4. Read the message shown after the import. It lists articles added, articles linked to threads, duplicates skipped and quality warnings (missing ports, generic rationales, criticality distribution, cached sources, agent notes).

The database lives in this browser. Use menu > **Download backup** regularly: the downloaded file restores everything when imported, in this browser or another one. Menu > **Reset data** deletes every imported batch.

## Weekly cycle with the Python scripts (optional)

```powershell
$py = "C:\Users\HO.GEYMERY\.local\bin\python3.15.exe"

# 1. Prepare the context (existing threads) for the agent
& $py scripts/techwatch.py context

# 2. Run the agent with THREE inputs:
#      agent/port-tech-watch/SKILL.md
#      agent/thread_context.json
#      schema/batch.schema.json
#    -> save its answer as data/inbox/batch_YYYY-Www.json

# 3. validate also prints quality warnings (missing ports, generic rationales,
#    criticality distribution, cached sources...): read them before merging

# 4. Check, then merge
& $py scripts/techwatch.py validate data/inbox/batch_2026-W46.json
& $py scripts/techwatch.py merge data/inbox/batch_2026-W46.json   # --dry-run to simulate

# 5. Open front/index.html
```

`merge` deduplicates articles by normalised URL (ignoring `utm_` parameters) and attaches each article to a thread:
1. through `previous_link`;
2. otherwise through the `thread_id` provided by the agent;
3. otherwise through a **cautious automatic link**: same terminal and country, same category or a shared technology, within 18 months. These articles are marked `"chaining": "auto"` and labelled "Automatic link" in the front end.

Any text the agent writes around the JSON is ignored. The first merge of a real batch removes demo data. `techwatch.py reset` empties the database, with a backup.

## Front end

- Open `front/index.html` by double-clicking: no server needed. Internet access is required for the satellite imagery and Leaflet.
- The left panel shows one week at a time: the week's headline and short editorial, then its articles sorted by importance. The week selector above the headline also offers "All weeks". Search looks through every week.
- **Importance** (dot colour): red = Critical, orange = Important, yellow = To watch. Clicking a level in the row under the search box hides or shows it. The topic list narrows to one topic.
- **Map**: one point per story (its latest article). Hover for the title, click to open the article in the panel.
- **Article view**: summary, key points, link to the source and, when the story has several updates, a timeline of them.
- **Data menu** (three dots, top right): import a JSON file, download the agent context, download a backup, reset data. Readers never need it.
- **CMA CGM vessels**: currently disabled. Set `VESSELS_ENABLED = true` at the top of `front/app.js` to show them (positions from `data/vessels.js`, reloaded every 5 minutes).

## Vessel positions

Source: **aisstream.io**, a free global AIS feed from shore-based receivers. The key is read from the Windows environment variable `AISSTREAM_API_KEY`, already set for this account.

```powershell
& $py scripts/vessels.py ais                 # listen for 5 min, keep "CMA CGM ..." vessels
& $py scripts/vessels.py ais --minutes 15 --pattern "^(CMA CGM|APL|ANL|CNC) "   # whole group
& $py scripts/vessels.py demo                # simulated positions
```

- Each run updates the vessels heard. A position that is not refreshed stays on the map for 48 h, and is dimmed after 6 h.
- Destination and ETA come from a message ships only send about every 6 minutes: listen for at least 10 minutes to get them.
- Vessels out at sea, beyond coastal range, are not received.
- To keep the map current: a Windows scheduled task every 30 minutes running `vessels.py ais --minutes 10`.
