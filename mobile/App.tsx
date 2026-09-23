// Configure the shared platform adapter before anything touches @qalatra/shared.
import './src/platform.native'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, AppState, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { DarkTheme, NavigationContainer, type Theme } from '@react-navigation/native'
import {
  createAccountAccessController,
  clearAccountToken,
  getActiveInstance,
  hydrateInstances,
  onInstanceConfigChange,
} from '@qalatra/shared'
import { hydrateNavConfig } from './src/lib/navConfig'
import { OnboardingScreen } from './src/screens/OnboardingScreen'
import { RootNavigator } from './src/navigation/RootNavigator'
import { ErrorBoundary } from './src/ErrorBoundary'
import { colors } from './src/theme'
import { AccountScreen } from './src/screens/AccountScreen'

const navTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
}

export default function App() {
  const [access] = useState(() => createAccountAccessController())
  const account = useSyncExternalStore(access.subscribe, access.getSnapshot)
  const connected = useSyncExternalStore(onInstanceConfigChange, () => !!getActiveInstance())
  const [ready, setReady] = useState(false)
  const [backendError, setBackendError] = useState('')
  const loadBackendState = useCallback(async () => {
    setBackendError('')
    try {
      await Promise.all([hydrateInstances(), hydrateNavConfig()])
      setReady(true)
    } catch {
      setBackendError('Could not load your connections. Please try again.')
    }
  }, [])

  useEffect(() => {
    const stop = access.start()
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void access.check()
    })
    void loadBackendState()
    return () => { stop(); listener.remove() }
  }, [access, loadBackendState])

  return (
    <GestureHandlerRootView style={styles.flex}>
    <SafeAreaProvider>
      <ErrorBoundary>
      <StatusBar barStyle="light-content" />
      {account.status === 'checking' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      ) : account.status === 'login' ? (
        <AccountScreen onAuthenticated={access.check} />
      ) : account.status === 'unlicensed' ? (
        <AccountScreen mode="unlicensed" onAuthenticated={access.check} />
      ) : account.status === 'error' ? (
        <AccountScreen mode="error" message={account.message} onAuthenticated={access.check} />
      ) : !ready ? (
        <View style={styles.center}>
          {backendError ? <><Text style={{ color: colors.text }}>{backendError}</Text><Pressable onPress={() => void loadBackendState()}><Text style={{ color: colors.accent }}>Try again</Text></Pressable></> : <ActivityIndicator color={colors.muted} />}
        </View>
      ) : !connected ? (
        <View style={styles.flex}>
          <OnboardingScreen />
          <Pressable onPress={clearAccountToken} style={{ padding: 16, backgroundColor: colors.bg }}><Text style={{ color: colors.accent, textAlign: 'center' }}>Sign out of Qalatra</Text></Pressable>
        </View>
      ) : (
        <NavigationContainer theme={navTheme}>
          <RootNavigator />
        </NavigationContainer>
      )}
      </ErrorBoundary>
    </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
})
