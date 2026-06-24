import { useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { createTerminalSession, listWorkspaceRoots, type WorkspaceRoot } from '@qalatra/shared'
import type { CreateTerminalProps } from '../navigation/types'
import { useLoader } from '../lib/useLoader'
import { Screen } from '../components/ui'
import { colors, radius, space } from '../theme'

/** Start a new tmux terminal session on the backend, optionally named and rooted
 *  at a chosen working directory (handy for jumping straight to a box service). */
export function CreateTerminalScreen({ navigation }: CreateTerminalProps) {
  const { data: roots } = useLoader(() => listWorkspaceRoots().catch(() => [] as WorkspaceRoot[]), [])
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      const session = await createTerminalSession({ title: title.trim() || undefined, cwd: cwd.trim() || undefined })
      navigation.replace('TerminalSession', { sessionId: session.id, title: session.title })
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const usableRoots = (roots ?? []).filter(r => r.exists && r.isDirectory)

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Terminal"
            placeholderTextColor={colors.muted2}
            autoFocus
          />

          <Text style={styles.label}>Working directory</Text>
          <TextInput
            style={styles.input}
            value={cwd}
            onChangeText={setCwd}
            placeholder="default workspace root"
            placeholderTextColor={colors.muted2}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {usableRoots.length > 0 ? (
            <View style={styles.chips}>
              {usableRoots.map(r => (
                <Pressable key={r.path} style={styles.chip} onPress={() => setCwd(r.path)}>
                  <Text style={styles.chipText}>{r.name}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <Pressable style={[styles.submit, busy && styles.dim]} onPress={create} disabled={busy}>
            <Text style={styles.submitText}>{busy ? 'Starting…' : 'Start Terminal'}</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.lg },
  label: { color: colors.muted2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space.lg, marginBottom: space.sm },
  input: {
    backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md,
    color: colors.textDim, padding: space.md, fontSize: 16,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  chipText: { color: colors.muted, fontSize: 13 },
  submit: { backgroundColor: colors.accentStrong, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.xl },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.5 },
})
