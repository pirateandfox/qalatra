import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { getActiveInstance, removeInstance } from '@qalatra/shared'
import type { TaskStackParamList } from '../navigation/types'
import { Screen } from '../components/ui'
import { colors, radius, space } from '../theme'

type Nav = NativeStackNavigationProp<TaskStackParamList>

export function MoreScreen() {
  const navigation = useNavigation<Nav>()
  const active = getActiveInstance()

  function disconnect() {
    Alert.alert(
      'Disconnect',
      `Remove the connection to ${active?.name ?? 'this backend'}? You'll need its URL + token to reconnect.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: () => active && removeInstance(active.id) },
      ],
    )
  }

  return (
    <Screen>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <Text style={styles.section}>Daily</Text>
        <Row label="Daily Note" onPress={() => navigation.navigate('DailyNote')} />
        <Row label="Habits" onPress={() => navigation.navigate('Habits')} />

        <Text style={styles.section}>Lists</Text>
        <Row label="Backlog" onPress={() => navigation.navigate('Backlog')} />
        <Row label="Code" onPress={() => navigation.navigate('Code')} />

        <Text style={styles.section}>Connection</Text>
        <View style={styles.card}>
          <Text style={styles.name}>{active?.name ?? 'Not connected'}</Text>
          {active?.url ? <Text style={styles.url}>{active.url}</Text> : null}
        </View>
        <Row label="Disconnect" destructive onPress={disconnect} />
      </ScrollView>
    </Screen>
  )
}

function Row({ label, onPress, destructive }: { label: string; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      <Text style={[styles.rowLabel, destructive && styles.destructive]}>{label}</Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingVertical: space.md },
  section: { color: colors.muted2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: space.lg, marginTop: space.lg, marginBottom: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.surface },
  rowLabel: { color: colors.textDim, fontSize: 16 },
  destructive: { color: colors.danger },
  chevron: { color: colors.muted2, fontSize: 20 },
  card: { marginHorizontal: space.lg, padding: space.md, backgroundColor: colors.surface, borderRadius: radius.md },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  url: { color: colors.muted, fontSize: 13, marginTop: 2 },
})
