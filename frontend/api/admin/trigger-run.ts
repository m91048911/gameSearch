// POST /api/admin/trigger-run
//
// 관리자 페이지의 "강제 업데이트" 버튼이 호출하는 프록시 함수.
// 브라우저는 오라클 VM의 admin_server.py(FastAPI)를 직접 호출하지 않는다 — 이 함수가
// 1) 호출자의 Supabase 로그인 세션이 관리자 본인(ADMIN_EMAIL)인지 먼저 확인하고
// 2) 맞다면 ADMIN_API_SECRET을 실어서 Tailscale Funnel 주소로 admin_server.py의 /run을 대신 호출한다.
// ADMIN_API_SECRET과 TAILSCALE_FUNNEL_URL은 이 서버리스 함수 안에만 있고 브라우저에는 절대 노출되지 않는다.
//
// 요청: Authorization: Bearer <supabase access_token> 헤더 필요 (프론트에서 supabase.auth.getSession()으로 얻은 값)
//
// 필요 환경변수 (Vercel 프로젝트 설정에 등록):
//   SUPABASE_URL, SUPABASE_ANON_KEY  - 호출자 토큰 검증용
//   ADMIN_EMAIL                      - 관리자 본인 이메일
//   ADMIN_API_SECRET                 - admin_server.py와 공유하는 시크릿
//   TAILSCALE_FUNNEL_URL             - 예: https://<머신이름>.<tailnet>.ts.net (DEPLOY.md 참고)

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 지원합니다.' })
    return
  }

  const authHeader = req.headers.authorization
  const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null
  if (!accessToken) {
    res.status(401).json({ error: '로그인이 필요합니다.' })
    return
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
  const adminEmail = process.env.ADMIN_EMAIL
  const adminApiSecret = process.env.ADMIN_API_SECRET
  const funnelUrl = process.env.TAILSCALE_FUNNEL_URL

  if (!supabaseUrl || !supabaseAnonKey || !adminEmail || !adminApiSecret || !funnelUrl) {
    res.status(500).json({ error: '서버 환경변수(SUPABASE_URL/SUPABASE_ANON_KEY/ADMIN_EMAIL/ADMIN_API_SECRET/TAILSCALE_FUNNEL_URL)가 설정되지 않았습니다.' })
    return
  }

  // 호출자가 보낸 access token으로 실제 로그인된 사용자인지, 그리고 관리자 본인인지 확인한다.
  const supabase = createClient(supabaseUrl, supabaseAnonKey)
  const { data, error } = await supabase.auth.getUser(accessToken)

  if (error || !data.user) {
    res.status(401).json({ error: '유효하지 않은 로그인입니다.' })
    return
  }

  if (data.user.email !== adminEmail) {
    res.status(403).json({ error: '관리자만 사용할 수 있습니다.' })
    return
  }

  try {
    const response = await fetch(`${funnelUrl.replace(/\/+$/, '')}/run`, {
      method: 'POST',
      headers: { 'X-Admin-Secret': adminApiSecret },
    })
    const body = await response.json().catch(() => ({}))
    res.status(response.status).json(body)
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? `오라클 서버 호출 실패: ${err.message}` : '오라클 서버에 연결하지 못했습니다.',
    })
  }
}
