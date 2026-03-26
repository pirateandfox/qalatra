import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.NODE_ENV === 'production' ? './' : '/',
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
})
