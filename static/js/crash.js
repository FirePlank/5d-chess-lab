// Engine crash reports: when Kairos fails in a browser (its worker can't start, a search traps,
// or an online game's search keeps failing), what happened goes to the server
// (public.engine_crash_report), which has the admins' Discord channel told
// (scripts/crash-report.mjs). Nothing personal: the message, where it happened, the browser.
import { query } from './net.js';
import { browserPrint } from './fairplay.js';

/** The same failure is reported once a minute at most from a page. */
const REPEAT_MS = 60_000;
const last = new Map();
let version = null;

/** Report a crash: {message, stage, position?, game?, ply?, threads?, hashMb?, shared?}. */
export async function reportCrash(info) {
  const message = String(info.message || 'unknown').slice(0, 1000);
  const now = Date.now();
  if (now - (last.get(message) || 0) < REPEAT_MS) return;
  last.set(message, now);
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
  } catch (e) { /* a report is best effort */ }
}
