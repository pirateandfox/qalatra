// Configure the shared platform adapter before anything touches @qalatra/shared.
import './src/platform.native'

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { DarkTheme, NavigationContainer, type Theme } from '@react-navigation/native'
import {
  getAccountEntitlement,
  getAccountToken,
  getActiveInstance,
  hydrateAccount,
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

type Boot = 'loading' | 'account' | 'unlicensed' | 'account_error' | 'onboarding' | 'main'

export default function App() {
  const [boot, setBoot] = useState<Boot>('loading')
  const [accountError, setAccountError] = useState('')

  // Mobile is remote-only: with no active/default backend, go to onboarding.
  const evaluate = useCallback(() => {
    setBoot(getActiveInstance() ? 'main' : 'onboarding')
  }, [])

  const evaluateAccount = useCallback(async () => {
    if (!getAccountToken()) {
      setBoot('account')
      return
    }
    setBoot('loading')
    try {
      const entitlement = await getAccountEntitlement()
      if (!entitlement?.active || !entitlement.hasSeat) {
        setBoot('unlicensed')
        return
      }
      setAccountError('')
      evaluate()
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'Could not verify your license.')
      setBoot('account_error')
    }
  }, [evaluate])

  useEffect(() => {
    let active = true
    // Warm both caches before rendering: instances decide onboarding vs main,
    // and the nav config decides the initial tab + which sections render.
    Promise.all([hydrateAccount(), hydrateInstances(), hydrateNavConfig()]).then(() => {
      if (active) void evaluateAccount()
    })
    const unsubscribe = onInstanceConfigChange(evaluate)
    return () => {
      active = false
      unsubscribe()
    }
  }, [evaluateAccount])

  return (
    <GestureHandlerRootView style={styles.flex}>
    <SafeAreaProvider>
      <ErrorBoundary>
      <StatusBar barStyle="light-content" />
      {boot === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      ) : boot === 'account' ? (
        <AccountScreen onAuthenticated={evaluateAccount} />
      ) : boot === 'unlicensed' ? (
        <AccountScreen mode="unlicensed" onAuthenticated={evaluateAccount} />
      ) : boot === 'account_error' ? (
        <AccountScreen mode="error" message={accountError} onAuthenticated={evaluateAccount} />
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
