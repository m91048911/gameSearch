// GET /api/admin/usage
//
// 관리자 페이지의 "API 사용량" 패널이 호출하는 프록시 함수. trigger-run.ts와 완전히 같은 인증
// 패턴을 쓴다 — 브라우저는 오라클 VM을 직접 호출하지 않고, 이 함수가
// 1) 호출자의 Supabase 로그인 세션이 관리자 목록(ADMIN_EMAILS)에 있는지 먼저 확인하고
// 2) 맞다면 ADMIN_API_SECRET을 실어서 Tailscale Funnel 주소로 admin_server.py의 /usage를 대신 호출한다.
// admin_server.py의 /usage는 Tavily의 공식 GET /usage 응답을 그대로 돌려준다 (크레딧 사용량/한도).
// Gemini는 구글이 API 키로 조회 가능한 공식 사용량 엔드포인트를 제공하지 않아 포함되지 않는다 —
// 그쪽은 프론트(AdminApp.tsx)가 이미 불러온 run_log.gemini_calls로 근사치를 계산해서 보여준다.
//
// 요청: Authorization: Bearer <supabase access_token> 헤더 필요
//
// 필요 환경변수 (trigger-run.ts와 동일하게 Vercel 프로젝트 설정에 등록):
//   SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAILS, ADMIN_API_SECRET, TAILSCALE_FUNNEL_URL

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET만 지원합니다.' })
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
  const adminEmailsRaw = process.env.ADMIN_EMAILS
  const adminApiSecret = process.env.ADMIN_API_SECRET
  const funnelUrl = process.env.TAILSCALE_FUNNEL_URL

  if (!supabaseUrl || !supabaseAnonKey || !adminEmailsRaw || !adminApiSecret || !funnelUrl) {
    res.status(500).json({ error: '서버 환경변수(SUPABASE_URL/SUPABASE_ANON_KEY/ADMIN_EMAILS/ADMIN_API_SECRET/TAILSCALE_FUNNEL_URL)가 설정되지 않았습니다.' })
    return
  }

  const adminEmails = adminEmailsRaw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  const supabase = createClient(supabaseUrl, supabaseAnonKey)
  const { data, error } = await supabase.auth.getUser(accessToken)

  if (error || !data.user) {
    res.status(401).json({ error: '유효하지 않은 로그인입니다.' })
    return
  }

  if (!data.user.email || !adminEmails.includes(data.user.email.trim().toLowerCase())) {
    res.status(403).json({ error: '관리자만 사용할 수 있습니다.' })
    return
  }

  try {
    const response = await fetch(`${funnelUrl.replace(/\/+$/, '')}/usage`, {
      method: 'GET',
      headers: { 'X-Admin-Secret': adminApiSecret },
    })
    const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string }
    res.status(response.status).json({ ...body, error: body.error ?? body.detail })
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? `오라클 서버 호출 실패: ${err.message}` : '오라클 서버에 연결하지 못했습니다.',
    })
  }
}
