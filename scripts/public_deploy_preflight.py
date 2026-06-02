"""LeafVault public deployment preflight checks.

This script intentionally checks only example files. It does not read real
.env files, does not require Docker, and does not access the network.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

ENV_FILE = ROOT / ".env.production.example"
COMPOSE_FILE = ROOT / "docker-compose.prod.yml"
LOCAL_COMPOSE_FILE = ROOT / "docker-compose.local.yml"
CADDY_FILE = ROOT / "deploy/Caddyfile.prod.example"


REQUIRED_ENV_KEYS = [
    "SECRET_KEY",
    "ENVIRONMENT",
    "DEPLOYMENT_MODE",
    "LEAFVAULT_DOMAIN",
    "PUBLIC_BASE_URL",
    "TRUSTED_HOSTS",
    "FORCE_HTTPS",
    "REGISTRATION_MODE",
    "REGISTRATION_INVITE_CODE",
    "ACCESS_TOKEN_EXPIRE_DAYS",
    "DATABASE_PATH",
    "UPLOAD_DIR",
    "LOG_LEVEL",
    "ALLOWED_ORIGINS",
    "COOKIE_SECURE",
    "SERVER_UPLOAD_ENABLED",
    "DEMO_SERVER_UPLOAD_ENABLED",
    "AI_API_KEY",
    "AI_BASE_URL",
    "SENDER_EMAIL",
    "SENDER_PASSWORD",
    "SMTP_SERVER",
    "SMTP_PORT",
]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_example_env(source: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def has_real_secret(source: str) -> bool:
    secret_patterns = [
        r"sk-[A-Za-z0-9_-]{16,}",
        r"SECRET_KEY=(?!change-me)[A-Za-z0-9_\-]{32,}",
        r"SENDER_PASSWORD=[A-Za-z0-9_\-]{12,}",
        r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    ]
    return any(re.search(pattern, source) for pattern in secret_patterns)


def check_env_example() -> list[str]:
    errors: list[str] = []
    if not ENV_FILE.exists():
        return ["Missing .env.production.example"]
    source = read(ENV_FILE)
    values = parse_example_env(source)

    for key in REQUIRED_ENV_KEYS:
        if key not in values:
            errors.append(f".env.production.example missing {key}")

    if values.get("ENVIRONMENT") != "production":
        errors.append("ENVIRONMENT must be production in .env.production.example")
    if values.get("DEPLOYMENT_MODE") != "public":
        errors.append("DEPLOYMENT_MODE must be public in .env.production.example")
    if values.get("REGISTRATION_MODE") != "invite":
        errors.append("REGISTRATION_MODE should default to invite in .env.production.example")
    if not values.get("REGISTRATION_INVITE_CODE"):
        errors.append("REGISTRATION_INVITE_CODE placeholder is required in .env.production.example")
    if not values.get("PUBLIC_BASE_URL", "").startswith("https://"):
        errors.append("PUBLIC_BASE_URL must start with https:// in .env.production.example")
    if values.get("TRUSTED_HOSTS") == "*":
        errors.append("TRUSTED_HOSTS must not be * in .env.production.example")
    if values.get("ALLOWED_ORIGINS") == "*":
        errors.append("ALLOWED_ORIGINS must not be * in .env.production.example")
    if values.get("COOKIE_SECURE", "").lower() != "true":
        errors.append("COOKIE_SECURE must be true in .env.production.example")
    if values.get("FORCE_HTTPS", "").lower() != "true":
        errors.append("FORCE_HTTPS should be true in .env.production.example")
    if values.get("SERVER_UPLOAD_ENABLED", "").lower() != "true":
        errors.append("SERVER_UPLOAD_ENABLED should be true in .env.production.example")
    if values.get("DEMO_SERVER_UPLOAD_ENABLED", "").lower() != "false":
        errors.append("DEMO_SERVER_UPLOAD_ENABLED should be false in .env.production.example")
    if "change-me" not in values.get("SECRET_KEY", "").lower():
        errors.append("SECRET_KEY in .env.production.example must remain a placeholder")
    if values.get("LEAFVAULT_DOMAIN") != "leafvault.example.com":
        errors.append("LEAFVAULT_DOMAIN should use leafvault.example.com placeholder")
    if "leafvault.example.com" not in values.get("PUBLIC_BASE_URL", ""):
        errors.append("PUBLIC_BASE_URL should use the placeholder domain")
    if has_real_secret(source):
        errors.append(".env.production.example appears to contain a real secret")
    return errors


def service_block(compose: str, service: str) -> str:
    pattern = rf"(?ms)^  {re.escape(service)}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)"
    match = re.search(pattern, compose)
    return match.group(1) if match else ""


def check_compose_prod() -> list[str]:
    errors: list[str] = []
    if not COMPOSE_FILE.exists():
        return ["Missing docker-compose.prod.yml"]
    source = read(COMPOSE_FILE)
    lower = source.lower()

    for marker in (
        "leafvault:",
        "caddy:",
        "build:",
        "env_file:",
        ".env.production",
        "expose:",
        '"8000"',
        "./data:/app/data",
        "./uploads:/app/uploads",
        "image: caddy:2",
        "ports:",
        '"80:80"',
        '"443:443"',
        "deploy/Caddyfile.prod.example:/etc/caddy/Caddyfile:ro",
    ):
        if marker not in source:
            errors.append(f"docker-compose.prod.yml missing {marker}")

    leafvault_block = service_block(source, "leafvault")
    if "ports:" in leafvault_block:
        errors.append("docker-compose.prod.yml leafvault service must not publish host ports; use docker-compose.local.yml for local testing")
    if "8000:8000" in leafvault_block or "8001:8000" in leafvault_block:
        errors.append("docker-compose.prod.yml leafvault service must not publish 8000:8000 or 8001:8000")
    for forbidden in ("--reload", "SECRET_KEY=", "AI_API_KEY=", "SENDER_PASSWORD="):
        if forbidden.lower() in lower:
            errors.append(f"docker-compose.prod.yml must not contain {forbidden}")
    return errors


def check_compose_local() -> list[str]:
    errors: list[str] = []
    if not LOCAL_COMPOSE_FILE.exists():
        return ["Missing docker-compose.local.yml"]
    source = read(LOCAL_COMPOSE_FILE)
    leafvault_block = service_block(source, "leafvault")
    if not leafvault_block:
        errors.append("docker-compose.local.yml missing leafvault service")
    if "ports:" not in leafvault_block or "8001:8000" not in leafvault_block:
        errors.append("docker-compose.local.yml must publish leafvault as 8001:8000 for local Docker testing")
    if "--reload" in source:
        errors.append("docker-compose.local.yml must not use --reload")
    return errors


def check_caddy_example() -> list[str]:
    errors: list[str] = []
    if not CADDY_FILE.exists():
        return ["Missing deploy/Caddyfile.prod.example"]
    source = read(CADDY_FILE)
    if "{$LEAFVAULT_DOMAIN}" not in source:
        errors.append("Caddyfile.prod.example must use {$LEAFVAULT_DOMAIN}")
    if "reverse_proxy leafvault:8000" not in source:
        errors.append("Caddyfile.prod.example must reverse_proxy leafvault:8000")
    if "leafvault.example.com" in source:
        errors.append("Caddyfile.prod.example must not hardcode a domain")
    if re.search(r"tls\s+\S+@\S+", source):
        errors.append("Caddyfile.prod.example must not hardcode an email")
    if has_real_secret(source):
        errors.append("Caddyfile.prod.example appears to contain a real secret")
    return errors


def run_example_checks() -> list[str]:
    errors: list[str] = []
    errors.extend(check_env_example())
    errors.extend(check_compose_prod())
    errors.extend(check_compose_local())
    errors.extend(check_caddy_example())
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Check LeafVault public deployment example files.")
    parser.add_argument("--example", action="store_true", help="Check example production deployment files only.")
    args = parser.parse_args()
    if not args.example:
        print("Use --example to check example deployment files. Real .env files are intentionally not read.")
        return 2

    errors = run_example_checks()
    if errors:
        print("LeafVault public deployment preflight failed:")
        for error in errors:
            print(f" - {error}")
        return 1

    print("LeafVault public deployment preflight passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
