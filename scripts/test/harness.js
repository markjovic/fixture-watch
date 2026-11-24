// scripts/test/harness.js
//
// THE REGRESSION HARNESS. Runs scripts/fixture-watch.js UNMODIFIED, in a throwaway
// git repo with a throwaway bare remote, against a faked PlayHQ and a faked
// Pushover (scripts/test/mock-playhq.cjs, preloaded with --require).
//
// ⚠️ `node --check` IS NOT A TEST. It proves syntax and nothing else — it did not
// catch a constant copied without its definition (TERMINAL, 2026-11-24). Every
// scenario here actually executes the watcher end to end, including the real git
// commit and push, and asserts on what came out: the Pushover messages, the state
// files on disk and the process exit code.
//
// USAGE
//   node scripts/test/harness.js [name-fragment ...]
//
// The basketball watcher is LIVE and alerting on Mark's phone. A footy regression
// there is worse than footy arriving late, so every pre-footy scenario is kept
// here unchanged and is expected to behave exactly as it did before the sports
// block existed.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const links = require('../lib/team-links.cjs');

const REPO  = path.join(__dirname, '..', '..');
const ONLY  = process.argv.slice(2);
const DAY   = 86400000;
const isoD  = (ms) => new Date(ms).toISOString().slice(0, 10);
const FUT1  = isoD(Date.now() + 30 * DAY);
const FUT2  = isoD(Date.now() + 37 * DAY);
const PAST  = isoD(Date.now() - 30 * DAY);

const UUID  = '0afc7690-c2db-4644-b039-af1c34520af3';
const BB    = 'basketball-victoria';
const AFL   = 'afl';
const FOOTY_BASE = 'https://markjovic.github.io/junior-footy-dashboard/index.html';
const ST_BASE    = 'https://markjovic.github.io/stattrack/';

let passed = 0, failed = 0;
const problems = [];
function check(scenario, label, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  problems.push(`${scenario} › ${label}${detail ? `\n      ${detail}` : ''}`);
}

// ─── Config used by every scenario ───────────────────────────────────────────
function cfgFor(sports) {
  return {
    sports,
    tenant: BB, sport: 'basketball', stattrackBase: ST_BASE,
    players: [{ uuid: UUID, name: 'Toby', sports: Object.keys(sports), pinnedTeams: {} }],
    completeFixtureSlotsEvery: 4,
    gradeRoundsRefreshHours: 12,
    activeChangeWindowDays: 7,
    stopAfterSeasonEndDays: 21,
    failureAlertCooldownHours: 6,
    maxAlertChars: 1000,
  };
}
const SPORT_BB = { basketball: { label: 'Basketball', tenant: BB, link: { kind: 'stattrack', base: ST_BASE, urlTitle: 'Open in StatTrack' } } };
const SPORT_FOOTY = {
  label: 'Footy', tenant: AFL,
  link: { kind: 'footy-dashboard', base: FOOTY_BASE, urlTitle: 'Open in the footy dashboard' },
  orgShortCodes: { '383836bb': 'EFNL', '4c8b472e': 'WFNL', '1cf85e52': 'SEJ', '0f20da4f': 'SER', '4f9a099e': 'YJFL' },
};

// ─── PlayHQ response builders ────────────────────────────────────────────────
function pteam(o) {
  return {
    id: o.id, name: o.name,
    organisation: { id: o.clubId || 'club-1', name: o.club || 'Spirit' },
    grade: o.gradeId ? { id: o.gradeId, name: o.gradeName } : null,
    season: {
      id: o.sid || 'season-1', name: o.seasonName || '2026',
      startDate: o.startDate || '2026-01-01', endDate: o.endDate === undefined ? null : o.endDate,
      status: { name: 'In progress', value: o.seasonStatus || 'IN_PROGRESS' },
      competition: { id: 'comp-1', name: o.comp || 'Winter 2026', organisation: { id: o.orgId || 'assoc-1', name: o.assoc || 'Association' } },
    },
  };
}
function game(o) {
  return {
    id: o.id, dates: [o.date], status: { value: o.status || 'SCHEDULED' },
    home: { id: o.homeId, name: o.homeName },
    away: { id: o.awayId, name: o.awayName },
    result: null,
    allocation: { dateTimeList: [{ date: o.date, time: o.time || '09:00:00' }], court: { id: 'crt-1', name: o.court || 'Court 1', venue: { id: 'ven-1', name: o.venue || 'Stadium' } } },
  };
}
function round(o) {
  return {
    id: o.id, name: o.name, isFinalsRound: !!o.finals,
    grade: { id: o.gradeId, name: o.gradeName || 'Grade', season: { id: 'season-1', name: '2026', competition: { id: 'comp-1', name: 'Winter 2026', organisation: { id: 'assoc-1', name: 'Association' } } } },
    fixture: { games: o.games || [] },
  };
}
function fixtureData(o) {
  return {
    discoverTeam: {
      id: o.tid,
      grade: o.gradeId ? { id: o.gradeId, name: o.gradeName } : null,
      season: { id: o.sid || 'season-1', name: o.seasonName || '2026', competition: { id: 'comp-1', name: 'Winter 2026', organisation: { id: o.orgId || 'assoc-1', name: o.assoc || 'Association' } }, status: { value: 'IN_PROGRESS' } },
      organisation: { id: 'club-1', name: o.club || 'Spirit' },
    },
    discoverTeamFixture: o.rounds || [],
  };
}
function gradeData(o) {
  return { discoverGrade: { id: o.gid, name: o.name || 'Grade', hideScores: false, rounds: o.rounds, season: { id: 'season-1', competition: { id: 'comp-1', organisation: { id: 'assoc-1', name: 'Association' } } } } };
}
const roundList = (n, currentIdx) => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, name: `Round ${i + 1}`, abbreviatedName: `R${i + 1}`, number: i + 1, current: i === currentIdx, isFinalsRound: false }));

