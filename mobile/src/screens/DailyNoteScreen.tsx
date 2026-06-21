import { useEffect, useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { fetchDailyNote, offsetDate, saveDailyNote, today } from '@qalatra/shared'
import { useLoader } from '../lib/useLoader'
import { ErrorView, Loading, Screen } from '../components/ui'
import { colors, radius, space } from '../theme'

export function DailyNoteScreen() {
  const [date, setDate] = useState(today())
  const { data, loading, error, reload } = useLoader(() => fetchDailyNote(date), [date])

  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (data) {
      setContent(data.content ?? '')
      setDirty(false)
    }
  }, [data])

  async function save() {
    if (!dirty) return
    setSaving(true)
    try {
      await saveDailyNote(date, content)
      setDirty(false)
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Pressable onPress={() => setDate(offsetDate(date, -1))} hitSlop={10}><Text style={styles.nav}>‹</Text></Pressable>
          <Text style={styles.date}>{date === today() ? 'Today' : date}</Text>
          <Pressable onPress={() => setDate(offsetDate(date, 1))} hitSlop={10}><Text style={styles.nav}>›</Text></Pressable>
        </View>

        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorView message={error} onRetry={reload} />
        ) : (
          <TextInput
            style={styles.editor}
            value={content}
            onChangeText={t => { setContent(t); setDirty(true) }}
            onBlur={save}
            multiline
            placeholder="Today's note…"
            placeholderTextColor={colors.muted2}
            textAlignVertical="top"
          />
        )}

        {dirty ? (
          <Pressable style={[styles.save, saving && styles.dim]} onPress={save} disabled={saving}>
            <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  nav: { color: colors.accent, fontSize: 26, paddingHorizontal: space.md },
  date: { color: colors.text, fontSize: 16, fontWeight: '600' },
  editor: { flex: 1, color: colors.textDim, fontSize: 16, lineHeight: 23, padding: space.lg },
  save: { backgroundColor: colors.accentStrong, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', margin: space.lg },
  saveText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.5 },
})
