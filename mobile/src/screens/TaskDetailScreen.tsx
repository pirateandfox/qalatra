import { useEffect, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as Sharing from 'expo-sharing'
import { File } from 'expo-file-system'
import * as FileSystem from 'expo-file-system/legacy'
import {
  addNote,
  api,
  currentServerInstance,
  deleteAttachment,
  fetchAgentJobs,
  fetchAttachments,
  uploadAttachment,
  fetchContexts,
  fetchNotes,
  fetchProjects,
  fetchSubtasks,
  fetchTask,
  queueAgentJob,
  updateTask,
  type AgentJob,
  type Attachment,
  type Context,
  type Note,
  type Project,
  type Task,
} from '@qalatra/shared'
import type { TaskDetailProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { ErrorView, Loading, Screen } from '../components/ui'
import { ButtonRow, type ChipOption, type ChipValue } from '../components/ChipRow'
import { MetaCard, MetaRow } from '../components/MetaCard'
import { SelectSheet } from '../components/SelectSheet'
import { DateSheet } from '../components/DateSheet'
import { isHttpUrl, isMarkdownLink, linkLabel, parseLinks } from '../lib/links'
import { formatDate, nextWeekStart, thisWeekend, tomorrow } from '../lib/dates'
import { colors, priorityColor, radius, space } from '../theme'

/** Which metadata picker, if any, is currently open. */
type SheetKey = 'priority' | 'energy' | 'context' | 'project' | 'recurrence'
type DateKey = 'due' | 'start'

/** The display label for a selected option value, or null when unset (so the
 *  summary row falls back to its dimmed placeholder). */
function valueLabel(options: ChipOption[], value: ChipValue): string | null {
  if (value == null || value === '') return null
  return options.find(o => o.value === value)?.label ?? String(value)
}

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

/** A label for the recurrence summary row: the shorthand's friendly name, or
 *  the raw RRULE string for custom recurrences. */
function recurrenceLabel(r: string | null): string | null {
  if (!r) return null
  return RECUR_OPTS.find(o => o.value === r)?.label ?? r
}

export function TaskDetailScreen({ route, navigation }: TaskDetailProps) {
  const { taskId } = route.params
  const { data, loading, error, reload } = useLoader(async () => {
    const [task, notes, subtasks, contexts, projects, attachments, jobs] = await Promise.all([
      fetchTask(taskId),
      fetchNotes(taskId).catch(() => [] as Note[]),
      fetchSubtasks(taskId).catch(() => [] as Task[]),
      fetchContexts().catch(() => [] as Context[]),
      fetchProjects().catch(() => [] as Project[]),
      fetchAttachments(taskId).catch(() => [] as Attachment[]),
      fetchAgentJobs(taskId).catch(() => [] as AgentJob[]),
    ])
    return { task, notes, subtasks, contexts, projects, attachments, jobs }
  }, [taskId])

  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')
  const [newNote, setNewNote] = useState('')
  const [sheet, setSheet] = useState<SheetKey | null>(null)
  const [dateSheet, setDateSheet] = useState<DateKey | null>(null)

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

  /** Pick a file (or photo) and upload it as a task attachment. Reads the picked
   *  file's bytes locally and sends them to the existing /api/attachments endpoint. */
  async function pickAndUploadAttachment() {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })
    if (result.canceled || !result.assets?.length) return
    const asset = result.assets[0]
    const bytes = Array.from(new Uint8Array(await new File(asset.uri).arrayBuffer()))
    await uploadAttachment(taskId, asset.name, asset.mimeType ?? 'application/octet-stream', bytes)
  }

  /** Attach a photo/screenshot from the camera roll — the most common mobile case. */
  async function pickAndUploadPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access in Settings to attach images.')
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 1 })
    if (result.canceled || !result.assets?.length) return
    const asset = result.assets[0]
    const bytes = Array.from(new Uint8Array(await new File(asset.uri).arrayBuffer()))
    await uploadAttachment(taskId, asset.fileName ?? 'photo.jpg', asset.mimeType ?? 'image/jpeg', bytes)
  }

  /** Open an attachment. S3-hosted files have a public URL; locally-stored files
   *  (no URL) are downloaded via the authenticated content endpoint, then handed
   *  to the system share/preview sheet. */
  async function openAttachment(att: Attachment) {
    if (att.url) {
      await Linking.openURL(att.url)
      return
    }
    const inst = await currentServerInstance()
    const dir = FileSystem.cacheDirectory
    if (!dir) throw new Error('No cache directory available')
    const safeName = (att.filename || 'attachment').replace(/[^\w.\-]+/g, '_')
    const { uri } = await FileSystem.downloadAsync(
      `${inst.url.replace(/\/$/, '')}/api/attachments/${encodeURIComponent(att.id)}/content`,
      `${dir}${safeName}`,
      { headers: { Authorization: `Bearer ${inst.token}` } },
    )
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
    else Alert.alert('Downloaded', uri)
  }

  if (loading) return <Loading />
  if (error || !task) return <ErrorView message={error ?? 'Task not found'} onRetry={reload} />

  const done = task.status === 'done'
  const links = parseLinks(task.links)

  const contextOpts: ChipOption[] = [{ value: null, label: 'None' }, ...(data?.contexts ?? []).map(c => ({ value: c.slug, label: c.label }))]
  const projectOpts: ChipOption[] = [{ value: null, label: 'None' }, ...(data?.projects ?? []).map(p => ({ value: p.name, label: p.name }))]

  // Apply an edit, then close whichever picker is open.
  const setField = (fields: Record<string, unknown>) => { setSheet(null); act(() => updateTask(taskId, fields)) }

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

          <View style={styles.statusRow}>
            <View style={[styles.statusBadge, done && styles.statusBadgeDone]}>
              <Text style={[styles.statusText, done && styles.statusTextDone]}>{task.status}</Text>
            </View>
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

          {/* Editable metadata — tap a row to open its picker */}
          <MetaCard>
            <MetaRow label="Priority" value={valueLabel(PRIORITY_OPTS, task.my_priority)} placeholder="None" valueColor={priorityColor(task.my_priority)} onPress={() => setSheet('priority')} />
            <MetaRow label="Energy" value={valueLabel(ENERGY_OPTS, task.energy_required)} placeholder="None" onPress={() => setSheet('energy')} />
            <MetaRow label="Context" value={valueLabel(contextOpts, task.context)} placeholder="None" onPress={() => setSheet('context')} />
            <MetaRow label="Project" value={valueLabel(projectOpts, task.project)} placeholder="None" onPress={() => setSheet('project')} />
            <MetaRow label="Due" value={formatDate(task.due_date)} placeholder="No date" onPress={() => setDateSheet('due')} />
            <MetaRow label="Start" value={formatDate(task.start_date)} placeholder="No date" onPress={() => setDateSheet('start')} />
            <MetaRow label="Recurrence" value={recurrenceLabel(task.recurrence)} placeholder="None" onPress={() => setSheet('recurrence')} />
          </MetaCard>

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

          {links.length > 0 ? (
            <Field label="Links">
              {links.map((link, i) => {
                // Render server-side .md files in the native reader; everything
                // else (URLs, remote .md) opens in the system browser.
                const md = isMarkdownLink(link.url) && !isHttpUrl(link.url)
                return (
                  <Pressable
                    key={`${link.url}-${i}`}
                    style={styles.link}
                    onPress={() =>
                      md
                        ? navigation.navigate('MarkdownViewer', { path: link.url, title: linkLabel(link) })
                        : Linking.openURL(link.url).catch(() => {})
                    }
                  >
                    <Text style={styles.linkIcon}>{md ? '📄' : '🔗'}</Text>
                    <Text style={styles.linkText} numberOfLines={1}>{linkLabel(link)}</Text>
                    <Text style={styles.linkOpen}>{md ? 'read ›' : 'open ↗'}</Text>
                  </Pressable>
                )
              })}
            </Field>
          ) : null}

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

          <Field label={`Attachments${data && data.attachments.length ? ` (${data.attachments.length})` : ''}`}>
            {data?.attachments.map(a => (
              <View key={a.id} style={styles.attachment}>
                <Pressable
                  style={styles.attachmentMain}
                  onPress={() => act(() => openAttachment(a))}
                  disabled={busy}
                >
                  <Text style={styles.attachmentName} numberOfLines={1}>{a.filename}</Text>
                  <Text style={styles.attachmentOpen}>open ›</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    Alert.alert('Delete attachment?', a.filename, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => act(() => deleteAttachment(a.id)) },
                    ])
                  }
                  hitSlop={8}
                  disabled={busy}
                >
                  <Text style={styles.attachmentDelete}>✕</Text>
                </Pressable>
              </View>
            ))}
            <View style={styles.attachmentActions}>
              <Action label="＋ File" onPress={() => act(() => pickAndUploadAttachment())} disabled={busy} />
              <Action label="📷 Photo" onPress={() => act(() => pickAndUploadPhoto())} disabled={busy} />
            </View>
          </Field>

          {task.agent_path ? (
            <Field label="Agent">
              <Action label="▶ Run agent" onPress={() => act(() => queueAgentJob(taskId))} disabled={busy} />
              {data && data.jobs.length > 0 ? (
                data.jobs.map(j => (
                  <View key={j.id} style={styles.job}>
                    <Text style={styles.jobStatus}>{j.status}</Text>
                    {j.result ? <Text style={styles.jobResult} numberOfLines={6}>{j.result}</Text> : null}
                    <Text style={styles.jobTime}>{j.created_at}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.dim}>No runs yet.</Text>
              )}
            </Field>
          ) : null}

          <View style={styles.footer} />
        </ScrollView>
      </KeyboardAvoidingView>

      <SelectSheet
        visible={sheet === 'priority'}
        title="Priority"
        options={PRIORITY_OPTS}
        value={task.my_priority}
        onSelect={v => setField({ my_priority: v == null ? null : Number(v) })}
        onClose={() => setSheet(null)}
      />
      <SelectSheet
        visible={sheet === 'energy'}
        title="Energy"
        options={ENERGY_OPTS}
        value={task.energy_required}
        onSelect={v => setField({ energy_required: v })}
        onClose={() => setSheet(null)}
      />
      <SelectSheet
        visible={sheet === 'context'}
        title="Context"
        options={contextOpts}
        value={task.context}
        onSelect={v => setField({ context: v })}
        onClose={() => setSheet(null)}
      />
      <SelectSheet
        visible={sheet === 'project'}
        title="Project"
        options={projectOpts}
        value={task.project}
        onSelect={v => setField({ project: v })}
        onClose={() => setSheet(null)}
      />
      <SelectSheet
        visible={sheet === 'recurrence'}
        title="Recurrence"
        options={RECUR_OPTS}
        value={recurrenceShorthand(task.recurrence)}
        onSelect={v => { setSheet(null); act(() => api.updateRecurrence(taskId, v as string | null)) }}
        onClose={() => setSheet(null)}
      />
      <DateSheet
        visible={dateSheet === 'due'}
        title="Due date"
        value={task.due_date}
        onChange={iso => act(() => api.updateDueDate(taskId, iso))}
        onClose={() => setDateSheet(null)}
      />
      <DateSheet
        visible={dateSheet === 'start'}
        title="Start date"
        value={task.start_date}
        onChange={iso => act(() => updateTask(taskId, { start_date: iso }))}
        onClose={() => setDateSheet(null)}
      />
    </Screen>
  )
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
  statusRow: { flexDirection: 'row', marginTop: space.md },
  statusBadge: { backgroundColor: colors.surface, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  statusBadgeDone: { backgroundColor: colors.selected },
  statusText: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  statusTextDone: { color: colors.success },
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
  link: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  linkIcon: { fontSize: 15 },
  linkText: { color: colors.textDim, fontSize: 15, flex: 1 },
  linkOpen: { color: colors.accent, fontSize: 13 },
  attachment: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  attachmentMain: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  attachmentName: { color: colors.textDim, fontSize: 14, flex: 1, marginRight: space.sm },
  attachmentOpen: { color: colors.accent, fontSize: 13 },
  attachmentDelete: { color: colors.muted2, fontSize: 16, paddingLeft: space.md },
  attachmentActions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  job: { marginTop: space.md, padding: space.md, backgroundColor: colors.surface, borderRadius: radius.md },
  jobStatus: { color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  jobResult: { color: colors.textDim, fontSize: 13, marginTop: 4 },
  jobTime: { color: colors.muted2, fontSize: 11, marginTop: 4 },
  addNote: { marginTop: space.md, gap: space.sm },
  addNoteInput: {
    backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md,
    color: colors.textDim, padding: space.md, fontSize: 15, minHeight: 44, textAlignVertical: 'top',
  },
  footer: { height: 60 },
})
