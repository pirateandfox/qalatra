import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radius, space } from '../theme'
import type { ChipOption, ChipValue } from './ChipRow'

/** A bottom-sheet single-select picker — the mobile equivalent of a dropdown.
 *  Tapping an option selects it and closes the sheet; tapping the backdrop
 *  dismisses without changing the value. */
export function SelectSheet({ visible, title, options, value, onSelect, onClose, searchable = false, searchPlaceholder = 'Search…', emptyText = 'No matches' }: {
  visible: boolean
  title: string
  options: ChipOption[]
  value: ChipValue
  onSelect: (v: ChipValue) => void
  onClose: () => void
  searchable?: boolean
  searchPlaceholder?: string
  emptyText?: string
}) {
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!visible) setQuery('')
  }, [visible])

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return options
    return options.filter(option => {
      const haystack = `${option.label} ${option.sublabel ?? ''}`.toLowerCase()
      return terms.every(term => haystack.includes(term))
    })
  }, [options, query])

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stop taps inside the sheet from closing it. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          {searchable ? (
            <View style={styles.searchWrap}>
              <TextInput
                style={styles.search}
                value={query}
                onChangeText={setQuery}
                placeholder={searchPlaceholder}
                placeholderTextColor={colors.muted2}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          ) : null}
          <ScrollView style={styles.list} bounces={false}>
            {filtered.length === 0 ? (
              <Text style={styles.empty}>{emptyText}</Text>
            ) : null}
            {filtered.map(o => {
              const selected = o.value === value
              return (
                <Pressable
                  key={String(o.value)}
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  onPress={() => onSelect(o.value)}
                >
                  <View style={styles.optionTextWrap}>
                    <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{o.label}</Text>
                    {o.sublabel ? <Text style={styles.optionSublabel} numberOfLines={1}>{o.sublabel}</Text> : null}
                  </View>
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
  searchWrap: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.textDim,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 15,
  },
  list: { paddingHorizontal: space.sm },
  option: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: space.md, paddingHorizontal: space.md, borderRadius: radius.md,
  },
  optionPressed: { backgroundColor: colors.surface },
  optionTextWrap: { flex: 1, marginRight: space.md },
  optionText: { color: colors.textDim, fontSize: 16 },
  optionTextSelected: { color: colors.accent, fontWeight: '600' },
  optionSublabel: { color: colors.muted2, fontSize: 12, marginTop: 2 },
  check: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  empty: { color: colors.muted2, fontSize: 14, textAlign: 'center', paddingVertical: space.lg },
})
