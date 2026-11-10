"""User-Agent value sent by every outbound request: ``<APP_NAME>/<version> (+<APP_CONTACT>)``."""

import os
import re
from collections.abc import Mapping

_PRODUCT_TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_PRINTABLE_ASCII_WITHOUT_COMMENT_DELIMITERS = re.compile(r"[\x20-\x27\x2a-\x5b\x5d-\x7e]+")
_ASCII_WHITESPACE = " \t\n\v\f\r"


class MissingSettingError(LookupError):
    """A required environment setting is absent or empty."""


def user_agent(app_name: str, version: str, contact: str) -> str:
    """Build the header value; raise ``ValueError`` for parts that are invalid or injectable.

    The contact is trimmed of ASCII whitespace and must be printable ASCII without ``(``, ``)``
    or ``\\``.
    """
    if not _PRODUCT_TOKEN.fullmatch(app_name):
        msg = f"User-Agent app name must be a non-empty HTTP token, got {app_name!r}"
        raise ValueError(msg)
    if not _PRODUCT_TOKEN.fullmatch(version):
        msg = f"User-Agent version must be a non-empty HTTP token, got {version!r}"
        raise ValueError(msg)
    trimmed_contact = contact.strip(_ASCII_WHITESPACE)
    if not _PRINTABLE_ASCII_WITHOUT_COMMENT_DELIMITERS.fullmatch(trimmed_contact):
        msg = (
            "User-Agent contact must be a non-empty URL or e-mail address in printable ASCII "
            "without parentheses or backslashes"
        )
        raise ValueError(msg)
    return f"{app_name}/{version} (+{trimmed_contact})"


def user_agent_from_env(version: str, environ: Mapping[str, str] = os.environ) -> str:
    """Build the header from ``APP_NAME`` and ``APP_CONTACT`` in ``environ``."""
    return user_agent(_required(environ, "APP_NAME"), version, _required(environ, "APP_CONTACT"))


def _required(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name, "")
    if not value.strip():
        msg = f"{name} is not set; copy .env.example to .env and fill it in"
        raise MissingSettingError(msg)
    return value
