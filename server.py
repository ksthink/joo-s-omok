from flask import Flask, request, jsonify, send_from_directory
import os
import json
import logging
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from functools import wraps
from zoneinfo import ZoneInfo

from db import get_db

# Configure logging
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')

# Serverless hosts (Vercel) have a read-only filesystem: log to stdout only there.
_log_handlers = [logging.StreamHandler()]
try:
    os.makedirs(LOG_DIR, exist_ok=True)
    _log_handlers.insert(0, logging.FileHandler(os.path.join(LOG_DIR, 'server.log')))
except OSError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=_log_handlers
)
logger = logging.getLogger('omok_server')

KST = ZoneInfo('Asia/Seoul')

def get_kst_date():
    return datetime.now(KST).strftime('%Y-%m-%d')

def get_kst_time():
    return datetime.now(KST).strftime('%H:%M:%S')

def get_kst_datetime():
    return datetime.now(KST)

app = Flask(__name__, static_folder='.')

# Learning dashboard: /dashboard (page) and /dashboard/api/* (its data)
from dashboard.app import bp as dashboard_bp  # noqa: E402
app.register_blueprint(dashboard_bp, url_prefix='/dashboard')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
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

WIN_CONDITION_PATTERNS = {'OOOOO'}

SIMPLE_PATTERNS = {'O__', '__O', '_O_'}
COMPOSITE_PATTERNS = (_config or {}).get('composite_patterns', {
    "double_open_three": 30000, "four_three": 40000, "double_four": 90000
})
CLUSTER_PATTERNS = (_config or {}).get('cluster_patterns', {})
CLUSTER_CONNECTION_PATTERNS = (_config or {}).get('cluster_connection_patterns', {})
LEARNING_CONFIG = (_config or {}).get('learning', {
    "min_games_threshold": 15, "ema_old_weight": 0.85, "ema_new_weight": 0.15,
    "min_weight_ratio": 0.3, "max_weight_ratio": 3.0, "win_multiplier": 1.5
})
PHASE_CONFIG = (_config or {}).get('phases', {
    "opening": {"max_move": 10}, "midgame": {"max_move": 30}, "endgame": {"max_move": 225}
})

# ─── Learning ────────────────────────────────────────────────────────────────────
# Tables live in Postgres (schema.sql). Every learning function takes the open
# connection of the request so one game is learned over a single connection.

def _bounded_weight(current_w, win_rate, base_weight, att_weight, def_weight, perspective, penalty=1.0):
    """EMA step toward the observed win rate, kept within the base-weight ratio
    bounds and within max_weight_ratio of the other perspective's weight."""
    min_ratio = LEARNING_CONFIG['min_weight_ratio']
    max_ratio = LEARNING_CONFIG['max_weight_ratio']
    raw_weight = win_rate * base_weight * LEARNING_CONFIG['win_multiplier'] * penalty
    new_weight = current_w * LEARNING_CONFIG['ema_old_weight'] + raw_weight * LEARNING_CONFIG['ema_new_weight']
    min_weight = base_weight * min_ratio
    max_weight = base_weight * max_ratio

    other_weight = def_weight if perspective == 'attack' else att_weight
    if other_weight and other_weight > base_weight * min_ratio:
        if perspective == 'attack':
            max_weight = min(max_weight, other_weight * max_ratio)
        else:
            min_weight = max(min_weight, other_weight / max_ratio)

    return max(min_weight, min(new_weight, max_weight))

def _count_results(conn, table, key_col, keys, perspective, is_win):
    win_col = f'{perspective}_win_count'
    total_col = f'{perspective}_total_count'
    for key in keys:
        conn.execute(f'''
            UPDATE {table}
            SET {win_col} = {win_col} + %s,
                {total_col} = {total_col} + 1,
                win_count = win_count + %s,
                total_count = total_count + 1
            WHERE {key_col} = %s
        ''', (1 if is_win else 0, 1 if is_win else 0, key))

