"""Static release checks for LeafVault v0.1.0 freeze artifacts."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_CLAIMS = [
    "绝对安全",
    "军事级加密",
    "完全无法破解",
    "永远无法泄露",
]
SECRET_PATTERNS = [
    r"sk-[A-Za-z0-9_-]{20,}",
    r"SECRET_KEY\s*=\s*(?!change-me|test|testing)[A-Za-z0-9_\-]{24,}",
    r"SENDER_PASSWORD\s*=\s*[^\\s`]+",
]


def read(path: str) -> str:
    target = ROOT / path
    if not target.exists():
        raise AssertionError(f"Missing required file: {path}")
    return target.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"Missing {label}: {needle}")


def assert_not_contains(text: str, needle: str, label: str) -> None:
    if needle in text:
        raise AssertionError(f"Forbidden wording in {label}: {needle}")


def assert_no_secret_patterns(text: str, label: str) -> None:
    for pattern in SECRET_PATTERNS:
        if re.search(pattern, text, flags=re.IGNORECASE):
            raise AssertionError(f"Potential secret found in {label}: {pattern}")


def main() -> int:
    failures: list[str] = []
    try:
        version = read("VERSION").strip()
        changelog = read("CHANGELOG.md")
        checklist = read("docs/V0_1_RELEASE_CHECKLIST.md")
        readme = read("README.md")

        if version != "0.1.0":
            raise AssertionError("VERSION must be exactly 0.1.0")

        for path in ["VERSION", "CHANGELOG.md", "docs/V0_1_RELEASE_CHECKLIST.md"]:
            if not (ROOT / path).exists():
                raise AssertionError(f"Missing required release file: {path}")

        for text, label in [(readme, "README.md"), (changelog, "CHANGELOG.md"), (checklist, "release checklist")]:
            assert_no_secret_patterns(text, label)
            for forbidden in FORBIDDEN_CLAIMS:
                assert_not_contains(text, forbidden, label)

        assert_contains(changelog, "v0.1.0", "CHANGELOG version")
        assert_contains(changelog, "已知限制", "CHANGELOG known limits")
        assert_contains(changelog, "后续规划", "CHANGELOG roadmap")
        assert_contains(checklist, "python scripts/quality_gate.py", "quality gate checklist command")
        assert_contains(checklist, "python scripts/public_deploy_preflight.py --example", "production preflight command")
        assert_contains(checklist, "docker compose -f docker-compose.prod.yml up -d --build", "production compose command")
        assert_contains(checklist, "https://your-domain.com/api/health", "health check URL")
        assert_contains(checklist, "https://your-domain.com/api/deployment/status", "deployment status URL")
        assert_contains(checklist, "邀请码注册", "invite registration manual test")
        assert_contains(checklist, "Demo", "Demo manual test")
        assert_contains(checklist, "8000 没有直接暴露公网", "server port check")

        assert_contains(readme, "v0.1.0", "README current version")
        assert_contains(readme, "Demo", "README Demo mode")
        assert_contains(readme, "邀请码", "README invite registration")
        assert_contains(readme, "docs/PUBLIC_DEPLOYMENT.md", "README public deployment doc")
        assert_contains(readme, "docs/V0_1_RELEASE_CHECKLIST.md", "README release checklist doc")

    except AssertionError as exc:
        failures.append(str(exc))

    if failures:
        print("Release static check failed:")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print("Release static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
