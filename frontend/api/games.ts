// GET /api/games
//
// 공개 캘린더의 "게임별 보기"에 항상 전체 수집 대상 게임을 보여주기 위한 엔드포인트.
// game_events에 아직 이벤트가 하나도 없는 게임도 목록에 나와야 하므로, game_events가 아니라
// games 테이블에서 직접 가져온다. 게임 목록은 자주 안 바뀌니 이벤트보다 길게 캐싱한다.
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

  const { data, error } = await supabase
    .from('games')
    .select('id, name_ko, name_en')
    .order('id')

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  const games = (data ?? []).map((row) => ({
    id: row.id as number,
    name: (row.name_ko ?? row.name_en ?? `#${row.id}`) as string,
  }))

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate')
  res.status(200).json({ games })
}
