// scripts/lib/netball-connect.cjs
//
// NETBALL CONNECT (Squadi) API CLIENT. A THIRD SOURCE, NOT A THIRD PLAYHQ TENANT.
//
// Unrelated API, unrelated auth, unrelated failure modes. It shares no session, no
// headers and no code with the PlayHQ side, which is the cheapest guarantee that it
// cannot break the basketball and footy checks.
//
// Every request shape here is verified: §3/§4/§8 of the spec from Mark's workstation
// on 2026-11-28, and acceptance test 0 from a GitHub Actions runner on the same day
// (login 200, teams 2, registrations 4/4). The Playwright fallback in spec §11.4 is
// therefore NOT needed — the WAF serves the runner.
//
// ─── PRIVACY — THIS REPO AND ITS ACTIONS LOGS ARE PUBLIC ─────────────────────
// personaldetails returns a child's name, date of birth, address and parent contact
// details in the same document as the two fields we read. This module NEVER returns
// a raw body to its caller: each call returns a typed outcome carrying only the
// extracted fields. Nothing here logs an id, a name, a token, a header or a body.
//
// ─── CREDENTIAL SCOPE — SPEC §11.3 ───────────────────────────────────────────
// A personal username and password for an account holding children's personal
// details and saved payment methods. Not a scoped token, so the code scopes itself:
// ALLOWED_PATHS is exhaustive and refusal happens before the request is built. Read
// calls only — no profile edits, registrations, payments, de-registrations, consent
// or notification changes, logouts or password operations. One login per run, and
// 401 is never retried because a tight loop on a wrong password risks a lockout.

'use strict';

const API_HOST   = 'api-netball.squadi.com';
const ORIGIN     = 'https://registration.netballconnect.com';
const TIMEOUT_MS = 30000;
const RETRY_WAIT_MS = 30000;

