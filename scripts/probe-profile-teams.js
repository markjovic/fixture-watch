// scripts/probe-profile-teams.js   ·   v2 (CLUB SWEEP)
//
// ⚠️ v2 REPLACES the v1 file of the same name delivered earlier on 2026-11-15.
// v1 could only answer the question if a registration for an unplayed season
// already existed. Mark reported there are no upcoming seasons right now, so v2
// adds the club sweep described below, which asks PlayHQ what seasons EXIST rather
// than waiting for one to turn up on a profile. You can tell them apart in the log:
// v2 prints "probe-profile-teams v2" in its banner and a CLUB SWEEP section.
//
// THE DECIDING TEST for fixture-watch, and nothing else.
//
// THE QUESTION
//   Does a new registration appear on `publicProfileTeams` as soon as the player is
//   registered, or only after their first game has been played?
//
//   If it appears at registration, following by PLAYER is sufficient: every current
//   team on the profile is watched and a new season's fixture is seen the moment it
//   is published. If it only appears after game one, following by player finds a new
//   season's fixture AFTER round 1 — which defeats the purpose — and pinned team ids
//   become essential rather than a fallback.
//
// WHAT IT DOES
//   1. One `publicProfileTeams` call per player.
//   2. For each team that comes back, one `discoverTeamFixture` call to count how
//      many of that team's games have actually been played. A registration whose
//      team has games scheduled and ZERO played is direct proof of
//      registration-time visibility.
//   3. CLUB SWEEP. For each organisation the player is registered at, one
//      `discoverCompetitions(organisationID)` call — which returns every season that
//      club has ever run, with startDate, endDate and status, INCLUDING seasons at
//      status UPCOMING. Measured 2026-09-07: this works on a guest session and sees
//      a season the moment the association creates it, before anybody has played.
//
//      That turns the question into a comparison that can be run TODAY: here are the
//      seasons the club has, here are the seasons on the player's profile, and here
//      is the difference. A season the club holds that the profile does not list is
//      either "the player is not registered for it" or "registered and not visible"
//      — and Mark knows which, for his own children, without needing a probe.
//
//   It prints the raw `publicProfileTeams` payload per player, unmerged and
//   untouched, so the answer does not depend on this script's interpretation of it.
//
// WHAT IT DOES NOT DO
//   No writes, no commits, no state, no Pushover. It is a one-off.
//
// ─── PROVENANCE OF EVERY PLAYHQ-FACING LINE ──────────────────────────────────
//   HEADERS_BASE, COOKIE_QUERIES, refreshSession(), doFetch(), isWafBlock,
//   Q_PROFILE_TEAMS and Q_TEAM_FIXTURE are COPIED VERBATIM from the live scripts in
//   markjovic/sports-players-stats, as the project rules require — never written
//   from scratch, never trimmed:
//     · HEADERS_BASE, COOKIE_QUERIES, refreshSession, doFetch, isWafBlock,
//       Q_PROFILE_TEAMS      → scripts/discover-seasons.js  (staged copy 2026-10-13)
//     · Q_TEAM_FIXTURE       → scripts/discover-fixtures.js (staged copy 2026-10-13)
//     · Q_ORG_COMPETITIONS   → scripts/discover-org-seasons.js (staged copy)
//     · lib/playhq-session.cjs → copied as a whole file, unmodified
//   The ONE adaptation to refreshSession: discover-seasons.js sets
//   BOOTSTRAP_REFUSED_RETRIES to 0 when running as a matrix shard, because a shard
//   has a 10-minute job limit. This probe is not a shard, so it takes the
//   non-shard branch (one retry after one full penalty window) and the SHARD
//   references are gone. No query, header or client behaviour is changed.
//
// ─── RULES THIS SCRIPT IS BUILT ON ───────────────────────────────────────────
//   · fetch() ONLY. Never https.request, never a hand-set content-length. Measured
//     2026-10-05 on one runner ten seconds apart, same URL and same headers:
//     fetch() granted, https.request refused with a CloudFront block.
//   · The five headers go together unmodified, emulator user-agent included. Drop
//     the user-agent and CloudFront 403s immediately.
//   · NEVER `actions/setup-node` in a job that calls api.playhq.com — it changes the
//     runner's outbound fingerprint and every request is refused, session
//     acquisition included. The workflow uses the runner's preinstalled Node.
//   · A CloudFront hard block (403 with an HTML body) is DISTINCT from an
//     application 403 and is reported as such.
//   · A failure to ASK is never recorded as an ANSWER. NOT_FOUND, a block, a
//     timeout and an empty registration list are four different outcomes and are
//     printed as four different outcomes. The run exits non-zero if any player was
//     not answered.
//   · Player ids must be api-namespace ids — the ones in StatTrack URLs. A
//     spectator id returns NOT_FOUND, and NOT_FOUND must never be read as
//     "this player has no teams".
//
// USAGE (dispatched from the workflow; these are its arguments)
//   node scripts/probe-profile-teams.js --players=<uuid>[,<uuid>...]
//        [--tenant=basketball-victoria] [--no-fixtures] [--no-clubs] [--delay=400]

