import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radius, space } from '../theme'

/** A grouped card of tappable summary rows. Children are <MetaRow> elements;
 *  the first one's divider is suppressed so it doesn't double the card border. */
export function MetaCard({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View style={styles.card}>
      {rows.map((child, i) =>
        i === 0 ? cloneElement(child as ReactElement<{ first?: boolean }>, { first: true }) : child,
      )}
    </View>
  )
}

/** One summary line: label on the left, current value + chevron on the right.
 *  Tapping the row opens a picker. An empty value shows a dimmed placeholder. */
export function MetaRow({ label, value, placeholder = '—', valueColor, first, onPress }: {
  label: string
  value?: string | null
  placeholder?: string
  valueColor?: string | null
  first?: boolean
  onPress: () => void
}) {
  const hasValue = value != null && value !== ''
  return (
    <Pressable style={({ pressed }) => [styles.row, first && styles.rowFirst, pressed && styles.rowPressed]} onPress={onPress}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.valueWrap}>
        <Text
          style={[styles.value, valueColor ? { color: valueColor } : null, !hasValue && styles.placeholder]}
          numberOfLines={1}
        >
          {hasValue ? value : placeholder}
        </Text>
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: space.lg,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowFirst: { borderTopWidth: 0 },
  rowPressed: { backgroundColor: colors.surface2 },
  label: { color: colors.muted, fontSize: 15 },
  valueWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1, marginLeft: space.md },
  value: { color: colors.textDim, fontSize: 15, fontWeight: '500', flexShrink: 1 },
  placeholder: { color: colors.muted2, fontWeight: '400' },
  chevron: { color: colors.muted2, fontSize: 18, marginTop: -2 },
})
