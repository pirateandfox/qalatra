import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native'
import { WebView } from 'react-native-webview'
import { createTerminalSession, currentServerInstance, listTerminalSessions, terminalSocketUrl } from '@qalatra/shared'
import type { TerminalProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { ErrorView, Loading } from '../components/ui'
import { colors } from '../theme'

/** A real shell on the backend, in a WebView. The pty is server-side (tmux over a
 *  WebSocket); we reuse a running session (or create one), compute its
 *  token-bearing socket URL, and hand it to the xterm bundle served at /terminal.
 *  Loading from the server origin keeps the WebSocket same-origin. */
export function TerminalScreen({ navigation }: TerminalProps) {
  const { data, loading, error, reload } = useLoader(async () => {
    const inst = await currentServerInstance()
    const status = await listTerminalSessions()
    if (!status.tmux?.ok) {
      throw new Error(status.tmux?.error || 'tmux is required on the backend for terminals.')
    }
    let session = status.sessions.find(s => s.status === 'running') ?? status.sessions[0]
    if (!session) session = await createTerminalSession({ title: 'Mobile' })
    const wsUrl = await terminalSocketUrl(session.id, 80, 24)
    return { base: inst.url.replace(/\/$/, ''), wsUrl, title: session.title }
  }, [])

  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (data?.title) navigation.setOptions({ title: data.title })
  }, [navigation, data?.title])

  if (loading) return <Loading />
  if (error || !data) return <ErrorView message={error ?? 'No terminal available'} onRetry={reload} />
  if (loadError) return <ErrorView message={loadError} onRetry={() => { setLoadError(null); reload() }} />

  const injected = `window.__QALATRA_TERM__ = ${JSON.stringify({ wsUrl: data.wsUrl })};\ntrue;`

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <WebView
        source={{ uri: `${data.base}/terminal` }}
        injectedJavaScriptBeforeContentLoaded={injected}
        originWhitelist={['*']}
        javaScriptEnabled
        keyboardDisplayRequiresUserAction={false}
        startInLoadingState
        renderLoading={() => <Loading />}
        onError={({ nativeEvent }) => setLoadError(`Terminal failed to load: ${nativeEvent.description || 'unknown error'}`)}
        onHttpError={({ nativeEvent }) =>
          setLoadError(
            nativeEvent.statusCode === 401 || nativeEvent.statusCode === 404
              ? 'Terminal not found on this backend (the /terminal route). Deploy the server build that serves it (git pull + restart on the box), then retry.'
              : `Terminal request failed (HTTP ${nativeEvent.statusCode}).`,
          )
        }
        style={styles.flex}
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
})