'use strict';

const crypto = require('crypto');
const { createSessionGuard } = require('./lib/playhq-session.cjs');

// ─── Arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a === undefined ? dflt : a.slice(name.length + 3).trim();
};

const PLAYERS = (argOf('players', '') || '')
  .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
const TENANT      = argOf('tenant', 'basketball-victoria') || 'basketball-victoria';
const DO_FIXTURES = !args.includes('--no-fixtures');
const DO_CLUBS    = !args.includes('--no-clubs');
const DELAY_MS    = (() => {
  const n = parseInt(argOf('delay', '400'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 400;
})();

const API_URL = 'https://api.playhq.com/graphql';

if (!PLAYERS.length) {
  console.error('FATAL: no player ids. Pass --players=<uuid>[,<uuid>...] (api-namespace ids, the ones in StatTrack URLs).');
  process.exit(2);
}

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
// How a REFUSED bootstrap is handled: wait one full penalty window, then one retry.
const BOOTSTRAP_REFUSED_WAIT_MS = 15 * 60 * 1000;
const BOOTSTRAP_REFUSED_RETRIES = 1;
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function refreshSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    // ⚠️ A REFUSED BOOTSTRAP IS RETRIED ONCE, AFTER ONE FULL WINDOW.
    // The 2026-10-04 cadence (20s, 40s, 60s … ten attempts) made up to ten
    // cookieless requests INTO the penalty window it was waiting out, and every
    // request made into that window extends it. A 403 means the window is open, so
    // wait the full ~15 minutes it lasts and ask ONCE more. A second refusal is
    // final — fail loudly, write nothing. Non-403 failures (an answer with no
    // cookie in it) are not the window and keep a short retry.
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
          // A 403 is the SOURCE being refused, not this query. Trying the next one
          // immediately only doubles the rate into a block that is already on.
          if (status === 403) { refused = true; break; }
          continue;
        }
        // undici hands back one entry per Set-Cookie; the joined-header fallback holds
        // several in one string, so split that on ',' as the old code did.
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
    throw new Error(`Failed to obtain session cookie: ${longWaits ? `refused ${longWaits + 1} times, ${Math.round(BOOTSTRAP_REFUSED_WAIT_MS / 60000)} minutes apart — the penalty window did not close` : 'no usable cookie in any answer'} — see per-attempt ⚠ lines above for HTTP status and body`);
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

// ─── doFetch — copied verbatim. fetch() ONLY. ────────────────────────────────
// ⚠️ DO NOT "OPTIMISE" THIS BACK TO https.request, AND DO NOT SET content-length BY
// HAND. Measured on one runner, 10 s apart, same URL, same five headers, same
// user-agent: fetch() GRANTED, https.request REFUSED (403 CLOUDFRONT-BLOCK).
// It resolves on ANY status and never throws for a 403.
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
  return {
    status:     res.status,
    rawCookies: cookies.length ? cookies : undefined,
    body,
    rawText,
  };
}

// The WAF block page, as nightly-crawl.js recognises it.
const isWafBlock = (rawText) => /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(rawText || '') || (rawText || '').includes('DOCTYPE');

// ─── Queries — copied verbatim ───────────────────────────────────────────────
// Q_PROFILE_TEAMS: scripts/discover-seasons.js
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

// Q_TEAM_FIXTURE: scripts/discover-fixtures.js — the per-team fixture call.
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

