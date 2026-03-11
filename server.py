from flask import Flask, request, jsonify, send_from_directory
import sqlite3
import os
import json
from datetime import datetime
from functools import wraps

app = Flask(__name__, static_folder='.')

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'game.db')
WEIGHTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'weights.json')
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

BASE_WEIGHTS = {
    "OOOOO": 100000,
    "_OOOO_": 50000,
    "OOOO_": 10000,
    "_OOOO": 10000,
    "XOOOO_": 10000,
    "_OOOOX": 10000,
    "_OOO_": 5000,
    "OOO__": 1000,
    "__OOO": 1000,
    "_O_OO_": 1000,
    "_OO_O_": 1000,
    "OO_O_": 1000,
    "_O_OO": 1000,
    "OO__": 100,
    "__OO": 100,
    "_O_O_": 100,
    "_OO_": 100,
    "O__": 10,
    "__O": 10,
    "_O_": 10
}

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
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
            current_weight REAL
        )
    ''')
    
    for pattern, weight in BASE_WEIGHTS.items():
        conn.execute('''
            INSERT OR IGNORE INTO pattern_stats (pattern, win_count, total_count, current_weight)
            VALUES (?, 0, 0, ?)
        ''', (pattern, weight))
    
    conn.commit()
    conn.close()
    
    if not os.path.exists(WEIGHTS_PATH):
        save_weights_to_file()

def load_weights_from_file():
    try:
        with open(WEIGHTS_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return {"version": 1, "last_updated": datetime.now().isoformat(), "patterns": {}}

def save_weights_to_file():
    conn = get_db()
    cursor = conn.execute('SELECT pattern, current_weight, win_count, total_count FROM pattern_stats')
    rows = cursor.fetchall()
    conn.close()
    
    weights_data = {
        "version": 1,
        "last_updated": datetime.now().isoformat(),
        "patterns": {}
    }
    
    for row in rows:
        weights_data["patterns"][row['pattern']] = {
            "weight": row['current_weight'],
            "wins": row['win_count'],
            "total": row['total_count']
        }
    
    with open(WEIGHTS_PATH, 'w', encoding='utf-8') as f:
        json.dump(weights_data, f, indent=2, ensure_ascii=False)

def extract_patterns_from_moves(moves, winner):
    patterns = set()
    board = [[0] * 15 for _ in range(15)]
    
    for i, move in enumerate(moves):
        player = move.get('player', 1 if i % 2 == 0 else 2)
        row, col = move['row'], move['col']
        board[row][col] = player
        
        if player == winner:
            patterns.update(extract_patterns_at(board, row, col, player))
    
    return patterns

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

def update_pattern_weights(patterns, is_win):
    conn = get_db()
    
    for pattern in patterns:
        conn.execute('''
            UPDATE pattern_stats 
            SET win_count = win_count + ?,
                total_count = total_count + 1
            WHERE pattern = ?
        ''', (1 if is_win else 0, pattern))
    
    cursor = conn.execute('SELECT pattern, win_count, total_count, current_weight FROM pattern_stats')
    rows = cursor.fetchall()
    
    for row in rows:
        pattern = row['pattern']
        win_count = row['win_count']
        total_count = row['total_count']
        current_weight = row['current_weight']
        base_weight = BASE_WEIGHTS.get(pattern, 1000)
        
        if total_count >= 30:
            raw_weight = (win_count / total_count) * base_weight * 1.5
            new_weight = current_weight * 0.9 + raw_weight * 0.1
            min_weight = base_weight * 0.5
            max_weight = base_weight * 2.0
            new_weight = max(min_weight, min(new_weight, max_weight))
            
            conn.execute('''
                UPDATE pattern_stats SET current_weight = ? WHERE pattern = ?
            ''', (new_weight, pattern))
    
    conn.commit()
    conn.close()
    save_weights_to_file()

def cross_origin(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        response = f(*args, **kwargs)
        if isinstance(response, tuple):
            resp = response[0]
            resp.headers.add('Access-Control-Allow-Origin', '*')
            resp.headers.add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            resp.headers.add('Access-Control-Allow-Headers', 'Content-Type')
            return response
        else:
            response.headers.add('Access-Control-Allow-Origin', '*')
            response.headers.add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
            return response
    return decorated_function

@app.route('/api/leaderboard', methods=['GET', 'OPTIONS'])
@cross_origin
def get_leaderboard():
    if request.method == 'OPTIONS':
        return jsonify({}), 200
    
    conn = get_db()
    cursor = conn.execute(
        'SELECT name, score, level, stones, date FROM leaderboard ORDER BY score DESC LIMIT 10'
    )
    rows = cursor.fetchall()
    conn.close()
    
    leaderboard = []
    for row in rows:
        leaderboard.append({
            'name': row['name'],
            'score': row['score'],
            'level': row['level'],
            'stones': row['stones'],
            'date': row['date']
        })
    
    return jsonify(leaderboard)

@app.route('/api/leaderboard', methods=['POST', 'OPTIONS'])
@cross_origin
def save_score():
    if request.method == 'OPTIONS':
        return jsonify({}), 200
    
    data = request.json
    
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    
    name = data.get('name', '익명')
    score = data.get('score', 0)
    level = data.get('level', 1)
    stones = data.get('stones', 0)
    date = data.get('date')
    
    if not date:
        date = datetime.now().strftime('%Y-%m-%d')
    
    conn = get_db()
    conn.execute(
        'INSERT INTO leaderboard (name, score, level, stones, date) VALUES (?, ?, ?, ?, ?)',
        (name, score, level, stones, date)
    )
    conn.commit()
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
    winner = data.get('winner', 0)
    game_mode = data.get('gameMode', 'practice')
    level = data.get('level', 1)
    stone_count = len(moves)
    date = datetime.now().strftime('%Y-%m-%d')
    
    if stone_count < 5 or stone_count > 100:
        conn = get_db()
        conn.execute(
            'INSERT INTO game_records (moves, winner, game_mode, level, stone_count, date) VALUES (?, ?, ?, ?, ?, ?)',
            (json.dumps(moves), winner, game_mode, level, stone_count, date)
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'learned': False, 'reason': 'outlier'})
    
    conn = get_db()
    conn.execute(
        'INSERT INTO game_records (moves, winner, game_mode, level, stone_count, date) VALUES (?, ?, ?, ?, ?, ?)',
        (json.dumps(moves), winner, game_mode, level, stone_count, date)
    )
    conn.commit()
    conn.close()
    
    if winner == 1:
        patterns = extract_patterns_from_moves(moves, winner)
        update_pattern_weights(patterns, is_win=True)
        return jsonify({'success': True, 'learned': True, 'patterns_count': len(patterns)})
    
    return jsonify({'success': True, 'learned': False, 'reason': 'ai_won'})

@app.route('/api/weights', methods=['GET', 'OPTIONS'])
@cross_origin
def get_weights():
    if request.method == 'OPTIONS':
        return jsonify({}), 200
    
    weights_data = load_weights_from_file()
    
    if not weights_data.get('patterns'):
        conn = get_db()
        cursor = conn.execute('SELECT pattern, current_weight FROM pattern_stats')
        rows = cursor.fetchall()
        conn.close()
        
        weights_data['patterns'] = {}
        for row in rows:
            weights_data['patterns'][row['pattern']] = {'weight': row['current_weight']}
    
    return jsonify(weights_data)

@app.route('/api/weights/reset', methods=['POST', 'OPTIONS'])
@cross_origin
def reset_weights():
    if request.method == 'OPTIONS':
        return jsonify({}), 200
    
    conn = get_db()
    for pattern, weight in BASE_WEIGHTS.items():
        conn.execute('''
            UPDATE pattern_stats 
            SET win_count = 0, total_count = 0, current_weight = ?
            WHERE pattern = ?
        ''', (weight, pattern))
    conn.commit()
    conn.close()
    
    save_weights_to_file()
    
    return jsonify({'success': True, 'message': 'Weights reset to defaults'})

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_file(path):
    return send_from_directory('.', path)

if __name__ == '__main__':
    init_db()
    app.run(host='0.0.0.0', port=8081, debug=False)
