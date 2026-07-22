-- Supabase: 게임별 공식 도메인 목록 (공식 정보만 검색하도록 Tavily include_domains에 사용)
-- 예: update games set official_domains = array['hoyoverse.com', 'genshin.hoyoverse.com', 'x.com/Genshin_7'] where id = 1;
-- 값을 비워두면(NULL) 기존처럼 도메인 제한 없이 검색한다.

alter table games add column if not exists official_domains text[];

-- games는 RLS만 켜져 있고 정책이 없으면 anon key로는 아무것도 못 읽는다(기본 거부).
-- 공개 캘린더(/api/games, anon key)와 관리자 페이지(로그인 세션)는 계속 읽을 수 있어야 하고,
-- 쓰기(추가/수정/삭제)는 관리자 본인 로그인 세션에서만 가능해야 한다.
-- 크론/game_search.py는 SUPABASE_KEY(서비스 롤)로 쓰기 때문에 아래 RLS와 무관하게 항상 동작한다.
alter table games enable row level security;

drop policy if exists "public can read games" on games;
create policy "public can read games"
  on games for select
  using (true);

drop policy if exists "admin can manage games" on games;
create policy "admin can manage games"
  on games for all
  using (auth.jwt() ->> 'email' = 'm91048911@gmail.com')
  with check (auth.jwt() ->> 'email' = 'm91048911@gmail.com');

-- Supabase: 검색 주제 정의 테이블
-- 새 검색 항목을 늘리고 싶으면 코드 수정 없이 이 테이블에 행만 추가하면 된다.
-- calendar_category: 프론트엔드 캘린더(gameInfo 레포)의 MenuKey('launch' | 'update' | 'broadcast' | 'pickup' 등)와 매핑되는 값.
--   프론트엔드에 새 메뉴를 추가하지 않고 기존 카테고리에 합치고 싶으면 이 값만 바꾸면 된다.

create table if not exists topics (
  id                 text primary key,        -- 예: 'version_update'
  label              text not null,           -- Gemini 프롬프트/화면에 쓰일 이름
  query_hint         text not null,           -- Tavily 검색어에 붙일 문구
  calendar_category  text not null,           -- 프론트엔드 MenuKey와 매핑: 'update' | 'pickup' | 'broadcast' | 'launch'
  sort_order         int not null default 0,
  active             boolean not null default true
);

-- games와 마찬가지로, RLS만 켜져 있고 정책이 없으면 anon key로 아무것도 못 읽는다(기본 거부).
-- 지금 프론트엔드는 topics를 직접 읽지는 않지만, 나중에 필요해질 수 있고 games와 일관성을 맞추기 위해
-- 동일한 패턴(공개 읽기 + 관리자 전용 쓰기)을 적용해둔다.
alter table topics enable row level security;

drop policy if exists "public can read topics" on topics;
create policy "public can read topics"
  on topics for select
  using (true);

drop policy if exists "admin can manage topics" on topics;
create policy "admin can manage topics"
  on topics for all
  using (auth.jwt() ->> 'email' = 'm91048911@gmail.com')
  with check (auth.jwt() ->> 'email' = 'm91048911@gmail.com');

alter table topics add column if not exists calendar_category text;

insert into topics (id, label, query_hint, calendar_category, sort_order) values
  ('version_update', '버전 업데이트 날짜', '버전 업데이트 날짜', 'update', 1),
  ('character_pickup', '캐릭터 픽업 기간', '캐릭터 픽업 기간', 'pickup', 2),
  ('broadcast_schedule', '공식방송 일정', '공식방송 일정', 'broadcast', 3)
on conflict (id) do nothing;

-- 기존에 topics 테이블을 이미 만들어뒀다면 calendar_category 컬럼만 추가/채우기
update topics set calendar_category = 'update' where id = 'version_update' and calendar_category is null;
update topics set calendar_category = 'pickup' where id = 'character_pickup' and calendar_category is null;
update topics set calendar_category = 'broadcast' where id = 'broadcast_schedule' and calendar_category is null;