// Q_ORG_COMPETITIONS: scripts/discover-org-seasons.js — the top-down season route.
// ⚠️ The reference's note "discoverOrganisation for BV: returns null for guest
// sessions" is about a DIFFERENT query. discoverCompetitions works on a guest
// session, and it returns seasons at status UPCOMING — which is the whole point
// here: it sees a season before anybody has registered or played.
const Q_ORG_COMPETITIONS = {
  operationName: 'discoverCompetitions',
  query: `query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id
    name
    seasons(organisationID: $organisationID) {
      id
      name
      startDate
      endDate
      status { name value }
    }
    organisation { id name }
  }
}`,
};

// ─── Typed calls ─────────────────────────────────────────────────────────────
// Every outcome is named. "I could not ask" is never returned as "the answer is none".
async function probeTeams(profileID) {
  try { await ensureSession(); }
  catch (err) { return { kind: 'no-session', err }; }

  let status, json, rawText;
  try {
    ({ status, body: json, rawText } = await doFetch(API_URL, { ...Q_PROFILE_TEAMS, variables: { profileID } }, { ...HEADERS_BASE, 'Cookie': sessionCookie }));
  } catch (err) { return { kind: 'error', err }; }

  if (status === 403) {
    if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)` };
    return { kind: 'private', detail: 'application 403 — profile inaccessible (NOT a CloudFront block)' };
  }
  if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
  if (status < 200 || status >= 300) return { kind: 'error', err: new Error(`HTTP ${status}`) };
  if (!json) return { kind: 'error', err: new Error(`unparseable body: ${(rawText || '').slice(0, 120)}`) };

  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).join(' | ');
    // NOT_FOUND is the signature of a non-api-namespace id (a spectator id, or a
    // truncated one). It is NOT "this player has no teams" and must never be
    // reported as such.
    if (/not.?found/i.test(msg)) return { kind: 'notfound', detail: msg };
    return { kind: 'gql-error', detail: msg };
  }

  const teams = (json.data || json)?.publicProfileTeams;
  if (teams == null) return { kind: 'null', detail: 'publicProfileTeams is NULL — the profile is PRIVATE, or the id does not resolve on this tenant. This call cannot tell those two apart.' };
  return { kind: 'ok', teams: Array.isArray(teams) ? teams : [], raw: json };
}

async function teamFixture(teamID) {
  try { await ensureSession(); }
  catch (err) { return { kind: 'no-session', err }; }

  let status, json, rawText;
  try {
    ({ status, body: json, rawText } = await doFetch(API_URL, { ...Q_TEAM_FIXTURE, variables: { teamID } }, { ...HEADERS_BASE, 'Cookie': sessionCookie }));
  } catch (err) { return { kind: 'error', err }; }

  if (status === 403) {
    if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)` };
    return { kind: 'forbidden', detail: 'application 403' };
  }
  if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
  if (status < 200 || status >= 300) return { kind: 'error', err: new Error(`HTTP ${status}`) };
  if (!json) return { kind: 'error', err: new Error(`unparseable body: ${(rawText || '').slice(0, 120)}`) };
  if (json.errors?.length) return { kind: 'gql-error', detail: json.errors.map(e => e.message).join(' | ') };

  const data = json.data || json;
  // `data` present with no discoverTeamFixture means the team genuinely has no
  // rounds — a real answer, distinct from a failure to ask.
  return { kind: 'ok', team: data.discoverTeam || null, rounds: Array.isArray(data.discoverTeamFixture) ? data.discoverTeamFixture : [] };
}

