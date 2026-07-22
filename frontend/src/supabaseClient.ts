// 브라우저에서 직접 쓰는 Supabase 클라이언트. App.tsx(공개 캘린더)는 이걸 타입 참조로만 쓰고
// 실제 조회는 /api/events, /api/games(서버리스 함수)를 거치지만, AdminApp.tsx(관리자 화면)는
// 로그인/세션 관리와 games·game_events·run_log 조회/쓰기에 이 클라이언트를 직접 사용한다.
// anon key만 쓰기 때문에 실제 접근 범위는 전부 Supabase RLS 정책(schema.sql)이 결정한다.
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY가 설정되지 않았습니다. .env.example을 참고해 .env를 만드세요.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// game_events 테이블 한 행의 형태 (game_search.py의 save_events가 채워 넣는 컬럼)
export type GameEventRow = {
  id: number
  event_date: string
  title: string
  category: string
  genre: string | null
  note: string | null
  source_url: string | null
  verified: boolean | null
  confidence: string | null
}
