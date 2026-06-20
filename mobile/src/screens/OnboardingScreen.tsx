import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { setActiveInstance, setDefaultInstance, testInstanceConnection, upsertInstance } from '@qalatra/shared'

/**
 * First-run connection: paste a Qalatra backend URL + access token. Validates
 * against the headless API, then stores it as the default/active remote instance.
 * App.tsx's onInstanceConfigChange subscription swaps to the main UI on success.
 */
export function OnboardingScreen() {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Connect to Qalatra</Text>
      <Text style={styles.subtitle}>Enter a server URL and access token from Settings → Access Tokens.</Text>

      <Text style={styles.label}>Name (optional)</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="My Qalatra"
        placeholderTextColor="#52525b"
        autoCapitalize="words"
      />

      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="https://qalatra.example.com"
        placeholderTextColor="#52525b"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <Text style={styles.label}>Access Token</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="qal_…"
        placeholderTextColor="#52525b"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={connect} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect</Text>}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center' },
  title: { color: '#fafafa', fontSize: 24, fontWeight: '700', marginBottom: 6 },
  subtitle: { color: '#a1a1aa', fontSize: 14, marginBottom: 24 },
  label: { color: '#a1a1aa', fontSize: 12, fontWeight: '600', marginBottom: 6, marginTop: 12, textTransform: 'uppercase' },
  input: {
    backgroundColor: '#18181b',
    borderColor: '#3f3f46',
    borderWidth: 1,
    borderRadius: 8,
    color: '#fafafa',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  error: { color: '#f87171', marginTop: 16, fontSize: 14 },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 24,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
})