// A normalised game, as normaliseGames() would have stored it. Used to prefill state.
function ng(o) {
  return { d: o.d, t: o.t || '09:00', v: o.v || 'Stadium', c: o.c || 'Court 1', opp: o.opp || 'Rivals', oppId: o.oppId || 'opp-1', home: o.home === undefined ? true : o.home, st: o.st || 'SCHEDULED', gid: o.gid || 'grade-1', gn: o.gn || 'Grade', rn: o.rn || 'Round 1', finals: false };
}
function teamState(o) {
  return {
    tid: o.tid,
    reg: { tid: o.tid, sport: o.sport || 'basketball', name: o.name, club: 'Spirit', sid: 'season-1', seasonName: '2026', seasonStatus: 'IN_PROGRESS', endDate: o.endDate === undefined ? null : o.endDate, comp: 'Winter 2026', assoc: 'Association', assocId: o.orgId || 'assoc-1', currentGid: o.gid || 'grade-1', currentGrade: o.gradeName || 'Grade' },
    players: [UUID],
    games: o.games || {},
    rounds: null,
    coverage: o.coverage === undefined ? { gid: o.gid || 'grade-1', complete: false, covered: 1, nonFinalsRounds: 3, fromRound: 1, missing: ['Round 2'], lastGameDate: o.lastGameDate || FUT1, finalsRoundsInGrade: 0, checkedAt: new Date().toISOString() } : o.coverage,
    firstSeenAt: new Date(Date.now() - 60 * DAY).toISOString(),
    lastChangeAt: new Date(Date.now() - 60 * DAY).toISOString(),
    lastCheckedAt: new Date(Date.now() - DAY).toISOString(),
  };
}

