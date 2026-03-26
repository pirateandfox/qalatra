import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { fetchContexts, type Context } from '../api'
import { CONTEXT_COLORS, CONTEXT_LABELS } from './constants'

interface ContextsValue {
  contexts: Context[]
  getColor: (slug: string) => string
  getLabel: (slug: string) => string
  refresh: () => void
}

const Ctx = createContext<ContextsValue>({
  contexts: [],
  getColor: slug => CONTEXT_COLORS[slug] ?? '#888888',
  getLabel: slug => CONTEXT_LABELS[slug] ?? slug,
  refresh: () => {},
})

export function ContextsProvider({ children }: { children: ReactNode }) {
  const [contexts, setContexts] = useState<Context[]>([])

  const load = useCallback(() => {
    fetchContexts().then(setContexts).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  function getColor(slug: string) {
    return contexts.find(c => c.slug === slug)?.color ?? CONTEXT_COLORS[slug] ?? '#888888'
  }

  function getLabel(slug: string) {
    return contexts.find(c => c.slug === slug)?.label ?? CONTEXT_LABELS[slug] ?? slug
  }

  return (
    <Ctx.Provider value={{ contexts, getColor, getLabel, refresh: load }}>
      {children}
    </Ctx.Provider>
  )
}

export function useContexts() {
  return useContext(Ctx)
}
