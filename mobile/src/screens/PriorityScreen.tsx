import { useCallback } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { fetchTasks, today, type Task, type TaskData } from '@qalatra/shared'
import type { TaskStackParamList } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { TaskRow } from '../components/TaskRow'
import { Loading, ErrorView, EmptyView, Screen } from '../components/ui'
import { colors, space } from '../theme'

type Nav = NativeStackNavigationProp<TaskStackParamList>

const SECTIONS: { key: keyof TaskData; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'dueToday', label: 'Due Today' },
  { key: 'active', label: 'Active' },
  { key: 'wakingUp', label: 'Waking Up' },
  { key: 'events', label: 'Events' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'doneToday', label: 'Done Today' },
]

export function PriorityScreen() {
  const navigation = useNavigation<Nav>()
  const { data, loading, refreshing, error, reload, refresh } = useLoader(() => fetchTasks(today()))
  useFocusEffect(useCallback(() => { void reload() }, [reload]))

  if (loading) return <Loading />
  if (error) return <ErrorView message={error} onRetry={reload} />

  const sections = SECTIONS
    .map(s => ({ ...s, tasks: (data?.[s.key] as Task[] | undefined) ?? [] }))
    .filter(s => s.tasks.length)

  if (!sections.length) return <EmptyView message="Nothing for today. Tap + to capture a task." />

  return (
    <Screen>
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}>
        {sections.map(s => (
          <View key={s.key} style={styles.section}>
            <Text style={styles.header}>
              {s.label} <Text style={styles.count}>{s.tasks.length}</Text>
            </Text>
            {s.tasks.map(t => (
              <TaskRow key={t.id} task={t} onPress={() => navigation.navigate('TaskDetail', { taskId: t.id })} />
            ))}
          </View>
        ))}
        <View style={styles.footer} />
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  section: { marginTop: space.lg },
  header: {
    color: colors.muted2,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: space.lg,
    marginBottom: space.xs,
  },
  count: { color: colors.borderStrong },
  footer: { height: 40 },
})
