"""Encrypted outbox and branded, accessible Italian/English transactional email."""

import json
import uuid
from datetime import UTC, datetime
from html import escape

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import EmailOutbox
from app.common.crypto import keyring
from app.config import settings


async def queue_email(
    db: AsyncSession,
    user_id: uuid.UUID | None,
    recipient: str,
    subject: str,
    body: str,
    html: str | None = None,
    *,
    registration: dict | None = None,
) -> None:
    row = EmailOutbox(id=uuid.uuid4(), user_id=user_id, created_at=datetime.now(UTC))
    payload = json.dumps(
        {
            "recipient": recipient,
            "subject": subject,
            "body": body,
            "html": html,
            "registration": registration,
        },
        ensure_ascii=False,
    )
    encrypted = keyring.encrypt(payload, purpose="email", aad=f"email:{row.user_id}:{row.id}")
    row.payload_ciphertext = encrypted.ciphertext
    row.payload_nonce = encrypted.nonce
    row.key_version = encrypted.key_version
    db.add(row)
    await db.flush()


def _render(locale: str, title: str, intro: str, *, code=None, url=None, expiry: str):
    it = locale == "it"
    root = settings.app_public_url.rstrip("/")
    instruction = (
        "Torna alla registrazione e inserisci questo codice. Usa il codice dell’ultima email richiesta."
        if it
        else "Return to registration and enter this code. Use the code from your latest requested email."
    )
    button = "Continua su OpenBib" if it else "Continue to OpenBib"
    ignore = (
        "Se non hai richiesto questa operazione, puoi ignorare questa email. Non condividere il codice o il collegamento."
        if it
        else "If you did not request this action, you can ignore this email. Do not share the code or link."
    )
    footer = (
        "Email di servizio relativa al tuo account OpenBib."
        if it
        else "Service email concerning your OpenBib account."
    )
    terms = "Termini" if it else "Terms"
    text = f"OpenBib\n\n{title}\n\n{intro}\n\n"
    if code is not None:
        text += f"{code}\n\n{instruction}\n\n"
        action = f'<p style="margin:24px 0;background:#e4efec;border:1px solid #c3d9d2;border-radius:8px;padding:22px 12px;text-align:center;font-family:monospace;font-size:36px;font-weight:bold;letter-spacing:8px;color:#244c44;">{escape(code)}</p><p style="line-height:1.6;">{escape(instruction)}</p>'
    else:
        text += f"{url}\n\n"
        action = f'<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0;"><tr><td bgcolor="#33695f" style="border-radius:6px;"><a href="{escape(url, quote=True)}" style="display:inline-block;padding:16px 24px;color:#ffffff;text-decoration:none;font-weight:bold;">{button}</a></td></tr></table><p style="font-size:13px;line-height:1.6;overflow-wrap:anywhere;word-break:break-all;"><a href="{escape(url, quote=True)}" style="color:#33695f;">{escape(url)}</a></p>'
    text += f"{expiry}\n\n{ignore}\n\n{footer}\nPrivacy: {root}/privacy\n{terms}: {root}/terms"
    html = f'''<!doctype html>
<html lang="{locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)}</title></head>
<body style="margin:0;padding:0;background:#f8faf9;color:#20352e;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;">{escape(intro)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f8faf9"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #dbe5df;border-radius:12px;">
<tr><td style="padding:28px 28px 20px;border-bottom:1px solid #e4efec;"><img src="cid:openbib-logo" width="36" height="36" alt="Logo OpenBib" style="vertical-align:middle;border:0;"> <span style="vertical-align:middle;font-family:Georgia,serif;font-size:26px;font-weight:bold;color:#33695f;">OpenBib</span></td></tr>
<tr><td style="padding:28px;"><h1 style="margin:0 0 16px;font-size:25px;line-height:1.3;">{escape(title)}</h1><p style="line-height:1.6;">{escape(intro)}</p>{action}<p style="font-size:14px;line-height:1.6;color:#425e53;">{escape(expiry)}</p><p style="margin-top:24px;font-size:13px;line-height:1.6;color:#54675f;">{escape(ignore)}</p></td></tr></table>
<p style="max-width:560px;font-size:12px;line-height:1.7;color:#54675f;">{escape(footer)}<br><a href="{escape(root, quote=True)}/privacy" style="color:#33695f;">Privacy</a> · <a href="{escape(root, quote=True)}/terms" style="color:#33695f;">{terms}</a></p>
</td></tr></table></body></html>'''
    return title, text, html


def registration_email(locale: str, code: str, expires_at) -> tuple[str, str, str]:
    stamp = expires_at.strftime("%d/%m/%Y %H:%M UTC")
    return _render(
        locale,
        "Il tuo codice di verifica OpenBib" if locale == "it" else "Your OpenBib verification code",
        "Conferma il tuo indirizzo email per creare il tuo account."
        if locale == "it"
        else "Confirm your email address to create your account.",
        code=code,
        expiry=f"Scadenza del codice: {stamp}." if locale == "it" else f"Code expires: {stamp}.",
    )


def lifecycle_email(kind: str, locale: str, token: str) -> tuple[str, str, str]:
    routes = {"reset_password": "reset-password", "change_email": "confirm-email"}
    url = f"{settings.app_public_url.rstrip('/')}/{routes[kind]}#token={token}"
    messages = {
        "it": {
            "reset_password": (
                "Reimposta la password OpenBib",
                "Hai richiesto una nuova password. Usa il pulsante per sceglierla.",
                "Il collegamento scade tra un’ora.",
            ),
            "change_email": (
                "Conferma la nuova email OpenBib",
                "Conferma questo indirizzo per aggiornare l’email del tuo account.",
                "Il collegamento scade tra 24 ore.",
            ),
        },
        "en": {
            "reset_password": (
                "Reset your OpenBib password",
                "You requested a new password. Use the button to choose it.",
                "This link expires in one hour.",
            ),
            "change_email": (
                "Confirm your new OpenBib email",
                "Confirm this address to update your account email.",
                "This link expires in 24 hours.",
            ),
        },
    }
    title, intro, expiry = messages[locale][kind]
    return _render(locale, title, intro, url=url, expiry=expiry)