// ─── Running one scenario ────────────────────────────────────────────────────
function run(spec) {
  const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-harness-'));
  const repo   = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { stdio: 'pipe' });
  fs.cpSync(path.join(REPO, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'watch.json'), JSON.stringify(spec.cfg, null, 2) + '\n');
  fs.mkdirSync(path.join(repo, 'state'), { recursive: true });
  for (const [name, obj] of Object.entries(spec.state || {})) {
    fs.writeFileSync(path.join(repo, 'state', name), JSON.stringify(obj, null, 2) + '\n');
  }
  const g = (a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'harness@local']);
  g(['config', 'user.name', 'harness']);
  g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
  g(['remote', 'add', 'origin', remote]); g(['push', '-q', 'origin', 'main']);

  const scenFile = path.join(dir, 'scenario.json');
  const logFile  = path.join(dir, 'calls.json');
  fs.writeFileSync(scenFile, JSON.stringify(spec.net, null, 2));
  fs.writeFileSync(logFile, '[]');

  const r = spawnSync(process.execPath, ['scripts/fixture-watch.js', '--force', '--delay=0'], {
    cwd: repo, encoding: 'utf8', timeout: 180000,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${path.join(REPO, 'scripts', 'test', 'mock-playhq.cjs')}`,
      FW_SCENARIO: scenFile, FW_CALLLOG: logFile, FW_FAST_SLEEP: '1',
      PUSHOVER_TOKEN: 'harness-token', PUSHOVER_USER: 'harness-user',
    },
  });

  const calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  const ctx = {
    code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', calls,
    pushes: calls.filter(c => c.kind === 'pushover'),
    sessions: calls.filter(c => c.kind === 'session'),
    authed: calls.filter(c => c.kind === 'profile' || c.kind === 'fixture' || c.kind === 'grade'),
    repo,
    stateExists: (f) => fs.existsSync(path.join(repo, 'state', f)),
    stateOf: (f) => { const p = path.join(repo, 'state', f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; },
    titles: () => calls.filter(c => c.kind === 'pushover').map(c => c.title),
  };
  try { spec.assert(ctx, (label, ok, detail) => check(spec.name, label, ok, detail)); }
  catch (err) { check(spec.name, 'assertions threw', false, `${err.message}\n--- stdout ---\n${ctx.stdout.slice(-2500)}\n--- stderr ---\n${ctx.stderr.slice(-1500)}`); }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
//  UNIT TESTS — the footy link builder, against the MEASURED data
// ═══════════════════════════════════════════════════════════════════════════
function unitTests() {
  const S = 'unit \u00b7 footy link';
  const sp = { link: { kind: 'footy-dashboard', base: FOOTY_BASE }, orgShortCodes: SPORT_FOOTY.orgShortCodes };
  const u = (o) => links.teamUrlFor(sp, o);
  const EFNL = '383836bb-1111-2222-3333-444455556666';
  const TID  = 'e2b94c0a-aaaa-bbbb-cccc-ddddeeeeffff';
  // The measured registration: Norwood U12 Purple, grade U12 - B, EFNL, 2026.
  const reg = { tid: TID, hasPlayedGame: true, teamName: 'Norwood U12 Purple', gradeName: 'U12 - B', seasonName: '2026', orgId: EFNL };
  const with_ = (over) => u({ ...reg, ...over });

  check(S, 'the id-keyed link, exactly',
    with_({}) === `${FOOTY_BASE}#y=2026&c=EFNL&a=U12&t=${TID}`, String(with_({})));

  // ⚠️ The dashboard holds a record only for a game marked FINAL, so a team with
  // none cannot be resolved by ANY key. Both pre-season alerts land here.
  check(S, 'no played game means NO link', with_({ hasPlayedGame: false }) === null);
  check(S, 'an absent hasPlayedGame means NO link — it must be opted into',
    u({ tid: TID, teamName: 'Norwood U12 Purple', gradeName: 'U12 - B', seasonName: '2026', orgId: EFNL }) === null);

  check(S, 'no team id means NO link', with_({ tid: null }) === null);
  check(S, 'an unmapped org means NO link', with_({ orgId: '11112222-aaaa' }) === null);
  check(S, 'no age anywhere means NO link', with_({ teamName: 'Norwood Seniors', gradeName: 'Senior Men Division 1' }) === null);
  check(S, 'a non-year season name means NO link', with_({ seasonName: '2026/27' }) === null);
  check(S, 'no org id means NO link', with_({ orgId: null }) === null);

  // `a` is STILL derived here — the id swap removed cleanTeam, not the age.
  check(S, 'grade null falls back to the team-name age token',
    with_({ gradeName: null, teamName: 'Lilydale U13', seasonName: '2027' })
      === `${FOOTY_BASE}#y=2027&c=EFNL&a=U13&t=${TID}`, String(with_({ gradeName: null, teamName: 'Lilydale U13', seasonName: '2027' })));
  check(S, 'a girls grade carries the Girls suffix in `a`',
    with_({ gradeName: 'U12 Girls - B', teamName: 'Norwood U12 Girls Blue' })
      === `${FOOTY_BASE}#y=2026&c=EFNL&a=U12%20Girls&t=${TID}`);
  check(S, 'U17.5 is read from the grade name, not an ageName',
    with_({ gradeName: 'U17.5 Boys A', teamName: 'Mt Eliza JFC U17 Boys Red' })
      === `${FOOTY_BASE}#y=2026&c=EFNL&a=U17.5&t=${TID}`);

  check(S, 'the short code matches on the full uuid too',
    links.shortCodeFor('4c8b472e', SPORT_FOOTY.orgShortCodes) === 'WFNL' &&
    links.shortCodeFor('4c8b472e-0000-0000-0000-000000000000', SPORT_FOOTY.orgShortCodes) === 'WFNL');

  // cleanTeam is retained but NOT wired into the link. These pin the old name form
  // so reverting is one line if the id format ever has to be abandoned, and they
  // keep the U17.5 trap on the record.
  check(S, 'cleanTeam still produces the old name form', links.cleanTeam('Norwood U12 Purple', 'U12') === 'Norwood Purple');
  check(S, 'cleanTeam still refuses to strip U17 for a U17.5 grade', links.cleanTeam('Mt Eliza JFC U17 Boys Red', 'U17.5') === 'Mt Eliza JFC U17 Boys Red');
  check(S, 'and cleanTeam is NOT in the link any more', !with_({}).includes('Norwood'));

  check(S, 'the basketball link is unchanged',
    links.teamUrlFor(SPORT_BB.basketball, { tid: 'T1', sid: 'S1' }) === `${ST_BASE}#t=T1&s=S1`);
  check(S, 'a basketball link with no season id is omitted',
    links.teamUrlFor(SPORT_BB.basketball, { tid: 'T1', sid: null }) === null);
  check(S, 'basketball ignores hasPlayedGame entirely',
    links.teamUrlFor(SPORT_BB.basketball, { tid: 'T1', sid: 'S1', hasPlayedGame: false }) === `${ST_BASE}#t=T1&s=S1`);
  check(S, 'an unknown link kind is omitted, not thrown',
    links.teamUrlFor({ link: { kind: 'something-new' } }, { tid: 'T1', sid: 'S1' }) === null);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════
const T1 = 'team-1', T2 = 'team-2', FT = 'footy-team-1';
const G1 = 'grade-1', G2 = 'grade-2', FG = 'footy-grade-1';

const bbProfileOneTeam = {
  [UUID]: { data: { publicProfileTeams: [pteam({ id: T1, name: 'Spirit Magic 3', gradeId: G1, gradeName: 'B13 - 1' })] } },
};
const bbFixtureTwoGames = {
  [T1]: { data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
    round({ id: 'r1', name: 'Round 1', gradeId: G1, gradeName: 'B13 - 1', games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
    round({ id: 'r2', name: 'Round 2', gradeId: G1, gradeName: 'B13 - 1', games: [game({ id: 'g2', date: FUT2, time: '11:00:00', homeId: 'opp-2', homeName: 'Others', awayId: T1, awayName: 'Spirit Magic 3' })] }),
    round({ id: 'r3', name: 'Round 3', gradeId: G1, gradeName: 'B13 - 1', games: [] }),
  ] }) },
};
const bbGrade3Rounds = { [G1]: { data: gradeData({ gid: G1, name: 'B13 - 1', rounds: roundList(3, 0) }) } };

const SCENARIOS = [

{
  name: '01 baseline — first sight of a team is ONE summary, not one alert per game',
  cfg: cfgFor(SPORT_BB), state: {},
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('exactly one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('it is the baseline summary', /now watching/.test(c.pushes[0].title));
    ck('no per-game ADDED lines', !/\+ ADDED/.test(c.pushes[0].message), c.pushes[0].message);
    ck('the link is StatTrack', c.pushes[0].url === `${ST_BASE}#t=${T1}&s=season-1`, String(c.pushes[0].url));
    ck('state written', !!c.stateOf(`${T1}.json`));
    ck('state records the sport', c.stateOf(`${T1}.json`).reg.sport === 'basketball');
    ck('player state is in the bySport shape', !!c.stateOf('_players.json')[UUID].bySport.basketball.seen);
  },
},

{
  name: '02 change — a future game moving is reported',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: {
    g1: ng({ d: FUT1, t: '09:00', rn: 'Round 1', opp: 'Rivals' }),
    g2: ng({ d: FUT2, t: '11:00', rn: 'Round 2', opp: 'Others', home: false, oppId: 'opp-2' }),
  } }), '_players.json': { [UUID]: { name: 'Toby', bySport: { basketball: { seen: true, teams: { [T1]: { tid: T1, name: 'Spirit Magic 3', sid: 'season-1', seasonName: '2026', endDate: null } } } } } } },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, time: '14:30:00', homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
      round({ id: 'r2', name: 'Round 2', gradeId: G1, games: [game({ id: 'g2', date: FUT2, time: '11:00:00', homeId: 'opp-2', homeName: 'Others', awayId: T1, awayName: 'Spirit Magic 3' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('one alert', c.pushes.length === 1, JSON.stringify(c.titles()));
    ck('it names the time change', /time 09:00 → 14:30/.test(c.pushes[0].message), c.pushes[0].message);
    ck('state now holds the new time', c.stateOf(`${T1}.json`).games.g1.t === '14:30');
  },
},

{
  name: '03 regrade — the grade set changing is its own headline',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1, gid: G1, gn: 'B13 - 1' }) } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: { [G2]: { data: gradeData({ gid: G2, name: 'B13 - 2', rounds: roundList(3, 0) }) } }, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G2, gradeName: 'B13 - 2', rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G2, gradeName: 'B13 - 2', games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('the title says REGRADED', c.pushes.some(p => /REGRADED/.test(p.title)), JSON.stringify(c.titles()));
    ck('the body names both grade ids', c.pushes.some(p => p.message.includes(`REGRADE: ${G1} → ${G2}`)), c.pushes.map(p => p.message).join('\n'));
  },
},

