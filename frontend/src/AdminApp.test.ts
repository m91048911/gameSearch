// AdminApp.tsx의 순수 함수 유닛 테스트. 컴포넌트 렌더링 없이 로직만 검증한다.
// 실행: npm run test (frontend 폴더에서)

import { describe, expect, it, vi } from 'vitest'

// AdminApp.tsx는 최상단에서 실제 Supabase 클라이언트를 생성한다(./supabaseClient).
// 테스트 환경엔 .env가 없어 그 생성이 실패하므로, 순수 함수만 테스트하는 이 파일에서는
// supabaseClient를 가짜로 대체해 import 시점의 부작용(createClient 호출)을 막는다.
vi.mock('./supabaseClient', () => ({ supabase: {} }))

const { pacificDateString, sumTodayGeminiCalls } = await import('./AdminApp')

describe('pacificDateString', () => {
  it('UTC 기준 자정을 넘겨도 태평양 시간으로는 아직 전날일 수 있다', () => {
    // 2026-07-22T03:00:00Z는 UTC로는 22일이지만, PDT(UTC-7)로는 21일 20시.
    const utc = new Date('2026-07-22T03:00:00Z')
    expect(pacificDateString(utc)).toBe('2026-07-21')
  })

  it('태평양 시간 기준으로 날짜가 이미 넘어간 시각은 그 날짜를 반환한다', () => {
    // 2026-07-22T20:00:00Z = PDT 13시, 같은 날짜.
    const utc = new Date('2026-07-22T20:00:00Z')
    expect(pacificDateString(utc)).toBe('2026-07-22')
  })
})

describe('sumTodayGeminiCalls', () => {
  const now = new Date('2026-07-22T20:00:00Z') // 태평양 시간 기준 2026-07-22

  it('태평양 시간 기준 오늘 실행분의 gemini_calls만 더한다', () => {
    const runs = [
      { started_at: '2026-07-22T20:00:00Z', gemini_calls: 10 }, // 오늘(태평양 22일)
      { started_at: '2026-07-22T03:00:00Z', gemini_calls: 5 }, // 태평양 시간으로는 21일 → 제외
      { started_at: '2026-07-21T18:00:00Z', gemini_calls: 3 }, // 태평양 시간으로는 21일 → 제외
    ]
    expect(sumTodayGeminiCalls(runs, now)).toBe(10)
  })

  it('gemini_calls가 null이어도 에러 없이 0으로 취급한다', () => {
    const runs = [{ started_at: '2026-07-22T20:00:00Z', gemini_calls: null }]
    expect(sumTodayGeminiCalls(runs, now)).toBe(0)
  })

  it('오늘 실행이 여러 건이면 전부 합산한다', () => {
    const runs = [
      { started_at: '2026-07-22T20:00:00Z', gemini_calls: 10 },
      { started_at: '2026-07-22T21:00:00Z', gemini_calls: 4 },
    ]
    expect(sumTodayGeminiCalls(runs, now)).toBe(14)
  })

  it('실행 이력이 없으면 0을 반환한다', () => {
    expect(sumTodayGeminiCalls([], now)).toBe(0)
  })
})
