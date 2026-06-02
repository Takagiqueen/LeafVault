"""Static documentation checks for LeafVault project presentation docs."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


REQUIRED_FILES = [
    "README.md",
    "docs/PROJECT_OVERVIEW.md",
    "docs/ARCHITECTURE.md",
    "docs/ROADMAP.md",
    "docs/SCREENSHOT_GUIDE.md",
    "docs/images/.gitkeep",
]

README_REQUIRED_MARKERS = [
    "# LeafVault",
    "项目简介",
    "核心功能",
    "技术栈",
    "架构概览",
    "快速开始",
    "Docker 自托管",
    "测试与质量门禁",
    "当前限制",
    "后续规划",
    "docs/SECURITY_HARDENING.md",
    "docs/DEPLOYMENT_DOCKER.md",
    "docs/REGRESSION_TEST_PLAN.md",
]

DOC_REQUIRED_MARKERS = {
    "docs/PROJECT_OVERVIEW.md": [
        "LeafVault 是什么",
        "为什么做这个项目",
        "核心使用场景",
        "项目当前阶段",
        "当前限制",
    ],
    "docs/ARCHITECTURE.md": [
        "```mermaid",
        "前端结构",
        "后端结构",
        "数据流",
        "本地优先设计",
        "加密备份设计",
        "同步设计",
        "认证设计",
        "部署结构",
        "架构限制",
    ],
    "docs/ROADMAP.md": [
        "v0.1 当前目标",
        "已完成",
        "短期计划",
        "中期计划",
        "长期计划",
    ],
    "docs/SCREENSHOT_GUIDE.md": [
        "推荐截图列表",
        "截图尺寸建议",
        "截图命名建议",
        "隐私提醒",
        "docs/images/",
    ],
}

FORBIDDEN_CLAIMS = [
    "绝对安全",
    "军事级加密",
    "完全无法破解",
    "无漏洞",
]

SECRET_PATTERNS = [
    r"SECRET_KEY\s*=\s*(?!change-me|<|your-|test-secret)[A-Za-z0-9_\-]{24,}",
    r"AI_API_KEY\s*=\s*(?:sk-|[A-Za-z0-9_\-]{32,})",
    r"SENDER_PASSWORD\s*=\s*[A-Za-z0-9_\-]{16,}",
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def iter_markdown_files() -> list[Path]:
    files = [ROOT / "README.md"]
    docs_dir = ROOT / "docs"
    if docs_dir.exists():
        files.extend(sorted(docs_dir.rglob("*.md")))
    return files


def run_checks() -> list[str]:
    errors: list[str] = []
    for rel_path in REQUIRED_FILES:
        if not (ROOT / rel_path).exists():
            errors.append(f"Missing required documentation file: {rel_path}")
    if errors:
        return errors

    readme = read("README.md")
    for marker in README_REQUIRED_MARKERS:
        if marker not in readme:
            errors.append(f"README.md missing required section or link: {marker}")

    if "```mermaid" not in readme:
        errors.append("README.md must include a Mermaid architecture diagram")

    for rel_path, markers in DOC_REQUIRED_MARKERS.items():
        source = read(rel_path)
        for marker in markers:
            if marker not in source:
                errors.append(f"{rel_path} missing required marker: {marker}")

    markdown_sources = [(path, path.read_text(encoding="utf-8")) for path in iter_markdown_files()]
    for path, source in markdown_sources:
        rel = path.relative_to(ROOT)
        if "DEPLOYMENT_MODE=self-hosted-public" in source:
            errors.append(f"{rel} contains unsupported DEPLOYMENT_MODE=self-hosted-public; use DEPLOYMENT_MODE=public")
        if "DEPLOYMENT_MODE=docker" in source:
            errors.append(f"{rel} contains unsupported DEPLOYMENT_MODE=docker; use local/lan/public")
        if rel.as_posix() == "README.md" and "AUTH_RETURN_TOKEN_IN_LOGIN_RESPONSE" in source:
            errors.append("README.md documents unsupported AUTH_RETURN_TOKEN_IN_LOGIN_RESPONSE")
        for phrase in FORBIDDEN_CLAIMS:
            if phrase in source:
                errors.append(f"{rel} contains over-strong security/product claim: {phrase}")
        for pattern in SECRET_PATTERNS:
            if re.search(pattern, source):
                errors.append(f"{rel} appears to contain a real secret-like value: {pattern}")
        if re.search(r"!\[[^\]]*\]\(https?://", source, flags=re.IGNORECASE):
            errors.append(f"{rel} references an external image; use docs/images/ instead")

    if re.search(r"https?://[^\s)]+\.(?:png|jpe?g|webp|gif|svg)", readme, flags=re.IGNORECASE):
        errors.append("README.md must not reference external preview images")

    deployment_docker = read("docs/DEPLOYMENT_DOCKER.md")
    if "docker-compose.yml 中包含" in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must name docker-compose.prod.yml instead of generic docker-compose.yml")
    if "确认 `docker-compose.yml`" in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must not use generic docker-compose.yml in troubleshooting")
    bare_compose_commands = [
        "docker compose up -d",
        "docker compose down",
        "docker compose logs -f",
        "docker compose ps",
    ]
    for command in bare_compose_commands:
        if command in deployment_docker:
            errors.append(f"docs/DEPLOYMENT_DOCKER.md must use explicit -f compose files instead of bare command: {command}")
    if ".env.production" not in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must document .env.production for Docker/server deployment")
    if "公网生产必须使用 HTTPS" not in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must state that public production requires HTTPS")
    if "http://电脑局域网IP:8001" not in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must document local Docker phone access via 电脑局域网IP:8001")
    if "http://localhost:8000" in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must not use localhost:8000 for local Docker testing; use 127.0.0.1:8001")
    if "http://127.0.0.1:8000" in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must not use 127.0.0.1:8000 for local Docker testing; use 127.0.0.1:8001")
    if "reverse_proxy leafvault:8000" not in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must show the Compose Caddy target reverse_proxy leafvault:8000")
    if "reverse_proxy 127.0.0.1:8000" in deployment_docker:
        errors.append("docs/DEPLOYMENT_DOCKER.md must not use reverse_proxy 127.0.0.1:8000 for the Compose Caddy example")

    return errors


def main() -> int:
    errors = run_checks()
    if errors:
        print("Docs static check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("Docs static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
