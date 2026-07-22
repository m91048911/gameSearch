"""
game_search.py의 순수 함수 + 목(mock) 기반 유닛 테스트.

원칙: Tavily/Gemini/Supabase 등 외부 API는 절대 실제로 호출하지 않는다.
전부 mock으로 대체해서, 네트워크 없이 몇 초 안에 끝나야 한다.

실행: pytest tests/test_game_search.py -v
"""

import time
from unittest.mock import MagicMock

import pytest

import game_search as gs


# ---- _valid_iso_date -----------------------------------------------------


@pytest.mark.parametrize(
    "value, expected",
    [
        ("2026-07-22", True),
        ("2026-13-01", False),  # 존재하지 않는 달
        ("2026/07/22", False),  # 형식이 다름
        ("", False),
        (None, False),
        (12345, False),  # 문자열이 아님
    ],
)
def test_valid_iso_date(value, expected):
    assert gs._valid_iso_date(value) is expected


# ---- _parse_json ----------------------------------------------------------


def test_parse_json_plain():
    assert gs._parse_json('{"a": 1}') == {"a": 1}


def test_parse_json_with_code_fence():
    text = '```json\n{"a": 1, "b": [1, 2]}\n```'
    assert gs._parse_json(text) == {"a": 1, "b": [1, 2]}


def test_parse_json_with_plain_code_fence_no_lang():
    text = '```\n{"a": 1}\n```'
    assert gs._parse_json(text) == {"a": 1}


# ---- _known_source_urls / _drop_unknown_source_urls -----------------------
# 프롬프트 인젝션/할루시네이션 방어의 핵심 로직. 실제 검색 결과에 없는 url을 가진
# 이벤트는 LLM이 뭐라고 말했든 무조건 걸러져야 한다.


@pytest.fixture
def raw_results():
    return {
        "version_update": {
            "query": "원신 버전 업데이트 날짜 2026",
            "answer": "6.4 버전은 7월 30일에 업데이트됩니다.",
            "sources": [
                {"title": "공식 홈페이지", "url": "https://genshin.hoyoverse.com/notice/1", "content": "..."},
            ],
        },
        "character_pickup": {
            "query": "원신 캐릭터 픽업 기간 2026",
            "answer": "",
            "sources": [],
        },
    }


def test_known_source_urls(raw_results):
    urls = gs._known_source_urls(raw_results)
    assert urls == {"https://genshin.hoyoverse.com/notice/1"}


def test_drop_unknown_source_urls_keeps_known_url(raw_results):
    events = {
        "version_update": [
            {"date": "2026-07-30", "title": "6.4 버전 업데이트", "source_url": "https://genshin.hoyoverse.com/notice/1"},
        ],
        "character_pickup": [],
    }
    cleaned = gs._drop_unknown_source_urls(events, raw_results)
    assert len(cleaned["version_update"]) == 1
    assert cleaned["character_pickup"] == []


def test_drop_unknown_source_urls_removes_fabricated_url(raw_results):
    """LLM이(프롬프트 인젝션이든 할루시네이션이든) 실제 검색 결과에 없는 url을 지어내면 버려져야 한다."""
    events = {
        "version_update": [
            {"date": "2026-07-30", "title": "6.4 버전 업데이트", "source_url": "https://evil.example.com/fake"},
        ],
        "character_pickup": [],
    }
    cleaned = gs._drop_unknown_source_urls(events, raw_results)
    assert cleaned["version_update"] == []


def test_drop_unknown_source_urls_handles_missing_source_url(raw_results):
    events = {"version_update": [{"date": "2026-07-30", "title": "제목만 있고 url 없음"}], "character_pickup": []}
    cleaned = gs._drop_unknown_source_urls(events, raw_results)
    assert cleaned["version_update"] == []


# ---- _generate_content_with_retry -----------------------------------------


class _FakeResponse:
    def __init__(self, text):
        self.text = text


def test_retry_succeeds_after_transient_errors(monkeypatch):
    """503 UNAVAILABLE이 두 번 나고 세 번째에 성공하면, 재시도해서 최종적으로 성공해야 한다."""
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)  # 테스트가 실제로 기다리지 않게

    call_count = {"n": 0}

    def flaky_generate_content(model, contents):
        call_count["n"] += 1
        if call_count["n"] < 3:
            raise RuntimeError("503 UNAVAILABLE: model is overloaded")
        return _FakeResponse('{"ok": true}')

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = flaky_generate_content

    response = gs._generate_content_with_retry(fake_client, "아무 프롬프트")

    assert response.text == '{"ok": true}'
    assert call_count["n"] == 3


def test_retry_gives_up_on_non_transient_error(monkeypatch):
    """400 같은 재시도해도 소용없는 에러는 바로 위로 던져야 한다 (재시도 낭비 금지)."""
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = RuntimeError("400 INVALID_ARGUMENT: bad prompt")

    with pytest.raises(RuntimeError, match="400 INVALID_ARGUMENT"):
        gs._generate_content_with_retry(fake_client, "아무 프롬프트")

    assert fake_client.models.generate_content.call_count == 1


def test_retry_exhausts_after_max_retries(monkeypatch):
    """계속 503만 나면 max_retries만큼만 시도하고 결국 마지막 에러를 던져야 한다."""
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = RuntimeError("503 UNAVAILABLE")

    with pytest.raises(RuntimeError, match="503 UNAVAILABLE"):
        gs._generate_content_with_retry(fake_client, "아무 프롬프트", max_retries=3, base_delay=1)

    assert fake_client.models.generate_content.call_count == 3


# ---- get_confirmed_future_topic_ids ---------------------------------------


def test_get_confirmed_future_topic_ids_returns_empty_for_none_client():
    assert gs.get_confirmed_future_topic_ids(None, game_id=1) == set()
    assert gs.get_confirmed_future_topic_ids(MagicMock(), game_id=None) == set()


def test_get_confirmed_future_topic_ids_parses_rows():
    fake_client = MagicMock()
    fake_execute = fake_client.table.return_value.select.return_value.eq.return_value.eq.return_value.eq.return_value.eq.return_value.gte.return_value.execute
    fake_execute.return_value.data = [{"topic_id": "character_pickup"}, {"topic_id": "broadcast_schedule"}]

    result = gs.get_confirmed_future_topic_ids(fake_client, game_id=1)

    assert result == {"character_pickup", "broadcast_schedule"}
    fake_client.table.assert_called_with("game_events")
