// scripts/fixture-watch.js
//
// Follows PLAYERS. Alerts on anything that happens to the fixtures of the teams
// those players are currently registered to.
//
// ─── WHAT IT ALERTS ON ───────────────────────────────────────────────────────
//   · a game added
//   · a game's date, time, venue, court or opponent changed
//   · a game removed or withdrawn
//   · a REGRADE — the team's games now carry a different grade id
//   · a team appearing on, or disappearing from, a player's profile
//   · a team's fixture dropping to ZERO — louder, because it usually means the
//     regrade was made as a NEW team entry and the real fixture is somewhere else
//   · the first time a team is seen: ONE baseline summary per player, never one
//     alert per existing game
//
// ─── THE RULE THAT OUTRANKS EVERY OTHER RULE HERE ────────────────────────────
// A FAILED FETCH MUST NEVER LOOK LIKE AN EMPTY OR CHANGED FIXTURE.
//
// A 403, a GraphQL error, a timeout or a refused session produces NO alert about
// games, does NOT overwrite the saved state for that team, and does not advance
// anything. Every PlayHQ call returns a TYPED outcome and "I could not ask" is never
// stored as "the answer is none". The run goes red and sends ONE separate
// "watcher failed" alert, rate-limited so a PlayHQ outage does not empty the phone
// battery. A CloudFront hard block (403 with an HTML body) is reported as a
// different thing from an application 403, because they mean different things and
// need different responses.
//
// ─── POLLING NEVER "COMPLETES" DURING A SEASON ───────────────────────────────
// Detecting a complete fixture is unreliable and stopping would miss regrades and
// finals. So:
//   The cadence is decided by FIXTURE COVERAGE, not by the calendar.
//
//   `discoverGrade` returns the grade's whole round list the moment the grade is
//   set up — `rounds { id name number isFinalsRound }`. So "has this team got a
//   game in every round that exists?" is answerable, and it is the right question:
//   a team with a game in every non-finals round has nothing left to be published
//   until finals, and a team missing rounds is mid-way through a fixture block.
//
//   REDUCED — every Nth slot (`completeFixtureSlotsEvery`). ONLY a team that has a
//             game in EVERY non-finals round of its current grade AND still has a
//             game in the future AND has not changed in the last
//             `activeChangeWindowDays`. There is nothing left to publish for it
//             right now. NEVER stopped.
//   FULL    — every slot. Everything else, and in particular:
//             · a team missing rounds — the next fixture block is being published;
//             · a team whose LAST SCHEDULED GAME HAS PASSED — this is the finals
//               hunt, and it is the moment the watcher matters most;
//             · a team whose grade round list could not be fetched, or whose grade
//               is unknown. Every unknown falls to FULL. The failure direction is
//               more checking, never less.
//
//   ⚠️ IF A BYE ROUND DOES NOT APPEAR IN A TEAM'S FIXTURE, coverage never reaches
//   complete and the team simply stays on FULL for ever. That costs call volume and
//   nothing else — it can never cause a missed alert. The log names the missing
//   rounds on every check so the cause is visible rather than guessed at.
//   STOP    — only when the team leaves the player's profile, the player is removed
//             from watch.json, or `stopAfterSeasonEndDays` have passed since the
//             season's endDate. A season with NO endDate is NEVER stopped on age:
//             808 seasons in the sibling database have no endDate and a missing date
//             is not an ended season.
//
// ─── IDENTITY ────────────────────────────────────────────────────────────────
// A team can hold two grades in one season. The identity of a registration is
// (tid, gid), NEVER tid alone. The grade is tracked per GAME, which is the only
// place a grade carries a date, and a change in the set of grades across a team's
// games is a REGRADE.
//
// ─── PROVENANCE OF EVERY PLAYHQ-FACING LINE ──────────────────────────────────
// HEADERS_BASE, COOKIE_QUERIES, refreshSession(), doFetch(), isWafBlock,
// Q_PROFILE_TEAMS and Q_TEAM_FIXTURE are COPIED VERBATIM from the live scripts in
// markjovic/sports-players-stats — never written from scratch, never trimmed:
//   · HEADERS_BASE, COOKIE_QUERIES, refreshSession, doFetch, isWafBlock,
//     Q_PROFILE_TEAMS   → scripts/discover-seasons.js  (staged copy 2026-10-13)
//   · Q_TEAM_FIXTURE    → scripts/discover-fixtures.js (staged copy 2026-10-13)
//   · lib/playhq-session.cjs → copied as a whole file, unmodified
// The ONE adaptation to refreshSession: the source branches on a matrix-shard flag
// that does not exist here, so it takes the non-shard branch. No query, header or
// client behaviour is changed.
//
// ⚠️ fetch() ONLY. Never https.request, never a hand-set content-length — measured
//    on one runner ten seconds apart, same URL and headers: fetch() granted,
//    https.request refused.
// ⚠️ NEVER actions/setup-node in a job that calls api.playhq.com.
// ⚠️ Request volume is deliberately small: one profile call per player, then one
//    fixture call per team to check, sequential, with a delay between calls.
//
// USAGE
//   node scripts/fixture-watch.js [--dry-run] [--force] [--no-alerts]
//                                 [--players=<uuid>,...] [--delay=600]
//     --dry-run    do everything, write and commit nothing, print the alerts
//     --force      ignore the Melbourne-time slot gate and run now
//     --no-alerts  suppress Pushover entirely (still writes state)
//     --players    restrict this run to these uuids (must be in watch.json)

'use strict';

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { execFileSync } = require('child_process');
const { createSessionGuard } = require('./lib/playhq-session.cjs');
const { slotDecision }       = require('./lib/schedule-gate.cjs');
const pushover               = require('./lib/pushover.cjs');

const ROOT       = path.join(__dirname, '..');
const STATE_DIR  = path.join(ROOT, 'state');
const CONFIG     = path.join(ROOT, 'watch.json');
const PLAYERS_ST = path.join(STATE_DIR, '_players.json');
const META_ST    = path.join(STATE_DIR, '_meta.json');

// ─── Arguments ────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const argOf = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a === undefined ? dflt : a.slice(name.length + 3).trim();
};
const DRY_RUN   = args.includes('--dry-run');
const FORCE     = args.includes('--force');
const NO_ALERTS = args.includes('--no-alerts');
const ONLY      = (argOf('players', '') || '').split(/[\s,]+/).filter(Boolean);
const DELAY_MS  = (() => { const n = parseInt(argOf('delay', '600'), 10); return Number.isFinite(n) && n >= 0 ? n : 600; })();

