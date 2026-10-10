"""Create the Postgres tables and fill them.

    DATABASE_URL=postgresql://... python tools/db_setup.py [game.db]

Applies schema.sql, then copies the leaderboard and game records from an old
SQLite file when one is given (only into empty tables, so re-running never
duplicates rows).
"""
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from db import get_db  # noqa: E402

COLUMNS = {
    'leaderboard': ['id', 'name', 'score', 'level', 'stones', 'date'],
    'game_records': ['id', 'moves', 'winner', 'game_mode', 'level', 'stone_count', 'date', 'time'],
}


def copy_sqlite(conn, path):
    src = sqlite3.connect(path)
    for table, cols in COLUMNS.items():
        if conn.execute(f'SELECT EXISTS (SELECT 1 FROM {table}) AS e').fetchone()['e']:
            print(f'{table}: not empty, skipped')
            continue
        rows = src.execute(f'SELECT {", ".join(cols)} FROM {table}').fetchall()
        conn.cursor().executemany(
            f'INSERT INTO {table} ({", ".join(cols)}) VALUES ({", ".join(["%s"] * len(cols))})', rows)
        conn.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                     f"COALESCE((SELECT MAX(id) FROM {table}), 0) + 1, false)")
        print(f'{table}: {len(rows)} rows copied')


def main():
    with get_db() as conn:
        with open(os.path.join(ROOT, 'schema.sql'), encoding='utf-8') as f:
            conn.execute(f.read())
        if len(sys.argv) > 1:
            copy_sqlite(conn, sys.argv[1])
    print('done')


if __name__ == '__main__':
    main()
