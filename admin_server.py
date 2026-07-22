"""
관리자용 FastAPI 서버.

오라클 VM에서 상시 실행되고, Tailscale Funnel로 외부(Vercel 관리자 페이지)에 노출된다.
Vercel의 관리자 페이지가 이 서버를 직접 호출하지 않는다 — Vercel 서버리스 함수
(frontend/api/admin/trigger-run.ts)가 로그인한 사용자가 관리자인지 먼저 확인한 뒤,
ADMIN_API_SECRET을 실어서 이 서버를 대신 호출한다. 이 시크릿은 브라우저에 절대 노출되지 않는다.

엔드포인트:
  GET  /health  - 상태 확인 (인증 불필요, Tailscale/모니터링용)
  GET  /status  - 마지막 실행 정보 + 현재 실행 중 여부 (X-Admin-Secret 헤더 필요)
  POST /run     - 강제 실행. 이미 실행 중이면 409, 직전 실행이 쿨다운 안에 있으면 429.
                  백그라운드로 돌리고 즉시 202 응답 (X-Admin-Secret 헤더 필요)
  GET  /usage   - Tavily 계정/API키 사용량을 그대로 전달 (X-Admin-Secret 헤더 필요).
                  Gemini는 구글이 API 키로 조회 가능한 공식 사용량 엔드포인트를 제공하지
                  않으므로 포함하지 않는다 — Gemini 쪽은 /status의 run_log.gemini_calls
                  (우리가 직접 센 근사치)로 대신한다.

실행 (로컬 테스트): python admin_server.py
운영 실행: uvicorn admin_server:app --host 127.0.0.1 --port 8000
  Tailscale Funnel이 이 포트를 외부와 연결하므로 0.0.0.0으로 열 필요가 없다 (systemd 설정은 DEPLOY.md 참고).

필요 환경변수 (.env, game_search.py와 공유 + 아래 항목 추가):
  ADMIN_API_SECRET
  ADMIN_RUN_COOLDOWN_SECONDS (선택, 기본 180) - /run 완료 직후 재요청을 막는 대기 시간(초).
    관리자 토큰이 유출되거나 실수로 버튼을 연타해도 Tavily/Gemini 크레딧이 짧은 간격으로
    반복 소모되지 않도록 하는 안전장치.
"""

import os
import threading
import time
from typing import Optional

import requests
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException

from game_search import TAVILY_API_KEY, get_supabase_client, log, run_all_games

load_dotenv()

ADMIN_API_SECRET = os.getenv("ADMIN_API_SECRET")
RUN_COOLDOWN_SECONDS = int(os.getenv("ADMIN_RUN_COOLDOWN_SECONDS", "180"))

app = FastAPI(title="game-search-admin")

# 동시 실행(크론 도중에 관리자가 또 누르는 경우 등)을 막기 위한 잠금.
_run_lock = threading.Lock()
_run_in_progress = False
# 마지막으로 실행이 "끝난" 시각(time.monotonic() 기준). 서버 재시작하면 초기화되는데,
# 어차피 쿨다운은 남용 방지용 안전장치일 뿐이라 그 정도는 문제 없다.
_last_run_finished_at: Optional[float] = None


def _check_secret(x_admin_secret: Optional[str]):
    if not ADMIN_API_SECRET:
        raise HTTPException(status_code=500, detail="서버에 ADMIN_API_SECRET이 설정되지 않았습니다.")
    if x_admin_secret != ADMIN_API_SECRET:
        raise HTTPException(status_code=401, detail="인증 실패")


def _run_in_background():
    global _run_in_progress, _last_run_finished_at
    try:
        run_all_games(trigger_source="manual")
    except Exception as e:
        log(f"수동 실행 실패: {e}")
    finally:
        with _run_lock:
            _run_in_progress = False
            _last_run_finished_at = time.monotonic()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/status")
def status(x_admin_secret: Optional[str] = Header(default=None)):
    _check_secret(x_admin_secret)

    client = get_supabase_client()
    res = (
        client.table("run_log")
        .select("*")
        .order("started_at", desc=True)
        .limit(1)
        .execute()
    )
    last_run = res.data[0] if res.data else None

    return {"running": _run_in_progress, "last_run": last_run}


@app.get("/usage")
def usage(x_admin_secret: Optional[str] = Header(default=None)):
    """Tavily의 공식 GET /usage 응답을 그대로 전달한다 (크레딧 사용량/한도/플랜 정보).
    Gemini는 API 키로 조회 가능한 동급 엔드포인트가 없어서 여기 포함하지 않는다."""
    _check_secret(x_admin_secret)

    if not TAVILY_API_KEY:
        raise HTTPException(status_code=500, detail="TAVILY_API_KEY가 설정되지 않았습니다.")

    try:
        res = requests.get(
            "https://api.tavily.com/usage",
            headers={"Authorization": f"Bearer {TAVILY_API_KEY}"},
            timeout=10,
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Tavily 사용량 조회 실패: {e}")

    if res.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Tavily 사용량 조회 실패 (status={res.status_code})")

    return res.json()


@app.post("/run", status_code=202)
def trigger_run(background_tasks: BackgroundTasks, x_admin_secret: Optional[str] = Header(default=None)):
    _check_secret(x_admin_secret)

    global _run_in_progress
    with _run_lock:
        if _run_in_progress:
            raise HTTPException(status_code=409, detail="이미 실행 중입니다.")

        if _last_run_finished_at is not None:
            elapsed = time.monotonic() - _last_run_finished_at
            if elapsed < RUN_COOLDOWN_SECONDS:
                remaining = int(RUN_COOLDOWN_SECONDS - elapsed)
                raise HTTPException(
                    status_code=429,
                    detail=f"너무 잦은 요청입니다. {remaining}초 후 다시 시도하세요.",
                )

        _run_in_progress = True

    background_tasks.add_task(_run_in_background)
    return {"status": "started"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
