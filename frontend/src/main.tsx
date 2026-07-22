import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AdminApp from './AdminApp'
import './style.css'

// 별도 라우터 없이 pathname으로만 분기한다 (/admin이면 관리자 화면, 그 외에는 공개 캘린더).
// 정적 배포 환경에서 /admin으로 바로 접속해도 404가 나지 않도록 vercel.json에 SPA rewrite를 설정해뒀다.
const isAdminRoute = window.location.pathname.startsWith('/admin')

// StrictMode는 개발 모드에서만 각 effect를 두 번 실행시켜 정리(cleanup) 누락 같은 버그를
// 조기에 드러내준다 (프로덕션 빌드에는 영향 없음).
ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <StrictMode>{isAdminRoute ? <AdminApp /> : <App />}</StrictMode>,
)
