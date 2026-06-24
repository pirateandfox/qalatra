import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native'
import { WebView } from 'react-native-webview'
import { currentServerInstance, terminalSocketUrl } from '@qalatra/shared'
import type { TerminalSessionProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { ErrorView, Loading } from '../components/ui'
import { colors } from '../theme'

/** A single backend shell in a WebView. The pty is server-side (tmux over a
 *  WebSocket); we compute the chosen session's token-bearing socket URL and hand
 *  it to the xterm bundle served at /terminal. */
export function TerminalSessionScreen({ route, navigation }: TerminalSessionProps) {
  const { sessionId, title } = route.params
  const { data, loading, error, reload } = useLoader(async () => {
    const inst = await currentServerInstance()
    const wsUrl = await terminalSocketUrl(sessionId, 80, 24)
    return { base: inst.url.replace(/\/$/, ''), wsUrl }
  }, [sessionId])
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (title) navigation.setOptions({ title })
  }, [navigation, title])

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
