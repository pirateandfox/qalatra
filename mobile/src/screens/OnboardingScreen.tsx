import { SafeAreaView } from 'react-native-safe-area-context'
import { StyleSheet } from 'react-native'
import { ConnectForm } from '../components/ConnectForm'
import { colors } from '../theme'

/**
 * First-run connection. App.tsx's onInstanceConfigChange subscription swaps to the
 * main UI once a backend is stored, so no onConnected callback is needed here.
 */
export function OnboardingScreen() {
  return (
    <SafeAreaView style={styles.root}>
      <ConnectForm
        title="Connect to Qalatra"
        subtitle="Enter a server URL and access token from Settings → Access Tokens."
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
})
