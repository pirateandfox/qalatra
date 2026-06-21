// Configure the shared platform adapter before anything touches @qalatra/shared.
import './src/platform.native'

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { DarkTheme, NavigationContainer, type Theme } from '@react-navigation/native'
import { getActiveInstance, hydrateInstances, onInstanceConfigChange } from '@qalatra/shared'
import { OnboardingScreen } from './src/screens/OnboardingScreen'
import { RootNavigator } from './src/navigation/RootNavigator'
import { ErrorBoundary } from './src/ErrorBoundary'
import { colors } from './src/theme'

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

type Boot = 'loading' | 'onboarding' | 'main'

export default function App() {
  const [boot, setBoot] = useState<Boot>('loading')

  // Mobile is remote-only: with no active/default backend, go to onboarding.
  const evaluate = useCallback(() => {
    setBoot(getActiveInstance() ? 'main' : 'onboarding')
  }, [])

  useEffect(() => {
    let active = true
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
    <GestureHandlerRootView style={styles.flex}>
    <SafeAreaProvider>
      <ErrorBoundary>
      <StatusBar barStyle="light-content" />
      {boot === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      ) : boot === 'onboarding' ? (
        <OnboardingScreen />
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