{
  name: '04 fixture-to-zero — games disappearing is the loud one',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }), g2: ng({ d: FUT2 }) } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: { [T1]: { data: fixtureData({ tid: T1, gradeId: G1, rounds: [] }) } } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('FIXTURE EMPTY alert', c.pushes.some(p => /FIXTURE EMPTY/.test(p.title)), JSON.stringify(c.titles()));
    ck('it says PlayHQ answered normally', c.pushes.some(p => /not a fetch failure/.test(p.message)));
  },
},

{
  name: '05 fixture-published — zero to a whole season is a summary, not N ADDED lines',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: {}, lastGameDate: null, coverage: null }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'o1', awayName: 'A' })] }),
      round({ id: 'r2', name: 'Round 2', gradeId: G1, games: [game({ id: 'g2', date: FUT2, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'o2', awayName: 'B' })] }),
      round({ id: 'r3', name: 'Round 3', gradeId: G1, games: [game({ id: 'g3', date: isoD(Date.now() + 44 * DAY), homeId: T1, homeName: 'Spirit Magic 3', awayId: 'o3', awayName: 'C' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('FIXTURE OUT alert', c.pushes.some(p => /FIXTURE OUT/.test(p.title)), JSON.stringify(c.titles()));
    const m = (c.pushes.find(p => /FIXTURE OUT/.test(p.title)) || {}).message || '';
    ck('it is a First/Last summary', /First:/.test(m) && /Last:/.test(m), m);
    ck('it is NOT a list of ADDED lines', !/\+ ADDED/.test(m), m);
  },
},

{
  name: '06 team gone — and the pre-footy flat _players.json is migrated, not ignored',
  cfg: cfgFor(SPORT_BB),
  state: {
    [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }),
    '_players.json': { [UUID]: { seen: true, name: 'Toby', teams: { [T1]: { tid: T1, name: 'Spirit Magic 3', sid: 'season-1', seasonName: '2026', endDate: null } } } },
  },
  net: { tenants: { [BB]: { profile: { [UUID]: { data: { publicProfileTeams: [] } } } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('TEAM GONE alert', c.pushes.some(p => /TEAM GONE/.test(p.title)), JSON.stringify(c.titles()));
    ck('the state file is removed', !c.stateExists(`${T1}.json`));
    const ps = c.stateOf('_players.json')[UUID];
    ck('player state migrated to bySport', !!ps.bySport && !ps.teams, JSON.stringify(ps));
    ck('and now holds no basketball teams', Object.keys(ps.bySport.basketball.teams).length === 0);
  },
},

{
  name: '07 new team — a second registration appearing on the profile',
  cfg: cfgFor(SPORT_BB),
  state: {
    [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }),
    '_players.json': { [UUID]: { name: 'Toby', bySport: { basketball: { seen: true, teams: { [T1]: { tid: T1, name: 'Spirit Magic 3', sid: 'season-1', seasonName: '2026', endDate: null } } } } } },
  },
  net: { tenants: { [BB]: { grade: bbGrade3Rounds,
    profile: { [UUID]: { data: { publicProfileTeams: [
      pteam({ id: T1, name: 'Spirit Magic 3', gradeId: G1, gradeName: 'B13 - 1' }),
      pteam({ id: T2, name: 'Spirit Magic 4', gradeId: G1, gradeName: 'B13 - 1' }),
    ] } } },
    fixture: {
      [T1]: { data: fixtureData({ tid: T1, gradeId: G1, rounds: [round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] })] }) },
      [T2]: { data: fixtureData({ tid: T2, gradeId: G1, rounds: [round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g9', date: FUT1, homeId: T2, homeName: 'Spirit Magic 4', awayId: 'opp-9', awayName: 'Zed' })] })] }) },
    } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('NEW TEAM alert', c.pushes.some(p => /NEW TEAM/.test(p.title)), JSON.stringify(c.titles()));
    ck('and a baseline for it', c.pushes.some(p => /now watching Spirit Magic 4/.test(p.title)), JSON.stringify(c.titles()));
    ck('state written for the new team', !!c.stateOf(`${T2}.json`));
  },
},

{
  name: '08 blocked profile — a WAF block is NEVER read as "no teams"',
  cfg: cfgFor(SPORT_BB),
  state: {
    [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }),
    '_players.json': { [UUID]: { name: 'Toby', bySport: { basketball: { seen: true, teams: { [T1]: { tid: T1, name: 'Spirit Magic 3', sid: 'season-1', seasonName: '2026', endDate: null } } } } } },
  },
  net: { tenants: { [BB]: { profile: { [UUID]: { waf: true } }, grade: bbGrade3Rounds, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G1, rounds: [round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] })] }) },
  } } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('no TEAM GONE alert', !c.pushes.some(p => /TEAM GONE/.test(p.title)), JSON.stringify(c.titles()));
    ck('a watcher-failed alert was sent', c.pushes.some(p => p.title === 'watcher failed'), JSON.stringify(c.titles()));
    ck('it names the CloudFront block', c.pushes.some(p => /CLOUDFRONT-BLOCK/.test(p.message)));
    ck('the known team is still checked', c.calls.some(x => x.kind === 'fixture' && x.id === T1));
  },
},

