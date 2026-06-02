"""LeafVault mobile UI guardrails for the profile and sync management areas."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


REQUIRED_TEXT = [
    "数据与同步管理",
    "syncManagementSummary",
    "data-mobile-section=\"sync-management\"",
    "展开云端备份列表与同步高级工具",
    "常用操作",
]

REQUIRED_ACTIONS = [
    'data-backup-action="export-encrypted"',
    'data-backup-action="import-encrypted"',
    'data-backup-action="upload-encrypted"',
    'data-incremental-action="start-manual-sync"',
    'data-incremental-action="run-sync-diagnostics"',
]

SENSITIVE_PATTERNS = [
    r"console\.log\s*\([^)]*(token|password|csrf|decryptedPayload|plainPayload)",
    r"(localStorage|sessionStorage)\.setItem\s*\([^)]*(password|csrf|syncPassword|backupPassword|derivedKey)",
]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def find_duplicate_ids(html: str) -> list[str]:
    ids = re.findall(r'id="([^"]+)"', html)
    seen: set[str] = set()
    duplicates: set[str] = set()
    for item in ids:
        if item in seen:
            duplicates.add(item)
        seen.add(item)
    return sorted(duplicates)


def run_checks() -> list[str]:
    errors: list[str] = []
    index_path = ROOT / "templates/index.html"
    backup_path = ROOT / "static/js/modules/backup.js"
    sync_path = ROOT / "static/js/modules/incremental-sync.js"
    ui_state_path = ROOT / "static/js/modules/ui-state.js"
    if not index_path.exists():
        return ["Missing templates/index.html"]
    if not backup_path.exists() or not sync_path.exists():
        return ["Missing backup.js or incremental-sync.js"]
    if not ui_state_path.exists():
        return ["Missing static/js/modules/ui-state.js"]

    html = read("templates/index.html")
    backup_js = read("static/js/modules/backup.js")
    sync_js = read("static/js/modules/incremental-sync.js")
    ui_state_js = read("static/js/modules/ui-state.js")
    diary_js = read("static/js/modules/diary.js")
    ledger_js = read("static/js/modules/ledger.js")
    combined = "\n".join([html, backup_js, sync_js, ui_state_js, diary_js, ledger_js])

    for text in REQUIRED_TEXT:
        if text not in html:
            errors.append(f"Mobile UI marker missing from index.html: {text}")

    for action in REQUIRED_ACTIONS:
        if action not in combined:
            errors.append(f"Critical profile/sync action missing: {action}")

    if "ui-state.js" not in html:
        errors.append("index.html does not include ui-state.js")

    for function_name in (
        "renderEmptyState",
        "renderLoadingState",
        "renderErrorState",
        "setButtonLoading",
        "normalizeUserFacingError",
    ):
        if function_name not in ui_state_js:
            errors.append(f"ui-state.js missing {function_name}")

    for message in (
        "登录状态校验失败，请刷新页面或重新登录。",
        "文件太大了，请压缩后再上传。",
        "还没有写日记，今天可以先记录一句话。",
        "还没有账本记录，试着添加一笔收入或支出。",
        "还没有云端备份，上传一份加密备份后会显示在这里。",
        "当前没有需要处理的同步冲突。",
        "还没有同步历史，完成一次手动同步后会显示在这里。",
    ):
        if message not in combined:
            errors.append(f"Unified UI state copy missing: {message}")

    duplicates = find_duplicate_ids(html)
    if duplicates:
        errors.append(f"Duplicate id values found in index.html: {', '.join(duplicates)}")

    inline_handlers = re.findall(r"\son(?:click|change|submit|input|keydown|keyup|load)=", html, flags=re.IGNORECASE)
    if len(inline_handlers) > 0:
        errors.append(f"Inline event handlers are present in index.html: {len(inline_handlers)}")

    if re.search(r"width\s*:\s*(?:8|9|10)\d{2}px", html):
        errors.append("Potential fixed desktop-width style found in index.html")

    if 'data-mobile-advanced-sync' not in html or '<details class="mobile-collapsible"' not in html:
        errors.append("Advanced sync area is not guarded by a collapsed details panel")

    if "diaryFullPreviewModal" not in html or "diary-full-preview-panel" not in html:
        errors.append("Diary readonly preview modal/panel is missing")
    if "height: 94dvh" not in html and "height: 92dvh" not in html and "h-[92dvh]" not in html:
        errors.append("Diary readonly preview needs a mobile viewport-height layout")
    if "overflow-y: auto" not in html:
        errors.append("Diary readonly preview panel needs internal scrolling")
    if ".diary-detail-back" not in html or "min-height: 44px" not in html:
        errors.append("Diary readonly preview close button needs at least 44px touch height")
    if "diary-full-preview-readonly" not in html or "diary-detail-actions" not in html:
        errors.append("Diary readonly preview must hide editing actions in readonly mode")

    if "window.alert(message)" in combined or "alert(error" in combined:
        errors.append("New UI state work should not use alert as the primary error channel")

    for pattern in SENSITIVE_PATTERNS:
        if re.search(pattern, combined, flags=re.IGNORECASE):
            errors.append(f"Sensitive logging or storage pattern found: {pattern}")

    if re.search(r"width\s*:\s*(?:8|9|10)\d{2}px", ui_state_js):
        errors.append("Potential fixed desktop-width style found in ui-state.js")

    return errors


def main() -> int:
    errors = run_checks()
    if errors:
        print("Mobile UI static check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("Mobile UI static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