const API_URL = 'https://api.playhq.com/graphql';
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso  = () => new Date().toISOString();

// ─── Config ───────────────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG)) { console.error(`FATAL: ${CONFIG} does not exist.`); process.exit(2); }
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
catch (err) { console.error(`FATAL: watch.json does not parse: ${err.message}`); process.exit(2); }

const TENANT          = cfg.tenant || 'basketball-victoria';
const STATTRACK       = (cfg.stattrackBase || '').replace(/\/+$/, '/') || null;
const REDUCED_EVERY   = Number.isFinite(cfg.completeFixtureSlotsEvery) && cfg.completeFixtureSlotsEvery > 0 ? cfg.completeFixtureSlotsEvery : 4;
const ROUNDS_REFRESH_H = Number.isFinite(cfg.gradeRoundsRefreshHours) ? cfg.gradeRoundsRefreshHours : 12;
const CHANGE_WINDOW_D = Number.isFinite(cfg.activeChangeWindowDays) ? cfg.activeChangeWindowDays : 7;
const STOP_AFTER_D    = Number.isFinite(cfg.stopAfterSeasonEndDays) ? cfg.stopAfterSeasonEndDays : 21;
const FAIL_COOLDOWN_H = Number.isFinite(cfg.failureAlertCooldownHours) ? cfg.failureAlertCooldownHours : 6;
const MAX_ALERT_CHARS = Number.isFinite(cfg.maxAlertChars) ? cfg.maxAlertChars : 1000;

let WATCHED = Array.isArray(cfg.players) ? cfg.players.filter(p => p && p.uuid) : [];
if (ONLY.length) WATCHED = WATCHED.filter(p => ONLY.includes(p.uuid));
if (!WATCHED.length) { console.error('FATAL: no players to watch. watch.json has none, or --players matched none of them.'); process.exit(2); }
for (const p of WATCHED) {
  if (p.uuid.length !== 36) {
    console.error(`FATAL: ${p.uuid} is ${p.uuid.length} characters. publicProfileTeams needs the FULL api-namespace uuid (the one in the StatTrack player URL). A spectator or truncated id returns NOT_FOUND, and NOT_FOUND must never be read as "no teams".`);
    process.exit(2);
  }
}

// ─── Slot gate ────────────────────────────────────────────────────────────────
const slot = slotDecision();
if (!slot.run && !FORCE) {
  console.log(`[fixture-watch] off-slot — ${slot.local} — ${slot.why}. Nothing to do.`);
  process.exit(0);
}
console.log(`[fixture-watch] ${slot.local} — ${slot.why}${FORCE && !slot.run ? ' (OVERRIDDEN by --force)' : ''}  slot #${slot.slotOrdinal}`);
const CHECK_REDUCED = (slot.slotOrdinal % REDUCED_EVERY) === 0;
console.log(`[fixture-watch] complete-fixture teams ${CHECK_REDUCED ? 'ARE' : 'are NOT'} checked this slot (every ${REDUCED_EVERY} slots). Every other team is checked EVERY slot.`);

// ─── Headers — full set, never split, never modified (copied verbatim) ────────
const HEADERS_BASE = {
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT,
  'content-type': 'application/json',
};

