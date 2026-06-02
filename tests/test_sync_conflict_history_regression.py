from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_sync_conflict_history_frontend_functions_exist():
    sync_js = (ROOT / "static/js/modules/incremental-sync.js").read_text(encoding="utf-8")

    required_functions = [
        "createConflictCopy",
        "resolveSyncConflict",
        "recordSyncHistory",
        "listSyncHistory",
        "renderSyncHistoryPanel",
        "retryFailedLocalChange",
        "ignoreFailedLocalChange",
        "cleanupSyncedLocalChanges",
        "cleanupResolvedConflicts",
        "startManualSyncWizard",
        "runSyncDiagnostics",
    ]
    for function_name in required_functions:
        assert function_name in sync_js


def test_sync_history_and_diagnostics_do_not_log_sensitive_payloads():
    sync_js = (ROOT / "static/js/modules/incremental-sync.js").read_text(encoding="utf-8")

    forbidden_console_patterns = [
        "console.log(token",
        "console.log(password",
        "console.log(csrf",
        "console.log(decryptedPayload",
        "console.log(plainPayload",
        "console.log(encrypted_change",
        "console.log(encrypted_blob",
    ]
    for pattern in forbidden_console_patterns:
        assert pattern not in sync_js

    # The sync module may handle encrypted fields in memory for upload/preview,
    # but history metadata must explicitly filter sensitive fields.
    required_sanitized_keys = [
        "'payload'",
        "'encrypted_change'",
        "'decryptedPayload'",
        "'plainPayload'",
        "'local_snapshot'",
        "'remote_snapshot'",
        "'token'",
        "'password'",
        "'content'",
        "'note'",
    ]
    for key in required_sanitized_keys:
        assert key in sync_js
