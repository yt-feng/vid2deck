from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Any


def send_manual_order_notification(order: dict[str, Any]) -> dict[str, Any]:
    to_email = (os.getenv("ORDER_NOTIFY_EMAIL") or "yt.feng@foxmail.com").strip()
    smtp_host = (os.getenv("SMTP_HOST") or "").strip()
    smtp_user = (os.getenv("SMTP_USER") or "").strip()
    smtp_password = (os.getenv("SMTP_PASSWORD") or "").strip()
    smtp_from = (os.getenv("SMTP_FROM") or smtp_user).strip()

    if not smtp_host:
        return {"sent": False, "reason": "SMTP_HOST is not configured"}
    if not smtp_user or not smtp_password or not smtp_from:
        return {"sent": False, "reason": "SMTP_USER, SMTP_PASSWORD or SMTP_FROM is not configured"}

    port = int(os.getenv("SMTP_PORT", "587"))
    use_ssl = env_flag("SMTP_SSL", default=(port == 465))
    use_tls = env_flag("SMTP_TLS", default=not use_ssl)

    msg = EmailMessage()
    service_name = str(order.get("service_name") or "Manual service")
    customer_email = str(order.get("email") or "")
    msg["Subject"] = f"Vid2Deck manual order: {service_name}"
    msg["From"] = smtp_from
    msg["To"] = to_email
    if customer_email:
        msg["Reply-To"] = customer_email
    msg.set_content(render_manual_order_email(order))

    if use_ssl:
        with smtplib.SMTP_SSL(smtp_host, port, timeout=12, context=ssl.create_default_context()) as server:
            server.login(smtp_user, smtp_password)
            server.send_message(msg)
    else:
        with smtplib.SMTP(smtp_host, port, timeout=12) as server:
            if use_tls:
                server.starttls(context=ssl.create_default_context())
            server.login(smtp_user, smtp_password)
            server.send_message(msg)

    return {"sent": True, "to": to_email}


def render_manual_order_email(order: dict[str, Any]) -> str:
    lines = [
        "Vid2Deck received a new manual service order.",
        "",
        f"Service: {order.get('service_name') or ''}",
        f"Customer email: {order.get('email') or ''}",
        f"Quantity: {order.get('quantity') or 1} {order.get('unit_label') or ''}",
        f"Plan key: {order.get('plan') or ''}",
        f"Transaction ID: {order.get('paddle_transaction_id') or ''}",
        f"Customer ID: {order.get('paddle_customer_id') or ''}",
        f"Event ID: {order.get('event_id') or ''}",
        "",
        "Customer note:",
        str(order.get("details") or "(empty)"),
        "",
        "Reply to this email to contact the customer directly.",
    ]
    return "\n".join(lines)


def env_flag(name: str, *, default: bool = False) -> bool:
    value = (os.getenv(name) or "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}
