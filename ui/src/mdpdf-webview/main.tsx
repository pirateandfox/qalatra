// Standalone entry that mounts ONLY the markdown editor (mdpdf MdView) for use
// inside a React Native WebView on mobile/iPad. It reuses the exact desktop
// editor — CodeMirror + paginated preview + PDF — because that machinery is
// inherently web and not worth rebuilding natively.
//
// The host RN screen injects `window.__QALATRA_MD__ = { serverUrl, token, path }`
// before this loads (injectedJavaScriptBeforeContentLoaded). We seed a single
// Qalatra instance from that config so the shared API client (readTextFile /
// writeTextFile → /api/files) is authenticated, then render MdView for the file.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setActiveInstance, upsertInstance } from '../api' // side effect: configures platform (localStorage)
import MdView from '../mdpdf/MdView'
import { applyTokens, buildTokens, loadThemeFromStorage } from '../lib/theme'
import '../index.css'

declare global {
  interface Window {
    __QALATRA_MD__?: { serverUrl: string; token: string; path: string }
    ReactNativeWebView?: { postMessage: (msg: string) => void }
  }
}

const cfg = window.__QALATRA_MD__ ?? { serverUrl: '', token: '', path: '' }

// Seed the single backend this WebView talks to (same origin it was served from).
if (cfg.token) {
  const instance = upsertInstance({ id: 'webview', name: 'Qalatra', url: cfg.serverUrl, token: cfg.token })
  setActiveInstance(instance.id)
}

// Apply theme tokens so MdView.css var(--…) references resolve (defaults in a
// fresh WebView; no persisted overrides).
const { mode, overrides } = loadThemeFromStorage()
applyTokens(buildTokens(mode, overrides))

/** Tell the RN host about lifecycle events it may act on (e.g. close → goBack). */
function notify(type: string, message?: string) {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type, message }))
}

// Surface page-level failures to the RN host so a render/API error shows a real
// message instead of a blank WebView during testing.
window.addEventListener('error', e => notify('error', e.message || String(e.error)))
window.addEventListener('unhandledrejection', e => notify('error', String(e.reason?.message ?? e.reason)))

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <MdView
        filePath={cfg.path}
        onClose={() => notify('close')}
        terminalOpen={false}
        onTerminalToggle={() => {}}
        onChatWithDoc={() => {}}
      />
    </StrictMode>,
  )
} catch (err) {
  notify('error', err instanceof Error ? err.message : String(err))
}
