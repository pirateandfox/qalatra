import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radius, space } from '../theme'

export type ChipValue = string | number | null
export type ChipOption = { value: ChipValue; label: string }

/** A labeled, horizontally-scrolling single-select chip row. */
export function ChipRow({ label, options, value, onChange }: {
  label: string
  options: ChipOption[]
  value: ChipValue
  onChange: (v: ChipValue) => void
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {options.map(o => {
          const selected = o.value === value
          return (
            <Pressable
              key={String(o.value)}
              onPress={() => onChange(o.value)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{o.label}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}

/** A row of tappable action buttons (e.g. snooze/due quick-sets). */
export function ButtonRow({ label, actions }: { label: string; actions: { label: string; onPress: () => void }[] }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {actions.map(a => (
          <Pressable key={a.label} onPress={a.onPress} style={styles.chip}>
            <Text style={styles.chipText}>{a.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { marginTop: space.lg },
  label: { color: colors.muted2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: space.sm },
  chips: { gap: space.sm, paddingRight: space.lg },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.selected },
  chipText: { color: colors.muted, fontSize: 13 },
  chipTextSelected: { color: colors.accent, fontWeight: '600' },
})
