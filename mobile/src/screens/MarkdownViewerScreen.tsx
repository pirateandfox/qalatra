import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { readTextFile, writeTextFile } from '@qalatra/shared'
import type { MarkdownViewerProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { ErrorView, Loading, Screen } from '../components/ui'
import { colors, radius, space } from '../theme'

/** Renders a `.md` file opened from a task's links. Read mode renders natively
 *  with react-native-markdown-display; Edit mode is a native source editor that
 *  saves over the shared /api/files endpoint. No WebView — the full mdpdf editor
 *  (CodeMirror + paginated preview + PDF) is a later, WebView-based step. */
export function MarkdownViewerScreen({ route, navigation }: MarkdownViewerProps) {
  const { path, title } = route.params
  const { data, loading, error, reload } = useLoader(() => readTextFile(path), [path])

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const draftRef = useRef('')
  draftRef.current = draft

  const startEdit = useCallback(() => {
    setDraft(data ?? '')
    setEditing(true)
  }, [data])

  const cancelEdit = useCallback(() => setEditing(false), [])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await writeTextFile(path, draftRef.current)
      setEditing(false)
      await reload()
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [path, reload])

  useEffect(() => {
    navigation.setOptions({
      title: title ?? 'Document',
      headerRight: () =>
        editing ? (
          <HeaderActions>
            <HeaderButton label="Cancel" onPress={cancelEdit} muted disabled={saving} />
            <HeaderButton label={saving ? 'Saving…' : 'Save'} onPress={save} disabled={saving} />
          </HeaderActions>
        ) : data != null ? (
          <HeaderActions>
            <HeaderButton label="⤢ Editor" muted onPress={() => navigation.navigate('MarkdownEditor', { path, title })} />
            <HeaderButton label="Edit" onPress={startEdit} />
          </HeaderActions>
        ) : null,
    })
  }, [navigation, title, path, editing, saving, data, startEdit, cancelEdit, save])

  if (loading) return <Loading />
  if (error || data == null) return <ErrorView message={error ?? 'Could not load file'} onRetry={reload} />

  if (editing) {
    return (
      <Screen>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TextInput
            style={styles.editor}
            value={draft}
            onChangeText={setDraft}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Markdown…"
            placeholderTextColor={colors.muted2}
            textAlignVertical="top"
          />
        </KeyboardAvoidingView>
      </Screen>
    )
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Markdown style={mdStyles}>{data}</Markdown>
      </ScrollView>
    </Screen>
  )
}

function HeaderActions({ children }: { children: React.ReactNode }) {
  return <View style={styles.headerActions}>{children}</View>
}

function HeaderButton({ label, onPress, disabled, muted }: { label: string; onPress: () => void; disabled?: boolean; muted?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={8}>
      <Text style={[styles.headerBtn, muted && styles.headerBtnMuted, disabled && styles.headerBtnDim]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.lg, paddingBottom: 60 },
  editor: {
    flex: 1,
    color: colors.textDim,
    backgroundColor: colors.bg,
    fontFamily: 'Menlo',
    fontSize: 14,
    lineHeight: 20,
    padding: space.lg,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  headerBtn: { color: colors.accent, fontSize: 16, fontWeight: '600', marginLeft: space.lg },
  headerBtnMuted: { color: colors.muted, fontWeight: '400' },
  headerBtnDim: { opacity: 0.5 },
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
  code_inline: { backgroundColor: colors.surface2, color: colors.textDim, borderRadius: radius.sm, paddingHorizontal: 4, fontFamily: mono, fontSize: 14 },
  fence: { backgroundColor: colors.surface, color: colors.textDim, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: space.md, fontFamily: mono, fontSize: 13 },
  code_block: { backgroundColor: colors.surface, color: colors.textDim, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: space.md, fontFamily: mono, fontSize: 13 },
  hr: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginVertical: space.md },
  table: { borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, marginBottom: space.md },
  thead: { backgroundColor: colors.surface },
  th: { borderColor: colors.border, padding: space.sm, color: colors.text },
  td: { borderColor: colors.border, padding: space.sm },
  bullet_list_icon: { color: colors.muted },
  ordered_list_icon: { color: colors.muted },
} as const
