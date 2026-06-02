import smtplib
from email.header import Header
from email.mime.text import MIMEText

from core.config import SENDER_EMAIL, SENDER_PASSWORD, SMTP_PORT, SMTP_SERVER, logger

def send_email_code(target_email: str, code: str, action_type: str) -> bool:
    if not SENDER_EMAIL or not SENDER_PASSWORD:
        logger.error("邮件凭证未配置")
        return False
    action_text = "注册新账号" if action_type == "register" else "重置密码"
    subject = "【LeafVault】系统验证码"
    content = (
        f"您正在进行【{action_text}】操作。\n\n"
        f"您的验证码是：【 {code} 】\n\n"
        "验证码在 5 分钟内有效，请勿泄露给他人。\n"
        "如非本人操作，请忽略此邮件。"
    )
    msg = MIMEText(content, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"]    = SENDER_EMAIL
    msg["To"]      = target_email
    try:
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, timeout=10) as server:
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.sendmail(SENDER_EMAIL, [target_email], msg.as_string())
        return True
    except Exception as e:
        logger.error(f"邮件发送失败: {e}")
        return False
