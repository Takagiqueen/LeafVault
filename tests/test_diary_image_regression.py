from pathlib import Path

from core.config import MAX_IMAGE_SIZE_BYTES
from core.validators import safe_filename_prefix
import services.diary_service as diary_service


JPEG_BYTES = b"\xff\xd8\xff\xe0" + (b"0" * 128)
ROOT = Path(__file__).resolve().parents[1]


def _image_paths(body: dict) -> list[str]:
    return [path for path in str(body.get("image_paths", "")).split(",") if path]


def test_diary_mobile_image_multi_select_contract_is_preserved():
    index_html = (ROOT / "templates/index.html").read_text(encoding="utf-8")
    diary_js = (ROOT / "static/js/modules/diary.js").read_text(encoding="utf-8")

    import re

    hidden_input = re.search(r'<input[^>]+id="hiddenImageInput"[^>]*>', index_html).group(0)
    any_file_input = re.search(r'<input[^>]+id="diaryAnyFileImageInput"[^>]*>', index_html).group(0)

    assert 'type="file"' in hidden_input
    assert 'accept="image/*"' in hidden_input
    assert 'multiple="multiple"' in hidden_input
    assert 'data-diary-image-input="multi"' in hidden_input
    assert "capture" not in hidden_input
    assert "imagePreviewGrid" in index_html
    assert "addImageBtnWrap" in index_html
    assert "imgCountHint" in index_html
    assert "mainDiarySubmitBtn" in index_html
    assert "openDiaryAnyFileImageBtn" in index_html
    assert 'multiple="multiple"' in any_file_input
    assert 'data-diary-image-input="any-file"' in any_file_input
    assert "accept=" not in any_file_input
    assert "image/*" not in any_file_input
    assert "capture" not in any_file_input

    assert "MAX_DIARY_IMAGE_COUNT = 9" in diary_js
    assert "setupDiaryImageInputMultiSelect" in diary_js
    assert "setupDiaryAnyFileImageInput" in diary_js
    assert "openDiaryAnyFileImagePicker" in diary_js
    assert "isAllowedDiaryImageFile" in diary_js
    assert "window.showOpenFilePicker" in diary_js
    assert "appendDiaryImageFiles" in diary_js
    assert "function normalizeDiaryImagePaths" in diary_js
    assert "function normalizeImageSrc" in diary_js
    assert "function serializeDiaryImagePaths" in diary_js
    assert "repairDiaryImagePathParts" in diary_js
    assert "data:image/jpeg;base64" in diary_js
    assert "/9j/" in diary_js
    assert "iVBOR" in diary_js
    assert "UklGR" in diary_js
    assert "Array.from(fileList || [])" in diary_js
    assert "filter(isAllowedDiaryImageFile)" in diary_js
    assert "startsWith('image/')" not in diary_js
    assert "files[0]" not in diary_js
    assert "Promise.allSettled(acceptedFiles.map" not in diary_js
    assert "正在处理 ${i + 1}/${acceptedFiles.length}" in diary_js


def test_diary_image_path_normalizer_static_contract():
    diary_js = (ROOT / "static/js/modules/diary.js").read_text(encoding="utf-8")
    backup_js = (ROOT / "static/js/modules/backup.js").read_text(encoding="utf-8")
    service_worker = (ROOT / "static/service-worker.js").read_text(encoding="utf-8")

    assert "DIARY_FULL_DATA_IMAGE_RE" in diary_js
    assert "collectDiaryImagePathParts" in diary_js
    assert "repairDiaryImagePathParts" in diary_js
    assert "normalizeImageSrc(src)" in diary_js
    assert "return `data:${rawMime};base64,${text}`" in diary_js
    assert "JSON.stringify(paths)" in diary_js
    assert "window.LeafVaultDiaryImages" in diary_js

    assert "repairDiaryImagePathParts" in backup_js
    assert "serializeDiaryImagePathList" in backup_js
    assert "JSON.stringify(paths)" in backup_js

    assert "request.url.startsWith('data:')" in service_worker
    assert "request.url.startsWith('blob:')" in service_worker
    assert "looksLikeRawImageBase64Path" in service_worker


def test_diary_update_appends_images_without_losing_existing_paths(api):
    token = api.register_and_login("diary_img_full", "diary-img-full@example.test")

    created = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-04", "mood_label": "happy", "content": "first with two images"},
        files=[
            ("images", ("old-a.jpg", JPEG_BYTES, "image/jpeg")),
            ("images", ("old-b.jpg", JPEG_BYTES, "image/jpeg")),
        ],
    ).json()
    assert created["status"] == "success"
    first_paths = _image_paths(created)
    assert len(first_paths) == 2

    appended = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-04", "mood_label": "happy", "content": "append third", "retained_images": "", "removed_images": ""},
        files=[("images", ("new-c.jpg", JPEG_BYTES, "image/jpeg"))],
    ).json()
    appended_paths = _image_paths(appended)
    assert appended["status"] == "success"
    assert all(path in appended_paths for path in first_paths)
    assert len(appended_paths) == 3

    text_only = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-04", "mood_label": "happy", "content": "text only update", "retained_images": "", "removed_images": ""},
    ).json()
    assert _image_paths(text_only) == appended_paths

    removed = appended_paths[1]
    retained = [path for path in appended_paths if path != removed]
    after_remove = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={
            "date": "2026-06-04",
            "mood_label": "happy",
            "content": "remove one image",
            "retained_images": ",".join(retained),
            "removed_images": removed,
        },
    ).json()
    assert removed not in _image_paths(after_remove)
    assert _image_paths(after_remove) == retained


