// scripts/lib/team-links.cjs
//
// THE ALERT LINK, PER SPORT. One job: turn what the watcher already knows about a
// team into a URL that opens THAT TEAM, or return null.
//
// ─── THE RULE THAT OUTRANKS EVERY OTHER RULE HERE ────────────────────────────
// OMIT RATHER THAN APPROXIMATE.
//
// A missing link is honest. A wrong link is not. Every builder here returns null the
// moment any key it needs is unavailable. Nothing is guessed, nothing is defaulted,
// nothing is "near enough".
//
// ⚠️ THE DASHBOARD-SIDE HISTORY, BECAUSE IT EXPLAINS THE STRICTNESS.
// Before junior-footy-dashboard v1.08, `t` was the one URL key that failed SILENTLY
// in two different ways: a fresh page load dropped it and rendered the whole
// unfiltered age group — a link that opened, looked right and showed the wrong team —
// and a same-tab tap, the usual notification case, emptied the view to "0 matches".
// As of v1.08 (2026-11-24) both paths validate and say so out loud:
//   "Team Norwood Purple not found in U12 — showing all teams"
// Same for `r`. So a stale link now degrades LOUDLY rather than lying. It is still a
// stale link — the dashboard cannot resolve a team renamed since the alert was sent,
// and a rename is one of the things this watcher alerts about — so the rule does not
// relax. Emitting nothing is still better than emitting a guess.
//
// ─── BASKETBALL — StatTrack ──────────────────────────────────────────────────
// `#t=<teamId>&s=<seasonId>`. Both are ids the watcher holds directly, so there is
// nothing to derive and the link is either complete or absent.
//
// ─── FOOTY — junior-footy-dashboard ──────────────────────────────────────────
// `#y=<year>&c=<compShort>&a=<age>&t=<teamName>`
//
// ⚠️ THE FOOTY LINK IS KEYED ON NAMES, NOT IDS. The dashboard's client model holds
// no team ids at all — `S.selTeam` filters on `m.home === S.selTeam || m.away ===
// S.selTeam`. So three of the four keys are DERIVATIONS, and each one can fail:
//
//   y  season.name, and only when it is a bare 4-digit year. Anything else → null.
//   c  NOT a PlayHQ field. The dashboard's compShort comes from its OWN config.json
//      (`organisations[] { code, name }`), so the watcher carries an org-id → short
//      code map in watch.json. An org that is not in the map → null.
//   a  the age token from the GRADE name — NOT grades.json ageName, which returns
//      "U17" for a U17.5 competition. A girls grade is "U12 Girls". When the grade
//      is null — WHICH IS THE CASE FOR A BRAND NEW REGISTRATION, measured on
//      afbd05d3 2026-11-24 — fall back to the age token in the TEAM name, and when
//      there is none of those either → null.
//   t  the PlayHQ team name with the grade's OWN age token stripped, replicating
//      cleanTeam(name, gradeAge) from the footy repo's results-engine.js verbatim.
//      "Norwood U12 Purple" + U12 → "Norwood Purple". ⚠️ Only the matching age is
//      stripped: a "U17 Boys Red" team in a U17.5 grade keeps its U17, because the
//      dashboard stored it that way and the two must agree exactly.
//
// `g` (grade) is deliberately NOT emitted. A regrade would stale it and the team
// filter does not need it.
//
// Omitting the gender suffix where the grade name does not carry one is safe: a
// wrong `a` is reported by the dashboard, and since v1.08 so is a wrong `t`. `t` is
// never built without an age to strip in any case.
//
// ⚠️ AN ID-KEYED `t=<teamId>` FORMAT IS DESIGNED BUT DEFERRED (claude/team_deep_link.md).
// It would delete the cleanTeam replication below outright — fixture-watch already
// holds the team id, and the dashboard's fixture query already fetches and discards
// home/away ids, so the API cost is zero. It cannot be verified until the 2027 season
// starts populating those ids. THAT IS WHY THIS IS ONE ISOLATED MODULE: the swap in
// January must be a change to footyDashboardUrl() and nothing else. Do not change the
// output now.

'use strict';

// ─── Age ─────────────────────────────────────────────────────────────────────
// The dashboard's parseGradeName() cannot be ported: with no ageName (and the
// watcher's profile query returns none) its `!ageName` branch takes the Senior/Open
// path and answers "U12 B" for grade "U12 - B" — a string that matches no age group
// on the dashboard. What IS portable is the junior branch's own behaviour: the age
// token out of the name, plus the gender suffix when the gender is not one of
// Men/Mixed/Boys. That is what this reproduces, from the name alone.
function ageToken(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const n = raw.replace(/^\*\s*/, '').replace(/\s+-\s+/g, ' ').trim();
  const m = n.match(/\bU(\d+(?:\.\d+)?)\b/i);
  if (!m) return null;
  let age = 'U' + m[1];
  if (/\bGirls\b/i.test(n))      age += ' Girls';
  else if (/\bWomen\b/i.test(n)) age += ' Women';
  return age;
}

