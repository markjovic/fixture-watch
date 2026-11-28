// scripts/nc-probe-reachability.js
//
// NETBALL CONNECT — ACCEPTANCE TEST 0: RUNNER REACHABILITY.
//
// The ONE question this answers: will Squadi's WAF serve a GitHub Actions runner?
// Every call in this file has been verified from Mark's workstation with PowerShell
// 5.1 on 2026-11-28. NONE of it has been verified from a cloud IP, and Squadi is
// known to 403 non-browser calls to its public livescores API from cloud IPs.
//
// ⚠️ NOTHING ELSE IS BUILT UNTIL THIS PASSES. If login or either fetch returns 403,
// the whole source moves to the Playwright-in-headless-Chromium fallback (spec
// §11.4) and the client is written differently. Building the real client first and
// discovering this second would throw that work away.
//
// EXPECTED OUTPUT, and the only output:
//   login: HTTP 200
//   teams: 2
//   registrations: 4/4
//
// ─── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
// No state, no diffing, no Pushover, no paging, no Teams-tab canary. It does not
// read, import or touch watch.json or fixture-watch.js. Netball Connect is a
// SEPARATE SOURCE with its own API and its own login — it must not be able to
// break the PlayHQ checks, and the cheapest guarantee of that is that this file
// shares nothing with them.
//
// ─── PRIVACY — THIS REPO IS PUBLIC AND SO ARE ITS ACTIONS LOGS ───────────────
// Spec §11.1. The three lines above are the whole of the output, plus error
// reasons. NEVER printed, and never read into a variable that is printed: the
// password, the `BWSA ...` header (reversible to the password), the authToken, any
// userId / registrationId / teamId / participantId, any name, any date of birth,
// any response body. personaldetails returns a child's address and parent contact
// details in the same document as the two fields we count — the response is
// inspected field by field and never dumped.
//
// ─── CREDENTIAL SCOPE — SPEC §11.3 ───────────────────────────────────────────
// This is a personal username and password for an account holding children's
// personal details and saved payment methods, not a scoped token. The code scopes
// itself: ALLOWED_PATHS below is exhaustive and ncFetch refuses anything else, so a
// future edit cannot quietly reach a write endpoint. Read calls only. One login per
// run. No retry on 401 — a tight loop on a wrong password risks a lockout.

'use strict';

const API_HOST = 'api-netball.squadi.com';
const ORIGIN   = 'https://registration.netballconnect.com';
const TIMEOUT_MS = 30000;

// ⚠️ EXHAUSTIVE. Spec §11.3. The two POSTs are read queries — they return lists and
// change nothing. Any path not in this set is refused before the request is made.
const ALLOWED_PATHS = new Set([
  '/users/users/loginWithEmailPassword',
  '/users/api/user/personaldetails',
  '/users/api/user/registration',
  '/users/api/user/teams',
]);

// ─── Output ──────────────────────────────────────────────────────────────────
// Everything this process says goes through here, so there is one place to audit
// against spec §11.1.
const say  = (line) => process.stdout.write(`${line}\n`);
const fail = (reason) => { say(`ERROR ${reason}`); process.exit(1); };

