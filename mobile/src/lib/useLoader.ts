import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Generic async loader with loading / refreshing / error state. Pass a stable
 * `deps` array to re-run when inputs change. The loader itself is read through a
 * ref so callers don't have to memoize it.
 */
export function useLoader<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const run = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true)
    try {
      setError(null)
      setData(await loaderRef.current())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void run(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return {
    data,
    loading,
    refreshing,
    error,
    reload: useCallback(() => run(false), [run]),
    refresh: useCallback(() => run(true), [run]),
  }
}
