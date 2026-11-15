// scripts/fixture-watch-daemon.js
//
// THE LOOP. One Actions job that stays alive and runs a check every N minutes,
// instead of depending on GitHub delivering a cron fire every N minutes.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// MEASURED 2026-11-15/16 on this repo: a `7,37 * * * *` schedule delivered TWO
// fires out of an expected EIGHTEEN overnight, and one of those landed at 02:51 —
// neither :07 nor :37. GitHub's scheduler drops most fires on a high-frequency
// cron and shifts the ones it keeps. Two checks a day is not a watcher.
//
// So the cron is demoted to a STARTER, not the clock. One fire a day is enough to
// begin the loop, and a daily schedule is far more likely to be delivered than a
// half-hourly one. The loop itself keeps the cadence, and it keeps it exactly.
//
// ─── WHY IT SPAWNS RATHER THAN IMPORTS ───────────────────────────────────────
// Each pass is `node scripts/fixture-watch.js --force` in a FRESH PROCESS. That is
// deliberate:
//   · the watcher is already proven end to end; wrapping it in a loop in-process
//     would mean restructuring it and re-proving it;
//   · a fresh process means a FRESH PLAYHQ SESSION every pass, so the ~290-call
//     session budget and the 15-minute session age can never accumulate across a
//     five-hour job;
//   · a pass that dies — any reason at all — costs that pass and nothing else. The
//     loop records it and carries on. One CloudFront block must not end the day.
//
// ─── THE 6-HOUR CAP ──────────────────────────────────────────────────────────
// A job on a GitHub-hosted runner is capped at 6 hours
// (https://docs.github.com/en/actions/reference/limits). The active day is 15 hours,
// so the workflow runs FOUR legs chained with `needs:`, each given a wall-clock
// Melbourne end time. Chained jobs live in ONE workflow run (capped at 35 days), so
// there is no dispatch between them: nothing to lose, no PAT, no chain to break.
// A later leg runs on `always() && !cancelled()` so a failed leg does not cost the
// rest of the day.
//
// ─── WHAT IT GUARANTEES, AND WHAT IT DOES NOT ────────────────────────────────
// It does NOT make GitHub reliable. If the daily fire is dropped too, the watchdog
// workflow is the backstop: it runs on the old half-hourly cron and, whenever a
// fire IS delivered and no daemon is running, it performs one check directly. So
// the worst case degrades to exactly today's behaviour rather than to nothing.
//
// USAGE
//   node scripts/fixture-watch-daemon.js --until=14:00 [--interval=30]
//                                        [--budget-min=330] [--pass-args="--dry-run"]
//     --until        Melbourne wall-clock HH:MM at which this leg stops. Required.
//     --interval     minutes between passes (default 30)
//     --budget-min   hard stop after this many minutes of wall time, whatever
//                    --until says. Protects the 6-hour job cap. Default 330.
//     --pass-args    extra arguments handed to each pass, e.g. "--dry-run"

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  melbourneParts, melbourneMinutes, ZONE, ACTIVE_FROM_H, ACTIVE_TO_H,
} = require('./lib/schedule-gate.cjs');

const ROOT   = path.join(__dirname, '..');
const WATCH  = path.join(__dirname, 'fixture-watch.js');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a === undefined ? dflt : a.slice(name.length + 3).trim();
};

const UNTIL = argOf('until', '');
const INTERVAL_MIN = (() => { const n = parseInt(argOf('interval', '30'), 10); return Number.isFinite(n) && n >= 1 ? n : 30; })();
const BUDGET_MIN   = (() => { const n = parseInt(argOf('budget-min', '330'), 10); return Number.isFinite(n) && n >= 1 ? n : 330; })();
const PASS_ARGS    = (argOf('pass-args', '') || '').split(/\s+/).filter(Boolean);

const m = /^(\d{1,2}):(\d{2})$/.exec(UNTIL);
if (!m) { console.error('FATAL: --until=HH:MM is required (Melbourne wall clock), e.g. --until=14:00'); process.exit(2); }
const UNTIL_H = parseInt(m[1], 10), UNTIL_M = parseInt(m[2], 10);
const UNTIL_MINS = UNTIL_H * 60 + UNTIL_M;
if (UNTIL_H > 24 || UNTIL_M > 59) { console.error(`FATAL: --until=${UNTIL} is not a valid time`); process.exit(2); }

const ACTIVE_FROM = ACTIVE_FROM_H * 60;
const ACTIVE_TO   = ACTIVE_TO_H * 60;

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
const stamp = () => melbourneParts().label;

