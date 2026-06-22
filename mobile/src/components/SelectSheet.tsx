import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radius, space } from '../theme'
import type { ChipOption, ChipValue } from './ChipRow'

/** A bottom-sheet single-select picker — the mobile equivalent of a dropdown.
 *  Tapping an option selects it and closes the sheet; tapping the backdrop
 *  dismisses without changing the value. */
export function SelectSheet({ visible, title, options, value, onSelect, onClose }: {
  visible: boolean
  title: string
  options: ChipOption[]
  value: ChipValue
  onSelect: (v: ChipValue) => void
  onClose: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stop taps inside the sheet from closing it. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={styles.list} bounces={false}>
            {options.map(o => {
              const selected = o.value === value
              return (
                <Pressable
                  key={String(o.value)}
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  onPress={() => onSelect(o.value)}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{o.label}</Text>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              )
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface2,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: space.xl,
    maxHeight: '70%',
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginTop: space.sm },
  title: { color: colors.muted2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  list: { paddingHorizontal: space.sm },
  option: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: space.md, paddingHorizontal: space.md, borderRadius: radius.md,
  },
  optionPressed: { backgroundColor: colors.surface },
  optionText: { color: colors.textDim, fontSize: 16 },
  optionTextSelected: { color: colors.accent, fontWeight: '600' },
  check: { color: colors.accent, fontSize: 16, fontWeight: '700' },
})
