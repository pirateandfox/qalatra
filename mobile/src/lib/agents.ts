import type { Agent } from '@qalatra/shared'
import type { ChipOption, ChipValue } from '../components/ChipRow'

function compact(parts: Array<string | null | undefined>) {
  return parts.map(part => part?.trim()).filter(Boolean) as string[]
}

export function effectiveContext(value: ChipValue | string | null | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'personal'
}

export function effectiveProject(value: ChipValue | string | null | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

export function agentSublabel(agent: Agent) {
  return compact([
    agent.project ? `Project: ${agent.project}` : agent.context ? `Context: ${agent.context}` : null,
    agent.folder,
    agent.relativePath && agent.relativePath !== agent.path ? agent.relativePath : null,
  ]).join(' · ')
}

export function agentFallbackLabel(path: string) {
  return path.split('/').filter(Boolean).pop() || path
}

export function agentLabel(agents: Agent[], path: string | null | undefined) {
  if (!path) return null
  return agents.find(agent => agent.path === path)?.name ?? agentFallbackLabel(path)
}

export function agentOptions(agents: Agent[], selectedPath?: string | null): ChipOption[] {
  const options: ChipOption[] = [{ value: null, label: 'None' }]
  for (const agent of agents) {
    options.push({
      value: agent.path,
      label: agent.name,
      sublabel: agentSublabel(agent) || undefined,
    })
  }
  if (selectedPath && !agents.some(agent => agent.path === selectedPath)) {
    options.push({ value: selectedPath, label: agentFallbackLabel(selectedPath), sublabel: selectedPath })
  }
  return options
}

export function agentsForCreate(agents: Agent[], context: ChipValue, project: ChipValue) {
  const ctx = effectiveContext(context)
  const proj = effectiveProject(project)
  return agents.filter(agent =>
    (!agent.context || agent.context === ctx) &&
    (!agent.project || !proj || agent.project === proj)
  )
}

export function agentsForDetail(agents: Agent[], context: string | null | undefined, project: string | null | undefined, selectedPath?: string | null) {
  const ctx = effectiveContext(context)
  const filtered = agents.filter(agent => {
    if (!agent.context) return true
    if (agent.context !== ctx) return false
    if (!agent.project) return true
    return agent.project === project
  })
  if (!selectedPath || filtered.some(agent => agent.path === selectedPath)) return filtered
  const selected = agents.find(agent => agent.path === selectedPath)
  return selected ? [...filtered, selected] : filtered
}
