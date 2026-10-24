// Accounts: signing in with Discord or Google (Supabase Auth, the PKCE flow; the sign-in dialog),
// signing out, and the signed-in profile for the rest of the site (the header shows it: header.js). Signing in links this
// browser's player token to the account (account_link), so the server knows who plays from here;
// signing out unlinks it and starts a fresh token, so the next person on this browser is a guest.
// Rated games need an account; everything else works as a guest.
import { sb, rpc, forgetToken, report } from './net.js';
import { $, toast } from './util.js';

/** Where the page was when sign-in left for the provider (the redirect returns without a hash). */
const RETURN_KEY = 'kairos.authReturn';
const PROVIDERS = { discord: 'Discord', google: 'Google' };

const listeners = new Set();

export const account = {
  /** The signed-in profile ({user_id, name, rating, rd, provisional, games, imported}), or null. */
  profile: null,
  /** Whether the session check has finished (until then `profile` is unknown, not "guest"). */
  ready: false,
  /** Call `fn(profile)` whenever the account changes (and once it is known). */
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

function set(profile) {
  account.profile = profile;
  account.ready = true;
  for (const fn of listeners) fn(profile);
}

/** The profile changed here (renamed, a new bio): everyone hears of it. */
export function setProfile(profile) { if (profile) set(profile); }

/** A rating as the site shows it: 1500? while provisional. */
export function ratingText(rating, provisional) {
  if (rating == null) return '';
  return `${rating}${provisional ? '?' : ''}`;
}

/** A profile page's address. */
export function profileHref(userId) { return `#/player/${userId}`; }

export async function initAccount() {
  $('#acct-discord').onclick = () => signIn('discord');
  $('#acct-google').onclick = () => signIn('google');
  const c = sb();
  if (!c) return set(null);
  // Back from the provider: the client exchanged the code; put the page back where it was.
  const back = (() => { try { return sessionStorage.getItem(RETURN_KEY); } catch (e) { return null; } })();
  if (/[?&](code|error)=/.test(location.search)) {
    const err = new URLSearchParams(location.search).get('error_description');
    history.replaceState(null, '', location.pathname + (back || location.hash || '#/'));
    try { sessionStorage.removeItem(RETURN_KEY); } catch (e) { /* ignore */ }
    if (err) toast('Sign-in failed: ' + err, { error: true, ms: 8000 });
  }
  let session = null;
  try { session = (await c.auth.getSession()).data.session; } catch (e) { /* offline */ }
  c.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') link();
    else if (event === 'SIGNED_OUT') set(null);
  });
  if (session) await link();
  else set(null);
}

/** Link this browser to the signed-in account and load its profile. */
async function link() {
  try {
    set(await rpc('account_link'));
  } catch (e) {
    // A session the server refuses (expired, revoked): treat as signed out.
    if (e.user || /JWT|token/i.test(e.message)) { await sb().auth.signOut().catch(() => {}); set(null); }
    else if (!account.ready) set(null);
  }
}

/** Re-read the profile (after a rated game, say). */
export async function refreshAccount() {
  if (!account.profile) return;
  try {
    const p = await rpc('account_me');
    if (p) set(p);
  } catch (e) { /* keep the old one */ }
}

async function signIn(provider) {
  try { sessionStorage.setItem(RETURN_KEY, location.hash || '#/'); } catch (e) { /* ignore */ }
  const { error } = await sb().auth.signInWithOAuth({
    provider,
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) toast(`Could not sign in with ${PROVIDERS[provider]}: ${error.message}`, { error: true });
}

/** Sign out of this browser: it becomes a new guest. */
export async function signOut() {
  if (window.kairosApp && window.kairosApp.route === 'game' && !confirm('Signing out leaves the game on this page. Sign out anyway?')) return;
  try { await rpc('account_unlink'); } catch (e) { report(e); }
  await sb().auth.signOut().catch(() => {});
  // The next visitor of this browser is a new guest.
  forgetToken();
  location.reload();
}

/** The sign-in dialog (Discord or Google). */
export function openSignIn() {
  $('#dlg-account').showModal();
}
