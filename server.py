from flask import Flask, request, jsonify, send_from_directory
import sqlite3
import os
import json
import logging
import traceback
from datetime import datetime, timezone
from functools import wraps
from zoneinfo import ZoneInfo

# Configure logging
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, 'server.log')),
        logging.StreamHandler()
    ]
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
        conn.execute('''
            CREATE TABLE IF NOT EXISTS cluster_pattern_stats (
                pattern_id TEXT PRIMARY KEY,
                win_count INTEGER DEFAULT 0,
                total_count INTEGER DEFAULT 0,
                attack_weight REAL,
                defense_weight REAL,
                attack_win_count INTEGER DEFAULT 0,
                attack_total_count INTEGER DEFAULT 0,
                defense_win_count INTEGER DEFAULT 0,
                defense_total_count INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS cluster_connection_stats (
                connection_type TEXT PRIMARY KEY,
                win_count INTEGER DEFAULT 0,
                total_count INTEGER DEFAULT 0,
                attack_weight REAL,
                defense_weight REAL,
                attack_win_count INTEGER DEFAULT 0,
                attack_total_count INTEGER DEFAULT 0,
                defense_win_count INTEGER DEFAULT 0,
                defense_total_count INTEGER DEFAULT 0
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

        # Insert cluster patterns
        for pattern_id, info in CLUSTER_PATTERNS.items():
            weight = info.get('weight', 1000) if isinstance(info, dict) else info
            conn.execute('''
                INSERT OR IGNORE INTO cluster_pattern_stats
                (pattern_id, win_count, total_count, attack_weight, defense_weight,
                 attack_win_count, attack_total_count, defense_win_count, defense_total_count)
                VALUES (?, 0, 0, ?, ?, 0, 0, 0, 0)
            ''', (pattern_id, weight, weight))

        # Insert cluster connection patterns
        for conn_type, info in CLUSTER_CONNECTION_PATTERNS.items():
            weight = info.get('weight', 1000) if isinstance(info, dict) else conn_type
            conn.execute('''
                INSERT OR IGNORE INTO cluster_connection_stats
                (connection_type, win_count, total_count, attack_weight, defense_weight,
                 attack_win_count, attack_total_count, defense_win_count, defense_total_count)
                VALUES (?, 0, 0, ?, ?, 0, 0, 0, 0)
            ''', (conn_type, weight, weight))

        conn.commit()
    finally:
        conn.close()

    if not os.path.exists(WEIGHTS_PATH):
        save_weights_to_file()

def reanalyze_all_games(force=False):
    """Reanalyze all existing games for pattern extraction."""
    conn = get_db()
    try:
        if force:
            conn.execute('DELETE FROM composite_pattern_stats')
            conn.execute('''
                UPDATE cluster_pattern_stats SET
                    win_count = 0, total_count = 0,
                    attack_win_count = 0, attack_total_count = 0,
                    defense_win_count = 0, defense_total_count = 0,
                    attack_weight = (SELECT weight FROM (
                        SELECT pattern_id, 
                            CASE WHEN pattern_id LIKE 'cross%' THEN 5000
                                 WHEN pattern_id LIKE 'three%' THEN 3000
                                 WHEN pattern_id LIKE 'corner%' THEN 2000
                                 WHEN pattern_id LIKE 't_shape%' THEN 2500
                                 ELSE 1000 END as weight
                    ) WHERE cluster_pattern_stats.pattern_id = pattern_id),
                    defense_weight = attack_weight
            ''')
            conn.execute('''
                UPDATE cluster_connection_stats SET
                    win_count = 0, total_count = 0,
                    attack_win_count = 0, attack_total_count = 0,
                    defense_win_count = 0, defense_total_count = 0,
                    attack_weight = (SELECT weight FROM (
                        SELECT connection_type,
                            CASE WHEN connection_type = 'bridge_threat' THEN 8000
                                 WHEN connection_type = 'nearby_threes' THEN 4000
                                 WHEN connection_type = 'supporting_threat' THEN 3000
                                 WHEN connection_type = 'pincer_threat' THEN 3500
                                 ELSE 1000 END as weight
                    ) WHERE cluster_connection_stats.connection_type = connection_type),
                    defense_weight = attack_weight
            ''')
            conn.execute('UPDATE game_records SET analyzed = 0')
            conn.commit()
        
        cursor = conn.execute('SELECT id, moves, winner, analyzed FROM game_records WHERE analyzed = 0 OR analyzed IS NULL')
        games = cursor.fetchall()
        
        if not games:
            print("No games to analyze")
            return
        
        analyzed_count = 0
        for row in games:
            game_id = row['id']
            moves = json.loads(row['moves']) if row['moves'] else []
            winner = row['winner']
            
            if len(moves) < 9 or len(moves) > 225:
                conn.execute('UPDATE game_records SET analyzed = 1 WHERE id = ?', (game_id,))
                continue
            
            try:
                for p in (1, 2):
                    is_win = (winner == p)
                    perspective = 'defense' if p == 1 else 'attack'
                    
                    composites = extract_composite_patterns(moves, p)
                    for c in composites:
                        conn.execute('''
                            INSERT INTO composite_pattern_stats 
                            (pattern_type, game_id, move_number, player, resulted_in_win)
                            VALUES (?, ?, ?, ?, ?)
                        ''', (c['type'], game_id, c['move_number'], c['player'], 1 if is_win else 0))
                    
                    cluster_patterns = extract_cluster_patterns(moves, p)
                    if cluster_patterns:
                        pattern_types = list(set(c['type'] for c in cluster_patterns))
                        _update_cluster_pattern_weights_with_conn(conn, pattern_types, perspective, is_win)
                    
                    connections = extract_cluster_connections(moves, p)
                    if connections:
                        conn_types = list(set(c['type'] for c in connections))
                        _update_cluster_connection_weights_with_conn(conn, conn_types, perspective, is_win)
                
                conn.execute('UPDATE game_records SET analyzed = 1 WHERE id = ?', (game_id,))
                conn.commit()
                analyzed_count += 1
            except Exception as e:
                print(f"Error reanalyzing game {game_id}: {e}")
                conn.rollback()
        
        if analyzed_count > 0:
            print(f"Reanalyzed {analyzed_count} games")
    finally:
        conn.close()
    
    save_weights_to_file()

def _update_cluster_pattern_weights_with_conn(conn, cluster_patterns, perspective, is_win):
    """Update cluster pattern weights using existing connection."""
    if not cluster_patterns:
        return
    
    threshold = LEARNING_CONFIG['min_games_threshold']
    ema_old = LEARNING_CONFIG['ema_old_weight']
    ema_new = LEARNING_CONFIG['ema_new_weight']
    min_ratio = LEARNING_CONFIG['min_weight_ratio']
    max_ratio = LEARNING_CONFIG['max_weight_ratio']
    win_mult = LEARNING_CONFIG['win_multiplier']
    
    win_col = f'{perspective}_win_count'
    total_col = f'{perspective}_total_count'
    weight_col = f'{perspective}_weight'
    
    for pattern in cluster_patterns:
        conn.execute(f'''
            UPDATE cluster_pattern_stats
            SET {win_col} = {win_col} + ?,
                {total_col} = {total_col} + 1,
                win_count = win_count + ?,
                total_count = total_count + 1
            WHERE pattern_id = ?
        ''', (1 if is_win else 0, 1 if is_win else 0, pattern))

def _update_cluster_connection_weights_with_conn(conn, connections, perspective, is_win):
    """Update cluster connection weights using existing connection."""
    if not connections:
        return
    
    threshold = LEARNING_CONFIG['min_games_threshold']
    ema_old = LEARNING_CONFIG['ema_old_weight']
    ema_new = LEARNING_CONFIG['ema_new_weight']
    min_ratio = LEARNING_CONFIG['min_weight_ratio']
    max_ratio = LEARNING_CONFIG['max_weight_ratio']
    win_mult = LEARNING_CONFIG['win_multiplier']
    
    win_col = f'{perspective}_win_count'
    total_col = f'{perspective}_total_count'
    weight_col = f'{perspective}_weight'
    
    for conn_type in connections:
        conn.execute(f'''
            UPDATE cluster_connection_stats
            SET {win_col} = {win_col} + ?,
                {total_col} = {total_col} + 1,
                win_count = win_count + ?,
                total_count = total_count + 1
            WHERE connection_type = ?
        ''', (1 if is_win else 0, 1 if is_win else 0, conn_type))

def update_cluster_pattern_weights(cluster_patterns, perspective, is_win):
    """Update cluster pattern weights with ratio bounds."""
    if not cluster_patterns:
        return
    
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
        
        for pattern in cluster_patterns:
            conn.execute(f'''
                UPDATE cluster_pattern_stats
                SET {win_col} = {win_col} + ?,
                    {total_col} = {total_col} + 1,
                    win_count = win_count + ?,
                    total_count = total_count + 1
                WHERE pattern_id = ?
            ''', (1 if is_win else 0, 1 if is_win else 0, pattern))
        
        cursor = conn.execute('''
            SELECT pattern_id, attack_total_count, defense_total_count,
                   attack_weight, defense_weight
            FROM cluster_pattern_stats
        ''')
        rows = cursor.fetchall()
        
        for row in rows:
            pattern_id = row['pattern_id']
            att_total = row['attack_total_count'] or 0
            def_total = row['defense_total_count'] or 0
            att_weight = row['attack_weight']
            def_weight = row['defense_weight']
            
            info = CLUSTER_PATTERNS.get(pattern_id, {})
            base_weight = info.get('weight', 1000) if isinstance(info, dict) else 1000
            
            if att_weight is None:
                att_weight = base_weight
            if def_weight is None:
                def_weight = base_weight
            
            cursor2 = conn.execute(f'''
                SELECT {win_col}, {total_col} FROM cluster_pattern_stats WHERE pattern_id = ?
            ''', (pattern_id,))
            row2 = cursor2.fetchone()
            if not row2:
                continue
            
            win_count = row2[0] or 0
            total_count = row2[1] or 0
            
            if total_count < threshold:
                continue
            
            win_rate = win_count / total_count
            raw_weight = win_rate * base_weight * win_mult
            current_w = att_weight if perspective == 'attack' else def_weight
            new_weight = current_w * ema_old + raw_weight * ema_new
            
            min_weight = base_weight * min_ratio
            max_weight = base_weight * max_ratio
            
            other_weight = def_weight if perspective == 'attack' else att_weight
            ratio_limit = max_ratio
            if other_weight and other_weight > base_weight * min_ratio:
                if perspective == 'attack':
                    max_weight = min(max_weight, other_weight * ratio_limit)
                else:
                    min_weight = max(min_weight, other_weight / ratio_limit)
            
            new_weight = max(min_weight, min(new_weight, max_weight))
            
            conn.execute(f'''
                UPDATE cluster_pattern_stats SET {weight_col} = ? WHERE pattern_id = ?
            ''', (new_weight, pattern_id))
        
        conn.commit()
    finally:
        conn.close()

def update_cluster_connection_weights(connections, perspective, is_win):
    """Update cluster connection pattern weights with ratio bounds."""
    if not connections:
        return
    
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
        
        for conn_type in connections:
            conn.execute(f'''
                UPDATE cluster_connection_stats
                SET {win_col} = {win_col} + ?,
                    {total_col} = {total_col} + 1,
                    win_count = win_count + ?,
                    total_count = total_count + 1
                WHERE connection_type = ?
            ''', (1 if is_win else 0, 1 if is_win else 0, conn_type))
        
        cursor = conn.execute('''
            SELECT connection_type, attack_total_count, defense_total_count,
                   attack_weight, defense_weight
            FROM cluster_connection_stats
        ''')
        rows = cursor.fetchall()
        
        for row in rows:
            conn_type = row['connection_type']
            att_total = row['attack_total_count'] or 0
            def_total = row['defense_total_count'] or 0
            att_weight = row['attack_weight']
            def_weight = row['defense_weight']
            
            info = CLUSTER_CONNECTION_PATTERNS.get(conn_type, {})
            base_weight = info.get('weight', 1000) if isinstance(info, dict) else 1000
            
            if att_weight is None:
                att_weight = base_weight
            if def_weight is None:
                def_weight = base_weight
            
            cursor2 = conn.execute(f'''
                SELECT {win_col}, {total_col} FROM cluster_connection_stats WHERE connection_type = ?
            ''', (conn_type,))
            row2 = cursor2.fetchone()
            if not row2:
                continue
            
            win_count = row2[0] or 0
            total_count = row2[1] or 0
            
            if total_count < threshold:
                continue
            
            win_rate = win_count / total_count
            raw_weight = win_rate * base_weight * win_mult
            current_w = att_weight if perspective == 'attack' else def_weight
            new_weight = current_w * ema_old + raw_weight * ema_new
            
            min_weight = base_weight * min_ratio
            max_weight = base_weight * max_ratio
            
            other_weight = def_weight if perspective == 'attack' else att_weight
            ratio_limit = max_ratio
            if other_weight and other_weight > base_weight * min_ratio:
                if perspective == 'attack':
                    max_weight = min(max_weight, other_weight * ratio_limit)
                else:
                    min_weight = max(min_weight, other_weight / ratio_limit)
            
            new_weight = max(min_weight, min(new_weight, max_weight))
            
            conn.execute(f'''
                UPDATE cluster_connection_stats SET {weight_col} = ? WHERE connection_type = ?
            ''', (new_weight, conn_type))
        
        conn.commit()
    finally:
        conn.close()

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
    conn.execute('''
        UPDATE pattern_stats SET attack_weight = current_weight
        WHERE attack_weight IS NULL
    ''')
    
    cursor2 = conn.execute("PRAGMA table_info(game_records)")
    game_cols = {row['name'] for row in cursor2.fetchall()}
    if 'analyzed' not in game_cols:
        conn.execute('ALTER TABLE game_records ADD COLUMN analyzed INTEGER DEFAULT 0')
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
        return {"version": 2, "last_updated": get_kst_datetime().isoformat(), "patterns": {}}

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
        "last_updated": get_kst_datetime().isoformat(),
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
def update_pattern_weights(patterns, perspective, is_win):
    """
    Update pattern weights bidirectionally with ratio bounds and bias correction.
    perspective: 'attack' or 'defense'
    is_win: True if this perspective's patterns contributed to a win
    """
    patterns = set(patterns) - WIN_CONDITION_PATTERNS
    
    if not patterns:
        return
    
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

        cursor = conn.execute('''
            SELECT pattern, attack_total_count, defense_total_count,
                   attack_weight, defense_weight, current_weight
            FROM pattern_stats
        ''')
        rows = cursor.fetchall()

        for row in rows:
            pattern = row['pattern']
            att_total = row['attack_total_count'] or 0
            def_total = row['defense_total_count'] or 0
            att_weight = row['attack_weight']
            def_weight = row['defense_weight']
            current_w = row['current_weight']
            base_weight = BASE_WEIGHTS.get(pattern, 1000)

            if att_weight is None:
                att_weight = base_weight
            if def_weight is None:
                def_weight = base_weight
            if current_w is None:
                current_w = base_weight

            att_win = 0
            def_win = 0
            if pattern in patterns:
                cursor2 = conn.execute(f'''
                    SELECT attack_win_count, defense_win_count, attack_total_count, defense_total_count
                    FROM pattern_stats WHERE pattern = ?
                ''', (pattern,))
                row2 = cursor2.fetchone()
                if row2:
                    att_win = row2['attack_win_count'] or 0
                    def_win = row2['defense_win_count'] or 0
                    att_total = row2['attack_total_count'] or 0
                    def_total = row2['defense_total_count'] or 0

            if perspective == 'attack':
                win_count = att_win
                total_count = att_total
            else:
                win_count = def_win
                total_count = def_total

            if total_count < threshold:
                continue

            win_rate = win_count / total_count
            simple_pattern_penalty = 0.7 if pattern in SIMPLE_PATTERNS else 1.0
            raw_weight = win_rate * base_weight * win_mult * simple_pattern_penalty
            new_weight = current_w * ema_old + raw_weight * ema_new
            min_weight = base_weight * min_ratio
            max_weight = base_weight * max_ratio
            
            other_weight = def_weight if perspective == 'attack' else att_weight
            ratio_limit = max_ratio
            if other_weight and other_weight > base_weight * min_ratio:
                if perspective == 'attack':
                    max_weight = min(max_weight, other_weight * ratio_limit)
                else:
                    min_weight = max(min_weight, other_weight / ratio_limit)
            
            new_weight = max(min_weight, min(new_weight, max_weight))

            conn.execute(f'''
                UPDATE pattern_stats SET {weight_col} = ?, current_weight = ? WHERE pattern = ?
            ''', (new_weight, new_weight, pattern))

        game_count = conn.execute('SELECT COUNT(*) as c FROM game_records').fetchone()['c']
        now = get_kst_datetime().isoformat()
        cursor3 = conn.execute('SELECT pattern, attack_weight, defense_weight FROM pattern_stats')
        for row in cursor3.fetchall():
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
        date = get_kst_date()

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
    date = get_kst_date()

    # Validate winner based on stone count
    # Winner 1 (player) needs at least 9 stones (5 player + 4 AI)
    # Winner 2 (AI) needs at least 10 stones (5 AI + 5 player)
    # Winner 0 (draw) should have full board (225 stones) or mutual agreement
    if winner == 1 and stone_count < 9:
        # Invalid: player can't win with less than 9 stones
        return jsonify({'success': False, 'error': 'Invalid game: player win requires at least 9 stones'}), 400
    if winner == 2 and stone_count < 10:
        # Invalid: AI can't win with less than 10 stones
        return jsonify({'success': False, 'error': 'Invalid game: AI win requires at least 10 stones'}), 400

    # Save game record
    conn = get_db()
    try:
        cursor = conn.execute(
            'INSERT INTO game_records (moves, winner, game_mode, level, stone_count, date, time) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (json.dumps(moves), winner, game_mode, level, stone_count, date, get_kst_time())
        )
        game_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    # Skip learning for outlier games or draws/incomplete games
    if stone_count < 9 or stone_count > 225:
        return jsonify({'success': True, 'learned': False, 'reason': 'outlier'})
    
    if winner == -1 or winner == 0:
        return jsonify({'success': True, 'learned': False, 'reason': 'draw_or_incomplete'})

    learned_info = {'attack_patterns': 0, 'defense_patterns': 0, 'composites': 0, 'cluster_patterns': 0, 'cluster_connections': 0}

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

    # Extract and learn cluster patterns
    for p in (1, 2):
        cluster_patterns = extract_cluster_patterns(moves, target_player=p)
        if cluster_patterns:
            pattern_types = [c['type'] for c in cluster_patterns]
            perspective = 'defense' if p == 1 else 'attack'
            is_win = (winner == p)
            update_cluster_pattern_weights(pattern_types, perspective, is_win)
            learned_info['cluster_patterns'] += len(cluster_patterns)

    # Extract and learn cluster connection patterns
    for p in (1, 2):
        connections = extract_cluster_connections(moves, target_player=p)
        if connections:
            conn_types = [c['type'] for c in connections]
            perspective = 'defense' if p == 1 else 'attack'
            is_win = (winner == p)
            update_cluster_connection_weights(conn_types, perspective, is_win)
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
        logger.info('Initializing database...')
        init_db()
        logger.info('Database initialized successfully')
        logger.info('Starting Omok server on port 8081...')
        app.run(host='0.0.0.0', port=8081, debug=False, threaded=True)
    except Exception as e:
        logger.critical(f'Failed to start server: {str(e)}\n{traceback.format_exc()}')
        raise