def update_cluster_weights(conn, table, key_col, keys, base_info, perspective, is_win):
    """Update cluster pattern or cluster connection weights with ratio bounds."""
    if not keys:
        return

    _count_results(conn, table, key_col, keys, perspective, is_win)

    rows = conn.execute(f'''
        SELECT {key_col} AS key, attack_weight, defense_weight,
               {perspective}_win_count AS wins, {perspective}_total_count AS total
        FROM {table}
    ''').fetchall()

    for row in rows:
        info = base_info.get(row['key'], {})
        base_weight = info.get('weight', 1000) if isinstance(info, dict) else 1000
        att_weight = row['attack_weight'] if row['attack_weight'] is not None else base_weight
        def_weight = row['defense_weight'] if row['defense_weight'] is not None else base_weight

        total_count = row['total'] or 0
        if total_count < LEARNING_CONFIG['min_games_threshold']:
            continue

        current_w = att_weight if perspective == 'attack' else def_weight
        new_weight = _bounded_weight(current_w, (row['wins'] or 0) / total_count, base_weight,
                                     att_weight, def_weight, perspective)
        conn.execute(f'UPDATE {table} SET {perspective}_weight = %s WHERE {key_col} = %s',
                     (new_weight, row['key']))

def weights_payload(conn):
    """Pattern weights in the shape ai.js loads (formerly weights.json)."""
    rows = conn.execute('''
        SELECT pattern, current_weight, attack_weight, defense_weight,
               win_count, total_count, attack_win_count, attack_total_count,
               defense_win_count, defense_total_count
        FROM pattern_stats
    ''').fetchall()
    last = conn.execute('SELECT MAX(recorded_at) AS t FROM weight_history').fetchone()['t']

    return {
        "version": 2,
        "last_updated": last or get_kst_datetime().isoformat(),
        "learning_config": LEARNING_CONFIG,
        "patterns": {
            row['pattern']: {
                "weight": row['current_weight'],
                "attack_weight": row['attack_weight'],
                "defense_weight": row['defense_weight'],
                "wins": row['win_count'],
                "total": row['total_count'],
                "attack_wins": row['attack_win_count'],
                "attack_total": row['attack_total_count'],
                "defense_wins": row['defense_win_count'],
                "defense_total": row['defense_total_count']
            } for row in rows
        }
    }

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
    """Extract patterns for a specific player from the game moves with phase weighting."""
    patterns = set()
    patterns_with_phase = []
    board = [[0] * 15 for _ in range(15)]

    for i, move in enumerate(moves):
        player = move.get('player', 1 if i % 2 == 0 else 2)
        row, col = move['row'], move['col']
        if not (0 <= row < 15 and 0 <= col < 15):
            continue
        board[row][col] = player

        if player == target_player:
            detected = extract_patterns_at(board, row, col, player)
            patterns.update(detected)
            move_number = i + 1
            phase = get_game_phase(move_number)
            patterns_with_phase.append((detected, phase))

    return patterns

def extract_decisive_patterns(moves, target_player, n_final=6):
    """
    Extract patterns from only the last N moves of the game.
    These are the 'decisive' patterns most causally linked to the game outcome.
    Builds the full board state first, then only records patterns from the last N moves.
    """
    board = [[0] * 15 for _ in range(15)]

    # Replay the entire game to build correct board state
    for move in moves:
        player = move.get('player', 0)
        row, col = move['row'], move['col']
        if 0 <= row < 15 and 0 <= col < 15 and player in (1, 2):
            board[row][col] = player

    # Now undo last N moves to replay from (total - N)
    total = len(moves)
    start_idx = max(0, total - n_final)

    # Rebuild board up to start_idx
    board2 = [[0] * 15 for _ in range(15)]
    for i in range(start_idx):
        move = moves[i]
        player = move.get('player', 0)
        row, col = move['row'], move['col']
        if 0 <= row < 15 and 0 <= col < 15 and player in (1, 2):
            board2[row][col] = player

    # Collect patterns only from the decisive last moves
    patterns = set()
    for i in range(start_idx, total):
        move = moves[i]
        player = move.get('player', 1 if i % 2 == 0 else 2)
        row, col = move['row'], move['col']
        if not (0 <= row < 15 and 0 <= col < 15):
            continue
        board2[row][col] = player
        if player == target_player:
            detected = extract_patterns_at(board2, row, col, player)
            patterns.update(detected)

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

