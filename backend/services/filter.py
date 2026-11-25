"""硬过滤：城市 / 薪资 / 无双休 / 方向。

纯规则，不依赖 LLM。返回 (是否通过, 原因)。命中任一即淘汰。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from config import settings
from db import get_float_setting, get_list_setting

_SALARY_RANGE = re.compile(r"(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*([Kk千Ww万])")
_SALARY_ABOVE = re.compile(r"(\d+(?:\.\d+)?)\s*([Kk千Ww万])\s*以上")
_SALARY_BELOW = re.compile(r"(\d+(?:\.\d+)?)\s*([Kk千Ww万])\s*以下")


def _to_k(value: float, unit: str) -> float:
    return value * 10 if unit.lower() in ("w", "万") else value


def parse_salary(text: str) -> Optional[tuple[float, float]]:
    """解析 '15-25K·13薪' / '1.2-2万' / '20K以上' → (min_K, max_K)。失败返回 None。"""
    if not text:
        return None
    t = str(text).replace(" ", "")
    m = _SALARY_RANGE.search(t)
    if m:
        return _to_k(float(m.group(1)), m.group(3)), _to_k(float(m.group(2)), m.group(3))
    m = _SALARY_ABOVE.search(t)
    if m:
        return _to_k(float(m.group(1)), m.group(2)), float("inf")
    m = _SALARY_BELOW.search(t)
    if m:
        return 0.0, _to_k(float(m.group(1)), m.group(2))
    return None


@dataclass
class FilterResult:
    passed: bool
    reasons: list[str]

    @property
    def reason_text(self) -> str:
        return "通过硬过滤" if self.passed else " · ".join(self.reasons)


def hard_filter(
    *,
    title: str = "",
    city: str = "",
    salary: str = "",
    jd: str = "",
) -> FilterResult:
    reasons: list[str] = []

    # 运行时设置（DB 优先，回退 config 默认值），支持侧边栏改画像
    cities = get_list_setting("cities", settings.CITIES)
    salary_min_k = get_float_setting("salary_min", settings.SALARY_MIN_K)
    salary_max_k = get_float_setting("salary_max", settings.SALARY_MAX_K)

    # 1) 城市
    if not any(c in (city or "") for c in cities):
        reasons.append(f"城市不符({city or '空'})")

    # 2) 薪资是否有交集
    rng = parse_salary(salary)
    if rng is None:
        reasons.append("薪资无法解析")
    elif not (rng[0] <= salary_max_k and rng[1] >= salary_min_k):
        reasons.append(f"薪资不符({salary})")

    # 3) 无双休排除词
    text = f"{title or ''} {jd or ''}"
    hit = [k for k in settings.NO_WEEKEND_KEYWORDS if k in text]
    if hit:
        reasons.append(f"无双休关键词({'/'.join(hit)})")

    # 4) 岗位方向
    upper_title = (title or "").upper()
    if not any(k.upper() in upper_title for k in settings.DIRECTION_KEYWORDS):
        reasons.append("方向不符")

    return FilterResult(passed=not reasons, reasons=reasons)


def matched_skills(title: str, jd: str) -> list[str]:
    text = f"{title or ''} {jd or ''}".upper()
    return [k for k in settings.SKILL_KEYWORDS if k.upper() in text]


def risk_hits(jd: str) -> list[str]:
    text = jd or ""
    return [k for k in settings.RISK_KEYWORDS if k in text]