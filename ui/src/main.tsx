import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadThemeFromStorage, buildTokens, applyTokens } from './lib/theme'

// Apply theme synchronously before first render to avoid flash
const { mode, overrides } = loadThemeFromStorage()
applyTokens(buildTokens(mode, overrides))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
