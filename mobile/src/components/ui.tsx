import type { ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { colors, radius, space } from '../theme'

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>
}

export function Loading() {
  return (
    <Centered>
      <ActivityIndicator color={colors.muted} />
    </Centered>
  )
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Centered>
      <Text style={styles.errorText}>{message}</Text>
      {onRetry ? <Text style={styles.retry} onPress={onRetry}>Tap to retry</Text> : null}
    </Centered>
  )
}

export function EmptyView({ message }: { message: string }) {
  return (
    <Centered>
      <Text style={styles.emptyText}>{message}</Text>
    </Centered>
  )
}

export function Badge({ label, color }: { label: string; color?: string }) {
  return (
    <View style={[styles.badge, color ? { borderColor: color } : null]}>
      <Text style={[styles.badgeText, color ? { color } : null]}>{label}</Text>
    </View>
  )
}

export function Dot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  errorText: { color: colors.danger, fontSize: 14, textAlign: 'center' },
  retry: { color: colors.accent, fontSize: 14, marginTop: space.md },
  emptyText: { color: colors.muted2, fontSize: 14, textAlign: 'center' },
  badge: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
})