// ⚠️ EXHAUSTIVE. The two POSTs are read queries — they return lists and change
// nothing. Adding to this set is a decision about what the credential may do.
const ALLOWED_PATHS = new Set([
  '/users/users/loginWithEmailPassword',
  '/users/api/user/personaldetails',
  '/users/api/user/registration',
  '/users/api/user/teams',
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function createClient(o) {
  const email    = o.email;
  const password = o.password;
  const log      = o.log || (() => {});
  let authToken  = null;

  async function ncFetch(url, init) {
    const u = new URL(url);
    if (u.hostname !== API_HOST)        throw new Error('refused: host is not the Netball Connect API');
    if (!ALLOWED_PATHS.has(u.pathname)) throw new Error('refused: path not in the allow-list');
    return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  // Spec §3: 5xx / timeout / DNS retried ONCE after 30s. 401 and 403 are never
  // retried — 401 risks a lockout, 403 is a WAF answer that will not change.
  async function once(label, fn) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res;
      try {
        res = await fn();
      } catch (err) {
        const why = err && err.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000}s`
                  : (err && err.message) ? err.message : 'network error';
        if (attempt === 2) return { kind: 'error', reason: `${label}: ${why}` };
        log(`  (${label}: ${why} — retrying once in ${RETRY_WAIT_MS / 1000}s)`);
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      if (res.status >= 500 && attempt === 1) {
        log(`  (${label}: HTTP ${res.status} — retrying once in ${RETRY_WAIT_MS / 1000}s)`);
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      return { kind: 'res', res };
    }
    return { kind: 'error', reason: `${label}: unreachable` };
  }

  // A body is parsed, never returned and never logged.
  async function body(res, label) {
    let text = '';
    try { text = await res.text(); } catch (_) { return { kind: 'error', reason: `${label}: response could not be read` }; }
    try { return { kind: 'ok', json: JSON.parse(text) }; }
    catch (_) { return { kind: 'error', reason: `${label}: HTTP ${res.status} - body is not JSON (WAF page?)` }; }
  }

  const authed = () => ({ 'authorization': authToken, 'Origin': ORIGIN });

  // ─── §3 · login ────────────────────────────────────────────────────────────
  // GET, no body, credentials Base64'd behind the literal scheme "BWSA". Unusual,
  // and it is exactly what the site does.
  async function login() {
    const basic = Buffer.from(`${email}:${password}`, 'utf8').toString('base64');
    const r = await once('login', () => ncFetch(
      `https://${API_HOST}/users/users/loginWithEmailPassword`,
      { method: 'GET', headers: { 'authorization': `BWSA ${basic}`, 'Origin': ORIGIN, 'Accept': 'application/json' } },
    ));
    if (r.kind === 'error') return r;
    const { res } = r;
    if (res.status === 401) return { kind: 'error', reason: 'login: rejected (wrong email/password?)' };
    if (res.status === 403) return { kind: 'error', reason: 'login: blocked (WAF)' };
    if (res.status !== 200) return { kind: 'error', reason: `login: HTTP ${res.status}` };

    const b = await body(res, 'login');
    if (b.kind !== 'ok') return b;
    const tok = b.json && b.json.authToken;
    if (typeof tok !== 'string' || !tok) return { kind: 'error', reason: 'login: no authToken' };

    authToken = tok;
    // ⚠️ Derived at run time, so GitHub's secret masking does not cover it.
    // Emitted before the token can reach the log by any other route.
    if (process.env.GITHUB_ACTIONS) process.stdout.write(`::add-mask::${tok}\n`);
    return { kind: 'ok' };
  }

  // ─── §4 · personaldetails — THE team source ────────────────────────────────
  // Returns ONLY the team rows. The rest of the document is the child's personal
  // details and is not read into anything that leaves this function.
  async function teams(alias, userId) {
    const r = await once(`fetch ${alias}`, () => ncFetch(
      // Query string exactly as the site sends it, empty parameters included.
      `https://${API_HOST}/users/api/user/personaldetails?userId=${encodeURIComponent(userId)}&refereeMobileNumber=&organisationId=`,
      { method: 'GET', headers: { ...authed(), 'Accept': 'application/json' } },
    ));
    if (r.kind === 'error') return r;
    const { res } = r;
    if (res.status === 403) return { kind: 'error', reason: `fetch ${alias}: blocked (WAF)` };
    if (res.status !== 200) return { kind: 'error', reason: `fetch ${alias}: HTTP ${res.status}` };

    const b = await body(res, `fetch ${alias}`);
    if (b.kind !== 'ok') return b;
    if (!b.json || !Array.isArray(b.json.competitions)) {
      return { kind: 'error', reason: `fetch ${alias}: 'competitions' missing - format changed` };
    }

    // ⚠️ KEY ON teamId ALONE. Teams are not reliably filed under the right
    // competition — the 2026 Spring team sits under the Autumn competition — so
    // competitionName is display text and nothing is joined on it. divisions[] does
    // not map to teams[] either. Old seasons stay in the list; it grows, never resets.
    const rows = [];
    const seen = new Set();
    for (const comp of b.json.competitions) {
      const list = (comp && Array.isArray(comp.teams)) ? comp.teams : [];   // missing/null = zero teams, not an error
      for (const t of list) {
        // teamId is a STRING, compTeamId is the same value as a NUMBER.
        const id = (t && t.teamId != null) ? String(t.teamId).trim() : '';
        if (!id) return { kind: 'error', reason: `fetch ${alias}: team without teamId - format changed` };
        if (seen.has(id)) continue;                 // same teamId twice: keep the first
        seen.add(id);
        rows.push({
          teamId: id,
          teamName: String((t && t.teamName) || '').trim(),
          competitionName: String((comp && comp.competitionName) || '').trim(),
          roles: (Array.isArray(t.userTeamRoles) ? t.userTeamRoles : [])
            .map(r2 => String((r2 && r2.roleName) || '').trim()).filter(Boolean).join(', '),
        });
      }
    }
    return { kind: 'ok', rows };
  }

  // ─── §8 · registrations ────────────────────────────────────────────────────
  // Registration usually happens BEFORE team allocation, so a new registration is
  // the first sign of a new season.
  const regBody = (userId, offset, limit) => ({
    competitionId: '-1',            // STRING
    userId,                         // NUMBER
    organisationId: null,
    yearRefId: -1,                  // NUMBER
    isAdmin: false,
    dataType: null,
    myRegPaging:        { limit, offset },
    otherRegPaging:     { limit: 10, offset: 0 },
    childRegPaging:     { limit: 10, offset: 0 },
    teamRegPaging:      { limit: 10, offset: 0 },
    pastTeamRegPaging:  { limit: 10, offset: 0 },
    adminTeamRegPaging: { limit: 10, offset: 0 },
  });

  async function registrations(alias, userId, limit) {
    const LIMIT = Number.isFinite(limit) && limit > 0 ? limit : 10;
    const rows = new Map();          // registrationId -> row
    let totalCount = null;

    // ⚠️ DO NOT TRUST nextPage. It returned 10 against a totalCount of 4. The loop
    // is driven by totalCount.
    //
    // ⚠️ THREE INDEPENDENT STOPS, because "keep asking until you have totalCount"
    // is a loop a misbehaving server controls. Found by the harness on 2026-11-28:
    // a page that returns the SAME rows every time satisfies "got > 0" and never
    // reaches totalCount, and the pass hangs until the job timeout. A hang is the
    // worst failure mode here — it takes the PlayHQ checks down with it, which is
    // precisely what this source is built not to do.
    //   1. a page with no rows at all;
    //   2. a page that adds no NEW registrationId;
    //   3. a hard cap on pages.
    // Any of them leaving the collection short falls through to the incomplete
    // check below, which is an ERROR and never a list of removals.
    const MAX_PAGES = 50;
    for (let offset = 0, page = 0; page < MAX_PAGES; offset += LIMIT, page++) {
      const r = await once('registrations', () => ncFetch(
        `https://${API_HOST}/users/api/user/registration`,
        {
          method: 'POST',
          headers: { ...authed(), 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
          body: JSON.stringify(regBody(userId, offset, LIMIT)),
        },
      ));
      if (r.kind === 'error') return r;
      const { res } = r;
      if (res.status === 403) return { kind: 'error', reason: 'registrations: blocked (WAF)' };
      if (res.status !== 200) return { kind: 'error', reason: `registrations: HTTP ${res.status}` };

      const b = await body(res, 'registrations');
      if (b.kind !== 'ok') return b;
      const my = b.json && b.json.myRegistrations;
      if (!my || !my.page || typeof my.page.totalCount !== 'number') {
        return { kind: 'error', reason: 'registrations: page.totalCount missing - format changed' };
      }
      if (!Array.isArray(my.registrationDetails)) {
        return { kind: 'error', reason: 'registrations: registrationDetails missing - format changed' };
      }
      if (totalCount === null) totalCount = my.page.totalCount;

      const before = rows.size;
      let got = 0;
      for (const row of my.registrationDetails) {
        const id = (row && row.registrationId) ? String(row.registrationId).trim() : '';
        if (!id) return { kind: 'error', reason: 'registrations: row without registrationId - format changed' };
        got++;
        if (!rows.has(id)) rows.set(id, row);
      }
      if (got === 0) break;                 // nothing on the page
      if (rows.size === before) break;      // rows, but none of them new — the server is repeating itself
      if (rows.size >= totalCount) break;   // we have what it said there was
    }

    // ⚠️ AN INCOMPLETE COLLECTION IS AN ERROR, NOT A SHORT LIST. Diffing a short
    // list against state would report every missing registration as REMOVED.
    if (rows.size !== totalCount) {
      return { kind: 'error', reason: `registrations: got ${rows.size} of ${totalCount} - incomplete` };
    }
    return { kind: 'ok', rows: [...rows.values()], totalCount };
  }

  // ─── §4.1 · the Teams-tab endpoint — NOT the source, optional canary ───────
  // Returns totalCount 0 for Penny despite two allocations, which is why the
  // website's Teams tab says "No data". Watched only so we learn if it ever starts
  // working. An HTTP error here is logged as a status and never alerts.
  async function teamsTab(alias, userId) {
    let res;
    try {
      res = await ncFetch(`https://${API_HOST}/users/api/user/teams`, {
        method: 'POST',
        headers: { ...authed(), 'Content-Type': 'application/json', 'sourcesystem': 'WebRegistration' },
        body: JSON.stringify({ userId, limit: 10, offset: 0 }),
      });
    } catch (_) { return { kind: 'skip' }; }
    if (res.status !== 200) { log(`  nc[${alias}]: teams-tab HTTP ${res.status}`); return { kind: 'skip' }; }
    const b = await body(res, 'teams-tab');
    if (b.kind !== 'ok') return { kind: 'skip' };
    const n = b.json && b.json.page && b.json.page.totalCount;
    return { kind: 'ok', totalCount: typeof n === 'number' ? n : 0 };
  }

  return { login, teams, registrations, teamsTab };
}

module.exports = { createClient, ALLOWED_PATHS, API_HOST, ORIGIN };