# ─── Cluster Pattern Extraction ───────────────────────────────────────────────────
def find_clusters(board, player):
    """Find connected stone clusters using 8-direction flood fill."""
    size = len(board)
    visited = [[False] * size for _ in range(size)]
    clusters = []
    directions_8 = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
    
    for start_r in range(size):
        for start_c in range(size):
            if board[start_r][start_c] == player and not visited[start_r][start_c]:
                cluster = []
                stack = [(start_r, start_c)]
                while stack:
                    r, c = stack.pop()
                    if visited[r][c]:
                        continue
                    visited[r][c] = True
                    cluster.append((r, c))
                    for dr, dc in directions_8:
                        nr, nc = r + dr, c + dc
                        if 0 <= nr < size and 0 <= nc < size:
                            if board[nr][nc] == player and not visited[nr][nc]:
                                stack.append((nr, nc))
                if len(cluster) >= 3:
                    clusters.append(cluster)
    return clusters

def get_cluster_bounds(cluster):
    """Get bounding box of a cluster."""
    rows = [p[0] for p in cluster]
    cols = [p[1] for p in cluster]
    return min(rows), max(rows), min(cols), max(cols)

def extract_cluster_pattern_type(cluster, board):
    """Identify the type of cluster pattern based on shape analysis."""
    if len(cluster) < 3:
        return None
    
    cluster_set = set(cluster)
    size = len(cluster)
    
    min_r, max_r, min_c, max_c = get_cluster_bounds(cluster)
    height = max_r - min_r + 1
    width = max_c - min_c + 1
    
    directions_4 = [(0, 1), (1, 0), (1, 1), (1, -1)]
    
    center_r = sum(p[0] for p in cluster) // size
    center_c = sum(p[1] for p in cluster) // size
    
    def count_in_direction(start_r, start_c, dr, dc):
        count = 0
        r, c = start_r + dr, start_c + dc
        while (r, c) in cluster_set:
            count += 1
            r += dr
            c += dc
        return count
    
    horizontal = count_in_direction(center_r, center_c, 0, 1) + count_in_direction(center_r, center_c, 0, -1) + 1
    vertical = count_in_direction(center_r, center_c, 1, 0) + count_in_direction(center_r, center_c, -1, 0) + 1
    diag1 = count_in_direction(center_r, center_c, 1, 1) + count_in_direction(center_r, center_c, -1, -1) + 1
    diag2 = count_in_direction(center_r, center_c, 1, -1) + count_in_direction(center_r, center_c, -1, 1) + 1
    
    has_h = horizontal >= 3
    has_v = vertical >= 3
    has_d1 = diag1 >= 3
    has_d2 = diag2 >= 3
    
    active_count = sum([has_h, has_v, has_d1, has_d2])
    
    # 4 or more directions: cross pattern
    if active_count >= 4:
        return 'cross_plus'
    
    # 3 directions: three-way patterns
    if active_count == 3:
        # T-shape: vertical + horizontal (like ㅗ or ㅜ)
        if has_h and has_v:
            # Determine orientation based on cluster shape
            top_count = sum(1 for p in cluster if p[0] == min_r)
            bottom_count = sum(1 for p in cluster if p[0] == max_r)
            if top_count == 1:
                return 't_shape_1'  # ㅗ shape (T pointing up)
            elif bottom_count == 1:
                return 't_shape_2'  # ㅜ shape (T pointing down)
            return 'three_way_up'  # Generic three-way
        
        # X with one arm: diagonal + diagonal
        if has_d1 and has_d2:
            # ㅓ or ㅏ shape
            left_count = sum(1 for p in cluster if p[1] == min_c)
            right_count = sum(1 for p in cluster if p[1] == max_c)
            if left_count == 1:
                return 'three_way_left'  # ㅓ shape
            elif right_count == 1:
                return 'three_way_right'  # ㅏ shape
            return 'cross_x'
        
        # Mixed: one straight + two diagonals
        # This shouldn't happen with typical patterns, but handle it
        return 'three_way_up'
    
    # 2 directions: corner or L-shape
    if active_count == 2:
        if has_h and has_v:
            # Check shape to determine corner type
            top_count = sum(1 for p in cluster if p[0] == min_r)
            bottom_count = sum(1 for p in cluster if p[0] == max_r)
            left_count = sum(1 for p in cluster if p[1] == min_c)
            right_count = sum(1 for p in cluster if p[1] == max_c)
            
            if top_count == 1 and left_count == 1:
                return 'corner_l_1'  # ┌
            if top_count == 1 and right_count == 1:
                return 'corner_l_2'  # ┐
            if bottom_count == 1 and left_count == 1:
                return 'corner_l_3'  # └
            if bottom_count == 1 and right_count == 1:
                return 'corner_l_4'  # ┘
            return 'corner_l_1'
        
        if has_d1 and has_d2:
            # X shape with only diagonals
            return 'cross_x'
    
    return None