{
  name: '09 blocked fixture — state is left EXACTLY as it was',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, fixture: { [T1]: { waf: true } } } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('no fixture alert', !c.pushes.some(p => p.title !== 'watcher failed'), JSON.stringify(c.titles()));
    ck('watcher-failed alert sent', c.pushes.some(p => p.title === 'watcher failed'));
    ck('the one stored game is untouched', Object.keys(c.stateOf(`${T1}.json`).games).join(',') === 'g1');
  },
},

{
  name: '10 Pushover rejection — the state write is HELD BACK so nothing is lost',
  cfg: cfgFor(SPORT_BB), state: {},
  net: { pushover: { mode: 'reject' }, tenants: { [BB]: { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('the alert was attempted', c.pushes.length >= 1);
    ck('NO state file was written for the team', !c.stateExists(`${T1}.json`), 'the alert never arrived, so the next run must re-detect it');
    ck('the log says it was held back', /holding back state/.test(c.stdout), c.stdout.slice(-800));
  },
},

{
  name: '11 past-game rename — history changing is NOT news',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, lastGameDate: PAST, games: {
    gp: ng({ d: PAST, st: 'FINAL', opp: 'Rivals', oppId: 'opp-1', rn: 'Round 1' }),
  } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
    [T1]: { data: fixtureData({ tid: T1, gradeId: G1, rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'gp', date: PAST, status: 'FINAL', homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'ZZ - Rivals - W' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1200)}`);
    ck('NO alert at all', c.pushes.length === 0, JSON.stringify(c.titles()));
    ck('the log says no change', /no change/.test(c.stdout));
  },
},

{
  name: '12 transient 504 — retried inside the pass, and it recovers',
  cfg: cfgFor(SPORT_BB), state: {},
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, grade: bbGrade3Rounds, fixture: {
    [T1]: { transient: 1, data: fixtureData({ tid: T1, gradeId: G1, gradeName: 'B13 - 1', rounds: [
      round({ id: 'r1', name: 'Round 1', gradeId: G1, games: [game({ id: 'g1', date: FUT1, homeId: T1, homeName: 'Spirit Magic 3', awayId: 'opp-1', awayName: 'Rivals' })] }),
    ] }) },
  } } } },
  assert(c, ck) {
    ck('exit 0 — it recovered', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('the fixture was asked twice', c.calls.filter(x => x.kind === 'fixture').length === 2, String(c.calls.filter(x => x.kind === 'fixture').length));
    ck('the retry is in the log', /retrying in 5s/.test(c.stdout));
    ck('no watcher-failed alert', !c.pushes.some(p => p.title === 'watcher failed'));
    ck('state written', !!c.stateOf(`${T1}.json`));
  },
},

{
  name: '13 timeout — three dead attempts is a typed failure, not an empty fixture',
  cfg: cfgFor(SPORT_BB),
  state: { [`${T1}.json`]: teamState({ tid: T1, name: 'Spirit Magic 3', gid: G1, games: { g1: ng({ d: FUT1 }) } }) },
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, fixture: { [T1]: { throwTimes: 3 } } } } },
  assert(c, ck) {
    ck('exit 1', c.code === 1, `exit ${c.code}`);
    ck('three attempts were made', c.calls.filter(x => x.kind === 'fixture').length === 3, String(c.calls.filter(x => x.kind === 'fixture').length));
    ck('watcher-failed alert sent', c.pushes.some(p => p.title === 'watcher failed'));
    ck('no FIXTURE EMPTY alert', !c.pushes.some(p => /FIXTURE EMPTY/.test(p.title)), JSON.stringify(c.titles()));
    ck('the stored game survives', Object.keys(c.stateOf(`${T1}.json`).games).join(',') === 'g1');
  },
},

{
  name: '14 two tenants — ONE SESSION PER TENANT, and the right cookie on every call',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }), state: {},
  net: { tenants: {
    [BB]:  { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds },
    [AFL]: {
      profile: { [UUID]: { data: { publicProfileTeams: [pteam({
        id: FT, name: 'Norwood U12 Purple', club: 'Norwood', clubId: '6d405ccb',
        gradeId: FG, gradeName: 'U12 - B',
        sid: 'footy-season-2026', seasonName: '2026', startDate: '2025-10-01', endDate: null,
        comp: 'EFNL 2026', orgId: '383836bb-1111-2222-3333-444455556666', assoc: 'Eastern Football Netball League',
      })] } } },
      fixture: { [FT]: { data: fixtureData({ tid: FT, gradeId: FG, gradeName: 'U12 - B', sid: 'footy-season-2026', club: 'Norwood', orgId: '383836bb-1111-2222-3333-444455556666', assoc: 'Eastern Football Netball League', rounds: [
        round({ id: 'fr1', name: 'Round 1', gradeId: FG, gradeName: 'U12 - B', games: [game({ id: 'fg1', date: FUT1, homeId: FT, homeName: 'Norwood U12 Purple', awayId: 'fopp', awayName: 'Vermont U12 Blue' })] }),
        round({ id: 'fr2', name: 'Round 2', gradeId: FG, gradeName: 'U12 - B', games: [] }),
      ] }) } },
      grade: { [FG]: { data: gradeData({ gid: FG, name: 'U12 - B', rounds: roundList(2, 0) }) } },
    },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-2000)}`);
    const bbS  = c.sessions.filter(s => s.tenant === BB).length;
    const aflS = c.sessions.filter(s => s.tenant === AFL).length;
    ck('exactly one session bootstrap per tenant', bbS === 1 && aflS === 1, `basketball ${bbS}, afl ${aflS}`);
    const wrong = c.authed.filter(x => !String(x.cookie || '').includes(`sess-${x.tenant}`));
    ck('every authed call carried ITS OWN tenant cookie', wrong.length === 0, JSON.stringify(wrong.slice(0, 3)));
    ck('both state files written', !!c.stateOf(`${T1}.json`) && !!c.stateOf(`${FT}.json`));
    ck('each state records its sport', c.stateOf(`${T1}.json`) && c.stateOf(`${FT}.json`) && c.stateOf(`${T1}.json`).reg.sport === 'basketball' && c.stateOf(`${FT}.json`).reg.sport === 'footy');
    ck('both sports appear in player state', Object.keys(c.stateOf('_players.json')[UUID].bySport).sort().join(',') === 'basketball,footy');
    const footyAlert = c.pushes.find(p => /Norwood U12 Purple/.test(p.title));
    ck('the footy alert title carries the sport', !!footyAlert && /^\[Footy\]/.test(footyAlert.title), footyAlert ? footyAlert.title : JSON.stringify(c.titles()));
    ck('the basketball alert title carries the sport', c.pushes.some(p => /^\[Basketball\]/.test(p.title)), JSON.stringify(c.titles()));
    // ⚠️ This team's only game is in the FUTURE, so the dashboard holds no record
    // of it and NO link may be emitted. Basketball is unaffected.
    ck('the footy alert carries NO link — nothing played yet', !!footyAlert && footyAlert.url === null, footyAlert ? String(footyAlert.url) : '(no alert)');
    ck('the basketball alert still links to StatTrack', c.pushes.some(p => String(p.url || '').startsWith(ST_BASE)), JSON.stringify(c.pushes.map(p => p.url)));
  },
},

{
  name: '15 two tenants — a tenant failing entirely does NOT stop the other',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }), state: {},
  net: { tenants: {
    [BB]:  { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds },
    [AFL]: { session: 'waf' },
  } },
  assert(c, ck) {
    ck('exit 1 — the run is red', c.code === 1, `exit ${c.code}`);
    ck('basketball still completed', !!c.stateOf(`${T1}.json`), c.stdout.slice(-2000));
    ck('basketball still alerted', c.pushes.some(p => /^\[Basketball\]/.test(p.title) && /now watching/.test(p.title)), JSON.stringify(c.titles()));
    ck('the failure is labelled with the sport', c.pushes.some(p => p.title === 'watcher failed' && /Footy ·/.test(p.message)), (c.pushes.find(p => p.title === 'watcher failed') || {}).message);
    ck('the afl session was not retried for ever', c.sessions.filter(s => s.tenant === AFL).length <= 3, String(c.sessions.filter(s => s.tenant === AFL).length));
    ck('no basketball session was wasted on it', c.sessions.filter(s => s.tenant === BB).length === 1);
  },
},

