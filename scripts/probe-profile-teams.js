// scripts/probe-profile-teams.js
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
//   One `publicProfileTeams` call per player. Then, for each team that comes back,
//   one `discoverTeamFixture` call to count how many of that team's games have
//   actually been played. A registration whose team has games scheduled and ZERO
//   played is the proof that registration-time visibility exists.
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
//        [--tenant=basketball-victoria] [--no-fixtures] [--delay=400]

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
  console.log('fixture-watch — probe-profile-teams');
  console.log(`  tenant:   ${TENANT}`);
  console.log(`  players:  ${PLAYERS.length}`);
  console.log(`  fixtures: ${DO_FIXTURES ? 'yes (one discoverTeamFixture call per returned team)' : 'no (--no-fixtures)'}`);
  console.log(`  delay:    ${DELAY_MS} ms between calls`);
  console.log('═'.repeat(78));

  for (const p of PLAYERS) {
    if (p.length !== 36) {
      console.log(`\n⚠ ${p} is ${p.length} characters, not 36. publicProfileTeams needs the FULL api-namespace uuid — the one in the StatTrack player URL. A truncated or spectator id returns NOT_FOUND, which this probe will report as NOT_FOUND and never as "no teams".`);
    }
  }

  const unanswered = [];
  const evidence   = [];   // registrations with games scheduled and none played

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

    for (const t of r.teams) {
      const s = t.season || {};
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
    console.log('  That is NOT yet proof of the opposite: it only proves that none of the players');
    console.log('  probed had an unplayed registration at this moment. Re-run with a player who is');
    console.log('  registered for an upcoming season and has not played a game in it. If such a');
    console.log('  player returns the registration, the answer is registration-time visibility;');
    console.log('  if their profile omits it, following by player cannot see a new season before');
    console.log('  round 1 and pinned team ids become essential.');
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
