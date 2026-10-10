from flask import Blueprint, render_template, jsonify
import json

from db import get_db

# Served by server.py under /dashboard (pages, static files and /dashboard/api/*)
bp = Blueprint('dashboard', __name__, template_folder='templates',
               static_folder='static', static_url_path='/static')

def safe_query(query, params=(), fetchone=False):
    with get_db() as conn:
        cursor = conn.execute(query, params)
        return cursor.fetchone() if fetchone else cursor.fetchall()

@bp.route('/')
def index():
    return render_template('index.html')

@bp.route('/api/stats')
def get_stats():
    with get_db() as conn:
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

@bp.route('/api/leaderboard')
def get_leaderboard():
    rows = safe_query('''
        SELECT name, score, level, stones, date
        FROM leaderboard ORDER BY score DESC, id LIMIT 20
    ''')
    return jsonify([dict(row) for row in rows])

@bp.route('/api/games')
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

@bp.route('/api/game/<int:game_id>')
def get_game(game_id):
    row = safe_query('''
        SELECT id, moves, winner, game_mode, level, stone_count, date, time
        FROM game_records WHERE id = %s
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

    if len(open_four_lines) >= 2 or (len(open_four_lines) >= 1 and len(blocked_four_lines) >= 1):
        composite_type = 'double_four'
        composite_lines = open_four_lines + blocked_four_lines
    elif len(blocked_four_lines) >= 1 and len(open_three_lines) >= 1:
        composite_type = 'four_three'
        composite_lines = blocked_four_lines + open_three_lines
    elif len(open_three_lines) >= 2:
        composite_type = 'double_open_three'
        composite_lines = open_three_lines

    return composite_type, composite_lines

@bp.route('/api/game/<int:game_id>/patterns')
def get_game_patterns(game_id):
    row = safe_query('SELECT moves FROM game_records WHERE id = %s', (game_id,), fetchone=True)
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