def test_diary_upload_rejects_when_entry_image_count_exceeds_limit(api, monkeypatch):
    monkeypatch.setattr(diary_service, "MAX_DIARY_IMAGES_PER_ENTRY", 2)
    token = api.register_and_login("diary_img_limit", "diary-img-limit@example.test")

    created = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-09", "mood_label": "happy", "content": "two images are ok"},
        files=[
            ("images", ("one.jpg", JPEG_BYTES, "image/jpeg")),
            ("images", ("two.jpg", JPEG_BYTES, "image/jpeg")),
        ],
    )
    assert created.status_code == 200

    too_many = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-09", "mood_label": "happy", "content": "third image rejected", "retained_images": "", "removed_images": ""},
        files=[("images", ("three.jpg", JPEG_BYTES, "image/jpeg"))],
    )
    assert too_many.status_code == 422
    body = too_many.json()
    assert "单篇日记最多只能放 2 张图" in body["detail"]
    assert "/tmp" not in str(body)


def test_diary_image_upload_rejects_unsafe_types_and_keeps_safe_urls(api):
    token = api.register_and_login("diary_img_safe", "diary-img-safe@example.test")

    normal_upload = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-05", "mood_label": "happy", "content": "safe generated filename"},
        files=[("images", ("safe.jpg", JPEG_BYTES, "image/jpeg"))],
    ).json()
    path = _image_paths(normal_upload)[0]
    assert path.startswith("/uploads/")
    assert ".." not in path
    assert "\\" not in path


def test_uploaded_diary_image_is_served_from_uploads_and_legacy_static_fallback(api, temp_upload_dir):
    token = api.register_and_login("diary_img_static", "diary-img-static@example.test")
    upload = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-10", "mood_label": "happy", "content": "serve image"},
        files=[("images", ("serve.jpg", JPEG_BYTES, "image/jpeg"))],
    ).json()
    path = _image_paths(upload)[0]
    assert path.startswith("/uploads/")
    assert api.client.get(path).status_code == 200
    assert api.client.get(path.replace("/uploads/", "/static/images/")).status_code == 200

    filename = Path(path).name
    assert (temp_upload_dir / filename).exists()

    path_traversal_name = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-06", "mood_label": "happy", "content": "reject unsafe filename"},
        files=[("images", ("../evil.jpg", JPEG_BYTES, "image/jpeg"))],
    )
    assert path_traversal_name.status_code in (400, 413, 415, 422)

    svg = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-06", "mood_label": "happy", "content": "svg rejected"},
        files=[("images", ("bad.svg", b"<svg></svg>", "image/svg+xml"))],
    )
    assert svg.status_code in (400, 415, 422)

    too_large = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-06-07", "mood_label": "happy", "content": "too large rejected"},
        files=[("images", ("large.jpg", b"\xff\xd8\xff\xe0" + (b"x" * (MAX_IMAGE_SIZE_BYTES + 1)), "image/jpeg"))],
    )
    assert too_large.status_code == 413


def test_restored_backup_image_path_is_accepted_for_current_user(api, temp_upload_dir):
    token = api.register_and_login("diary_img_restore", "diary-img-restore@example.test")
    user_id = api.user_id(token)
    owner = safe_filename_prefix(user_id)
    restored_path = f"/uploads/backup_{owner}_abcdef1234567890abcd.jpg"

    # 备份恢复接口会生成 backup_<user>_<sha>.ext 形式的稳定图片路径。
    # 日记同步时 retained_images 必须接受这个路径，否则恢复后图片会被服务器过滤为空。
    saved_file = temp_upload_dir / Path(restored_path).name
    saved_file.write_bytes(JPEG_BYTES)

    res = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={
            "date": "2026-06-11",
            "mood_label": "一般",
            "content": "restored backup image",
            "retained_images": restored_path,
            "removed_images": "",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "success"
    assert _image_paths(body) == [restored_path]
    detail = api.client.get("/api/diaries/detail?date=2026-06-11", headers=api.auth(token)).json()["data"]
    assert detail["image_paths"] == restored_path
    assert api.client.get(restored_path).status_code == 200


def test_other_user_cannot_read_diary_image_records(api):
    token_a = api.register_and_login("diary_img_owner", "diary-img-owner@example.test")
    token_b = api.register_and_login("diary_img_other", "diary-img-other@example.test")
    api.client.post(
        "/api/diaries/",
        headers=api.auth(token_a),
        data={"date": "2026-06-08", "mood_label": "happy", "content": "private image record"},
        files=[("images", ("private.jpg", JPEG_BYTES, "image/jpeg"))],
    )
    other_detail = api.client.get("/api/diaries/detail?date=2026-06-08", headers=api.auth(token_b)).json()
    assert other_detail["status"] == "not_found"