// ─── Session cookie (promise-locked; copied verbatim from discover-seasons.js) ─
let sessionCookie  = null;
let sessionPromise = null;
const BOOTSTRAP_REFUSED_WAIT_MS = 15 * 60 * 1000;
const BOOTSTRAP_REFUSED_RETRIES = 1;
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    // A REFUSED BOOTSTRAP IS RETRIED ONCE, AFTER ONE FULL WINDOW. Every cookieless
    // request made INTO an open penalty window extends it, so a fast retry ladder
    // keeps the window open instead of waiting it out.
    let longWaits = 0, shortWaits = 0;
    for (let attempt = 1; ; attempt++) {
      let refused = false;
      for (const body of COOKIE_QUERIES) {
        let status, rawCookies, rawText;
        try {
          ({ status, rawCookies, rawText } = await doFetch(API_URL, body, HEADERS_BASE));
        } catch (err) {
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: fetch threw ${err.code || ''} ${err.message}`);
          sessionPromise = null;
          throw err;
        }
        if (!rawCookies) {
          const b = rawText || '';
          const sniff = b.includes('Request blocked') ? `CLOUDFRONT-BLOCK (${b.length}b HTML)`
                      : b.includes('DOCTYPE')         ? `HTML page (${b.length}b): ${b.slice(0, 80)}`
                      : (b.slice(0, 120) || '(empty body)');
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: HTTP ${status}, NO set-cookie, body: ${sniff.replace(/\s+/g, ' ')}`);
          if (status === 403) { refused = true; break; }
          continue;
        }
        const parts = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
          .flatMap(c => c.split(',')).map(c => c.trim().split(';')[0]).filter(Boolean);
        const get = (name) => parts.find(c => c.startsWith(name + '=')) || null;
        const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
        if (!tier || !session || !sub) {
          console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: HTTP ${status}, set-cookie PRESENT but missing phq_tier/phq_session/phq_sub — names seen: ${parts.map(c => c.split('=')[0]).join(', ')}`);
          continue;
        }
        sessionCookie = `${tier}; ${session}; ${sub}`;
        sessionPromise = null;
        console.log(`  Session refreshed (attempt ${attempt})`);
        return;
      }
      if (refused) {
        if (longWaits >= BOOTSTRAP_REFUSED_RETRIES) break;
        longWaits++;
        console.log(`  ⛔ bootstrap refused (attempt ${attempt}) — the penalty window is open. Waiting ${Math.round(BOOTSTRAP_REFUSED_WAIT_MS / 60000)} minutes for it to close, then asking once more.`);
        await sleep(BOOTSTRAP_REFUSED_WAIT_MS);
        continue;
      }
      if (shortWaits >= 4) break;
      shortWaits++;
      await sleep(20000 * shortWaits);
    }
    sessionPromise = null;
    throw new Error(`Failed to obtain session cookie: ${longWaits ? 'the penalty window did not close' : 'no usable cookie in any answer'} — see per-attempt ⚠ lines above`);
  })();
  return sessionPromise;
}

const sessionGuard = createSessionGuard({
  refresh:   refreshSession,
  hasCookie: () => !!sessionCookie,
  clear:     () => { sessionCookie = null; },
});

class SessionUnavailable extends Error {}
let sessionDead = false;
async function ensureSession() {
  if (sessionDead) throw new SessionUnavailable('PlayHQ refused a session earlier in this run — not asking again');
  try { await sessionGuard.ensure(); }
  catch (err) { sessionDead = true; throw new SessionUnavailable(err.message); }
}

// ─── doFetch — copied verbatim. fetch() ONLY, resolves on ANY status. ────────
async function doFetch(url, bodyObj, headers) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
  });
  const rawText = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(rawText); } catch (_) { body = null; }
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return { status: res.status, rawCookies: cookies.length ? cookies : undefined, body, rawText };
}

const isWafBlock = (rawText) => /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(rawText || '') || (rawText || '').includes('DOCTYPE');

// ─── Queries — copied verbatim ───────────────────────────────────────────────
const Q_PROFILE_TEAMS = {
  operationName: 'PublicProfileTeams',
  query: `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    id name
    organisation { id name }
    grade { id name }
    season {
      id name startDate endDate
      status { name value }
      competition { id name organisation { id name } }
    }
  }
}`,
};

const Q_TEAM_FIXTURE = {
  operationName: 'TeamFixture',
  query: `query TeamFixture($teamID: ID!) {
  discoverTeam(teamID: $teamID) {
    id
    grade { id name }
    season {
      id name
      competition { id name organisation { id name } }
      status { value }
    }
    organisation { id name }
  }
  discoverTeamFixture(teamID: $teamID) {
    id name isFinalsRound
    grade {
      id name
      season {
        id name
        competition { id name organisation { id name } }
      }
    }
    fixture {
      games {
        id dates
        status { value }
        home {
          ... on DiscoverTeam {
            id name
            logo { sizes { url dimensions { width } } }
            organisation { id name }
          }
        }
        away {
          ... on DiscoverTeam {
            id name
            logo { sizes { url dimensions { width } } }
            organisation { id name }
          }
        }
        result {
          home { statistics { count type { value } } }
          away { statistics { count type { value } } }
        }
        allocation {
          dateTimeList { date time }
          court {
            id name abbreviatedName
            venue {
              id name abbreviatedName
              latitude longitude
              address suburb state postcode country
            }
          }
        }
      }
    }
  }
}`,
};

// Q_GRADE_ROUNDS: scripts/nightly-crawl.js — the grade's whole round list, which
// exists from the moment the grade is set up and carries isFinalsRound per round.
const Q_GRADE_ROUNDS = {
  operationName: 'gradeRounds',
  query: `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name hideScores
    rounds { id name abbreviatedName current number isFinalsRound }
    season { id competition { id organisation { id name } } }
  }
}`,
};

// ─── Typed calls ─────────────────────────────────────────────────────────────
async function probeTeams(profileID) {
  try { await ensureSession(); } catch (err) { return { kind: 'no-session', detail: err.message }; }
  let status, json, rawText;
  try { ({ status, body: json, rawText } = await doFetch(API_URL, { ...Q_PROFILE_TEAMS, variables: { profileID } }, { ...HEADERS_BASE, 'Cookie': sessionCookie })); }
  catch (err) { return { kind: 'error', detail: err.message }; }

  if (status === 403) {
    if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML) — PlayHQ's WAF refused us, NOT an application 403` };
    return { kind: 'private', detail: 'application 403 — the profile is inaccessible. This is NOT a CloudFront block.' };
  }
  if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
  if (status < 200 || status >= 300) return { kind: 'error', detail: `HTTP ${status}` };
  if (!json) return { kind: 'error', detail: `unparseable body: ${(rawText || '').slice(0, 120)}` };
  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).join(' | ');
    if (/not.?found/i.test(msg)) return { kind: 'notfound', detail: `${msg} — the id did not resolve. This is NOT "the player has no teams".` };
    return { kind: 'gql-error', detail: msg };
  }
  const teams = (json.data || json)?.publicProfileTeams;
  if (teams == null) return { kind: 'null', detail: 'publicProfileTeams is NULL — profile PRIVATE, or the id does not resolve. This call cannot tell those apart.' };
  return { kind: 'ok', teams: Array.isArray(teams) ? teams : [] };
}

async function teamFixture(teamID) {
  try { await ensureSession(); } catch (err) { return { kind: 'no-session', detail: err.message }; }
  let status, json, rawText;
  try { ({ status, body: json, rawText } = await doFetch(API_URL, { ...Q_TEAM_FIXTURE, variables: { teamID } }, { ...HEADERS_BASE, 'Cookie': sessionCookie })); }
  catch (err) { return { kind: 'error', detail: err.message }; }

  if (status === 403) {
    if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)` };
    return { kind: 'forbidden', detail: 'application 403' };
  }
  if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
  if (status < 200 || status >= 300) return { kind: 'error', detail: `HTTP ${status}` };
  if (!json) return { kind: 'error', detail: `unparseable body: ${(rawText || '').slice(0, 120)}` };
  if (json.errors?.length) return { kind: 'gql-error', detail: json.errors.map(e => e.message).join(' | ') };

  const data = json.data || json;
  // `data` present with no discoverTeamFixture means the team genuinely holds no
  // rounds — a real answer, and a DIFFERENT thing from a failure to ask.
  return { kind: 'ok', team: data.discoverTeam || null, rounds: Array.isArray(data.discoverTeamFixture) ? data.discoverTeamFixture : [] };
}

async function gradeRounds(gradeID) {
  try { await ensureSession(); } catch (err) { return { kind: 'no-session', detail: err.message }; }
  let status, json, rawText;
  try { ({ status, body: json, rawText } = await doFetch(API_URL, { ...Q_GRADE_ROUNDS, variables: { gradeID } }, { ...HEADERS_BASE, 'Cookie': sessionCookie })); }
  catch (err) { return { kind: 'error', detail: err.message }; }

  if (status === 403) {
    if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)` };
    return { kind: 'forbidden', detail: 'application 403' };
  }
  if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
  if (status < 200 || status >= 300) return { kind: 'error', detail: `HTTP ${status}` };
  if (!json) return { kind: 'error', detail: `unparseable body: ${(rawText || '').slice(0, 120)}` };
  if (json.errors?.length) return { kind: 'gql-error', detail: json.errors.map(e => e.message).join(' | ') };

  const g = (json.data || json)?.discoverGrade;
  // ⚠️ A GRADING grade returns an empty ladder and can return an empty round list.
  // That is a real answer, and an empty round list makes coverage meaningless — so
  // it is reported as `empty` and the team stays on FULL rather than being declared
  // complete against zero rounds.
  if (!g) return { kind: 'empty', detail: 'discoverGrade returned nothing for this grade id' };
  const rounds = Array.isArray(g.rounds) ? g.rounds : [];
  if (!rounds.length) return { kind: 'empty', detail: `grade "${g.name || gradeID}" has no rounds yet` };
  return { kind: 'ok', gradeName: g.name || null, rounds };
}