def extract_cluster_patterns(moves, target_player):
    """Extract cluster patterns from game moves."""
    clusters_found = []
    board = [[0] * 15 for _ in range(15)]
    
    for i, move in enumerate(moves):
        player = move.get('player', 1 if i % 2 == 0 else 2)
        row, col = move['row'], move['col']
        if not (0 <= row < 15 and 0 <= col < 15):
            continue
        board[row][col] = player
        
        if player == target_player:
            clusters = find_clusters(board, player)
            for cluster in clusters:
                pattern_type = extract_cluster_pattern_type(cluster, board)
                if pattern_type:
                    clusters_found.append({
                        'type': pattern_type,
                        'move_number': i + 1,
                        'player': player,
                        'size': len(cluster)
                    })
    
    seen = set()
    unique = []
    for c in clusters_found:
        key = (c['type'], c['move_number'], c['player'])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique

def build_influence_map(board, player):
    """Build influence map showing connection potential."""
    size = len(board)
    influence = [[0] * size for _ in range(size)]
    
    for r in range(size):
        for c in range(size):
            if board[r][c] == player:
                for dr in range(-4, 5):
                    for dc in range(-4, 5):
                        nr, nc = r + dr, c + dc
                        if 0 <= nr < size and 0 <= nc < size and board[nr][nc] == 0:
                            dist = max(abs(dr), abs(dc))
                            influence[nr][nc] += 5 - dist
    return influence

def find_connection_points(influence_map, threshold=4):
    """Find high-influence connection points."""
    size = len(influence_map)
    points = []
    for r in range(size):
        for c in range(size):
            if influence_map[r][c] >= threshold:
                points.append((r, c, influence_map[r][c]))
    return sorted(points, key=lambda x: -x[2])

def classify_connection(board, row, col, player):
    """Classify the type of connection created by placing at (row, col)."""
    directions = [(0, 1), (1, 0), (1, 1), (1, -1)]
    open_threes = 0
    fours = 0
    
    for dr, dc in directions:
        line = get_line_pattern(board, row, col, dr, dc, player)
        if '_OOOO_' in line:
            fours += 2
        elif 'OOOO' in line:
            fours += 1
        if '_OOO_' in line:
            open_threes += 1
    
    # Classification order matters - pincer_threat must come before supporting_threat
    if open_threes >= 2:
        return 'nearby_threes'        # Double open three (쌍삼)
    if fours >= 1 and open_threes >= 1:
        return 'bridge_threat'        # Four-three (사삼)
    if fours >= 2:
        return 'pincer_threat'        # Double four (쌍사)
    if open_threes >= 1:
        return 'supporting_threat'    # Open three support
    return None

