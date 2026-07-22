import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// vite.config.ts(빌드용)와 분리해서 둔다 — 여기서는 DOM 렌더링 없이 순수 함수만 테스트하므로
// environment는 'node'로 충분하다.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
  },
})
