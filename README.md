# gameSearchScheduler

게임별 버전 업데이트/캐릭터 픽업/공식방송 일정을 자동으로 검색해 공개 캘린더로 보여주는 시스템.

- `game_search.py` — Supabase의 games/topics를 읽어 Tavily+Gemini로 검색·검증하고 `game_events`에 저장 (오라클 VM에서 cron으로 3일마다 실행)
- `admin_server.py` — 관리자 강제 실행용 FastAPI 서버 (오라클 VM에서 상시 실행, Tailscale Funnel로 노출)
- `frontend/` — 공개 캘린더(Vite+React) + `/admin` 관리자 페이지, Vercel 배포
- `schema.sql` — Supabase 테이블 정의
- `DEPLOY.md` — 오라클 VM 배포 가이드 (uv 설치, cron, systemd, Tailscale Funnel)

## 로컬 실행

```bash
uv venv && uv pip install -r requirements.txt
cp .env.example .env   # 키 채우기
python game_search.py "원신"   # 테스트 모드 (DB 저장 안 함)
python game_search.py          # 전체 게임 실행 (DB 저장)
```

```bash
cd frontend
npm install
cp .env.example .env   # 키 채우기
npm run dev
```
