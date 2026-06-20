import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useLayout } from './hooks/useLayout'
import { TodayScreen } from './screens/TodayScreen'

/**
 * Adaptive shell — the one place phone and tablet layouts diverge.
 *  - twoPane (tablet / regular width): master-detail, mirroring the desktop's
 *    TaskList + DetailPanel.
 *  - compact (phone): single column. TODO: push a detail route on tap once
 *    navigation (e.g. React Navigation / Expo Router) is added.
 */
export function AppShell() {
  const { twoPane } = useLayout()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (twoPane) {
    return (
      <View style={styles.row}>
        <View style={styles.listPane}>
          <TodayScreen selectedId={selectedId} onSelect={setSelectedId} />
        </View>
        <View style={styles.detailPane}>
          <DetailPlaceholder taskId={selectedId} />
        </View>
      </View>
    )
  }

  return <TodayScreen selectedId={selectedId} onSelect={setSelectedId} />
}

function DetailPlaceholder({ taskId }: { taskId: string | null }) {
  return (
    <View style={styles.detailInner}>
      <Text style={styles.detailText}>{taskId ? `Task ${taskId}` : 'Select a task'}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  listPane: { width: 360, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: '#27272a' },
  detailPane: { flex: 1 },
  detailInner: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  detailText: { color: '#71717a', fontSize: 14 },
})