// ─── Normalising a fixture ───────────────────────────────────────────────────
// Only the fields a human would notice a change in. Scores are deliberately NOT
// tracked: this watches the FIXTURE, and a score arriving on a played game would
// otherwise fire a "changed" alert every Saturday evening.
function normaliseGames(tid, rounds) {
  const games = {};
  for (const round of rounds) {
    const rn  = round?.name || null;
    const gid = round?.grade?.id || null;
    const gn  = round?.grade?.name || null;
    const isFinals = !!round?.isFinalsRound;
    for (const g of (round?.fixture?.games || [])) {
      if (!g?.id) continue;
      const dt    = g.allocation?.dateTimeList?.[0] || null;
      const court = g.allocation?.court || null;
      const venue = court?.venue || null;
      const homeId = g.home?.id || null;
      const awayId = g.away?.id || null;
      // home is null, not false, when neither side resolves — a bye, a placeholder,
      // or a side PlayHQ has not named yet. A boolean would file every one of those
      // as "away" and alert the moment it resolves.
      const isHome = homeId && homeId === tid ? true : (awayId && awayId === tid ? false : null);
      const oppTeam = isHome === true ? g.away : (isHome === false ? g.home : null);
      games[g.id] = {
        d:   dt?.date || (Array.isArray(g.dates) ? g.dates[0] : null) || null,
        t:   dt?.time ? String(dt.time).slice(0, 5) : null,
        v:   venue?.name || null,
        c:   court?.name || null,
        opp: oppTeam?.name || null,
        oppId: oppTeam?.id || null,
        home: isHome,
        st:  g.status?.value || null,
        gid, gn, rn,
        finals: isFinals,
      };
    }
  }
  return games;
}

const FIELDS = [
  ['d',   'date'],
  ['t',   'time'],
  ['v',   'venue'],
  ['c',   'court'],
  ['opp', 'opponent'],
  ['st',  'status'],
  ['gn',  'grade'],
];

function describeGame(g) {
  const bits = [];
  bits.push(g.d || 'no date');
  if (g.t) bits.push(g.t);
  if (g.opp) bits.push(`${g.home === true ? 'v' : g.home === false ? '@' : 'vs'} ${g.opp}`);
  if (g.v) bits.push(g.v + (g.c ? ` ${g.c}` : ''));
  if (g.rn) bits.push(`[${g.rn}]`);
  return bits.join(' ');
}

// ─── Diff ────────────────────────────────────────────────────────────────────
function diffFixture(prevGames, nextGames) {
  const changes = [];
  const prevIds = Object.keys(prevGames || {});
  const nextIds = Object.keys(nextGames || {});

  for (const id of nextIds) {
    if (!prevGames[id]) { changes.push({ type: 'added', id, game: nextGames[id], line: `+ ADDED  ${describeGame(nextGames[id])}` }); continue; }
    const a = prevGames[id], b = nextGames[id];
    const diffs = [];
    for (const [key, label] of FIELDS) {
      if ((a[key] ?? null) !== (b[key] ?? null)) diffs.push(`${label} ${a[key] ?? '—'} → ${b[key] ?? '—'}`);
    }
    if (diffs.length) changes.push({ type: 'changed', id, game: b, line: `~ ${describeGame(b)}\n    ${diffs.join('; ')}` });
  }
  for (const id of prevIds) {
    if (!nextGames[id]) changes.push({ type: 'removed', id, game: prevGames[id], line: `− REMOVED  ${describeGame(prevGames[id])}` });
  }

  // (tid, gid) is the identity. The set of grades across the team's games changing
  // is a REGRADE — reported on its own, because it is the thing most likely to make
  // a Saturday morning go wrong and it is easy to miss among game-level diffs.
  const gidsOf = (gs) => [...new Set(Object.values(gs || {}).map(g => g.gid).filter(Boolean))].sort();
  const prevGids = gidsOf(prevGames), nextGids = gidsOf(nextGames);
  const regrade = prevGids.length && nextGids.length && prevGids.join(',') !== nextGids.join(',');

  return { changes, regrade, prevGids, nextGids };
}

