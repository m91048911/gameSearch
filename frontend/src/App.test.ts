// App.tsx의 순수 함수 유닛 테스트. 컴포넌트 렌더링 없이 로직만 검증한다.
// 실행: npm run test (frontend 폴더에서)

import { describe, expect, it, vi } from 'vitest'
import type { GameEventRow } from './supabaseClient'

// App.tsx는 방문자 수 카운트를 위해 최상단에서 실제 Supabase 클라이언트를 생성한다(./supabaseClient).
// 테스트 환경엔 .env가 없어 그 생성이 실패하므로, 순수 함수만 테스트하는 이 파일에서는
// supabaseClient를 가짜로 대체해 import 시점의 부작용(createClient 호출)을 막는다.
vi.mock('./supabaseClient', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))

const { buildCalendarDays, categoryLabel, colorForGame, formatIsoDate, koreaDateString, mapRow } = await import(
  './App'
)

describe('koreaDateString', () => {
  it('UTC로는 자정을 안 넘겼어도 한국시간(UTC+9)으로는 이미 다음날일 수 있다', () => {
    // 2026-07-21T16:00:00Z = 한국시간 2026-07-22 01:00
    const utc = new Date('2026-07-21T16:00:00Z')
    expect(koreaDateString(utc)).toBe('2026-07-22')
  })

  it('한국시간 기준으로 아직 자정 전이면 그 전날 날짜를 반환한다', () => {
    // 2026-07-21T10:00:00Z = 한국시간 2026-07-21 19:00
    const utc = new Date('2026-07-21T10:00:00Z')
    expect(koreaDateString(utc)).toBe('2026-07-21')
  })
})

describe('formatIsoDate', () => {
  it('한 자리 월/일을 0으로 채운다', () => {
    expect(formatIsoDate(2026, 0, 5)).toBe('2026-01-05') // month는 0-indexed(1월)
  })

  it('두 자리 월/일은 그대로 나온다', () => {
    expect(formatIsoDate(2026, 11, 25)).toBe('2026-12-25')
  })
})

describe('buildCalendarDays', () => {
  it('항상 6주(42칸)를 채운다', () => {
    // 2026년 2월(28일, 평년) 처럼 짧은 달로 경계값을 확인
    const days = buildCalendarDays(2026, 1)
    expect(days).toHaveLength(42)
  })

  it('이번 달 날짜 수만큼 inCurrentMonth=true가 나온다', () => {
    const days = buildCalendarDays(2026, 6) // 2026년 7월 = 31일
    const inMonth = days.filter((d) => d.inCurrentMonth)
    expect(inMonth).toHaveLength(31)
    expect(inMonth[0].date.getDate()).toBe(1)
    expect(inMonth[inMonth.length - 1].date.getDate()).toBe(31)
  })

  it('앞뒤로 지난달/다음달 날짜가 채워진다', () => {
    const days = buildCalendarDays(2026, 6)
    const before = days.filter((d) => !d.inCurrentMonth && d.date.getMonth() === 5) // 6월(지난달)
    const after = days.filter((d) => !d.inCurrentMonth && d.date.getMonth() === 7) // 8월(다음달)
    expect(before.length + after.length).toBe(42 - 31)
  })
})

describe('categoryLabel', () => {
  it('알려진 카테고리는 한글 라벨로 바꾼다', () => {
    expect(categoryLabel('update')).toBe('업데이트')
    expect(categoryLabel('broadcast')).toBe('공식방송')
  })

  it('모르는 카테고리는 키를 그대로 돌려준다', () => {
    expect(categoryLabel('unknown_category')).toBe('unknown_category')
  })
})

describe('colorForGame', () => {
  it('같은 이름은 항상 같은 색을 반환한다', () => {
    expect(colorForGame('원신')).toBe(colorForGame('원신'))
  })

  it('색상 팔레트 안의 값만 반환한다', () => {
    const color = colorForGame('니케 승리의 여신')
    expect(color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('mapRow', () => {
  it('DB 행을 화면에서 쓰는 ScheduleItem 형태로 바꾼다', () => {
    const row: GameEventRow = {
      id: 42,
      event_date: '2026-07-30',
      title: '6.4 버전 업데이트',
      category: 'update',
      genre: '원신',
      note: null,
      source_url: null,
      verified: true,
      confidence: 'high',
    }
    expect(mapRow(row)).toEqual({
      id: '42',
      date: '2026-07-30',
      title: '6.4 버전 업데이트',
      category: 'update',
      game: '원신',
      note: null,
      sourceUrl: null,
      verified: true,
      confidence: 'high',
    })
  })

  it('genre가 없으면 game을 "기타"로 채운다', () => {
    const row: GameEventRow = {
      id: 1,
      event_date: '2026-07-30',
      title: '제목',
      category: 'update',
      genre: null,
      note: null,
      source_url: null,
      verified: null,
      confidence: null,
    }
    expect(mapRow(row).game).toBe('기타')
  })
})
