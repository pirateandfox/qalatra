import { Component, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radius, space } from './theme'

/** Catches render errors anywhere below it and shows a recoverable message
 *  instead of crashing the app to a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.warn('[qalatra] render error', error)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <View style={styles.root}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.msg}>{this.state.error.message}</Text>
          <Pressable style={styles.btn} onPress={this.reset}>
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      )
    }
    return this.props.children
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: space.sm },
  msg: { color: colors.muted, fontSize: 14, textAlign: 'center', marginBottom: space.xl },
  btn: { backgroundColor: colors.accentStrong, borderRadius: radius.md, paddingVertical: space.md, paddingHorizontal: space.xl },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
