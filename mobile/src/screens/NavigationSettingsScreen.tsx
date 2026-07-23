import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { getActiveInstance } from '@qalatra/shared'
import { Screen } from '../components/ui'
import {
  NAV_ITEMS,
  setNavConfig,
  useNavConfig,
  type NavConfigItem,
  type NavSection,
  type TabSection,
} from '../lib/navConfig'
import { colors, radius, space } from '../theme'

export function NavigationSettingsScreen() {
  const config = useNavConfig()
  const hidden = new Set(config.hidden)
  const backendName = getActiveInstance()?.name ?? 'this backend'

  function toggleVisible(key: NavSection) {
    if (config.landing === key) return // the default tab can't be hidden
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setNavConfig({ ...config, hidden: [...next], landing: config.landing })
  }

  function setLanding(key: TabSection) {
    // Making a tab the default also unhides it (normalize enforces this).
    setNavConfig({ ...config, hidden: config.hidden, landing: key })
  }

  const tabs = NAV_ITEMS.filter(i => i.level === 'tab')
  const more = NAV_ITEMS.filter(i => i.level === 'more')

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.intro}>
          Configuring navigation for {backendName}. Choose which sections appear and which tab opens on
          launch. This is set per backend and stored on this device, so switching backends swaps the
          tabs and menu to that backend&apos;s view. The default tab is always shown.
        </Text>

        <Text style={styles.section}>Tabs</Text>
        {tabs.map(item => (
          <NavRow
            key={item.key}
            item={item}
            isDefault={config.landing === item.key}
            isVisible={!hidden.has(item.key)}
            onToggle={() => toggleVisible(item.key)}
            onSetDefault={() => setLanding(item.key as TabSection)}
          />
        ))}

        <Text style={styles.section}>More menu</Text>
        {more.map(item => (
          <NavRow
            key={item.key}
            item={item}
            isDefault={false}
            isVisible={!hidden.has(item.key)}
            onToggle={() => toggleVisible(item.key)}
          />
        ))}

        <Text style={styles.section}>Tools (web)</Text>
        <View style={styles.row}>
          <View style={styles.rowLeft}>
            <Text style={[styles.label, !config.toolsEnabled && styles.labelHidden]}>Show Tools tab</Text>
          </View>
          <Switch
            value={config.toolsEnabled}
            onValueChange={v => setNavConfig({ ...config, toolsEnabled: v })}
            trackColor={{ true: colors.accent, false: colors.border }}
            thumbColor={colors.text}
          />
        </View>
        {config.toolsEnabled ? (
          <View style={styles.labelRow}>
            <Text style={styles.labelFieldName}>Label</Text>
            <TextInput
              style={styles.input}
              value={config.toolsLabel}
              onChangeText={t => setNavConfig({ ...config, toolsLabel: t })}
              placeholder="Tools"
              placeholderTextColor={colors.muted2}
              autoCapitalize="none"
            />
          </View>
        ) : null}
        <Text style={styles.toolsHint}>Opens this backend&apos;s web tool. It&apos;s a per-backend preference.</Text>
      </ScrollView>
    </Screen>
  )
}

function NavRow({
  item,
  isDefault,
  isVisible,
  onToggle,
  onSetDefault,
}: {
  item: NavConfigItem
  isDefault: boolean
  isVisible: boolean
  onToggle: () => void
  onSetDefault?: () => void
}) {
  return (
    <View style={[styles.row, isDefault && styles.rowDefault]}>
      <View style={styles.rowLeft}>
        <Text style={[styles.label, !isVisible && styles.labelHidden]}>{item.label}</Text>
        {onSetDefault ? (
          <Text
            style={[styles.defaultTag, isDefault && styles.defaultTagActive]}
            onPress={isDefault ? undefined : onSetDefault}
          >
            {isDefault ? '✓ Default' : 'Set default'}
          </Text>
        ) : null}
      </View>
      <Switch
        value={isVisible}
        onValueChange={onToggle}
        disabled={isDefault}
        trackColor={{ true: colors.accent, false: colors.border }}
        thumbColor={colors.text}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.md },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: space.lg, marginBottom: space.sm },
  section: {
    color: colors.muted2,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: space.lg,
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowDefault: { backgroundColor: colors.surface },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: space.md, flex: 1 },
  label: { color: colors.text, fontSize: 16 },
  labelHidden: { color: colors.muted2 },
  defaultTag: {
    color: colors.muted2,
    fontSize: 12,
    paddingVertical: 3,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  defaultTagActive: { color: colors.accent, borderColor: colors.accent },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.md },
  labelFieldName: { color: colors.muted, fontSize: 14, width: 54 },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  toolsHint: { color: colors.muted2, fontSize: 12, paddingHorizontal: space.lg, marginTop: space.xs },
})
