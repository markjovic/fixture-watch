# fixture-watch

Follows **players**. Pushes a phone alert the moment a fixture for any of their
current teams is set, changed or removed.

Two sports: **basketball** on the `basketball-victoria` tenant and **footy** on the
`afl` tenant. Sports are configuration, not code — adding footy on 2026-11-24 needed
no new fixture logic, because the basketball query shapes port to `afl` verbatim.

This is **not** part of the StatTrack app or the junior footy dashboard. It links
into both, and that is the whole connection.

---

## Why it exists

Some competitions publish fixtures four weeks at a time, or less. Teams get regraded
mid-season. Finals fixtures appear after the last round. None of that produces an
email, and all of it changes where a child is playing on Saturday morning.

---

## Setup

1. **Repo secrets** — Settings → Secrets and variables → Actions:
   - `PUSHOVER_TOKEN` — the Pushover application token
   - `PUSHOVER_USER` — the Pushover user key

   Both already exist on this repo. If an alert ever reports
   `application token is invalid`, it is one of these.

2. **Actions must be enabled** with write permission: Settings → Actions → General →
   Workflow permissions → **Read and write permissions**. The watcher commits its
   state back to this repo, and without this the push fails and the run goes red.

3. **Add the players you want followed** to `watch.json` (below).

That is all. There is nothing to install and nothing to run locally.

---

## Configuration — `watch.json`

Edit it in the GitHub web UI. It is read on every run.

```json
{
  "sports": {
    "basketball": {
      "label": "Basketball",
      "tenant": "basketball-victoria",
      "link": { "kind": "stattrack", "base": "https://markjovic.github.io/stattrack/" }
    },
    "footy": {
      "label": "Footy",
      "tenant": "afl",
      "link": { "kind": "footy-dashboard", "base": "https://markjovic.github.io/junior-footy-dashboard/index.html" },
      "orgShortCodes": { "383836bb": "EFNL", "4c8b472e": "WFNL", "1cf85e52": "SEJ", "0f20da4f": "SER", "4f9a099e": "YJFL" }
    }
  },
  "tenant": "basketball-victoria",
  "sport": "basketball",
  "stattrackBase": "https://markjovic.github.io/stattrack/",
  "players": [
    { "uuid": "0afc7690-c2db-4644-b039-af1c34520af3", "name": "Toby",
      "sports": ["basketball", "footy"], "pinnedTeams": { "basketball": [], "footy": [] } }
  ],
  "completeFixtureSlotsEvery": 4,
  "gradeRoundsRefreshHours": 12,
  "activeChangeWindowDays": 7,
  "stopAfterSeasonEndDays": 21,
  "failureAlertCooldownHours": 6,
  "maxAlertChars": 1000
}
```

| key | what it does |
|---|---|
| `sports.<name>.tenant` | The PlayHQ tenant header. It is the **only** thing that differs between sports at the HTTP level. |
| `sports.<name>.label` | What goes in the alert title, in square brackets: `[Footy] Toby — NEW TEAM`. |
| `sports.<name>.link` | How the alert's deep link is built — `stattrack` or `footy-dashboard`. See **The footy link** below. |
| `sports.<name>.orgShortCodes` | Footy only. PlayHQ organisation id → the short code the dashboard uses in its `c` URL key. |
| `players[].sports` | Which sports to look this player up in. Omitted, it means the legacy sport alone. |
| `players[].uuids` | Optional per-sport uuid override, for a profile with a different api id on another tenant. **Toby does not need one** — his single uuid resolves on both tenants, measured 2026-11-24. |
| `tenant` / `sport` / `stattrackBase` | The pre-footy single-sport keys. Still read, but **only** when `sports` is missing or empty, so a half-finished edit cannot leave the watcher quietly watching nothing. Do not delete them. |
| `players[].uuid` | **The api-namespace uuid — the 36-character id in a StatTrack player URL.** A spectator id returns `NOT_FOUND`, and the watcher refuses to start rather than read that as "no teams". |
| `players[].name` | What appears in the alert title. |
| `players[].pinnedTeams` | Team ids watched regardless of whether they are on the profile. A pinned team is never dropped on season age. As an object it is keyed by sport; a bare array belongs to the player's first sport. |
| `completeFixtureSlotsEvery` | Reduced cadence for a team with a game in every non-finals round and a game still to come. Everything else is checked every slot. |
| `gradeRoundsRefreshHours` | How long a grade's round list is cached before re-fetching. Also re-fetched when the fixture is incomplete, the grade changes, or the last game has passed. |
| `activeChangeWindowDays` | A team that changed within this many days stays on the FULL cadence even with a complete fixture. |
| `stopAfterSeasonEndDays` | Days after a season's `endDate` before a team is dropped. **A season with no `endDate` is never dropped on age.** |
| `failureAlertCooldownHours` | At most one "watcher failed" alert per this many hours. The run still goes red every time. |
| `maxAlertChars` | Message cap. Pushover's hard limit is 1024. |