{
  name: '16 footy out of season — three COMPLETED seasons produce SILENCE, not noise',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }), state: {},
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: { profile: { [UUID]: { data: { publicProfileTeams: [
      pteam({ id: 'e2b94c0a', name: 'Norwood U12 Purple', club: 'Norwood', gradeId: '0fd9befd', gradeName: 'U12 - B', sid: '2dcbf383', seasonName: '2026', startDate: '2025-10-01', endDate: '2026-09-30', seasonStatus: 'COMPLETED', orgId: '383836bb-x' }),
      pteam({ id: 'd382b356', name: 'Norwood U11', club: 'Norwood', gradeId: 'a53bfc56', gradeName: 'U11 - B', sid: '75d8a232', seasonName: '2025', startDate: '2024-10-01', endDate: '2025-09-30', seasonStatus: 'COMPLETED', orgId: '383836bb-x' }),
      pteam({ id: 'f8b540b9', name: 'Norwood U10', club: 'Norwood', gradeId: 'ce193e34', gradeName: 'U10 - Blue', sid: 'ca9cc98b', seasonName: '2024', startDate: '2023-10-01', endDate: '2024-09-30', seasonStatus: 'COMPLETED', orgId: '383836bb-x' }),
    ] } } } },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('NO alerts at all', c.pushes.length === 0, JSON.stringify(c.titles()));
    ck('no fixture call was made', c.calls.filter(x => x.kind === 'fixture').length === 0);
    ck('all three are logged as out of scope', (c.stdout.match(/out of scope, never watched/g) || []).length === 3, c.stdout.slice(-1500));
    ck('footy is recorded as seen, so a 2027 team will alert', c.stateOf('_players.json')[UUID].bySport.footy.seen === true);
  },
},