// ─── The only way this file reaches the network ──────────────────────────────
async function ncFetch(url, init) {
  const u = new URL(url);
  if (u.hostname !== API_HOST) throw new Error(`refused: host ${u.hostname} is not ${API_HOST}`);
  if (!ALLOWED_PATHS.has(u.pathname)) throw new Error(`refused: path not in the allow-list`);
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// Spec §3: 5xx / timeout / DNS retried ONCE after 30s. 401 and 403 are NOT retried
// — 401 risks a lockout and 403 is the answer this probe exists to get.
async function withOneRetry(label, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fn();
    } catch (err) {
      const why = err && err.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000}s`
                : (err && err.message) ? err.message : String(err);
      if (attempt === 2) fail(`${label}: ${why}`);
      say(`  (${label}: ${why} — retrying once in 30s)`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    if (res.status >= 500 && attempt === 1) {
      say(`  (${label}: HTTP ${res.status} — retrying once in 30s)`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    return res;
  }
  fail(`${label}: unreachable`);
}

// A body is parsed, never printed. On unparseable JSON we report the status only.
async function asJson(res, label) {
  let text = '';
  try { text = await res.text(); } catch (_) { fail(`${label}: response could not be read`); }
  try { return JSON.parse(text); } catch (_) { fail(`${label}: HTTP ${res.status} - body is not JSON (WAF page?)`); }
}

(async () => {
  // ── Secrets ────────────────────────────────────────────────────────────────
  const email = process.env.NC_EMAIL || '';
  const pw    = process.env.NC_PASSWORD || '';
  const rawPlayers = process.env.NC_PLAYERS || '';
  if (!email || !pw)   fail('config: NC_EMAIL or NC_PASSWORD is not set');
  if (!rawPlayers)     fail('config: NC_PLAYERS is not set');

  let players;
  try { players = JSON.parse(rawPlayers); }
  catch (_) { fail('config: NC_PLAYERS is not valid JSON'); }
  if (!Array.isArray(players) || !players.length) fail('config: NC_PLAYERS is not a non-empty array');
  for (const p of players) {
    if (!p || !p.alias || !(typeof p.userId === 'number')) fail('config: every NC_PLAYERS entry needs an alias and a numeric userId');
  }
  // alias is the ONLY player identifier that may appear in a log (spec §2).
  const tag = players.length > 1 ? (p) => `[${p.alias}] ` : () => '';

  // ── Step 1 · login (spec §3) ───────────────────────────────────────────────
  // GET with no body, and the credentials Base64'd into an Authorization header
  // behind the literal scheme "BWSA". Unusual, and it is what the site does.
  const basic = Buffer.from(`${email}:${pw}`, 'utf8').toString('base64');
  const loginRes = await withOneRetry('login', () => ncFetch(
    `https://${API_HOST}/users/users/loginWithEmailPassword`,
    { method: 'GET', headers: { 'authorization': `BWSA ${basic}`, 'Origin': ORIGIN, 'Accept': 'application/json' } },
  ));

  say(`login: HTTP ${loginRes.status}`);
  if (loginRes.status === 401) fail('login: rejected (wrong email/password?)');
  if (loginRes.status === 403) fail('login: blocked (WAF) - use the spec §11.4 Playwright fallback');
  if (loginRes.status !== 200) fail(`login: HTTP ${loginRes.status}`);

  const loginBody = await asJson(loginRes, 'login');
  const authToken = loginBody && loginBody.authToken;
  if (typeof authToken !== 'string' || !authToken) fail('login: no authToken');

  // ⚠️ The token is derived at run time, so GitHub's secret masking does NOT cover
  // it. Mask before it can reach the log by any route (spec §3).
  say(`::add-mask::${authToken}`);

  const authed = { 'authorization': authToken, 'Origin': ORIGIN };

  for (const p of players) {
    // ── Step 2 · personaldetails — the team source (spec §4) ─────────────────
    // The query string is sent exactly as the site sends it, empty parameters and
    // all. Only `competitions[].teams[].teamId` is read out of a document that is
    // otherwise full of a child's personal details.
    const pdRes = await withOneRetry(`fetch ${p.alias}`, () => ncFetch(
      `https://${API_HOST}/users/api/user/personaldetails?userId=${encodeURIComponent(p.userId)}&refereeMobileNumber=&organisationId=`,
      { method: 'GET', headers: { ...authed, 'Accept': 'application/json' } },
    ));
    if (pdRes.status === 403) fail(`fetch ${p.alias}: blocked (WAF) - use the spec §11.4 Playwright fallback`);
    if (pdRes.status !== 200) fail(`fetch ${p.alias}: HTTP ${pdRes.status}`);

    const pd = await asJson(pdRes, `fetch ${p.alias}`);
    if (!pd || !Array.isArray(pd.competitions)) fail(`fetch ${p.alias}: 'competitions' missing - format changed`);

    // teamId is a STRING here and a NUMBER as compTeamId. Normalise, and count
    // unique ids — the same team can appear twice, and teams are not reliably
    // filed under the right competition (spec §4 quirks).
    const teamIds = new Set();
    for (const comp of pd.competitions) {
      const teams = (comp && Array.isArray(comp.teams)) ? comp.teams : [];   // missing/null = zero teams, not an error
      for (const t of teams) {
        const id = t && t.teamId != null ? String(t.teamId).trim() : '';
        if (!id) fail(`fetch ${p.alias}: team without teamId - format changed`);
        teamIds.add(id);
      }
    }
    say(`${tag(p)}teams: ${teamIds.size}`);

    // ── Step 3 · registrations (spec §8) ─────────────────────────────────────
    // ONE page only. This probe is about reachability, not completeness — the
    // paging rule in §8.2 (never trust nextPage; loop on totalCount) belongs to the
    // real client. With limit 10 against an expected totalCount of 4, one request
    // returns everything, so count/totalCount is still the honest check.
    const body = {
      competitionId: '-1', userId: p.userId, organisationId: null, yearRefId: -1,
      isAdmin: false, dataType: null,
      myRegPaging:        { limit: 10, offset: 0 },
      otherRegPaging:     { limit: 10, offset: 0 },
      childRegPaging:     { limit: 10, offset: 0 },
      teamRegPaging:      { limit: 10, offset: 0 },
      pastTeamRegPaging:  { limit: 10, offset: 0 },
      adminTeamRegPaging: { limit: 10, offset: 0 },
    };
    const regRes = await withOneRetry('registrations', () => ncFetch(
      `https://${API_HOST}/users/api/user/registration`,
      {
        method: 'POST',
        headers: { ...authed, 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
        body: JSON.stringify(body),
      },
    ));
    if (regRes.status === 403) fail('registrations: blocked (WAF) - use the spec §11.4 Playwright fallback');
    if (regRes.status !== 200) fail(`registrations: HTTP ${regRes.status}`);

    const reg = await asJson(regRes, 'registrations');
    const my  = reg && reg.myRegistrations;
    if (!my || !my.page || typeof my.page.totalCount !== 'number') fail('registrations: page.totalCount missing - format changed');
    if (!Array.isArray(my.registrationDetails)) fail('registrations: registrationDetails missing - format changed');

    const regIds = new Set();
    for (const row of my.registrationDetails) {
      const id = row && row.registrationId ? String(row.registrationId).trim() : '';
      if (!id) fail('registrations: row without registrationId - format changed');
      regIds.add(id);
    }
    say(`${tag(p)}registrations: ${regIds.size}/${my.page.totalCount}`);
  }
})().catch(err => {
  // A thrown error must not carry a body, a header or an id into the log.
  fail(`unexpected: ${err && err.message ? err.message : 'see the step above'}`);
});