### Which players to follow

Open the player in StatTrack and take the uuid out of the URL:

```
https://markjovic.github.io/stattrack/#p=0afc7690-c2db-4644-b039-af1c34520af3
                                          ^^^^ this ^^^^
```

---

## How it runs

**A long-running job keeps the cadence. The cron only starts it.**

Melbourne local time: a check **every 30 minutes between 07:00 and 22:00**, nothing
between 22:00 and 07:00.

### Why it is built this way

⚠️ **GitHub does not deliver a high-frequency cron.** Measured on this repo,
2026-11-15/16: a `7,37 * * * *` schedule delivered **two fires out of an expected
eighteen** overnight, and one of those landed at **02:51** — neither `:07` nor `:37`.
Delivery is sparse *and* time-shifted. Two checks a day is not a watcher.

So the cron was demoted to a starter. `Fixture Watch` fires **once a day** at 19:45
UTC — a daily schedule is far more likely to be delivered than a half-hourly one —
and the job then stays alive and runs a check every 30 minutes itself, on its own
clock, exactly on time.

A job is capped at **6 hours** ([Actions limits](https://docs.github.com/en/actions/reference/limits)),
and the active day is 15 hours, so the workflow is **four legs chained with
`needs:`** — ending at 10:00, 14:00, 18:00 and 22:00 Melbourne. Chained jobs live in
one workflow run (capped at 35 days), so nothing is dispatched between them: no PAT,
no chain to lose, nothing that can silently fail and leave the day dead. Each later
leg runs on `always() && !cancelled()`, so a failed leg does not cost the rest of the
day, and cancelling the run still stops everything.

Each pass is a **fresh `node scripts/fixture-watch.js`**, not a loop inside one
process. That means a fresh PlayHQ session every pass — so the ~290-call session
budget can never accumulate across a five-hour job — and a pass that dies costs that
pass and nothing else.

19:45 UTC is 06:45 Melbourne in AEDT and 05:45 in AEST. Leg 1 sleeps until 07:00
either way, so daylight saving needs no arithmetic anywhere.

### The watchdog

`Fixture Watch Watchdog` runs on the old half-hourly cron, which GitHub mostly
ignores — and that is the point. Whenever a fire *is* delivered, it checks whether a
daemon run is in progress and, if not, performs **one check inline**. So if the daily
fire is ever dropped, the worst case degrades to a couple of checks a day rather than
to nothing at all.

It does not dispatch the daemon: a `workflow_dispatch` made with `GITHUB_TOKEN` does
not create a new workflow run, so that would need a personal access token. Doing the
check inline needs no token and has no chain to break.

Neither workflow has a `concurrency` group, deliberately. A shared group would make
the watchdog **queue** behind a five-hour leg instead of standing down, and a queued
run can be evicted by the next arrival. The in-progress check is the interlock; if
the two ever did overlap, the watcher is idempotent and its push retries with
`merge -X ours`, so the cost is a wasted pass, not bad data.

## Team lifecycle — polling never "completes" during a season

The cadence is decided by **fixture coverage**, not by the calendar.

`discoverGrade` returns the grade's whole round list the moment the grade is set up —
`rounds { id name number isFinalsRound }`. So "has this team got a game in every round
that exists?" is answerable, and it is the right question. A team with a game in every
non-finals round has nothing left to be published until finals. A team missing rounds
is mid-way through a fixture block being released.

- **REDUCED — every `completeFixtureSlotsEvery` slots.** Only a team with a game in
  every non-finals round **from the current round onward**, **and** a game still to
  come, and no change in the last `activeChangeWindowDays`.
- **FULL — every slot.** Everything else, in particular:
  - a team **missing rounds** — the next fixture block is being published;
  - a team whose **last scheduled game has passed** — this is the finals hunt, and
    it is the moment the watcher matters most;
  - a team whose grade round list could not be fetched, or whose grade is a GRADING
    grade with no rounds yet, or whose grade is unknown.
- **STOP** — only when the team leaves the player's profile, the player is removed
  from `watch.json`, or `stopAfterSeasonEndDays` have passed since the season's
  `endDate`. A season with **no `endDate` is never stopped on age** — a missing date
  is not an ended season.

Three things make this work on real data, each of which got it wrong first:

- **A round object is not a game.** `discoverTeamFixture` returns the grade's rounds
  including ones the team holds no game in — a team with 5 games came back with 15
  round objects. A round counts only when the team actually holds a game in it. A BYE
  is a game entry, so a bye round counts.
- **Only rounds from the current round onward are required.** `discoverGrade` flags
  the current round. A regraded team's earlier games belong to its *old* grade, so it
  can never hold a game in its new grade's early rounds and would sit at incomplete
  for ever. Same for a team that joined late or had a washed-out round — and none of
  that says anything about whether the fixture *ahead* is published.
- **Rounds are matched on round id**, never on name: names repeat across grades and
  seasons. Coverage is computed against the current grade only.

**Every unknown falls to FULL** — no round list, no current round, a GRADING grade
with no rounds, an unknown grade. The failure direction is more checking, never less.
The log prints the coverage, the round it counts from, and the missing round names on
every check, so the reasoning is visible rather than guessed at.

## Alerts

| alert | priority |
|---|---|
| Game added | normal |
| Game's date, time, venue, court or opponent changed | normal |
| Game removed or withdrawn | normal |
| **REGRADE** — the team's games now carry a different grade | high |
| New team on a player's profile | high |
| Team gone from a player's profile | high |
| **Fixture dropped to ZERO** | high |
| First time a team is seen — one baseline summary | normal |
| Watcher failed | normal, rate limited |

Each alert links to the team: basketball in StatTrack, footy in the junior footy
dashboard. **The alert title names the sport** — `[Footy] Toby — NEW TEAM`.

**Scores are deliberately not watched.** This follows the fixture. If it tracked
scores it would alert every Saturday evening as results came in.

**Fixture dropped to zero gets its own loud alert** because it usually means the
regrade was made as a *new team entry* — the real fixture is under a different team
id, and this team will quietly never show a game again.

**First run per team sends one summary, never one alert per existing game.**

---

## When something goes wrong

**A failed fetch never looks like an empty or changed fixture.** This is the rule the
whole design serves. A 403, a GraphQL error, a timeout or a refused session:

- produces **no** alert about games
- does **not** overwrite the saved state for that team
- marks the run **red** and sends one separate `watcher failed` alert, rate limited
  so a PlayHQ outage does not empty the phone battery

A **CloudFront hard block** (403 with an HTML body) is reported as a different thing
from an **application 403**, because they mean different things.

**An alert that did not send holds back its own state write.** If Pushover rejects a
message, the change is not baselined — so the next run detects it again and alerts
again. The alternative is silently swallowing the one notification the repo exists to
deliver.

There is no silent `catch` anywhere. A script that cannot do its job exits non-zero
and says why.

---

## Running it by hand

**Actions → Fixture Watch → Run workflow** starts the loop now:

| input | effect |
|---|---|
| `dry_run` | Every pass writes nothing, commits nothing, and prints alerts instead of sending them. |
| `interval` | Minutes between passes. Default 30. |
| `single_leg` | Run leg 1 only, ending at 22:00. For testing — it stops at the wall-time budget. |

**Actions → Fixture Watch Watchdog → Run workflow** does a single check, which is the
quickest way to see the current state of every team.

## State

`state/<tid>.json` — one file per watched team, holding the last known fixture. This
is what each run diffs against. Committed only when something changed, so the commit
history is a readable record of every fixture change.

`state/_players.json` — each player's current team list, used to detect a team
appearing or disappearing. It deliberately holds **no timestamp**: a "last checked
at" field would be committed 34 times a day saying nothing and bury the real history.

`state/_meta.json` — when the last failure alert was sent, for the cooldown.

`state/_keepalive.json` — see below.

---

## The keep-alive

GitHub disables scheduled workflows on a **public** repo after 60 days without
repository activity. This watcher commits only when a fixture changes, so an
off-season can pass with no commit at all — and the schedule would switch itself off
exactly when the next season's fixture is published.

It is widely held that commits pushed by a workflow count as that activity. **That
was not verified**, and the whole purpose of the repo is not worth staking on a
belief about GitHub's internals. So `keepalive.yml` makes a deliberate commit on the
1st of each month. If bot commits do count, it is twelve harmless commits a year.

---

## PlayHQ

Every query, header set and session routine is **copied verbatim** from the live
scripts in `markjovic/sports-players-stats`, which run against the real API on a
schedule. Nothing here was written from scratch, and nothing was trimmed.

| borrowed | from |
|---|---|
| headers, cookie queries, `refreshSession`, `doFetch`, `isWafBlock`, `publicProfileTeams` | `scripts/discover-seasons.js` |
| `discoverTeamFixture` (the per-team fixture call) | `scripts/discover-fixtures.js` |
| `gradeRounds` (the grade's round list) | `scripts/nightly-crawl.js` |
| `discoverCompetitions` (probe only) | `scripts/discover-org-seasons.js` |
| `lib/playhq-session.cjs` | copied whole, unmodified |

Three rules that look like trivia and are not:

- **`fetch()` only.** Never `https.request`, never a hand-set `content-length`.
  Measured on one runner ten seconds apart, same URL and headers: `fetch()` granted,
  `https.request` refused with a CloudFront block.
- **The five headers go together unmodified**, emulator user-agent included. The
  user-agent is load-bearing — drop it and CloudFront 403s immediately.
- **Never `actions/setup-node`** in a job that calls `api.playhq.com`. It changes the
  runner's outbound fingerprint and every request is refused, session acquisition
  included.

Request volume is small by design: one profile call per player, then one fixture call
per team due this slot, sequential, with a delay between calls.

---

## `probe-profile-teams.js`

A one-off diagnostic, kept because the question it answers will come up again.

**Does a registration appear on `publicProfileTeams` as soon as the player is
registered, or only after their first game?** If the former, following by player is
enough. If the latter, a new season's fixture is only found after round 1 and
`pinnedTeams` is the answer rather than a safety net.

It dumps the raw `publicProfileTeams` payload per player, counts how many of each
team's games have actually been played, and then sweeps each club with
`discoverCompetitions` — which returns seasons at status `UPCOMING`, so it sees a
season the moment the association creates it. Comparing the club's seasons against
the profile's seasons is what settles the question.

Run it from Actions whenever a club publishes a new season.

---

## The footy link

Basketball alerts link to StatTrack with `#t=<teamId>&s=<seasonId>` — two ids the
watcher already holds, so the link is either complete or absent.

Footy is harder, and the difficulty is worth stating plainly.

```
https://markjovic.github.io/junior-footy-dashboard/index.html#y=2026&c=EFNL&a=U12&t=Norwood%20Purple
```

**The footy link is keyed on NAMES, not ids.** The dashboard's client model holds no
team ids at all — its team filter compares `m.home` and `m.away` to the name in `t`.
So three of the four keys are derivations:

| key | value | where it comes from |
|---|---|---|
| `y` | `2026` | `season.name`, and only when it is a bare four-digit year. |
| `c` | `EFNL` | **Not a PlayHQ field.** `orgShortCodes` in `watch.json`, copied from the dashboard's own `config.json`. |
| `a` | `U12` | The age token from the **grade** name. A girls grade is `U12 Girls`. `grades.json`'s `ageName` is not used — it says `U17` for a U17.5 competition. |
| `t` | `Norwood Purple` | The PlayHQ team name with the grade's **own** age token stripped, replicating `cleanTeam(name, gradeAge)` from the dashboard's `results-engine.js`. |

`g` is deliberately omitted — a regrade would stale it and the team filter does not
need it.

### ⚠️ Omit rather than approximate

`scripts/lib/team-links.cjs` returns `null` the moment any key is unavailable. A
missing link is honest; a wrong one is not.

Before dashboard **v1.08** a wrong `t` failed *silently*, in two ways: a fresh page
load dropped the key and rendered the whole unfiltered age group — a link that
opened, looked right and showed the wrong team — and a same-tab tap, which is the
usual notification case, emptied the view to "0 matches". As of v1.08 both paths
validate and say so: *"Team Norwood Purple not found in U12 — showing all teams"*.
Same for `r`.

That makes a stale link degrade **loudly**, not correctly. The dashboard still cannot
resolve a team renamed since the alert was sent — and a rename is one of the things
this watcher alerts about — so the rule does not relax. The known cases that produce
no link:

- the organisation is not in `orgShortCodes` — which is also every organisation the
  dashboard does not ingest, so a link would have found nothing anyway;
- the season name is not a bare year;
- there is no age token in the grade name **and** none in the team name.

**A brand new registration has `grade: null`** — measured on profile `afbd05d3`,
2026-11-24 — so for the single most important footy alert, a new team appearing, the
age comes from the team name (`Lilydale U13` → `U13`). If the team name has no age
token either, the alert goes out with no link.

**A 2027 link may open an empty view** until the dashboard ingests the 2027 season.
That is not a defect, just the order things happen in.

### An id-keyed link is coming, but not yet

A `t=<teamId>` format is designed (`claude/team_deep_link.md`) and would remove the
`cleanTeam` age-strip replication entirely — fixture-watch already holds the team id,
and the dashboard's fixture query already fetches and discards home/away ids, so the
API cost is zero. It is deferred because nothing populates those ids until the 2027
season starts fetching, so the format cannot be verified yet. **Do not change the
builder's output now**; the swap in January is a change to `footyDashboardUrl()` and
nothing else.

### Which organisations are covered

The five the dashboard tracks and ingests, taken from its `config.json`
`organisations[]`: **EFNL, WFNL, SEJ, SER, YJFL**. Twelve more organisations are
listed there as `tracked: false` with long descriptive names rather than short
codes; the dashboard holds no data for them, so a team in one of those gets no link.
Add an entry to `orgShortCodes` only once the dashboard ingests that organisation
and `config.json` gives it a short name.

---

## Footy will be silent until a 2027 registration appears

All three of Toby's footy seasons — 2026 (Norwood U12 Purple), 2025 (U11) and 2024
(U10) — are `COMPLETED` and well past their `endDate`. On the day footy is switched
on the watcher correctly classifies all three as out of scope and watches nothing.
**That is not a fault.** The log says `out of scope, never watched` for each of them,
footy is recorded as seen, and the first 2027 registration the club enters will fire
a `[Footy] Toby — NEW TEAM` alert.

Two other things the real footy data changes, neither of which needs a code change:

- **Footy seasons straddle the calendar year.** 2026 ran 2025-10-01 → 2026-09-30, so
  `startDate` can be in the previous year. Only `endDate` is used in the stop
  arithmetic, so nothing breaks. Do not "fix" it.
- **Byes are real and evidenced** — Norwood U11 returned 16 rounds and 15 games. A
  team with a bye never reaches complete coverage, so footy teams will mostly sit on
  the FULL cadence. That costs call volume and can never cause a missed alert. **Do
  not loosen the coverage rule to make REDUCED engage.**

---

## Tests — `scripts/test/harness.js`

```
node scripts/test/harness.js              # everything
node scripts/test/harness.js "14 two"     # one scenario, by name fragment
```

⚠️ **`node --check` is not a test.** It proves syntax and nothing else; it did not
catch a constant copied without its definition (`TERMINAL`, 2026-11-24).

The harness runs `scripts/fixture-watch.js` **unmodified** in a throwaway git repo
with a throwaway bare remote, against a faked PlayHQ and a faked Pushover preloaded
with `node --require`. Nothing in the production code knows it exists. Each scenario
asserts on what actually came out: the Pushover messages, the state files on disk
and the process exit code.

Eighteen scenarios: the thirteen that existed before footy (baseline, change,
regrade, fixture-to-zero, fixture-published, team gone, new team, blocked profile,
blocked fixture, Pushover rejection, past-game rename, 502/504 retry, timeout) plus
two-tenants-healthy, two-tenants-one-dead, footy-out-of-season, the `grade: null`
registration, and a legacy `watch.json` with no `sports` block. Plus unit tests for
the footy link builder against the measured data.

The two-tenant scenario is the one that matters for the session rewrite: it asserts
exactly one session bootstrap per tenant and that **every authenticated call carried
its own tenant's cookie**. Reverting `clientFor()` to a shared session makes it fail.

The harness cannot reach PlayHQ and does not try to. Run a real `--dry-run` against
live PlayHQ from the watchdog workflow before trusting a change.
