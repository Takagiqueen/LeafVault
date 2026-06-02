"""LeafVault frontend security and module integrity checks."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


REQUIRED_FILES = [
    "static/js/modules/backup.js",
    "static/js/modules/ui-state.js",
    "static/js/modules/local-db.js",
    "static/js/modules/incremental-sync.js",
    "static/service-worker.js",
    "templates/index.html",
]

BACKUP_FUNCTIONS = [
    "exportEncryptedBackup",
    "importEncryptedBackup",
    "uploadEncryptedBackupSnapshot",
    "fetchCloudBackupSnapshots",
    "downloadCloudBackupSnapshot",
    "restoreCloudBackupSnapshot",
    "deleteCloudBackupSnapshot",
    "updateBackupStatusPanel",
    "shouldShowBackupReminder",
]

SYNC_FUNCTIONS = [
    "createLocalChange",
    "listPendingLocalChanges",
    "uploadPendingLocalChanges",
    "fetchRemoteChangeMetadata",
    "previewRemoteChange",
    "analyzeRemoteChangeAgainstLocal",
    "applyRemoteChange",
    "createConflictCopy",
    "resolveSyncConflict",
    "recordSyncHistory",
    "startManualSyncWizard",
    "autoCheckRemoteChangesIfNeeded",
    "runSyncDiagnostics",
]

SENSITIVE_CONSOLE_TERMS = [
    "decryptedPayload",
    "plainPayload",
    "password",
    "syncPassword",
    "backupPassword",
    "derivedKey",
    "token",
    "encrypted_change",
    "encrypted_blob",
]

SENSITIVE_STORAGE_TERMS = [
    "password",
    "syncPassword",
    "backupPassword",
    "derivedKey",
    "syncKey",
    "decryptedPayload",
    "plainPayload",
]

REPORT_FORBIDDEN_PATTERNS = [
    r"\bcontent\s*:",
    r"\bnote\s*:",
    r"\bencrypted_change\s*:",
    r"\bencrypted_blob\s*:",
    r"\bpayload\s*:",
    r"\bdecryptedPayload\s*:",
    r"\btoken\s*:",
    r"\bpassword\s*:",
    r"\bkey\s*:",
]


def read_rel(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def function_exists(source: str, name: str) -> bool:
    patterns = [
        rf"\bfunction\s+{re.escape(name)}\s*\(",
        rf"\basync\s+function\s+{re.escape(name)}\s*\(",
        rf"\bconst\s+{re.escape(name)}\s*=",
        rf"\blet\s+{re.escape(name)}\s*=",
        rf"\bwindow\.{re.escape(name)}\s*=",
        rf"\b{re.escape(name)}\s*:",
    ]
    return any(re.search(pattern, source) for pattern in patterns)


def collect_sensitive_source_errors(path: Path, source: str) -> list[str]:
    errors: list[str] = []
    for line_no, line in enumerate(source.splitlines(), 1):
        if re.search(r"\bconsole\.log\s*\(", line):
            if any(term.lower() in line.lower() for term in SENSITIVE_CONSOLE_TERMS):
                errors.append(f"{path}:{line_no} console.log may expose sensitive data")
        if re.search(r"\b(localStorage|sessionStorage)\.setItem\s*\(", line):
            if any(term.lower() in line.lower() for term in SENSITIVE_STORAGE_TERMS):
                errors.append(f"{path}:{line_no} storage write may persist a password/key/payload")
        if re.search(r"\bindexedDB\b", line, re.IGNORECASE):
            if any(term.lower() in line.lower() for term in ("sync password", "backup password", "derived key")):
                errors.append(f"{path}:{line_no} IndexedDB reference mentions sensitive credential material")
    return errors


def check_css_pipeline(index_html: str) -> list[str]:
    errors: list[str] = []
    head_match = re.search(r"<head[\s\S]*?</head>", index_html, flags=re.IGNORECASE)
    head_html = head_match.group(0) if head_match else ""
    if "/static/output.css" not in head_html:
        errors.append("templates/index.html must load /static/output.css inside <head>")

    output_css_path = ROOT / "static/output.css"
    if not output_css_path.exists():
        errors.append("static/output.css is missing")
        return errors
    output_css = output_css_path.read_text(encoding="utf-8", errors="ignore")
    if len(output_css) < 10_000:
        errors.append("static/output.css looks too small; Tailwind build may be stale or incomplete")
    for utility in (".fixed", ".grid", ".flex", ".hidden", ".w-5", ".h-5", ".min-h-screen", ".backdrop-blur"):
        if utility not in output_css:
            errors.append(f"static/output.css missing core Tailwind utility: {utility}")

    tailwind_config = read_rel("tailwind.config.js")
    for needle in ("./templates/**/*.html", "./static/js/**/*.js"):
        if needle not in tailwind_config:
            errors.append(f"tailwind.config.js content must include `{needle}`")
    return errors


def extract_function_body(source: str, function_name: str) -> str:
    match = re.search(rf"(?:async\s+)?function\s+{re.escape(function_name)}\s*\([^)]*\)\s*{{", source)
    if not match:
        return ""
    index = match.end()
    depth = 1
    while index < len(source) and depth:
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        index += 1
    return source[match.start() : index]


def run_checks() -> list[str]:
    errors: list[str] = []
    for rel in REQUIRED_FILES:
        if not (ROOT / rel).exists():
            errors.append(f"Missing required file: {rel}")

    pwa_status = ROOT / "static/js/modules/pwa-status.js"
    if pwa_status.exists():
        REQUIRED_FILES.append("static/js/modules/pwa-status.js")

    if errors:
        return errors

    index_html = read_rel("templates/index.html")
    errors.extend(check_css_pipeline(index_html))
    for module_name in ("ui-state.js", "local-db.js", "backup.js", "incremental-sync.js"):
        if module_name not in index_html:
            errors.append(f"templates/index.html does not include {module_name}")
    if pwa_status.exists() and "pwa-status.js" not in index_html:
        errors.append("templates/index.html does not include pwa-status.js")
    if "navigator.serviceWorker" not in index_html and "pwa-status.js" not in index_html:
        errors.append("Service Worker registration module or logic is missing from index.html")

    backup_js = read_rel("static/js/modules/backup.js")
    for name in BACKUP_FUNCTIONS:
        if not function_exists(backup_js, name):
            errors.append(f"backup.js missing required function/export: {name}")

    sync_js = read_rel("static/js/modules/incremental-sync.js")
    for name in SYNC_FUNCTIONS:
        if not function_exists(sync_js, name):
            errors.append(f"incremental-sync.js missing required function/export: {name}")

    for rel in ("static/js/modules/backup.js", "static/js/modules/incremental-sync.js", "static/js/modules/local-db.js"):
        source = read_rel(rel)
        errors.extend(collect_sensitive_source_errors(Path(rel), source))

    sw = read_rel("static/service-worker.js")
    for needle in ("CACHE_VERSION", "activate", "caches.delete", "SKIP_WAITING", "/api/", "Authorization", "/static/images/"):
        if needle not in sw:
            errors.append(f"service-worker.js missing safety marker: {needle}")
    if re.search(r"encrypted_change|encrypted_blob", sw, flags=re.IGNORECASE):
        errors.append("service-worker.js should not mention/cache encrypted backup or sync payload fields")
    install_body = extract_function_body(sw, "install")
    if "skipWaiting" in install_body:
        errors.append("service-worker.js install handler should not force skipWaiting")

    report_body = extract_function_body(sync_js, "buildSyncDiagnosticReport")
    if not report_body:
        errors.append("incremental-sync.js missing buildSyncDiagnosticReport")
    else:
        for pattern in REPORT_FORBIDDEN_PATTERNS:
            if re.search(pattern, report_body):
                errors.append(f"buildSyncDiagnosticReport contains forbidden report field pattern: {pattern}")

    return errors


def main() -> int:
    errors = run_checks()
    if errors:
        print("Frontend static check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("Frontend static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