const ageFromGradeName = (gradeName) => ageToken(gradeName);
const ageFromTeamName  = (teamName)  => ageToken(teamName);

// ─── cleanTeam — REPLICATED FROM THE FOOTY REPO, NOT REINVENTED ──────────────
// results-engine.js cleanTeam(name, gradeAge). The dashboard stores team names
// through this function, so the watcher must produce byte-identical output or the
// `t` key silently matches nothing.
//
// The no-gradeAge branch there strips NOTHING (v20, 2026-08-19 — stripping any
// U-number produced four duplicate records). Here the equivalent is stronger: no
// age means no link at all, because `a` is unavailable too.
function cleanTeam(name, gradeAge) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const ageNum = String(gradeAge || '').match(/^(U\d+(?:\.\d+)?)/i);
  if (!ageNum) return null;
  const token = ageNum[1].replace('.', '\\.');
  const out = raw.replace(new RegExp('\\s+' + token + '\\b\\s*', 'gi'), ' ')
                 .replace(/\s+$/, '')
                 .trim();
  return out || null;
}

// ─── org id → the dashboard's short code ─────────────────────────────────────
// The footy repo's config.json keys organisations by an EIGHT-CHARACTER prefix of
// the PlayHQ organisation uuid, so the map is matched on the full id first and on
// the leading eight characters second. A key shorter than eight characters is never
// used as a prefix — that would match half the tenant.
function shortCodeFor(orgId, map) {
  if (!orgId || !map || typeof map !== 'object') return null;
  const id = String(orgId).trim();
  if (!id) return null;
  if (Object.prototype.hasOwnProperty.call(map, id) && map[id]) return map[id];
  const lower = id.toLowerCase();
  for (const k of Object.keys(map)) {
    if (!map[k]) continue;
    const kk = String(k).toLowerCase();
    if (kk === lower) return map[k];
    if (kk.length >= 8 && lower.startsWith(kk)) return map[k];
  }
  return null;
}

// ─── The two builders ────────────────────────────────────────────────────────
function stattrackUrl(o) {
  const base = String(o.base || '').replace(/\/+$/, '/');
  if (!base || !o.tid || !o.sid) return null;
  return `${base}#t=${encodeURIComponent(o.tid)}&s=${encodeURIComponent(o.sid)}`;
}

function footyDashboardUrl(o) {
  const base = String(o.base || '').trim();
  if (!base) return null;

  // y — a bare four-digit year, or nothing. Footy seasons straddle the calendar
  // year (2026 ran 2025-10-01 → 2026-09-30) but PlayHQ still names them "2026".
  const year = String(o.seasonName || '').trim();
  if (!/^\d{4}$/.test(year)) return null;

  // c — from the map, never from the PlayHQ name.
  const code = shortCodeFor(o.orgId, o.orgShortCodes);
  if (!code) return null;

  // a — grade name first, team name second, nothing third.
  const age = ageFromGradeName(o.gradeName) || ageFromTeamName(o.teamName);
  if (!age) return null;

  // t — the silent key. Built only from an age we actually have.
  const team = cleanTeam(o.teamName, age);
  if (!team) return null;

  const q = [['y', year], ['c', code], ['a', age], ['t', team]]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${base}#${q}`;
}

// ─── What the watcher calls ──────────────────────────────────────────────────
// `sport` is one entry of watch.json's `sports` block. An unknown link kind returns
// null rather than throwing: a sport added to watch.json with a link shape this
// version does not know about must still be WATCHED, just without a link.
function teamUrlFor(sport, parts) {
  const link = (sport && sport.link) || {};
  switch (link.kind) {
    case 'stattrack':
      return stattrackUrl({ base: link.base, tid: parts.tid, sid: parts.sid });
    case 'footy-dashboard':
      return footyDashboardUrl({
        base:          link.base,
        seasonName:    parts.seasonName,
        orgId:         parts.orgId,
        gradeName:     parts.gradeName,
        teamName:      parts.teamName,
        orgShortCodes: (sport && sport.orgShortCodes) || {},
      });
    default:
      return null;
  }
}

function urlTitleFor(sport) {
  const link = (sport && sport.link) || {};
  if (link.urlTitle) return String(link.urlTitle);
  if (link.kind === 'footy-dashboard') return 'Open in the footy dashboard';
  if (link.kind === 'stattrack')       return 'Open in StatTrack';
  return 'Open';
}

module.exports = {
  teamUrlFor, urlTitleFor,
  stattrackUrl, footyDashboardUrl,
  ageFromGradeName, ageFromTeamName, cleanTeam, shortCodeFor,
};
