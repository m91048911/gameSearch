// GET /api/events
//
// 공개 캘린더가 호출하는 캐시된 엔드포인트. Supabase game_events를 서버에서 대신 조회해
// s-maxage로 하루 동안 Vercel Edge 캐시에 태워 보낸다 — 방문자가 몰려도
// Supabase 무료 티어의 API 호출/egress를 프론트 트래픽만큼 그대로 소모하지 않게 하기 위함.
//
// 수집(game_search.py)은 그대로 두고, 화면에 내려주는 범위만 "이번 달 기준 앞뒤 한 달"로 제한한다.
// 즉 지난달 1일 ~ 다음달 말일 사이의 일정만 반환한다 (너무 오래된 과거/너무 먼 미래는 굳이 안 보내도 됨).
//
// 필요 환경변수 (Vercel 프로젝트 설정에 등록, VITE_ 접두어 없이 — 서버 전용):
//   SUPABASE_URL, SUPABASE_ANON_KEY (anon/publishable 키. service key는 여기 쓰지 않는다)

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET만 지원합니다.' })
    return
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY가 설정되지 않았습니다.' })
    return
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey)

  // UTC 기준 오늘이 속한 달의 1일에서, 전월 1일 / 익월 말일을 계산한다.
  const now = new Date()
  const rangeStart = toIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))
  const rangeEnd = toIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0)))

  const { data, error } = await supabase
    .from('game_events')
    .select('id, event_date, title, category, genre, note, source_url, verified, confidence')
    .gte('event_date', rangeStart)
    .lte('event_date', rangeEnd)
    .order('event_date', { ascending: true })

  if (error) {
    // Supabase 원본 에러 메시지에는 컬럼/제약조건명 등 내부 스키마 정보가 섞여 나올 수 있다.
    // 인증 없는 공개 엔드포인트라 그대로 돌려주지 않고, 서버 로그(Vercel Function Logs)에만 남긴다.
    console.error('[api/events] Supabase 조회 실패:', error)
    res.status(500).json({ error: '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' })
    return
  }

  // stale-while-revalidate: 캐시가 만료돼도 재검증하는 동안은 지난 응답을 그대로 보여준다.
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate')
  res.status(200).json({ events: data ?? [] })
}
