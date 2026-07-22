"""
admin_server.py(FastAPI) 엔드포인트 테스트.

원칙: 실제 game_search.run_all_games()(=진짜 Tavily/Gemini/Supabase 호출)는 절대 실행하지 않는다.
전부 mock으로 대체한다. 인증(시크릿 검증), 동시 실행 잠금(409), 재요청 쿨다운(429)만 검증한다.

실행: pytest tests/test_admin_server.py -v
"""

import time
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import admin_server


@pytest.fixture(autouse=True)
def reset_admin_state(monkeypatch):
    """모듈 레벨 전역 상태(_run_in_progress, _last_run_finished_at, ADMIN_API_SECRET, RUN_COOLDOWN_SECONDS)가
    테스트끼리 서로 영향을 주지 않도록 각 테스트 전에 안전한 기본값으로 리셋한다."""
    monkeypatch.setattr(admin_server, "ADMIN_API_SECRET", "test-secret")
    monkeypatch.setattr(admin_server, "RUN_COOLDOWN_SECONDS", 180)
    monkeypatch.setattr(admin_server, "_run_in_progress", False)
    monkeypatch.setattr(admin_server, "_last_run_finished_at", None)
    yield


@pytest.fixture
def client():
    return TestClient(admin_server.app)


def test_health_needs_no_auth(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_run_rejects_missing_secret_config(client, monkeypatch):
    monkeypatch.setattr(admin_server, "ADMIN_API_SECRET", None)
    response = client.post("/run", headers={"X-Admin-Secret": "anything"})
    assert response.status_code == 500


def test_run_rejects_wrong_secret(client):
    response = client.post("/run", headers={"X-Admin-Secret": "wrong-secret"})
    assert response.status_code == 401


def test_run_starts_successfully_with_correct_secret(client, monkeypatch):
    monkeypatch.setattr(admin_server, "run_all_games", MagicMock(return_value={"processed": 0, "total": 0, "errors": []}))
    response = client.post("/run", headers={"X-Admin-Secret": "test-secret"})
    assert response.status_code == 202
    assert response.json() == {"status": "started"}


def test_run_rejects_when_already_in_progress(client, monkeypatch):
    monkeypatch.setattr(admin_server, "_run_in_progress", True)
    response = client.post("/run", headers={"X-Admin-Secret": "test-secret"})
    assert response.status_code == 409


def test_run_rejects_within_cooldown(client, monkeypatch):
    monkeypatch.setattr(admin_server, "_last_run_finished_at", time.monotonic())  # 방금 끝남
    monkeypatch.setattr(admin_server, "RUN_COOLDOWN_SECONDS", 180)
    response = client.post("/run", headers={"X-Admin-Secret": "test-secret"})
    assert response.status_code == 429
    assert "다시 시도" in response.json()["detail"]


def test_run_allowed_after_cooldown_passed(client, monkeypatch):
    monkeypatch.setattr(admin_server, "run_all_games", MagicMock(return_value={"processed": 0, "total": 0, "errors": []}))
    monkeypatch.setattr(admin_server, "_last_run_finished_at", time.monotonic() - 200)  # 200초 전에 끝남
    monkeypatch.setattr(admin_server, "RUN_COOLDOWN_SECONDS", 180)
    response = client.post("/run", headers={"X-Admin-Secret": "test-secret"})
    assert response.status_code == 202


def test_status_needs_correct_secret(client, monkeypatch):
    fake_client = MagicMock()
    fake_client.table.return_value.select.return_value.order.return_value.limit.return_value.execute.return_value.data = []
    monkeypatch.setattr(admin_server, "get_supabase_client", lambda: fake_client)

    response = client.get("/status", headers={"X-Admin-Secret": "test-secret"})
    assert response.status_code == 200
    assert response.json() == {"running": False, "last_run": None}

    response = client.get("/status", headers={"X-Admin-Secret": "wrong"})
    assert response.status_code == 401
