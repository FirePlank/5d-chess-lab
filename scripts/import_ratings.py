"""scripts/import_ratings.py ratings.csv > import.sql: the 5D community's ratings as SQL that
loads them into private.rating_import (paste it into the Supabase SQL editor; don't commit the
list or the SQL). A player signing in with a Discord account found there starts from its rating.

The CSV has a header row; columns (any order, extra ones ignored):
    discord_id   the Discord user id (a snowflake, digits)        required
    rating       the rating                                       required
    name         a name, for reference                            optional
    rd           Glicko deviation; empty: from `games`            optional
    vol          Glicko-2 volatility; empty: 0.09                 optional
    games        games played (sets the deviation when rd is empty: 100+ games 60, 30+ 80,
                 10+ 110, fewer 200, unknown 150)                 optional

Re-running updates players who haven't claimed their rating yet and leaves claimed ones alone.
"""
import csv
import sys


def num(v, kind=float):
    v = (v or '').strip()
    return kind(v) if v else None


def sql(v):
    if v is None:
        return 'null'
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(path):
    rows = []
    with open(path, newline='', encoding='utf-8-sig') as f:
        for i, r in enumerate(csv.DictReader(f), start=2):
            r = {k.strip().lower(): v for k, v in r.items() if k}
            did = (r.get('discord_id') or '').strip()
            if not did.isdigit():
                sys.exit(f'line {i}: discord_id {did!r} is not a Discord id')
            rating = num(r.get('rating'))
            if rating is None or not 100 <= rating <= 4000:
                sys.exit(f'line {i}: rating {r.get("rating")!r} is missing or out of range')
            rd = num(r.get('rd'))
            if rd is not None and not 45 <= rd <= 500:
                sys.exit(f'line {i}: rd {rd} outside 45..500')
            rows.append((did, (r.get('name') or '').strip()[:64] or None, rating, rd, num(r.get('vol')), num(r.get('games'), int)))
    print('-- The 5D community ratings (scripts/import_ratings.py): %d players.' % len(rows))
    print('insert into private.rating_import (discord_id, name, rating, rd, vol, games) values')
    print(',\n'.join('  (%s)' % ', '.join(sql(v) for v in row) for row in rows))
    print('on conflict (discord_id) do update set name = excluded.name, rating = excluded.rating, rd = excluded.rd,')
    print('  vol = excluded.vol, games = excluded.games')
    print('  where private.rating_import.claimed_by is null;')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
