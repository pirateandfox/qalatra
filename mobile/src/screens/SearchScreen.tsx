import { useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { searchTasks, type Task } from '@qalatra/shared'
import type { TaskStackParamList } from '../navigation/types'
import { TaskRow } from '../components/TaskRow'
import { Screen } from '../components/ui'
import { ChipRow, type ChipValue } from '../components/ChipRow'
import { colors, space } from '../theme'

type Nav = NativeStackNavigationProp<TaskStackParamList>

export function SearchScreen() {
  const navigation = useNavigation<Nav>()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ChipValue>('open')
  const [results, setResults] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setSearched(false)
      return
    }
    setLoading(true)
    const handle = setTimeout(async () => {
      try {
        setResults(await searchTasks(q, scope === 'all' ? 'all' : 'open'))
      } catch {
        setResults([])
      } finally {
        setLoading(false)
        setSearched(true)
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [query, scope])

  return (
    <Screen>
      <View style={styles.searchBar}>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Search tasks…"
          placeholderTextColor={colors.muted2}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="search"
        />
      </View>
      <ChipRow
        label=""
        value={scope}
        options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]}
        onChange={setScope}
      />
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.muted} /></View>
      ) : (
        <FlatList
          style={styles.flex}
          data={results}
          keyExtractor={t => t.id}
          renderItem={({ item }) => <TaskRow task={item} onPress={() => navigation.navigate('TaskDetail', { taskId: item.id })} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.dim}>{searched ? 'No matches.' : 'Type to search your tasks.'}</Text>
            </View>
          }
        />
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchBar: { padding: space.lg, paddingBottom: 0 },
  input: {
    backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 8,
    color: colors.textDim, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 16,
  },
  center: { alignItems: 'center', justifyContent: 'center', padding: space.xl },
  dim: { color: colors.muted2, fontSize: 14 },
})
