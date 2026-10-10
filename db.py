import os

import psycopg
from psycopg.rows import dict_row


def get_db():
    """Connect to the Postgres database in DATABASE_URL (Supabase).

    prepare_threshold=None: Supabase's transaction pooler cannot keep prepared
    statements between transactions.
    """
    return psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row, prepare_threshold=None)
