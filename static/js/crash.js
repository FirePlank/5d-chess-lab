// Engine crash reports: when Kairos fails in a browser (its worker can't start, a search traps,
// or an online game's search keeps failing), what happened goes to the server
// (public.engine_crash_report), which has the admins' Discord channel told
// (scripts/crash-report.mjs). Nothing personal: the message, where it happened, the browser.
// The player is told (a toast) that Kairos crashed and that the crash was reported.
import { query } from './net.js';
import { browserPrint } from './fairplay.js';
import { toast } from './util.js';

/** The same failure is reported once a minute at most from a page. */
const REPEAT_MS = 60_000;
const last = new Map();
let version = null;

/**
 * Report a crash: {message, stage, position?, game?, ply?, threads?, hashMb?, shared?}. Tells the
 * player unless `notify` is false (a caller that says it itself). Resolves whether the report
 * reached the server (false for a repeat within a minute, which isn't sent).
 */
export async function reportCrash(info, { notify = true } = {}) {
  const message = String(info.message || 'unknown').slice(0, 1000);
  const now = Date.now();
  if (now - (last.get(message) || 0) < REPEAT_MS) return false;
  last.set(message, now);
  const sent = await send(info, message);
  if (notify) {
    const what = info.stage === 'start' ? 'Kairos failed to start in this browser' : 'Kairos crashed and was restarted';
    toast(`${what}. ${sent ? 'A crash report was sent so it can be fixed.' : 'The crash report could not be sent.'}`, { error: true, ms: 7000 });
  }
  return sent;
}

async function send(info, message) {
  try {
    if (!version) version = fetch('version.json').then((r) => r.json()).then((v) => v.sha).catch(() => null);
    const n = navigator;
    await query('engine_crash_report', {
      p_message: message,
      p_context: {
        stage: info.stage || null,
        page: location.hash.split('?')[0] || '#/',
        game: info.game || null,
        ply: info.ply ?? null,
        position: info.position ? String(info.position).slice(0, 4000) : null,
        threads: info.threads ?? null,
        hashMb: info.hashMb ?? null,
        isolated: !!self.crossOriginIsolated,
        build: await version,
        browser: n.userAgent,
        cores: n.hardwareConcurrency || null,
        memory: n.deviceMemory || null,
      },
      p_fp: await browserPrint(),
    });
    return true;
  } catch (e) {
    return false;
  }
}