-- Tavily 사용량(크레딧) 절감용: 주제별로 검색 깊이를 다르게 준다.
-- 'basic'이 'advanced'보다 크레딧을 덜 쓴다. 공식 홈페이지에 명확히 공지되는
-- 버전 업데이트/픽업은 basic으로도 충분하고, 찾기 까다로운 공식방송 일정만 advanced를 유지한다.
alter table topics add column if not exists search_depth text not null default 'basic';
update topics set search_depth = 'advanced' where id = 'broadcast_schedule';

-- 캘린더에 바로 꽂을 수 있는 개별 일정(이벤트) 테이블.
-- gameInfo 프론트엔드의 ScheduleItem과 1:1로 대응한다: date/title/category/genre/note.
-- 기존 game_schedule_info(주제당 텍스트 한 줄)를 대체한다 — 달력에는 실제 날짜 단위 이벤트가 필요하기 때문.
-- 하루 실행마다 (game_id, topic_id) 조합의 기존 행을 지우고 새로 채운다 (game_search.py의 save_events 참고).

create table if not exists game_events (
  id           bigint generated always as identity primary key,
  game_id      bigint references games(id) on delete cascade,
  topic_id     text references topics(id) on delete cascade,
  event_date   date not null,
  title        text not null,       -- 예: '6.4 버전 업데이트'
  category     text not null,       -- topics.calendar_category 값을 그대로 복사 (프론트 MenuKey)
  genre        text,                -- 게임 이름 (프론트 ScheduleItem.genre)
  note         text,                -- 짧은 설명
  source_url   text,
  verified     boolean,
  confidence   text,
  checked_at   timestamptz not null default now()
);

create index if not exists game_events_date_idx on game_events (event_date);

-- 관리자 페이지에서 직접 추가한 일정과, game_search.py(크론)가 자동으로 채운 일정을 구분한다.
-- save_events()는 자동 실행마다 이 (game_id, topic_id) 조합의 'search' 행만 지우고 다시 채우므로,
-- 관리자가 직접 추가한 'manual' 행은 자동 실행에 영향받지 않고 계속 남는다.
alter table game_events add column if not exists source text not null default 'search';

-- 공개 캘린더(/api/events, anon key)는 계속 읽을 수 있어야 하고, 쓰기(추가/수정/삭제)는
-- 관리자 본인 로그인 세션에서만 가능해야 한다. 크론/FastAPI는 SUPABASE_KEY(서비스 롤)로 쓰기 때문에
-- 아래 RLS와 무관하게 항상 동작한다.
alter table game_events enable row level security;

drop policy if exists "public can read game_events" on game_events;
create policy "public can read game_events"
  on game_events for select
  using (true);

drop policy if exists "admin can manage game_events" on game_events;
create policy "admin can manage game_events"
  on game_events for all
  using (auth.jwt() ->> 'email' = 'm91048911@gmail.com')
  with check (auth.jwt() ->> 'email' = 'm91048911@gmail.com');

-- 실행 이력 테이블. game_search.py(크론)와 FastAPI(/run, 수동 트리거)가 모두 여기에 기록한다.
-- 쓰기는 오라클 VM에서 SUPABASE_KEY(서비스 롤)로만 하므로 RLS를 우회한다.
-- 읽기는 관리자 페이지에서 로그인한 본인 이메일일 때만 허용한다.

create table if not exists run_log (
  id               bigint generated always as identity primary key,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null default 'running',  -- 'running' | 'success' | 'failed'
  trigger_source   text not null,                      -- 'cron' | 'manual'
  games_processed  int,
  error_message    text,
  gemini_calls     int not null default 0  -- 이 실행에서 실제로 호출한 Gemini API 횟수(재시도 포함).
                                            -- 구글이 공식 제공하는 쿼터 수치가 아니라, 우리가 직접 센 근사치.
);

-- 이미 배포된 DB에는 위 create table이 no-op이라 컬럼이 따로 필요하면 아래를 실행:
alter table run_log add column if not exists gemini_calls int not null default 0;

alter table run_log enable row level security;

drop policy if exists "admin can read run_log" on run_log;
create policy "admin can read run_log"
  on run_log for select
  using (auth.jwt() ->> 'email' = 'm91048911@gmail.com');