(async () => {
  const startedMs = Date.now();
  console.log('═'.repeat(78));
  console.log(`fixture-watch daemon — leg until ${UNTIL} ${ZONE}`);
  console.log(`  started:   ${stamp()}`);
  console.log(`  interval:  every ${INTERVAL_MIN} min`);
  console.log(`  budget:    ${BUDGET_MIN} min of wall time (the job cap is 360)`);
  console.log(`  active:    ${String(ACTIVE_FROM_H).padStart(2, '0')}:00–${ACTIVE_TO_H}:00`);
  if (PASS_ARGS.length) console.log(`  pass args: ${PASS_ARGS.join(' ')}`);
  console.log('═'.repeat(78));

  let passes = 0, failed = 0, lastExit = 0;

  for (;;) {
    const elapsedMin = (Date.now() - startedMs) / 60000;
    if (elapsedMin >= BUDGET_MIN) {
      console.log(`\n[daemon] ${stamp()} — wall-time budget of ${BUDGET_MIN} min reached. Ending this leg so the job cannot hit the 6-hour cap mid-pass.`);
      break;
    }

    const nowMins = melbourneMinutes();

    // Past this leg's end time. The next leg in the chain takes over.
    if (nowMins >= UNTIL_MINS) {
      console.log(`\n[daemon] ${stamp()} — reached ${UNTIL}. Ending this leg.`);
      break;
    }

    // After the active window: nothing more happens today, whatever --until says.
    if (nowMins >= ACTIVE_TO) {
      console.log(`\n[daemon] ${stamp()} — past ${ACTIVE_TO_H}:00, the day is over. Ending this leg.`);
      break;
    }

    // Before the active window: wait it out rather than burning passes on no-ops.
    // Bounded by this leg's end and by the budget, so an early start can never
    // sleep past its own deadline.
    if (nowMins < ACTIVE_FROM) {
      const waitMin = Math.min(
        ACTIVE_FROM - nowMins,
        UNTIL_MINS - nowMins,
        Math.max(0, BUDGET_MIN - elapsedMin),
      );
      console.log(`\n[daemon] ${stamp()} — before ${String(ACTIVE_FROM_H).padStart(2, '0')}:00. Sleeping ${Math.round(waitMin)} min.`);
      await sleep(waitMin * 60000);
      continue;
    }

    // ── one pass ────────────────────────────────────────────────────────────
    passes++;
    console.log(`\n${'─'.repeat(78)}\n[daemon] pass ${passes} — ${stamp()}\n${'─'.repeat(78)}`);
    // --force because the DAEMON owns the window decision. Without it the child
    // would re-apply its own gate, and a boundary disagreement between the two
    // would show up as a silent no-op that looks identical to "nothing changed".
    const r = spawnSync(process.execPath, [WATCH, '--force', ...PASS_ARGS], {
      cwd: ROOT, stdio: 'inherit',
    });
    lastExit = r.status == null ? 1 : r.status;
    if (r.error) { console.log(`[daemon] pass ${passes} could not be started: ${r.error.message}`); failed++; }
    else if (lastExit !== 0) { console.log(`[daemon] pass ${passes} exited ${lastExit} — recorded, continuing. One bad pass must not end the day.`); failed++; }

    // ── sleep to the next interval boundary ─────────────────────────────────
    // Aligned to the wall clock so passes land on predictable minutes and a slow
    // pass does not push every later one later.
    const after = melbourneMinutes();
    const nextBoundary = (Math.floor(after / INTERVAL_MIN) + 1) * INTERVAL_MIN;
    const stopAt = Math.min(UNTIL_MINS, ACTIVE_TO);
    if (nextBoundary >= stopAt) {
      console.log(`\n[daemon] ${stamp()} — next pass would be at or past ${String(Math.floor(stopAt / 60)).padStart(2, '0')}:${String(stopAt % 60).padStart(2, '0')}. Ending this leg.`);
      break;
    }
    const waitMin = Math.min(nextBoundary - after, Math.max(0, BUDGET_MIN - (Date.now() - startedMs) / 60000));
    console.log(`\n[daemon] next pass in ${Math.round(waitMin)} min (at ${String(Math.floor(nextBoundary / 60)).padStart(2, '0')}:${String(nextBoundary % 60).padStart(2, '0')} ${ZONE})`);
    await sleep(waitMin * 60000);
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`[daemon] leg finished ${stamp()} — ${passes} pass(es), ${failed} failed, ${Math.round((Date.now() - startedMs) / 60000)} min of wall time.`);
  console.log('═'.repeat(78));

  // A leg that had a failed pass is RED, so it is visible — but it has already run
  // every other pass, and the next leg runs regardless (`always() && !cancelled()`).
  if (failed) {
    console.error(`FAILED: ${failed} of ${passes} pass(es) exited non-zero. Each one is reported above with its own reason; state for anything PlayHQ did not answer was left untouched.`);
    process.exit(1);
  }
  if (passes === 0) console.log('[daemon] no passes were due in this leg.');
  console.log('Done.');
})().catch(err => {
  console.error(`\nFATAL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
