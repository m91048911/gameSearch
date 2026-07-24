import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase } from './supabaseClient'
import type { GameEventRow } from './supabaseClient'

// ---- 타입 정의 -------------------------------------------------------

// game_events 한 행(GameEventRow)을 화면에서 다루기 편한 형태로 매핑한 것.
// DB 컬럼명을 그대로 쓰지 않고 camelCase로 바꾸는 것도 겸한다 (sourceUrl 등).
type ScheduleItem = {
  id: string
  date: string // 'YYYY-MM-DD'
  title: string
  category: string // topics.calendar_category 값 (update / pickup / broadcast / launch ...)
  game: string // 게임 이름 (game_events.genre)
  note: string | null
  sourceUrl: string | null
  verified: boolean | null
  confidence: string | null
}

// 달력의 칸 하나. inCurrentMonth=false면 지난달/다음달에서 넘어온, 흐리게 표시되는 채움용 날짜다.
type CalendarDay = {
  date: Date
  inCurrentMonth: boolean
}

// /api/events 호출 상태. 화면 상단에 로딩 스피너 대신 상태 메시지를 보여주는 데 쓰인다.
type LoadStatus = 'loading' | 'ready' | 'error'

// /api/games가 돌려주는 게임 하나. games 테이블의 id + 표시용 이름(name_ko 우선)만 필요해서
// 이 정도로 단순화했다.
type GameOption = {
  id: number
  name: string
}

// ---- 상수 -------------------------------------------------------------

const weekdayLabels = ['일', '월', '화', '수', '목', '금', '토']

// 카테고리 키 -> 사람이 읽는 이름. 여기 없는 카테고리가 DB에 새로 생기면 키 값을 그대로 보여준다.
const CATEGORY_LABELS: Record<string, string> = {
  update: '업데이트',
  pickup: '캐릭터 픽업',
  broadcast: '공식방송',
  launch: '신작출시',
}

// 사이드바에 보여줄 선호 순서. 목록에 없는 카테고리는 뒤에 알파벳순으로 붙는다.
const CATEGORY_ORDER = ['update', 'pickup', 'broadcast', 'launch']

export function categoryLabel(key: string): string {
  return CATEGORY_LABELS[key] ?? key
}

// 게임 이름마다 항상 같은 색이 나오도록 이름을 해시해서 팔레트에서 고른다.
const GAME_COLOR_PALETTE = [
  '#6366f1', // indigo
  '#ec4899', // pink
  '#22c55e', // green
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#ef4444', // red
  '#0ea5e9', // sky
  '#84cc16', // lime
  '#f97316', // orange
]

// 방문자 수의 "오늘" 기준은 한국시간(Asia/Seoul) 자정이다 — schema.sql의 increment_site_visits()가
// 같은 기준으로 site_visits_daily 행을 나누므로, 클라이언트도 같은 기준으로 조회해야 같은 행을 가리킨다.
export function koreaDateString(date: Date): string {
  // en-CA 로케일은 YYYY-MM-DD 형식을 그대로 내보내서 DB의 date 컬럼과 문자열로 바로 비교할 수 있다.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date)
}

export function colorForGame(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return GAME_COLOR_PALETTE[hash % GAME_COLOR_PALETTE.length]
}

// ---- 날짜 유틸 ---------------------------------------------------------

export const formatIsoDate = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

export const buildCalendarDays = (year: number, month: number): CalendarDay[] => {
  const firstDayIndex = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const previousMonthDays = new Date(year, month, 0).getDate()
  const calendar: CalendarDay[] = []

  for (let i = firstDayIndex - 1; i >= 0; i -= 1) {
    calendar.push({ date: new Date(year, month - 1, previousMonthDays - i), inCurrentMonth: false })
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    calendar.push({ date: new Date(year, month, day), inCurrentMonth: true })
  }

  while (calendar.length < 42) {
    const nextDay = calendar.length - (firstDayIndex + daysInMonth) + 1
    calendar.push({ date: new Date(year, month + 1, nextDay), inCurrentMonth: false })
  }

  return calendar
}

export function mapRow(row: GameEventRow): ScheduleItem {
  return {
    id: String(row.id),
    date: row.event_date,
    title: row.title,
    category: row.category,
    game: row.genre ?? '기타',
    note: row.note,
    sourceUrl: row.source_url,
    verified: row.verified,
    confidence: row.confidence,
  }
}

// ---- 메인 컴포넌트 ------------------------------------------------------

