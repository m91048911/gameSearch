import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { GameEventRow } from './supabaseClient'

// ---- 타입 정의 -------------------------------------------------------

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

type CalendarDay = {
  date: Date
  inCurrentMonth: boolean
}

type LoadStatus = 'loading' | 'ready' | 'error'

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

function categoryLabel(key: string): string {
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

function colorForGame(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return GAME_COLOR_PALETTE[hash % GAME_COLOR_PALETTE.length]
}

// ---- 날짜 유틸 ---------------------------------------------------------

const formatIsoDate = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const buildCalendarDays = (year: number, month: number): CalendarDay[] => {
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

function mapRow(row: GameEventRow): ScheduleItem {
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
  const today = new Date()
  const [viewDate, setViewDate] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [items, setItems] = useState<ScheduleItem[]>([])
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [allGames, setAllGames] = useState<GameOption[]>([])

  const [selectedCategory, setSelectedCategory] = useState('all')
  const [selectedGame, setSelectedGame] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

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

  const visibleItems = useMemo(() => {
    return items
      .filter((item) => selectedCategory === 'all' || item.category === selectedCategory)
      .filter((item) => !selectedGame || item.game === selectedGame)
  }, [items, selectedCategory, selectedGame])

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

  useEffect(() => {
    if (selectedDate && selectedEvents.length === 0) {
      setSelectedDate(null)
    }
  }, [selectedDate, selectedEvents.length])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedDate(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const goPrevMonth = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
  const goNextMonth = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))
  const goToday = () => setViewDate(new Date(today.getFullYear(), today.getMonth(), 1))

  const upcoming = [...visibleItems]
    .filter((item) => item.date >= formatIsoDate(today.getFullYear(), today.getMonth(), today.getDate()))
    .sort((a, b) => a.date.localeCompare(b.date))[0]

  return (
    <div className="layout-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <p className="eyebrow">Game Schedule</p>

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
        </div>
      </aside>

      <main className="content">
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
              <span>등록된 게임</span>
              <strong>{games.length}</strong>
            </div>
            <div>
              <span>다음 일정</span>
              <strong>{upcoming?.title ?? '예정 없음'}</strong>
            </div>
          </div>
        </section>

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
