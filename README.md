# fixture-watch

Follows **players**. Pushes a phone alert the moment a fixture for any of their
current teams is set, changed or removed.

Basketball Victoria first. The tenant and sport are configuration, not code, so
footy on PlayHQ is a `watch.json` edit rather than a rewrite.

This is **not** part of the StatTrack app. It links into StatTrack, and that is the
whole connection.

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
  "tenant": "basketball-victoria",
  "sport": "basketball",
  "stattrackBase": "https://markjovic.github.io/stattrack/",
  "players": [
    { "uuid": "0afc7690-c2db-4644-b039-af1c34520af3", "name": "Toby", "pinnedTeams": [] }
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
| `tenant` | PlayHQ tenant. `basketball-victoria` today; footy is a different value here, not a different script. |
| `players[].uuid` | **The api-namespace uuid — the 36-character id in a StatTrack player URL.** A spectator id returns `NOT_FOUND`, and the watcher refuses to start rather than read that as "no teams". |
| `players[].name` | What appears in the alert title. |
| `players[].pinnedTeams` | Team ids watched regardless of whether they are on the profile. A pinned team is never dropped on season age. |
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

## The schedule

Melbourne local time:

| window | cadence |
|---|---|
| 07:00 – 09:00 | hourly |
| 09:00 – 20:00 | every 30 minutes |
| 20:00 – 22:00 | hourly |
| 22:00 – 07:00 | nothing |

GitHub cron is UTC and cannot follow daylight saving, so the workflow fires on
`7,37 * * * *` — every half hour, all year — and **the script decides** whether the
slot does work, in `Australia/Melbourne` terms. An off-slot run exits in a couple of
seconds with one line in the log. Daylight saving needs no intervention, ever.

---

## Team lifecycle — polling never "completes" during a season

The cadence is decided by **fixture coverage**, not by the calendar.

`discoverGrade` returns the grade's whole round list the moment the grade is set up —
`rounds { id name number isFinalsRound }`. So "has this team got a game in every round
that exists?" is answerable, and it is the right question. A team with a game in every
non-finals round has nothing left to be published until finals. A team missing rounds
is mid-way through a fixture block being released.

- **REDUCED — every `completeFixtureSlotsEvery` slots.** Only a team with a game in
  **every** non-finals round of its current grade, **and** a game still to come, and
  no change in the last `activeChangeWindowDays`.
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

Rounds are matched on **round id**, never on name: names repeat across grades and
seasons. Coverage is computed against the **current** grade only — after a regrade a
team's games span two grades, and the rounds that matter from here are the new one's.

**Every unknown falls to FULL.** If a bye round does not appear in a team's fixture,
coverage never reaches complete and that team simply stays on FULL for ever. That
costs call volume and nothing else — it can never cause a missed alert. The log names
the missing rounds on every check, so the cause is visible rather than guessed at.

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

Each alert links to the team in StatTrack.

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

Actions → **Fixture Watch** → Run workflow. Inputs:

| input | effect |
|---|---|
| `dry_run` | Do everything, write and commit nothing, print the alerts instead of sending them. |
| `force` | Ignore the Melbourne slot gate and run now. |
| `no_alerts` | Suppress Pushover entirely. State is still written. |
| `players` | Restrict the run to these uuids. Blank means all of them. |

`dry_run` + `force` is the safe way to see exactly what it would do, at any hour.

---

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
