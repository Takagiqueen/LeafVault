from core.validators import safe_filename_prefix


JPEG_BYTES = b"\xff\xd8\xff\xe0" + (b"0" * 64)


def test_diary_crud_and_user_isolation(api):
    token_a = api.register_and_login("diary_a", "diary-a@example.test")
    token_b = api.register_and_login("diary_b", "diary-b@example.test")

    assert api.client.post(
        "/api/diaries/",
        headers=api.auth(token_a),
        data={"date": "2026-05-10", "mood_label": "happy", "content": "A first"},
    ).json()["status"] == "success"
    assert api.client.post(
        "/api/diaries/",
        headers=api.auth(token_b),
        data={"date": "2026-05-10", "mood_label": "happy", "content": "B first"},
    ).json()["status"] == "success"

    update = api.client.post(
        "/api/diaries/",
        headers=api.auth(token_a),
        data={"date": "2026-05-10", "mood_label": "happy", "content": "A updated"},
    )
    assert update.json()["status"] == "success"
    assert api.client.get("/api/diaries/list", headers=api.auth(token_a)).json()["data"][0]["content"] == "A updated"
    assert api.client.get("/api/diaries/list", headers=api.auth(token_b)).json()["data"][0]["content"] == "B first"

    delete = api.client.delete("/api/diaries/2026-05-10", headers=api.auth(token_a))
    assert delete.json()["status"] == "success"
    assert api.client.get("/api/diaries/list", headers=api.auth(token_a)).json()["data"] == []
    assert len(api.client.get("/api/diaries/list", headers=api.auth(token_b)).json()["data"]) == 1


def test_diary_pin_limit_allows_five_and_rejects_sixth(api):
    token = api.register_and_login("pin_limit", "pin-limit@example.test")

    for day in range(1, 7):
        response = api.client.post(
            "/api/diaries/",
            headers=api.auth(token),
            data={"date": f"2026-05-{day:02d}", "mood_label": "一般", "content": f"diary {day}"},
        )
        assert response.json()["status"] == "success"

    for day in range(1, 6):
        response = api.client.post(
            "/api/diaries/toggle_pin",
            headers=api.auth(token),
            data={"date": f"2026-05-{day:02d}"},
        )
        body = response.json()
        assert body["status"] == "success"
        assert body["is_pinned"] == 1

    blocked = api.client.post(
        "/api/diaries/toggle_pin",
        headers=api.auth(token),
        data={"date": "2026-05-06"},
    ).json()
    assert blocked == {
        "status": "error",
        "message": "最多只能置顶 5 篇日记，请先取消一篇置顶",
    }


def test_ledger_crud_stats_and_calendar_are_user_scoped(api):
    token_a = api.register_and_login("ledger_a", "ledger-a@example.test")
    token_b = api.register_and_login("ledger_b", "ledger-b@example.test")

    api.client.post(
        "/api/diaries/",
        headers=api.auth(token_a),
        data={"date": "2026-05-11", "mood_label": "happy", "content": "A day"},
    )
    api.client.post(
        "/api/diaries/",
        headers=api.auth(token_b),
        data={"date": "2026-05-11", "mood_label": "sad", "content": "B day"},
    )
    a_ledger = api.client.post(
        "/api/ledgers/",
        headers=api.auth(token_a),
        data={"type": "expense", "amount": "18.5", "category": "meal", "note": "lunch", "date": "2026-05-11", "uuid": "ledger-a-1"},
    )
    assert a_ledger.json()["status"] == "success"
    api.client.post(
        "/api/ledgers/",
        headers=api.auth(token_b),
        data={"type": "expense", "amount": "999", "category": "hidden", "note": "private", "date": "2026-05-11", "uuid": "ledger-b-1"},
    )

    summary = api.client.get("/api/stats/monthly_summary?month=2026-05", headers=api.auth(token_a)).json()["data"]
    assert summary["total_expense"] == 18.5
    calendar = api.client.get("/api/calendar?month=2026-05", headers=api.auth(token_a)).json()["data"]
    assert calendar["expenses"]["2026-05-11"] == 18.5
    assert "2026-05-11" in calendar["moods"]

    ledger_id = api.client.get("/api/ledgers/list", headers=api.auth(token_a)).json()["data"][0]["id"]
    assert api.client.delete(f"/api/ledgers/{ledger_id}", headers=api.auth(token_a)).json()["status"] == "success"
    assert api.client.get("/api/ledgers/list", headers=api.auth(token_a)).json()["data"] == []
    assert len(api.client.get("/api/ledgers/list", headers=api.auth(token_b)).json()["data"]) == 1


def test_diary_append_image_does_not_drop_existing_paths_when_retained_is_missing(api):
    token = api.register_and_login("image_owner", "image-owner@example.test")
    user_id = api.user_id(token)
    owner = safe_filename_prefix(user_id)
    old1 = f"/static/images/20260521010101_{owner}_old1.jpg"
    old2 = f"/static/images/20260521010102_{owner}_old2.jpg"

    conn = api.connect()
    conn.execute(
        """
        INSERT INTO diaries (user_id, username, date, mood_label, content, image_paths, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, user_id, "2026-05-12", "happy", "has old images", f"{old1},{old2}", "2026-05-12T00:00:00.000Z"),
    )
    conn.commit()
    conn.close()

    response = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={
            "date": "2026-05-12",
            "mood_label": "happy",
            "content": "append image",
            "retained_images": "",
            "removed_images": "",
        },
        files={"images": ("new3.jpg", JPEG_BYTES, "image/jpeg")},
    )
    body = response.json()
    assert body["status"] == "success"
    assert old1 in body["image_paths"]
    assert old2 in body["image_paths"]
    assert body["image_paths"].count("/static/images/") == 2
    assert body["image_paths"].count("/uploads/") == 1


def test_diary_removed_images_explicitly_deletes_only_selected_old_path(api):
    token = api.register_and_login("image_remove", "image-remove@example.test")
    user_id = api.user_id(token)
    owner = safe_filename_prefix(user_id)
    old1 = f"/static/images/20260521010101_{owner}_old1.jpg"
    old2 = f"/static/images/20260521010102_{owner}_old2.jpg"
    old3 = f"/static/images/20260521010103_{owner}_old3.jpg"

    conn = api.connect()
    conn.execute(
        """
        INSERT INTO diaries (user_id, username, date, mood_label, content, image_paths, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, user_id, "2026-05-13", "happy", "has old images", f"{old1},{old2},{old3}", "2026-05-13T00:00:00.000Z"),
    )
    conn.commit()
    conn.close()

    body = api.client.post(
        "/api/diaries/",
        headers=api.auth(token),
        data={
            "date": "2026-05-13",
            "mood_label": "happy",
            "content": "remove one",
            "retained_images": f"{old1},{old3}",
            "removed_images": old2,
        },
    ).json()
    assert body["status"] == "success"
    assert old1 in body["image_paths"]
    assert old3 in body["image_paths"]
    assert old2 not in body["image_paths"]
