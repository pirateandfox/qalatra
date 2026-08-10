import { useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import {
  accountPortalUrl,
  clearAccountToken,
  completeAccount2FA,
  loginAccount,
} from '@qalatra/shared'
import { colors } from '../theme'

export function AccountScreen({
  mode = 'login',
  message,
  onAuthenticated,
}: {
  mode?: 'login' | 'unlicensed' | 'error'
  message?: string
  onAuthenticated: () => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [tempToken, setTempToken] = useState('')
  const [error, setError] = useState(message ?? '')
  const [busy, setBusy] = useState(false)

  async function signIn() {
    setBusy(true)
    setError('')
    try {
      const result = await loginAccount(email.trim(), password)
      if (result.status === 'requires_2fa') setTempToken(result.tempToken)
      else await onAuthenticated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign in failed.')
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    setBusy(true)
    setError('')
    try {
      await completeAccount2FA(tempToken, code.trim())
      await onAuthenticated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Verification failed.')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'error') {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Qalatra account</Text>
          <Text style={styles.title}>We couldn’t verify your license</Text>
          <Text style={styles.copy}>{message || 'The account service could not be reached.'}</Text>
          <Pressable style={styles.primary} onPress={() => void onAuthenticated()}>
            <Text style={styles.primaryText}>Try again</Text>
          </Pressable>
          <Pressable
            style={styles.secondary}
            onPress={() => {
              clearAccountToken()
              void onAuthenticated()
            }}
          >
            <Text style={styles.secondaryText}>Sign in again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  if (mode === 'unlicensed') {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Qalatra hosted access</Text>
          <Text style={styles.title}>A hosted-app seat is required</Text>
          <Text style={styles.copy}>
            Your account is valid, but it does not have an active Connect seat
            or the admin seat included with a Cloud node. Ask your organization
            owner to assign access in the portal.
          </Text>
          <Pressable
            style={styles.primary}
            onPress={() => void Linking.openURL(accountPortalUrl('/team'))}
          >
            <Text style={styles.primaryText}>Open portal</Text>
          </Pressable>
          <Pressable
            style={styles.secondary}
            onPress={() => {
              clearAccountToken()
              void onAuthenticated()
            }}
          >
            <Text style={styles.secondaryText}>Use another account</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>Qalatra account</Text>
        <Text style={styles.title}>
          {tempToken ? 'Verification code' : 'Sign in to Qalatra'}
        </Text>
        <Text style={styles.copy}>
          {tempToken
            ? 'Use your authenticator code or a backup code.'
            : 'Mobile access follows your Connect seat or the admin seat included with a Cloud node.'}
        </Text>
        {tempToken ? (
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="Verification code"
            placeholderTextColor={colors.muted2}
            autoComplete="one-time-code"
          />
        ) : (
          <>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor={colors.muted2}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
            />
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={colors.muted2}
              secureTextEntry
              autoComplete="current-password"
            />
          </>
        )}
        {!!error && <Text style={styles.error}>{error}</Text>}
        <Pressable
          style={[styles.primary, busy && styles.disabled]}
          disabled={busy}
          onPress={() => void (tempToken ? verify() : signIn())}
        >
          {busy ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.primaryText}>
              {tempToken ? 'Verify' : 'Sign in'}
            </Text>
          )}
        </Pressable>
        {!tempToken && (
          <Pressable
            onPress={() => void Linking.openURL(accountPortalUrl('/register'))}
          >
            <Text style={styles.link}>Create an account</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.bg,
  },
  card: {
    gap: 14,
    padding: 24,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  primary: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  primaryText: { color: colors.bg, fontWeight: '700' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: colors.muted },
  link: { padding: 8, color: colors.accent, textAlign: 'center' },
  error: { color: '#ff8f9c', lineHeight: 20 },
  disabled: { opacity: 0.65 },
})