async function orgCompetitions(organisationID) {
  try { await ensureSession(); }
  catch (err) { return { kind: 'no-session', err }; }

  let status, json, rawText;
  try {
    ({ status, body: json, rawText } = await doFetch(API_URL, { ...Q_ORG_COMPETITIONS, variables: { organisationID } }, { ...HEADERS_BASE, 'Cookie': sessionCookie }));
  } catch (err) { return { kind: 'error', err }; }

  if (status === 403) {
    if (isWafBlock(rawText)) return { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(rawText || '').length}b HTML)` };
    return { kind: 'forbidden', detail: 'application 403' };
  }
  if (status === 429 || status === 503) return { kind: 'blocked', detail: `HTTP ${status} rate signal` };
  if (status < 200 || status >= 300) return { kind: 'error', err: new Error(`HTTP ${status}`) };
  if (!json) return { kind: 'error', err: new Error(`unparseable body: ${(rawText || '').slice(0, 120)}`) };
  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).join(' | ');
    // "Organisation could not be found" is a real answer about a deleted org, not a
    // failure to ask. It is still not "this club has no seasons".
    return { kind: 'gql-error', detail: msg };
  }

  const comps = (json.data || json)?.discoverCompetitions;
  if (comps == null) return { kind: 'null', detail: 'discoverCompetitions is NULL' };
  return { kind: 'ok', comps: Array.isArray(comps) ? comps : [] };
}

// ─── Fixture summary ─────────────────────────────────────────────────────────
// A game counts as PLAYED when PlayHQ says FINAL or a score is recorded. Those two
// are counted separately as well, because they are different claims.
const TERMINAL = new Set(['FINAL', 'CANCELLED', 'ABANDONED', 'FORFEIT']);

function parseScoreCount(stats) {
  if (!Array.isArray(stats)) return null;
  const s = stats.find(x => (x?.type?.value || '').toUpperCase() === 'SCORE' || (x?.type?.value || '').toUpperCase() === 'POINTS');
  if (s && Number.isFinite(s.count)) return s.count;
  return Number.isFinite(stats[0]?.count) ? stats[0].count : null;
}

function summariseRounds(rounds) {
  const byStatus = {};
  let games = 0, final = 0, scored = 0, upcoming = 0, finalsRounds = 0;
  let firstDate = null, lastDate = null;
  const gradeIds = new Set();

  for (const round of rounds) {
    if (round?.isFinalsRound) finalsRounds++;
    if (round?.grade?.id) gradeIds.add(`${round.grade.id}|${round.grade.name || ''}`);
    for (const g of (round?.fixture?.games || [])) {
      if (!g?.id) continue;
      games++;
      const st = (g.status?.value || 'UNKNOWN').toUpperCase();
      byStatus[st] = (byStatus[st] || 0) + 1;
      if (st === 'FINAL') final++;
      if (!TERMINAL.has(st)) upcoming++;
      const hs = parseScoreCount(g.result?.home?.statistics);
      const as = parseScoreCount(g.result?.away?.statistics);
      if (hs != null || as != null) scored++;
      const d = g.allocation?.dateTimeList?.[0]?.date || (Array.isArray(g.dates) ? g.dates[0] : null);
      if (d) {
        if (!firstDate || d < firstDate) firstDate = d;
        if (!lastDate  || d > lastDate)  lastDate  = d;
      }
    }
  }
  return { games, final, scored, upcoming, byStatus, firstDate, lastDate, finalsRounds, rounds: rounds.length, gradeIds: [...gradeIds] };
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const started = Date.now();
  console.log('═'.repeat(78));
  console.log('fixture-watch — probe-profile-teams v2 (CLUB SWEEP)');
  console.log(`  tenant:   ${TENANT}`);
  console.log(`  players:  ${PLAYERS.length}`);
  console.log(`  fixtures: ${DO_FIXTURES ? 'yes (one discoverTeamFixture call per returned team)' : 'no (--no-fixtures)'}`);
  console.log(`  clubs:    ${DO_CLUBS ? 'yes (one discoverCompetitions call per organisation seen)' : 'no (--no-clubs)'}`);
  console.log(`  delay:    ${DELAY_MS} ms between calls`);
  console.log('═'.repeat(78));

  for (const p of PLAYERS) {
    if (p.length !== 36) {
      console.log(`\n⚠ ${p} is ${p.length} characters, not 36. publicProfileTeams needs the FULL api-namespace uuid — the one in the StatTrack player URL. A truncated or spectator id returns NOT_FOUND, which this probe will report as NOT_FOUND and never as "no teams".`);
    }
  }

  const unanswered = [];
  const evidence   = [];   // registrations with games scheduled and none played
  // For the club sweep: which seasons each player's profile lists, and which clubs
  // they are registered at. Both are built ONLY from answered calls — a player whose
  // profile could not be read contributes nothing and is never treated as "no seasons".
  const profileSeasons = new Map();   // uuid -> Set(seasonId)
  const clubs          = new Map();   // orgId -> { name, players:Set(uuid) }

  for (let i = 0; i < PLAYERS.length; i++) {
    const uuid = PLAYERS[i];
    console.log(`\n${'─'.repeat(78)}\nPLAYER ${i + 1}/${PLAYERS.length}  ${uuid}\n${'─'.repeat(78)}`);

    const r = await probeTeams(uuid);
    await sleep(DELAY_MS);

    if (r.kind !== 'ok') {
      const why = r.detail || r.err?.message || '';
      console.log(`  ✖ NOT ANSWERED — ${r.kind}${why ? `: ${why}` : ''}`);
      if (r.kind === 'notfound') console.log('    NOT_FOUND means the id did not resolve on this tenant. It does NOT mean the player has no teams.');
      unanswered.push({ uuid, kind: r.kind, why });
      if (r.kind === 'no-session') break;   // the source is dead for this run
      continue;
    }

    console.log(`  publicProfileTeams returned ${r.teams.length} registration(s).`);
    console.log('\n  ── RAW publicProfileTeams payload (unmerged, untouched) ──');
    console.log(JSON.stringify(r.raw, null, 2).split('\n').map(l => `  ${l}`).join('\n'));

    if (!r.teams.length) {
      console.log('\n  (An empty array with no GraphQL error is a real answer: PlayHQ holds no registrations for this profile.)');
      continue;
    }

    profileSeasons.set(uuid, new Set());

    for (const t of r.teams) {
      const s = t.season || {};
      if (s.id) profileSeasons.get(uuid).add(s.id);
      // The club the TEAM belongs to, which is the one that runs the registration.
      // The competition's organisation is the association (EDJBA and the like) and
      // is collected too — a new season is created by the association, not the club.
      for (const o of [t.organisation, s.competition?.organisation]) {
        if (!o?.id) continue;
        if (!clubs.has(o.id)) clubs.set(o.id, { name: o.name || '', players: new Set() });
        clubs.get(o.id).players.add(uuid);
      }
      console.log(`\n  ── registration ──`);
      console.log(`     team:        ${t.id}  ${t.name || ''}`);
      console.log(`     club:        ${t.organisation?.id || '—'}  ${t.organisation?.name || ''}`);
      console.log(`     grade:       ${t.grade ? `${t.grade.id}  ${t.grade.name || ''}` : 'NULL  (publicProfileTeams returns grade=NULL for COMPLETED seasons)'}`);
      console.log(`     season:      ${s.id || '—'}  ${s.name || ''}`);
      console.log(`     season stat: ${s.status?.value || '—'}  (${s.status?.name || ''})`);
      console.log(`     startDate:   ${s.startDate || 'NULL'}`);
      console.log(`     endDate:     ${s.endDate || 'NULL  ← no endDate; must not be read as "ended"'}`);
      console.log(`     competition: ${s.competition?.id || '—'}  ${s.competition?.name || ''}  /  ${s.competition?.organisation?.name || ''}`);

      if (!DO_FIXTURES) continue;

      const f = await teamFixture(t.id);
      await sleep(DELAY_MS);

      if (f.kind !== 'ok') {
        const why = f.detail || f.err?.message || '';
        console.log(`     fixture:     ✖ NOT ANSWERED — ${f.kind}${why ? `: ${why}` : ''}`);
        unanswered.push({ uuid, team: t.id, kind: f.kind, why });
        if (f.kind === 'no-session') break;
        continue;
      }

      const sum = summariseRounds(f.rounds);
      console.log(`     fixture:     ${sum.rounds} round(s), ${sum.games} game(s) — FINAL ${sum.final}, with a score ${sum.scored}, not yet terminal ${sum.upcoming}, finals rounds ${sum.finalsRounds}`);
      console.log(`     statuses:    ${Object.keys(sum.byStatus).length ? Object.entries(sum.byStatus).map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`);
      console.log(`     dates:       ${sum.firstDate || '—'} → ${sum.lastDate || '—'}`);
      console.log(`     grades seen on this team's rounds: ${sum.gradeIds.length ? sum.gradeIds.join(' ; ') : '(none)'}${sum.gradeIds.length > 1 ? '   ← MORE THAN ONE GRADE: this team has been regraded. Identity is (tid, gid), never tid.' : ''}`);

      if (sum.games > 0 && sum.final === 0 && sum.scored === 0) {
        console.log('     ★ THIS REGISTRATION IS VISIBLE WITH ZERO GAMES PLAYED.');
        evidence.push({ uuid, team: t.id, teamName: t.name, season: s.name, seasonStatus: s.status?.value, games: sum.games, first: sum.firstDate });
      } else if (sum.games === 0) {
        console.log('     ◦ Registration present but the team has NO fixture yet — also registration-time visibility, with nothing to diff against yet.');
        evidence.push({ uuid, team: t.id, teamName: t.name, season: s.name, seasonStatus: s.status?.value, games: 0, first: null });
      }
    }
  }

  // ─── Club sweep ────────────────────────────────────────────────────────────
  // What seasons do these clubs and associations actually have, and which of them
  // are missing from the players' profiles?
  const missingFromProfiles = [];   // seasons a club holds that no probed profile lists
  const futureSeasons       = [];   // seasons at UPCOMING, or starting after today
  // ⚠️ A CLUB THAT COULD NOT BE ASKED IS NOT A CLUB WITH NO SEASONS. Without this
  // counter the "no future season exists" verdict prints after a run in which every
  // discoverCompetitions call was refused — a failure to ask recorded as an answer,
  // which is the fault class this project has been bitten by four times.
  let clubsAsked = 0, clubsUnanswered = 0;

  if (DO_CLUBS && clubs.size && !sessionDead) {
    console.log(`\n${'═'.repeat(78)}`);
    console.log(`CLUB SWEEP — discoverCompetitions on ${clubs.size} organisation(s)`);
    console.log('═'.repeat(78));

    const today = new Date().toISOString().slice(0, 10);

    for (const [orgId, club] of clubs) {
      console.log(`\n  ── ${orgId}  ${club.name} ──`);
      const c = await orgCompetitions(orgId);
      await sleep(DELAY_MS);

      if (c.kind !== 'ok') {
        const why = c.detail || c.err?.message || '';
        console.log(`     ✖ NOT ANSWERED — ${c.kind}${why ? `: ${why}` : ''}`);
        unanswered.push({ uuid: `org ${orgId}`, kind: c.kind, why });
        clubsUnanswered++;
        if (c.kind === 'no-session') { clubsUnanswered += clubs.size - clubsAsked - clubsUnanswered; break; }
        continue;
      }
      clubsAsked++;

      if (!c.comps.length) { console.log('     (no competitions returned — a real answer, not a failure)'); continue; }

      for (const comp of c.comps) {
        console.log(`     competition ${comp.id}  ${comp.name || ''}`);
        const seasons = Array.isArray(comp.seasons) ? comp.seasons : [];
        if (!seasons.length) { console.log('       (no seasons)'); continue; }
        // Newest first, by startDate — a missing startDate sorts last rather than
        // being dropped, because absence is not a date.
        const sorted = [...seasons].sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
        for (const s of sorted) {
          const st = s.status?.value || '—';
          const starts = s.startDate || null;
          const isFuture = st === 'UPCOMING' || (starts && starts > today);
          const listedBy = [...club.players].filter(u => profileSeasons.get(u)?.has(s.id));
          const probedHere = [...club.players].filter(u => profileSeasons.has(u));
          const mark = isFuture ? '★ FUTURE' : '        ';
          console.log(`       ${mark} ${s.id}  ${s.name || ''}  [${st}]  ${starts || 'no startDate'} → ${s.endDate || 'NO endDate'}`);
          console.log(`                 on profile of: ${listedBy.length ? listedBy.join(', ') : 'NONE of the probed players'}`);
          if (isFuture) {
            futureSeasons.push({ orgId, orgName: club.name, comp: comp.name, season: s, listedBy, probedHere });
            if (!listedBy.length) missingFromProfiles.push({ orgId, orgName: club.name, comp: comp.name, season: s, probedHere });
          }
        }
      }
    }
  } else if (DO_CLUBS && !clubs.size) {
    console.log('\n  (Club sweep skipped — no organisation ids came back from any profile.)');
  }

  // ─── Verdict ───────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(78)}`);
  console.log('VERDICT');
  console.log('═'.repeat(78));

  if (evidence.length) {
    console.log(`\n  publicProfileTeams listed ${evidence.length} registration(s) for a team with NO game played yet:\n`);
    for (const e of evidence) {
      console.log(`    ${e.uuid}  →  ${e.team} ${e.teamName || ''}  |  ${e.season || ''} [${e.seasonStatus || '—'}]  |  ${e.games} scheduled game(s)${e.first ? `, first ${e.first}` : ', no fixture yet'}`);
    }
    console.log('\n  → A registration is visible BEFORE the first game. Following by PLAYER is sufficient;');
    console.log('    pinned team ids stay as a fallback rather than a requirement.');
  } else {
    console.log('\n  No registration was seen for a team with zero games played.');
    console.log('  That alone is NOT proof of the opposite: it only proves that none of the players');
    console.log('  probed had an unplayed registration at this moment. See the club sweep below.');
  }

  // ─── What the club sweep settles ───────────────────────────────────────────
  if (DO_CLUBS) {
    console.log('\n  ── club sweep ──');
    if (!futureSeasons.length && clubsUnanswered) {
      console.log(`\n  ✖ NO CONCLUSION. ${clubsUnanswered} of ${clubsAsked + clubsUnanswered} organisation(s) could not be asked,`);
      console.log('  and the ones that answered held no future season. "Not asked" is not "nothing');
      console.log('  there", so this run says nothing about whether a next season exists. Fix the');
      console.log('  cause listed above and run it again.');
    } else if (!futureSeasons.length) {
      console.log(`\n  All ${clubsAsked} organisation(s) answered. None returned a season at status UPCOMING or with a future`);
      console.log('  startDate. So PlayHQ itself is not holding a next season yet, which matches');
      console.log('  Mark\'s reading that there are none to look at. The question CANNOT be settled');
      console.log('  today by any route — there is nothing in existence to test against. Re-run this');
      console.log('  probe when a club publishes a new season; it will answer on that run.');
      console.log('\n  → Build the watcher so it does not depend on the answer: follow by player, accept');
      console.log('    pinned team ids as a first-class input rather than a fallback, and watch the');
      console.log('    clubs themselves with this same discoverCompetitions call so a new season is');
      console.log('    seen when the ASSOCIATION creates it rather than when a profile catches up.');
    } else {
      console.log(`\n  ${futureSeasons.length} season(s) at UPCOMING or with a future startDate exist at these clubs:\n`);
      for (const f of futureSeasons) {
        console.log(`    ${f.season.id}  ${f.season.name || ''}  [${f.season.status?.value || '—'}]  starts ${f.season.startDate || '—'}`);
        console.log(`      ${f.orgName} / ${f.comp || ''}`);
        console.log(`      listed on profile of: ${f.listedBy.length ? f.listedBy.join(', ') : 'NONE'}`);
      }
      if (missingFromProfiles.length) {
        console.log('\n  ⚠ READ THIS — IT IS THE ANSWER, BUT ONLY YOU CAN FINISH IT.');
        console.log('    The season(s) above marked "listed on profile of: NONE" exist at the club and');
        console.log('    do NOT appear on any probed player\'s publicProfileTeams.');
        console.log('    If a probed player IS already registered for one of them, then a registration');
        console.log('    is NOT visible before the first game: following by player would find the');
        console.log('    fixture only after round 1, and PINNED TEAM IDS ARE ESSENTIAL.');
        console.log('    If none of them is registered yet, this proves nothing either way — the');
        console.log('    profile is correct to omit a registration that does not exist.');
        console.log('    This script cannot know which. You can.');
      } else {
        console.log('\n  Every future season at these clubs is already listed on a probed player\'s profile.');
        console.log('  → A registration is visible before the season starts. Following by PLAYER is');
        console.log('    sufficient; pinned team ids stay as a fallback rather than a requirement.');
      }
    }
  }

  if (unanswered.length) {
    console.log(`\n  ⚠ ${unanswered.length} call(s) were NOT answered and are NOT part of the verdict:`);
    for (const u of unanswered) console.log(`    ${u.uuid}${u.team ? ` / team ${u.team}` : ''}  ${u.kind}${u.why ? `: ${u.why}` : ''}`);
  }

  console.log(`\n  session: ${JSON.stringify(sessionGuard.stats())}`);
  console.log(`  elapsed: ${Math.round((Date.now() - started) / 1000)}s`);

  if (unanswered.length) {
    console.error('\nFAILED: at least one call was not answered. A failure to ask is not an answer — fix the cause and re-run before drawing any conclusion.');
    process.exit(1);
  }
  console.log('\nDone.');
})().catch(err => {
  console.error(`\nFATAL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
