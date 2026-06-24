import { useEffect } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Sharing from 'expo-sharing'
import * as FileSystem from 'expo-file-system/legacy'
import { currentServerInstance, listDirectory, listWorkspaceRoots, type DirectoryEntry } from '@qalatra/shared'
import type { FileBrowserProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { EmptyView, ErrorView, Loading, Screen } from '../components/ui'
import { colors, space } from '../theme'

function humanSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Browse the backend's workspace files. With no path it lists workspace roots;
 *  otherwise it lists a directory. Folders push deeper; `.md` files open in the
 *  in-app reader/editor; anything else downloads and opens in the share/preview
 *  sheet. All over the existing /api/files endpoints — no server changes. */
export function FileBrowserScreen({ route, navigation }: FileBrowserProps) {
  const { path, title } = route.params ?? {}
  const { data, loading, error, reload, refresh, refreshing } = useLoader(async () => {
    if (!path) {
      const roots = await listWorkspaceRoots()
      const entries: DirectoryEntry[] = roots
        .filter(r => r.exists && r.isDirectory)
        .map(r => ({ name: r.name, path: r.path, type: 'directory', size: null, modifiedAt: null, extension: '' }))
      return { entries }
    }
    const res = await listDirectory(path)
    return { entries: res.entries }
  }, [path])

  useEffect(() => {
    navigation.setOptions({ title: title ?? 'Files' })
  }, [navigation, title])

  async function openFile(entry: DirectoryEntry) {
    const inst = await currentServerInstance()
    const dir = FileSystem.cacheDirectory
    if (!dir) throw new Error('No cache directory available')
    const safeName = (entry.name || 'file').replace(/[^\w.\-]+/g, '_')
    const { uri } = await FileSystem.downloadAsync(
      `${inst.url.replace(/\/$/, '')}/api/files/content?path=${encodeURIComponent(entry.path)}`,
      `${dir}${safeName}`,
      { headers: { Authorization: `Bearer ${inst.token}` } },
    )
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
    else Alert.alert('Downloaded', uri)
  }

  function open(entry: DirectoryEntry) {
    if (entry.type === 'directory') {
      navigation.push('FileBrowser', { path: entry.path, title: entry.name })
    } else if (entry.extension.toLowerCase() === 'md') {
      navigation.navigate('MarkdownViewer', { path: entry.path, title: entry.name })
    } else {
      openFile(entry).catch(err => Alert.alert('Could not open', err instanceof Error ? err.message : String(err)))
    }
  }

  if (loading) return <Loading />
  if (error) return <ErrorView message={error} onRetry={reload} />

  const entries = [...(data?.entries ?? [])].sort(
    (a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name),
  )

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
      >
        {entries.length === 0 ? (
          <EmptyView message="Empty folder." />
        ) : (
          entries.map(entry => {
            const isDir = entry.type === 'directory'
            return (
              <Pressable key={entry.path} style={styles.row} onPress={() => open(entry)}>
                <Text style={styles.icon}>{isDir ? '📁' : entry.extension.toLowerCase() === 'md' ? '📄' : '📃'}</Text>
                <Text style={styles.name} numberOfLines={1}>{entry.name}</Text>
                {isDir ? <Text style={styles.chevron}>›</Text> : <Text style={styles.size}>{humanSize(entry.size)}</Text>}
              </Pressable>
            )
          })
        )}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.sm, flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  icon: { fontSize: 18 },
  name: { color: colors.textDim, fontSize: 16, flex: 1 },
  chevron: { color: colors.muted2, fontSize: 20 },
  size: { color: colors.muted2, fontSize: 13 },
})
