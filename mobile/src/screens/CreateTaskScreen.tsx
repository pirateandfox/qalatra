import { useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { api, fetchAgents, fetchContexts, fetchProjects, today, type Agent, type Context, type Project } from '@qalatra/shared'
import type { CreateTaskProps } from '../navigation/types'
import { Screen } from '../components/ui'
import { ButtonRow, ChipRow, type ChipOption, type ChipValue } from '../components/ChipRow'
import { SelectSheet } from '../components/SelectSheet'
import { useLoader } from '../lib/useLoader'
import { agentLabel, agentOptions, agentsForCreate } from '../lib/agents'
import { nextWeekStart, thisWeekend, tomorrow } from '../lib/dates'
import { colors, radius, space } from '../theme'

const PRIORITY_OPTS: ChipOption[] = [
  { value: null, label: 'None' },
  { value: 1, label: 'P1' }, { value: 2, label: 'P2' }, { value: 3, label: 'P3' }, { value: 4, label: 'P4' }, { value: 5, label: 'P5' },
]

export function CreateTaskScreen({ navigation }: CreateTaskProps) {
  const { data } = useLoader(async () => {
    const [contexts, projects, agents] = await Promise.all([
      fetchContexts().catch(() => [] as Context[]),
      fetchProjects().catch(() => [] as Project[]),
      fetchAgents().catch(() => [] as Agent[]),
    ])
    return { contexts, projects, agents }
  })

  const [title, setTitle] = useState('')
  const [context, setContext] = useState<ChipValue>(null)
  const [project, setProject] = useState<ChipValue>(null)
  const [priority, setPriority] = useState<ChipValue>(null)
  const [agentPath, setAgentPath] = useState<ChipValue>(null)
  const [agentSheet, setAgentSheet] = useState(false)
  const [dueDate, setDueDate] = useState('')
  const [busy, setBusy] = useState(false)

  const contextOpts: ChipOption[] = [{ value: null, label: 'None' }, ...(data?.contexts ?? []).map(c => ({ value: c.slug, label: c.label }))]
  const projectOpts: ChipOption[] = [{ value: null, label: 'None' }, ...(data?.projects ?? []).map(p => ({ value: p.name, label: p.name }))]
  const filteredAgents = agentsForCreate(data?.agents ?? [], context, project)
  const agentOpts = agentOptions(filteredAgents, typeof agentPath === 'string' ? agentPath : null)

  function handleContextChange(value: ChipValue) {
    setContext(value)
    setProject(null)
    setAgentPath(null)
  }

  function handleProjectChange(value: ChipValue) {
    setProject(value)
    const selectedAgent = typeof agentPath === 'string'
      ? data?.agents.find(agent => agent.path === agentPath)
      : null
    if (selectedAgent?.project && typeof value === 'string' && value && selectedAgent.project !== value) {
      setAgentPath(null)
    }
  }

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
        agent_path: (agentPath as string) || undefined,
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

          <ChipRow label="Context" value={context} options={contextOpts} onChange={handleContextChange} />
          <ChipRow label="Project" value={project} options={projectOpts} onChange={handleProjectChange} />
          <Text style={styles.label}>Agent</Text>
          <Pressable
            style={({ pressed }) => [styles.selectButton, pressed && styles.selectButtonPressed]}
            onPress={() => setAgentSheet(true)}
          >
            <Text style={[styles.selectValue, !agentPath && styles.selectPlaceholder]} numberOfLines={1}>
              {agentLabel(data?.agents ?? [], typeof agentPath === 'string' ? agentPath : null) ?? 'None'}
            </Text>
            <Text style={styles.selectChevron}>›</Text>
          </Pressable>
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
      <SelectSheet
        visible={agentSheet}
        title="Agent"
        options={agentOpts}
        value={agentPath}
        onSelect={v => { setAgentPath(v); setAgentSheet(false) }}
        onClose={() => setAgentSheet(false)}
        searchable
        searchPlaceholder="Search agents…"
        emptyText="No agents match this task"
      />
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
  selectButton: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  selectButtonPressed: { backgroundColor: colors.surface2 },
  selectValue: { color: colors.textDim, fontSize: 16, flex: 1 },
  selectPlaceholder: { color: colors.muted2 },
  selectChevron: { color: colors.muted2, fontSize: 20, marginTop: -2 },
  submit: { backgroundColor: colors.accentStrong, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.xl },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.5 },
})
