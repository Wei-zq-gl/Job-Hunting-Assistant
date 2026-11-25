"""软评分：调用 qwen-plus 输出匹配分 / 理由 / 风险点 / 建议问题。"""
from __future__ import annotations

import json

from config import settings
from db import db
from llm import prompts, qwen_client
from models import ScoreResult


def score_job_data(*, title: str, company: str, salary: str, city: str, jd: str) -> ScoreResult:
    messages = [
        {"role": "system", "content": prompts.SCORER_SYSTEM},
        {"role": "user", "content": prompts.scorer_user(title, company, salary, city, jd)},
    ]
    data, raw = qwen_client.chat_json(messages, temperature=0.2)
    try:
        score = int(data.get("score", 0))
    except (TypeError, ValueError):
        score = 0
    return ScoreResult(
        score=max(0, min(100, score)),
        reason=str(data.get("reason", "")),
        risks=[str(x) for x in (data.get("risks") or [])],
        questions=[str(x) for x in (data.get("questions") or [])],
        raw=raw,
    )


def score_job(job_id: str) -> ScoreResult:
    """读取 jobs 表 → 评分 → 回写。"""
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise ValueError(f"job 不存在: {job_id}")
        job = dict(row)
        result = score_job_data(
            title=job["title"], company="", salary=job["salary"] or "",
            city=job["city"] or "", jd=job["jd"] or "",
        )
        # 评分只决定「展示/达标」，入队状态由 /api/queue/enqueue 单独设置，
        # 避免仅因分数高就被标记为「已入队待发送」而无法手动入队。
        status = "candidate" if result.score >= settings.AUTO_OUTREACH_MIN_SCORE else "displayed_only"
        conn.execute(
            "UPDATE jobs SET match_score = ?, match_reason = ?, match_risk = ?, "
            "match_questions = ?, status = ? WHERE id = ?",
            (
                result.score, result.reason,
                json.dumps(result.risks, ensure_ascii=False),
                json.dumps(result.questions, ensure_ascii=False),
                status, job_id,
            ),
        )
    return result