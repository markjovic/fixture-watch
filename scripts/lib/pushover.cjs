// scripts/lib/pushover.cjs
//
// Pushover delivery, and the message budget.
//
// ⚠️ PUSHOVER'S HARD LIMIT IS 1024 CHARACTERS and it does not fail politely — a
// longer message is rejected or silently cut. Every message built here is capped,
// and when lines are dropped the message SAYS how many were dropped. A truncated
// alert that does not admit it is a lie about the fixture.
//
// ⚠️ A FAILED SEND IS A FAILURE. It returns false and the caller goes red. An alert
// nobody received is not an alert, and the whole point of this repo is the phone
// buzzing.

'use strict';

const API = 'https://api.pushover.net/1/messages.json';

/**
 * Build a message body from lines, capped, with an honest tail when it overflows.
 * @param {string[]} lines
 * @param {number} maxChars
 */
function buildBody(lines, maxChars) {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cost = line.length + 1;
    // Reserve room for the "…and N more" tail before deciding this line fits.
    const remaining = lines.length - i;
    const tail = remaining > 1 ? `\n…and ${remaining} more` : '';
    if (used + cost + tail.length > maxChars) {
      out.push(`…and ${remaining} more`);
      return out.join('\n');
    }
    out.push(line);
    used += cost;
  }
  return out.join('\n');
}

/**
 * @param {object} o
 * @param {string} o.token
 * @param {string} o.user
 * @param {string} o.title
 * @param {string} o.message
 * @param {string} [o.url]
 * @param {string} [o.urlTitle]
 * @param {number} [o.priority]  -1 quiet, 0 normal, 1 high
 * @param {boolean} [o.dryRun]
 * @returns {Promise<{ok:boolean, status:number, detail:string}>}
 */
async function send(o) {
  if (o.dryRun) {
    console.log(`  [dry-run] PUSHOVER priority ${o.priority ?? 0} — ${o.title}`);
    console.log(o.message.split('\n').map(l => `    | ${l}`).join('\n'));
    if (o.url) console.log(`    | ${o.urlTitle || 'link'}: ${o.url}`);
    return { ok: true, status: 0, detail: 'dry-run' };
  }

  if (!o.token || !o.user) {
    return { ok: false, status: 0, detail: 'PUSHOVER_TOKEN or PUSHOVER_USER is empty — the secret is missing from the repo or not passed to the job' };
  }

  const form = new URLSearchParams();
  form.set('token', o.token);
  form.set('user', o.user);
  form.set('title', o.title.slice(0, 250));
  form.set('message', o.message.slice(0, 1024));
  if (o.url) { form.set('url', o.url); form.set('url_title', (o.urlTitle || 'Open').slice(0, 100)); }
  if (o.priority != null) form.set('priority', String(o.priority));

  let res, text;
  try {
    res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    text = await res.text().catch(() => '');
  } catch (err) {
    return { ok: false, status: 0, detail: `network: ${err.message}` };
  }

  if (res.status === 200) return { ok: true, status: 200, detail: 'sent' };
  return { ok: false, status: res.status, detail: `HTTP ${res.status}: ${(text || '').slice(0, 200)}` };
}

module.exports = { send, buildBody };
