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

app = Flask(__name__, static_folder='.')

# Learning dashboard: /dashboard (page) and /dashboard/api/* (its data)
from dashboard.app import bp as dashboard_bp  # noqa: E402
app.register_blueprint(dashboard_bp, url_prefix='/dashboard')

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
        conn.execute(
            'INSERT INTO game_records (moves, winner, game_mode, level, stone_count, date, time) '
            'VALUES (%s, %s, %s, %s, %s, %s, %s)',
            (json.dumps(moves), winner, game_mode, level, stone_count, date, get_kst_time())
        )

    return jsonify({'success': True})

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
