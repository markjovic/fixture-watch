// scripts/lib/netball-watch.cjs
//
// NETBALL CONNECT — extract, diff, and build the Pushover messages. Pure logic: no
// network, no filesystem, no clock it does not receive. All of it is unit-testable
// without touching Squadi, which is why it is separate from the client.
//
// ─── THE PRIVACY RULE IS IMPLEMENTED HERE, NOT JUST DOCUMENTED ───────────────
// State is committed to a PUBLIC repo. Team and competition names are already
// public on Netball Connect's draw pages; what must never be published is the LINK
// between those and a specific child. So nothing that identifies the child reaches
// a state record:
//
//   · players are keyed by `alias` ("p1") from NC_PLAYERS;
//   · teams and registrations are keyed by HMAC-SHA256(NC_STATE_KEY, "<kind>:<id>")
//     truncated to 16 hex — stable for diffing, not reversible, and not joinable to
//     the platform without the key;
//   · no child name, userId, registrationId, teamId, participantId or date of birth
//     is written anywhere.
//
// The child's NAME exists only inside a Pushover message, and it comes from
// NC_PLAYERS — never from an API response, which would route a personal-details
// field into a string that could later be logged.

'use strict';

const crypto = require('crypto');

const NC_URL       = 'https://registration.netballconnect.com';
const NC_URL_TITLE = 'Netball Connect';

// ─── Pseudonymous state key ──────────────────────────────────────────────────
// Truncated to 16 hex (64 bits). Collision risk across a handful of teams and
// registrations is nil, and a shorter key keeps the committed state readable.
function stateKey(hmacKey, kind, id) {
  return crypto.createHmac('sha256', String(hmacKey))
    .update(`${kind}:${id}`)
    .digest('hex')
    .slice(0, 16);
}

// Australian format, and only when the value actually parses as a date.
function auDate(v) {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  return s;
}

// ─── Records ─────────────────────────────────────────────────────────────────
// Only these fields are ever stored. Everything else the API returned is dropped
// here and never reaches state, a log or a disk.
function teamRecords(rows, hmacKey) {
  return rows.map(r => ({
    stateKey: stateKey(hmacKey, 'team', r.teamId),
    teamName: r.teamName,
    competitionName: r.competitionName,
    roles: r.roles,                      // display only, not stored
  }));
}

// §8.3. `teamId` becomes the BOOLEAN hasTeam — the id itself must not be stored.
// affiliate / membershipProduct / createdOn may appear in a notification built from
// the current response but are never stored.
function regRecords(rows, hmacKey) {
  return rows.map(r => ({
    stateKey: stateKey(hmacKey, 'reg', String(r.registrationId).trim()),
    competitionName: String(r.competitionName || '').trim(),
    membershipType: String(r.membershipType || '').trim(),
    paymentStatus: r.paymentStatus == null ? null : String(r.paymentStatus),
    expiryDate: r.expiryDate == null ? null : String(r.expiryDate),
    divisionId: r.divisionId == null ? null : r.divisionId,
    hasTeam: r.teamId != null,
    deRegistered: r.alreadyDeRegistered === 1,
    deRegisterStarted: r.deRegisterId != null,
    failed: r.isFailedRegistration === 1,
    approvalStatusRefId: r.approvalStatusRefId == null ? null : r.approvalStatusRefId,
    _affiliate: String(r.affiliate || '').trim(),
    _product: String(r.membershipProduct || '').trim(),
  }));
}

// The fields a change in which is worth an alert. competitionName and
// membershipType are DISPLAY — they are refreshed in state without notifying.
const WATCHED_REG_FIELDS = [
  'paymentStatus', 'expiryDate', 'divisionId', 'hasTeam',
  'deRegistered', 'deRegisterStarted', 'failed', 'approvalStatusRefId',
];

