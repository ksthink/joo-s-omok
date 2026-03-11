from flask import Flask, request, jsonify, send_from_directory
import sqlite3
import os
from datetime import datetime
from functools import wraps

app = Flask(__name__, static_folder='.')

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'game.db')
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

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
    conn.commit()
    conn.close()

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
        'SELECT name, score, level, stones, date FROM leaderboard ORDER BY score DESC LIMIT 20'
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

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_file(path):
    return send_from_directory('.', path)

if __name__ == '__main__':
    init_db()
    app.run(host='0.0.0.0', port=8081, debug=False)
