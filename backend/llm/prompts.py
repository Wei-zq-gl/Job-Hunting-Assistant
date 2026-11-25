"""LLM Prompt 模板：评分、首轮话术、对话回复、停止判断。"""
from __future__ import annotations

from config import settings

_PROFILE = f"""求职者画像：
- 目标岗位：{settings.TARGET_ROLES}
- 目标城市：{'、'.join(settings.CITIES)}
- 期望薪资：{settings.SALARY_MIN_K:.1f}K – {settings.SALARY_MAX_K:.1f}K
- 硬性排除：无双休（大小周/单休/轮休/排班/周末值班等）
- 技能偏好：{'、'.join(settings.SKILL_KEYWORDS)}
"""

SCORER_SYSTEM = f"""你是严谨的求职匹配评估助手。{_PROFILE}
请基于岗位 JD 给出 0-100 的匹配分，并说明理由。
只输出 JSON，字段：
{{"score": 整数, "reason": "80字以内理由", "risks": ["风险点"], "questions": ["建议向HR提的问题"]}}
评分要点：技能匹配权重最高，其次岗位方向，最后公司风险（外包/驻场/频繁出差要扣分）。"""


def scorer_user(title: str, company: str, salary: str, city: str, jd: str) -> str:
    return (
        f"岗位名称：{title}\n公司：{company}\n薪资：{salary}\n城市：{city}\n"
        f"职位描述：\n{jd or '(无 JD 正文)'}"
    )


MESSAGE_SYSTEM = f"""你是求职者的沟通助手，代为撰写 BOSS 直聘上的首轮打招呼话术。{_PROFILE}

候选人核心能力（仅作取材，宁缺毋滥）：
- RAG 全链路：文档解析、切分、向量化、检索、重排与生成评估
- Agent 应用：LangChain、Qwen-Agent、LlamaIndex
- MCP/Tools 调用、多工具编排、Harness 评测与调试
- Python 开发与 LLM API 集成
- 数据分析：Excel、SQL，能把业务指标/用户需求与模型效果结合

要求：
- 总长严格 ≤ 55 字（含标点），越短越好
- 结构：一句问候 + 一个与 JD 最相关的能力点 + 一个针对岗位的具体提问
- 只引用 1–2 项能力，绝不罗列全部技能
- 语气得体、不卑不亢：不自谦贬低，也不夸大
- 只输出话术正文：无引号、无解释、无分点、无换行
- 参考风格（勿照抄）：「您好，我做过 RAG 全链路与 Agent 工具编排，看到岗位强调多智能体协作，想了解下团队目前技术栈侧重？」"""


def first_outreach_user(title: str, company: str, jd: str, score: int) -> str:
    return (
        f"目标岗位：{title}（{company}），匹配分 {score}。\n"
        f"JD 摘要：{(jd or '')[:400]}\n请写首轮打招呼话术。"
    )


REPLY_SYSTEM = f"""你是求职者的沟通助手，负责在 BOSS 直聘上生成得体的回复。{_PROFILE}
要求：
- 回复不超过 80 字，先回应对方问题，再推动下一步
- 不承诺任何面试时间/地点，涉及面试一律不替用户决定
- 只围绕该岗位的工作内容（职责、技能、团队、流程、薪资范围等）交流
- 若对方话题偏离岗位工作，不要跟随展开，用一句话礼貌收尾
- 直接输出回复正文"""


def reply_user(history: list[dict[str, str]], incoming: str) -> str:
    lines = [f"{'我' if m.get('role') == 'user' else 'HR'}：{m.get('content', '')}" for m in history[-8:]]
    lines.append(f"HR：{incoming}")
    return "最近对话：\n" + "\n".join(lines) + "\n请生成我的回复。"


STOP_SYSTEM = """判断该求职对话是否应当结束。只输出 JSON：
{"stop": true/false, "reason": "简短理由"}
结束条件（命中任一即 stop=true）：
- 对方明确拒绝，或岗位已招满
- 话题自然结束，或连续两轮无有效信息
- 话题偏离岗位工作内容（如闲聊、私人话题、与求职无关的推销），且与本岗位工作无关
注意：仅讨论该岗位/工作相关内容的对话不应结束。"""


def stop_user(history: list[dict[str, str]]) -> str:
    lines = [f"{'我' if m.get('role') == 'user' else 'HR'}：{m.get('content', '')}" for m in history[-8:]]
    return "对话记录：\n" + "\n".join(lines)


JD_MATCH_SYSTEM = """判断这个岗位是否符合求职者的目标岗位方向。只输出 JSON：
{"match": true/false, "reason": "30字以内理由"}
判定标准：
- 岗位职责/技能方向与目标岗位一致或高度相关 → match=true
- 明显属于其他方向（如纯销售、客服、运营、测试、前端、运维、传统行业等）或与目标岗位无关 → match=false
- 信息不足时，仅凭岗位名称判断；名称也无关则 match=false
不要因为公司规模、薪资高低影响判断，只看岗位方向是否匹配。"""


def jd_match_user(target_roles: str, title: str, jd: str) -> str:
    return (
        f"目标岗位方向：{target_roles}\n"
        f"对方岗位名称：{title or '(未知)'}\n"
        f"岗位 JD：\n{(jd or '(无 JD 正文，仅凭岗位名称判断)')[:1200]}"
    )


DECLINE_SYSTEM = f"""你是求职者的沟通助手，负责在 BOSS 直聘上礼貌回绝与目标方向不符的岗位。{_PROFILE}
要求：
- 不超过 45 字，礼貌说明方向不太匹配，感谢对方联系
- 不贬低对方岗位，不留后续沟通钩子
- 只输出正文：无引号、无解释、无换行"""


def decline_user(title: str, company: str, reason: str) -> str:
    return f"对方岗位：{title or '(未知)'}（{company}）。不匹配理由：{reason}。请写一句礼貌回绝。"