def extract_cluster_connections(moves, target_player):
    """Extract cluster connection patterns from game moves."""
    connections_found = []
    board = [[0] * 15 for _ in range(15)]
    
    for i, move in enumerate(moves):
        player = move.get('player', 1 if i % 2 == 0 else 2)
        row, col = move['row'], move['col']
        if not (0 <= row < 15 and 0 <= col < 15):
            continue
        
        if player == target_player and board[row][col] == 0:
            influence = build_influence_map(board, player)
            if influence[row][col] >= 4:
                conn_type = classify_connection(board, row, col, player)
                if conn_type:
                    connections_found.append({
                        'type': conn_type,
                        'move_number': i + 1,
                        'player': player,
                        'influence': influence[row][col]
                    })
        
        board[row][col] = player
    
    seen = set()
    unique = []
    for c in connections_found:
        key = (c['type'], c['move_number'], c['player'])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique

# ─── Bidirectional Weight Updates ────────────────────────────────────────────────
def update_pattern_weights(conn, patterns, perspective, is_win):
    """
    Update pattern weights bidirectionally with ratio bounds and bias correction.
    perspective: 'attack' or 'defense'
    is_win: True if this perspective's patterns contributed to a win
    """
    patterns = set(patterns) - WIN_CONDITION_PATTERNS

    if not patterns:
        return

    _count_results(conn, 'pattern_stats', 'pattern', patterns, perspective, is_win)

    rows = conn.execute(f'''
        SELECT pattern, attack_weight, defense_weight, current_weight,
               {perspective}_win_count AS wins, {perspective}_total_count AS total
        FROM pattern_stats
    ''').fetchall()

    for row in rows:
        pattern = row['pattern']
        base_weight = BASE_WEIGHTS.get(pattern, 1000)
        att_weight = row['attack_weight'] if row['attack_weight'] is not None else base_weight
        def_weight = row['defense_weight'] if row['defense_weight'] is not None else base_weight
        current_w = row['current_weight'] if row['current_weight'] is not None else base_weight

        total_count = row['total'] or 0
        if total_count < LEARNING_CONFIG['min_games_threshold']:
            continue

        # Patterns absent from this game count as losses for this update
        win_count = (row['wins'] or 0) if pattern in patterns else 0
        simple_pattern_penalty = 0.7 if pattern in SIMPLE_PATTERNS else 1.0
        new_weight = _bounded_weight(current_w, win_count / total_count, base_weight,
                                     att_weight, def_weight, perspective, simple_pattern_penalty)
        conn.execute(f'UPDATE pattern_stats SET {perspective}_weight = %s, current_weight = %s WHERE pattern = %s',
                     (new_weight, new_weight, pattern))

    game_count = conn.execute('SELECT COUNT(*) AS c FROM game_records').fetchone()['c']
    conn.execute('''
        INSERT INTO weight_history (pattern, attack_weight, defense_weight, game_count, recorded_at)
        SELECT pattern, attack_weight, defense_weight, %s, %s FROM pattern_stats
    ''', (game_count, get_kst_datetime().isoformat()))

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

    with get_db() as conn:
        rows = conn.execute(
            'SELECT name, score, level, stones, date FROM leaderboard ORDER BY score DESC, id LIMIT 10'
        ).fetchall()

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
        date = get_kst_date()

    with get_db() as conn:
        conn.execute(
            'INSERT INTO leaderboard (name, score, level, stones, date) VALUES (%s, %s, %s, %s, %s)',
            (name, score, level, stones, date)
        )

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
    date = get_kst_date()

    # Validate winner based on stone count. Black moves first (the player, or the
    # AI when the player picked white): black needs at least 9 stones to win
    # (5 + 4), white at least 10 (5 + 5)
    first = moves[0]['player'] if moves else 1
    if winner in (1, 2):
        min_stones = 9 if winner == first else 10
        if stone_count < min_stones:
            side = 'player' if winner == 1 else 'AI'
            return jsonify({'success': False, 'error': f'Invalid game: {side} win requires at least {min_stones} stones'}), 400

    with get_db() as conn:
        game_id = conn.execute(
            'INSERT INTO game_records (moves, winner, game_mode, level, stone_count, date, time) '
            'VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id',
            (json.dumps(moves), winner, game_mode, level, stone_count, date, get_kst_time())
        ).fetchone()['id']
        # Keep the record even if learning below fails
        conn.commit()

        # Skip learning for outlier games or draws/incomplete games
        if stone_count < 9 or stone_count > 225:
            return jsonify({'success': True, 'learned': False, 'reason': 'outlier'})

        if winner == -1 or winner == 0:
            return jsonify({'success': True, 'learned': False, 'reason': 'draw_or_incomplete'})

        # One game learns at a time: concurrent requests would otherwise lock the
        # stats rows in different orders (deadlock) or overwrite each other's EMA step
        conn.execute('SELECT pg_advisory_xact_lock(1)')

        learned_info = {'attack_patterns': 0, 'defense_patterns': 0, 'composites': 0, 'cluster_patterns': 0, 'cluster_connections': 0}

        if winner == 1:
            # Player won: strengthen defense weights for player decisive patterns,
            # weaken attack weights for AI decisive patterns
            player_patterns = extract_decisive_patterns(moves, target_player=1)
            ai_patterns = extract_decisive_patterns(moves, target_player=2)

            if player_patterns:
                update_pattern_weights(conn, player_patterns, perspective='defense', is_win=True)
                learned_info['defense_patterns'] = len(player_patterns)
            if ai_patterns:
                update_pattern_weights(conn, ai_patterns, perspective='attack', is_win=False)
                learned_info['attack_patterns'] = len(ai_patterns)

        elif winner == 2:
            # AI won: strengthen attack weights for AI decisive patterns
            ai_patterns = extract_decisive_patterns(moves, target_player=2)
            if ai_patterns:
                update_pattern_weights(conn, ai_patterns, perspective='attack', is_win=True)
                learned_info['attack_patterns'] = len(ai_patterns)

            # Also record player defense failures (decisive patterns only)
            player_patterns = extract_decisive_patterns(moves, target_player=1)
            if player_patterns:
                update_pattern_weights(conn, player_patterns, perspective='defense', is_win=False)
                learned_info['defense_patterns'] = len(player_patterns)

        # Extract and save composite patterns
        for p in (1, 2):
            composites = extract_composite_patterns(moves, target_player=p)
            if composites:
                conn.cursor().executemany('''
                    INSERT INTO composite_pattern_stats (pattern_type, game_id, move_number, player, resulted_in_win)
                    VALUES (%s, %s, %s, %s, %s)
                ''', [(c['type'], game_id, c['move_number'], c['player'], 1 if winner == p else 0) for c in composites])
                learned_info['composites'] += len(composites)

        # Extract and learn cluster patterns and cluster connections
        for p in (1, 2):
            perspective = 'defense' if p == 1 else 'attack'
            is_win = (winner == p)

            cluster_patterns = extract_cluster_patterns(moves, target_player=p)
            if cluster_patterns:
                update_cluster_weights(conn, 'cluster_pattern_stats', 'pattern_id',
                                       [c['type'] for c in cluster_patterns], CLUSTER_PATTERNS, perspective, is_win)
                learned_info['cluster_patterns'] += len(cluster_patterns)

            connections = extract_cluster_connections(moves, target_player=p)
            if connections:
                update_cluster_weights(conn, 'cluster_connection_stats', 'connection_type',
                                       [c['type'] for c in connections], CLUSTER_CONNECTION_PATTERNS, perspective, is_win)
                learned_info['cluster_connections'] += len(connections)

    return jsonify({
        'success': True,
        'learned': True,
        'attack_patterns': learned_info['attack_patterns'],
        'defense_patterns': learned_info['defense_patterns'],
        'composites': learned_info['composites'],
        'cluster_patterns': learned_info['cluster_patterns'],
        'cluster_connections': learned_info['cluster_connections']
    })

