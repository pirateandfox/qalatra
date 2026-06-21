import { useCallback } from 'react'
import { FlatList, RefreshControl } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { Task } from '@qalatra/shared'
import type { TaskStackParamList } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { TaskRow } from './TaskRow'
import { Loading, ErrorView, EmptyView, Screen } from './ui'
import { colors } from '../theme'

type Nav = NativeStackNavigationProp<TaskStackParamList>

const flexStyle = { flex: 1 }

export function TaskListView({ loader, emptyMessage }: { loader: () => Promise<Task[]>; emptyMessage: string }) {
  const navigation = useNavigation<Nav>()
  const { data, loading, refreshing, error, reload, refresh } = useLoader(loader)
  useFocusEffect(useCallback(() => { void reload() }, [reload]))

  if (loading) return <Loading />
  if (error) return <ErrorView message={error} onRetry={reload} />
  const tasks = data ?? []
  if (!tasks.length) return <EmptyView message={emptyMessage} />

  return (
    <Screen>
      <FlatList
        style={flexStyle}
        data={tasks}
        keyExtractor={t => t.id}
        renderItem={({ item }) => (
          <TaskRow task={item} onPress={() => navigation.navigate('TaskDetail', { taskId: item.id })} />
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
      />
    </Screen>
  )
}
