import { useEffect, useState } from 'react'
import { fetchSettings, saveSettings } from '../api'
import { AgentsSettings } from './settings/AgentsSettings'
import { ContextsSettings } from './settings/ContextsSettings'
import { EncryptionBackupSettings } from './settings/EncryptionBackupSettings'
import { GeneralSettings } from './settings/GeneralSettings'
import { InstancesSettings } from './settings/InstancesSettings'
import { SidebarSettings } from './settings/SidebarSettings'
import { StorageSettings } from './settings/StorageSettings'
import type { SidebarConfig } from '../lib/nav'
import './Settings.css'
import './SettingsView.css'

type Tab = 'general' | 'sidebar' | 'instances' | 'storage' | 'encryption' | 'contexts' | 'agents'

const TABS: { key: Tab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'sidebar', label: 'Sidebar' },
  { key: 'instances', label: 'Instances' },
  { key: 'storage', label: 'Storage' },
  { key: 'encryption', label: 'Encryption & Backup' },
  { key: 'contexts', label: 'Contexts' },
  { key: 'agents', label: 'Agents' },
]

interface SettingsViewProps {
  sidebarConfig: SidebarConfig
  onSidebarConfigChange: (config: SidebarConfig) => void
}

export default function SettingsView({ sidebarConfig, onSidebarConfigChange }: SettingsViewProps) {
  const [tab, setTab] = useState<Tab>('general')
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetchSettings().then(setSettings).catch(() => {})
  }, [])

  function markSaved() {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  async function handleSave() {
    await saveSettings(settings)
    markSaved()
  }

  function setSetting(key: string, value: string) {
    setSettings(current => ({ ...current, [key]: value }))
  }

  return (
    <div className="sv-root">
      <div className="sv-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`sv-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="sv-body settings-body">
        {tab === 'general' && (
          <GeneralSettings settings={settings} setSetting={setSetting} saved={saved} onSave={handleSave} />
        )}
        {tab === 'sidebar' && (
          <SidebarSettings config={sidebarConfig} onChange={onSidebarConfigChange} />
        )}
        {tab === 'instances' && (
          <InstancesSettings settings={settings} setSettings={setSettings} markSaved={markSaved} />
        )}
        {tab === 'storage' && (
          <StorageSettings settings={settings} setSetting={setSetting} saved={saved} onSave={handleSave} />
        )}
        {tab === 'encryption' && (
          <EncryptionBackupSettings
            settings={settings}
            setSettings={setSettings}
            setSetting={setSetting}
            saved={saved}
            onSave={handleSave}
          />
        )}
        {tab === 'contexts' && <ContextsSettings />}
        {tab === 'agents' && <AgentsSettings />}
      </div>
    </div>
  )
}