@app.route('/api/weights', methods=['GET', 'OPTIONS'])
@cross_origin
def get_weights():
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    with get_db() as conn:
        return jsonify(weights_payload(conn))

@app.route('/api/weights/reset', methods=['POST', 'OPTIONS'])
@cross_origin
def reset_weights():
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    with get_db() as conn:
        for pattern, weight in BASE_WEIGHTS.items():
            conn.execute('''
                UPDATE pattern_stats
                SET win_count = 0, total_count = 0, current_weight = %s,
                    attack_weight = %s, defense_weight = %s,
                    attack_win_count = 0, attack_total_count = 0,
                    defense_win_count = 0, defense_total_count = 0
                WHERE pattern = %s
            ''', (weight, weight, weight, pattern))

    return jsonify({'success': True, 'message': 'Weights reset to defaults'})

# ─── Jev Intuition Layer (TypeSafe System One) ───────────────────────────────────
# The browser sends the board and the engine's candidate moves; this route builds
# the prompt itself (no free text from the client reaches the API) and asks Jev
# which candidate it prefers. The key stays on the server (TYPESAFE_API_KEY).
JEV_API_URL = os.environ.get('JEV_API_URL', 'https://api.typesafe.ai/v1/systemone')
JEV_MODEL = os.environ.get('JEV_MODEL', 'jev-latest')
JEV_TIMEOUT_SEC = 3.0
JEV_MAX_CANDIDATES = 12
JEV_COLS = 'ABCDEFGHIJKLMNO'
JEV_GRADE_TEXT = {
    'three': 'an open three', 'four': 'a four', 'double-three': 'a double three',
    'four-three': 'a four-three', 'winning': 'a winning shape', 'five': 'five',
}