function App() {
  const today = new Date() // "오늘" 배지, 기본 표시 월, "다음 일정" 계산의 기준점으로 계속 재사용된다.

  // 지금 화면에 보여주는 달(월 이동 버튼으로 바뀜). 항상 그 달의 1일로 고정해두면
  // buildCalendarDays(year, month) 계산이 단순해진다.
  const [viewDate, setViewDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [items, setItems] = useState<ScheduleItem[]>([]) // /api/events에서 받아온 전체 일정 (필터링 전)
  const [status, setStatus] = useState<LoadStatus>('loading') // /api/events 로딩 상태 (달력 위 안내 메시지용)
  const [errorMessage, setErrorMessage] = useState('')
  const [allGames, setAllGames] = useState<GameOption[]>([]) // /api/games에서 받아온 "수집 대상 게임 전체" 목록
  const [visitCount, setVisitCount] = useState<number | null>(null) // 왼쪽 사이드바 하단 "누적 방문" 표시용
  const [todayVisitCount, setTodayVisitCount] = useState<number | null>(null) // 같은 곳의 "오늘 방문" 표시용

  // 사이드바 필터 상태 3종. selectedCategory='all'이 기본(필터링 없음)이고,
  // selectedGame=null도 마찬가지로 "게임 필터 없음"을 의미한다.
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [selectedGame, setSelectedGame] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null) // 날짜 칸 클릭 시 열리는 상세 모달의 대상 날짜

  // 일정 데이터 로딩. 마운트 시 한 번만 호출한다(뒤로가기/새로고침 없이는 서버 재조회 안 함).
  // cancelled 플래그로, 컴포넌트가 언마운트된 뒤에 응답이 늦게 와도 setState를 안 하게 막는다
  // (React의 "unmounted component에 state 업데이트" 경고 방지).
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setStatus('loading')
      try {
        const response = await fetch('/api/events')
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `HTTP ${response.status}`)
        }
        const { events } = (await response.json()) as { events: GameEventRow[] }

        if (cancelled) return
        setItems(events.map(mapRow))
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setErrorMessage(err instanceof Error ? err.message : String(err))
        setStatus('error')
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  // 게임 목록은 별도의 병렬 요청으로 가져온다. /api/events와 굳이 하나로 합치지 않은 이유는,
  // 이벤트가 하나도 없는 게임도 "게임별 보기"에는 계속 나와야 해서 games 테이블을 직접 조회하는
  // 별개의 엔드포인트(/api/games)가 필요했기 때문이다.
  useEffect(() => {
    let cancelled = false

    const loadGames = async () => {
      try {
        const response = await fetch('/api/games')
        if (!response.ok) return
        const { games } = (await response.json()) as { games: GameOption[] }
        if (!cancelled) setAllGames(games)
      } catch {
        // 게임 목록은 부가 정보라 실패해도 달력 자체는 계속 동작해야 하니 조용히 무시한다.
      }
    }

    loadGames()
    return () => {
      cancelled = true
    }
  }, [])

  // 방문자 수(오늘/누적). sessionStorage로 "이 브라우저 세션에서 이미 세었는지"만 구분해, 새로고침이나
  // 뒤로가기로 같은 방문자가 중복 카운트되지 않게 한다(탭/브라우저를 새로 열면 다시 센다).
  // 이미 센 세션이면 증가시키지 않고 현재 값만 읽어와서, 화면엔 항상 최신 값이 보이게 한다.
  // 장식성 지표라 실패해도 조용히 무시하고 달력 기능에는 영향을 주지 않는다.
  useEffect(() => {
    let cancelled = false
    const SESSION_KEY = 'gs_visit_counted'

    const trackVisit = async () => {
      try {
        if (sessionStorage.getItem(SESSION_KEY)) {
          const today = koreaDateString(new Date())
          const [totalRes, todayRes] = await Promise.all([
            supabase.from('site_visits').select('count').eq('id', 1).single(),
            supabase.from('site_visits_daily').select('count').eq('visit_date', today).maybeSingle(),
          ])
          if (cancelled) return
          if (!totalRes.error && totalRes.data) setVisitCount(totalRes.data.count as number)
          if (!todayRes.error) setTodayVisitCount((todayRes.data?.count as number | undefined) ?? 0)
        } else {
          // increment_site_visits()는 table(total, today)를 반환하므로 supabase-js에서는 행 배열로 온다.
          const { data, error } = await supabase.rpc('increment_site_visits')
          const row = data?.[0] as { total: number; today: number } | undefined
          if (!error && row) {
            if (!cancelled) {
              setVisitCount(row.total)
              setTodayVisitCount(row.today)
            }
            sessionStorage.setItem(SESSION_KEY, '1')
          }
        }
      } catch {
        // 무시 — 방문자 수는 없어도 캘린더 기능에는 지장 없다.
      }
    }

    trackVisit()
    return () => {
      cancelled = true
    }
  }, [])

  // 사이드바 카테고리 목록. 실제 데이터에 등장하는 카테고리만 보여주고(빈 카테고리는 안 보임),
  // 'all'을 맨 앞에 고정한 뒤 CATEGORY_ORDER 순서대로, 목록에 없는 새 카테고리는 뒤에 알파벳순으로 붙인다.
  const categories = useMemo(() => {
    const found = new Set(items.map((item) => item.category))
    const ordered = CATEGORY_ORDER.filter((key) => found.has(key))
    const rest = Array.from(found)
      .filter((key) => !CATEGORY_ORDER.includes(key))
      .sort((a, b) => a.localeCompare(b))
    return ['all', ...ordered, ...rest]
  }, [items])

  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()

  // 이벤트가 하나도 없는 게임도 계속 목록에 보이도록, game_events가 아니라 games 테이블(/api/games)
  // 에서 가져온 전체 목록을 기준으로 삼는다. 아직 로딩 전이거나 실패했을 때는 지금까지 불러온
  // 이벤트에 등장하는 게임 이름만이라도 보여준다 (완전히 빈 화면보다는 낫다).
  const games = useMemo(() => {
    if (allGames.length > 0) {
      return allGames.map((g) => g.name)
    }
    const found = new Set(items.map((item) => item.game))
    return Array.from(found).sort((a, b) => a.localeCompare(b, 'ko'))
  }, [allGames, items])

  // 지금 보고 있는 달 + 선택된 카테고리 기준으로, 게임별 이벤트 개수를 세서 legend 배지에 쓴다.
  // (게임 필터 자체는 여기 반영하지 않는다 — 그래야 다른 게임을 눌러도 내 게임의 배지 숫자가 안 바뀐다.)
  const gameCountsInView = useMemo(() => {
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
    const counts: Record<string, number> = {}
    for (const item of items) {
      if (selectedCategory !== 'all' && item.category !== selectedCategory) continue
      if (!item.date.startsWith(monthPrefix)) continue
      counts[item.game] = (counts[item.game] ?? 0) + 1
    }
    return counts
  }, [items, selectedCategory, year, month])

  // 카테고리 + 게임 필터를 둘 다 적용한 최종 목록. 달력에 실제로 그려지는 건 전부 이 값 기준이다.
  const visibleItems = useMemo(() => {
    return items
      .filter((item) => selectedCategory === 'all' || item.category === selectedCategory)
      .filter((item) => !selectedGame || item.game === selectedGame)
  }, [items, selectedCategory, selectedGame])

  // 날짜별로 묶어둬야 달력 칸을 그릴 때마다 매번 배열 전체를 훑지 않고 O(1)로 조회할 수 있다.
  const eventsByDate = useMemo(() => {
    const map: Record<string, ScheduleItem[]> = {}
    for (const item of visibleItems) {
      if (!map[item.date]) map[item.date] = []
      map[item.date].push(item)
    }
    return map
  }, [visibleItems])

  const calendarDays = useMemo(() => buildCalendarDays(year, month), [year, month])
  const monthTitle = `${year}년 ${month + 1}월`

  const selectedEvents = selectedDate ? (eventsByDate[selectedDate] ?? []) : []
  const selectedDateLabel = selectedDate ? selectedDate.replaceAll('-', '.') : ''

  // 상세 모달이 열려있는 상태에서 필터를 바꿔서 그 날짜에 더 이상 보여줄 일정이 없어지면,
  // 빈 모달이 뜬 채로 남지 않도록 자동으로 닫는다.
  useEffect(() => {
    if (selectedDate && selectedEvents.length === 0) {
      setSelectedDate(null)
    }
  }, [selectedDate, selectedEvents.length])

  // Esc 키로 상세 모달을 닫을 수 있게 하는 전역 키보드 리스너. 모달이 열려있을 때만 동작해도 되지만,
  // selectedDate가 null이면 setSelectedDate(null)이 아무 효과가 없으니 조건 분기 없이 그냥 둬도 안전하다.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedDate(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // 월 이동 버튼 3개. viewDate는 항상 "그 달의 1일"로 유지해서 buildCalendarDays 계산이 어긋나지 않게 한다.
  const goPrevMonth = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
  const goNextMonth = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))
  const goToday = () => setViewDate(new Date(today.getFullYear(), today.getMonth(), 1))

  const todayIso = formatIsoDate(today.getFullYear(), today.getMonth(), today.getDate())

  // 상단 "오늘 일정" 카드에 쓸 값. 현재 필터(visibleItems) 기준으로 날짜가 오늘인 것만 센다.
  const todayItems = visibleItems.filter((item) => item.date === todayIso)

  // 상단 "다음 일정" 카드에 쓸 값. 오늘 일정과 겹치지 않도록, 오늘보다 뒤(오늘 제외)인 일정 중
  // 가장 가까운 것 하나만 뽑는다.
  const upcoming = [...visibleItems].filter((item) => item.date > todayIso).sort((a, b) => a.date.localeCompare(b.date))[0]

  return (
    <div className="layout-shell">
      {/* 왼쪽 사이드바: 카테고리 필터 + 게임별 필터 + 현재 필터 요약 카드 */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <p className="eyebrow">Game Schedule</p>

          {/* 카테고리 필터 버튼들. 'all'은 필터 없음을 의미하고 항상 맨 앞에 고정된다. */}
          <nav className="menu-list" aria-label="카테고리 필터">
            {categories.map((key) => (
              <button
                key={key}
                type="button"
                className={key === selectedCategory ? 'menu-item active' : 'menu-item'}
                onClick={() => setSelectedCategory(key)}
              >
                <strong>{key === 'all' ? '전체일정' : categoryLabel(key)}</strong>
                <span>
                  {key === 'all'
                    ? '모든 게임의 모든 일정'
                    : `${items.filter((item) => item.category === key).length}건 등록됨`}
                </span>
              </button>
            ))}
          </nav>

          {/* 게임별 필터. 클릭하면 토글(같은 게임 다시 클릭 시 필터 해제)되고, 배지 숫자는
              gameCountsInView(이번 달 + 현재 카테고리 기준 개수)를 그대로 쓴다. */}
          {games.length > 0 && (
            <div className="game-legend" aria-label="게임별 필터">
              <p className="legend-title">게임별 보기</p>
              <div className="legend-chips">
                {games.map((game) => {
                  const count = gameCountsInView[game] ?? 0
                  return (
                    <button
                      key={game}
                      type="button"
                      className={game === selectedGame ? 'legend-chip active' : 'legend-chip'}
                      style={{ '--chip-color': colorForGame(game) } as CSSProperties}
                      onClick={() => setSelectedGame((cur) => (cur === game ? null : game))}
                    >
                      <span className="legend-dot" />
                      {game}
                      {count > 0 && <span className="legend-count">{count}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="sidebar-card">
          <span>표시 중인 일정</span>
          <strong>{visibleItems.length}건</strong>
          <p>
            {selectedCategory === 'all' ? '전체일정' : categoryLabel(selectedCategory)}
            {selectedGame ? ` · ${selectedGame}` : ''} 기준으로 달력이 필터링됩니다.
          </p>
          {(visitCount !== null || todayVisitCount !== null) && (
            <p className="visitor-count">
              오늘 {(todayVisitCount ?? 0).toLocaleString()}회 · 누적 {(visitCount ?? 0).toLocaleString()}회
            </p>
          )}
        </div>
      </aside>

      <main className="content">
        {/* 상단 요약 배너: 이번 달 타이틀 + 전체/게임 수/다음 일정 통계 3종 */}
        <section className="hero-panel">
          <div>
            <p className="eyebrow">Monthly Overview</p>
            <h2>{monthTitle}</h2>
            <p className="hero-copy">
              게임별 버전 업데이트, 캐릭터 픽업, 공식방송 일정을 한 달력에서 확인하세요. 왼쪽에서 카테고리나
              게임을 선택하면 달력이 바로 필터링됩니다.
            </p>
          </div>

          <div className="hero-stats">
            <div>
              <span>전체 일정</span>
              <strong>{items.length}</strong>
            </div>
            <div>
              <span>오늘 일정</span>
              <strong>{todayItems.length}건</strong>
            </div>
            <div>
              <span>다음 일정</span>
              <strong>{upcoming?.title ?? '예정 없음'}</strong>
            </div>
          </div>
        </section>

        {/* 월간 캘린더 본체. 항상 6주(42칸)를 그려서 달마다 레이아웃 높이가 흔들리지 않게 한다. */}
        <section className="calendar-panel">
          <div className="calendar-header">
            <div>
              <h3>일정 달력</h3>
              <p>
                {selectedCategory === 'all' ? '모든 카테고리' : categoryLabel(selectedCategory)}
                {selectedGame ? ` · ${selectedGame}` : ''}
              </p>
            </div>
            <div className="month-nav">
              <button type="button" onClick={goPrevMonth} aria-label="이전 달">
                ‹
              </button>
              <button type="button" className="month-nav-today" onClick={goToday}>
                오늘
              </button>
              <button type="button" onClick={goNextMonth} aria-label="다음 달">
                ›
              </button>
            </div>
          </div>

          {status === 'error' && (
            <p className="status-message status-error">
              데이터를 불러오지 못했습니다: {errorMessage}. /api/events가 정상 배포됐는지, Vercel의
              SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 설정됐는지 확인하세요.
            </p>
          )}
          {status === 'loading' && <p className="status-message">일정을 불러오는 중...</p>}
          {status === 'ready' && items.length === 0 && (
            <p className="status-message">아직 game_events 테이블에 저장된 일정이 없습니다.</p>
          )}

          <div className="calendar-grid calendar-weekdays">
            {weekdayLabels.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div className="calendar-grid calendar-days">
            {calendarDays.map(({ date, inCurrentMonth }) => {
              const isoDate = formatIsoDate(date.getFullYear(), date.getMonth(), date.getDate())
              const dayEvents = eventsByDate[isoDate] ?? []
              const isToday =
                date.getFullYear() === today.getFullYear() &&
                date.getMonth() === today.getMonth() &&
                date.getDate() === today.getDate()

              return (
                <article
                  key={isoDate}
                  className={[
                    'calendar-cell',
                    inCurrentMonth ? '' : 'muted',
                    isToday ? 'today' : '',
                    dayEvents.length > 0 ? 'has-event' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {dayEvents.length > 0 ? (
                    <button type="button" className="calendar-cell-trigger" onClick={() => setSelectedDate(isoDate)}>
                      <div className="calendar-date-row">
                        <span className="calendar-date">{date.getDate()}</span>
                        <span className="event-badge">{dayEvents.length}</span>
                      </div>

                      <div className="calendar-events">
                        {dayEvents.slice(0, 2).map((item) => (
                          <div key={item.id} className="event-chip" style={{ borderLeftColor: colorForGame(item.game) }}>
                            <strong>{item.title}</strong>
                            <span>{item.game}</span>
                          </div>
                        ))}
                        {dayEvents.length > 2 ? <span className="more-events">+{dayEvents.length - 2} more</span> : null}
                      </div>
                    </button>
                  ) : (
                    <div className="calendar-cell-content">
                      <div className="calendar-date-row">
                        <span className="calendar-date">{date.getDate()}</span>
                      </div>
                      <div className="calendar-events" />
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </section>
      </main>

      {/* 날짜 칸 클릭 시 뜨는 상세 모달. 배경 클릭/Esc로 닫히고, 모달 내부 클릭은
          stopPropagation으로 배경 클릭 핸들러까지 안 번지게 막는다. */}
      {selectedEvents.length > 0 ? (
        <div className="modal-backdrop" onClick={() => setSelectedDate(null)} role="presentation">
          <section
            className="schedule-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="schedule-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Schedule Detail</p>
                <h3 id="schedule-modal-title">{selectedDateLabel} 일정</h3>
              </div>
              <button type="button" className="modal-close" aria-label="상세 일정 닫기" onClick={() => setSelectedDate(null)}>
                닫기
              </button>
            </div>

            <div className="modal-list">
              {selectedEvents.map((item) => (
                <article key={item.id} className="modal-item" style={{ borderLeftColor: colorForGame(item.game) }}>
                  <div className="modal-item-main">
                    <div className="modal-item-tags">
                      <span className="game-dot" style={{ backgroundColor: colorForGame(item.game) }} />
                      <span className="modal-game">{item.game}</span>
                      <span className="modal-category">{categoryLabel(item.category)}</span>
                      {item.verified === true && <span className="verify-badge verify-true">확인됨</span>}
                      {item.verified === false && <span className="verify-badge verify-false">미확인</span>}
                    </div>
                    <h4>{item.title}</h4>
                    {item.note && <p className="modal-note">{item.note}</p>}
                    {item.sourceUrl && (
                      <a className="modal-source" href={item.sourceUrl} target="_blank" rel="noreferrer">
                        출처 보기 ↗
                      </a>
                    )}
                  </div>
                  <div className="schedule-meta">
                    <span>{item.date.replaceAll('-', '.')}</span>
                    {item.confidence && <span className="confidence-label">신뢰도: {item.confidence}</span>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

export default App
