import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewNavigation } from 'react-native-webview'
import { createBoxWebSession, type BoxWebSession } from '@qalatra/shared'
import type { ToolsTabProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { EmptyView, ErrorView, Loading } from '../components/ui'
import { colors, space } from '../theme'

const URL_BRIDGE = `
(() => {
  const send = () => {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'qalatra-tools-url',
        url: window.location.href,
      }));
    } catch {}
  };
  const wrap = name => {
    const original = window.history[name];
    window.history[name] = function(...args) {
      const result = original.apply(this, args);
      setTimeout(send, 0);
      return result;
    };
  };
  wrap('pushState');
  wrap('replaceState');
  window.addEventListener('popstate', send);
  window.addEventListener('hashchange', send);
  send();
})();
true;
`

function remapSessionUrl(currentUrl: string | null, nextSession: BoxWebSession) {
  if (!currentUrl) return nextSession.url
  try {
    const current = new URL(currentUrl)
    const next = new URL(nextSession.url)
    const match = current.pathname.match(/^\/api\/box-web\/proxy\/[^/]+(\/.*)?$/)
    if (!match) return nextSession.url

    const basePath = next.pathname.replace(/\/$/, '')
    const suffix = match[1] || '/'
    next.pathname = suffix === '/' ? `${basePath}/` : `${basePath}${suffix}`
    next.search = current.search
    next.hash = current.hash
    return next.toString()
  } catch {
    return nextSession.url
  }
}

/** The backend's "Box Web" tools surface, embedded in a WebView. The session URL
 *  is ticket-authenticated, so the WebView needs no bearer header. */
export function ToolsScreen({ navigation }: ToolsTabProps) {
  const webViewRef = useRef<WebView>(null)
  const currentUrlRef = useRef<string | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { data, loading, refreshing, error, reload, refresh } = useLoader(() => createBoxWebSession())

  useEffect(() => {
    if (!data?.url) {
      setSourceUrl(null)
      return
    }
    setSourceUrl(remapSessionUrl(currentUrlRef.current, data))
  }, [data])

  const reconnect = useCallback(() => {
    setLoadError(null)
    void refresh()
  }, [refresh])

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    currentUrlRef.current = nav.url
  }, [])

  const onMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data)
      if (data?.type === 'qalatra-tools-url' && typeof data.url === 'string') {
        currentUrlRef.current = data.url
      }
    } catch {
      // Ignore messages not sent by the URL bridge.
    }
  }, [])

  useEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        sourceUrl ? (
          <Pressable
            accessibilityLabel="Reconnect Tools"
            accessibilityRole="button"
            disabled={loading || refreshing}
            hitSlop={10}
            onPress={reconnect}
          >
            <Text style={[styles.headerButton, (loading || refreshing) && styles.dim]}>
              {refreshing ? '…' : '↻'}
            </Text>
          </Pressable>
        ) : null,
    })
  }, [navigation, loading, reconnect, refreshing, sourceUrl])

  if (loading) return <Loading />
  if (error) return <ErrorView message={`Tools unavailable: ${error}`} onRetry={reload} />
  if (!data?.url) return <EmptyView message="No Tools configured for this backend." />
  if (!sourceUrl) return <Loading />
  if (loadError) return <ErrorView message={loadError} onRetry={reconnect} />

  return (
    <View style={styles.flex}>
      <WebView
        ref={webViewRef}
        source={{ uri: sourceUrl }}
        style={styles.flex}
        cacheEnabled={false}
        domStorageEnabled
        injectedJavaScript={URL_BRIDGE}
        onMessage={onMessage}
        onNavigationStateChange={onNavigationStateChange}
        onError={({ nativeEvent }) => {
          currentUrlRef.current = nativeEvent.url
          setLoadError(`Tools failed to load: ${nativeEvent.description || 'unknown error'}`)
        }}
        onHttpError={({ nativeEvent }) => {
          currentUrlRef.current = nativeEvent.url
          setLoadError(
            nativeEvent.statusCode === 401
              ? 'Tools session expired. Tap to reconnect and keep this path.'
              : `Tools request failed (HTTP ${nativeEvent.statusCode}).`,
          )
        }}
        startInLoadingState
        renderLoading={() => <Loading />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  headerButton: { color: colors.accent, fontSize: 24, fontWeight: '600', marginRight: space.md },
  dim: { opacity: 0.5 },
})
