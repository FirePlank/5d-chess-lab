// Signed actions for an online game's broadcast (online.js): a player's page shows its action to
// the game's other pages at once, before the database has it, and signs it so that no one else
// (a spectator, another tab) can show a false one. Each page makes an ECDSA P-256 key for the
// game (its private half never leaves the page; game_key puts the public half on the game's row),
// and signs "<game>|<ply>|<action>". The database's own update confirms the action either way.

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const message = (game, ply, lan) => new TextEncoder().encode(`${game}|${ply}|${lan}`);

/** A new key: {privateKey (not extractable), pub: the public half, base64url}. */
export async function newKey() {
  const k = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
  return { privateKey: k.privateKey, pub: b64(await crypto.subtle.exportKey('raw', k.publicKey)) };
}

/** The signature of action `lan` at `ply` of `game`. */
export async function sign(key, game, ply, lan) {
  return b64(await crypto.subtle.sign(SIG, key.privateKey, message(game, ply, lan)));
}

const imported = new Map();

/** Whether `sig` is `pub`'s signature of action `lan` at `ply` of `game`. */
export async function verify(pub, sig, game, ply, lan) {
  try {
    if (!imported.has(pub)) imported.set(pub, crypto.subtle.importKey('raw', unb64(pub), ALG, false, ['verify']));
    return await crypto.subtle.verify(SIG, await imported.get(pub), unb64(sig), message(game, ply, lan));
  } catch (e) {
    return false;
  }
}