const STORED_TEAM = (r, firstSeen) => ({ teamName: r.teamName, competitionName: r.competitionName, firstSeen });
const STORED_REG  = (r, firstSeen) => ({
  competitionName: r.competitionName, membershipType: r.membershipType,
  paymentStatus: r.paymentStatus, expiryDate: r.expiryDate, divisionId: r.divisionId,
  hasTeam: r.hasTeam, deRegistered: r.deRegistered, deRegisterStarted: r.deRegisterStarted,
  failed: r.failed, approvalStatusRefId: r.approvalStatusRefId, firstSeen,
});

// ─── Diffs ───────────────────────────────────────────────────────────────────
// ⚠️ A REMOVAL IS ONLY EVER REPORTED FROM A FETCH THAT FULLY SUCCEEDED AND
// VALIDATED. The caller must not invoke these with a partial list — an incomplete
// registrations page would otherwise read as every missing row being removed.
function diffTeams(prev, next, today) {
  const events = [];
  const nextState = {};
  const prevKeys = new Set(Object.keys(prev || {}));

  for (const r of next) {
    const was = (prev || {})[r.stateKey];
    if (!was) {
      events.push({ type: 'team-added', rec: r });
      nextState[r.stateKey] = STORED_TEAM(r, today);
    } else {
      if (was.teamName !== r.teamName) events.push({ type: 'team-renamed', rec: r, from: was.teamName });
      nextState[r.stateKey] = STORED_TEAM(r, was.firstSeen || today);
    }
    prevKeys.delete(r.stateKey);
  }
  for (const gone of prevKeys) {
    events.push({ type: 'team-removed', rec: { ...(prev[gone] || {}), stateKey: gone } });
  }
  return { events, nextState };
}

function diffRegs(prev, next, today) {
  const events = [];
  const nextState = {};
  const prevKeys = new Set(Object.keys(prev || {}));

  for (const r of next) {
    const was = (prev || {})[r.stateKey];
    if (!was) {
      events.push({ type: 'reg-added', rec: r });
      nextState[r.stateKey] = STORED_REG(r, today);
    } else {
      const changes = [];
      for (const f of WATCHED_REG_FIELDS) {
        const a = was[f] === undefined ? null : was[f];
        const b = r[f] === undefined ? null : r[f];
        if (a !== b) changes.push({ field: f, from: a, to: b });
      }
      if (changes.length) events.push({ type: 'reg-changed', rec: r, changes });
      nextState[r.stateKey] = STORED_REG(r, was.firstSeen || today);
    }
    prevKeys.delete(r.stateKey);
  }
  for (const gone of prevKeys) {
    events.push({ type: 'reg-removed', rec: { ...(prev[gone] || {}), stateKey: gone } });
  }
  return { events, nextState };
}

// ─── Messages ────────────────────────────────────────────────────────────────
// `name` is the display name from NC_PLAYERS. It never comes from the API.
const show = (v) => (v === null || v === undefined || v === '') ? '—' : String(v);

function messageFor(ev, name) {
  const r = ev.rec || {};
  switch (ev.type) {
    case 'team-added':
      return {
        title: `${name} - new netball team`,
        lines: [r.teamName, r.competitionName, r.roles ? `Role: ${r.roles}` : null].filter(Boolean),
      };
    case 'team-renamed':
      return { title: `${name} - netball team renamed`, lines: [`${ev.from} → ${r.teamName}`] };
    case 'team-removed':
      return { title: `${name} - removed from netball team`, lines: [r.teamName, r.competitionName].filter(Boolean) };
    case 'reg-added':
      return {
        title: `${name} - new netball registration`,
        lines: [
          r._affiliate || null,
          r.competitionName || null,
          (r._product || r.membershipType) ? `${r._product ? r._product + ' - ' : ''}${r.membershipType}`.trim() : null,
          `Status: ${show(r.paymentStatus)}${r.expiryDate ? `, valid until ${auDate(r.expiryDate)}` : ''}`,
        ].filter(Boolean),
      };
    case 'reg-changed': {
      const gotTeam = ev.changes.some(c => c.field === 'hasTeam' && c.to === true);
      return {
        title: gotTeam ? `${name} - netball registration now has a team`
                       : `${name} - netball registration updated`,
        lines: [r.competitionName || null, ...ev.changes.map(c => {
          const fmt = (v) => c.field === 'expiryDate' ? auDate(v) : show(v);
          return `${c.field}: ${fmt(c.from)} → ${fmt(c.to)}`;
        })].filter(Boolean),
      };
    }
    case 'reg-removed':
      return {
        title: `${name} - netball registration removed`,
        lines: [`${r.competitionName || '—'}${r.membershipType ? ` (${r.membershipType})` : ''}`],
      };
    default:
      return { title: `${name} - netball change`, lines: [ev.type] };
  }
}

