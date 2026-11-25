"""发送队列：限流（8 条/天）、间隔（30–60s 随机）、熔断。

计数口径（对齐 PRD）：
- first_outreach   → 计入每日 8 条
- reply / inbound_reply / resume_sent → 不计入
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Optional

from config import settings
from db import db, get_int_setting, get_setting, set_setting
from services import company_registry

_next_send_at_key = "next_send_at"


def _now() -> datetime:
    return datetime.now()


def _fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def today_str() -> str:
    return _now().strftime("%Y-%m-%d")


# ---------------- 计数 ----------------
def today_first_outreach_count() -> int:
    with db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM messages "
            "WHERE send_type = 'first_outreach' AND counted_today = 1 "
            "AND date(created_at) = ?",
            (today_str(),),
        ).fetchone()
    return int(row["n"])


def today_reply_count() -> int:
    with db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM messages "
            "WHERE send_type IN ('reply', 'inbound_reply') AND direction = 'outbound' "
            "AND date(created_at) = ?",
            (today_str(),),
        ).fetchone()
    return int(row["n"])


def first_outreach_limit() -> int:
    return int(get_setting("daily_first_outreach_limit", str(settings.DAILY_FIRST_OUTREACH_LIMIT)))


def quota_left() -> int:
    return max(0, first_outreach_limit() - today_first_outreach_count())


# ---------------- 熔断 ----------------
def is_circuit_broken() -> bool:
    return get_setting("circuit_broken", "false") == "true"


def break_circuit(reason: str) -> None:
    set_setting("circuit_broken", "true")
    set_setting("circuit_reason", reason)


def reset_circuit() -> None:
    set_setting("circuit_broken", "false")
    set_setting("circuit_reason", "")


def _bump_failures() -> int:
    n = int(get_setting("consecutive_failures", "0")) + 1
    set_setting("consecutive_failures", str(n))
    if n >= settings.MAX_CONSECUTIVE_FAILURES:
        break_circuit(f"连续发送失败 {n} 次")
    return n


def _reset_failures() -> None:
    set_setting("consecutive_failures", "0")


def seconds_until_next_send() -> int:
    """距离下次允许发送还有多少秒（0 表示可发）。"""
    raw = get_setting(_next_send_at_key, "")
    if not raw:
        return 0
    try:
        nxt = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return 0
    delta = (nxt - _now()).total_seconds()
    return max(0, int(delta))


def send_interval_range() -> tuple[int, int]:
    """发送间隔（秒）。DB 设置优先，回退 config；保证 max ≥ min。"""
    lo = get_int_setting("send_interval_min", settings.SEND_INTERVAL_MIN)
    hi = get_int_setting("send_interval_max", settings.SEND_INTERVAL_MAX)
    lo = max(0, lo)
    hi = max(lo, hi)
    return lo, hi


def _schedule_next_send() -> None:
    """发送成功后，安排下一次最早可发时间：now + 随机间隔。"""
    lo, hi = send_interval_range()
    interval = random.randint(lo, hi)
    set_setting(_next_send_at_key, _fmt(_now() + timedelta(seconds=interval)))


# ---------------- 入队 ----------------
def enqueue(conn, *, company_id: int, job_id: Optional[str], send_type: str, content: str) -> int:
    counted = 1 if send_type == "first_outreach" else 0
    cur = conn.execute(
        "INSERT INTO send_queue(company_id, job_id, send_type, content, counted_today) "
        "VALUES (?, ?, ?, ?, ?)",
        (company_id, job_id, send_type, content, counted),
    )
    return int(cur.lastrowid)


# ---------------- 取件 / 回执 ----------------
def pick_next(send_type: Optional[str] = None) -> tuple[Optional[dict], str]:
    """取一条可发送的队列项。返回 (item, 说明)。

    send_type: 指定只取某类（如 'reply'）；回复类不占用首轮限速。
    """
    if is_circuit_broken():
        return None, "熔断中：" + (get_setting("circuit_reason", "") or "")

    # 限速只针对首轮主动外呼；回复/简历可即时发送
    if send_type != "reply":
        wait = seconds_until_next_send()
        if wait > 0:
            return None, f"限速中，{wait}s 后可发"

    with db() as conn:
        # 白名单二次校验：入队后 HR 主动找上来的公司，其待发首轮外呼直接作废
        conn.execute(
            "UPDATE send_queue SET status = 'canceled' "
            "WHERE status = 'pending' AND send_type = 'first_outreach' "
            "AND company_id IN (SELECT id FROM companies WHERE is_whitelisted = 1)"
        )

        sql = "SELECT * FROM send_queue WHERE status = 'pending'"
        args: list = []
        if send_type:
            sql += " AND send_type = ?"
            args.append(send_type)
        sql += " ORDER BY id LIMIT 1"
        row = conn.execute(sql, args).fetchone()
        if not row:
            return None, "队列为空"
        item = dict(row)
        company = conn.execute(
            "SELECT name FROM companies WHERE id = ?", (item["company_id"],)
        ).fetchone()
        item["company_name"] = company["name"] if company else ""

        # 附带岗位信息，供扩展打开目标页 / 展示
        job = conn.execute(
            "SELECT title, url FROM jobs WHERE id = ?", (item["job_id"],)
        ).fetchone()
        item["job_title"] = job["title"] if job else ""
        item["job_url"] = job["url"] if job else ""

    if item["send_type"] == "first_outreach" and item["counted_today"]:
        if quota_left() <= 0:
            return None, f"今日首轮外呼已达上限 {first_outreach_limit()} 条"

    return item, "ok"


def ack(queue_id: int, ok: bool, error: Optional[str] = None) -> dict:
    """扩展回传发送结果。"""
    with db() as conn:
        row = conn.execute("SELECT * FROM send_queue WHERE id = ?", (queue_id,)).fetchone()
        if not row:
            raise ValueError(f"队列项不存在: {queue_id}")
        item = dict(row)

        if ok:
            conn.execute("UPDATE send_queue SET status = 'sent' WHERE id = ?", (queue_id,))
            conn.execute(
                "INSERT INTO messages(company_id, job_id, direction, content, send_type, counted_today, status) "
                "VALUES (?, ?, 'outbound', ?, ?, ?, 'sent')",
                (item["company_id"], item["job_id"], item["content"], item["send_type"], item["counted_today"]),
            )
            if item["send_type"] == "first_outreach":
                company_registry.mark_outbound_contacted(item["company_id"], conn)
                conn.execute("UPDATE jobs SET status = 'sent' WHERE id = ?", (item["job_id"],))
        else:
            retry = item["retry_count"] + 1
            status = "failed" if retry >= 3 else "pending"
            conn.execute(
                "UPDATE send_queue SET status = ?, retry_count = ? WHERE id = ?",
                (status, retry, queue_id),
            )

    if ok:
        _reset_failures()
        # 只有首轮外呼需要 30–60s 间隔，回复不占用
        if item["send_type"] == "first_outreach":
            _schedule_next_send()
    else:
        msg = (error or "").lower()
        if "验证码" in (error or "") or "captcha" in msg:
            break_circuit("检测到验证码")
        elif "登录" in (error or "") or "login" in msg:
            break_circuit("登录失效")
        else:
            _bump_failures()

    return {"ok": ok, "circuit_broken": is_circuit_broken()}