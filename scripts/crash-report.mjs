// Engine crash reports to the admins' Discord channel: takes the reports browsers sent
// (public.engine_crashes_take, with the detector's key) and posts each one with the fair-play
// webhook. Run by .github/workflows/crash-report.yml, which the database starts; its logs are
// public, so this prints nothing.
//
//   FAIRPLAY_KEY=... FAIRPLAY_DISCORD_WEBHOOK=... node scripts/crash-report.mjs

const API = process.env.FAIRPLAY_API || 'https://iazwinlpwqcdamnybzll.supabase.co';
const PUBLISHABLE = 'sb_publishable_PTo_ji_9zGfGaIK1xKpLUw_fBA_7Jjk';
const SITE = 'https://fireplank.github.io/5d-chess-lab/';
const WEBHOOK = process.env.FAIRPLAY_DISCORD_WEBHOOK;

const r = await fetch(`${API}/rest/v1/rpc/engine_crashes_take`, {
  method: 'POST',
  headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${PUBLISHABLE}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_key: process.env.FAIRPLAY_KEY }),
});
if (!r.ok) throw new Error(`engine_crashes_take: HTTP ${r.status}`);
const crashes = await r.json();

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const code = (s, n) => `\`\`\`\n${clip(String(s).replace(/```/g, "'''"), n)}\n\`\`\``;

/** One crash as a Discord embed. */
function embed(c) {
  const x = c.context || {};
  const fields = [
    { name: 'Where', value: clip(`${x.stage || '?'} · ${x.page || '?'}${x.game ? ` · [game](${SITE}#/game/${x.game})` : ''}${x.ply != null ? ` · ply ${x.ply}` : ''}`, 1024), inline: false },
    { name: 'Player', value: c.user ? `[${c.name || 'account'}](${SITE}#/player/${c.user})` : 'guest', inline: true },
    { name: 'Engine', value: `${x.threads ?? '?'} threads · ${x.hashMb ?? '?'} MB · ${x.isolated ? 'isolated' : 'not isolated'}`, inline: true },
    { name: 'Build', value: x.build ? `[${x.build.slice(0, 7)}](https://github.com/FirePlank/5d-chess-lab/commit/${x.build})` : '?', inline: true },
    { name: 'Browser', value: clip(`${x.browser || '?'} · ${x.cores ?? '?'} cores · ${x.memory ?? '?'} GB`, 1024), inline: false },
  ];
  if (x.position) fields.push({ name: 'Position', value: code(x.position, 1000), inline: false });
  return {
    title: 'Engine crash',
    color: 0xe0a030,
    description: code(c.message, 2000),
    fields,
    timestamp: c.at,
  };
}

if (WEBHOOK) {
  // Discord takes up to 10 embeds a message.
  for (let i = 0; i < crashes.length; i += 10) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '5D Chess Lab crashes', allowed_mentions: { parse: [] }, embeds: crashes.slice(i, i + 10).map(embed) }),
    });
    if (!res.ok) throw new Error(`webhook: HTTP ${res.status}`);
  }
}
