"""Static Docker deployment checks for LeafVault.

This script intentionally does not call Docker. It only validates repository
files and obvious safety boundaries for self-hosted deployment.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

REQUIRED_FILES = [
    "Dockerfile",
    ".dockerignore",
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "docker-compose.local.yml",
    ".env.example",
    ".env.production.example",
    "docs/DEPLOYMENT_DOCKER.md",
]

ENV_KEYS = [
    "SECRET_KEY",
    "ACCESS_TOKEN_EXPIRE_DAYS",
    "DATABASE_PATH",
    "UPLOAD_DIR",
    "ENVIRONMENT",
    "LOG_LEVEL",
    "ALLOWED_ORIGINS",
    "AI_API_KEY",
    "AI_BASE_URL",
    "SENDER_EMAIL",
    "SENDER_PASSWORD",
    "SMTP_SERVER",
    "SMTP_PORT",
]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def contains_all(source: str, needles: list[str], label: str) -> list[str]:
    return [f"{label} missing `{needle}`" for needle in needles if needle not in source]


def check_dockerfile() -> list[str]:
    errors: list[str] = []
    source = read("Dockerfile")
    lower = source.lower()
    errors += contains_all(
        source,
        ["FROM python:", "WORKDIR /app", "requirements.txt", "uvicorn", "main:app"],
        "Dockerfile",
    )
    if "npm run build" not in source:
        errors.append("Dockerfile should build Tailwind CSS with `npm run build` for Docker images")
    if "COPY --from=frontend /app/static/output.css /app/static/output.css" not in source:
        errors.append("Dockerfile should copy the generated static/output.css from the frontend build stage")
    if "pip install" not in lower:
        errors.append("Dockerfile missing `pip install`")
    for forbidden in ["--reload", "COPY .env", "ADD .env", "SECRET_KEY=", "AI_API_KEY=", "SENDER_PASSWORD="]:
        if forbidden.lower() in lower:
            errors.append(f"Dockerfile must not contain `{forbidden}`")
    return errors


def check_dockerignore() -> list[str]:
    errors: list[str] = []
    source = read(".dockerignore")
    lines = {line.strip() for line in source.splitlines() if line.strip() and not line.strip().startswith("#")}
    required_any = [
        (".env",),
        (".env.*",),
        ("venv", ".venv"),
        ("node_modules",),
        ("__pycache__", "pycache"),
        ("*.db",),
        ("*.sqlite",),
        ("*.sqlite3",),
        ("repomix-output.xml",),
        ("data",),
        ("uploads",),
    ]
    for choices in required_any:
        if not any(choice in lines for choice in choices):
            errors.append(f".dockerignore must exclude one of: {', '.join(choices)}")
    forbidden_static_assets = {"static/output.css", "input.css", "tailwind.config.js", "package.json", "package-lock.json"}
    blocked = sorted(forbidden_static_assets.intersection(lines))
    if blocked:
        errors.append(f".dockerignore must not exclude frontend build inputs: {', '.join(blocked)}")
    return errors


def check_compose() -> list[str]:
    errors: list[str] = []
    source = read("docker-compose.yml")
    source_flat = compact(source)
    lower = source.lower()
    errors += contains_all(
        source,
        [
            "leafvault:",
            "build:",
            "ports:",
            "env_file:",
            ".env",
            "./data:/app/data",
            "./uploads:/app/uploads",
            "restart: unless-stopped",
            "healthcheck:",
            "/api/health",
        ],
        "docker-compose.yml",
    )
    for forbidden in ["--reload", "SECRET_KEY=", "AI_API_KEY=", "SENDER_PASSWORD="]:
        if forbidden.lower() in lower:
            errors.append(f"docker-compose.yml must not contain `{forbidden}`")
    if re.search(r"sk-[A-Za-z0-9_-]{12,}", source_flat):
        errors.append("docker-compose.yml appears to contain a real API key")
    return errors


def service_block(compose: str, service: str) -> str:
    pattern = rf"(?ms)^  {re.escape(service)}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)"
    match = re.search(pattern, compose)
    return match.group(1) if match else ""


def check_production_compose() -> list[str]:
    errors: list[str] = []
    source = read("docker-compose.prod.yml")
    leafvault_block = service_block(source, "leafvault")
    caddy_block = service_block(source, "caddy")
    if not leafvault_block:
        errors.append("docker-compose.prod.yml missing leafvault service")
    if not caddy_block:
        errors.append("docker-compose.prod.yml missing caddy service")
    for needle in ("env_file:", ".env.production", "expose:", '"8000"', "./data:/app/data", "./uploads:/app/uploads"):
        if needle not in leafvault_block:
            errors.append(f"docker-compose.prod.yml leafvault missing `{needle}`")
    if "ports:" in leafvault_block or "8000:8000" in leafvault_block or "8001:8000" in leafvault_block:
        errors.append("docker-compose.prod.yml leafvault must not publish host ports; use docker-compose.local.yml for local testing")
    for needle in ("ports:", '"80:80"', '"443:443"', "reverse", "caddy:2"):
        if needle == "reverse":
            continue
        if needle not in caddy_block:
            errors.append(f"docker-compose.prod.yml caddy missing `{needle}`")
    for forbidden in ("--reload", "SECRET_KEY=", "AI_API_KEY=", "SENDER_PASSWORD="):
        if forbidden.lower() in source.lower():
            errors.append(f"docker-compose.prod.yml must not contain `{forbidden}`")
    return errors


def check_local_compose() -> list[str]:
    errors: list[str] = []
    source = read("docker-compose.local.yml")
    leafvault_block = service_block(source, "leafvault")
    if not leafvault_block:
        errors.append("docker-compose.local.yml missing leafvault service")
    if "ports:" not in leafvault_block or "8001:8000" not in leafvault_block:
        errors.append("docker-compose.local.yml must publish leafvault as 8001:8000")
    if "--reload" in source:
        errors.append("docker-compose.local.yml must not use --reload")
    return errors


def check_env_example() -> list[str]:
    errors: list[str] = []
    source = read(".env.example")
    for key in ENV_KEYS:
        if not re.search(rf"^{re.escape(key)}=", source, flags=re.MULTILINE):
            errors.append(f".env.example missing `{key}`")
    secret_match = re.search(r"^SECRET_KEY=(.+)$", source, flags=re.MULTILINE)
    if not secret_match:
        errors.append(".env.example missing SECRET_KEY value")
    else:
        secret_value = secret_match.group(1).strip()
        if "change-me" not in secret_value.lower():
            errors.append(".env.example SECRET_KEY should be a change-me placeholder")
    if not re.search(r"SECRET_KEY[\s\S]{0,160}(必须|修改|随机|random)", source):
        errors.append(".env.example must tell users to modify SECRET_KEY")
    if re.search(r"sk-[A-Za-z0-9_-]{12,}", source):
        errors.append(".env.example appears to contain a real API key")
    if re.search(r"(?im)^SENDER_PASSWORD=.{8,}$", source):
        errors.append(".env.example must not contain a real-looking email authorization code")
    return errors


def check_env_production_example() -> list[str]:
    errors: list[str] = []
    source = read(".env.production.example")
    required = {
        "SERVER_UPLOAD_ENABLED": "true",
        "DEMO_SERVER_UPLOAD_ENABLED": "false",
        "COOKIE_SECURE": "true",
        "FORCE_HTTPS": "true",
        "REGISTRATION_MODE": "invite",
    }
    for key, expected in required.items():
        match = re.search(rf"^{re.escape(key)}=(.+)$", source, flags=re.MULTILINE)
        if not match:
            errors.append(f".env.production.example missing `{key}`")
            continue
        if match.group(1).strip().lower() != expected:
            errors.append(f".env.production.example `{key}` should be `{expected}`")
    for key in ("TRUSTED_HOSTS", "ALLOWED_ORIGINS"):
        match = re.search(rf"^{re.escape(key)}=(.+)$", source, flags=re.MULTILINE)
        if not match or match.group(1).strip() == "*":
            errors.append(f".env.production.example `{key}` must not be `*`")
    return errors


def check_deployment_doc() -> list[str]:
    source = read("docs/DEPLOYMENT_DOCKER.md")
    keywords = [
        "docker compose -f docker-compose.prod.yml up -d --build",
        "docker compose -f docker-compose.prod.yml -f docker-compose.local.yml up -d --build",
        ".env.production",
        "SECRET_KEY",
        "data",
        "uploads",
        "/api/health",
        "HTTPS",
        "备份",
    ]
    errors = contains_all(source, keywords, "docs/DEPLOYMENT_DOCKER.md")
    if "Caddy" not in source and "Nginx" not in source:
        errors.append("docs/DEPLOYMENT_DOCKER.md must mention Caddy or Nginx")
    return errors


def run_checks() -> list[str]:
    errors: list[str] = []
    for rel in REQUIRED_FILES:
        if not (ROOT / rel).exists():
            errors.append(f"Missing required file: {rel}")
    if errors:
        return errors
    errors.extend(check_dockerfile())
    errors.extend(check_dockerignore())
    errors.extend(check_compose())
    errors.extend(check_production_compose())
    errors.extend(check_local_compose())
    errors.extend(check_env_example())
    errors.extend(check_env_production_example())
    errors.extend(check_deployment_doc())
    return errors


def main() -> int:
    errors = run_checks()
    if errors:
        print("Docker static check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("Docker static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
