from flask import Flask, request, jsonify, send_from_directory
import sqlite3
import os
import json
from datetime import datetime
from functools import wraps

app = Flask(__name__, static_folder='.')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'game.db')
WEIGHTS_PATH = os.path.join(BASE_DIR, 'weights.json')
CONFIG_PATH = os.path.join(BASE_DIR, 'weights_config.json')

# ─── Load BASE_WEIGHTS from single source ───────────────────────────────────────
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
COMPOSITE_PATTERNS = (_config or {}).get('composite_patterns', {
    "double_open_three": 30000, "four_three": 40000, "double_four": 90000
})
LEARNING_CONFIG = (_config or {}).get('learning', {
    "min_games_threshold": 15, "ema_old_weight": 0.85, "ema_new_weight": 0.15,
    "min_weight_ratio": 0.3, "max_weight_ratio": 3.0, "win_multiplier": 1.5
})
PHASE_CONFIG = (_config or {}).get('phases', {
    "opening": {"max_move": 10}, "midgame": {"max_move": 30}, "endgame": {"max_move": 225}
})

# ─── Database ────────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    try:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS leaderboard (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                score INTEGER NOT NULL,
                level INTEGER NOT NULL,
                stones INTEGER NOT NULL,
                date TEXT NOT NULL
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS game_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                moves TEXT NOT NULL,
                winner INTEGER NOT NULL,
                game_mode TEXT,
                level INTEGER,
                stone_count INTEGER,
                date TEXT
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS pattern_stats (
                pattern TEXT PRIMARY KEY,
                win_count INTEGER DEFAULT 0,
                total_count INTEGER DEFAULT 0,
                current_weight REAL,
                attack_weight REAL,
                defense_weight REAL,
                attack_win_count INTEGER DEFAULT 0,
                attack_total_count INTEGER DEFAULT 0,
                defense_win_count INTEGER DEFAULT 0,
                defense_total_count INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS weight_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern TEXT NOT NULL,
                attack_weight REAL,
                defense_weight REAL,
                game_count INTEGER,
                recorded_at TEXT
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS composite_pattern_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern_type TEXT NOT NULL,
                game_id INTEGER,
                move_number INTEGER,
                player INTEGER,
                resulted_in_win INTEGER DEFAULT 0
            )
        ''')

        # Migrate old pattern_stats if columns are missing
        _migrate_pattern_stats(conn)

        # Insert base patterns
        for pattern, weight in BASE_WEIGHTS.items():
            conn.execute('''
                INSERT OR IGNORE INTO pattern_stats
                (pattern, win_count, total_count, current_weight, attack_weight, defense_weight,
                 attack_win_count, attack_total_count, defense_win_count, defense_total_count)
                VALUES (?, 0, 0, ?, ?, ?, 0, 0, 0, 0)
            ''', (pattern, weight, weight, weight))

        conn.commit()
    finally:
        conn.close()

    if not os.path.exists(WEIGHTS_PATH):
        save_weights_to_file()

def _migrate_pattern_stats(conn):
    """Add new columns to pattern_stats if they don't exist (migration)."""
    cursor = conn.execute("PRAGMA table_info(pattern_stats)")
    existing_cols = {row['name'] for row in cursor.fetchall()}
    new_cols = {
        'attack_weight': 'REAL',
        'defense_weight': 'REAL',
        'attack_win_count': 'INTEGER DEFAULT 0',
        'attack_total_count': 'INTEGER DEFAULT 0',
        'defense_win_count': 'INTEGER DEFAULT 0',
        'defense_total_count': 'INTEGER DEFAULT 0',
    }
    for col, col_type in new_cols.items():
        if col not in existing_cols:
            conn.execute(f'ALTER TABLE pattern_stats ADD COLUMN {col} {col_type}')
    # Backfill attack/defense weights from current_weight for existing rows
    conn.execute('''
        UPDATE pattern_stats SET attack_weight = current_weight
        WHERE attack_weight IS NULL
    ''')
    conn.execute('''
        UPDATE pattern_stats SET defense_weight = current_weight
        WHERE defense_weight IS NULL
    ''')
    conn.commit()

# ─── Weights File I/O ────────────────────────────────────────────────────────────
def load_weights_from_file():
    try:
        with open(WEIGHTS_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"version": 2, "last_updated": datetime.now().isoformat(), "patterns": {}}

def save_weights_to_file():
    conn = get_db()
    try:
        cursor = conn.execute('''
            SELECT pattern, current_weight, attack_weight, defense_weight,
                   win_count, total_count, attack_win_count, attack_total_count,
                   defense_win_count, defense_total_count
            FROM pattern_stats
        ''')
        rows = cursor.fetchall()
    finally:
        conn.close()

    weights_data = {
        "version": 2,
        "last_updated": datetime.now().isoformat(),
        "learning_config": LEARNING_CONFIG,
        "patterns": {}
    }

    for row in rows:
        weights_data["patterns"][row['pattern']] = {
            "weight": row['current_weight'],
            "attack_weight": row['attack_weight'],
            "defense_weight": row['defense_weight'],
            "wins": row['win_count'],
            "total": row['total_count'],
            "attack_wins": row['attack_win_count'],
            "attack_total": row['attack_total_count'],
            "defense_wins": row['defense_win_count'],
            "defense_total": row['defense_total_count']
        }

    with open(WEIGHTS_PATH, 'w', encoding='utf-8') as f:
        json.dump(weights_data, f, indent=2, ensure_ascii=False)

# ─── Pattern Extraction ──────────────────────────────────────────────────────────
def get_game_phase(move_number):
    if move_number <= PHASE_CONFIG['opening']['max_move']:
        return 'opening'
    if move_number <= PHASE_CONFIG['midgame']['max_move']:
        return 'midgame'
    return 'endgame'

def get_region(row, col):
    if 5 <= row <= 9 and 5 <= col <= 9:
        return 'center'
    if row <= 2 or row >= 12 or col <= 2 or col >= 12:
        return 'edge'
    return 'mid'

def extract_patterns_from_moves(moves, target_player):
    """Extract patterns for a specific player from the game moves."""
    patterns = set()
    board = [[0] * 15 for _ in range(15)]

    for i, move in enumerate(moves):
        player = move.get('player', 1 if i % 2 == 0 else 2)
        row, col = move['row'], move['col']
        if not (0 <= row < 15 and 0 <= col < 15):
            continue
        board[row][col] = player

        if player == target_player:
            patterns.update(extract_patterns_at(board, row, col, player))

    return patterns

def extract_composite_patterns(moves, target_player):
    """Detect composite threat patterns (쌍삼, 사삼, 쌍사) from moves."""
    composites = []
    board = [[0] * 15 for _ in range(15)]

    for i, move in enumerate(moves):
        player = move.get('player', 1 if i % 2 == 0 else 2)
        row, col = move['row'], move['col']
        if not (0 <= row < 15 and 0 <= col < 15):
            continue
        board[row][col] = player

        if player == target_player:
            composite = detect_composite_at(board, row, col, player)
            if composite:
                composites.append({
                    'type': composite,
                    'move_number': i + 1,
                    'player': player
                })

    return composites

def detect_composite_at(board, row, col, player):
    """Check if placing at (row,col) creates a composite threat."""
    directions = [(0, 1), (1, 0), (1, 1), (1, -1)]
    open_fours = 0
    blocked_fours = 0
    open_threes = 0

    for dr, dc in directions:
        line = get_line_pattern(board, row, col, dr, dc, player)
        if '_OOOO_' in line:
            open_fours += 1
        elif 'OOOO' in line:
            blocked_fours += 1
        if '_OOO_' in line:
            open_threes += 1

    if open_fours >= 2 or (open_fours >= 1 and blocked_fours >= 1):
        return 'double_four'
    if blocked_fours >= 1 and open_threes >= 1:
        return 'four_three'
    if open_threes >= 2:
        return 'double_open_three'
    return None

def extract_patterns_at(board, row, col, player):
    patterns = set()
    directions = [(0, 1), (1, 0), (1, 1), (1, -1)]

    for dr, dc in directions:
        line = get_line_pattern(board, row, col, dr, dc, player)
        for pattern in BASE_WEIGHTS.keys():
            if pattern in line:
                patterns.add(pattern)

    return patterns

def get_line_pattern(board, row, col, dr, dc, player):
    size = len(board)
    line = ''
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
    return line

# ─── Bidirectional Weight Updates ────────────────────────────────────────────────
def update_pattern_weights(patterns, perspective, is_win):
    """
    Update pattern weights bidirectionally.
    perspective: 'attack' or 'defense'
    is_win: True if this perspective's patterns contributed to a win
    """
    conn = get_db()
    try:
        threshold = LEARNING_CONFIG['min_games_threshold']
        ema_old = LEARNING_CONFIG['ema_old_weight']
        ema_new = LEARNING_CONFIG['ema_new_weight']
        min_ratio = LEARNING_CONFIG['min_weight_ratio']
        max_ratio = LEARNING_CONFIG['max_weight_ratio']
        win_mult = LEARNING_CONFIG['win_multiplier']

        win_col = f'{perspective}_win_count'
        total_col = f'{perspective}_total_count'
        weight_col = f'{perspective}_weight'

        for pattern in patterns:
            conn.execute(f'''
                UPDATE pattern_stats
                SET {win_col} = {win_col} + ?,
                    {total_col} = {total_col} + 1,
                    win_count = win_count + ?,
                    total_count = total_count + 1
                WHERE pattern = ?
            ''', (1 if is_win else 0, 1 if is_win else 0, pattern))

        # Recalculate weights for patterns that have enough data
        cursor = conn.execute(f'''
            SELECT pattern, {win_col}, {total_col}, {weight_col}
            FROM pattern_stats
        ''')
        rows = cursor.fetchall()

        for row in rows:
            pattern = row['pattern']
            win_count = row[win_col] or 0
            total_count = row[total_col] or 0
            current_w = row[weight_col]
            base_weight = BASE_WEIGHTS.get(pattern, 1000)

            if current_w is None:
                current_w = base_weight

            if total_count >= threshold:
                raw_weight = (win_count / total_count) * base_weight * win_mult
                new_weight = current_w * ema_old + raw_weight * ema_new
                min_weight = base_weight * min_ratio
                max_weight = base_weight * max_ratio
                new_weight = max(min_weight, min(new_weight, max_weight))

                conn.execute(f'''
                    UPDATE pattern_stats SET {weight_col} = ?, current_weight = ? WHERE pattern = ?
                ''', (new_weight, new_weight, pattern))

        # Record weight history
        game_count = conn.execute('SELECT COUNT(*) as c FROM game_records').fetchone()['c']
        now = datetime.now().isoformat()
        cursor2 = conn.execute('SELECT pattern, attack_weight, defense_weight FROM pattern_stats')
        for row in cursor2.fetchall():
            conn.execute('''
                INSERT INTO weight_history (pattern, attack_weight, defense_weight, game_count, recorded_at)
                VALUES (?, ?, ?, ?, ?)
            ''', (row['pattern'], row['attack_weight'], row['defense_weight'], game_count, now))

        conn.commit()
    finally:
        conn.close()

    save_weights_to_file()

# ─── CORS Decorator ──────────────────────────────────────────────────────────────
def cross_origin(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        response = f(*args, **kwargs)
        if isinstance(response, tuple):
            resp = response[0]
        else:
            resp = response
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response
    return decorated_function

# ─── Input Validation Helpers ────────────────────────────────────────────────────
def sanitize_name(name):
    if not isinstance(name, str):
        return '익명'
    name = name.strip()[:20]
    return name if name else '익명'

def validate_int(value, default, min_val=None, max_val=None):
    try:
        v = int(value)
        if min_val is not None and v < min_val:
            return default
        if max_val is not None and v > max_val:
            return default
        return v
    except (TypeError, ValueError):
        return default

# ─── API Routes ──────────────────────────────────────────────────────────────────
@app.route('/api/leaderboard', methods=['GET', 'OPTIONS'])
@cross_origin
def get_leaderboard():
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    conn = get_db()
    try:
        cursor = conn.execute(
            'SELECT name, score, level, stones, date FROM leaderboard ORDER BY score DESC LIMIT 10'
        )
        rows = cursor.fetchall()
    finally:
        conn.close()

    return jsonify([{
        'name': row['name'], 'score': row['score'],
        'level': row['level'], 'stones': row['stones'], 'date': row['date']
    } for row in rows])

@app.route('/api/leaderboard', methods=['POST', 'OPTIONS'])
@cross_origin
def save_score():
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    data = request.json
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    name = sanitize_name(data.get('name', '익명'))
    score = validate_int(data.get('score'), 0, min_val=0, max_val=999999)
    level = validate_int(data.get('level'), 1, min_val=1, max_val=10)
    stones = validate_int(data.get('stones'), 0, min_val=0, max_val=500)
    date = data.get('date')
    if not date or not isinstance(date, str) or len(date) > 20:
        date = datetime.now().strftime('%Y-%m-%d')

    conn = get_db()
    try:
        conn.execute(
            'INSERT INTO leaderboard (name, score, level, stones, date) VALUES (?, ?, ?, ?, ?)',
            (name, score, level, stones, date)
        )
        conn.commit()
    finally:
        conn.close()

    return jsonify({'success': True})

@app.route('/api/game-record', methods=['POST', 'OPTIONS'])
@cross_origin
def save_game_record():
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    data = request.json
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    moves = data.get('moves', [])
    winner = validate_int(data.get('winner'), 0, min_val=0, max_val=2)
    game_mode = data.get('gameMode', 'practice')
    if game_mode not in ('practice', 'challenge'):
        game_mode = 'practice'
    level = validate_int(data.get('level'), 1, min_val=1, max_val=10)

    # Validate moves structure
    valid_moves = []
    for m in moves:
        if isinstance(m, dict) and 'row' in m and 'col' in m:
            r = validate_int(m.get('row'), -1, min_val=0, max_val=14)
            c = validate_int(m.get('col'), -1, min_val=0, max_val=14)
            if r >= 0 and c >= 0:
                valid_moves.append({
                    'row': r, 'col': c,
                    'player': validate_int(m.get('player'), 0, min_val=0, max_val=2)
                })
    moves = valid_moves
    stone_count = len(moves)
    date = datetime.now().strftime('%Y-%m-%d')

    # Save game record
    conn = get_db()
    try:
        cursor = conn.execute(
            'INSERT INTO game_records (moves, winner, game_mode, level, stone_count, date) VALUES (?, ?, ?, ?, ?, ?)',
            (json.dumps(moves), winner, game_mode, level, stone_count, date)
        )
        game_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    # Skip learning for outlier games
    if stone_count < 9 or stone_count > 225:
        return jsonify({'success': True, 'learned': False, 'reason': 'outlier'})

    learned_info = {'attack_patterns': 0, 'defense_patterns': 0, 'composites': 0}

    if winner == 1:
        # Player won: strengthen defense weights for player patterns,
        # weaken attack weights for AI patterns
        player_patterns = extract_patterns_from_moves(moves, target_player=1)
        ai_patterns = extract_patterns_from_moves(moves, target_player=2)

        if player_patterns:
            update_pattern_weights(player_patterns, perspective='defense', is_win=True)
            learned_info['defense_patterns'] = len(player_patterns)
        if ai_patterns:
            update_pattern_weights(ai_patterns, perspective='attack', is_win=False)
            learned_info['attack_patterns'] = len(ai_patterns)

    elif winner == 2:
        # AI won: strengthen attack weights for AI patterns
        ai_patterns = extract_patterns_from_moves(moves, target_player=2)
        if ai_patterns:
            update_pattern_weights(ai_patterns, perspective='attack', is_win=True)
            learned_info['attack_patterns'] = len(ai_patterns)

        # Also record player defense failures
        player_patterns = extract_patterns_from_moves(moves, target_player=1)
        if player_patterns:
            update_pattern_weights(player_patterns, perspective='defense', is_win=False)
            learned_info['defense_patterns'] = len(player_patterns)

    # Extract and save composite patterns
    for p in (1, 2):
        composites = extract_composite_patterns(moves, target_player=p)
        if composites:
            conn2 = get_db()
            try:
                for c in composites:
                    conn2.execute('''
                        INSERT INTO composite_pattern_stats (pattern_type, game_id, move_number, player, resulted_in_win)
                        VALUES (?, ?, ?, ?, ?)
                    ''', (c['type'], game_id, c['move_number'], c['player'], 1 if winner == p else 0))
                conn2.commit()
                learned_info['composites'] += len(composites)
            finally:
                conn2.close()

    return jsonify({
        'success': True,
        'learned': True,
        'attack_patterns': learned_info['attack_patterns'],
        'defense_patterns': learned_info['defense_patterns'],
        'composites': learned_info['composites']
    })

@app.route('/api/weights', methods=['GET', 'OPTIONS'])
@cross_origin
def get_weights():
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    weights_data = load_weights_from_file()

    if not weights_data.get('patterns'):
        conn = get_db()
        try:
            cursor = conn.execute('SELECT pattern, current_weight, attack_weight, defense_weight FROM pattern_stats')
            rows = cursor.fetchall()
        finally:
            conn.close()

        weights_data['patterns'] = {}
        for row in rows:
            weights_data['patterns'][row['pattern']] = {
                'weight': row['current_weight'],
                'attack_weight': row['attack_weight'],
                'defense_weight': row['defense_weight']
            }

    return jsonify(weights_data)

@app.route('/api/weights/reset', methods=['POST', 'OPTIONS'])
@cross_origin
def reset_weights():
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    conn = get_db()
    try:
        for pattern, weight in BASE_WEIGHTS.items():
            conn.execute('''
                UPDATE pattern_stats
                SET win_count = 0, total_count = 0, current_weight = ?,
                    attack_weight = ?, defense_weight = ?,
                    attack_win_count = 0, attack_total_count = 0,
                    defense_win_count = 0, defense_total_count = 0
                WHERE pattern = ?
            ''', (weight, weight, weight, pattern))
        conn.commit()
    finally:
        conn.close()

    save_weights_to_file()
    return jsonify({'success': True, 'message': 'Weights reset to defaults'})

# ─── Static File Serving ─────────────────────────────────────────────────────────
ALLOWED_EXTENSIONS = {'.html', '.js', '.css', '.woff2', '.wav', '.json', '.png', '.ico'}

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory('.', path)

if __name__ == '__main__':
    init_db()
    app.run(host='0.0.0.0', port=8081, debug=False)