def jev_coord(row, col):
    return f'{JEV_COLS[col]}{row + 1}'

def jev_board_text(board, last_move, ai_color='white'):
    opp_color = 'black' if ai_color == 'white' else 'white'
    lines = [
        'Gomoku on a 15x15 board. Five or more in a row wins.',
        f'X = {opp_color} (opponent). O = {ai_color} (you). It is your move as O.',
        'Columns A-O run left to right, rows 1-15 run top to bottom.',
        '    ' + ' '.join(JEV_COLS),
    ]
    for r in range(15):
        lines.append(f'{r + 1:>3} ' + ' '.join('.XO'[v] for v in board[r]))
    if last_move:
        lines.append(f'Opponent just played {jev_coord(*last_move)}.')
    return '\n'.join(lines)

def jev_note(cand):
    parts = []
    me, opp = JEV_GRADE_TEXT.get(cand.get('me')), JEV_GRADE_TEXT.get(cand.get('opp'))
    if me:
        parts.append(f'makes {me} for O')
    if opp:
        parts.append(f'blocks X from {opp}')
    note = '; '.join(parts) or 'quiet developing move'
    winrate = cand.get('winrate')
    if isinstance(winrate, (int, float)) and not isinstance(winrate, bool) and 0 <= winrate <= 1:
        note += f' (engine win estimate {round(winrate * 100)}%)'
    return note

def jev_parse_request(data):
    """Validate the client payload. Returns (board, last_move, candidates, ai_color) or raises ValueError."""
    board = data.get('board')
    if not (isinstance(board, list) and len(board) == 15 and
            all(isinstance(row, list) and len(row) == 15 and
                all(v in (0, 1, 2) for v in row) for row in board)):
        raise ValueError('board must be 15x15 of 0/1/2')

    def cell(m):
        r, c = m.get('row'), m.get('col')
        if not (isinstance(r, int) and isinstance(c, int) and 0 <= r < 15 and 0 <= c < 15):
            raise ValueError('bad coordinate')
        return r, c

    last = data.get('lastMove')
    last_move = cell(last) if isinstance(last, dict) else None

    raw = data.get('candidates')
    if not isinstance(raw, list) or not 2 <= len(raw) <= JEV_MAX_CANDIDATES:
        raise ValueError(f'candidates must be a list of 2-{JEV_MAX_CANDIDATES} moves')
    candidates, seen = [], set()
    for m in raw:
        if not isinstance(m, dict):
            raise ValueError('bad candidate')
        r, c = cell(m)
        if board[r][c] != 0 or (r, c) in seen:
            raise ValueError('candidate must be a distinct empty cell')
        seen.add((r, c))
        candidates.append({'row': r, 'col': c, 'me': m.get('me'), 'opp': m.get('opp'), 'winrate': m.get('winrate')})
    ai_color = data.get('aiColor', 'white')
    if ai_color not in ('black', 'white'):
        raise ValueError('aiColor must be black or white')
    return board, last_move, candidates, ai_color

