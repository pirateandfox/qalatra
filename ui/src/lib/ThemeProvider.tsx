import { createContext, useContext, useState, useEffect } from 'react'
import {
  type ThemeMode, type ThemeTokens, type TokenKey,
  loadThemeFromStorage, saveModeToStorage, saveOverridesToStorage,
  buildTokens, applyTokens, getSystemMode,
} from './theme'

interface ThemeContextValue {
  mode: ThemeMode
  effectiveMode: 'light' | 'dark'
  tokens: ThemeTokens
  setMode: (mode: ThemeMode) => void
  setToken: (key: TokenKey, value: string) => void
  resetOverrides: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => loadThemeFromStorage().mode)
  const [overrides, setOverrides] = useState<Partial<ThemeTokens>>(() => loadThemeFromStorage().overrides)

  // Track system preference as separate state, updated only via event listener
  const [systemMode, setSystemMode] = useState<'light' | 'dark'>(getSystemMode)

  // Listen for OS dark/light preference changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setSystemMode(getSystemMode())
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Derive effective mode from current state — no setState call needed
  const effectiveMode: 'light' | 'dark' = mode === 'system' ? systemMode : mode

  // Apply CSS tokens whenever effective mode or overrides change
  useEffect(() => {
    applyTokens(buildTokens(mode, overrides))
  }, [mode, overrides, systemMode])

  function setMode(newMode: ThemeMode) {
    saveModeToStorage(newMode)
    setModeState(newMode)
  }

  function setToken(key: TokenKey, value: string) {
    const newOverrides = { ...overrides, [key]: value }
    setOverrides(newOverrides)
    saveOverridesToStorage(newOverrides)
  }

  function resetOverrides() {
    setOverrides({})
    saveOverridesToStorage({})
  }

  const tokens = buildTokens(mode, overrides)

  return (
    <ThemeContext.Provider value={{ mode, effectiveMode, tokens, setMode, setToken, resetOverrides }}>
      {children}
    </ThemeContext.Provider>
  )
}
