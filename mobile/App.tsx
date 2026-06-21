// Configure the shared platform adapter before anything touches @qalatra/shared.
import './src/platform.native'

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { getActiveInstance, hydrateInstances, onInstanceConfigChange } from '@qalatra/shared'
import { OnboardingScreen } from './src/screens/OnboardingScreen'
import { AppShell } from './src/AppShell'

type Boot = 'loading' | 'onboarding' | 'main'

export default function App() {
  const [boot, setBoot] = useState<Boot>('loading')

  // Mobile is remote-only: with no active/default backend, send the user to
  // onboarding to paste a server URL + token.
  const evaluate = useCallback(() => {
    setBoot(getActiveInstance() ? 'main' : 'onboarding')
  }, [])

  useEffect(() => {
    let active = true
    // Warm the AsyncStorage-backed cache before reading instance state.
    hydrateInstances().then(() => {
      if (active) evaluate()
    })
    const unsubscribe = onInstanceConfigChange(evaluate)
    return () => {
      active = false
      unsubscribe()
    }
  }, [evaluate])

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" />
        {boot === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : boot === 'onboarding' ? (
          <OnboardingScreen />
        ) : (
          <AppShell />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0b0d' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
