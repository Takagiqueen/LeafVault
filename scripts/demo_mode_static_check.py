"""Static checks for LeafVault local-only Demo mode."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    target = ROOT / path
    if not target.exists():
        raise AssertionError(f"Missing required file: {path}")
    return target.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"Missing {label}: {needle}")


def assert_not_contains(text: str, pattern: str, label: str) -> None:
    if re.search(pattern, text, flags=re.IGNORECASE | re.DOTALL):
        raise AssertionError(f"Forbidden pattern found in {label}: {pattern}")


def main() -> int:
    failures: list[str] = []
    try:
        index = read("templates/index.html")
        session_js = read("static/js/modules/session.js")
        local_db_js = read("static/js/modules/local-db.js")
        request_js = read("static/js/api/request.js")
        backup_js = read("static/js/modules/backup.js")
        sync_js = read("static/js/modules/incremental-sync.js")
        diary_js = read("static/js/modules/diary.js")
        ledger_js = read("static/js/modules/ledger.js")
        docs = read("docs/DEMO_MODE.md")

        for name in [
            "setSessionMode",
            "getSessionMode",
            "isDemoMode",
            "enterDemoMode",
            "exitDemoMode",
            "restoreDemoSession",
            "clearDemoData",
        ]:
            assert_contains(session_js, name, f"session function {name}")

        assert_contains(session_js, "demo-local-user", "Demo local user id")
        assert_contains(session_js, "leafvault_demo_v1", "Demo workspace id")
        assert_contains(local_db_js, "leafvault_demo_v1", "Demo IndexedDB workspace")
        assert_contains(local_db_js, "getDemoLocalDBName", "Demo DB name helper")

        assert_contains(index, "enterDemoModeBtn", "Demo entry button id")
        assert_contains(index, "体验 Demo", "Demo entry copy")
        assert_contains(index, "demoModeBanner", "Demo mode banner")
        assert_contains(index, "数据仅保存在当前浏览器", "Demo local-only copy")

        assert_contains(request_js, "DEMO_ALLOWED_API_PATHS", "Demo API allowlist")
        assert_contains(request_js, "/api/deployment/status", "Deployment status allowed in Demo")
        assert_contains(request_js, "shouldBlockDemoApiRequest", "Demo apiFetch guard")
        assert_contains(request_js, "Demo mode local only", "Demo blocked error marker")

        assert_contains(backup_js, "notifyDemoLocalOnly", "Cloud backup Demo block")
        assert_contains(backup_js, "isDemoMode", "Cloud backup Demo mode guard")
        assert_contains(sync_js, "notifyDemoLocalOnly", "Incremental sync Demo block")
        assert_contains(sync_js, "isDemoMode", "Incremental sync Demo mode guard")
        assert_contains(sync_js, "renderManualSyncStatus('Demo 模式仅支持本地体验。')", "Manual sync Demo block")
        assert_contains(sync_js, "return null", "Manual sync Demo return")

        assert_contains(diary_js, "demo_image_data_urls", "Demo diary local images")
        assert_contains(diary_js, "filesToDiaryDataUrls", "Demo image local persistence")
        assert_contains(ledger_js, "isDemoMode", "Ledger Demo guard")

        assert_contains(docs, "Demo 模式", "Demo documentation title")
        assert_contains(docs, "不会上传到服务器", "Demo documentation cloud boundary")

        assert_not_contains(session_js, r"localStorage\.setItem\([^)]*csrf", "session csrf storage")
        assert_not_contains(session_js, r"localStorage\.setItem\([^)]*password", "session password storage")
        assert_not_contains(session_js, r"sessionStorage\.setItem\([^)]*(token|csrf|password)", "session sensitive storage")
        combined = "\n".join([session_js, request_js, diary_js, ledger_js, backup_js, sync_js])
        assert_not_contains(combined, r"console\.log\([^)]*(token|csrf|password|decryptedPayload|plainPayload)", "sensitive console log")

    except AssertionError as exc:
        failures.append(str(exc))

    if failures:
        print("Demo mode static check failed:")
        for failure in failures:
            print(f" - {failure}")
        return 1

    print("Demo mode static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
