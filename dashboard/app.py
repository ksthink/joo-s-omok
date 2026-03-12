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
CLUSTER_PATTERNS = (_config or {}).get('cluster_patterns', {
    "three_way_up": {"weight": 3000, "name": "ㅗ", "desc": "삼방향 위"},
    "three_way_down": {"weight": 3000, "name": "ㅜ", "desc": "삼방향 아래"},
    "three_way_left": {"weight": 3000, "name": "ㅓ", "desc": "삼방향 왼쪽"},
    "three_way_right": {"weight": 3000, "name": "ㅏ", "desc": "삼방향 오른쪽"},
    "cross_plus": {"weight": 5000, "name": "+", "desc": "십자가"},
    "cross_x": {"weight": 5000, "name": "X", "desc": "대각선 십자"},
    "corner_l_1": {"weight": 2000, "name": "┌", "desc": "왼쪽 위 코너"},
    "corner_l_2": {"weight": 2000, "name": "┐", "desc": "오른쪽 위 코너"},
    "corner_l_3": {"weight": 2000, "name": "└", "desc": "왼쪽 아래 코너"},
    "corner_l_4": {"weight": 2000, "name": "┘", "desc": "오른쪽 아래 코너"},
    "t_shape_1": {"weight": 2500, "name": "T", "desc": "T자 위"},
    "t_shape_2": {"weight": 2500, "name": "⊥", "desc": "T자 아래"}
})
CLUSTER_CONNECTION_PATTERNS = (_config or {}).get('cluster_connection_patterns', {
    "nearby_threes": {"weight": 4000, "desc": "두 열린3이 근접"},
    "bridge_threat": {"weight": 8000, "desc": "한 수로 두 패턴 연결"},
    "supporting_threat": {"weight": 3000, "desc": "한 패턴이 다른 패턴 지원"},
    "pincer_threat": {"weight": 3500, "desc": "두 패턴이 상대 협공"}
})
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
        SELECT id, winner, game_mode, level, stone_count, date, time
        FROM game_records ORDER BY id DESC LIMIT 50
    ''')
    games = []
    mode_map = {'practice': '연습게임', 'challenge': '챌린지', 'tested': 'AI테스트'}
    for row in rows:
        if row['winner'] == -1:
            winner_text = 'AI테스트'
        elif row['winner'] == 1:
            winner_text = '플레이어 승'
        else:
            winner_text = 'AI 승'
        games.append({
            'id': row['id'], 'winner': row['winner'], 'winner_text': winner_text,
            'game_mode': mode_map.get(row['game_mode'], row['game_mode']),
            'level': row['level'],
            'stone_count': row['stone_count'], 'date': row['date'], 'time': row['time'] or ''
        })
    return jsonify(games)

@app.route('/api/game/<int:game_id>')
def get_game(game_id):
    row = safe_query('''
        SELECT id, moves, winner, game_mode, level, stone_count, date, time
        FROM game_records WHERE id = ?
    ''', (game_id,), fetchone=True)

    if not row:
        return jsonify({'error': 'Game not found'}), 404

    mode_map = {'practice': '연습게임', 'challenge': '챌린지', 'tested': 'AI테스트'}
    moves = json.loads(row['moves']) if row['moves'] else []
    return jsonify({
        'id': row['id'], 'moves': moves, 'winner': row['winner'],
        'game_mode': mode_map.get(row['game_mode'], row['game_mode']),
        'level': row['level'],
        'stone_count': row['stone_count'], 'date': row['date'], 'time': row['time'] or ''
    })

PATTERNS = [
    "OOOOO", "_OOOO_", "OOOO_", "_OOOO", "XOOOO_", "_OOOOX",
    "_OOO_", "OOO__", "__OOO", "_O_OO_", "_OO_O_", "OO_O_", "_O_OO",
    "OO__", "__OO", "_O_O_", "_OO_", "O__", "__O", "_O_"
]

def get_line_for_pattern(board, row, col, dr, dc, player):
    size = len(board)
    line = ''
    positions = []
    for k in range(-4, 5):
        r = row + dr * k
        c = col + dc * k
        if r < 0 or r >= size or c < 0 or c >= size:
            line += 'X'
        elif board[r][c] == player:
            line += 'O'
        elif board[r][c] == 0:
            line += '_'
        else:
            line += 'X'
        positions.append((r, c))
    return line, positions

def find_patterns_on_board(board, player):
    size = len(board)
    found_patterns = []
    directions = [(0, 1, 'horizontal'), (1, 0, 'vertical'), (1, 1, 'diagonal'), (1, -1, 'anti-diagonal')]
    checked = set()

    for i in range(size):
        for j in range(size):
            if board[i][j] != player:
                continue
            for dr, dc, dir_name in directions:
                line, positions = get_line_for_pattern(board, i, j, dr, dc, player)
                for pattern in PATTERNS:
                    idx = 0
                    while True:
                        found_idx = line.find(pattern, idx)
                        if found_idx == -1:
                            break
                        first_o_idx = pattern.find('O')
                        last_o_idx = pattern.rfind('O')
                        start_pos = positions[found_idx + first_o_idx]
                        end_pos = positions[found_idx + last_o_idx]
                        key = (pattern, start_pos, end_pos, dir_name)
                        if key not in checked:
                            checked.add(key)
                            found_patterns.append({
                                'pattern': pattern,
                                'player': player,
                                'direction': dir_name,
                                'start': {'row': start_pos[0], 'col': start_pos[1]},
                                'end': {'row': end_pos[0], 'col': end_pos[1]}
                            })
                        idx = found_idx + 1
    return found_patterns

def find_composite_threat_lines(board, row, col, player):
    directions = [(0, 1, 'horizontal'), (1, 0, 'vertical'), (1, 1, 'diagonal'), (1, -1, 'anti-diagonal')]
    open_four_lines = []
    blocked_four_lines = []
    open_three_lines = []

    for dr, dc, dir_name in directions:
        line, positions = get_line_for_pattern(board, row, col, dr, dc, player)
        if '_OOOO_' in line:
            idx = line.find('_OOOO_')
            start_pos = positions[idx + 1]
            end_pos = positions[idx + 4]
            open_four_lines.append({
                'pattern': '_OOOO_',
                'player': player,
                'direction': dir_name,
                'start': {'row': start_pos[0], 'col': start_pos[1]},
                'end': {'row': end_pos[0], 'col': end_pos[1]}
            })
        elif 'OOOO' in line:
            idx = line.find('OOOO')
            start_pos = positions[idx]
            end_pos = positions[idx + 3]
            blocked_four_lines.append({
                'pattern': 'OOOO',
                'player': player,
                'direction': dir_name,
                'start': {'row': start_pos[0], 'col': start_pos[1]},
                'end': {'row': end_pos[0], 'col': end_pos[1]}
            })
        if '_OOO_' in line:
            idx = line.find('_OOO_')
            start_pos = positions[idx + 1]
            end_pos = positions[idx + 3]
            open_three_lines.append({
                'pattern': '_OOO_',
                'player': player,
                'direction': dir_name,
                'start': {'row': start_pos[0], 'col': start_pos[1]},
                'end': {'row': end_pos[0], 'col': end_pos[1]}
            })

    composite_type = None
    composite_lines = []

    if open_four_lines >= 2 or (len(open_four_lines) >= 1 and len(blocked_four_lines) >= 1):
        composite_type = 'double_four'
        composite_lines = open_four_lines + blocked_four_lines
    elif len(blocked_four_lines) >= 1 and len(open_three_lines) >= 1:
        composite_type = 'four_three'
        composite_lines = blocked_four_lines + open_three_lines
    elif len(open_three_lines) >= 2:
        composite_type = 'double_open_three'
        composite_lines = open_three_lines

    return composite_type, composite_lines

@app.route('/api/game/<int:game_id>/patterns')
def get_game_patterns(game_id):
    row = safe_query('SELECT moves FROM game_records WHERE id = ?', (game_id,), fetchone=True)
    if not row:
        return jsonify({'error': 'Game not found'}), 404

    moves = json.loads(row['moves']) if row['moves'] else []
    board = [[0] * 15 for _ in range(15)]
    all_patterns = []
    composite_pattern_keys = set()

    for i, move in enumerate(moves):
        r, c, p = move['row'], move['col'], move['player']
        if 0 <= r < 15 and 0 <= c < 15:
            board[r][c] = p
            patterns = find_patterns_on_board(board, p)
            for pat in patterns:
                pat['move_index'] = i
            all_patterns.extend(patterns)

            composite_type, composite_lines = find_composite_threat_lines(board, r, c, p)
            if composite_type:
                for line in composite_lines:
                    line['move_index'] = i
                    line['is_composite'] = True
                    line['composite_type'] = composite_type
                    key = (line['pattern'], line['player'], line['direction'],
                           line['start']['row'], line['start']['col'],
                           line['end']['row'], line['end']['col'])
                    composite_pattern_keys.add(key)

    seen = set()
    unique_patterns = []
    for p in all_patterns:
        key = (p['pattern'], p['player'], p['direction'], p['start']['row'], p['start']['col'], p['end']['row'], p['end']['col'])
        if key not in seen:
            seen.add(key)
            if key in composite_pattern_keys:
                p['is_composite'] = True
            unique_patterns.append(p)

    return jsonify({'patterns': unique_patterns})

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

@app.route('/api/cluster-weights')
def get_cluster_weights():
    """Return cluster pattern weights for AI."""
    conn = get_db()
    try:
        tables = {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        
        cluster_patterns = {}
        cluster_connections = {}
        
        if 'cluster_pattern_stats' in tables:
            rows = conn.execute('''
                SELECT pattern_id, attack_weight, defense_weight, win_count, total_count
                FROM cluster_pattern_stats
            ''').fetchall()
            for row in rows:
                cluster_patterns[row['pattern_id']] = {
                    'attack_weight': row['attack_weight'],
                    'defense_weight': row['defense_weight'],
                    'wins': row['win_count'],
                    'total': row['total_count']
                }
        
        if 'cluster_connection_stats' in tables:
            rows = conn.execute('''
                SELECT connection_type, attack_weight, defense_weight, win_count, total_count
                FROM cluster_connection_stats
            ''').fetchall()
            for row in rows:
                cluster_connections[row['connection_type']] = {
                    'attack_weight': row['attack_weight'],
                    'defense_weight': row['defense_weight'],
                    'wins': row['win_count'],
                    'total': row['total_count']
                }
    finally:
        conn.close()
    
    return jsonify({
        'cluster_patterns': cluster_patterns,
        'cluster_connections': cluster_connections
    })

@app.route('/api/cluster-stats')
def get_cluster_stats():
    """Return cluster pattern statistics."""
    conn = get_db()
    try:
        tables = {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if 'cluster_pattern_stats' not in tables:
            return jsonify([])
        
        rows = conn.execute('''
            SELECT pattern_id,
                   win_count, total_count,
                   attack_weight, defense_weight,
                   attack_win_count, attack_total_count,
                   defense_win_count, defense_total_count
            FROM cluster_pattern_stats
            ORDER BY total_count DESC
        ''').fetchall()
    finally:
        conn.close()
    
    result = []
    for row in rows:
        total = row['total_count'] or 1
        entry = {
            'pattern_id': row['pattern_id'],
            'name': CLUSTER_PATTERNS.get(row['pattern_id'], {}).get('name', row['pattern_id']),
            'desc': CLUSTER_PATTERNS.get(row['pattern_id'], {}).get('desc', ''),
            'total': row['total_count'],
            'wins': row['win_count'],
            'win_rate': round((row['win_count'] / total * 100), 1) if total > 0 else 0,
            'attack_weight': row['attack_weight'],
            'defense_weight': row['defense_weight'],
            'attack_wins': row['attack_win_count'],
            'attack_total': row['attack_total_count'],
            'defense_wins': row['defense_win_count'],
            'defense_total': row['defense_total_count']
        }
        result.append(entry)
    
    return jsonify(result)

@app.route('/api/cluster-connection-stats')
def get_cluster_connection_stats():
    """Return cluster connection pattern statistics."""
    conn = get_db()
    try:
        tables = {r['name'] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if 'cluster_connection_stats' not in tables:
            return jsonify([])
        
        rows = conn.execute('''
            SELECT connection_type,
                   win_count, total_count,
                   attack_weight, defense_weight,
                   attack_win_count, attack_total_count,
                   defense_win_count, defense_total_count
            FROM cluster_connection_stats
            ORDER BY total_count DESC
        ''').fetchall()
    finally:
        conn.close()
    
    result = []
    for row in rows:
        total = row['total_count'] or 1
        entry = {
            'connection_type': row['connection_type'],
            'desc': CLUSTER_CONNECTION_PATTERNS.get(row['connection_type'], {}).get('desc', ''),
            'total': row['total_count'],
            'wins': row['win_count'],
            'win_rate': round((row['win_count'] / total * 100), 1) if total > 0 else 0,
            'attack_weight': row['attack_weight'],
            'defense_weight': row['defense_weight'],
            'attack_wins': row['attack_win_count'],
            'attack_total': row['attack_total_count'],
            'defense_wins': row['defense_win_count'],
            'defense_total': row['defense_total_count']
        }
        result.append(entry)
    
    return jsonify(result)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8082, debug=False)
