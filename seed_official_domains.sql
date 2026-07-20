-- 게임별 공식 도메인 채우기 (1회성 실행, Supabase SQL Editor에서 실행)
-- name_ko 값이 실제 games 테이블과 다르면 0 rows affected로 나오니, 그 경우 name_ko를 맞춰서 다시 실행하세요.

-- 원신 (Genshin Impact) - HoYoverse
update games set official_domains = array['genshin.hoyoverse.com', 'hoyoverse.com']
where name_ko = '원신';

-- 붕괴 스타레일 (Honkai: Star Rail) - HoYoverse
update games set official_domains = array['hsr.hoyoverse.com', 'hoyoverse.com']
where name_ko = '붕괴 스타레일';

-- 젠레스존제로 (Zenless Zone Zero) - HoYoverse
update games set official_domains = array['zenless.hoyoverse.com', 'hoyoverse.com']
where name_ko = '젠레스존제로';

-- 명일방주 엔드필드 (Arknights: Endfield) - Hypergryph / 글로벌 퍼블리셔 Gryphline
update games set official_domains = array['endfield.hypergryph.com', 'gryphline.com']
where name_ko = '명일방주 엔드필드';

-- 실행 후 확인
select id, name_ko, official_domains from games where name_ko in (
  '원신', '붕괴 스타레일', '젠레스존제로', '명일방주 엔드필드'
);
