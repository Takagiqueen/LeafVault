"""Static PWA and Service Worker regression checks for LeafVault.

The script is intentionally offline-only: it reads local files and never tries
to install Docker, start a browser, or make network requests.
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

    sw_path = ROOT / "static/service-worker.js"
    manifest_path = ROOT / "static/manifest.json"
    pwa_status_path = ROOT / "static/js/modules/pwa-status.js"
    index_path = ROOT / "templates/index.html"

    for path in (sw_path, manifest_path, pwa_status_path, index_path):
        if not path.exists():
            errors.append(f"Missing required PWA file: {path.relative_to(ROOT)}")
    if errors:
        return errors, warnings

    sw = read("static/service-worker.js")
    manifest = read("static/manifest.json")
    pwa_status = read("static/js/modules/pwa-status.js")
    index_html = read("templates/index.html")

    for needle in ("CACHE_VERSION", "APP_SHELL_ASSETS", "install", "activate", "fetch"):
        if needle not in sw:
            errors.append(f"service-worker.js missing marker: {needle}")

    if "url.pathname.startsWith('/api/')" not in sw:
        errors.append("service-worker.js must bypass all /api/ requests")
    api_bypass_covered = "url.pathname.startsWith('/api/')" in sw
    for api_path in ("/api/session/status", "/api/deployment/status", "/api/register", "/api/login", "/api/sync/"):
        if not api_bypass_covered:
            errors.append(f"service-worker.js must bypass {api_path}")

    if "request.headers.has('Authorization')" not in sw:
        errors.append("service-worker.js must bypass requests with Authorization headers")
    if "/static/images/" not in sw or "/uploads/" not in sw:
        errors.append("service-worker.js must bypass user-uploaded image paths")
    if re.search(r"encrypted_(?:blob|change)|decryptedPayload|plainPayload", sw, flags=re.IGNORECASE):
        errors.append("service-worker.js must not cache or mention encrypted/decrypted payload fields")
    if "skipWaiting" not in sw or "SKIP_WAITING" not in sw:
        errors.append("service-worker.js must support explicit SKIP_WAITING update flow")
    install_body = re.search(r"self\.addEventListener\('install'.*?\n\}\);", sw, flags=re.DOTALL)
    if install_body and "skipWaiting" in install_body.group(0):
        errors.append("service-worker.js install handler must not force skipWaiting")

    if '"start_url"' not in manifest or '"display"' not in manifest or '"icons"' not in manifest:
        errors.append("manifest.json missing start_url/display/icons")
    if "registerPWAUpdateHandler" not in pwa_status or "ensureOnlineForCloudFeature" not in pwa_status:
        errors.append("pwa-status.js missing update/offline handling hooks")
    if "window.addEventListener('offline'" not in pwa_status or "window.addEventListener('online'" not in pwa_status:
        errors.append("pwa-status.js missing online/offline listeners")
    if (
        "navigator.serviceWorker.register('/service-worker.js" not in pwa_status
        and "navigator.serviceWorker.register('/static/service-worker.js" not in pwa_status
    ):
        errors.append("pwa-status.js must register the service worker")
    if "pwaStatusBanner" not in index_html:
        errors.append("index.html missing PWA status banner container")

    combined = "\n".join([sw, pwa_status, index_html])
    for pattern in (
        r"console\.log\s*\([^)]*(token|password|csrf)",
        r"console\.log\s*\([^)]*(encrypted_change|encrypted_blob|decryptedPayload|plainPayload)",
        r"unsafe-eval",
    ):
        if re.search(pattern, combined, flags=re.IGNORECASE):
            errors.append(f"PWA/static source contains unsafe pattern: {pattern}")

    if "SYNC_STARTED" in sw:
        warnings.append("Background sync message hook is present; ensure foreground code still owns encrypted sync.")

    return errors, warnings


def main() -> int:
    errors, warnings = run_checks()
    for warning in warnings:
        print(f"WARNING: {warning}")
    if errors:
        print("PWA static check failed:")
        for error in errors:
            print(f" - {error}")
        return 1
    print("PWA static check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
