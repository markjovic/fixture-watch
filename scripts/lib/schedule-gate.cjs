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
//   07:00–22:00   every fire does work
//   22:00–07:00   nothing
//
// ─── WHY THERE IS NO LONGER A TOP/BOTTOM-OF-HOUR DISTINCTION ─────────────────
// The original spec was hourly in 07:00–09:00 and 20:00–22:00 and half-hourly in
// between, implemented by accepting only the :07 fire in the hourly windows.
// That assumed GitHub delivers both fires. MEASURED 2026-11-15/16: it does not.
// Overnight, two fires were delivered out of an expected eighteen, and one of them
// landed at 02:51 — neither :07 nor :37. Delivery is sparse AND time-shifted.
//
// Under that behaviour, rejecting a fire for being "the half-past slot" can throw
// away the ONLY fire in an hour. A delivery we decline is not replaced. So every
// fire inside the active window now does work, and the hourly windows are hourly
// only in the sense that GitHub happens to deliver that often.
//
// The cost if GitHub ever becomes reliable again is about eight extra checks a day
// in those two windows. That is the safe direction — more checking, never less.
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
 * Melbourne wall-clock parts for an instant. The one place Intl is called.
 * @param {Date} [now]
 * @returns {{hour:number, minute:number, weekday:string, date:string, label:string}}
 */
function melbourneParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hour12: false,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  // Some ICU builds render midnight as 24 under hour12:false. Normalise it, or it
  // falls through every hour range and the gate silently never opens.
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(p.minute, 10);
  return {
    hour, minute,
    weekday: p.weekday,
    date: `${p.year}-${p.month}-${p.day}`,
    label: `${p.weekday} ${p.year}-${p.month}-${p.day} ${String(hour).padStart(2, '0')}:${p.minute} ${ZONE}`,
  };
}

/** Milliseconds from `now` until the next Melbourne wall-clock HH:MM. */
function msUntilMelbourne(hh, mm, now = new Date()) {
  const { hour, minute } = melbourneParts(now);
  let mins = (hh * 60 + mm) - (hour * 60 + minute);
  if (mins < 0) mins += 24 * 60;          // it is tomorrow
  // Align to the start of the current minute so repeated calls do not drift.
  return mins * 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
}

/** Melbourne minutes-since-midnight, for comparing against a wall-clock target. */
function melbourneMinutes(now = new Date()) {
  const { hour, minute } = melbourneParts(now);
  return hour * 60 + minute;
}

/**
 * @param {Date} [now]
 * @returns {{run:boolean, why:string, local:string, hour:number, minute:number,
 *            half:'top'|'bottom', slotOrdinal:number, zone:string}}
 */
function slotDecision(now = new Date()) {
  const { hour, minute, label: local } = melbourneParts(now);
  const half = minute < 30 ? 'top' : 'bottom';

  // 1800000 ms = 30 minutes. Whole-hour zone offsets mean this index advances in
  // lockstep with the local half hours, DST included.
  const slotOrdinal = Math.floor(now.getTime() / 1800000);

  let run, why;
  if (hour < 7 || hour >= 22) {
    run = false; why = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} is inside the 22:00–07:00 quiet period`;
  } else {
    run = true; why = 'inside the 07:00–22:00 active window — every delivered fire does work';
  }

  return { run, why, local, hour, minute, half, slotOrdinal, zone: ZONE };
}

module.exports = { slotDecision, melbourneParts, melbourneMinutes, msUntilMelbourne, ZONE, ACTIVE_FROM_H: 7, ACTIVE_TO_H: 22 };
