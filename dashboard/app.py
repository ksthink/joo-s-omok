from flask import Flask, render_template, jsonify
import sqlite3
import os
import json

app = Flask(__name__,
            template_folder='templates',
            static_folder='static')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'game.db')
WEIGHTS_PATH = os.path.join(BASE_DIR, 'weights.json')
CONFIG_PATH = os.path.join(BASE_DIR, 'weights_config.json')

# ─── Load BASE_WEIGHTS from single source ────────────────────────────────────────
def load_config():
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None

_config = load_config()
BASE_WEIGHTS = _config['patterns'] if _config else {
    "OOOOO": 100000, "_OOOO_": 50000, "OOOO_": 10000, "_OOOO": 10000,
    "XOOOO_": 10000, "_OOOOX": 10000, "_OOO_": 5000, "OOO__": 1000,
    "__OOO": 1000, "_O_OO_": 1000, "_OO_O_": 1000, "OO_O_": 1000,
    "_O_OO": 1000, "OO__": 100, "__OO": 100, "_O_O_": 100, "_OO_": 100,
    "O__": 10, "__O": 10, "_O_": 10
}
LEARNING_CONFIG = (_config or {}).get('learning', {
    "min_games_threshold": 15
})

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def safe_query(query, params=(), fetchone=False):
    """Execute a query with proper connection cleanup."""
    conn = get_db()
    try:
        cursor = conn.execute(query, params)
        if fetchone:
            return cursor.fetchone()
        return cursor.fetchall()
    finally:
        conn.close()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/stats')
def get_stats():
    conn = get_db()
    try:
        total_games = conn.execute('SELECT COUNT(*) as count FROM game_records').fetchone()['count']
        player_wins = conn.execute('SELECT COUNT(*) as count FROM game_records WHERE winner = 1').fetchone()['count']
        ai_wins = conn.execute('SELECT COUNT(*) as count FROM game_records WHERE winner = 2').fetchone()['count']
        draws = conn.execute('SELECT COUNT(*) as count FROM game_records WHERE winner = 0').fetchone()['count']

        practice_games = conn.execute("SELECT COUNT(*) as count FROM game_records WHERE game_mode = 'practice'").fetchone()['count']
        challenge_games = conn.execute("SELECT COUNT(*) as count FROM game_records WHERE game_mode = 'challenge'").fetchone()['count']

        daily_stats = conn.execute('''
            SELECT date, COUNT(*) as count,
                   SUM(CASE WHEN winner = 1 THEN 1 ELSE 0 END) as player_wins
            FROM game_records
            GROUP BY date
            ORDER BY date DESC
            LIMIT 7
        ''').fetchall()
    finally:
        conn.close()

    win_rate = round((player_wins / total_games * 100), 1) if total_games > 0 else 0

    return jsonify({
        'total_games': total_games,
        'player_wins': player_wins,
        'ai_wins': ai_wins,
        'draws': draws,
        'win_rate': win_rate,
        'practice_games': practice_games,
        'challenge_games': challenge_games,
        'daily_stats': [dict(row) for row in daily_stats]
    })

@app.route('/api/patterns')
def get_patterns():
    conn = get_db()
    try:
        # Check if new columns exist
        cols = {r['name'] for r in conn.execute("PRAGMA table_info(pattern_stats)").fetchall()}
        has_new_cols = 'attack_weight' in cols

        if has_new_cols:
            cursor = conn.execute('''
                SELECT pattern, win_count, total_count, current_weight,
                       attack_weight, defense_weight,
                       attack_win_count, attack_total_count,
                       defense_win_count, defense_total_count
                FROM pattern_stats
                ORDER BY total_count DESC
            ''')
        else:
            cursor = conn.execute('''
                SELECT pattern, win_count, total_count, current_weight
                FROM pattern_stats
                ORDER BY total_count DESC
            ''')
        rows = cursor.fetchall()
    finally:
        conn.close()

    threshold = LEARNING_CONFIG.get('min_games_threshold', 15)
    patterns = []
    for row in rows:
        base_weight = BASE_WEIGHTS.get(row['pattern'], 0)
        total = row['total_count'] or 0
        status = '학습중' if total >= threshold else '대기'
        win_rate = round((row['win_count'] / total * 100), 1) if total > 0 else 0
        weight_change = round(((row['current_weight'] - base_weight) / base_weight * 100), 1) if base_weight > 0 else 0
        progress = min(100, round(total / threshold * 100)) if threshold > 0 else 0

        entry = {
            'pattern': row['pattern'],
            'win_count': row['win_count'],
            'total_count': total,
            'win_rate': win_rate,
            'base_weight': base_weight,
            'current_weight': row['current_weight'],
            'weight_change': weight_change,
            'status': status,
            'progress': progress,
            'threshold': threshold
        }

        if has_new_cols:
            atk_w = row['attack_weight'] or base_weight
            def_w = row['defense_weight'] or base_weight
            atk_total = row['attack_total_count'] or 0
            def_total = row['defense_total_count'] or 0
            atk_wins = row['attack_win_count'] or 0
            def_wins = row['defense_win_count'] or 0
            entry.update({
                'attack_weight': atk_w,
                'defense_weight': def_w,
                'attack_change': round(((atk_w - base_weight) / base_weight * 100), 1) if base_weight > 0 else 0,
                'defense_change': round(((def_w - base_weight) / base_weight * 100), 1) if base_weight > 0 else 0,
                'attack_total': atk_total,
                'defense_total': def_total,
                'attack_win_rate': round((atk_wins / atk_total * 100), 1) if atk_total > 0 else 0,
                'defense_win_rate': round((def_wins / def_total * 100), 1) if def_total > 0 else 0,
            })

        patterns.append(entry)

    return jsonify(patterns)