// ─── State ───────────────────────────────────────────────────────────────────
function readJson(file, dflt) {
  if (!fs.existsSync(file)) return dflt;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    // A state file that will not parse is a FAULT, not an empty state. Treating it
    // as empty would re-baseline the team and swallow every change silently.
    throw new Error(`state file ${path.relative(ROOT, file)} does not parse: ${err.message}`);
  }
}
const teamStateFile = (tid) => path.join(STATE_DIR, `${tid}.json`);
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// ─── Git — the house pattern ─────────────────────────────────────────────────
// Per-path add (this repo stages a handful of files, far below the ~2,000 ceiling
// where --pathspec-from-file becomes necessary). Commit BEFORE fetch/merge.
// 60 push attempts with pure random 1–91s jitter. THROWS when exhausted, because a
// red job beats silently discarded work. Every git call carries a timeout and an
// explicit maxBuffer — execFileSync's 1 MB default SIGTERMs git mid-merge.
const GIT_OPTS = { encoding: 'utf8', stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
const git = (a) => execFileSync('git', a, GIT_OPTS);

async function gitCommit(paths, message) {
  if (!paths.length) { console.log('  (nothing to stage)'); return false; }
  const staged = [];
  for (const p of paths) {
    const rel = path.relative(ROOT, p);
    try { git(['add', '--', rel]); staged.push(rel); }
    catch (err) { console.log(`  ⚠ git add failed for ${rel}: ${String(err.stderr || err.message).split('\n')[0]}`); }
  }
  const short = git(['diff', '--staged', '--shortstat']).trim();
  if (!short) { console.log('  (no changes to commit)'); return false; }
  console.log(`  staging: ${short}  [${staged.length} path(s)]`);

  git(['commit', '-m', message]);

  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      git(['fetch', 'origin', 'main']);
      git(['merge', '-X', 'ours', 'FETCH_HEAD', '--no-edit', '--no-stat', '-q']);
      git(['push', 'origin', 'HEAD:main']);
      console.log(`  pushed (attempt ${attempt})`);
      return true;
    } catch (err) {
      const msg = String(err.stderr || err.message || '');
      // A size/LFS/hook rejection is the git equivalent of an HTTP 4xx — it can
      // never succeed, so burning 60 attempts on it only buries the real error.
      if (/GH001|exceeds|file size|LFS|pre-receive hook declined|protected branch/i.test(msg)) {
        throw new Error(`push rejected permanently, not retrying: ${msg.slice(0, 300)}`);
      }
      console.log(`  push attempt ${attempt} failed: ${msg.split('\n').filter(Boolean)[0] || 'unknown'}`);
      try { git(['merge', '--abort']); } catch (_) {}
      if (attempt === 60) break;
      await sleep(1000 + Math.floor(Math.random() * 90000));
    }
  }
  throw new Error('push failed after 60 attempts — the run is RED and the state was NOT saved');
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const started = Date.now();
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // uuid -> { seen:true, name, teams: {tid:{...}} }
  // ⚠️ NO TIMESTAMP IN HERE. A "last read at" field changes on every single run, so
  // this file would be committed 34 times a day saying nothing, and the real history
  // of fixture changes would be buried under it. `seen` is a flag: it exists to tell
  // a first run (baseline, no alerts) from a later one, and nothing else.
  const playerState = readJson(PLAYERS_ST, {});
  const meta        = readJson(META_ST, {});      // { lastFailureAlertAt }
  const failures    = [];
  const alerts      = [];                         // { key, title, lines[], url, priority }
  const touched     = new Set();

  // ⚠️ STATE IS WRITTEN AFTER THE ALERTS ARE SENT, NOT BEFORE.
  // Writing first means that when Pushover rejects a send, the change has already
  // been baselined: the next run sees no difference, and the alert is lost for good.
  // The phone never buzzes and nothing in the repo says anything went wrong. So
  // every write is held here, keyed by the alert it belongs to, and applied only
  // when that alert actually reached Pushover. A held-back write costs one re-ask
  // on the next slot; a lost alert costs the whole point of the repo.
  const pendingWrites  = new Map();   // key -> { file, data }
  const pendingDeletes = new Map();   // key -> { file, tid }
  const pendingPlayers = new Map();   // key -> { uuid, data }

  const todayMs = Date.now();

  // ── Phase 1 · profiles ────────────────────────────────────────────────────
  // The team list per player. A player whose profile could not be read keeps the
  // team list from last time and contributes NO removals — a failed fetch must
  // never look like a team disappearing.
  const toCheck = new Map();   // tid -> { tid, reg, players:Set, pinned:boolean }

  for (const p of WATCHED) {
    console.log(`\n── ${p.name || p.uuid} (${p.uuid}) ──`);
    const r = await probeTeams(p.uuid);
    await sleep(DELAY_MS);

    const prev = playerState[p.uuid] || { teams: {}, seen: false };

    if (r.kind !== 'ok') {
      console.log(`  ✖ profile NOT ANSWERED — ${r.kind}: ${r.detail}`);
      failures.push(`${p.name || p.uuid}: profile ${r.kind} — ${r.detail}`);
      // Keep watching the teams we already know about, so a profile outage does not
      // also blind us to fixture changes. Nothing is removed and nothing is added.
      for (const tid of Object.keys(prev.teams || {})) {
        if (!toCheck.has(tid)) toCheck.set(tid, { tid, reg: prev.teams[tid], players: new Set(), pinned: false });
        toCheck.get(tid).players.add(p.uuid);
      }
      continue;
    }

    // A registration is CURRENT while its season is not COMPLETED. A COMPLETED
    // season's team is still watched until stopAfterSeasonEndDays — finals fixtures
    // appear after the last round and a season can be marked complete before them.
    const current = {};
    for (const t of r.teams) {
      const s = t.season || {};
      current[t.id] = {
        tid: t.id, name: t.name || null,
        club: t.organisation?.name || null, clubId: t.organisation?.id || null,
        sid: s.id || null, seasonName: s.name || null,
        seasonStatus: s.status?.value || null,
        startDate: s.startDate || null, endDate: s.endDate || null,
        comp: s.competition?.name || null,
        assoc: s.competition?.organisation?.name || null,
        regGid: t.grade?.id || null, regGrade: t.grade?.name || null,
      };
    }
    console.log(`  profile OK — ${Object.keys(current).length} registration(s)`);

    // Team appeared / disappeared on the profile.
    const prevTids = new Set(Object.keys(prev.teams || {}));
    const nextTids = new Set(Object.keys(current));
    const appeared = [...nextTids].filter(t => !prevTids.has(t));
    const vanished = [...prevTids].filter(t => !nextTids.has(t));

    if (prev.seen) {   // never on the very first run — that is the baseline
      for (const tid of appeared) {
        const c = current[tid];
        alerts.push({
          key: `p:${p.uuid}`,
          title: `${p.name || 'Player'} — NEW TEAM`,
          lines: [`${c.name || tid}`, `${c.club || ''} · ${c.seasonName || ''} ${c.regGrade ? `· ${c.regGrade}` : ''}`.trim(), `${c.comp || ''}`].filter(Boolean),
          url: teamUrl(tid, c.sid), priority: 1,
        });
      }
      for (const tid of vanished) {
        const c = prev.teams[tid] || {};
        alerts.push({
          key: `p:${p.uuid}`,
          title: `${p.name || 'Player'} — TEAM GONE`,
          lines: [`${c.name || tid} is no longer on the profile`, `${c.club || ''} · ${c.seasonName || ''}`.trim(), 'Watching has stopped for this team.'].filter(Boolean),
          url: teamUrl(tid, c.sid), priority: 1,
        });
        // STOP: drop the state file — but only once the alert has been delivered,
        // or a failed send would stop the watching AND never say so.
        const f = teamStateFile(tid);
        if (fs.existsSync(f)) pendingDeletes.set(`p:${p.uuid}|${tid}`, { file: f, tid, alertKey: `p:${p.uuid}` });
      }
    }

    pendingPlayers.set(`p:${p.uuid}`, { uuid: p.uuid, data: { seen: true, name: p.name || null, teams: current } });

    for (const tid of Object.keys(current)) {
      if (!toCheck.has(tid)) toCheck.set(tid, { tid, reg: current[tid], players: new Set(), pinned: false });
      toCheck.get(tid).players.add(p.uuid);
    }
    for (const tid of (p.pinnedTeams || [])) {
      if (!toCheck.has(tid)) toCheck.set(tid, { tid, reg: { tid, name: null, sid: null }, players: new Set(), pinned: true });
      toCheck.get(tid).players.add(p.uuid);
      toCheck.get(tid).pinned = true;
    }
  }

  function teamUrl(tid, sid) {
    // StatTrack's own deep-link format, read out of its hashFor(): t=<tid>&s=<sid>.
    if (!STATTRACK || !tid || !sid) return null;
    return `${STATTRACK}#t=${encodeURIComponent(tid)}&s=${encodeURIComponent(sid)}`;
  }

  // ── Phase 2 · fixtures ────────────────────────────────────────────────────
  const playerName = (uuid) => (WATCHED.find(w => w.uuid === uuid)?.name) || uuid.slice(0, 8);
  let checked = 0, skippedReduced = 0, stopped = 0, outOfScope = 0;

  for (const [tid, item] of toCheck) {
    const file  = teamStateFile(tid);
    const state = readJson(file, null);
    const reg   = item.reg || {};
    const label = `${reg.name || tid}${reg.club ? ` (${reg.club})` : ''}`;

    // STOP on season age. A missing endDate NEVER stops anything.
    const endDate = reg.endDate || state?.reg?.endDate || null;
    if (!item.pinned && endDate) {
      const endMs = Date.parse(`${endDate}T00:00:00Z`);
      if (Number.isFinite(endMs) && todayMs > endMs + STOP_AFTER_D * 86400000) {
        // A team with no state file was never watched, so there is nothing to stop.
        // Calling that "stopping" reads as though something was switched off, which
        // on a first run would be eight alarming lines about teams from 2024.
        if (state) {
          console.log(`\n  − ${label}: season ended ${endDate}, more than ${STOP_AFTER_D} days ago — stopping.`);
          if (!DRY_RUN) { fs.rmSync(file); touched.add(file); }   // no alert to lose: nothing to defer
          stopped++;
        } else {
          console.log(`\n  · ${label}: season ended ${endDate} — out of scope, never watched.`);
          outOfScope++;
        }
        continue;
      }
    }

    // ── CADENCE ──────────────────────────────────────────────────────────────
    // Decided from the coverage THIS TEAM'S LAST CHECK recorded, because the
    // decision has to be made before we have fetched anything this run.
    //
    // Only one thing earns a reduced cadence: a game in every non-finals round of
    // the grade AND a game still to come. Nothing is left to publish for such a
    // team until finals. Everything else — missing rounds, last game passed,
    // unknown coverage, no state — is FULL. Every unknown falls to FULL.
    const cov             = state?.coverage || null;
    const changedRecently = state?.lastChangeAt ? (todayMs - Date.parse(state.lastChangeAt)) < CHANGE_WINDOW_D * 86400000 : false;
    // Unknown last-game date reads as PASSED, which routes to FULL.
    const lastGamePassed  = cov?.lastGameDate ? todayMs > Date.parse(`${cov.lastGameDate}T23:59:59Z`) : true;
    const full = !state || !cov?.complete || lastGamePassed || changedRecently;
    if (!full && !CHECK_REDUCED) { skippedReduced++; continue; }

    const why = !state ? 'first run'
              : !cov?.complete ? `fixture incomplete${cov?.missing?.length ? ` — missing ${cov.missing.slice(0, 4).join(', ')}${cov.missing.length > 4 ? ` +${cov.missing.length - 4}` : ''}` : ''}`
              : lastGamePassed ? 'last scheduled game has passed — hunting finals'
              : changedRecently ? 'changed recently'
              : 'complete fixture, games still to come';
    console.log(`\n  ${full ? 'FULL   ' : 'REDUCED'} ${label}  (${why})`);
    const f = await teamFixture(tid);
    await sleep(DELAY_MS);
    checked++;

    if (f.kind !== 'ok') {
      // ⚠️ NOTHING IS WRITTEN AND NOTHING IS ALERTED. This is the whole rule.
      console.log(`     ✖ NOT ANSWERED — ${f.kind}: ${f.detail}. State left untouched; no fixture alert from this team.`);
      failures.push(`${label}: fixture ${f.kind} — ${f.detail}`);
      if (f.kind === 'no-session') break;
      continue;
    }

    const games = normaliseGames(tid, f.rounds);
    const count = Object.keys(games).length;

    // ── COVERAGE ─────────────────────────────────────────────────────────────
    // Does this team hold a game in every non-finals round of its CURRENT grade?
    // Coverage is computed against the current grade only: after a regrade the
    // team's games span two grades, and the rounds that matter from here are the
    // new grade's. Rounds are matched on ROUND ID, never on name — names repeat
    // across grades and seasons.
    const curGid = f.team?.grade?.id || [...new Set(Object.values(games).map(g => g.gid).filter(Boolean))].pop() || null;
    let roundsInfo = state?.rounds && state.rounds.gid === curGid ? state.rounds : null;
    const roundsStale = !roundsInfo || !roundsInfo.fetchedAt
      || (todayMs - Date.parse(roundsInfo.fetchedAt)) > ROUNDS_REFRESH_H * 3600000
      || !state?.coverage?.complete          // still filling: the round list may have grown
      || lastGamePassed;                     // finals rounds get added after the last round

    if (curGid && roundsStale) {
      const gr = await gradeRounds(curGid);
      await sleep(DELAY_MS);
      if (gr.kind === 'ok') {
        roundsInfo = { gid: curGid, fetchedAt: nowIso(), list: gr.rounds.map(r => ({ id: r.id, name: r.name || null, number: r.number ?? null, isFinalsRound: !!r.isFinalsRound })) };
      } else {
        // Could not ask. Keep whatever we had, and let coverage fall to unknown if
        // we had nothing — which routes the team to FULL. Not a run-level failure:
        // the fixture itself was answered, so the alerting is unaffected.
        console.log(`     grade rounds NOT ANSWERED — ${gr.kind}: ${gr.detail}. Cadence falls back to FULL for this team.`);
      }
    }

    let coverage = null;
    if (roundsInfo?.list?.length) {
      // ⚠️ A ROUND OBJECT IN THE RESPONSE IS NOT A GAME.
      // discoverTeamFixture returns the GRADE's rounds, including rounds this team
      // holds no game in. Measured on real data 2026-11-15: B13 Spirit Magic 3 came
      // back with 15 round objects for 5 games and was scored 11/15 covered, which
      // is nonsense — 5 games cannot cover 11 rounds. A round counts as covered only
      // when the team actually holds a game in it. A BYE is a game entry, so a bye
      // round still counts as covered.
      const teamRoundIds = new Set(
        f.rounds
          .filter(r => (!curGid || r?.grade?.id === curGid) && (r?.fixture?.games || []).some(g => g?.id))
          .map(r => r?.id).filter(Boolean)
      );
      const needed  = roundsInfo.list.filter(r => !r.isFinalsRound);
      const missing = needed.filter(r => !teamRoundIds.has(r.id));
      const dates   = Object.values(games).map(g => g.d).filter(Boolean).sort();
      coverage = {
        gid: curGid,
        roundsInGrade: roundsInfo.list.length,
        nonFinalsRounds: needed.length,
        covered: needed.length - missing.length,
        complete: needed.length > 0 && missing.length === 0,
        missing: missing.map(r => r.name || `round ${r.number ?? '?'}`),
        finalsRoundsInGrade: roundsInfo.list.filter(r => r.isFinalsRound).length,
        lastGameDate: dates.length ? dates[dates.length - 1] : null,
        checkedAt: nowIso(),
      };
      console.log(`     coverage: ${coverage.covered}/${coverage.nonFinalsRounds} non-finals round(s) hold a game${coverage.complete ? ' — COMPLETE' : `, missing ${coverage.missing.slice(0, 4).join(', ')}${coverage.missing.length > 4 ? ` +${coverage.missing.length - 4}` : ''}`}${coverage.finalsRoundsInGrade ? `; ${coverage.finalsRoundsInGrade} finals round(s) in the grade` : ''}; ${count} game(s); last game ${coverage.lastGameDate || '—'}`);
    } else {
      console.log('     coverage: UNKNOWN (no grade round list) — this team stays on FULL');
    }
    const teamMeta = {
      tid,
      name: f.team?.id ? (reg.name || state?.reg?.name || null) : (reg.name || null),
      club: reg.club || f.team?.organisation?.name || state?.reg?.club || null,
      sid:  reg.sid  || f.team?.season?.id || state?.reg?.sid || null,
      seasonName: reg.seasonName || f.team?.season?.name || state?.reg?.seasonName || null,
      seasonStatus: reg.seasonStatus || f.team?.season?.status?.value || null,
      endDate: endDate,
      comp: reg.comp || f.team?.season?.competition?.name || null,
      assoc: reg.assoc || f.team?.season?.competition?.organisation?.name || null,
      currentGid: f.team?.grade?.id || null,
      currentGrade: f.team?.grade?.name || null,
    };
    const url = teamUrl(tid, teamMeta.sid);
    const who = [...item.players].map(playerName).join(', ');

    if (!state) {
      // FIRST RUN FOR THIS TEAM — baseline, one summary, never one alert per game.
      console.log(`     baseline: ${count} game(s), ${f.rounds.length} round(s)`);
      alerts.push({
        key: `t:${tid}`,
        title: `${who} — now watching ${teamMeta.name || tid}`,
        lines: [
          `${teamMeta.club || ''} · ${teamMeta.seasonName || ''} ${teamMeta.currentGrade ? `· ${teamMeta.currentGrade}` : ''}`.trim(),
          `${count} game(s) on the fixture`,
          ...(() => {
            const future = Object.values(games)
              .filter(g => g.d && Date.parse(`${g.d}T23:59:59Z`) >= todayMs)
              .sort((a, b) => (a.d || '').localeCompare(b.d || ''));
            // Saying nothing here reads as "no games". Say which it is.
            if (!future.length) return [coverage && !coverage.complete ? 'No games scheduled ahead — waiting on the next fixture block.' : 'No games scheduled ahead.'];
            return future.slice(0, 3).map(g => `  ${describeGame(g)}`);
          })(),
        ].filter(Boolean),
        url, priority: 0, baseline: true,
      });
      pendingWrites.set(`t:${tid}`, { file, data: { tid, reg: teamMeta, players: [...item.players], games, rounds: roundsInfo || null, coverage, firstSeenAt: nowIso(), lastChangeAt: nowIso(), lastCheckedAt: nowIso() } });
      continue;
    }

    const prevCount = Object.keys(state.games || {}).length;
    const { changes, regrade, prevGids, nextGids } = diffFixture(state.games || {}, games);

    // ── The loud one. A fixture that had games and now has none usually means the
    // regrade was made as a NEW team entry, so the real fixture is somewhere else
    // and this team will quietly never show a game again.
    if (prevCount > 0 && count === 0) {
      console.log(`     ‼ FIXTURE DROPPED TO ZERO (was ${prevCount})`);
      alerts.push({
        key: `t:${tid}`,
        title: `‼ ${who} — FIXTURE EMPTY: ${teamMeta.name || tid}`,
        lines: [
          `This team had ${prevCount} game(s) and now has NONE.`,
          'PlayHQ answered normally — this is not a fetch failure.',
          'Most likely a regrade made as a new team entry: the fixture will be under a different team id.',
          `${teamMeta.club || ''} · ${teamMeta.seasonName || ''}`.trim(),
        ].filter(Boolean),
        url, priority: 1,
      });
    } else if (changes.length || regrade) {
      const lines = [];
      if (regrade) lines.push(`REGRADE: ${prevGids.join(',')} → ${nextGids.join(',')}${teamMeta.currentGrade ? ` (${teamMeta.currentGrade})` : ''}`);
      for (const c of changes) lines.push(c.line);
      const counts = ['added', 'changed', 'removed'].map(t => { const n = changes.filter(c => c.type === t).length; return n ? `${n} ${t}` : null; }).filter(Boolean).join(', ');
      console.log(`     ${regrade ? 'REGRADE + ' : ''}${counts || 'no game changes'}`);
      alerts.push({
        key: `t:${tid}`,
        title: `${who} — ${teamMeta.name || tid}${regrade ? ' REGRADED' : ''}`,
        lines: [`${teamMeta.seasonName || ''} ${teamMeta.currentGrade ? `· ${teamMeta.currentGrade}` : ''}`.trim(), ...lines].filter(Boolean),
        url, priority: regrade ? 1 : 0,
      });
    } else {
      console.log(`     no change (${count} game(s))`);
    }

    const changed = changes.length > 0 || regrade || (prevCount > 0 && count === 0);
    {
      const next = {
        tid, reg: teamMeta, players: [...item.players], games,
        rounds: roundsInfo || state.rounds || null,
        coverage: coverage || state.coverage || null,
        firstSeenAt: state.firstSeenAt || nowIso(),
        lastChangeAt: changed ? nowIso() : (state.lastChangeAt || null),
        lastCheckedAt: nowIso(),
      };
      // Coverage carries timestamps that move on every single check. Comparing the
      // whole object would commit on every slot and bury the fixture history, so
      // only the parts a reader or the next run's cadence depends on are compared.
      const covSig = (c) => c ? JSON.stringify([c.gid, c.complete, c.covered, c.nonFinalsRounds, c.missing, c.lastGameDate, c.finalsRoundsInGrade]) : 'null';
      // Only write when something a reader would care about moved. lastCheckedAt
      // alone is not worth a commit on every slot — that is 34 commits a day of
      // nothing, and it would bury the real history.
      if (changed || JSON.stringify(next.games) !== JSON.stringify(state.games) || JSON.stringify(next.reg) !== JSON.stringify(state.reg) || covSig(next.coverage) !== covSig(state.coverage)) {
        pendingWrites.set(`t:${tid}`, { file, data: next });
      }
    }
  }

  console.log(`\n[fixture-watch] ${checked} team(s) checked, ${skippedReduced} complete-fixture team(s) not due this slot, ${stopped} stopped, ${outOfScope} out of scope (season long over).`);

  // ── Phase 3 · alerts ──────────────────────────────────────────────────────
  const token = process.env.PUSHOVER_TOKEN || '';
  const user  = process.env.PUSHOVER_USER  || '';
  let sendFailed = false;

  const failedKeys = new Set();

  if (NO_ALERTS && alerts.length) {
    // Suppressed on purpose, not failed. The state is written, because the operator
    // asked for no alerts and does not want the same ones again on the next slot.
    console.log(`[fixture-watch] --no-alerts: ${alerts.length} alert(s) suppressed.`);
  } else {
    for (const a of alerts) {
      const body = pushover.buildBody(a.lines, MAX_ALERT_CHARS);
      const r = await pushover.send({ token, user, title: a.title, message: body, url: a.url || undefined, urlTitle: 'Open in StatTrack', priority: a.priority, dryRun: DRY_RUN });
      if (!r.ok) {
        console.log(`  ✖ Pushover failed: ${r.detail}`);
        failures.push(`Pushover: ${r.detail}`);
        sendFailed = true;
        if (a.key) failedKeys.add(a.key);
      }
    }
    if (alerts.length && !DRY_RUN && !sendFailed) console.log(`[fixture-watch] ${alerts.length} alert(s) sent.`);
    if (!alerts.length) console.log('[fixture-watch] no alerts.');
  }

  // ── Phase 4 · failure alert, rate limited ─────────────────────────────────
  if (failures.length) {
    const last = meta.lastFailureAlertAt ? Date.parse(meta.lastFailureAlertAt) : 0;
    const due  = !Number.isFinite(last) || (todayMs - last) > FAIL_COOLDOWN_H * 3600000;
    console.log(`\n[fixture-watch] ${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ✖ ${f}`);
    if (due && !NO_ALERTS) {
      const r = await pushover.send({
        token, user,
        title: 'watcher failed',
        message: pushover.buildBody([`${failures.length} failure(s) this run:`, ...failures], MAX_ALERT_CHARS),
        priority: 0, dryRun: DRY_RUN,
      });
      if (r.ok && !DRY_RUN) meta.lastFailureAlertAt = nowIso();
      if (!r.ok) console.log(`  ✖ failure alert could not be sent: ${r.detail}`);
    } else if (!due) {
      console.log(`  (failure alert suppressed — one was sent within the last ${FAIL_COOLDOWN_H}h. The run is still RED.)`);
    }
  }

  // ── Phase 5 · persist ─────────────────────────────────────────────────────
  let held = 0;
  if (!DRY_RUN) {
    for (const [key, w] of pendingWrites) {
      if (failedKeys.has(key)) { held++; console.log(`  ↺ holding back state for ${key} — its alert did not send, so the next run re-detects and re-alerts`); continue; }
      writeJson(w.file, w.data); touched.add(w.file);
    }
    for (const [, d] of pendingDeletes) {
      if (failedKeys.has(d.alertKey)) { held++; console.log(`  ↺ holding back the stop for ${d.tid} — its alert did not send`); continue; }
      if (fs.existsSync(d.file)) { fs.rmSync(d.file); touched.add(d.file); console.log(`  − stopped watching ${d.tid} (left the profile)`); }
    }
    for (const [key, pl] of pendingPlayers) {
      if (failedKeys.has(key)) { held++; continue; }
      playerState[pl.uuid] = pl.data;
    }

    writeJson(PLAYERS_ST, playerState); touched.add(PLAYERS_ST);
    writeJson(META_ST, meta);           touched.add(META_ST);
    // These two are staged unconditionally and git decides: when their content is
    // unchanged the staged shortstat is empty and nothing is committed. That is what
    // keeps a quiet slot from producing a commit saying nothing.
    await gitCommit([...touched], `fixture-watch: ${alerts.length} alert(s), ${checked} team(s) checked [skip ci]`);
    if (held) console.log(`[fixture-watch] ${held} state write(s) held back because their alert failed.`);
  } else {
    console.log(`\n[fixture-watch] --dry-run: nothing written, nothing committed (${pendingWrites.size} write(s) and ${pendingDeletes.size} stop(s) would have been applied).`);
  }

  console.log(`[fixture-watch] session ${JSON.stringify(sessionGuard.stats())}, elapsed ${Math.round((Date.now() - started) / 1000)}s`);

  if (failures.length) {
    console.error('\nFAILED: see the failure list above. State was written ONLY for teams PlayHQ answered AND whose alert was delivered; everything else is untouched, so the next run re-asks and re-alerts. Nothing has been lost.');
    process.exit(1);
  }
  console.log('Done.');
})().catch(err => {
  console.error(`\nFATAL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
