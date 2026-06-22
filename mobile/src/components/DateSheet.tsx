import { useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { today } from '@qalatra/shared'
import { nextWeekStart, thisWeekend, tomorrow } from '../lib/dates'
import { colors, radius, space } from '../theme'

/** Parse a YYYY-MM-DD string to a local Date anchored at noon (avoids the
 *  off-by-one that midnight-UTC parsing causes in western timezones). */
function isoToDate(iso: string | null): Date {
  return new Date((iso || today()) + 'T12:00:00')
}
function dateToIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** A bottom-sheet date picker with quick presets above a native calendar.
 *  `onChange` persists the new value (or null to clear); the sheet manages its
 *  own dismissal. On iOS the calendar is inline; on Android it opens the system
 *  date dialog. */
export function DateSheet({ visible, title, value, onChange, onClose }: {
  visible: boolean
  title: string
  value: string | null
  onChange: (iso: string | null) => void
  onClose: () => void
}) {
  const [androidOpen, setAndroidOpen] = useState(false)

  function pick(iso: string | null) {
    onChange(iso)
    onClose()
  }

  // Android renders the calendar as a system dialog, so the preset chips live in
  // our own sheet and a "Pick a date…" button launches the native dialog.
  function onAndroidChange(e: DateTimePickerEvent, d?: Date) {
    setAndroidOpen(false)
    if (e.type === 'set' && d) pick(dateToIso(d))
  }

  // The Android system dialog renders independently of our sheet's visibility.
  const androidPicker = androidOpen ? (
    <DateTimePicker mode="date" value={isoToDate(value)} onChange={onAndroidChange} />
  ) : null

  if (!visible) return androidPicker

  return (
    <>
      {androidPicker}
      <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>

          <View style={styles.quickRow}>
            <Quick label="Today" active={value === today()} onPress={() => pick(today())} />
            <Quick label="Tomorrow" active={value === tomorrow()} onPress={() => pick(tomorrow())} />
            <Quick label="Weekend" active={value === thisWeekend()} onPress={() => pick(thisWeekend())} />
            <Quick label="Next wk" active={value === nextWeekStart()} onPress={() => pick(nextWeekStart())} />
          </View>

          {Platform.OS === 'ios' ? (
            <DateTimePicker
              mode="date"
              display="inline"
              value={isoToDate(value)}
              themeVariant="dark"
              accentColor={colors.accent}
              onChange={(_e, d) => d && onChange(dateToIso(d))}
              style={styles.picker}
            />
          ) : (
            <Pressable style={styles.androidBtn} onPress={() => setAndroidOpen(true)}>
              <Text style={styles.androidBtnText}>{value ? value : 'Pick a date…'}</Text>
            </Pressable>
          )}

          <View style={styles.footerRow}>
            <Pressable style={styles.footerBtn} onPress={() => pick(null)}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
            <Pressable style={styles.footerBtn} onPress={onClose}>
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
      </Modal>
    </>
  )
}

function Quick({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.quick, active && styles.quickActive]}>
      <Text style={[styles.quickText, active && styles.quickTextActive]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface2,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: space.xl,
    paddingHorizontal: space.lg,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginTop: space.sm },
  title: { color: colors.muted2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, paddingTop: space.md, paddingBottom: space.sm },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  quick: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  quickActive: { borderColor: colors.accent, backgroundColor: colors.selected },
  quickText: { color: colors.muted, fontSize: 13 },
  quickTextActive: { color: colors.accent, fontWeight: '600' },
  picker: { alignSelf: 'stretch' },
  androidBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', backgroundColor: colors.surface },
  androidBtnText: { color: colors.textDim, fontSize: 16 },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.md },
  footerBtn: { paddingVertical: space.sm, paddingHorizontal: space.md },
  clearText: { color: colors.danger, fontSize: 15, fontWeight: '600' },
  doneText: { color: colors.accent, fontSize: 15, fontWeight: '700' },
})
