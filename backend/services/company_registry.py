"""公司维度注册与白名单。

白名单 = 我发过(union) 主动找我。已沟通过的公司跳过主动外呼。

写操作支持传入已有连接（conn），避免与外部事务嵌套时造成 SQLite 写锁。
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime
from typing import Iterator, Optional

from db import db, get_conn


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@contextmanager
def _conn(conn: Optional[sqlite3.Connection]) -> Iterator[sqlite3.Connection]:
    """复用外部连接；未提供则自建事务连接。"""
    if conn is not None:
        yield conn
    else:
        with db() as own:
            yield own


def get_or_create(conn, name: str) -> int:
    """按公司名取 id，不存在则创建。name 唯一索引保证去重。"""
    name = (name or "").strip() or "未知公司"
    row = conn.execute("SELECT id FROM companies WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("INSERT INTO companies(name) VALUES (?)", (name,))
    return int(cur.lastrowid)


def find(name: str) -> Optional[dict]:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM companies WHERE name = ?", (name,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def is_whitelisted(name: str) -> bool:
    c = find(name)
    return bool(c and c["is_whitelisted"])


def is_blacklisted(name: str) -> bool:
    c = find(name)
    return bool(c and c["is_blacklisted"])


def has_outbound_contacted(name: str) -> bool:
    c = find(name)
    return bool(c and c["is_outbound_contacted"])


def mark_outbound_contacted(company_id: int, conn: Optional[sqlite3.Connection] = None) -> None:
    """我主动发起首轮外呼 → 已沟通 + 入白名单。"""
    with _conn(conn) as c:
        c.execute(
            "UPDATE companies SET is_outbound_contacted = 1, is_whitelisted = 1, "
            "last_contact_at = ? WHERE id = ?",
            (_now(), company_id),
        )


def mark_inbound_contacted(company_id: int, conn: Optional[sqlite3.Connection] = None) -> None:
    """HR 主动找我 → 已沟通 + 入白名单。"""
    with _conn(conn) as c:
        c.execute(
            "UPDATE companies SET is_inbound_contacted = 1, is_whitelisted = 1, "
            "last_contact_at = ? WHERE id = ?",
            (_now(), company_id),
        )


def mark_resume_sent(company_id: int, conn: Optional[sqlite3.Connection] = None) -> None:
    with _conn(conn) as c:
        c.execute("UPDATE companies SET resume_sent = 1 WHERE id = ?", (company_id,))


def set_blacklist(company_id: int, flag: bool = True, conn: Optional[sqlite3.Connection] = None) -> None:
    with _conn(conn) as c:
        c.execute(
            "UPDATE companies SET is_blacklisted = ? WHERE id = ?",
            (1 if flag else 0, company_id),
        )