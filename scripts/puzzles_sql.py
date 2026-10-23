"""Turn puzzlegen's site export (one puzzle per line, JSONL) into Supabase migrations that load
the puzzles into public.puzzles, a file per ~1 MB. A puzzle already there gets the export's line,
steps and themes (a newer export: trimmed lines, say) and keeps its rating and plays; a later
export goes in as migrations with a new timestamp.

    python scripts/puzzles_sql.py <site_puzzles.jsonl> <timestamp, e.g. 20261024100100>
"""
import json
import sys
from pathlib import Path

CHUNK = 1_000_000

HEAD = """-- Puzzles {first}-{last} of {total} from Kairos's puzzle generator (scripts/puzzles_sql.py).
insert into public.puzzles (id, rating, rd, initial_rating, side, outcome, themes, position, mate_in,
  ends_in_mate, solution, steps)
select p->>'id', (p->>'rating')::real, 250, (p->>'rating')::integer,
  case p->>'side' when 'white' then 1 else 2 end, p->>'outcome',
  array(select jsonb_array_elements_text(p->'themes')), p->>'position', (p->>'mate_in')::smallint,
  coalesce((p->>'ends_in_mate')::boolean, false), p->'solution', p->'steps'
from jsonb_array_elements($puzzles$
"""
TAIL = """
$puzzles$::jsonb) p
on conflict (id) do update set side = excluded.side, outcome = excluded.outcome, themes = excluded.themes,
  position = excluded.position, mate_in = excluded.mate_in, ends_in_mate = excluded.ends_in_mate,
  solution = excluded.solution, steps = excluded.steps;
"""


def main(src, stamp):
    keep = ('id', 'rating', 'side', 'outcome', 'themes', 'position', 'mate_in', 'ends_in_mate', 'solution', 'steps')
    rows = []
    for line in open(src, encoding='utf-8'):
        if line.strip():
            p = json.loads(line)
            rows.append(json.dumps({k: p.get(k) for k in keep}, separators=(',', ':')))
    out = Path(__file__).resolve().parent.parent / 'supabase' / 'migrations'
    chunks, cur, size = [], [], 0
    for r in rows:
        if cur and size + len(r) > CHUNK:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(r)
        size += len(r)
    if cur:
        chunks.append(cur)
    n = 0
    for i, c in enumerate(chunks):
        body = '[\n' + ',\n'.join(c) + '\n]'
        assert '$puzzles$' not in body
        name = out / f'{int(stamp) + i}_puzzles_data_{i + 1:02d}.sql'
        name.write_text(HEAD.format(first=n + 1, last=n + len(c), total=len(rows)) + body + TAIL, encoding='utf-8', newline='\n')
        n += len(c)
        print(name.name, len(c), 'puzzles')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
