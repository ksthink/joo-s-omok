"""Create the Postgres tables and fill them.

    DATABASE_URL=postgresql://... python tools/db_setup.py [game.db]

Applies schema.sql, copies every table from the old SQLite file when one is
given (only into empty tables, so re-running never duplicates rows), then adds
any base pattern from weights_config.json that is still missing.
"""
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from db import get_db  # noqa: E402

TABLES = ['leaderboard', 'game_records', 'pattern_stats', 'weight_history',
          'composite_pattern_stats', 'cluster_pattern_stats', 'cluster_connection_stats']
IDENTITY_TABLES = ['leaderboard', 'game_records', 'weight_history', 'composite_pattern_stats']


def copy_sqlite(conn, path):
    src = sqlite3.connect(path)
    src.row_factory = sqlite3.Row
    for table in TABLES:
        if conn.execute(f'SELECT EXISTS (SELECT 1 FROM {table}) AS e').fetchone()['e']:
            print(f'{table}: not empty, skipped')
            continue
        rows = src.execute(f'SELECT * FROM {table}').fetchall()
        if rows:
            cols = rows[0].keys()
            conn.cursor().executemany(
                f'INSERT INTO {table} ({", ".join(cols)}) VALUES ({", ".join(["%s"] * len(cols))})',
                [tuple(r) for r in rows])
        print(f'{table}: {len(rows)} rows copied')
    for table in IDENTITY_TABLES:
        conn.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                     f"COALESCE((SELECT MAX(id) FROM {table}), 0) + 1, false)")


def seed(conn):
    with open(os.path.join(ROOT, 'weights_config.json'), encoding='utf-8') as f:
        config = json.load(f)
    for pattern, w in config['patterns'].items():
        conn.execute('''
            INSERT INTO pattern_stats (pattern, current_weight, attack_weight, defense_weight)
            VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING
        ''', (pattern, w, w, w))
    for table, key, items in (('cluster_pattern_stats', 'pattern_id', config.get('cluster_patterns', {})),
                              ('cluster_connection_stats', 'connection_type', config.get('cluster_connection_patterns', {}))):
        for k, info in items.items():
            w = info.get('weight', 1000) if isinstance(info, dict) else info
            conn.execute(f'''
                INSERT INTO {table} ({key}, attack_weight, defense_weight)
                VALUES (%s, %s, %s) ON CONFLICT DO NOTHING
            ''', (k, w, w))


def main():
    with get_db() as conn:
        with open(os.path.join(ROOT, 'schema.sql'), encoding='utf-8') as f:
            conn.execute(f.read())
        if len(sys.argv) > 1:
            copy_sqlite(conn, sys.argv[1])
        seed(conn)
    print('done')


if __name__ == '__main__':
    main()