{
  name: '17 footy new registration — grade null, no fixture, and therefore NO link',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }),
  state: { '_players.json': { [UUID]: { name: 'Toby', bySport: { basketball: { seen: true, teams: {} }, footy: { seen: true, teams: {} } } } } },
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: {
      profile: { [UUID]: { data: { publicProfileTeams: [pteam({
        id: '6a77a594', name: 'Lilydale U13', club: 'Lilydale', gradeId: null,
        sid: '1c5d3dfb', seasonName: '2027', startDate: '2026-11-01', endDate: '2027-09-19',
        seasonStatus: 'ACTIVE', comp: 'EFNL 2027', orgId: '383836bb-aaaa', assoc: 'Eastern Football Netball League',
      })] } } },
      fixture: { '6a77a594': { data: fixtureData({ tid: '6a77a594', gradeId: null, sid: '1c5d3dfb', seasonName: '2027', club: 'Lilydale', orgId: '383836bb-aaaa', rounds: [] }) } },
    },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    const nt = c.pushes.find(p => /NEW TEAM/.test(p.title));
    ck('a NEW TEAM alert fired', !!nt, JSON.stringify(c.titles()));
    ck('it is labelled Footy', !!nt && /^\[Footy\]/.test(nt.title), nt ? nt.title : '');
    // ⚠️ THE CASE THE WHOLE SUPPRESSION RULE EXISTS FOR. A brand new registration
    // has no games at all, so the dashboard cannot resolve it on any key. The alert
    // must still fire, and must carry NO link.
    ck('the NEW TEAM alert carries NO link', !!nt && nt.url === null, nt ? String(nt.url) : '');
    ck('no grade round call was possible or made', c.calls.filter(x => x.kind === 'grade').length === 0);
    ck('the baseline says no games are scheduled', c.pushes.some(p => /now watching Lilydale U13/.test(p.title) && /No games scheduled ahead/.test(p.message)), JSON.stringify(c.titles()));
  },
},

{
  name: '18 legacy config — a watch.json with NO sports block still works exactly as before',
  cfg: {
    tenant: BB, sport: 'basketball', stattrackBase: ST_BASE,
    players: [{ uuid: UUID, name: 'Toby', pinnedTeams: [] }],
    completeFixtureSlotsEvery: 4, gradeRoundsRefreshHours: 12, activeChangeWindowDays: 7,
    stopAfterSeasonEndDays: 21, failureAlertCooldownHours: 6, maxAlertChars: 1000,
  },
  state: {},
  net: { tenants: { [BB]: { profile: bbProfileOneTeam, fixture: bbFixtureTwoGames, grade: bbGrade3Rounds } } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    ck('one baseline alert', c.pushes.length === 1 && /now watching/.test(c.pushes[0].title), JSON.stringify(c.titles()));
    ck('the StatTrack link is intact', c.pushes[0].url === `${ST_BASE}#t=${T1}&s=season-1`, String(c.pushes[0].url));
    ck('only the basketball tenant was contacted', c.calls.every(x => x.kind === 'pushover' || x.tenant === BB));
  },
},

