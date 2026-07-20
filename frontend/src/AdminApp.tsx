import { useEffect, useState, type FormEvent } from 'react'
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
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)

  const [runs, setRuns] = useState<RunLogRow[]>([])
  const [runsError, setRunsError] = useState('')
  const [runsLoading, setRunsLoading] = useState(false)

  const [triggering, setTriggering] = useState(false)
  const [triggerMessage, setTriggerMessage] = useState('')

  const [games, setGames] = useState<GameOption[]>([])
  const [manualEvents, setManualEvents] = useState<ManualEventRow[]>([])
  const [manualEventsError, setManualEventsError] = useState('')
  const [manualEventsLoading, setManualEventsLoading] = useState(false)

  const [formGameId, setFormGameId] = useState('')
  const [formCategory, setFormCategory] = useState(CATEGORY_OPTIONS[0].value)
  const [formDate, setFormDate] = useState('')
  const [formTitle, setFormTitle] = useState('')
  const [formNote, setFormNote] = useState('')
  const [formSourceUrl, setFormSourceUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [addMessage, setAddMessage] = useState('')

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

  const loadGames = async () => {
    const { data, error } = await supabase.from('games').select('id, name_ko, name_en').order('id')
    if (!error) {
      setGames(
        (data ?? []).map((g) => ({ id: g.id as number, label: (g.name_ko ?? g.name_en ?? `#${g.id}`) as string })),
      )
    }
  }

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

  useEffect(() => {
    if (session) {
      loadRuns()
      loadGames()
      loadManualEvents()
    }
  }, [session])

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

      <section className="admin-panel">
        <div className="admin-panel-header">
          <h3>강제 업데이트</h3>
          <button type="button" onClick={handleTrigger} disabled={triggering}>
            {triggering ? '실행 요청 중...' : '지금 검색 실행'}
          </button>
        </div>
        {triggerMessage && <p className="status-message">{triggerMessage}</p>}
      </section>

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
