import { useEffect, useReducer } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import {
  getActiveInstanceId,
  getInstances,
  onInstanceConfigChange,
  removeInstance,
  setActiveInstance,
  setDefaultInstance,
} from '@qalatra/shared'
import type { TaskStackParamList } from '../navigation/types'
import { Screen } from '../components/ui'
import { colors, radius, space } from '../theme'

type Nav = NativeStackNavigationProp<TaskStackParamList>

export function InstancesScreen() {
  const navigation = useNavigation<Nav>()
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => onInstanceConfigChange(force), [])

  const instances = getInstances()
  const activeId = getActiveInstanceId()

  function switchTo(id: string) {
    setActiveInstance(id)
    setDefaultInstance(id)
  }

  function remove(id: string, name: string) {
    Alert.alert('Remove backend', `Remove the connection to ${name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => removeInstance(id) },
    ])
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        {instances.length === 0 ? (
          <Text style={styles.dim}>No backends yet.</Text>
        ) : (
          instances.map(i => {
            const active = i.id === activeId
            return (
              <Pressable key={i.id} style={[styles.row, active && styles.rowActive]} onPress={() => switchTo(i.id)}>
                <View style={styles.info}>
                  <Text style={styles.name}>
                    {i.name}
                    {active ? <Text style={styles.activeTag}>  · active</Text> : null}
                  </Text>
                  <Text style={styles.url} numberOfLines={1}>{i.url}</Text>
                </View>
                <Pressable hitSlop={10} onPress={() => remove(i.id, i.name)}>
                  <Text style={styles.remove}>Remove</Text>
                </Pressable>
              </Pressable>
            )
          })
        )}
        <Pressable style={styles.add} onPress={() => navigation.navigate('AddInstance')}>
          <Text style={styles.addText}>+ Add backend</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg },
  dim: { color: colors.muted2, fontSize: 14, padding: space.lg },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: space.md, backgroundColor: colors.surface, borderRadius: radius.md, marginBottom: space.sm,
    borderWidth: 1, borderColor: 'transparent',
  },
  rowActive: { borderColor: colors.accent },
  info: { flex: 1, marginRight: space.sm },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  activeTag: { color: colors.accent, fontSize: 13, fontWeight: '400' },
  url: { color: colors.muted, fontSize: 13, marginTop: 2 },
  remove: { color: colors.danger, fontSize: 13 },
  add: { marginTop: space.md, padding: space.md, alignItems: 'center', borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md },
  addText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
})
