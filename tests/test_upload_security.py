from core.config import MAX_IMAGE_SIZE_BYTES


JPEG_BYTES = b"\xff\xd8\xff\xe0" + (b"0" * 64)
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + (b"0" * 64)


def test_avatar_rejects_oversized_file(api):
    token = api.register_and_login("upload_big", "upload-big@example.test")
    response = api.client.post(
        "/api/user/avatar",
        headers=api.auth(token),
        files={"avatar": ("big.jpg", b"\xff\xd8\xff" + (b"0" * (MAX_IMAGE_SIZE_BYTES + 1)), "image/jpeg")},
    )
    assert response.json()["status"] == "error"


def test_avatar_rejects_illegal_extension_and_svg(api):
    token = api.register_and_login("upload_ext", "upload-ext@example.test")
    exe = api.client.post(
        "/api/user/avatar",
        headers=api.auth(token),
        files={"avatar": ("bad.exe", JPEG_BYTES, "image/jpeg")},
    )
    assert exe.status_code == 422
    svg = api.client.post(
        "/api/user/avatar",
        headers=api.auth(token),
        files={"avatar": ("bad.svg", b"<svg></svg>", "image/svg+xml")},
    )
    assert svg.status_code == 422


def test_avatar_rejects_spoofed_mime_or_magic_bytes(api):
    token = api.register_and_login("upload_mime", "upload-mime@example.test")
    bad_mime = api.client.post(
        "/api/user/avatar",
        headers=api.auth(token),
        files={"avatar": ("bad.jpg", JPEG_BYTES, "image/svg+xml")},
    )
    assert bad_mime.status_code == 422
    bad_magic = api.client.post(
        "/api/user/avatar",
        headers=api.auth(token),
        files={"avatar": ("bad.jpg", b"not actually a jpeg", "image/jpeg")},
    )
    assert bad_magic.status_code == 422


def test_avatar_success_uses_generated_safe_relative_path(api):
    token = api.register_and_login("upload_ok", "upload-ok@example.test")
    body = api.client.post(
        "/api/user/avatar",
        headers=api.auth(token),
        files={"avatar": ("original-name.jpg", JPEG_BYTES, "image/jpeg")},
    ).json()
    assert body["status"] == "success"
    assert body["avatar_url"].startswith("/uploads/avatar_")
    assert ".." not in body["avatar_url"]
    assert "original-name" not in body["avatar_url"]


def test_diary_image_rejects_svg_and_accepts_valid_png(api):
    token = api.register_and_login("upload_diary", "upload-diary@example.test")
    bad = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-05-23", "mood_label": "happy", "content": "svg should fail"},
        files={"images": ("bad.svg", b"<svg></svg>", "image/svg+xml")},
    )
    assert bad.status_code == 422

    ok = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={"date": "2026-05-23", "mood_label": "happy", "content": "png ok"},
        files={"images": ("ok.png", PNG_BYTES, "image/png")},
    ).json()
    assert ok["status"] == "success"
    assert ok["image_paths"].startswith("/uploads/")
    assert ".." not in ok["image_paths"]
