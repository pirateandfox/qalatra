// Minimal synchronous pub/sub. Replaces the `window` CustomEvent mechanism the
// desktop UI used for instance-config change notifications, so the shared core
// has no DOM dependency. Works identically on web and React Native.

export type Listener = () => void

export interface Emitter {
  /** Subscribe; returns an unsubscribe function. */
  on(listener: Listener): () => void
  /** Notify all current listeners. */
  emit(): void
}

export function createEmitter(): Emitter {
  const listeners = new Set<Listener>()
  return {
    on(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit() {
      // Snapshot so a listener that unsubscribes mid-emit doesn't skip others.
      for (const listener of [...listeners]) listener()
    },
  }
}