@app.route('/api/jev-move', methods=['POST', 'OPTIONS'])
@cross_origin
def jev_move():
    if request.method == 'OPTIONS':
        return jsonify({}), 200

    api_key = os.environ.get('TYPESAFE_API_KEY')
    if not api_key:
        return jsonify({'ok': False, 'error': 'jev_disabled'}), 503

    try:
        board, last_move, candidates, ai_color = jev_parse_request(request.get_json(silent=True) or {})
        opp_color = 'black' if ai_color == 'white' else 'white'
    except ValueError as e:
        return jsonify({'ok': False, 'error': str(e)}), 400

    ids = {jev_coord(c['row'], c['col']): c for c in candidates}
    payload = {
        'model': JEV_MODEL,
        'state': jev_board_text(board, last_move, ai_color),
        'questions': {
            'move': {
                'type': 'choice',
                'instructions': 'Which candidate move gives O the best winning chances?',
                'criteria': {cid: jev_note(c) for cid, c in ids.items()},
            },
            'outcome': {
                'type': 'choice',
                'instructions': 'With best play from here, which side is more likely to win this game?',
                'criteria': {'O': f'O ({ai_color}, you) wins', 'X': f'X ({opp_color}, opponent) wins'},
            },
        },
    }

    req = urllib.request.Request(
        JEV_API_URL,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=JEV_TIMEOUT_SEC) as resp:
            body = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        logger.warning(f'Jev HTTP {e.code}: {detail}')
        return jsonify({'ok': False, 'error': f'jev_http_{e.code}'}), 502
    except Exception as e:
        logger.warning(f'Jev request failed: {e}')
        return jsonify({'ok': False, 'error': 'jev_unreachable'}), 502

    answer = (body.get('answers') or {}).get('move') or {}
    choice = ids.get(answer.get('choice'))
    if not choice:
        return jsonify({'ok': False, 'error': 'jev_bad_answer'}), 502

    probs = answer.get('probabilities') or {}
    # Optional second answer: Jev's win probability for each side (None if missing)
    outcome = None
    oprobs = ((body.get('answers') or {}).get('outcome') or {}).get('probabilities') or {}
    try:
        ai, opp = float(oprobs['O']), float(oprobs['X'])
        if ai >= 0 and opp >= 0 and ai + opp > 0:
            outcome = {ai_color: ai / (ai + opp), opp_color: opp / (ai + opp)}
    except (KeyError, TypeError, ValueError):
        pass

    return jsonify({
        'ok': True,
        'choice': {'row': choice['row'], 'col': choice['col']},
        'confidence': answer.get('confidence'),
        'probabilities': [
            {'row': c['row'], 'col': c['col'], 'p': float(probs.get(cid, 0) or 0)}
            for cid, c in ids.items()
        ],
        'outcome': outcome,
        'usage': body.get('usage'),
    })

# ─── Static File Serving ─────────────────────────────────────────────────────────
ALLOWED_EXTENSIONS = {'.html', '.js', '.css', '.woff2', '.wav', '.json', '.png', '.ico', '.wasm', '.data'}

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory('.', path)

# ─── Error Handlers ──────────────────────────────────────────────────────────────
@app.errorhandler(404)
def not_found(error):
    logger.warning(f'404 Not Found: {request.url}')
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    logger.error(f'500 Internal Error: {request.url}\n{traceback.format_exc()}')
    return jsonify({'error': 'Internal server error'}), 500

@app.errorhandler(Exception)
def handle_exception(error):
    logger.error(f'Unhandled exception: {str(error)}\n{traceback.format_exc()}')
    return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    try:
        logger.info('Starting Omok server on port 8081...')
        app.run(host='0.0.0.0', port=8081, debug=False, threaded=True)
    except Exception as e:
        logger.critical(f'Failed to start server: {str(e)}\n{traceback.format_exc()}')
        raise
