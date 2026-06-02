import re
import sqlite3
from collections import Counter
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Request, Response

from core.dependencies import get_current_user
from core.rate_limit import limiter
from core.validators import validate_month_param
from db.database import get_db

router = APIRouter()

NEGATIVE_MOODS = {"有点累", "想休息", "不太好"}
POSITIVE_MOODS = {"开心", "还不错", "很好", "平静"}


@router.get("/api/stats/monthly_summary")
@limiter.limit("60/minute")
def get_stats_monthly_summary(
    request: Request,
    month: Optional[str] = None,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    month = validate_month_param(month)
    cursor = db.cursor()
    user_id = current_user["user_id"]
    cursor.execute(
        "SELECT SUM(amount) FROM ledgers WHERE user_id=? AND type='income' AND created_at LIKE ?",
        (user_id, f"{month}%"),
    )
    total_income = cursor.fetchone()[0] or 0.0
    cursor.execute(
        "SELECT SUM(amount) FROM ledgers WHERE user_id=? AND type='expense' AND created_at LIKE ?",
        (user_id, f"{month}%"),
    )
    total_expense = cursor.fetchone()[0] or 0.0
    return {
        "status": "success",
        "data": {
            "month": month,
            "total_income": round(total_income, 2),
            "total_expense": round(total_expense, 2),
            "balance": round(total_income - total_expense, 2),
        },
    }


@router.get("/api/stats/pie")
@limiter.limit("60/minute")
def get_stats_pie(
    request: Request,
    month: Optional[str] = None,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    month = validate_month_param(month)
    cursor = db.cursor()
    cursor.execute(
        "SELECT category, SUM(amount) as total FROM ledgers "
        "WHERE user_id=? AND type='expense' AND created_at LIKE ? GROUP BY category ORDER BY total DESC",
        (current_user["user_id"], f"{month}%"),
    )
    return {"status": "success", "data": [{"value": row["total"], "name": row["category"]} for row in cursor.fetchall()]}


@router.get("/api/stats/monthly_bar")
@limiter.limit("60/minute")
def get_stats_monthly_bar(
    request: Request,
    month: Optional[str] = None,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    month = validate_month_param(month)
    cursor = db.cursor()
    cursor.execute(
        "SELECT created_at, SUM(amount) as total FROM ledgers "
        "WHERE user_id=? AND type='expense' AND created_at LIKE ? GROUP BY created_at ORDER BY created_at ASC",
        (current_user["user_id"], f"{month}%"),
    )
    rows = cursor.fetchall()
    return {
        "status": "success",
        "data": {"dates": [r["created_at"] for r in rows], "amounts": [r["total"] for r in rows]},
    }


@router.get("/api/stats/trend_7d")
@limiter.limit("60/minute")
def get_stats_trend_7d(
    request: Request,
    days: int = 7,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    # 前端只允许 7/15 天切换，避免任意扩大统计窗口。
    days = 15 if days == 15 else 7
    today = datetime.now()
    end_date = today.strftime("%Y-%m-%d")
    start_date = (today - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    dates = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days - 1, -1, -1)]

    cursor = db.cursor()
    cursor.execute(
        "SELECT created_at, COALESCE(SUM(amount), 0) as total FROM ledgers "
        "WHERE user_id=? AND type='expense' AND created_at BETWEEN ? AND ? GROUP BY created_at",
        (current_user["user_id"], start_date, end_date),
    )
    db_map = {row["created_at"]: row["total"] for row in cursor.fetchall()}
    return {"status": "success", "data": {"dates": dates, "amounts": [db_map.get(d, 0) for d in dates]}}


@router.get("/api/calendar")
@limiter.limit("60/minute")
def get_calendar_data(
    request: Request,
    month: str,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    month = validate_month_param(month)
    cursor = db.cursor()
    user_id = current_user["user_id"]
    cursor.execute(
        "SELECT created_at, SUM(amount) as total FROM ledgers "
        "WHERE user_id=? AND type='expense' AND created_at LIKE ? GROUP BY created_at",
        (user_id, f"{month}%"),
    )
    expenses = {row["created_at"]: row["total"] for row in cursor.fetchall()}
    cursor.execute("SELECT date, mood_label FROM diaries WHERE user_id=? AND date LIKE ?", (user_id, f"{month}%"))
    moods = {row["date"]: row["mood_label"] for row in cursor.fetchall()}
    return {"status": "success", "data": {"expenses": expenses, "moods": moods}}


@router.get("/api/report")
@limiter.limit("10/minute")
def get_periodic_report(
    request: Request,
    response: Response,
    period: str,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    # v1 仅作为兼容接口保留；新前端统一依赖 /api/report/v2。
    response.headers["Deprecation"] = "true"
    response.headers["Link"] = '</api/report/v2>; rel="successor-version"'

    period = validate_month_param(period, "period")
    cursor = db.cursor()
    user_id = current_user["user_id"]
    cursor.execute(
        "SELECT date, mood_label, content FROM diaries WHERE user_id=? AND date LIKE ?",
        (user_id, f"{period}%"),
    )
    diaries = cursor.fetchall()
    cursor.execute(
        "SELECT created_at, amount, type FROM ledgers WHERE user_id=? AND created_at LIKE ?",
        (user_id, f"{period}%"),
    )
    ledgers = cursor.fetchall()

    total_expense = sum(row["amount"] for row in ledgers if row["type"] == "expense")
    negative_days = {row["date"] for row in diaries if row["mood_label"] in NEGATIVE_MOODS}
    emotional_expense = sum(
        row["amount"] for row in ledgers if row["type"] == "expense" and row["created_at"] in negative_days
    )
    tags = re.findall(r"#[\w\u4e00-\u9fff-]+", " ".join(row["content"] or "" for row in diaries))
    top_tags = [tag for tag, _ in Counter(tags).most_common(3)]

    if total_expense > 0:
        emo_ratio = (emotional_expense / total_expense) * 100
        insight = (
            f"低能量日期关联支出 {emotional_expense:.2f} 元，占总支出 {emo_ratio:.1f}%。下次心情不佳时，可以先散步或听歌替代冲动消费。"
            if emo_ratio > 15
            else "本期情绪消费控制得很稳，心情起伏没有明显影响钱包。"
        )
    else:
        insight = "本期还没有记录任何支出，是个轻盈的记账周期。"

    return {
        "status": "success",
        "data": {
            "diary_count": len(diaries),
            "total_expense": round(total_expense, 2),
            "emotional_expense": round(emotional_expense, 2),
            "top_tags": top_tags,
            "insight": insight,
        },
    }


@router.get("/api/report/v2")
@limiter.limit("10/minute")
def get_periodic_report_v2(
    request: Request,
    period: str,
    current_user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
):
    period = validate_month_param(period, "period")
    cursor = db.cursor()
    user_id = current_user["user_id"]

    cursor.execute(
        "SELECT date, mood_label, content FROM diaries "
        "WHERE user_id=? AND date LIKE ? ORDER BY date ASC",
        (user_id, f"{period}%"),
    )
    diaries = cursor.fetchall()

    cursor.execute(
        "SELECT created_at, amount, type, category, note FROM ledgers "
        "WHERE user_id=? AND created_at LIKE ? ORDER BY created_at ASC",
        (user_id, f"{period}%"),
    )
    ledgers = cursor.fetchall()

    total_income = sum(row["amount"] for row in ledgers if row["type"] == "income")
    total_expense = sum(row["amount"] for row in ledgers if row["type"] == "expense")
    balance = total_income - total_expense

    try:
        period_dt = datetime.strptime(period + "-01", "%Y-%m-%d")
        prev_month_dt = (period_dt.replace(day=1) - timedelta(days=1)).replace(day=1)
        prev_period = prev_month_dt.strftime("%Y-%m")
    except ValueError:
        prev_period = period

    cursor.execute(
        "SELECT SUM(amount) FROM ledgers WHERE user_id=? AND type='expense' AND created_at LIKE ?",
        (user_id, f"{prev_period}%"),
    )
    previous_expense = cursor.fetchone()[0] or 0.0
    expense_delta = total_expense - previous_expense
    expense_delta_ratio = (expense_delta / previous_expense * 100) if previous_expense else None

    mood_counter = Counter(row["mood_label"] for row in diaries if row["mood_label"])
    dominant_mood = mood_counter.most_common(1)[0][0] if mood_counter else "暂无记录"
    negative_days = {row["date"] for row in diaries if row["mood_label"] in NEGATIVE_MOODS}
    positive_days = {row["date"] for row in diaries if row["mood_label"] in POSITIVE_MOODS}

    daily_expenses = Counter()
    category_expenses = Counter()
    emotional_expense = 0.0
    for row in ledgers:
        if row["type"] != "expense":
            continue
        daily_expenses[row["created_at"]] += row["amount"]
        category_expenses[row["category"]] += row["amount"]
        if row["created_at"] in negative_days:
            emotional_expense += row["amount"]

    peak_day, peak_amount = daily_expenses.most_common(1)[0] if daily_expenses else ("暂无", 0.0)
    top_category, top_category_amount = (
        category_expenses.most_common(1)[0] if category_expenses else ("暂无", 0.0)
    )
    emotional_ratio = (emotional_expense / total_expense * 100) if total_expense else 0.0

    first_half_expense = sum(v for k, v in daily_expenses.items() if int(k[-2:]) <= 15)
    second_half_expense = max(total_expense - first_half_expense, 0.0)
    if second_half_expense > first_half_expense * 1.2 and second_half_expense > 0:
        spending_pace = "下半月支出明显抬升，适合提前设置周预算提醒。"
    elif first_half_expense > second_half_expense * 1.2 and first_half_expense > 0:
        spending_pace = "上半月支出更集中，后半段控制得更稳。"
    elif total_expense > 0:
        spending_pace = "整月消费节奏比较均衡，没有明显集中爆发。"
    else:
        spending_pace = "本期没有支出记录，账本压力很低。"

    all_content = " ".join(row["content"] or "" for row in diaries)
    tags = re.findall(r"#[\w\u4e00-\u9fff-]+", all_content)
    top_tags = [tag for tag, _ in Counter(tags).most_common(5)]
    cleaned_content = re.sub(r"#[\w\u4e00-\u9fff-]+", " ", all_content)
    raw_terms = re.findall(r"[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_-]{2,}", cleaned_content)
    stopwords = {
        "今天", "感觉", "觉得", "一个", "这个", "那个", "自己", "还是", "没有", "就是",
        "因为", "所以", "但是", "然后", "已经", "可以", "真的", "有点", "生活",
        "工作", "学习", "记录", "事情", "时候", "本月", "起来", "继续", "比较",
    }
    top_keywords = [word for word, _ in Counter(w for w in raw_terms if w not in stopwords).most_common(6)]
    diary_theme = "、".join(top_keywords[:4]) if top_keywords else ("、".join(top_tags[:3]) if top_tags else "还没有形成稳定主题")

    mood_summary = (
        f"本期共记录 {len(diaries)} 篇日记，最常出现的心情是「{dominant_mood}」。"
        f"低能量日 {len(negative_days)} 天，积极/平稳日 {len(positive_days)} 天。"
        if diaries
        else "本期还没有心情记录。"
    )
    content_summary = (
        f"这段时间的日记主要围绕「{diary_theme}」展开。"
        if diaries
        else "本期还没有日记内容，暂时无法总结生活主题。"
    )
    finance_summary = (
        f"本期收入 {total_income:.2f} 元，支出 {total_expense:.2f} 元，结余 {balance:.2f} 元。"
        f"支出最高日期是 {peak_day}，金额 {peak_amount:.2f} 元；主要消费分类是「{top_category}」。"
    )
    if previous_expense > 0 and expense_delta_ratio is not None:
        change_word = "增加" if expense_delta > 0 else "减少"
        finance_change = f"相比上月支出{change_word} {abs(expense_delta):.2f} 元，变化约 {abs(expense_delta_ratio):.1f}%。"
    elif total_expense > 0:
        finance_change = "上月暂无可对比支出，本期会作为之后趋势判断的基线。"
    else:
        finance_change = "暂无支出变化可分析。"

    if total_expense > 0 and emotional_ratio > 15:
        insight = (
            f"低能量日期关联支出 {emotional_expense:.2f} 元，占本期支出 {emotional_ratio:.1f}%。"
            "下次情绪低落时，可以先延迟消费 10 分钟，给自己一个缓冲。"
        )
    elif total_expense > 0:
        insight = (
            f"低能量日期关联支出 {emotional_expense:.2f} 元，占比 {emotional_ratio:.1f}%。"
            "情绪对消费的影响目前比较可控。"
        )
    else:
        insight = "本期没有支出记录，财务侧非常轻盈。"

    return {
        "status": "success",
        "data": {
            "diary_count": len(diaries),
            "mood_summary": mood_summary,
            "content_summary": content_summary,
            "finance_summary": finance_summary,
            "finance_change": finance_change,
            "spending_pace": spending_pace,
            "insight": insight,
            "dominant_mood": dominant_mood,
            "mood_distribution": dict(mood_counter),
            "top_tags": top_tags,
            "top_keywords": top_keywords,
            "total_income": round(total_income, 2),
            "total_expense": round(total_expense, 2),
            "balance": round(balance, 2),
            "previous_expense": round(previous_expense, 2),
            "expense_delta": round(expense_delta, 2),
            "expense_delta_ratio": round(expense_delta_ratio, 1) if expense_delta_ratio is not None else None,
            "emotional_expense": round(emotional_expense, 2),
            "emotional_ratio": round(emotional_ratio, 1),
            "peak_day": peak_day,
            "peak_amount": round(peak_amount, 2),
            "top_category": top_category,
            "top_category_amount": round(top_category_amount, 2),
        },
    }
