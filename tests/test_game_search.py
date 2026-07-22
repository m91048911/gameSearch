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


# ---- Gemini 호출 횟수 카운팅 (관리자 페이지 사용량 표시용) ------------------
# 구글이 API 키로 조회 가능한 공식 사용량 엔드포인트를 제공하지 않아서, 우리가 직접 센다.
# 재시도도 실제로는 API를 한 번 더 호출하는 것이므로 카운트에 포함되어야 한다.


def test_gemini_call_count_counts_every_actual_attempt_including_retries(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    gs.reset_gemini_call_count()

    call_count = {"n": 0}

    def flaky(model, contents):
        call_count["n"] += 1
        if call_count["n"] < 3:
            raise RuntimeError("503 UNAVAILABLE")
        return _FakeResponse('{"ok": true}')

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = flaky

    gs._generate_content_with_retry(fake_client, "아무 프롬프트")

    assert gs.get_gemini_call_count() == 3  # 실패 2번 + 성공 1번, 전부 실제 API 호출


def test_reset_gemini_call_count_zeroes_out():
    gs.reset_gemini_call_count()
    assert gs.get_gemini_call_count() == 0


# ---- 429 RESOURCE_EXHAUSTED(쿼터 소진) 전용 처리 ---------------------------
# 실제 운영 중 마주친 에러: 무료 티어 하루 20건 제한. 이건 503과 달리 "몇 번이고 재시도"하면
# 오히려 얼마 안 남은 쿼터를 더 깎아먹으므로, 딱 한 번만 재시도하고 안 되면 바로 포기해야 한다.


def test_extract_retry_delay_seconds_parses_google_error_format():
    message = (
        "429 RESOURCE_EXHAUSTED. {'error': {..., 'details': [..., "
        "{'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '57s'}]}}"
    )
    assert gs._extract_retry_delay_seconds(message) == 57.0


def test_extract_retry_delay_seconds_returns_none_when_absent():
    assert gs._extract_retry_delay_seconds("아무 관련 없는 에러 메시지") is None


def test_quota_exhausted_retries_exactly_once_then_succeeds(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    call_count = {"n": 0}

    def flaky(model, contents):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("429 RESOURCE_EXHAUSTED ... 'retryDelay': '10s' ...")
        return _FakeResponse('{"ok": true}')

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = flaky

    response = gs._generate_content_with_retry(fake_client, "아무 프롬프트")

    assert response.text == '{"ok": true}'
    assert call_count["n"] == 2  # 최초 시도 + 재시도 1번


def test_quota_exhausted_gives_up_after_one_retry(monkeypatch):
    """쿼터 소진이 재시도 후에도 계속되면, 503처럼 여러 번 더 시도하지 않고 딱 2번(최초+1회)만에 포기해야 한다."""
    sleep_calls = []
    monkeypatch.setattr(time, "sleep", lambda seconds: sleep_calls.append(seconds))

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = RuntimeError(
        "429 RESOURCE_EXHAUSTED ... 'retryDelay': '5s' ..."
    )

    with pytest.raises(RuntimeError, match="RESOURCE_EXHAUSTED"):
        gs._generate_content_with_retry(fake_client, "아무 프롬프트")

    assert fake_client.models.generate_content.call_count == 2
    assert sleep_calls == [5.0]  # 딱 한 번, Google이 알려준 시간만큼만 기다림


def test_quota_exhausted_delay_is_capped_at_60_seconds(monkeypatch):
    sleep_calls = []
    monkeypatch.setattr(time, "sleep", lambda seconds: sleep_calls.append(seconds))

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = RuntimeError(
        "429 RESOURCE_EXHAUSTED ... 'retryDelay': '300s' ..."  # 비정상적으로 긴 값이 와도
    )

    with pytest.raises(RuntimeError):
        gs._generate_content_with_retry(fake_client, "아무 프롬프트")

    assert sleep_calls == [60]  # 최대 60초까지만 기다린다


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
