"""Frontend regression guardrails for LeafVault v0.1 preview.

This is a static check for critical entry points and security-sensitive client
boundaries. It does not execute browser code and does not require network
access.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(rel_path: str) -> str:
    return (ROOT / rel_path).read_text(encoding="utf-8")


def run_checks() -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    required_files = [
        "templates/index.html",
        "static/js/api/request.js",
        "static/js/modules/session.js",
        "static/js/modules/auth.js",
        "static/js/modules/profile.js",
        "static/js/modules/diary.js",
        "static/js/modules/ledger.js",
        "static/js/modules/stats.js",
        "static/js/modules/backup.js",
        "static/js/modules/incremental-sync.js",
        "static/js/modules/ui-state.js",
        "static/js/modules/pwa-status.js",
    ]
    for rel_path in required_files:
        if not (ROOT / rel_path).exists():
            errors.append(f"Missing frontend file: {rel_path}")
    if errors:
        return errors, warnings

    html = read("templates/index.html")
    request_js = read("static/js/api/request.js")
    session_js = read("static/js/modules/session.js")
    auth_js = read("static/js/modules/auth.js")
    profile_js = read("static/js/modules/profile.js")
    diary_js = read("static/js/modules/diary.js")
    ledger_js = read("static/js/modules/ledger.js")
    backup_js = read("static/js/modules/backup.js")
    sync_js = read("static/js/modules/incremental-sync.js")
    ui_state_js = read("static/js/modules/ui-state.js")
    pwa_status_js = read("static/js/modules/pwa-status.js")
    stats_js = read("static/js/modules/stats.js")
    crypto_js = read("static/js/modules/crypto-engine.js")
    local_db_js = read("static/js/modules/local-db.js")
    combined = "\n".join([html, request_js, session_js, auth_js, profile_js, diary_js, ledger_js, backup_js, sync_js, ui_state_js, pwa_status_js, stats_js, crypto_js, local_db_js])

    markers = {
        "登录表单": 'id="loginForm"',
        "注册入口": 'id="registerForm"',
        "退出登录入口": 'data-profile-action="logout"',
        "日记保存按钮": 'id="mainDiarySubmitBtn"',
        "日记图片上传入口": 'data-diary-image-input="multi"',
        "账本添加入口": 'id="ledgerForm"',
        "生活日历区域": '生活日历',
        "导出加密备份入口": 'data-backup-action="export-encrypted"',
        "导入加密备份入口": 'data-backup-action="import-encrypted"',
        "上传云端加密备份入口": 'data-backup-action="upload-encrypted"',
        "云端备份列表入口": 'id="cloudBackupList"',
        "手动同步入口": 'data-incremental-action="start-manual-sync"',
        "同步历史入口": 'syncHistoryList',
        "冲突副本入口": 'syncConflictList',
        "同步诊断入口": 'data-incremental-action="run-sync-diagnostics"',
        "安全登录状态入口": '/api/session/status',
        "部署状态接口入口": '/api/deployment/status',
        "邀请码注册输入区": 'id="registrationInviteWrap"',
        "注册关闭提示": 'id="registrationClosedHint"',
        "数据与同步管理折叠区": 'data-mobile-section="sync-management"',
        "空状态/错误状态/加载状态工具": 'LeafVaultUIState',
    }
    for label, marker in markers.items():
        if marker not in combined:
            errors.append(f"Missing critical frontend entry: {label} ({marker})")

    hidden_input_match = re.search(r"<input[^>]+id=[\"']hiddenImageInput[\"'][^>]*>", html, flags=re.IGNORECASE)
    if not hidden_input_match:
        errors.append("Diary mobile image input hiddenImageInput is missing")
    else:
        hidden_input = hidden_input_match.group(0)
        for marker in ('type="file"', 'accept="image/*"', 'multiple="multiple"', 'data-diary-image-input="multi"'):
            if marker not in hidden_input:
                errors.append(f"Diary mobile image input missing marker: {marker}")
        if re.search(r"\scapture(?:=|\s|>)", hidden_input, flags=re.IGNORECASE):
            errors.append("Diary album multi-select input must not use capture")
    if "files[0]" in diary_js:
        errors.append("diary.js must not restrict diary image selection to files[0]")
    if "MAX_DIARY_IMAGE_COUNT = 9" not in diary_js:
        errors.append("diary.js must preserve MAX_DIARY_IMAGE_COUNT = 9")
    if "appendDiaryImageFiles" not in diary_js:
        errors.append("diary.js missing appendDiaryImageFiles batch image handler")
    any_file_input_match = re.search(r"<input[^>]+id=[\"']diaryAnyFileImageInput[\"'][^>]*>", html, flags=re.IGNORECASE)
    if not any_file_input_match:
        errors.append("Diary generic file picker input diaryAnyFileImageInput is missing")
    else:
        any_file_input = any_file_input_match.group(0)
        for marker in ('type="file"', 'multiple="multiple"', 'data-diary-image-input="any-file"'):
            if marker not in any_file_input:
                errors.append(f"Diary generic file picker input missing marker: {marker}")
        if re.search(r"\saccept=", any_file_input, flags=re.IGNORECASE):
            errors.append("Diary generic file picker input must not use accept")
        if re.search(r"\scapture(?:=|\s|>)", any_file_input, flags=re.IGNORECASE):
            errors.append("Diary generic file picker input must not use capture")
    if "openDiaryAnyFileImagePicker" not in diary_js or "window.showOpenFilePicker" not in diary_js:
        errors.append("diary.js missing generic file picker fallback")
    if "isAllowedDiaryImageFile" not in diary_js or "filter(isAllowedDiaryImageFile)" not in diary_js:
        errors.append("diary.js must filter generic selected files through isAllowedDiaryImageFile")
    if "startsWith('image/')" in diary_js or 'startsWith("image/")' in diary_js:
        errors.append("diary.js must not depend only on file.type.startsWith('image/') for selected images")
    for marker in (
        "function normalizeDiaryImagePaths",
        "function normalizeImageSrc",
        "repairDiaryImagePathParts",
        "window.LeafVaultDiaryImages",
        "data:image/jpeg;base64",
        "/9j/",
        "iVBOR",
        "UklGR",
    ):
        if marker not in diary_js:
            errors.append(f"diary.js missing robust image path normalizer marker: {marker}")

    readonly_preview_markers = {
        "readonly preview modal": "diaryFullPreviewModal",
        "readonly open function": "openDiaryReadonlyPreview",
        "readonly render function": "renderDiaryReadonlyPreview",
        "readonly close function": "closeDiaryReadonlyPreview",
        "readonly list binding": "setupDiaryCardReadonlyPreview",
        "readonly card marker": 'data-diary-card="true"',
        "readonly card date marker": "data-diary-date",
        "readonly mode marker": "diary-full-preview-readonly",
        "readonly markdown sanitizer": "DOMPurify.sanitize",
        "readonly markdown renderer": "marked.parse",
    }
    for label, marker in readonly_preview_markers.items():
        if marker not in combined:
            errors.append(f"Diary readonly preview missing {label}: {marker}")
    if 'role="button"' not in diary_js or 'tabindex="0"' not in diary_js:
        errors.append("Diary cards must be keyboard-focusable for readonly preview")
    if "button, a, input, textarea, select" not in diary_js or ".diary-img" not in diary_js:
        errors.append("Diary readonly preview must exclude inner buttons, links, inputs, and images")

    if "生成生活&财务双维复盘" not in html:
        errors.append("Stats report trigger text is missing")
    if "card('日记内容'" in stats_js or 'card("日记内容"' in stats_js:
        errors.append("Life and finance report must not render the diary-content insight card")

    if "restoreAuthSession" not in combined and "refreshSessionStatus" not in session_js:
        errors.append("Missing Cookie session recovery function: refreshSessionStatus/restoreAuthSession")
    if "refreshDeploymentStatus" not in auth_js or "applyDeploymentStatus" not in auth_js:
        errors.append("auth.js missing deployment status registration gate handlers")
    for marker in (
        "formatRegisterError",
        "getFastApiDetailItems",
        "mapRegisterFieldError",
        "getRegisterUsernameError",
        "用户名不能使用邮箱格式",
        "邀请码不正确或格式错误",
        "验证码不正确或已过期",
    ):
        if marker not in auth_js:
            errors.append(f"auth.js missing register validation/error marker: {marker}")
    if "formatRegisterError(res.status, json)" not in auth_js:
        errors.append("Register form must translate FastAPI 422 detail instead of showing a generic failure")
    if "data-register-username-input" not in html or "registerUsernameHint" not in html:
        errors.append("Register page must expose a username hint for email-format usernames")
    if re.search(r"(localStorage|sessionStorage)\.setItem\s*\([^)]*invite", auth_js, flags=re.IGNORECASE):
        errors.append("invite_code must not be saved to localStorage/sessionStorage")
    if re.search(r"console\.log\s*\([^)]*invite", auth_js, flags=re.IGNORECASE):
        errors.append("invite_code must not be printed to console")
    if "credentials = options.credentials || 'same-origin'" not in request_js and 'credentials: "same-origin"' not in request_js and "credentials: 'same-origin'" not in request_js:
        errors.append("apiFetch must use credentials same-origin")
    if "X-CSRF-Token" not in request_js or "getCsrfToken" not in session_js:
        errors.append("CSRF header support is missing from request/session modules")
    if "unlockWithPassword" not in crypto_js or "LOCAL_ENCRYPTION_LOCKED_MESSAGE" not in crypto_js:
        errors.append("CryptoEngine must support password-based local encryption unlock")
    for marker in (
        "derivePasswordKey",
        "encryptWithKey",
        "decryptWithKey",
        "canDecryptWithCurrentKey",
    ):
        if marker not in crypto_js:
            errors.append(f"CryptoEngine missing local data recovery helper: {marker}")
    if "ensureLocalEncryptionUnlocked" not in session_js or "showLocalEncryptionUnlockPanel" not in session_js:
        errors.append("Cookie session restore must gate encrypted local space behind an unlock panel")
    if "showCryptoLockedBanner" not in session_js or "requireCryptoUnlocked" not in session_js:
        errors.append("Cookie session restore must use a lightweight locked banner and shared crypto gate")
    for marker in (
        "showLocalDataRecoveryPanel",
        "markLocalDataRecoveryNeeded",
        "migrateLocalDataWithPasswords",
        "clearCurrentUserLocalCache",
    ):
        if marker not in session_js:
            errors.append(f"Local encrypted data recovery flow missing: {marker}")
    if session_js.count("window.confirm") < 2 or "请再次确认" not in session_js:
        errors.append("Clearing encrypted local cache must require a second confirmation")
    if "ensureCryptoOrPrompt" not in diary_js or "ensureCryptoOrPrompt" not in ledger_js:
        errors.append("Diary and ledger write flows must prompt for crypto unlock before encrypted writes")
    if "unlockWithPassword?.(loginPassword" not in auth_js:
        errors.append("Login success must initialize the local encryption key before entering the app")
    if "localUnlockFailed" not in auth_js or "showLocalDataRecoveryPanel" not in auth_js:
        errors.append("Login success with local crypto failure must enter app and show recovery panel")
    if "handleChangePassword" not in profile_js or "migrateLocalDataWithPasswords(oldPassword, newPassword" not in profile_js:
        errors.append("Changing account password must migrate encrypted local IndexedDB data before completing")
    if "apiFetch('/api/user/password'" not in profile_js:
        errors.append("Profile password form must still call the existing password API")
    if re.search(r"catch\s*\([^)]*\)\s*\{\s*toast\([^)]*本地加密空间解锁失败[^}]*return\s*;", auth_js, flags=re.DOTALL):
        errors.append("Login flow must not block account entry when only local encrypted cache unlock fails")
    if "requireLocalEncryptionUnlocked" not in local_db_js:
        errors.append("LocalStorage operations must check the local encryption key before encrypted reads/writes")
    if "reportLocalDecryptFailure" not in local_db_js or "markLocalDataRecoveryNeeded" not in local_db_js:
        errors.append("Encrypted IndexedDB read failures must surface the local data recovery panel")
    if "result, error" in local_db_js:
        errors.append("Encrypted IndexedDB failures must not print encrypted records to console")
    if "localDataLocked" not in ui_state_js:
        errors.append("UI error normalizer must distinguish local cache unlock failures from backup/sync password errors")
    if "CryptoEngine?.init?.({ force: true })" not in session_js:
        errors.append("Demo mode must initialize an isolated demo local encryption key")

    inline_handlers = re.findall(r"\son(?:click|change|submit|input|keydown|keyup|load)=", html, flags=re.IGNORECASE)
    if inline_handlers:
        errors.append(f"Inline event handlers present in index.html: {len(inline_handlers)}")
    if re.search(r"https://(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com)", combined):
        errors.append("Unexpected external CDN reference found in frontend files")
    if re.search(r"unsafe-eval", combined, flags=re.IGNORECASE):
        errors.append("unsafe-eval is not allowed")

    for pattern in (
        r"console\.log\s*\([^)]*(token|password|csrf|decryptedPayload|plainPayload|encrypted_blob|encrypted_change)",
        r"(localStorage|sessionStorage)\.setItem\s*\([^)]*(password|csrf|backupPassword|syncPassword|derivedKey|decryptedPayload|plainPayload)",
    ):
        if re.search(pattern, combined, flags=re.IGNORECASE):
            errors.append(f"Sensitive frontend pattern found: {pattern}")

    if re.search(r"localStorage\.setItem\s*\([^)]*token", session_js, flags=re.IGNORECASE):
        warnings.append("localStorage token compatibility code remains; production default should prefer Cookie session.")

    return errors, warnings


def main() -> int:
    errors, warnings = run_checks()
    for warning in warnings:
        print(f"WARNING: {warning}")
    if errors:
        print("Frontend regression check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("Frontend regression check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
