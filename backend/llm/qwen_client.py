"""DashScope（qwen-plus）兼容模式客户端。

仅用标准库之外的 requests 发起 HTTP 调用，不引入额外 SDK。
Key 取自环境变量 DASHSCOPE_API_KEY（见 config.settings）。
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

import requests

from config import settings


class LLMError(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(settings.DASHSCOPE_API_KEY)


def chat(
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.3,
    max_tokens: int = 1024,
    json_mode: bool = False,
) -> str:
    """调用 /chat/completions，返回首条回复文本。"""
    if not is_configured():
        raise LLMError("未配置 DASHSCOPE_API_KEY，请在环境变量或 .env 中设置")

    url = f"{settings.DASHSCOPE_BASE_URL.rstrip('/')}/chat/completions"
    payload: dict[str, Any] = {
        "model": settings.LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    resp = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {settings.DASHSCOPE_API_KEY}",
            "Content-Type": "application/json",
        },
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        timeout=settings.LLM_TIMEOUT,
    )
    if resp.status_code >= 400:
        raise LLMError(f"DashScope HTTP {resp.status_code}: {resp.text[:400]}")

    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError(f"无法解析 LLM 响应: {str(data)[:400]}") from exc


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)


def extract_json(text: str) -> Optional[dict]:
    """从模型输出里稳健地抠出 JSON 对象。"""
    if not text:
        return None
    candidate = text.strip()
    fence = _JSON_FENCE.search(candidate)
    if fence:
        candidate = fence.group(1).strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        start, end = candidate.find("{"), candidate.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(candidate[start : end + 1])
            except json.JSONDecodeError:
                return None
    return None


def chat_json(messages: list[dict[str, str]], **kwargs: Any) -> tuple[dict, str]:
    """返回 (解析后的 dict, 原始文本)。解析失败时 dict 为空。"""
    kwargs.setdefault("json_mode", True)
    raw = chat(messages, **kwargs)
    return (extract_json(raw) or {}), raw