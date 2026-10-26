"""Supabase REST API (PostgREST) client: SUPABASE_URL + SUPABASE_SECRET_KEY.

The secret key bypasses row level security, so it stays on the server.
"""
import json
import os
import urllib.parse
import urllib.request


def _request(method, path, params=None, body=None):
    url = f"{os.environ['SUPABASE_URL'].rstrip('/')}/rest/v1/{path}"
    if params:
        url += '?' + urllib.parse.urlencode(params)
    key = os.environ['SUPABASE_SECRET_KEY']
    req = urllib.request.Request(
        url, method=method,
        data=None if body is None else json.dumps(body).encode('utf-8'),
        # Cloudflare in front of the server rejects urllib's default User-Agent
        headers={'apikey': key, 'Content-Type': 'application/json', 'Prefer': 'return=minimal',
                 'User-Agent': 'omok-server'},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = resp.read()
    return json.loads(data) if data else None


def select(table, **params):
    """GET /rest/v1/<table>, e.g. select('leaderboard', select='name', order='score.desc', limit=10)."""
    return _request('GET', table, params)


def insert(table, row):
    _request('POST', table, body=row)


def rpc(function):
    return _request('POST', f'rpc/{function}', body={})
