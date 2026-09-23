import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'hosted' ? '/' : process.env.NODE_ENV === 'production' ? './' : '/',
  // Hosted publishing cannot accidentally inherit the free desktop gate setting.
  define: mode === 'hosted' ? { 'import.meta.env.VITE_QALATRA_ACCOUNT_AUTH': JSON.stringify('true') } : {},
  build: mode === 'hosted' ? { outDir: 'dist-hosted' } : {},
  resolve: {
    alias: {
      // Consume the shared core as source (bundled at build time). No npm link /
      // workspace install needed, so the desktop install + release pipeline is
      // unchanged.
      '@qalatra/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3456',
      '/logos': 'http://localhost:3456',
      '/favicon.svg': 'http://localhost:3456',
      '/complete': 'http://localhost:3456',
      '/complete-with-subtasks': 'http://localhost:3456',
      '/uncomplete': 'http://localhost:3456',
      '/snooze': 'http://localhost:3456',
      '/activate': 'http://localhost:3456',
      '/skip': 'http://localhost:3456',
      '/create-task-json': 'http://localhost:3456',
      '/update-title': 'http://localhost:3456',
      '/update-notes': 'http://localhost:3456',
      '/update-recurrence': 'http://localhost:3456',
      '/update-due-date': 'http://localhost:3456',
      '/add-link': 'http://localhost:3456',
      '/reorder': 'http://localhost:3456',
      '/create-subtask': 'http://localhost:3456',
    }
  }
}))
