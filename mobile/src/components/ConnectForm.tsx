import { useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { setActiveInstance, setDefaultInstance, testInstanceConnection, upsertInstance } from '@qalatra/shared'
import { colors, radius, space } from '../theme'

/** Shared "connect a backend" form — used by first-run onboarding and the in-app
 *  Add Backend screen. On success it stores the instance as default + active and
 *  calls onConnected (onboarding relies on App's config listener instead). */
export function ConnectForm({ title, subtitle, showGuide = false, onConnected }: { title: string; subtitle: string; showGuide?: boolean; onConnected?: () => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(showGuide)

  async function connect() {
    if (!url.trim() || !token.trim()) {
      setError('Enter both a server URL and an access token.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const serverUrl = url.trim()
      const accessToken = token.trim()
      const result = await testInstanceConnection({ url: serverUrl, token: accessToken })
      if (!result.ok) {
        setError('We couldn’t connect. Check the server URL and access token, and make sure your server is online.')
        return
      }
      const instance = upsertInstance({ name: name.trim() || result.name || 'Qalatra', url: serverUrl, token: accessToken })
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
        <View style={styles.mark}><Text style={styles.markText}>Q</Text></View>
        <Text style={styles.eyebrow}>Your workspace, connected</Text>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>

        <View style={styles.guide}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: guideOpen }} onPress={() => setGuideOpen(open => !open)} style={styles.guideToggle}>
            <Text style={styles.guideTitle}>Where do I find my key?</Text>
            <Text style={styles.guideSymbol}>{guideOpen ? '−' : '+'}</Text>
          </Pressable>
          {guideOpen && <View style={styles.steps}>
            <View style={styles.step}>
              <Text style={styles.stepNumber}>1</Text>
              <View style={styles.stepBody}>
                <Text style={styles.stepTitle}>Find your server URL</Text>
                <Text style={styles.stepText}>Use the address of the Qalatra server where your tasks live. If someone manages it for you, ask them for the URL and an access token.</Text>
              </View>
            </View>
            <View style={styles.step}>
              <Text style={styles.stepNumber}>2</Text>
              <View style={styles.stepBody}>
                <Text style={styles.stepTitle}>Create an access token</Text>
                <Text style={styles.stepText}>In Qalatra Desktop, select that server and open Settings → Instances → Access Tokens. Name it “Mobile app”, choose Create full-access token, and copy the token while it’s shown.</Text>
              </View>
            </View>
            <View style={styles.step}>
              <Text style={styles.stepNumber}>3</Text>
              <View style={styles.stepBody}>
                <Text style={styles.stepTitle}>Paste it below</Text>
                <Text style={styles.stepText}>Enter the URL and token, then tap Connect server. We’ll check the connection and open your tasks.</Text>
              </View>
            </View>
            <View style={styles.cloudNote}>
              <Text style={styles.stepTitle}>Using Qalatra Cloud?</Text>
              <Text style={styles.stepText}>Use the Server URL and Access token supplied with your server’s connection credentials.</Text>
            </View>
          </View>}
        </View>

        <View style={styles.form}>
        <Text accessibilityRole="header" style={styles.formTitle}>Add your server</Text>
        <Text style={styles.label}>Server name (optional)</Text>
        <TextInput accessibilityLabel="Server name (optional)" editable={!busy} style={styles.input} value={name} onChangeText={setName} placeholder="My Qalatra" placeholderTextColor={colors.muted2} autoCapitalize="words" />

        <Text style={styles.label}>Server URL</Text>
        <TextInput accessibilityLabel="Server URL" editable={!busy} style={styles.input} value={url} onChangeText={setUrl} placeholder="https://qalatra.example.com" placeholderTextColor={colors.muted2} autoCapitalize="none" autoCorrect={false} keyboardType="url" />

        <Text style={styles.label}>Access Token</Text>
        <TextInput accessibilityLabel="Access token" editable={!busy} style={styles.input} value={token} onChangeText={setToken} placeholder="qalatra_…" placeholderTextColor={colors.muted2} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        <Text style={styles.hint}>This is the key issued by your server. Your Qalatra account password won’t work here.</Text>

        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

        <Pressable accessibilityRole="button" accessibilityLabel={busy ? 'Connecting' : 'Connect server'} accessibilityState={{ disabled: busy, busy }} style={[styles.button, busy && styles.dim]} onPress={connect} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect server</Text>}
        </Pressable>
        <Text style={styles.hint}>Your connection is saved on this device. You can manage it later under More → Backends (switch / add).</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: space.xl, justifyContent: 'center', flexGrow: 1, width: '100%', maxWidth: 620, alignSelf: 'center' },
  mark: { width: 44, height: 44, borderRadius: radius.lg, backgroundColor: colors.selected, alignItems: 'center', justifyContent: 'center', marginBottom: space.xl },
  markText: { color: colors.accent, fontSize: 26, fontWeight: '700' },
  eyebrow: { color: colors.muted, fontSize: 11, letterSpacing: 1.3, textTransform: 'uppercase', marginBottom: space.sm },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: 6 },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: space.xl },
  guide: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, marginBottom: space.xl },
  guideToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.lg, minHeight: 48, gap: space.md },
  guideTitle: { color: colors.text, fontSize: 15, fontWeight: '600', flex: 1 },
  guideSymbol: { color: colors.accent, fontSize: 22 },
  steps: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.lg },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepNumber: { color: colors.accent, fontSize: 13, fontWeight: '700', paddingTop: 2, width: 16 },
  stepBody: { flex: 1 },
  stepTitle: { color: colors.textDim, fontSize: 14, fontWeight: '600', marginBottom: space.xs },
  stepText: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  cloudNote: { padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface2 },
  form: { padding: space.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg },
  formTitle: { color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: space.xs },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: space.md },
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
