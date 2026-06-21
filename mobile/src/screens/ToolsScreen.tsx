import { StyleSheet, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { createBoxWebSession } from '@qalatra/shared'
import { useLoader } from '../lib/useLoader'
import { EmptyView, ErrorView, Loading } from '../components/ui'
import { colors } from '../theme'

/** The backend's "Box Web" tools surface, embedded in a WebView. The session URL
 *  is ticket-authenticated, so the WebView needs no bearer header. */
export function ToolsScreen() {
  const { data, loading, error, reload } = useLoader(() => createBoxWebSession())

  if (loading) return <Loading />
  if (error) return <ErrorView message={`Tools unavailable: ${error}`} onRetry={reload} />
  if (!data?.url) return <EmptyView message="No Tools configured for this backend." />

  return (
    <View style={styles.flex}>
      <WebView
        source={{ uri: data.url }}
        style={styles.flex}
        startInLoadingState
        renderLoading={() => <Loading />}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
})
