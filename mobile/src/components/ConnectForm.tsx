import { useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { setActiveInstance, setDefaultInstance, testInstanceConnection, upsertInstance } from '@qalatra/shared'
import { colors, radius, space } from '../theme'

/** Shared "connect a backend" form — used by first-run onboarding and the in-app
 *  Add Backend screen. On success it stores the instance as default + active and
 *  calls onConnected (onboarding relies on App's config listener instead). */
export function ConnectForm({ title, subtitle, onConnected }: { title: string; subtitle: string; onConnected?: () => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect() {
    if (!url.trim() || !token.trim()) {
      setError('Enter both a server URL and an access token.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await testInstanceConnection({ url, token })
      if (!result.ok) {
        setError(result.error ?? 'Could not connect to that server.')
        return
      }
      const instance = upsertInstance({ name: name.trim() || result.name || 'Qalatra', url, token })
      setDefaultInstance(instance.id)
      setActiveInstance(instance.id)
      onConnected?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>

        <Text style={styles.label}>Name (optional)</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="My Qalatra" placeholderTextColor={colors.muted2} autoCapitalize="words" />

        <Text style={styles.label}>Server URL</Text>
        <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="https://qalatra.example.com" placeholderTextColor={colors.muted2} autoCapitalize="none" autoCorrect={false} keyboardType="url" />

        <Text style={styles.label}>Access Token</Text>
        <TextInput style={styles.input} value={token} onChangeText={setToken} placeholder="qal_…" placeholderTextColor={colors.muted2} autoCapitalize="none" autoCorrect={false} secureTextEntry />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable style={[styles.button, busy && styles.dim]} onPress={connect} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect</Text>}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: space.xl, justifyContent: 'center', flexGrow: 1 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: 6 },
  subtitle: { color: colors.muted, fontSize: 14, marginBottom: space.lg },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, marginTop: space.md, textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.surface, borderColor: colors.borderStrong, borderWidth: 1, borderRadius: radius.md,
    color: colors.text, paddingHorizontal: space.md, paddingVertical: 10, fontSize: 16,
  },
  error: { color: colors.danger, marginTop: space.lg, fontSize: 14 },
  button: { backgroundColor: colors.accentStrong, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginTop: space.xl },
  dim: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
})