@app.route('/api/leaderboard')
def get_leaderboard():
    rows = safe_query('''
        SELECT name, score, level, stones, date
        FROM leaderboard ORDER BY score DESC LIMIT 20
    ''')
    return jsonify([dict(row) for row in rows])

@app.route('/api/games')
def get_games():
    rows = safe_query('''
        SELECT id, winner, game_mode, level, stone_count, date
        FROM game_records ORDER BY id DESC LIMIT 50
    ''')
    games = []
    for row in rows:
        winner_text = '플레이어 승' if row['winner'] == 1 else ('AI 승' if row['winner'] == 2 else '무승부')
        games.append({
            'id': row['id'], 'winner': row['winner'], 'winner_text': winner_text,
            'game_mode': row['game_mode'], 'level': row['level'],
            'stone_count': row['stone_count'], 'date': row['date']
        })
    return jsonify(games)

@app.route('/api/game/<int:game_id>')
def get_game(game_id):
    row = safe_query('''
        SELECT id, moves, winner, game_mode, level, stone_count, date
        FROM game_records WHERE id = ?
    ''', (game_id,), fetchone=True)

    if not row:
        return jsonify({'error': 'Game not found'}), 404

    moves = json.loads(row['moves']) if row['moves'] else []
    return jsonify({
        'id': row['id'], 'moves': moves, 'winner': row['winner'],
        'game_mode': row['game_mode'], 'level': row['level'],
        'stone_count': row['stone_count'], 'date': row['date']
    })

@app.route('/api/weight-history')
def get_weight_history():
    """Return weight change history for visualization."""
    conn = get_db()
    try:
        # Check if table exists
        tables = {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if 'weight_history' not in tables:
            return jsonify([])

        rows = conn.execute('''
            SELECT pattern, attack_weight, defense_weight, game_count, recorded_at
            FROM weight_history
            ORDER BY id DESC
            LIMIT 500
        ''').fetchall()
    finally:
        conn.close()

    return jsonify([dict(row) for row in rows])

@app.route('/api/composite-stats')
def get_composite_stats():
    """Return composite threat pattern statistics."""
    conn = get_db()
    try:
        tables = {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if 'composite_pattern_stats' not in tables:
            return jsonify([])

        rows = conn.execute('''
            SELECT pattern_type,
                   COUNT(*) as total,
                   SUM(CASE WHEN player = 1 THEN 1 ELSE 0 END) as player_count,
                   SUM(CASE WHEN player = 2 THEN 1 ELSE 0 END) as ai_count,
                   SUM(CASE WHEN resulted_in_win = 1 THEN 1 ELSE 0 END) as win_count
            FROM composite_pattern_stats
            GROUP BY pattern_type
            ORDER BY total DESC
        ''').fetchall()
    finally:
        conn.close()

    result = []
    for row in rows:
        total = row['total'] or 1
        result.append({
            'pattern_type': row['pattern_type'],
            'total': row['total'],
            'player_count': row['player_count'],
            'ai_count': row['ai_count'],
            'win_rate': round((row['win_count'] / total * 100), 1)
        })
    return jsonify(result)

@app.route('/api/learning-progress')
def get_learning_progress():
    """Return learning progress for each pattern."""
    conn = get_db()
    try:
        cols = {r['name'] for r in conn.execute("PRAGMA table_info(pattern_stats)").fetchall()}
        has_new = 'attack_total_count' in cols

        if has_new:
            rows = conn.execute('''
                SELECT pattern, total_count, attack_total_count, defense_total_count
                FROM pattern_stats ORDER BY total_count DESC
            ''').fetchall()
        else:
            rows = conn.execute('''
                SELECT pattern, total_count FROM pattern_stats ORDER BY total_count DESC
            ''').fetchall()
    finally:
        conn.close()

    threshold = LEARNING_CONFIG.get('min_games_threshold', 15)
    result = []
    for row in rows:
        total = row['total_count'] or 0
        entry = {
            'pattern': row['pattern'],
            'total': total,
            'threshold': threshold,
            'progress': min(100, round(total / threshold * 100)) if threshold > 0 else 0,
            'is_active': total >= threshold
        }
        if has_new:
            atk = row['attack_total_count'] or 0
            dfn = row['defense_total_count'] or 0
            entry['attack_progress'] = min(100, round(atk / threshold * 100)) if threshold > 0 else 0
            entry['defense_progress'] = min(100, round(dfn / threshold * 100)) if threshold > 0 else 0
        result.append(entry)

    return jsonify(result)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8082, debug=False)
