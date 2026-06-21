import { useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { api, fetchContexts, fetchProjects, today, type Context, type Project } from '@qalatra/shared'
import type { CreateTaskProps } from '../navigation/types'
import { Screen } from '../components/ui'
import { ButtonRow, ChipRow, type ChipOption, type ChipValue } from '../components/ChipRow'
import { useLoader } from '../lib/useLoader'
import { nextWeekStart, thisWeekend, tomorrow } from '../lib/dates'
import { colors, radius, space } from '../theme'

const PRIORITY_OPTS: ChipOption[] = [
  { value: null, label: 'None' },
  { value: 1, label: 'P1' }, { value: 2, label: 'P2' }, { value: 3, label: 'P3' }, { value: 4, label: 'P4' }, { value: 5, label: 'P5' },
]

export function CreateTaskScreen({ navigation }: CreateTaskProps) {
  const { data } = useLoader(async () => {
    const [contexts, projects] = await Promise.all([
      fetchContexts().catch(() => [] as Context[]),
      fetchProjects().catch(() => [] as Project[]),
    ])
    return { contexts, projects }
  })

  const [title, setTitle] = useState('')
  const [context, setContext] = useState<ChipValue>(null)
  const [project, setProject] = useState<ChipValue>(null)
  const [priority, setPriority] = useState<ChipValue>(null)
  const [dueDate, setDueDate] = useState('')
  const [busy, setBusy] = useState(false)

  const contextOpts: ChipOption[] = [{ value: null, label: 'None' }, ...(data?.contexts ?? []).map(c => ({ value: c.slug, label: c.label }))]
  const projectOpts: ChipOption[] = [{ value: null, label: 'None' }, ...(data?.projects ?? []).map(p => ({ value: p.name, label: p.name }))]

  async function create() {
    if (!title.trim()) return
    setBusy(true)
    try {
      await api.createTask({
        title: title.trim(),
        context: (context as string) || undefined,
        project: (project as string) || null,
        my_priority: priority == null ? null : Number(priority),
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
        <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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

          <ChipRow label="Context" value={context} options={contextOpts} onChange={setContext} />
          <ChipRow label="Project" value={project} options={projectOpts} onChange={setProject} />
          <ChipRow label="Priority" value={priority} options={PRIORITY_OPTS} onChange={setPriority} />

          <Text style={styles.label}>Due date</Text>
          <TextInput style={styles.input} value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted2} autoCapitalize="none" />
          <ButtonRow
            label=""
            actions={[
              { label: 'Today', onPress: () => setDueDate(today()) },
              { label: 'Tomorrow', onPress: () => setDueDate(tomorrow()) },
              { label: 'Weekend', onPress: () => setDueDate(thisWeekend()) },
              { label: 'Next wk', onPress: () => setDueDate(nextWeekStart()) },
              { label: 'Clear', onPress: () => setDueDate('') },
            ]}
          />

          <Pressable style={[styles.submit, (busy || !title.trim()) && styles.dim]} onPress={create} disabled={busy || !title.trim()}>
            <Text style={styles.submitText}>Create Task</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.lg },
  label: { color: colors.muted2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space.lg, marginBottom: space.sm },
  input: {
    backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md,
    color: colors.textDim, padding: space.md, fontSize: 16,
  },
  submit: { backgroundColor: colors.accentStrong, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.xl },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.5 },
})
