import { useEffect } from 'react'
import { ScrollView, StyleSheet } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { readTextFile } from '@qalatra/shared'
import type { MarkdownViewerProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { ErrorView, Loading, Screen } from '../components/ui'
import { colors, space } from '../theme'

/** Read-only native renderer for a `.md` file opened from a task's links. Loads
 *  the content over the shared /api/files endpoint (works on any backend) and
 *  renders it with native components — no WebView. The full editor comes later. */
export function MarkdownViewerScreen({ route, navigation }: MarkdownViewerProps) {
  const { path, title } = route.params
  const { data, loading, error, reload } = useLoader(() => readTextFile(path), [path])

  useEffect(() => {
    if (title) navigation.setOptions({ title })
  }, [navigation, title])

  if (loading) return <Loading />
  if (error || data == null) return <ErrorView message={error ?? 'Could not load file'} onRetry={reload} />

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Markdown style={mdStyles}>{data}</Markdown>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: 60 },
})

// react-native-markdown-display merges these over its defaults (keys are AST
// node names). A dark palette aligned with the rest of the app.
const mono = 'Menlo'
const mdStyles = {
  body: { color: colors.textDim, fontSize: 16, lineHeight: 24 },
  heading1: { color: colors.text, fontSize: 26, fontWeight: '700', marginTop: 18, marginBottom: 8 },
  heading2: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  heading3: { color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 14, marginBottom: 4 },
  heading4: { color: colors.text, fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 4 },
  link: { color: colors.accent },
  blockquote: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderLeftWidth: 3,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    marginBottom: space.md,
  },
  code_inline: { backgroundColor: colors.surface2, color: colors.textDim, borderRadius: 4, paddingHorizontal: 4, fontFamily: mono, fontSize: 14 },
  fence: { backgroundColor: colors.surface, color: colors.textDim, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: space.md, fontFamily: mono, fontSize: 13 },
  code_block: { backgroundColor: colors.surface, color: colors.textDim, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: space.md, fontFamily: mono, fontSize: 13 },
  hr: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginVertical: space.md },
  table: { borderColor: colors.border, borderWidth: 1, borderRadius: 6, marginBottom: space.md },
  thead: { backgroundColor: colors.surface },
  th: { borderColor: colors.border, padding: space.sm, color: colors.text },
  td: { borderColor: colors.border, padding: space.sm },
  bullet_list_icon: { color: colors.muted },
  ordered_list_icon: { color: colors.muted },
} as const
