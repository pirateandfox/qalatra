import { useEffect, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import {
  addNote,
  api,
  fetchContexts,
  fetchNotes,
  fetchProjects,
  fetchSubtasks,
  fetchTask,
  today,
  updateTask,
  type Context,
  type Note,
  type Project,
  type Task,
} from '@qalatra/shared'
import type { TaskDetailProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { ErrorView, Loading, Screen } from '../components/ui'
import { ButtonRow, ChipRow, type ChipOption, type ChipValue } from '../components/ChipRow'
import { nextWeekStart, thisWeekend, tomorrow } from '../lib/dates'
import { colors, ENERGY_ICONS, priorityColor, radius, space } from '../theme'

const PRIORITY_OPTS: ChipOption[] = [
  { value: null, label: 'None' },
  { value: 1, label: 'P1' }, { value: 2, label: 'P2' }, { value: 3, label: 'P3' }, { value: 4, label: 'P4' }, { value: 5, label: 'P5' },
]
const ENERGY_OPTS: ChipOption[] = [
  { value: null, label: 'None' },
  { value: 'high', label: '🔥 High' }, { value: 'medium', label: '⚡ Med' }, { value: 'low', label: '🌿 Low' }, { value: 'async', label: '📬 Async' },
]
const RECUR_OPTS: ChipOption[] = [
  { value: null, label: 'None' },
  { value: 'daily', label: 'Daily' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' },
]
const RECUR_SHORTHANDS = ['daily', 'weekdays', 'weekly', 'monthly']

function recurrenceShorthand(r: string | null): ChipValue {
  if (!r) return null
  return RECUR_SHORTHANDS.includes(r) ? r : null
}

export function TaskDetailScreen({ route, navigation }: TaskDetailProps) {
  const { taskId } = route.params
  const { data, loading, error, reload } = useLoader(async () => {
    const [task, notes, subtasks, contexts, projects] = await Promise.all([
      fetchTask(taskId),
      fetchNotes(taskId).catch(() => [] as Note[]),
      fetchSubtasks(taskId).catch(() => [] as Task[]),
      fetchContexts().catch(() => [] as Context[]),
      fetchProjects().catch(() => [] as Project[]),
    ])
    return { task, notes, subtasks, contexts, projects }
  }, [taskId])

  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')
  const [newNote, setNewNote] = useState('')

  const task = data?.task
  useEffect(() => {
    if (!task) return
    setTitle(task.title)
    setDescription(task.description ?? '')
    setNotes(task.notes ?? '')
  }, [task])

  async function act(fn: () => Promise<unknown>, opts: { back?: boolean } = {}) {
    setBusy(true)
    try {
      await fn()
      if (opts.back) navigation.goBack()
      else await reload()
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />
  if (error || !task) return <ErrorView message={error ?? 'Task not found'} onRetry={reload} />

  const done = task.status === 'done'
  const pColor = priorityColor(task.my_priority)
  const energy = task.energy_required ? ENERGY_ICONS[task.energy_required] : null

  const contextOpts: ChipOption[] = [{ value: null, label: 'None' }, ...(data?.contexts ?? []).map(c => ({ value: c.slug, label: c.label }))]
  const projectOpts: ChipOption[] = [{ value: null, label: 'None' }, ...(data?.projects ?? []).map(p => ({ value: p.name, label: p.name }))]

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <TextInput
            style={styles.title}
            value={title}
            onChangeText={setTitle}
            multiline
            placeholder="Title"
            placeholderTextColor={colors.muted2}
            onBlur={() => title.trim() && title !== task.title && act(() => api.updateTitle(taskId, title.trim()))}
          />

          <View style={styles.metaRow}>
            {pColor ? <View style={[styles.pill, { borderColor: pColor }]}><Text style={[styles.pillText, { color: pColor }]}>P{task.my_priority}</Text></View> : null}
            {task.context ? <Meta text={task.context} /> : null}
            {task.project ? <Meta text={task.project} /> : null}
            {task.due_date ? <Meta text={`due ${task.due_date}`} /> : null}
            {energy ? <Meta text={energy} /> : null}
            <Meta text={task.status} />
          </View>

          <View style={styles.actions}>
            {done ? (
              <Action label="Uncomplete" onPress={() => act(() => api.uncomplete(taskId))} disabled={busy} />
            ) : (
              <Action label="✓ Complete" primary onPress={() => act(() => api.complete(taskId), { back: true })} disabled={busy} />
            )}
            <Action label="Activate" onPress={() => act(() => api.activate(taskId))} disabled={busy} />
            <Action label="Skip" onPress={() => act(() => api.skip(taskId), { back: true })} disabled={busy} />
          </View>

          {/* Editable properties */}
          <ChipRow label="Priority" value={task.my_priority} options={PRIORITY_OPTS} onChange={v => act(() => updateTask(taskId, { my_priority: v }))} />
          <ChipRow label="Energy" value={task.energy_required} options={ENERGY_OPTS} onChange={v => act(() => updateTask(taskId, { energy_required: v }))} />
          <ChipRow label="Context" value={task.context} options={contextOpts} onChange={v => act(() => updateTask(taskId, { context: v }))} />
          <ChipRow label="Project" value={task.project} options={projectOpts} onChange={v => act(() => updateTask(taskId, { project: v }))} />
          <ChipRow label="Recurrence" value={recurrenceShorthand(task.recurrence)} options={RECUR_OPTS} onChange={v => act(() => api.updateRecurrence(taskId, (v as string | null)))} />
          <ButtonRow
            label="Due date"
            actions={[
              { label: 'Today', onPress: () => act(() => api.updateDueDate(taskId, today())) },
              { label: 'Tomorrow', onPress: () => act(() => api.updateDueDate(taskId, tomorrow())) },
              { label: 'Weekend', onPress: () => act(() => api.updateDueDate(taskId, thisWeekend())) },
              { label: 'Next wk', onPress: () => act(() => api.updateDueDate(taskId, nextWeekStart())) },
              { label: 'Clear', onPress: () => act(() => api.updateDueDate(taskId, null)) },
            ]}
          />
          <ButtonRow
            label="Snooze"
            actions={[
              { label: 'Tomorrow', onPress: () => act(() => api.snooze(taskId, tomorrow()), { back: true }) },
              { label: 'Weekend', onPress: () => act(() => api.snooze(taskId, thisWeekend()), { back: true }) },
              { label: 'Next wk', onPress: () => act(() => api.snooze(taskId, nextWeekStart()), { back: true }) },
            ]}
          />

          <Field label="Description">
            <TextInput
              style={styles.multiline}
              value={description}
              onChangeText={setDescription}
              multiline
              placeholder="Add a description…"
              placeholderTextColor={colors.muted2}
              onBlur={() => description !== (task.description ?? '') && act(() => api.updateDescription(taskId, description))}
            />
          </Field>

          <Field label="Notes">
            <TextInput
              style={styles.multiline}
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="Scratch notes…"
              placeholderTextColor={colors.muted2}
              onBlur={() => notes !== (task.notes ?? '') && act(() => updateTask(taskId, { notes }))}
            />
          </Field>

          {data && data.subtasks.length > 0 ? (
            <Field label={`Subtasks (${data.subtasks.length})`}>
              {data.subtasks.map(st => (
                <Pressable
                  key={st.id}
                  style={styles.subtask}
                  onPress={() => act(() => (st.status === 'done' ? api.uncomplete(st.id) : api.complete(st.id)))}
                  disabled={busy}
                >
                  <Text style={styles.checkbox}>{st.status === 'done' ? '☑' : '☐'}</Text>
                  <Text style={[styles.subtaskText, st.status === 'done' && styles.subtaskDone]}>{st.title}</Text>
                </Pressable>
              ))}
            </Field>
          ) : null}

          <Field label="Log">
            {data && data.notes.length > 0 ? (
              data.notes.map(n => (
                <View key={n.id} style={styles.logItem}>
                  <Text style={styles.logAuthor}>{n.author}</Text>
                  <Text style={styles.logBody}>{n.body}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.dim}>No log entries yet.</Text>
            )}
            <View style={styles.addNote}>
              <TextInput
                style={styles.addNoteInput}
                value={newNote}
                onChangeText={setNewNote}
                placeholder="Add a log note…"
                placeholderTextColor={colors.muted2}
                multiline
              />
              <Action
                label="Add"
                onPress={() => newNote.trim() && act(async () => { await addNote(taskId, newNote.trim()); setNewNote('') })}
                disabled={busy || !newNote.trim()}
              />
            </View>
          </Field>

          <View style={styles.footer} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function Meta({ text }: { text: string }) {
  return <View style={styles.metaPill}><Text style={styles.metaPillText}>{text}</Text></View>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  )
}

function Action({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.action, primary && styles.actionPrimary, (pressed || disabled) && styles.actionDim]}
    >
      <Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.lg },
  title: { color: colors.text, fontSize: 22, fontWeight: '600', lineHeight: 28 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  metaPill: { backgroundColor: colors.surface, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  metaPillText: { color: colors.muted, fontSize: 12 },
  pill: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  pillText: { fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.lg },
  action: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  actionPrimary: { backgroundColor: colors.accentStrong, borderColor: colors.accentStrong },
  actionDim: { opacity: 0.5 },
  actionText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  actionTextPrimary: { color: '#fff' },
  field: { marginTop: space.xl },
  fieldLabel: { color: colors.muted2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: space.sm },
  multiline: {
    backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md,
    color: colors.textDim, padding: space.md, fontSize: 15, minHeight: 64, textAlignVertical: 'top',
  },
  subtask: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6 },
  checkbox: { color: colors.accent, fontSize: 18 },
  subtaskText: { color: colors.textDim, fontSize: 15, flex: 1 },
  subtaskDone: { color: colors.muted2, textDecorationLine: 'line-through' },
  logItem: { marginBottom: space.md },
  logAuthor: { color: colors.muted2, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  logBody: { color: colors.textDim, fontSize: 14, marginTop: 2 },
  dim: { color: colors.muted2, fontSize: 14 },
  addNote: { marginTop: space.md, gap: space.sm },
  addNoteInput: {
    backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md,
    color: colors.textDim, padding: space.md, fontSize: 15, minHeight: 44, textAlignVertical: 'top',
  },
  footer: { height: 60 },
})
