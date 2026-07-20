// GET /api/events
//
// 공개 캘린더가 호출하는 캐시된 엔드포인트. Supabase game_events를 서버에서 대신 조회해
// s-maxage로 하루 동안 Vercel Edge 캐시에 태워 보낸다 — 방문자가 몰려도
// Supabase 무료 티어의 API 호출/egress를 프론트 트래픽만큼 그대로 소모하지 않게 하기 위함.
//
// 오늘 이전 데이터는 반환하지 않는다 (지난 일정을 굳이 캐시/전송할 필요가 없어서).
//
// 필요 환경변수 (Vercel 프로젝트 설정에 등록, VITE_ 접두어 없이 — 서버 전용):
//   SUPABASE_URL, SUPABASE_ANON_KEY (anon/publishable 키. service key는 여기 쓰지 않는다)

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

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
  const today = new Date().toISOString().slice(0, 10) // UTC 기준 YYYY-MM-DD, "오늘부터만" 필터

  const { data, error } = await supabase
    .from('game_events')
    .select('id, event_date, title, category, genre, note, source_url, verified, confidence')
    .gte('event_date', today)
    .order('event_date', { ascending: true })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // stale-while-revalidate: 캐시가 만료돼도 재검증하는 동안은 지난 응답을 그대로 보여준다.
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate')
  res.status(200).json({ events: data ?? [] })
}
