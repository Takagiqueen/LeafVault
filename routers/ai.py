import sqlite3

import httpx

from fastapi import APIRouter, Depends, Form, Request

from core.config import AI_API_KEY, AI_BASE_URL, VALID_MODELS, logger
from core.dependencies import get_current_user
from core.rate_limit import limiter

router = APIRouter()

@router.post("/api/ai/polish")
@limiter.limit("10/minute")
async def ai_polish_diary(
    request: Request,
    content: str = Form(...),
    style: str = Form(...),
    model: str = Form("chat"),
    current_user: sqlite3.Row = Depends(get_current_user),
):
    if not AI_API_KEY:
        return {"status": "error", "message": "系统未配置 AI 密钥，该功能暂不可用"}

    content = content.strip()

    if len(content) < 5:
        return {"status": "error", "message": "日记内容太短，多写几个字再让 AI 帮你润色吧！"}

    if len(content) > 2000:
        return {"status": "error", "message": "日记内容过长（超过2000字），请分段润色"}

    # 只允许前端传 chat / reason，其他异常值一律回退到 chat
    model_type = model if model in VALID_MODELS else "chat"
    target_model = VALID_MODELS[model_type]

    system_prompt = "你是一个贴心、懂情感的私人日记助理。请帮用户润色日记，保持第一人称。"

    user_prompt = (
        f"请将以下日记内容，以【{style}】的风格进行重写和润色。\n"
        "要求：保持原意，自然流畅。不要输出任何解释性或开场白的话语，直接输出润色后的正文。\n\n"
        f"原内容：{content}"
    )

    headers = {
        "Authorization": f"Bearer {AI_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": target_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        # chat   -> DeepSeek V4 Flash 非思考模式
        # reason -> DeepSeek V4 Pro   思考模式
        "thinking": {
            "type": "enabled" if model_type == "reason" else "disabled"
        },
    }

    # 深度模式调用 Pro，并开启较高推理强度
    if model_type == "reason":
        payload["reasoning_effort"] = "high"

    try:
        logger.info("AI 润色请求：model_type=%s, target_model=%s", model_type, target_model)

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{AI_BASE_URL.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            )

            response.raise_for_status()
            result = response.json()

            message_data = result["choices"][0]["message"]
            polished_text = message_data.get("content", "").strip()
            reasoning = message_data.get("reasoning_content", "").strip()

            if not polished_text:
                return {"status": "error", "message": "AI 没有返回有效内容，请稍后重试"}

            return {
                "status": "success",
                "data": polished_text,
                "reasoning": reasoning,
            }

    except httpx.TimeoutException:
        return {"status": "error", "message": "AI 思考太久超时了，请换用标准模式或稍后重试"}

    except httpx.HTTPStatusError as e:
        logger.error("AI 接口请求失败：%s - %s", e.response.status_code, e.response.text)
        return {
            "status": "error",
            "message": f"AI 服务暂时不可用（错误码：{e.response.status_code}）",
        }

    except Exception as e:
        logger.exception("AI 润色接口未知异常：%s", e)
        return {"status": "error", "message": "AI 服务出现未知错误，请稍后重试"}

