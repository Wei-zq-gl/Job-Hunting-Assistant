"""回复监控：HR 回复 → 决策（面试转人工 / 简历自动发 / LLM 应答 / 关闭会话）。"""
from __future__ import annotations

from typing import Optional

from config import settings
from db import db, get_conn, get_str_setting
from llm import prompts, qwen_client
from models import ReplyDecision
from services import company_registry, message_generator, sender


def _hit(text: str, keywords: list[str]) -> list[str]:
    return [k for k in keywords if k in (text or "")]


def _history(conn, company_id: int) -> list[dict[str, str]]:
    rows = conn.execute(
        "SELECT direction, content FROM messages WHERE company_id = ? "
        "ORDER BY id DESC LIMIT 10",
        (company_id,),
    ).fetchall()
    out: list[dict[str, str]] = []
    for r in reversed(rows):
        role = "user" if r["direction"] == "outbound" else "assistant"
        out.append({"role": role, "content": r["content"]})
    return out


def _last_status(company_id: int) -> str:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT status FROM conversations WHERE company_id = ? ORDER BY id DESC LIMIT 1",
            (company_id,),
        ).fetchone()
        return row["status"] if row else ""
    finally:
        conn.close()


def _resolve_jd(
    company_id: int, job_id: Optional[str], job_title: Optional[str]
) -> tuple[str, str]:
    """取对方岗位的 JD 与名称，用于方向判定。

    优先级：消息上报的 job_id → 公司内与 job_title 同名的岗位 → 该公司最近一条有 JD 的岗位。
    都取不到时退化为「仅凭 job_title 文本判断」。
    """
    conn = get_conn()
    try:
        row = None
        if job_id:
            row = conn.execute(
                "SELECT title, jd FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if row is None and job_title:
            row = conn.execute(
                "SELECT title, jd FROM jobs WHERE company_id = ? AND title = ? "
                "ORDER BY (jd IS NULL), id DESC LIMIT 1",
                (company_id, job_title),
            ).fetchone()
        if row is None:
            row = conn.execute(
                "SELECT title, jd FROM jobs WHERE company_id = ? "
                "AND jd IS NOT NULL AND jd != '' ORDER BY id DESC LIMIT 1",
                (company_id,),
            ).fetchone()
        if row:
            return (row["jd"] or ""), (row["title"] or job_title or "")
    finally:
        conn.close()
    return "", (job_title or "")


def handle_inbound(
    *, company: str, job_id: Optional[str], content: str, job_title: Optional[str] = None
) -> ReplyDecision:
    """处理一条 HR 回复，返回决策。副作用：写库 / 入队应答。"""
    conn = get_conn()
    try:
        company_id = company_registry.get_or_create(conn, company)
        conn.execute(
            "INSERT INTO messages(company_id, job_id, direction, content, send_type, status) "
            "VALUES (?, ?, 'inbound', ?, 'inbound', 'received')",
            (company_id, job_id, content),
        )
        conn.commit()
        history = _history(conn, company_id)
    finally:
        conn.close()

    company_registry.mark_inbound_contacted(company_id)

    # 已回绝过的公司：只回绝一次，后续消息不再应答
    if _last_status(company_id) == "declined":
        return ReplyDecision(action="close", reason="此前已礼貌回绝，不再重复应答")

    # 0) JD 方向判定：不符合目标岗位 → 礼貌回绝，不再继续应答
    jd, resolved_title = _resolve_jd(company_id, job_id, job_title)
    target_roles = get_str_setting("target_roles", settings.TARGET_ROLES)
    matched, match_reason = message_generator.jd_matches_target(
        title=resolved_title, jd=jd, target_roles=target_roles
    )
    if not matched:
        decline_text = message_generator.generate_decline(
            title=resolved_title, company=company, reason=match_reason
        )
        _enqueue_reply(company_id, job_id, decline_text)
        _set_status(company_id, job_id, "declined")
        return ReplyDecision(
            action="decline",
            reason=match_reason or "岗位方向与求职目标不符",
            reply_text=decline_text,
        )

    # 1) 面试相关 → 转人工，绝不自动回复
    interview_hits = _hit(content, settings.INTERVIEW_KEYWORDS)
    if interview_hits:
        _set_status(company_id, job_id, "interview_pending")
        return ReplyDecision(
            action="manual_interview",
            reason=f"命中面试关键词：{'/'.join(interview_hits)}",
        )

    # 2) 简历请求 → 扩展自动点弹窗，同时给一句应答
    if _hit(content, settings.RESUME_KEYWORDS):
        reply_text = message_generator.generate_reply(history=history, incoming=content)
        _enqueue_reply(company_id, job_id, reply_text)
        return ReplyDecision(
            action="request_resume",
            reason="命中简历关键词，扩展自动发送简历",
            reply_text=reply_text,
        )

    # 3) 其余 → LLM 判断是否可停止
    stop, reason = _should_stop(history)
    if stop:
        _set_status(company_id, job_id, "closed_by_llm")
        return ReplyDecision(action="close", reason=reason or "LLM 判断会话可结束")

    reply_text = message_generator.generate_reply(history=history, incoming=content)
    _enqueue_reply(company_id, job_id, reply_text)
    return ReplyDecision(action="reply", reason="LLM 生成应答继续对话", reply_text=reply_text)


def _should_stop(history: list[dict[str, str]]) -> tuple[bool, str]:
    messages = [
        {"role": "system", "content": prompts.STOP_SYSTEM},
        {"role": "user", "content": prompts.stop_user(history)},
    ]
    try:
        data, _ = qwen_client.chat_json(messages, temperature=0.1)
    except Exception as exc:
        return False, f"停止判断失败：{exc}"
    return bool(data.get("stop")), str(data.get("reason", ""))


def _enqueue_reply(company_id: int, job_id: Optional[str], text: str) -> None:
    with db() as conn:
        sender.enqueue(
            conn, company_id=company_id, job_id=job_id or None,
            send_type="reply", content=text,
        )


def _set_status(company_id: int, job_id: Optional[str], status: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO conversations(company_id, job_id, status, updated_at) "
            "VALUES (?, ?, ?, datetime('now','localtime'))",
            (company_id, job_id, status),
        )
        if job_id:
            conn.execute("UPDATE jobs SET status = ? WHERE id = ?", (status, job_id))


def mark_resume_sent(*, company: str, job_id: Optional[str]) -> dict:
    """扩展自动发送简历后回传。"""
    with db() as conn:
        company_id = company_registry.get_or_create(conn, company)
        conn.execute(
            "INSERT INTO messages(company_id, job_id, direction, content, send_type, counted_today, status) "
            "VALUES (?, ?, 'outbound', ?, 'resume_sent', 0, 'sent')",
            (company_id, job_id, "（自动发送简历）"),
        )
    company_registry.mark_resume_sent(company_id)
    return {"ok": True, "company_id": company_id}