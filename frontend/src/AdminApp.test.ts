// AdminApp.tsx의 순수 함수 유닛 테스트. 컴포넌트 렌더링 없이 로직만 검증한다.
// 실행: npm run test (frontend 폴더에서)

import { describe, expect, it, vi } from 'vitest'

// AdminApp.tsx는 최상단에서 실제 Supabase 클라이언트를 생성한다(./supabaseClient).
// 테스트 환경엔 .env가 없어 그 생성이 실패하므로, 순수 함수만 테스트하는 이 파일에서는
// supabaseClient를 가짜로 대체해 import 시점의 부작용(createClient 호출)을 막는다.
vi.mock('./supabaseClient', () => ({ supabase: {} }))

const {
  pacificDateString,
  sumTodayGeminiCalls,
  isAdminSessionExpired,
  koreaDateString,
  currentMonthString,
  monthRange,
  gamesUpdatedTodayList,
} = await import('./AdminApp')

describe('isAdminSessionExpired', () => {
  const now = new Date('2026-07-22T12:00:00Z')

  it('로그인 기록이 없으면(null) 안전하게 만료된 것으로 취급한다', () => {
    expect(isAdminSessionExpired(null, now)).toBe(true)
  })

  it('로그인한 지 24시간이 안 지났으면 아직 만료가 아니다', () => {
    const loginAt = now.getTime() - 23 * 60 * 60 * 1000 // 23시간 전
    expect(isAdminSessionExpired(loginAt, now)).toBe(false)
  })

  it('로그인한 지 24시간이 지났으면 만료다', () => {
    const loginAt = now.getTime() - 25 * 60 * 60 * 1000 // 25시간 전
    expect(isAdminSessionExpired(loginAt, now)).toBe(true)
  })
})

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

describe('koreaDateString', () => {
  it('UTC로 자정을 넘기기 전이어도 한국 시간(UTC+9)으로는 이미 다음 날일 수 있다', () => {
    // 2026-07-21T15:30:00Z = 한국시간 22일 00:30
    const utc = new Date('2026-07-21T15:30:00Z')
    expect(koreaDateString(utc)).toBe('2026-07-22')
  })
})

describe('currentMonthString / monthRange', () => {
  it('currentMonthString은 YYYY-MM만 반환한다', () => {
    expect(currentMonthString(new Date('2026-07-21T15:30:00Z'))).toBe('2026-07')
  })

  it('monthRange는 그 달의 1일과 마지막 날을 반환한다', () => {
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' }) // 평년 2월
    expect(monthRange('2026-07')).toEqual({ start: '2026-07-01', end: '2026-07-31' })
  })
})

describe('gamesUpdatedTodayList', () => {
  const now = new Date('2026-07-22T05:00:00Z') // 한국시간 22일 14시

  it('한국 날짜 기준 오늘 last_searched_at인 게임만 이름을 돌려준다', () => {
    const games = [
      { label: '원신', lastSearchedAt: '2026-07-22T02:00:00Z' }, // 한국시간 22일
      { label: '니케', lastSearchedAt: '2026-07-20T02:00:00Z' }, // 한국시간 20일 → 제외
      { label: '명조', lastSearchedAt: null }, // 아직 한 번도 검색 안 됨 → 제외
    ]
    expect(gamesUpdatedTodayList(games, now)).toEqual(['원신'])
  })

  it('오늘 업데이트된 게임이 없으면 빈 배열을 반환한다', () => {
    expect(gamesUpdatedTodayList([{ label: '원신', lastSearchedAt: null }], now)).toEqual([])
  })
})
