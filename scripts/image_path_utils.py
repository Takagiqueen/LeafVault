"""Helpers for LeafVault image path diagnostics and safe migration."""

from __future__ import annotations

import json
from pathlib import Path


def _collect_parts(value: str | list | None) -> list[str]:
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            parts.extend(_collect_parts(item))
        return parts
    text = str(value or "").strip()
    if not text:
        return []
    if text.lower().startswith("data:image/") and ";base64," in text.lower():
        return [text]
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return _collect_parts(parsed)
        except json.JSONDecodeError:
            pass
    return [part.strip() for part in text.split(",") if part.strip()]


def _repair_parts(parts: list[str]) -> list[str]:
    repaired: list[str] = []
    prefixes = {
        "data:image/jpeg;base64",
        "data:image/jpg;base64",
        "data:image/png;base64",
        "data:image/webp;base64",
        "data:image/gif;base64",
    }
    index = 0
    while index < len(parts):
        current = parts[index].strip()
        next_part = parts[index + 1].strip() if index + 1 < len(parts) else ""
        if current.lower() in prefixes and next_part:
            repaired.append(f"{current},{next_part}")
            index += 2
        else:
            repaired.append(current)
            index += 1
    return repaired


def parse_image_paths(value: str | None) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for part in _repair_parts(_collect_parts(value)):
        if part and part not in seen:
            seen.add(part)
            result.append(part)
    return result


def resolve_image_file(db_path_value: str, upload_dir: Path, static_images_dir: Path) -> tuple[Path | None, Path | None]:
    """Return the expected local file path and an uploads fallback for a DB image path."""
    value = str(db_path_value or "").strip()
    if not value:
        return None, None
    filename = Path(value).name
    if not filename or "/" in filename or "\\" in filename or ".." in value:
        return None, None
    if value.startswith("/uploads/"):
        return upload_dir / filename, None
    if value.startswith("/static/images/"):
        return static_images_dir / filename, upload_dir / filename
    return None, None
