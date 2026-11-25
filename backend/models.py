"""Pydantic 请求 / 响应模型。"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# ---------------- 岗位采集 ----------------
class JobIngest(BaseModel):
    """扩展 read 到的单条岗位卡片。"""

    id: Optional[str] = None            # BOSS job id；缺省时后端用 url 摘要生成
    title: str
    company: str
    salary: str = ""
    city: str = ""
    area: str = ""
    experience: str = ""
    education: str = ""
    jd: str = ""
    url: str = ""
    auto_score: bool = True             # 是否立即触发 LLM 评分


class JobIngestRequest(BaseModel):
    jobs: list[JobIngest]


class JobOut(BaseModel):
    id: str
    title: str = ""
    company: str = ""
    salary: str = ""
    city: str = ""
    area: str = ""
    experience: str = ""
    education: str = ""
    jd: str = ""
    url: str = ""
    filter_pass: Optional[int] = None
    filter_reason: str = ""
    match_score: Optional[int] = None
    match_reason: str = ""
    match_risk: str = ""
    match_questions: str = ""
    status: str = "candidate"
    created_at: str = ""


class ScoreResult(BaseModel):
    score: int = Field(ge=0, le=100)
    reason: str = ""
    risks: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)
    raw: str = ""


# ---------------- 队列 / 发送 ----------------
class EnqueueRequest(BaseModel):
    job_id: str
    force: bool = False                 # 跳过分数/去重校验（手动加入）


class QueueItemOut(BaseModel):
    id: int
    job_id: str
    company_id: Optional[int]
    company_name: str = ""
    send_type: str
    content: str
    counted_today: int = 1
    retry_count: int = 0


class AckRequest(BaseModel):
    ok: bool
    error: Optional[str] = None         # 验证码 / 登录失效 / 选择器失败 等


SessionStatus = Literal["active", "interview_pending", "closed_by_llm"]


# ---------------- 回复监控 ----------------
class ReplyInbound(BaseModel):
    company: str
    job_id: Optional[str] = None
    content: str
    job_title: Optional[str] = None      # 对方岗位名称（扩展从聊天页右栏读取）
    conversation_id: Optional[int] = None


class ReplyDecision(BaseModel):
    action: Literal["decline", "manual_interview", "request_resume", "reply", "close"]
    reason: str = ""
    reply_text: Optional[str] = None


# ---------------- 简历 / 统计 / 设置 ----------------
class ResumeSent(BaseModel):
    company: str
    job_id: Optional[str] = None


class StatsOut(BaseModel):
    date: str
    first_outreach_today: int
    reply_today: int
    first_outreach_limit: int
    pending_queue_jobs: int          # 待发送队列中的岗位数（send_queue.status='pending'）
    interview_pending: int           # 最新会话状态为 interview_pending 的公司数
    contacted_companies: int         # 我主动发起过首轮外呼的公司数（is_outbound_contacted）
    circuit_broken: bool


class SettingItem(BaseModel):
    key: str
    value: str


class OkResponse(BaseModel):
    ok: bool = True
    detail: Any = None