from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_home_diary_cards_are_readonly_preview_targets():
    diary_js = (ROOT / "static/js/modules/diary.js").read_text(encoding="utf-8")

    assert 'data-diary-card="true"' in diary_js
    assert "data-diary-date" in diary_js
    assert 'role="button"' in diary_js
    assert 'tabindex="0"' in diary_js
    assert "setupDiaryCardReadonlyPreview" in diary_js
    assert "openDiaryReadonlyPreview(card.dataset.diaryDate)" in diary_js
    assert "event.key !== 'Enter' && event.key !== ' '" in diary_js


def test_diary_readonly_preview_reuses_safe_modal_and_sanitizes_markdown():
    index_html = (ROOT / "templates/index.html").read_text(encoding="utf-8")
    diary_js = (ROOT / "static/js/modules/diary.js").read_text(encoding="utf-8")

    assert 'id="diaryFullPreviewModal"' in index_html
    assert 'id="diaryFullPreviewContent"' in index_html
    assert 'id="diaryFullPreviewImages"' in index_html
    assert 'data-detail-action="close"' in index_html
    assert "diary-full-preview-readonly" in index_html
    assert "renderDiaryReadonlyPreview" in diary_js
    assert "closeDiaryReadonlyPreview" in diary_js
    assert "getDiaryForReadonlyPreview" in diary_js
    assert "marked.parse" in diary_js
    assert "DOMPurify.sanitize" in diary_js
    assert "innerHTML = renderDiaryContentHtml" in diary_js
    assert "LocalStorage.get('diaries', date)" in diary_js


def test_diary_readonly_preview_does_not_hijack_existing_card_actions():
    diary_js = (ROOT / "static/js/modules/diary.js").read_text(encoding="utf-8")

    assert "isDiaryCardInteractiveTarget" in diary_js
    assert "button, a, input, textarea, select" in diary_js
    assert "[data-diary-action]" in diary_js
    assert "[data-detail-action]" in diary_js
    assert ".diary-img" in diary_js
    assert "openLightbox" in diary_js
    assert "normalizeImageSrc" in diary_js or "normalizeDiaryImagePaths" in diary_js
    assert "img.dataset.src" in diary_js or "img.src" in diary_js
    assert "event.stopPropagation()" in diary_js
    assert "event.preventDefault()" in diary_js
    assert "togglePin(date)" in diary_js
    assert "deleteDiary(date)" in diary_js
    assert "modal.dataset.mode === 'readonly'" in diary_js
    assert "if (action === 'view')" in diary_js
    assert "openDiaryReadonlyPreview(diary)" in diary_js


def test_diary_readonly_preview_mobile_layout_contract():
    index_html = (ROOT / "templates/index.html").read_text(encoding="utf-8")

    assert "height: 94dvh" in index_html or "height: 92dvh" in index_html
    assert "overflow-y: auto" in index_html
    assert "min-height: 44px" in index_html
    assert "env(safe-area-inset-top)" in index_html
    assert "env(safe-area-inset-bottom)" in index_html
    assert "prefers-reduced-motion: reduce" in index_html


def test_no_inline_handlers_were_added_for_readonly_preview():
    index_html = (ROOT / "templates/index.html").read_text(encoding="utf-8")

    assert "onclick=" not in index_html.lower()
