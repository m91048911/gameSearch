# 오라클 클라우드 배포 가이드

1GB RAM Oracle Cloud VM에 이 프로젝트를 올려서 아래 두 가지를 동시에 돌린다.

- **cron**: `game_search.py`를 3일에 한 번 실행하는 배치 (자동 수집)
- **systemd 서비스**: `admin_server.py`(FastAPI)를 상시 실행 → Tailscale Funnel로 외부에 노출 → Vercel 관리자 페이지의 "강제 업데이트" 버튼이 이 서버를 호출

아래 명령의 `ubuntu`, `/home/ubuntu/gameSearch`는 Ubuntu 이미지 기준이다. Oracle Linux 이미지(`opc` 계정)라면 경로/유저를 그에 맞게 바꾼다.

## 1. 코드 업로드 + 환경변수

```bash
git clone <레포 주소> /home/ubuntu/gameSearch
cd /home/ubuntu/gameSearch
cp .env.example .env
nano .env   # 실제 키값 채우기 (TAVILY_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_KEY, ADMIN_API_SECRET)
```

`ADMIN_API_SECRET`은 `openssl rand -hex 32`로 생성한 값을 넣고, 같은 값을 Vercel의 `trigger-run` 함수 환경변수에도 등록해야 한다 (Task #6).

## 2. uv로 의존성 설치 (1GB RAM 절약)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env

cd /home/ubuntu/gameSearch
uv venv
uv pip install -r requirements.txt
```

`uv`는 pip보다 빌드 캐시/메모리를 덜 쓰기 때문에 1GB RAM에서 `google-genai`/`supabase` 같은 무거운 의존성을 설치할 때 스왑으로 인한 실패를 줄여준다.

## 3. cron 등록 (3일에 한 번 자동 수집)

```bash
crontab -e
```

아래 줄 추가 (매 3일 04:00 KST 실행, 서버 타임존이 UTC라면 맞춰서 시간 조정):

```
0 4 */3 * * cd /home/ubuntu/gameSearch && /home/ubuntu/gameSearch/.venv/bin/python game_search.py >> /home/ubuntu/gameSearch/cron.log 2>&1
```

## 4. admin_server.py를 systemd 서비스로 등록 (상시 실행)

리포지토리에 있는 `gamesearch-admin.service`를 등록한다:

```bash
sudo cp /home/ubuntu/gameSearch/gamesearch-admin.service /etc/systemd/system/gamesearch-admin.service
sudo systemctl daemon-reload
sudo systemctl enable --now gamesearch-admin
sudo systemctl status gamesearch-admin   # active (running) 확인
```

유닛 파일의 `User=`, `WorkingDirectory=`, `ExecStart=` 경로가 실제 계정/경로와 다르면 먼저 고친다. 로그는 `journalctl -u gamesearch-admin -f`로 확인한다.

## 5. Tailscale 설치 + Funnel로 8000번 포트 외부 노출

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

브라우저에서 인증 링크를 열어 본인 Tailscale 계정으로 로그인한다(관리자 혼자 쓰는 구조이므로 개인 계정이면 충분).

```bash
sudo tailscale funnel 8000
```

실행하면 `https://<머신이름>.<tailnet>.ts.net` 형태의 HTTPS 주소가 나온다. 이 주소가 admin_server.py의 공개 엔드포인트다 (내부적으로 127.0.0.1:8000 → Funnel이 HTTPS 종단 처리). 이 값을 Vercel의 `TAILSCALE_FUNNEL_URL` 환경변수로 등록한다 (Task #6).

`sudo tailscale funnel status`로 계속 켜져 있는지 확인할 수 있고, VM 재부팅 후에도 `tailscaled`는 systemd로 자동 등록되어 자동 재연결된다 (Funnel 설정도 유지됨).

## 6. 배포 확인

```bash
# VM 내부에서
curl http://127.0.0.1:8000/health
# {"status":"ok"}

curl -H "X-Admin-Secret: <ADMIN_API_SECRET 값>" http://127.0.0.1:8000/status
# {"running":false,"last_run":null 또는 이전 실행 정보}

# 외부(Funnel 주소)에서도 동일하게 확인
curl https://<머신이름>.<tailnet>.ts.net/health
```

## cron과 systemd 서비스가 겹치면?

cron(자동, 3일 주기)과 관리자의 수동 "강제 업데이트" 버튼은 서로 다른 프로세스라서 파이썬 메모리상의 잠금을 공유하지 못한다. 그래서 `run_all_games()`가 시작할 때마다 Supabase `run_log` 테이블에 `status='running'`인 행이 있는지 먼저 확인하고, 있으면 즉시 건너뛴다 (`_is_run_already_in_progress`). 즉 cron이 도는 중에 관리자가 버튼을 누르면 그 실행은 조용히 스킵되고 로그에 남으며, `game_events` 테이블이 두 프로세스에 의해 동시에 지워지고 다시 쓰이는 상황은 생기지 않는다.
