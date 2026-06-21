import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Task } from '@qalatra/shared'
import { fmtTime } from '@qalatra/shared'
import { colors, ENERGY_ICONS, priorityColor, radius, space } from '../theme'
import { Dot } from './ui'

function dueLabel(task: Task): string | null {
  if (task.task_type === 'event') return task.event_time ? fmtTime(task.event_time) : null
  if (task.due_date) return task.due_date
  return null
}

export function TaskRow({ task, selected, onPress }: { task: Task; selected?: boolean; onPress: () => void }) {
  const pColor = priorityColor(task.my_priority)
  const due = dueLabel(task)
  const energy = task.energy_required ? ENERGY_ICONS[task.energy_required] : null
  const done = task.status === 'done'

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, selected && styles.selected, pressed && styles.pressed]}
    >
      <View style={styles.leading}>
        {pColor ? <Dot color={pColor} /> : <View style={styles.dotSpacer} />}
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, done && styles.titleDone]} numberOfLines={2}>
          {task.title}
        </Text>
        <View style={styles.meta}>
          {task.context ? <Text style={styles.metaText}>{task.context}</Text> : null}
          {task.project ? <Text style={styles.metaText}>· {task.project}</Text> : null}
          {due ? <Text style={styles.metaText}>· {due}</Text> : null}
          {task.hard_deadline ? <Text style={styles.deadline}>· hard</Text> : null}
          {energy ? <Text style={styles.metaText}> {energy}</Text> : null}
        </View>
      </View>
      {task.blocked ? <Text style={styles.blocked}>blocked</Text> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: space.md,
  },
  selected: { backgroundColor: colors.selected },
  pressed: { backgroundColor: colors.surface },
  leading: { paddingTop: 5 },
  dotSpacer: { width: 8, height: 8 },
  body: { flex: 1 },
  title: { color: colors.textDim, fontSize: 16, lineHeight: 21 },
  titleDone: { color: colors.muted2, textDecorationLine: 'line-through' },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 3, gap: 3 },
  metaText: { color: colors.muted2, fontSize: 12 },
  deadline: { color: colors.danger, fontSize: 12 },
  blocked: { color: colors.danger, fontSize: 11, fontWeight: '600' },
  radius: { borderRadius: radius.sm },
})
