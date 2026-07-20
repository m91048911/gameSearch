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
