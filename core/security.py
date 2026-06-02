"""Compatibility facade for LeafVault security helpers.

New code can import focused helpers from:
- core.passwords
- core.tokens
- core.verification

Existing routers can keep importing from core.security during this low-risk split.
"""

from core.passwords import hash_password, verify_password
from core.tokens import create_access_token, security, verify_token
from core.verification import _hash_code, verify_code

__all__ = [
    "_hash_code",
    "create_access_token",
    "hash_password",
    "security",
    "verify_code",
    "verify_password",
    "verify_token",
]
