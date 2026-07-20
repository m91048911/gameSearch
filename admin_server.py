"""
관리자용 FastAPI 서버.

오라클 VM에서 상시 실행되고, Tailscale Funnel로 외부(Vercel 관리자 페이지)에 노출된다.
Vercel의 관리자 페이지가 이 서버를 직접 호출하지 않는다 — Vercel 서버리스 함수
(frontend/api/admin/trigger-run.ts)가 로그인한 사용자가 관리자인지 먼저 확인한 뒤,
ADMIN_API_SECRET을 실어서 이 서버를 대신 호출한다. 이 시크릿은 브라우저에 절대 노출되지 않는다.

엔드포인트:
  GET  /health  - 상태 확인 (인증 불필요, Tailscale/모니터링용)
  GET  /status  - 마지막 실행 정보 + 현재 실행 중 여부 (X-Admin-Secret 헤더 필요)
  POST /run     - 강제 실행. 이미 실행 중이면 409. 백그라운드로 돌리고 즉시 202 응답 (X-Admin-Secret 헤더 필요)

실행 (로컬 테스트): python admin_server.py
운영 실행: uvicorn admin_server:app --host 127.0.0.1 --port 8000
  Tailscale Funnel이 이 포트를 외부와 연결하므로 0.0.0.0으로 열 필요가 없다 (systemd 설정은 DEPLOY.md 참고).

필요 환경변수 (.env, game_search.py와 공유 + 아래 항목 추가):
  ADMIN_API_SECRET
"""

import os
import threading
from typing import Optional

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException

from game_search import get_supabase_client, log, run_all_games

load_dotenv()

ADMIN_API_SECRET = os.getenv("ADMIN_API_SECRET")

app = FastAPI(title="game-search-admin")

# 동시 실행(크론 도중에 관리자가 또 누르는 경우 등)을 막기 위한 잠금.
_run_lock = threading.Lock()
_run_in_progress = False


def _check_secret(x_admin_secret: Optional[str]):
    if not ADMIN_API_SECRET:
        raise HTTPException(status_code=500, detail="서버에 ADMIN_API_SECRET이 설정되지 않았습니다.")
    if x_admin_secret != ADMIN_API_SECRET:
        raise HTTPException(status_code=401, detail="인증 실패")


def _run_in_background():
    global _run_in_progress
    try:
        run_all_games(trigger_source="manual")
    except Exception as e:
        log(f"수동 실행 실패: {e}")
    finally:
        with _run_lock:
            _run_in_progress = False


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


@app.post("/run", status_code=202)
def trigger_run(background_tasks: BackgroundTasks, x_admin_secret: Optional[str] = Header(default=None)):
    _check_secret(x_admin_secret)

    global _run_in_progress
    with _run_lock:
        if _run_in_progress:
            raise HTTPException(status_code=409, detail="이미 실행 중입니다.")
        _run_in_progress = True

    background_tasks.add_task(_run_in_background)
    return {"status": "started"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
