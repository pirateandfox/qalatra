import { useCallback, useState } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { listHabits, logHabit, today, unlogHabit, type Habit, type HabitWeekDay } from '@qalatra/shared'
import { useLoader } from '../lib/useLoader'
import { EmptyView, ErrorView, Loading, Screen } from '../components/ui'
import { colors, radius, space } from '../theme'

export function HabitsScreen() {
  const { data, loading, refreshing, error, reload, refresh } = useLoader(() => listHabits(today()))
  useFocusEffect(useCallback(() => { void reload() }, [reload]))
  const [busy, setBusy] = useState(false)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      await reload()
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />
  if (error) return <ErrorView message={error} onRetry={reload} />
  const habits = data ?? []
  if (!habits.length) return <EmptyView message="No habits configured." />

  return (
    <Screen>
      <ScrollView
        style={styles.flex}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
      >
        {habits.map(h => (
          <HabitCard key={h.id} habit={h} busy={busy} onAct={act} />
        ))}
        <View style={styles.footer} />
      </ScrollView>
    </Screen>
  )
}

function HabitCard({ habit, busy, onAct }: { habit: Habit; busy: boolean; onAct: (fn: () => Promise<unknown>) => void }) {
  const done = habit.today_log?.status === 'done'
  const skipped = habit.today_log?.status === 'skipped'
  const d = today()
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{habit.title}</Text>
      {habit.description ? <Text style={styles.desc}>{habit.description}</Text> : null}
      <View style={styles.week}>
        {habit.week.map((day, i) => <DayDot key={day.date ?? i} day={day} />)}
      </View>
      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, done && styles.btnDone, busy && styles.dim]}
          disabled={busy}
          onPress={() => onAct(() => (done ? unlogHabit(habit.id, d) : logHabit(habit.id, d, 'done', null)))}
        >
          <Text style={[styles.btnText, done && styles.btnTextDone]}>{done ? '✓ Done today' : 'Mark done'}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, skipped && styles.btnSkipped, busy && styles.dim]}
          disabled={busy}
          onPress={() => onAct(() => (skipped ? unlogHabit(habit.id, d) : logHabit(habit.id, d, 'skipped', null)))}
        >
          <Text style={styles.btnText}>{skipped ? 'Skipped' : 'Skip'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

function DayDot({ day }: { day: HabitWeekDay }) {
  let color = colors.border // not due
  if (day.log?.status === 'done') color = colors.success
  else if (day.log?.status === 'skipped') color = colors.muted2
  else if (day.due) color = colors.borderStrong // due, not logged
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { padding: space.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  desc: { color: colors.muted, fontSize: 13, marginTop: 2 },
  week: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  dot: { width: 14, height: 14, borderRadius: 7 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  btn: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  btnDone: { borderColor: colors.success, backgroundColor: colors.selected },
  btnSkipped: { borderColor: colors.muted2 },
  btnText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  btnTextDone: { color: colors.success },
  dim: { opacity: 0.5 },
  footer: { height: 40 },
})
