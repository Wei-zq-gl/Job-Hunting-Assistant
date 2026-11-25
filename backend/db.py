"""SQLite 存取层：建表、连接、默认设置。

表结构对齐 PRD「数据模型」：companies / jobs / messages /
conversations / send_queue / settings。
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Any, Iterable, Iterator

from config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS companies (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL UNIQUE,
    is_outbound_contacted INTEGER NOT NULL DEFAULT 0,
    is_inbound_contacted  INTEGER NOT NULL DEFAULT 0,
    is_whitelisted        INTEGER NOT NULL DEFAULT 0,
    is_blacklisted        INTEGER NOT NULL DEFAULT 0,
    resume_sent           INTEGER NOT NULL DEFAULT 0,
    last_contact_at       TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,              -- BOSS job id / url 摘要
    company_id    INTEGER REFERENCES companies(id),
    title         TEXT,
    city          TEXT,
    area          TEXT,
    salary        TEXT,
    salary_min    REAL,
    salary_max    REAL,
    experience    TEXT,
    education     TEXT,
    jd            TEXT,
    url           TEXT,
    filter_pass   INTEGER,                       -- 硬过滤结果 1/0
    filter_reason TEXT,
    match_score   INTEGER,
    match_reason  TEXT,
    match_risk    TEXT,
    match_questions TEXT,
    status        TEXT NOT NULL DEFAULT 'candidate',
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    INTEGER REFERENCES companies(id),
    job_id        TEXT REFERENCES jobs(id),
    direction     TEXT NOT NULL,                 -- outbound / inbound
    content       TEXT NOT NULL,
    send_type     TEXT,                          -- first_outreach / reply / inbound_reply / resume_sent
    counted_today INTEGER NOT NULL DEFAULT 0,
    status        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER REFERENCES companies(id),
    job_id     TEXT REFERENCES jobs(id),
    history    TEXT,                             -- JSON 数组
    status     TEXT NOT NULL DEFAULT 'active',   -- active / interview_pending / closed_by_llm
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS send_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    INTEGER REFERENCES companies(id),
    job_id        TEXT REFERENCES jobs(id),
    send_type     TEXT NOT NULL,
    content       TEXT NOT NULL,
    counted_today INTEGER NOT NULL DEFAULT 1,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending / sent / failed / canceled
    retry_count   INTEGER NOT NULL DEFAULT 0,
    scheduled_at  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_queue_status ON send_queue(status);
CREATE INDEX IF NOT EXISTS idx_msg_company  ON messages(company_id);
CREATE INDEX IF NOT EXISTS idx_msg_created  ON messages(created_at);
"""

DEFAULT_SETTINGS: dict[str, str] = {
    "daily_first_outreach_limit": str(settings.DAILY_FIRST_OUTREACH_LIMIT),
    "send_interval_min": str(settings.SEND_INTERVAL_MIN),
    "send_interval_max": str(settings.SEND_INTERVAL_MAX),
    "auto_outreach_min_score": str(settings.AUTO_OUTREACH_MIN_SCORE),
    "whitelist_only": "true",
    "cities": ",".join(settings.CITIES),
    "salary_min": str(settings.SALARY_MIN_K),
    "salary_max": str(settings.SALARY_MAX_K),
    "circuit_broken": "false",
}


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """事务性连接：正常结束自动 commit，异常回滚。"""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


def init_db() -> None:
    """建表并写入默认设置（幂等）。"""
    with db() as conn:
        conn.executescript(SCHEMA)
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
                (key, value),
            )


def get_setting(key: str, default: str | None = None) -> str | None:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )


# ---------------- 运行时设置读取（DB 优先，回退配置默认值） ----------------
def get_int_setting(key: str, default: int) -> int:
    raw = get_setting(key)
    try:
        return int(raw) if raw is not None else default
    except (TypeError, ValueError):
        return default


def get_float_setting(key: str, default: float) -> float:
    raw = get_setting(key)
    try:
        return float(raw) if raw is not None else default
    except (TypeError, ValueError):
        return default


def get_list_setting(key: str, default: list[str]) -> list[str]:
    raw = get_setting(key)
    if not raw:
        return list(default)
    return [x.strip() for x in raw.split(",") if x.strip()]


def get_str_setting(key: str, default: str) -> str:
    raw = get_setting(key)
    return raw if raw else default