{
  name: '19 footy with a played game — the link is the TEAM ID, not the name',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }), state: {},
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: {
      profile: { [UUID]: { data: { publicProfileTeams: [pteam({
        id: FT, name: 'Norwood U12 Purple', club: 'Norwood', gradeId: FG, gradeName: 'U12 - B',
        sid: 'footy-season-2027', seasonName: '2027', startDate: '2026-10-01', endDate: null,
        comp: 'EFNL 2027', orgId: '383836bb-1111-2222-3333-444455556666', assoc: 'Eastern Football Netball League',
      })] } } },
      fixture: { [FT]: { data: fixtureData({ tid: FT, gradeId: FG, gradeName: 'U12 - B', sid: 'footy-season-2027', seasonName: '2027', club: 'Norwood', orgId: '383836bb-1111-2222-3333-444455556666', rounds: [
        round({ id: 'fr1', name: 'Round 1', gradeId: FG, gradeName: 'U12 - B', games: [game({ id: 'fg1', date: PAST, status: 'FINAL', homeId: FT, homeName: 'Norwood U12 Purple', awayId: 'fopp', awayName: 'Vermont U12 Blue' })] }),
        round({ id: 'fr2', name: 'Round 2', gradeId: FG, gradeName: 'U12 - B', games: [game({ id: 'fg2', date: FUT1, homeId: 'fopp2', homeName: 'Mitcham U12 Red', awayId: FT, awayName: 'Norwood U12 Purple' })] }),
      ] }) } },
      grade: { [FG]: { data: gradeData({ gid: FG, name: 'U12 - B', rounds: roundList(2, 1) }) } },
    },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    const a = c.pushes.find(p => /Norwood U12 Purple/.test(p.title));
    ck('the footy baseline alert fired', !!a, JSON.stringify(c.titles()));
    ck('the link carries the team ID', !!a && a.url === `${FOOTY_BASE}#y=2027&c=EFNL&a=U12&t=${FT}`, a ? String(a.url) : '(no alert)');
    ck('the team NAME is nowhere in the link', !!a && !String(a.url).includes('Norwood'), a ? String(a.url) : '');
    ck('the button names the dashboard', !!a && a.urlTitle === 'Open in the footy dashboard');
  },
},

{
  name: '20 team gone — the link is judged from the STORED fixture, not a fetch',
  cfg: cfgFor({ ...SPORT_BB, footy: SPORT_FOOTY }),
  state: {
    [`${FT}.json`]: teamState({ tid: FT, sport: 'footy', name: 'Norwood U12 Purple', gid: FG, gradeName: 'U12 - B', orgId: '383836bb-1111-2222-3333-444455556666', lastGameDate: PAST, games: { fg1: ng({ d: PAST, st: 'FINAL', gid: FG, gn: 'U12 - B', rn: 'Round 1' }) } }),
    '_players.json': { [UUID]: { name: 'Toby', bySport: {
      basketball: { seen: true, teams: {} },
      footy: { seen: true, teams: { [FT]: { tid: FT, name: 'Norwood U12 Purple', sid: 'footy-season-2027', seasonName: '2027', endDate: null, regGrade: 'U12 - B', assocId: '383836bb-1111-2222-3333-444455556666' } } } },
    } },
  },
  net: { tenants: {
    [BB]:  { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
    [AFL]: { profile: { [UUID]: { data: { publicProfileTeams: [] } } } },
  } },
  assert(c, ck) {
    ck('exit 0', c.code === 0, `exit ${c.code}\n${c.stdout.slice(-1500)}`);
    const gone = c.pushes.find(p => /TEAM GONE/.test(p.title));
    ck('a TEAM GONE alert fired', !!gone, JSON.stringify(c.titles()));
    ck('it is labelled Footy', !!gone && /^\[Footy\]/.test(gone.title), gone ? gone.title : '');
    // The team is off the profile so nothing was fetched — the stored fixture is
    // the only evidence that the dashboard can resolve it, and it holds a FINAL game.
    ck('the link is built from the stored FINAL game', !!gone && gone.url === `${FOOTY_BASE}#y=2027&c=EFNL&a=U12&t=${FT}`, gone ? String(gone.url) : '');
    ck('the state file is removed', !c.stateExists(`${FT}.json`));
    ck('no fixture call was made', c.calls.filter(x => x.kind === 'fixture').length === 0);
  },
},

];

// ═══════════════════════════════════════════════════════════════════════════
unitTests();
const todo = SCENARIOS.filter(s => !ONLY.length || ONLY.some(f => s.name.includes(f)));
for (const s of todo) {
  process.stdout.write(`▶ ${s.name}\n`);
  run(s);
}

console.log(`\n${'─'.repeat(72)}`);
if (failed) {
  console.log(`FAILED — ${passed} assertion(s) passed, ${failed} FAILED:\n`);
  for (const p of problems) console.log(`  ✖ ${p}`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed across ${todo.length} scenario(s) and the link unit tests.`);
