import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
pool = None


class Database:
    def __init__(self, conn, postgres):
        self.conn, self.postgres = conn, postgres

    def execute(self, sql, args=()):
        return self.conn.execute(sql.replace("?", "%s") if self.postgres else sql, args)

    def one(self, sql, args=()):
        row = self.execute(sql, args).fetchone()
        return dict(row) if row else None

    def all(self, sql, args=()):
        return [dict(row) for row in self.execute(sql, args)]


def _ensure_column(db, table, column, definition):
    if pool:
        db.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {definition}"
        )
    else:
        cols = {r["name"] for r in db.all(f"PRAGMA table_info({table})")}
        if column not in cols:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def initialize():
    global pool
    if os.getenv("DATABASE_URL", "").strip():
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        pool = ConnectionPool(
            os.environ["DATABASE_URL"],
            min_size=1,
            max_size=12,
            kwargs=dict(row_factory=dict_row, autocommit=False, prepare_threshold=None),
        )
    with transaction(True) as db:
        for stmt in (ROOT / "schema.sql").read_text().split(";"):
            if stmt.strip():
                db.execute(stmt.replace("BLOB", "BYTEA") if pool else stmt)
        _ensure_column(db, "exam_settings", "negative_marking", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(db, "sessions", "negative_marking", "INTEGER NOT NULL DEFAULT 0")


@contextmanager
def transaction(write=False, scope=None):
    if pool:
        with pool.connection() as conn:
            try:
                if write and scope is None:
                    conn.execute("SELECT pg_advisory_xact_lock(7095621)")
                elif write:
                    conn.execute("SELECT pg_advisory_xact_lock_shared(7095621)")
                    conn.execute("SELECT pg_advisory_xact_lock(42,hashtext(%s))", (scope,))
                yield Database(conn, True)
                if write:
                    conn.commit()
                else:
                    conn.rollback()
            except Exception:
                conn.rollback()
                raise
    else:
        conn = sqlite3.connect(
            os.getenv("SQLITE_PATH", str(ROOT / "exam.db")), timeout=20
        )
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=20000")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield Database(conn, False)
            if write:
                conn.commit()
            else:
                conn.rollback()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()