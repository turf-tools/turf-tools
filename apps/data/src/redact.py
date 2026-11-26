"""Mask credentials out of text that gets stored or logged."""

from __future__ import annotations

import re

# `scheme://user:password@host` — the scheme, user, and host stay readable.
_URL_CREDENTIALS = re.compile(r"(\b[A-Za-z][A-Za-z0-9+.-]*://[^\s:/@]+):[^\s@]+@")
# libpq keyword form: `password=secret`, optionally quoted.
_KEYWORD_PASSWORD = re.compile(r"(\bpassword\s*=\s*)('[^']*'|\"[^\"]*\"|[^\s'\"]+)", re.IGNORECASE)


def redact_secrets(text: str) -> str:
    """`text` with connection-string credentials masked, e.g.
    `postgres://app:***@host:5432/db` and `password=***`.

    Database drivers echo the connection string they were given in their error
    messages, so every exception text that's stored or logged passes through
    this first.
    """
    text = _URL_CREDENTIALS.sub(r"\1:***@", text)
    return _KEYWORD_PASSWORD.sub(r"\1***", text)
