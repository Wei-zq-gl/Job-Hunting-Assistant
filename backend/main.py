"""FastAPI 入口：BOSS Agent 本地服务。

职责：接收扩展上报的岗位 / 回复 / ACK，执行过滤、评分、话术、队列与统计。
所有数据落在本地 SQLite（data/boss_agent.db），不上传云端。

启动：
    cd backend && uvicorn main:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import hashlib
import json
from typing import Optional

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from db import db, get_conn, get_int_setting, init_db, rows_to_dicts
from llm import qwen_client
from models import (
    AckRequest,
    EnqueueRequest,
    JobIngestRequest,
    OkResponse,
    ReplyInbound,
    ResumeSent,
    SettingItem,
    StatsOut,
)
from services import company_registry, filter, reply_monitor, scorer, sender

app = FastAPI(title="BOSS Agent", version="0.1.0")

# 本地个人场景：允许扩展（chrome-extension://）直连
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 建表（幂等）；模块导入即保证 schema 就绪
init_db()


# ---------------- 健康检查 ----------------
@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "llm_configured": qwen_client.is_configured(),
        "model": settings.LLM_MODEL,
        "db": str(settings.DB_PATH),
        "circuit_broken": sender.is_circuit_broken(),
    }


# ---------------- 岗位采集 ----------------
def _make_job_id(job_id: Optional[str], url: str, title: str, company: str) -> str:
    if job_id:
        return job_id
    if url:
        return hashlib.md5(url.encode("utf-8")).hexdigest()[:16]
    return hashlib.md5(f"{company}|{title}".encode("utf-8")).hexdigest()[:16]


@app.post("/api/jobs/ingest")
def ingest_jobs(payload: JobIngestRequest = Body(...)) -> dict:
    """扩展上报岗位卡片：硬过滤 + 入库（可选立即评分）。"""
    created, dropped, scored = 0, 0, 0
    results = []

    for item in payload.jobs:
        jid = _make_job_id(item.id, item.url, item.title, item.company)
        fr = filter.hard_filter(
            title=item.title, city=item.city, salary=item.salary, jd=item.jd
        )
        rng = filter.parse_salary(item.salary)

        with db() as conn:
            company_id = company_registry.get_or_create(conn, item.company)
            conn.execute(
                """
                INSERT INTO jobs(id, company_id, title, city, area, salary, salary_min, salary_max,
                                 experience, education, jd, url, filter_pass, filter_reason, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    salary = excluded.salary, jd = excluded.jd,
                    filter_pass = excluded.filter_pass, filter_reason = excluded.filter_reason
                """,
                (
                    jid, company_id, item.title, item.city, item.area, item.salary,
                    rng[0] if rng else None, rng[1] if rng else None,
                    item.experience, item.education, item.jd, item.url,
                    1 if fr.passed else 0, fr.reason_text,
                    "candidate" if fr.passed else "dropped",
                ),
            )

        if not fr.passed:
            dropped += 1
        else:
            created += 1
            if item.auto_score and qwen_client.is_configured():
                try:
                    scorer.score_job(jid)
                    scored += 1
                except Exception as exc:  # 评分失败不影响入库
                    results.append({"id": jid, "score_error": str(exc)})

        results.append({"id": jid, "filter_pass": fr.passed, "filter_reason": fr.reason_text})

    return {
        "ok": True,
        "received": len(payload.jobs),
        "passed_filter": created,
        "dropped": dropped,
        "scored": scored,
        "results": results,
    }


@app.get("/api/jobs")
def list_jobs(
    status: Optional[str] = Query(default=None),
    min_score: Optional[int] = Query(default=None),
    sort: str = Query(default="score"),          # score / new / salary
    limit: Optional[int] = Query(default=None, ge=1, le=5000),  # 不传则返回全部
) -> dict:
    order = {
        "score": "j.match_score IS NULL, j.match_score DESC, j.created_at DESC",
        "new": "j.created_at DESC",
        "salary": "j.salary_max IS NULL, j.salary_max DESC, j.match_score DESC",
    }.get(sort, "j.match_score IS NULL, j.match_score DESC, j.created_at DESC")

    sql = (
        "SELECT j.*, c.name AS company, c.is_whitelisted AS company_whitelisted "
        "FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE 1=1"
    )
    args: list = []
    if status:
        sql += " AND j.status = ?"
        args.append(status)
    if min_score is not None:
        sql += " AND j.match_score >= ?"
        args.append(min_score)
    sql += f" ORDER BY {order}"
    if limit is not None:
        sql += " LIMIT ?"
        args.append(limit)

    conn = get_conn()
    try:
        rows = conn.execute(sql, args).fetchall()
        return {"ok": True, "count": len(rows), "jobs": rows_to_dicts(rows)}
    finally:
        conn.close()


@app.post("/api/jobs/{job_id}/score")
def score_one(job_id: str) -> dict:
    if not qwen_client.is_configured():
        raise HTTPException(400, "未配置 DASHSCOPE_API_KEY")
    try:
        result = scorer.score_job(job_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"ok": True, "result": result.model_dump()}


# ---------------- 发送队列 ----------------
@app.post("/api/queue/enqueue")
def queue_enqueue(req: EnqueueRequest = Body(...)) -> dict:
    conn = get_conn()
    try:
        job = conn.execute("SELECT * FROM jobs WHERE id = ?", (req.job_id,)).fetchone()
        if not job:
            raise HTTPException(404, "job 不存在")
        job = dict(job)

        if not job["filter_pass"] and not req.force:
            raise HTTPException(400, f"未通过硬过滤：{job['filter_reason']}")

        company = conn.execute(
            "SELECT * FROM companies WHERE id = ?", (job["company_id"],)
        ).fetchone()
        company = dict(company) if company else {}

        # 白名单硬校验：我发过 / HR 主动找我的公司，一律不再主动外呼（force 也不能绕过）
        if company.get("is_whitelisted"):
            raise HTTPException(400, "该公司已在白名单（我主动联系过或 HR 主动找我），不再主动外呼")

        if not req.force:
            if company.get("is_blacklisted"):
                raise HTTPException(400, "公司在黑名单")
            score = job["match_score"] or 0
            min_score = get_int_setting("auto_outreach_min_score", settings.AUTO_OUTREACH_MIN_SCORE)
            if score < min_score:
                raise HTTPException(400, f"匹配分 {score} 低于阈值 {min_score}")
            if sender.quota_left() <= 0:
                raise HTTPException(400, "今日首轮外呼已达上限")
    finally:
        conn.close()

    content = job.get("outreach_text") or ""
    if not content:
        from services import message_generator

        content = message_generator.generate_first_outreach(
            title=job["title"], company=company.get("name", ""),
            jd=job["jd"] or "", score=job["match_score"] or 0,
        )

    with db() as conn:
        qid = sender.enqueue(
            conn, company_id=job["company_id"], job_id=job["id"],
            send_type="first_outreach", content=content,
        )
        conn.execute("UPDATE jobs SET status = 'pending_outreach' WHERE id = ?", (job["id"],))

    return {"ok": True, "queue_id": qid, "content": content}


@app.get("/api/queue/next")
def queue_next(type: Optional[str] = Query(default=None)) -> dict:
    item, reason = sender.pick_next(type)
    return {
        "ok": True,
        "item": item,
        "reason": reason,
        "wait_seconds": sender.seconds_until_next_send(),
        "quota_left": sender.quota_left(),
        "circuit_broken": sender.is_circuit_broken(),
    }


@app.post("/api/queue/{queue_id}/ack")
def queue_ack(queue_id: int, req: AckRequest = Body(...)) -> dict:
    try:
        return {"ok": True, **sender.ack(queue_id, req.ok, req.error)}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/api/circuit/reset")
def circuit_reset() -> OkResponse:
    sender.reset_circuit()
    return OkResponse(detail="熔断已重置")


# ---------------- 回复 / 简历 ----------------
@app.post("/api/reply/inbound")
def reply_inbound(payload: ReplyInbound = Body(...)) -> dict:
    decision = reply_monitor.handle_inbound(
        company=payload.company,
        job_id=payload.job_id,
        content=payload.content,
        job_title=payload.job_title,
    )
    return {"ok": True, "decision": decision.model_dump()}


@app.post("/api/resume/sent")
def resume_sent(payload: ResumeSent = Body(...)) -> dict:
    return reply_monitor.mark_resume_sent(company=payload.company, job_id=payload.job_id)


# ---------------- 统计 / 设置 ----------------
@app.get("/api/stats/today", response_model=StatsOut)
def stats_today() -> StatsOut:
    """今日统计与当前状态快照。

    口径：
    - first_outreach_today / reply_today：按 messages 当日计数（见 sender）。
    - pending_queue_jobs：待发送队列中的岗位数（send_queue.status='pending'，按 job_id 去重）。
      不用 jobs.status，因为发送永久失败时不会回滚该字段，会虚高。
    - interview_pending：每家公司最新一条 conversations 状态为 interview_pending 的家数。
      不用 jobs.status，因为扩展上报 HR 消息不带 job_id，该字段不会被写入。
    - contacted_companies：我主动发起过首轮外呼的公司数（is_outbound_contacted）。
    """
    conn = get_conn()
    try:
        def scalar(sql: str, args: tuple = ()) -> int:
            return int(conn.execute(sql, args).fetchone()[0])

        queue_jobs = scalar(
            "SELECT COUNT(DISTINCT job_id) FROM send_queue "
            "WHERE status = 'pending' AND job_id IS NOT NULL"
        )
        interview = scalar(
            "SELECT COUNT(*) FROM conversations c "
            "WHERE c.id = (SELECT MAX(id) FROM conversations c2 WHERE c2.company_id = c.company_id) "
            "AND c.status = 'interview_pending'"
        )
        contacted = scalar("SELECT COUNT(*) FROM companies WHERE is_outbound_contacted = 1")
    finally:
        conn.close()

    return StatsOut(
        date=sender.today_str(),
        first_outreach_today=sender.today_first_outreach_count(),
        reply_today=sender.today_reply_count(),
        first_outreach_limit=sender.first_outreach_limit(),
        pending_queue_jobs=queue_jobs,
        interview_pending=interview,
        contacted_companies=contacted,
        circuit_broken=sender.is_circuit_broken(),
    )


@app.get("/api/companies")
def list_companies(
    kind: str = Query(default="contacted"),   # contacted(并集) / outbound / inbound
    limit: Optional[int] = Query(default=None, ge=1, le=5000),  # 不传则返回全部
) -> dict:
    """公司列表（记录与报表用）。contacted = 我发过 ∪ 主动找我。

    不传 limit 时返回全部，保证列表条数与 summary 计数一致。
    """
    where = {
        "outbound": "is_outbound_contacted = 1",
        "inbound": "is_inbound_contacted = 1",
    }.get(kind, "(is_outbound_contacted = 1 OR is_inbound_contacted = 1)")

    conn = get_conn()
    try:
        sql = (
            "SELECT id, name, is_outbound_contacted, is_inbound_contacted, is_whitelisted, "
            "resume_sent, last_contact_at, created_at FROM companies "
            f"WHERE {where} ORDER BY last_contact_at DESC, id DESC"
        )
        args: list = []
        if limit is not None:
            sql += " LIMIT ?"
            args.append(limit)
        rows = conn.execute(sql, args).fetchall()
        outbound = conn.execute(
            "SELECT COUNT(*) FROM companies WHERE is_outbound_contacted = 1"
        ).fetchone()[0]
        inbound = conn.execute(
            "SELECT COUNT(*) FROM companies WHERE is_inbound_contacted = 1"
        ).fetchone()[0]
        # 已沟通过 = 我主动联系 ∪ HR 主动来聊（去重）
        contacted = conn.execute(
            "SELECT COUNT(*) FROM companies "
            "WHERE is_outbound_contacted = 1 OR is_inbound_contacted = 1"
        ).fetchone()[0]
        return {
            "ok": True,
            "count": len(rows),
            "summary": {
                "outbound": int(outbound),
                "inbound": int(inbound),
                "contacted": int(contacted),
            },
            "companies": rows_to_dicts(rows),
        }
    finally:
        conn.close()


@app.get("/api/interviews")
def list_interviews(limit: Optional[int] = Query(default=None, ge=1, le=5000)) -> dict:
    """面试邀约待跟进：每家公司最新会话状态为 interview_pending。

    不传 limit 时返回全部，保证列表条数与 stats.interview_pending 一致。
    """
    conn = get_conn()
    try:
        sql = (
            "SELECT c.name AS company, v.updated_at, v.job_id, "
            "j.title AS job_title, j.url AS job_url "
            "FROM conversations v "
            "JOIN companies c ON c.id = v.company_id "
            "LEFT JOIN jobs j ON j.id = v.job_id "
            "WHERE v.id = (SELECT MAX(id) FROM conversations x WHERE x.company_id = v.company_id) "
            "AND v.status = 'interview_pending' "
            "ORDER BY v.updated_at DESC"
        )
        args: list = []
        if limit is not None:
            sql += " LIMIT ?"
            args.append(limit)
        rows = conn.execute(sql, args).fetchall()
        return {"ok": True, "count": len(rows), "interviews": rows_to_dicts(rows)}
    finally:
        conn.close()


@app.get("/api/settings")
def get_settings_api() -> dict:
    conn = get_conn()
    try:
        rows = conn.execute("SELECT key, value FROM settings ORDER BY key").fetchall()
        return {"ok": True, "settings": rows_to_dicts(rows)}
    finally:
        conn.close()


@app.put("/api/settings")
def put_settings(items: list[SettingItem] = Body(...)) -> dict:
    from db import DEFAULT_SETTINGS, set_setting

    allowed = set(DEFAULT_SETTINGS) - {"circuit_broken"}  # 熔断只走 /api/circuit/reset
    updated = 0
    for it in items:
        if it.key in allowed:
            set_setting(it.key, it.value)
            updated += 1
    return {"ok": True, "updated": updated}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=False)