import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { fetchTasks, today, type Task, type TaskData } from '@qalatra/shared'

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

export function TodayScreen({ selectedId, onSelect }: { selectedId?: string | null; onSelect?: (id: string) => void }) {
  const [data, setData] = useState<TaskData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      setData(await fetchTasks(today()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    )
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            void load()
          }}
          tintColor="#a1a1aa"
        />
      }
    >
      {SECTIONS.map(({ key, label }) => {
        const tasks = (data?.[key] as Task[] | undefined) ?? []
        if (!tasks.length) return null
        return (
          <View key={key} style={styles.section}>
            <Text style={styles.sectionHeader}>{label}</Text>
            {tasks.map(task => (
              <Pressable
                key={task.id}
                style={[styles.row, selectedId === task.id && styles.rowSelected]}
                onPress={() => onSelect?.(task.id)}
              >
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {task.title}
                </Text>
                {task.context ? <Text style={styles.rowMeta}>{task.context}</Text> : null}
              </Pressable>
            ))}
          </View>
        )
      })}
      <View style={styles.footerSpace} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: '#f87171', fontSize: 14, textAlign: 'center' },
  list: { flex: 1 },
  section: { marginTop: 16 },
  sectionHeader: {
    color: '#71717a',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#27272a',
  },
  rowSelected: { backgroundColor: '#1e293b' },
  rowTitle: { color: '#e4e4e7', fontSize: 16 },
  rowMeta: { color: '#71717a', fontSize: 12, marginTop: 2 },
  footerSpace: { height: 32 },
})
