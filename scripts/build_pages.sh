#!/usr/bin/env bash
# Assemble the static site (GitHub Pages) in $1 (default _site): static/, the browser build of
# the Kairos core (`cargo wasm`), and the game records in games/ with an index
# (games/files.json). Everything runs in the browser; no server.
set -euo pipefail
cd "$(dirname "$0")/.."
out=${1:-_site}
wasm=target/wasm32-wasip1-threads/release/kairos_wasm.wasm
[ -f "$wasm" ] || { echo "missing $wasm: run cargo wasm" >&2; exit 1; }
rm -rf "$out"
mkdir -p "$out"
cp -r static/. "$out"/
cp "$wasm" "$out/kairos.wasm"
mkdir -p "$out/games"
cp -r games/. "$out/games"/
"${PYTHON:-python3}" - "$out/games" <<'PY'
import json, os, sys
root = sys.argv[1]
files = []
for d, _, names in os.walk(root):
    for n in sorted(names):
        if not n.endswith(('.jsonl', '.5dpgn')):
            continue
        p = os.path.join(d, n)
        rel = os.path.relpath(p, root).replace(os.sep, '/')
        st = os.stat(p)
        files.append({'id': rel, 'name': n, 'dir': os.path.dirname(rel) or 'games', 'size': st.st_size, 'mtime': int(st.st_mtime)})
files.sort(key=lambda f: f['id'])
with open(os.path.join(root, 'files.json'), 'w') as f:
    json.dump({'ok': True, 'files': files}, f)
print(f'{len(files)} record files')
PY
# The build, shown in the header: the site's commit, and the engine commit Cargo.lock pins
# (games played in the browser record it, as the engine version they were played against).
sha=${GITHUB_SHA:-$(git rev-parse HEAD)}
repo=${GITHUB_REPOSITORY:-FirePlank/5d-chess-lab}
engine=$(sed -n '/^name = "kairos"$/,/^$/s/^source = ".*#\([0-9a-f]*\)"$/\1/p' Cargo.lock)
"${PYTHON:-python3}" - "$out/version.json" "$sha" "$repo" "$(git show -s --format=%cI "$sha" 2>/dev/null || true)" "$(git show -s --format=%s "$sha" 2>/dev/null || true)" "$engine" <<'PY'
import json, sys
out, sha, repo, date, subject, engine = sys.argv[1:7]
json.dump({
    'sha': sha, 'date': date, 'subject': subject, 'url': f'https://github.com/{repo}/commit/{sha}',
    'engine': {'sha': engine, 'url': f'https://github.com/FirePlank/5d-chess-engine/commit/{engine}'} if engine else None,
}, open(out, 'w'))
PY
touch "$out/.nojekyll"
echo "site in $out (engine ${engine:0:7})"
