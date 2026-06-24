import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { killTerminalSession, listTerminalSessions, type TerminalSession } from '@qalatra/shared'
import type { TerminalListProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { EmptyView, ErrorView, Loading, Screen } from '../components/ui'
import { colors, radius, space } from '../theme'

/** Lists the backend's tmux terminal sessions (shared with desktop). Tap a
 *  running one to open it; create new ones; kill/remove dead or unwanted ones. */
export function TerminalListScreen({ navigation }: TerminalListProps) {
  const { data, loading, error, reload, refresh, refreshing } = useLoader(() => listTerminalSessions(), [])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={() => navigation.navigate('CreateTerminal')} hitSlop={8}>
          <Text style={styles.headerNew}>＋ New</Text>
        </Pressable>
      ),
    })
  }, [navigation])

  // Refresh when returning from creating/opening/killing a session.
  useEffect(() => navigation.addListener('focus', reload), [navigation, reload])

  const open = useCallback(
    (s: TerminalSession) => {
      if (s.status !== 'running') {
        Alert.alert('Session exited', 'This terminal has stopped and can’t be reattached. Remove it or start a new one.')
        return
      }
      navigation.navigate('TerminalSession', { sessionId: s.id, title: s.title })
    },
    [navigation],
  )

  const remove = useCallback(
    (s: TerminalSession) => {
      Alert.alert(s.status === 'running' ? 'Kill session?' : 'Remove session?', s.title, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: s.status === 'running' ? 'Kill' : 'Remove',
          style: 'destructive',
          onPress: async () => {
            setBusy(true)
            try {
              await killTerminalSession(s.id)
              await reload()
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : String(err))
            } finally {
              setBusy(false)
            }
          },
        },
      ])
    },
    [reload],
  )

  if (loading) return <Loading />
  if (error) return <ErrorView message={error} onRetry={reload} />
  if (data && !data.tmux.ok) {
    return <ErrorView message={data.tmux.error || 'tmux is required on the backend for terminals.'} onRetry={reload} />
  }

  const sessions = data?.sessions ?? []

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
      >
        {sessions.length === 0 ? (
          <EmptyView message={'No terminal sessions.\nTap ＋ New to start one.'} />
        ) : (
          sessions.map(s => (
            <View key={s.id} style={styles.row}>
              <Pressable style={styles.rowMain} onPress={() => open(s)} disabled={busy}>
                <View style={[styles.dot, { backgroundColor: s.status === 'running' ? colors.success : colors.muted2 }]} />
                <View style={styles.rowText}>
                  <Text style={styles.title} numberOfLines={1}>{s.title}</Text>
                  <Text style={styles.cwd} numberOfLines={1}>{s.cwd}</Text>
                </View>
                {s.status === 'running' ? <Text style={styles.open}>open ›</Text> : <Text style={styles.exited}>exited</Text>}
              </Pressable>
              <Pressable onPress={() => remove(s)} hitSlop={8} disabled={busy}>
                <Text style={styles.kill}>✕</Text>
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.sm, flexGrow: 1 },
  headerNew: { color: colors.accent, fontSize: 16, fontWeight: '600', marginRight: space.md },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: space.md, gap: space.md },
  dot: { width: 9, height: 9, borderRadius: 5 },
  rowText: { flex: 1 },
  title: { color: colors.text, fontSize: 16, fontWeight: '500' },
  cwd: { color: colors.muted2, fontSize: 13, marginTop: 2 },
  open: { color: colors.accent, fontSize: 13 },
  exited: { color: colors.muted2, fontSize: 13 },
  kill: { color: colors.muted2, fontSize: 16, paddingLeft: space.lg, paddingVertical: space.md },
})
