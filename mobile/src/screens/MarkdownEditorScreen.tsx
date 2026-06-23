import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { currentServerInstance } from '@qalatra/shared'
import type { MarkdownEditorProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { ErrorView, Loading } from '../components/ui'
import { colors, space } from '../theme'

/** The full mdpdf markdown editor (CodeMirror source + paginated preview + PDF),
 *  reused verbatim from the desktop app inside a WebView. The server serves the
 *  self-contained editor bundle at /mdpdf; we inject the active backend's URL +
 *  token and the file path before it loads so its /api/files calls authenticate.
 *  Loading from the server origin keeps those calls same-origin. */
export function MarkdownEditorScreen({ route, navigation }: MarkdownEditorProps) {
  const { path, title } = route.params
  const { data: instance, loading, error, reload } = useLoader(() => currentServerInstance(), [])
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    navigation.setOptions({
      title: title ?? 'Editor',
      // Fallback close in case the in-page Close button's message doesn't fire.
      headerRight: () => (
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <Text style={styles.done}>Done</Text>
        </Pressable>
      ),
    })
  }, [navigation, title])

  if (loading) return <Loading />
  if (error || !instance) return <ErrorView message={error ?? 'No backend available'} onRetry={reload} />
  if (loadError) {
    return <ErrorView message={loadError} onRetry={() => { setLoadError(null); reload() }} />
  }

  const base = instance.url.replace(/\/$/, '')
  const config = { serverUrl: base, token: instance.token, path }
  const injected = `window.__QALATRA_MD__ = ${JSON.stringify(config)};\ntrue;`

  function onMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data)
      if (msg?.type === 'close') navigation.goBack()
      else if (msg?.type === 'error' && msg.message) setLoadError(`Editor error: ${msg.message}`)
    } catch {
      // Non-JSON messages from the page are ignored.
    }
  }

  return (
    <View style={styles.flex}>
      <WebView
        source={{ uri: `${base}/mdpdf` }}
        injectedJavaScriptBeforeContentLoaded={injected}
        onMessage={onMessage}
        originWhitelist={['*']}
        domStorageEnabled
        javaScriptEnabled
        keyboardDisplayRequiresUserAction={false}
        startInLoadingState
        renderLoading={() => <Loading />}
        onError={({ nativeEvent }) => setLoadError(`Editor failed to load: ${nativeEvent.description || 'unknown error'}`)}
        onHttpError={({ nativeEvent }) =>
          setLoadError(
            nativeEvent.statusCode === 404
              ? 'Editor bundle not found on this backend (HTTP 404). Deploy the server build that serves /mdpdf (git pull + restart), then retry.'
              : `Editor request failed (HTTP ${nativeEvent.statusCode}).`,
          )
        }
        style={styles.flex}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  done: { color: colors.accent, fontSize: 16, fontWeight: '600', marginRight: space.md },
})
