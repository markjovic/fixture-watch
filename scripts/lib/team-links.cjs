// scripts/lib/team-links.cjs
//
// THE ALERT LINK, PER SPORT. One job: turn what the watcher already knows about a
// team into a URL that opens THAT TEAM, or return null.
//
// ─── THE RULE THAT OUTRANKS EVERY OTHER RULE HERE ────────────────────────────
// OMIT RATHER THAN APPROXIMATE. A missing link is honest. A link that cannot
// resolve is not. Every builder returns null the moment anything it needs is
// unavailable — nothing is guessed, nothing is defaulted, nothing is "near enough".
//
// ─── BASKETBALL — StatTrack ──────────────────────────────────────────────────
// `#t=<teamId>&s=<seasonId>`. Both are ids the watcher holds directly.
//
// ─── FOOTY — junior-footy-dashboard, v1.13 / engine v28 ──────────────────────
// `#y=<year>&c=<compShort>&a=<age>&t=<teamId>`
//
// ⚠️ `t` IS NOW THE TEAM ID, NOT THE TEAM NAME (changed 2026-11-24).
// The dashboard reused the `t` key and resolves it id-first, name-fallback, so
// every link ever shared keeps working. We send the full api-namespace team uuid —
// the same id `publicProfileTeams` gives us — which deletes the one genuinely
// fragile thing about the old format: a replica of the dashboard's cleanTeam()
// age-strip living in this file, which two repos had to keep in agreement forever.
//
// The other three keys are UNCHANGED and still derived here, because the dashboard
// still filters by year, competition and age group:
//
//   y  season.name, and only when it is a bare 4-digit year.
//   c  NOT a PlayHQ field. The dashboard's compShort comes from its OWN config.json
//      (`organisations[] { code, name }`), so the watcher carries an org-id → short
//      code map in watch.json. An org not in the map → null.
//   a  the age token from the GRADE name — NOT grades.json ageName, which returns
//      "U17" for a U17.5 competition. A girls grade is "U12 Girls". When the grade
//      is null — WHICH IS THE CASE FOR A BRAND NEW REGISTRATION, measured on
//      afbd05d3 2026-11-24 — fall back to the age token in the TEAM name, and when
//      there is none of those either → null.
//
// `g` is deliberately not emitted. A regrade would stale it and the team filter
// does not need it.
//
// ─── ⚠️ THE DASHBOARD ONLY KNOWS GAMES THAT HAVE BEEN PLAYED ─────────────────
// This is the constraint that matters most, and it is not about ids.
//
// Every dashboard URL key is validated against STORED MATCH RECORDS, and a record
// exists only for a game PlayHQ has marked FINAL. So NO link into a season resolves
// before that season's round 1 — whatever key it uses, however correct it is.
//
// That lands squarely on the footy alerts that matter most: a NEW TEAM when a club
// enters next season's registration, and FIXTURE OUT when the draw is published.
// Both are pre-season by definition. A link on either would open, toast, and show
// the reader nothing they asked for.
//
// So `hasPlayedGame` is REQUIRED for a footy link, and the watcher sets it from its
// own state: at least one game with status FINAL. That mirrors the dashboard's own
// stamping rule exactly, using only what this repo already holds, and it needs no
// knowledge of what the dashboard has ingested. No played game → no link → the
// alert goes out as text, which is the honest answer.
//
// ⚠️ A SEASON FETCHED BEFORE ENGINE v28 HAS RECORDS BUT NO IDS. There was no
// backfill, by design. Such a season answers by NAME only, so an id-keyed link into
// it will toast. In practice every footy season this watcher can still alert on is
// 2027 or later and will have been fetched by v28 — a season is dropped
// stopAfterSeasonEndDays past its endDate long before this matters. Recorded
// because it is the one case where the id format is worse than the name format.
//
// ⚠️ OPEN QUESTION, RAISED WITH THE DASHBOARD PROJECT AND NOT YET ANSWERED.
// Ids are stamped only on FINAL games. If the dashboard FILTERS on the id itself
// rather than resolving it to a name once, an id-keyed link mid-season shows the
// team's played games and hides the upcoming fixture the alert was about — the
// wrong half. It would still be the right team, so this is a degradation and not a
// defect, and the first real footy alert in 2027 will settle it. Do not assume.

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

// ─── cleanTeam — RETAINED, BUT NO LONGER USED BY THE LINK ───────────────────
// This is the dashboard's results-engine.js cleanTeam(name, gradeAge), replicated.
// It built the old name-keyed `t` and is kept for two reasons: the dashboard's
// name fallback still accepts this exact form, so reverting is one line if the id
// format ever has to be abandoned; and the unit tests on it are the only written
// record of a rule two repos once had to agree on — including the trap that a
// "U17 Boys Red" team in a U17.5 grade keeps its U17, which caused four duplicate
// records on 2026-08-19.
//
// ⚠️ DO NOT WIRE IT BACK INTO footyDashboardUrl() without a reason. Deleting that
// coupling was the entire point of the id swap.
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

  // ⚠️ NO PLAYED GAME, NO LINK. The dashboard holds a record only for a game
  // PlayHQ has marked FINAL, so a link into a season with none resolves to nothing
  // whatever its keys say. This is the gate that keeps pre-season alerts — NEW TEAM
  // and FIXTURE OUT, the two that matter most — from carrying a dud link.
  if (o.hasPlayedGame !== true) return null;

  // t — the full api-namespace team uuid, straight from publicProfileTeams.
  const teamId = String(o.teamId || '').trim();
  if (!teamId) return null;

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

  const q = [['y', year], ['c', code], ['a', age], ['t', teamId]]
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
        teamId:        parts.tid,
        hasPlayedGame: parts.hasPlayedGame,
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
