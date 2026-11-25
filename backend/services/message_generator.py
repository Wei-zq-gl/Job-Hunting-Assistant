"""话术生成：首轮打招呼 + 对话回复 + JD 方向判定 + 礼貌回绝。

LLM 不可用时回退到保守模板，保证链路不中断。
所有输出都归一化为「单条消息」：压掉换行/多空格并限长，确保一次只发一条。
"""
from __future__ import annotations

import re

from llm import prompts, qwen_client

_FIRST_FALLBACK = "您好，我对{title}岗位很感兴趣，我在 AI Agent / RAG 方向有相关项目经验，方便了解下团队目前的技术栈吗？"
_REPLY_FALLBACK = "收到，感谢回复。想再确认一下这个岗位的核心技术方向，方便的话可以简单介绍下吗？"
_DECLINE_FALLBACK = "感谢您的联系，这个岗位方向和我的求职目标不太一致，祝您招聘顺利。"


def _single_line(text: str, limit: int = 120) -> str:
    """归一化为单条消息：压换行/多空格，去首尾空白，超长截断。"""
    t = re.sub(r"\s+", " ", (text or "")).strip()
    if len(t) > limit:
        t = t[: limit - 1].rstrip() + "…"
    return t


def generate_first_outreach(*, title: str, company: str, jd: str, score: int) -> str:
    messages = [
        {"role": "system", "content": prompts.MESSAGE_SYSTEM},
        {"role": "user", "content": prompts.first_outreach_user(title, company, jd, score)},
    ]
    try:
        text = qwen_client.chat(messages, temperature=0.6, max_tokens=120).strip()
        return _single_line(text, 80) or _FIRST_FALLBACK.format(title=title)
    except Exception:
        return _FIRST_FALLBACK.format(title=title)


def generate_reply(*, history: list[dict[str, str]], incoming: str) -> str:
    messages = [
        {"role": "system", "content": prompts.REPLY_SYSTEM},
        {"role": "user", "content": prompts.reply_user(history, incoming)},
    ]
    try:
        text = qwen_client.chat(messages, temperature=0.5, max_tokens=220).strip()
        return _single_line(text, 100) or _REPLY_FALLBACK
    except Exception:
        return _REPLY_FALLBACK


def jd_matches_target(*, title: str, jd: str, target_roles: str) -> tuple[bool, str]:
    """判断对方岗位方向是否符合目标岗位。返回 (匹配, 理由)。

    判定失败（LLM 不可用等）时默认按「匹配」处理，避免误回绝真实机会。
    """
    messages = [
        {"role": "system", "content": prompts.JD_MATCH_SYSTEM},
        {"role": "user", "content": prompts.jd_match_user(target_roles, title, jd)},
    ]
    try:
        data, _ = qwen_client.chat_json(messages, temperature=0.1)
    except Exception as exc:
        return True, f"判定失败，默认按匹配处理：{exc}"
    return bool(data.get("match")), str(data.get("reason", ""))


def generate_decline(*, title: str, company: str, reason: str) -> str:
    """生成一句礼貌回绝（单条消息）。"""
    messages = [
        {"role": "system", "content": prompts.DECLINE_SYSTEM},
        {"role": "user", "content": prompts.decline_user(title, company, reason)},
    ]
    try:
        text = qwen_client.chat(messages, temperature=0.3, max_tokens=80).strip()
        return _single_line(text, 60) or _DECLINE_FALLBACK
    except Exception:
        return _DECLINE_FALLBACK