"""全局配置：求职画像、限流参数、LLM、关键词。

所有硬性参数与 PRD「用户画像 / 业务规则」保持一致；
可用环境变量覆盖（见 .env.example）。
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # Boss_agent/
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# 载入 .env（可选依赖，缺失时静默跳过）
try:
    from dotenv import load_dotenv

    load_dotenv(BASE_DIR / ".env")
except Exception:  # pragma: no cover
    pass


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, default))
    except (TypeError, ValueError):
        return default


class Settings:
    # ---------- 服务 ----------
    HOST: str = os.getenv("HOST", "127.0.0.1")
    PORT: int = _env_int("PORT", 8000)

    # ---------- 存储 ----------
    DB_PATH: Path = DATA_DIR / "boss_agent.db"

    # ---------- LLM（DashScope 兼容模式）----------
    DASHSCOPE_API_KEY: str = os.getenv("DASHSCOPE_API_KEY", "")
    DASHSCOPE_BASE_URL: str = os.getenv(
        "DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    LLM_MODEL: str = os.getenv("LLM_MODEL", "qwen-max")
    LLM_TIMEOUT: int = _env_int("LLM_TIMEOUT", 60)

    # ---------- 求职画像 ----------
    CITIES: list[str] = ["上海", "武汉", "南京", "杭州", "苏州", "郑州"]
    SALARY_MIN_K: float = 12.0  # 1.2w
    SALARY_MAX_K: float = 20.0  # 2w
    TARGET_ROLES: str = "AI Agent 开发 / AI 产品经理"

    # ---------- 限流（业务规则）----------
    DAILY_FIRST_OUTREACH_LIMIT: int = _env_int("DAILY_FIRST_OUTREACH_LIMIT", 8)
    SEND_INTERVAL_MIN: int = _env_int("SEND_INTERVAL_MIN", 30)
    SEND_INTERVAL_MAX: int = _env_int("SEND_INTERVAL_MAX", 60)
    AUTO_OUTREACH_MIN_SCORE: int = _env_int("AUTO_OUTREACH_MIN_SCORE", 80)
    MAX_CONSECUTIVE_FAILURES: int = _env_int("MAX_CONSECUTIVE_FAILURES", 3)

    # ---------- 关键词 ----------
    NO_WEEKEND_KEYWORDS: list[str] = [
        "大小周", "单休", "轮休", "排班", "周末值班", "做六休一",
        "一周六天", "6天工作制", "弹性单休", "周末轮班",
    ]
    DIRECTION_KEYWORDS: list[str] = [
        "AI", "Agent", "智能体", "大模型", "LLM", "RAG",
        "LangChain", "产品经理", "Prompt", "NLP", "算法",
    ]
    SKILL_KEYWORDS: list[str] = [
        "Python", "RAG", "LangChain", "LlamaIndex", "Qwen", "MCP",
        "Function Call", "Tools", "Prompt", "SQL", "Excel", "需求分析", "PRD",
    ]
    RISK_KEYWORDS: list[str] = ["外包", "驻场", "派遣", "频繁出差", "出差"]

    # 命中即转人工（面试相关）
    INTERVIEW_KEYWORDS: list[str] = [
        "面试", "面谈", "复试", "笔试", "面试官", "约面", "微信", "电话", "到岗", "offer",
    ]
    # 命中即触发简历自动发送
    RESUME_KEYWORDS: list[str] = ["简历", "附件", "发我", "发一份", "投递"]


settings = Settings()