// More than three events in one run collapses to a single message, so a club doing
// a bulk reallocation cannot produce a burst of pushes.
function alertsFor(events, name) {
  if (!events.length) return [];
  const built = events.map(ev => ({ ev, msg: messageFor(ev, name) }));
  if (built.length <= 3) {
    return built.map(b => ({
      title: b.msg.title, lines: b.msg.lines, priority: 0, url: NC_URL, urlTitle: NC_URL_TITLE,
    }));
  }
  return [{
    title: `${name} - ${built.length} netball changes`,
    lines: built.map(b => `• ${b.msg.title.replace(`${name} - `, '')}: ${b.msg.lines[0] || ''}`.trim()),
    priority: 0, url: NC_URL, urlTitle: NC_URL_TITLE,
  }];
}

// First run for a player: store both lists and send ONE info message, never one
// alert per existing item. The expected counts are stated so an unexpected shape is
// visible in the message itself rather than needing the log.
function seedAlert(name, teamCount, regCount, expected) {
  const exp = expected || { teams: 2, registrations: 4 };
  const odd = (teamCount !== exp.teams || regCount !== exp.registrations)
    ? `Expected ${exp.teams} teams and ${exp.registrations} registrations — check this.` : null;
  return {
    title: `Netball Connect watch started for ${name}`,
    lines: [`${teamCount} team(s), ${regCount} registration(s) on record`, odd].filter(Boolean),
    priority: 0, url: NC_URL, urlTitle: NC_URL_TITLE,
  };
}

const canaryAlert = () => ({
  title: 'Netball Connect Teams tab now returns data',
  lines: ['Check whether it is a better source than personaldetails.'],
  priority: 0, url: NC_URL, urlTitle: NC_URL_TITLE,
});

// ─── Error alerting — once per failure state (§6) ────────────────────────────
// Alert when a reason first appears or changes; stay quiet while it is unchanged;
// remind once every 24 hours. Never include a body, token, header or id.
const ERROR_REMINDER_MS = 24 * 3600 * 1000;

function errorDecision(lastError, reason, nowMs) {
  if (!lastError || lastError.reason !== reason) {
    return { alert: true, next: { reason, firstSeen: new Date(nowMs).toISOString(), lastAlertAt: new Date(nowMs).toISOString() } };
  }
  const last = Date.parse(lastError.lastAlertAt || lastError.firstSeen || 0);
  if (Number.isFinite(last) && (nowMs - last) >= ERROR_REMINDER_MS) {
    return { alert: true, next: { ...lastError, lastAlertAt: new Date(nowMs).toISOString() } };
  }
  return { alert: false, next: lastError };
}

const errorAlert = (reason) => ({
  title: 'fixture-watch: Netball Connect error',
  lines: [reason], priority: 0,
});

const recoveryAlert = () => ({
  title: 'Netball Connect watch recovered',
  lines: ['The previous error has cleared.'], priority: 0,
});

module.exports = {
  stateKey, auDate, teamRecords, regRecords, diffTeams, diffRegs,
  messageFor, alertsFor, seedAlert, canaryAlert,
  errorDecision, errorAlert, recoveryAlert,
  WATCHED_REG_FIELDS, NC_URL, NC_URL_TITLE, ERROR_REMINDER_MS,
};
