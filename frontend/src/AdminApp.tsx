import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'

// 관리자 전용 화면. /admin 경로에서 렌더링된다 (src/main.tsx에서 pathname으로 분기).
// - 로그인: Supabase Auth (이메일/비밀번호). 관리자 한 명만 쓰므로 별도 가입 화면은 없음 —
//   Supabase 대시보드에서 미리 관리자 계정을 하나 만들어두고 그 계정으로 로그인한다.
// - 실행 이력(run_log)은 RLS로 이 관리자 이메일에게만 읽기가 허용되어 있다 (schema.sql 참고).
// - "강제 업데이트" 버튼은 이 프론트가 오라클 VM을 직접 부르지 않고, /api/admin/trigger-run
//   (Vercel 서버리스 함수)에 로그인 세션의 access_token을 실어 보낸다. 실제 인증/전달은 그 함수가 한다.

type RunLogRow = {
  id: number
  started_at: string
  finished_at: string | null
  status: string
  trigger_source: string
  games_processed: number | null
  error_message: string | null
  gemini_calls: number | null
}

// /api/admin/usage(→ 오라클 VM /usage → Tavily 공식 GET /usage)가 그대로 돌려주는 모양.
// 우리가 실제로 쓰는 필드만 옵셔널로 선언 — Tavily가 필드를 더 추가해도 깨지지 않는다.
type TavilyUsage = {
  key?: { usage?: number; limit?: number | null }
  account?: { current_plan?: string; plan_usage?: number; plan_limit?: number }
}

// Gemini는 구글이 API 키로 조회 가능한 공식 사용량 엔드포인트를 제공하지 않는다.
// 대신 run_log.gemini_calls(우리가 직접 센 호출 횟수)를, 구글의 실제 쿼터 리셋 기준인
// "태평양 시간(America/Los_Angeles) 자정"에 맞춰 "오늘" 몫만 합산해서 근사치로 보여준다.
export function pacificDateString(date: Date): string {
  // en-CA 로케일은 YYYY-MM-DD 형식을 그대로 내보내서 문자열 비교(같은 날인지)에 바로 쓸 수 있다.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date)
}

export function sumTodayGeminiCalls(
  runs: { started_at: string; gemini_calls: number | null }[],
  now: Date = new Date(),
): number {
  const today = pacificDateString(now)
  return runs
    .filter((r) => pacificDateString(new Date(r.started_at)) === today)
    .reduce((sum, r) => sum + (r.gemini_calls ?? 0), 0)
}

type GameOption = {
  id: number
  label: string
}

type ManualEventRow = {
  id: number
  event_date: string
  title: string
  category: string
  genre: string | null
  note: string | null
  source_url: string | null
}

// App.tsx의 CATEGORY_LABELS/CATEGORY_ORDER와 같은 값. 캘린더 카테고리가 이 4개로 고정돼 있어
// 별도 공용 모듈로 빼지 않고 그대로 둔다 — 카테고리를 늘릴 땐 두 파일 모두 확인.
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'update', label: '업데이트' },
  { value: 'pickup', label: '캐릭터 픽업' },
  { value: 'broadcast', label: '공식방송' },
  { value: 'launch', label: '신작출시' },
]

function formatDateTime(value: string | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString('ko-KR')
}

