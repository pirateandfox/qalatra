import { useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { api, offsetDate, today } from '@qalatra/shared'
import type { CreateTaskProps } from '../navigation/types'
import { Screen } from '../components/ui'
import { colors, radius, space } from '../theme'

export function CreateTaskScreen({ navigation }: CreateTaskProps) {
  const [title, setTitle] = useState('')
  const [context, setContext] = useState('')
  const [project, setProject] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    if (!title.trim()) return
    setBusy(true)
    try {
      await api.createTask({
        title: title.trim(),
        context: context.trim() || undefined,
        project: project.trim() || null,
        due_date: dueDate.trim() || null,
      } as Parameters<typeof api.createTask>[0])
      navigation.goBack()
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="What needs doing?"
            placeholderTextColor={colors.muted2}
            autoFocus
            multiline
          />

          <Text style={styles.label}>Context</Text>
          <TextInput style={styles.input} value={context} onChangeText={setContext} placeholder="e.g. personal" placeholderTextColor={colors.muted2} autoCapitalize="none" />

          <Text style={styles.label}>Project</Text>
          <TextInput style={styles.input} value={project} onChangeText={setProject} placeholder="optional" placeholderTextColor={colors.muted2} />

          <Text style={styles.label}>Due date</Text>
          <TextInput style={styles.input} value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted2} autoCapitalize="none" />
          <View style={styles.quickRow}>
            <Quick label="Today" onPress={() => setDueDate(today())} />
            <Quick label="Tomorrow" onPress={() => setDueDate(offsetDate(today(), 1))} />
            <Quick label="Clear" onPress={() => setDueDate('')} />
          </View>

          <Pressable style={[styles.submit, (busy || !title.trim()) && styles.dim]} onPress={create} disabled={busy || !title.trim()}>
            <Text style={styles.submitText}>Create Task</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function Quick({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.quick} onPress={onPress}>
      <Text style={styles.quickText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.lg },
  label: { color: colors.muted2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space.lg, marginBottom: space.sm },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.textDim,
    padding: space.md,
    fontSize: 16,
  },
  quickRow: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  quick: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  quickText: { color: colors.muted, fontSize: 13 },
  submit: { backgroundColor: colors.accentStrong, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.xl },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.5 },
})
