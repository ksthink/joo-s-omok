# Vercel entrypoint: serve the Flask app from server.py as a Python function.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import app  # noqa: E402,F401
