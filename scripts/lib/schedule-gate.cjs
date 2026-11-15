// scripts/lib/schedule-gate.cjs
//
// THE SLOT DECISION, IN MELBOURNE TIME.
//
// GitHub cron is UTC and cannot follow daylight saving, so the workflow fires on
// `7,37 * * * *` — every half hour, all day, every day — and this module decides in
// Australia/Melbourne terms whether the slot is one that does work. An off-slot run
// exits immediately with one line in the log.
//
// The schedule, Melbourne local:
//   07:00–09:00   hourly        (the :07 slot only)
//   09:00–20:00   every 30 min  (both slots)
//   20:00–22:00   hourly        (the :07 slot only)
//   22:00–07:00   nothing
//
// ─── WHY Intl AND NOT AN OFFSET ──────────────────────────────────────────────
// Melbourne is UTC+10 in winter and UTC+11 in summer and the changeover dates move.
// Intl with an IANA zone is the only thing in Node that knows that without a
// dependency. It is asked for the LOCAL hour directly rather than being used to
// compute an offset — fewer steps, nothing to get wrong twice a year.
//
// ─── WHY THE SLOT ORDINAL IS A UTC HALF-HOUR INDEX ───────────────────────────
// The QUIET cadence counts slots. Counting them in local time would make the
// sequence jump by an hour twice a year, in the middle of a season. Every Australian
// timezone offset is a whole number of hours, so a UTC half-hour index is in lockstep
// with the local half hours all year and never skips or repeats. The local clock
// decides WHETHER to run; the UTC index decides WHICH slot number it is.

'use strict';

const ZONE = 'Australia/Melbourne';

/**
 * @param {Date} [now]
 * @returns {{run:boolean, why:string, local:string, hour:number, minute:number,
 *            half:'top'|'bottom', slotOrdinal:number, zone:string}}
 */
function slotDecision(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour12: false,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;

  // Some ICU builds render midnight as 24 under hour12:false. Normalise it, because
  // 24 would fall through every range below and silently never run.
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(p.minute, 10);

  const local = `${p.weekday} ${p.year}-${p.month}-${p.day} ${String(hour).padStart(2, '0')}:${p.minute} ${ZONE}`;
  const half = minute < 30 ? 'top' : 'bottom';

  // 1800000 ms = 30 minutes. Whole-hour zone offsets mean this index advances in
  // lockstep with the local half hours, DST included.
  const slotOrdinal = Math.floor(now.getTime() / 1800000);

  let run, why;
  if (hour < 7 || hour >= 22) {
    run = false; why = `${String(hour).padStart(2, '0')}:${p.minute} is inside the 22:00–07:00 quiet period`;
  } else if (hour < 9) {
    run = half === 'top'; why = run ? 'hourly window 07:00–09:00' : 'hourly window 07:00–09:00 — this is the half-past slot';
  } else if (hour < 20) {
    run = true; why = 'half-hourly window 09:00–20:00';
  } else {
    run = half === 'top'; why = run ? 'hourly window 20:00–22:00' : 'hourly window 20:00–22:00 — this is the half-past slot';
  }

  return { run, why, local, hour, minute, half, slotOrdinal, zone: ZONE };
}

module.exports = { slotDecision, ZONE };