function AdminApp() {
  // 로그인 세션. null이면 로그인 폼을, 있으면 관리자 대시보드를 보여준다 (아래 return 문에서 분기).
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true) // 최초 세션 확인이 끝나기 전까지 깜빡임 방지용

  // 로그인 폼 상태
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)

  // "실행 이력" 패널 상태 (run_log 조회 결과)
  const [runs, setRuns] = useState<RunLogRow[]>([])
  const [runsError, setRunsError] = useState('')
  const [runsLoading, setRunsLoading] = useState(false)

  // "강제 업데이트" 버튼 상태
  const [triggering, setTriggering] = useState(false)
  const [triggerMessage, setTriggerMessage] = useState('')

  // "API 사용량" 패널 상태 (Tavily는 외부 API 응답 그대로, Gemini는 runs에서 계산하는 근사치)
  const [usage, setUsage] = useState<TavilyUsage | null>(null)
  const [usageError, setUsageError] = useState('')
  const [usageLoading, setUsageLoading] = useState(false)

  // "일정 직접 추가" 패널 상태: 게임 드롭다운 목록 + 지금까지 수동으로 추가한 일정(source='manual') 목록
  const [games, setGames] = useState<GameOption[]>([])
  const [manualEvents, setManualEvents] = useState<ManualEventRow[]>([])
  const [manualEventsError, setManualEventsError] = useState('')
  const [manualEventsLoading, setManualEventsLoading] = useState(false)

  // "일정 직접 추가" 폼 입력값들
  const [formGameId, setFormGameId] = useState('')
  const [formCategory, setFormCategory] = useState(CATEGORY_OPTIONS[0].value)
  const [formDate, setFormDate] = useState('')
  const [formTitle, setFormTitle] = useState('')
  const [formNote, setFormNote] = useState('')
  const [formSourceUrl, setFormSourceUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [addMessage, setAddMessage] = useState('')

  // 최초 마운트 시 기존 로그인 세션이 있는지 확인하고, 이후 로그인/로그아웃/토큰 갱신 등
  // 인증 상태가 바뀔 때마다 session을 갱신한다. onAuthStateChange 구독은 언마운트 시 해제한다.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => subscription.subscription.unsubscribe()
  }, [])

  // run_log 최근 30건 조회. RLS 정책상 로그인한 사용자의 이메일이 관리자 본인일 때만 읽힌다
  // (schema.sql의 "admin can read run_log" 정책 참고) — 여기 실패하면 대개 다른 이메일로 로그인한 경우다.
  const loadRuns = async () => {
    setRunsLoading(true)
    setRunsError('')

    const { data, error } = await supabase
      .from('run_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(30)

    if (error) {
      setRunsError(error.message)
    } else {
      setRuns((data ?? []) as RunLogRow[])
    }
    setRunsLoading(false)
  }

  // "일정 직접 추가" 폼의 게임 드롭다운용. 공개 캘린더(App.tsx)와 달리 여기는 로그인 세션으로
  // 직접 games 테이블을 조회한다(관리자 전용 화면이라 /api/games 캐시를 거칠 필요가 없음).
  const loadGames = async () => {
    const { data, error } = await supabase.from('games').select('id, name_ko, name_en').order('id')
    if (!error) {
      setGames(
        (data ?? []).map((g) => ({ id: g.id as number, label: (g.name_ko ?? g.name_en ?? `#${g.id}`) as string })),
      )
    }
  }

  // source='manual'인 행만 조회한다 — 자동 검색(source='search')이 채운 일정과 구분해서
  // "직접 추가한 일정" 목록에는 관리자가 손으로 넣은 것만 보이게 한다.
  const loadManualEvents = async () => {
    setManualEventsLoading(true)
    setManualEventsError('')

    const { data, error } = await supabase
      .from('game_events')
      .select('id, event_date, title, category, genre, note, source_url')
      .eq('source', 'manual')
      .order('event_date', { ascending: false })

    if (error) {
      setManualEventsError(error.message)
    } else {
      setManualEvents((data ?? []) as ManualEventRow[])
    }
    setManualEventsLoading(false)
  }

  // Tavily 사용량 조회. trigger-run.ts와 같은 패턴 — 로그인 세션의 access_token을 실어
  // /api/admin/usage(Vercel 서버리스 함수)에 보내면, 그 함수가 관리자 여부를 확인하고
  // Tailscale Funnel로 오라클 VM의 /usage(=Tavily 공식 GET /usage 프록시)를 대신 호출한다.
  const loadUsage = async () => {
    setUsageLoading(true)
    setUsageError('')
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) {
        throw new Error('로그인 세션이 만료됐습니다. 새로고침 후 다시 로그인해주세요.')
      }

      const response = await fetch('/api/admin/usage', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = (await response.json().catch(() => ({}))) as TavilyUsage & { error?: string }

      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }
      setUsage(body)
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : '요청에 실패했습니다.')
    } finally {
      setUsageLoading(false)
    }
  }

  // 로그인이 완료된 시점(session이 채워진 순간)에 대시보드에 필요한 데이터를 한꺼번에 불러온다.
  useEffect(() => {
    if (session) {
      loadRuns()
      loadGames()
      loadManualEvents()
      loadUsage()
    }
  }, [session])

  // Gemini는 공식 사용량 API가 없어서, 이미 불러온 run_log(runs)에서 태평양 시간 기준
  // "오늘" 실행분의 gemini_calls만 더해 근사치를 낸다. runs가 바뀔 때만 다시 계산한다.
  const todayGeminiCalls = useMemo(() => sumTodayGeminiCalls(runs), [runs])

  // "일정 직접 추가" 폼 제출. verified=true/confidence='high'로 고정해서 저장하는데, 관리자가
  // 직접 확인하고 넣는 정보라 자동 검색 결과처럼 별도 검증이 필요 없기 때문이다.
  const handleAddEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAddMessage('')

    if (!formGameId || !formDate || !formTitle.trim()) {
      setAddMessage('게임, 날짜, 제목은 필수입니다.')
      return
    }

    setAdding(true)
    const game = games.find((g) => String(g.id) === formGameId)

    const { error } = await supabase.from('game_events').insert({
      game_id: Number(formGameId),
      topic_id: null,
      event_date: formDate,
      title: formTitle.trim(),
      category: formCategory,
      genre: game?.label ?? null,
      note: formNote.trim() || null,
      source_url: formSourceUrl.trim() || null,
      verified: true,
      confidence: 'high',
      source: 'manual',
    })

    if (error) {
      setAddMessage(`추가 실패: ${error.message}`)
    } else {
      setAddMessage('일정을 추가했습니다.')
      setFormDate('')
      setFormTitle('')
      setFormNote('')
      setFormSourceUrl('')
      loadManualEvents()
    }
    setAdding(false)
  }

  // 서버 응답을 다시 조회하지 않고 로컬 상태에서 바로 제거한다 — 삭제 직후 목록이
  // 지연 없이 갱신되는 것처럼 보이게 하기 위함 (낙관적 업데이트에 가까운 처리).
  const handleDeleteManualEvent = async (id: number) => {
    const { error } = await supabase.from('game_events').delete().eq('id', id)
    if (error) {
      setManualEventsError(error.message)
    } else {
      setManualEvents((prev) => prev.filter((e) => e.id !== id))
    }
  }

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoginError('')
    setLoggingIn(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setLoginError(error.message)
    setLoggingIn(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
  }

  // "지금 검색 실행" 버튼 핸들러. 이 프론트는 오라클 VM을 직접 부르지 않고, 매번 최신 access_token을
  // 다시 받아서(만료 대비) /api/admin/trigger-run(Vercel 서버리스 함수)에 실어 보낸다. 그 함수가
  // 토큰 검증 → ADMIN_EMAILS 확인 → Tailscale Funnel로 오라클 VM 호출까지 대신 처리한다.
  // 실행은 백그라운드로 도니, 여기서는 "시작됐다"는 메시지만 보여주고 2초 후 실행 이력을 새로고침한다
  // (실제 완료까지는 몇 분 더 걸릴 수 있어, 그 사이엔 수동으로 "새로고침" 버튼을 눌러야 한다).
  const handleTrigger = async () => {
    setTriggering(true)
    setTriggerMessage('')
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) {
        throw new Error('로그인 세션이 만료됐습니다. 새로고침 후 다시 로그인해주세요.')
      }

      const response = await fetch('/api/admin/trigger-run', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }

      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }

      setTriggerMessage('실행을 시작했습니다. 몇 분 후 아래 실행 이력에서 결과를 확인하세요.')
      setTimeout(loadRuns, 2000)
    } catch (err) {
      setTriggerMessage(err instanceof Error ? err.message : '요청에 실패했습니다.')
    } finally {
      setTriggering(false)
    }
  }

  if (authLoading) {
    return (
      <div className="admin-shell">
        <p className="status-message">확인 중...</p>
      </div>
    )
  }

  // 로그인 안 된 상태: 이메일/비밀번호 폼만 보여준다. 회원가입 화면은 없음 —
  // 관리자 계정은 Supabase 대시보드(Authentication > Users)에서 미리 만들어둔다.
  if (!session) {
    return (
      <div className="admin-shell">
        <form className="admin-login" onSubmit={handleLogin}>
          <p className="eyebrow">Admin</p>
          <h2>관리자 로그인</h2>
          {loginError && <p className="status-message status-error">{loginError}</p>}
          <label>
            이메일
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" disabled={loggingIn}>
            {loggingIn ? '로그인 중...' : '로그인'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h2>게임 일정 검색 관리자</h2>
          <p className="admin-sub">{session.user.email}로 로그인됨</p>
        </div>
        <button type="button" className="admin-logout" onClick={handleLogout}>
          로그아웃
        </button>
      </header>

      {/* 패널 1: 강제 업데이트 (수동 트리거) */}
      <section className="admin-panel">
        <div className="admin-panel-header">
          <h3>강제 업데이트</h3>
          <button type="button" onClick={handleTrigger} disabled={triggering}>
            {triggering ? '실행 요청 중...' : '지금 검색 실행'}
          </button>
        </div>
        {triggerMessage && <p className="status-message">{triggerMessage}</p>}
      </section>

      {/* 패널 1.5: API 사용량 — Tavily는 공식 /usage 응답, Gemini는 우리가 직접 센 근사치 */}
      <section className="admin-panel">
        <div className="admin-panel-header">
          <h3>API 사용량</h3>
          <button type="button" onClick={loadUsage} disabled={usageLoading}>
            새로고침
          </button>
        </div>
        {usageError && <p className="status-message status-error">{usageError}</p>}
        {usageLoading && <p className="status-message">불러오는 중...</p>}

        <div className="admin-usage-cards">
          <div className="admin-usage-card">
            <p className="admin-usage-label">Tavily (이번 결제 주기)</p>
            {usage?.key ? (
              <p className="admin-usage-value">
                {usage.key.usage ?? '-'} / {usage.key.limit ?? '무제한'} 크레딧
              </p>
            ) : (
              !usageLoading && <p className="admin-usage-value">-</p>
            )}
            {usage?.account?.current_plan && (
              <p className="admin-usage-sub">
                플랜: {usage.account.current_plan} ({usage.account.plan_usage ?? '-'} / {usage.account.plan_limit ?? '-'})
              </p>
            )}
          </div>

          <div className="admin-usage-card">
            <p className="admin-usage-label">Gemini (오늘, 태평양 시간 기준 · 근사치)</p>
            <p className="admin-usage-value">{todayGeminiCalls}회</p>
            <p className="admin-usage-sub">구글 공식 쿼터 API가 없어 우리가 직접 센 호출 횟수입니다.</p>
          </div>
        </div>
      </section>

      {/* 패널 2: 일정 직접 추가 — 자동 검색이 놓친 일정을 수동 등록 + 지금까지 추가한 목록/삭제 */}
      <section className="admin-panel">
        <div className="admin-panel-header">
          <h3>일정 직접 추가</h3>
        </div>
        <p className="admin-panel-desc">
          검색으로 찾지 못했거나 급하게 추가해야 하는 일정을 직접 등록합니다. 여기서 추가한 일정은
          자동 검색이 다시 실행돼도 지워지지 않습니다.
        </p>
        <form className="admin-form" onSubmit={handleAddEvent}>
          <label>
            게임
            <select value={formGameId} onChange={(event) => setFormGameId(event.target.value)} required>
              <option value="">선택하세요</option>
              {games.map((game) => (
                <option key={game.id} value={game.id}>
                  {game.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            카테고리
            <select value={formCategory} onChange={(event) => setFormCategory(event.target.value)}>
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            날짜
            <input type="date" value={formDate} onChange={(event) => setFormDate(event.target.value)} required />
          </label>

          <label className="admin-form-wide">
            제목
            <input
              type="text"
              value={formTitle}
              onChange={(event) => setFormTitle(event.target.value)}
              placeholder="예: 6.4 버전 업데이트"
              required
            />
          </label>

          <label className="admin-form-wide">
            메모 (선택)
            <textarea value={formNote} onChange={(event) => setFormNote(event.target.value)} rows={2} />
          </label>

          <label className="admin-form-wide">
            출처 URL (선택)
            <input
              type="url"
              value={formSourceUrl}
              onChange={(event) => setFormSourceUrl(event.target.value)}
              placeholder="https://..."
            />
          </label>

          <button type="submit" className="admin-form-submit" disabled={adding}>
            {adding ? '추가하는 중...' : '일정 추가'}
          </button>
        </form>
        {addMessage && <p className="status-message">{addMessage}</p>}

        {manualEventsError && <p className="status-message status-error">{manualEventsError}</p>}
        {manualEventsLoading && <p className="status-message">불러오는 중...</p>}

        {manualEvents.length > 0 && (
          <table className="admin-table">
            <thead>
              <tr>
                <th>날짜</th>
                <th>게임</th>
                <th>카테고리</th>
                <th>제목</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {manualEvents.map((item) => (
                <tr key={item.id}>
                  <td>{item.event_date}</td>
                  <td>{item.genre ?? '-'}</td>
                  <td>{CATEGORY_OPTIONS.find((c) => c.value === item.category)?.label ?? item.category}</td>
                  <td>{item.title}</td>
                  <td>
                    <button type="button" className="admin-table-delete" onClick={() => handleDeleteManualEvent(item.id)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!manualEventsLoading && manualEvents.length === 0 && !manualEventsError && (
          <p className="status-message">직접 추가한 일정이 없습니다.</p>
        )}
      </section>

      {/* 패널 3: 실행 이력 — run_log 최근 30건 (성공/실패, 트리거 종류, 처리된 게임 수, 에러 메시지) */}
      <section className="admin-panel">
        <div className="admin-panel-header">
          <h3>실행 이력</h3>
          <button type="button" onClick={loadRuns} disabled={runsLoading}>
            새로고침
          </button>
        </div>
        {runsError && <p className="status-message status-error">{runsError}</p>}
        {runsLoading && <p className="status-message">불러오는 중...</p>}

        {runs.length > 0 && (
          <table className="admin-table">
            <thead>
              <tr>
                <th>시작</th>
                <th>종료</th>
                <th>상태</th>
                <th>트리거</th>
                <th>처리된 게임 수</th>
                <th>Gemini 호출</th>
                <th>에러</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{formatDateTime(run.started_at)}</td>
                  <td>{formatDateTime(run.finished_at)}</td>
                  <td>
                    <span className={`run-status run-status-${run.status}`}>{run.status}</span>
                  </td>
                  <td>{run.trigger_source}</td>
                  <td>{run.games_processed ?? '-'}</td>
                  <td>{run.gemini_calls ?? '-'}</td>
                  <td>{run.error_message ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!runsLoading && runs.length === 0 && !runsError && (
          <p className="status-message">실행 이력이 없습니다.</p>
        )}
      </section>
    </div>
  )
}

export default AdminApp
