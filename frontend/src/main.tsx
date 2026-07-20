import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AdminApp from './AdminApp'
import './style.css'

// 별도 라우터 없이 pathname으로만 분기한다 (/admin이면 관리자 화면, 그 외에는 공개 캘린더).
// 정적 배포 환경에서 /admin으로 바로 접속해도 404가 나지 않도록 vercel.json에 SPA rewrite를 설정해뒀다.
const isAdminRoute = window.location.pathname.startsWith('/admin')

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <StrictMode>{isAdminRoute ? <AdminApp /> : <App />}</StrictMode>,
)
