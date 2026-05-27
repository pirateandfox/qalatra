import { getS3Client } from '../s3.js'
import { scanAgents } from './agents.js'
import { backupStatus, listBackups, restoreBackup, runBackup } from './backups.js'
import { syncPendingAttachments } from './attachments.js'
import { exportKey, generateKey, importKey, keyStatus } from './keys.js'
import { runAgentScan } from './workers.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function today() {
  return new Date().toISOString().slice(0, 10)
}

function json(body, status = 200) {
  return { status, body }
}

function data(name, value) {
  return json({ ok: true, [name]: value })
}

function result(value) {
  return json({ ok: true, result: value })
}

function ok(extra = {}) {
  return json({ ok: true, ...extra })
}

function partsFor(url) {
  return url.pathname
    .replace(/^\/api\/v1\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(part => decodeURIComponent(part))
}

function boolParam(value) {
  return value === '1' || value === 'true' || value === 'yes'
}

function optionalBoolParam(value) {
  if (value == null) return undefined
  return boolParam(value)
}

function dateParam(value) {
  return value && DATE_RE.test(value) ? value : today()
}

function requireBodyId(id, body) {
  return { ...body, id: body.id ?? id }
}

async function agentsForSettings(ctx) {
  const settings = ctx.loadSettings()
  const excludeFolders = (settings.agentExcludeFolders ?? '').split(',').map(f => f.trim()).filter(Boolean)
  const root = settings.agentsRoot || settings.terminalCwd || process.env.HOME
  if (!root) return []
  const agents = await scanAgents(root, excludeFolders)
  await ctx.dbCall('upsertAgents', agents)
  return agents.map(({ capability, ...agent }) => agent)
}

async function testS3Connection(creds) {
  const client = getS3Client({
    s3Endpoint: creds.s3Endpoint,
    s3AccessKey: creds.s3AccessKey,
    s3SecretKey: creds.s3SecretKey,
  })
  if (!client) return { ok: false, error: 'Missing credentials' }
  try {
    const { HeadBucketCommand } = await import('@aws-sdk/client-s3')
    await client.send(new HeadBucketCommand({ Bucket: creds.s3Bucket }))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function handleV1(req, url, ctx, { parseBody }) {
  if (!url.pathname.startsWith('/api/v1')) return null

  const method = req.method
  const parts = partsFor(url)
  const [resource, id, action] = parts

  if (!resource) {
    return ok({ version: 1 })
  }

  if (resource === 'tasks') {
    if (!id && method === 'GET') {
      return data('data', await ctx.dbCall('getTasksForDate', dateParam(url.searchParams.get('date'))))
    }
    if (!id && method === 'POST') {
      return data('task', await ctx.dbCall('createTask', await parseBody(req)))
    }
    if (id === 'backlog' && method === 'GET') return data('tasks', await ctx.dbCall('getBacklog'))
    if (id === 'coding' && method === 'GET') return data('tasks', await ctx.dbCall('getCodingTasks'))
    if (id === 'reading' && method === 'GET') return data('tasks', await ctx.dbCall('getReadingTasks'))
    if (id === 'stale' && method === 'GET') return data('tasks', await ctx.dbCall('getStaleTasks', url.searchParams.get('days')))
    if (id === 'reorder' && method === 'POST') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('reorderTasks', body.ids ?? []))
    }

    if (!id) return null
    if (!action && method === 'GET') return data('task', await ctx.dbCall('getTask', id))
    if (!action && method === 'PATCH') return result(await ctx.dbCall('updateTask', id, await parseBody(req)))
    if (!action && method === 'DELETE') return result(await ctx.dbCall('deleteTask', id))
    if (action === 'reviewed' && (method === 'POST' || method === 'PATCH')) return result(await ctx.dbCall('markReviewed', id))
    if (action === 'dependencies' && method === 'GET') return data('dependencies', await ctx.dbCall('getTaskDependencies', id))
    if (action === 'dependencies' && method === 'POST') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('addTaskDependency', id, body.blocked_by_task_id ?? body.blockedByTaskId))
    }
    if (action === 'dependencies' && method === 'DELETE') {
      const blockedBy = parts[3] ?? url.searchParams.get('blocked_by_task_id') ?? url.searchParams.get('blockedByTaskId')
      return result(await ctx.dbCall('removeTaskDependency', id, blockedBy))
    }
    if (action === 'subtasks' && method === 'GET') return data('tasks', await ctx.dbCall('getSubtasks', id))
    if (action === 'subtasks' && method === 'POST') {
      const body = await parseBody(req)
      return data('task', await ctx.dbCall('createSubtask', id, body.title))
    }
    if (action === 'notes' && method === 'GET') return data('notes', await ctx.dbCall('listNotes', id))
    if (action === 'notes' && method === 'POST') {
      const body = await parseBody(req)
      return data('note', await ctx.dbCall('addNote', id, body.body))
    }
    if (action === 'agent-jobs' && method === 'GET') return data('jobs', await ctx.dbCall('listAgentJobs', id))
    if (action === 'agent-jobs' && method === 'POST') {
      const body = await parseBody(req)
      return data('job', await ctx.dbCall('createAgentJob', id, body.userMessage ?? null))
    }
    if (action === 'title' && method === 'PATCH') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('updateTaskTitle', id, body.title))
    }
    if (action === 'description' && method === 'PATCH') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('updateTaskDescription', id, body.description ?? null))
    }
    if (action === 'due-date' && method === 'PATCH') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('updateTaskDueDate', id, body.due_date ?? body.dueDate ?? null))
    }
    if (action === 'recurrence' && method === 'PATCH') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('updateTaskRecurrence', id, body.recurrence ?? null))
    }
    if (action === 'links' && method === 'POST') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('addTaskLink', id, body.url))
    }
    if (action === 'actions' && method === 'POST') {
      const body = await parseBody(req)
      const verb = parts[3]
      if (verb === 'complete') return result(await ctx.dbCall('completeTask', id))
      if (verb === 'complete-with-subtasks') return result(await ctx.dbCall('completeTaskWithSubtasks', id))
      if (verb === 'uncomplete') return result(await ctx.dbCall('uncompleteTask', id))
      if (verb === 'skip') return result(await ctx.dbCall('skipTask', id))
      if (verb === 'activate') return result(await ctx.dbCall('activateTask', id))
      if (verb === 'snooze') return result(await ctx.dbCall('snoozeTask', id, body.until))
    }
  }

  if (resource === 'daily-notes' && id === 'search' && method === 'POST') {
    return data('results', await ctx.dbCall('searchDailyNotesDb', await parseBody(req)))
  }

  if (resource === 'daily-notes' && !id && method === 'GET') {
    return data('results', await ctx.dbCall('searchDailyNotesDb', {
      query: url.searchParams.get('query') ?? '',
      date_from: url.searchParams.get('date_from') ?? url.searchParams.get('from') ?? undefined,
      date_to: url.searchParams.get('date_to') ?? url.searchParams.get('to') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    }))
  }

  if (resource === 'daily-notes' && id) {
    if (method === 'GET') return data('note', await ctx.dbCall('getDailyNote', id))
    if (method === 'PUT') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('saveDailyNote', id, body.content ?? ''))
    }
  }

  if (resource === 'contexts') {
    if (!id && method === 'GET') return data('contexts', await ctx.dbCall('listContexts'))
    if (!id && method === 'POST') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('createContext', body.slug, body.label, body.color))
    }
    if (id && method === 'PATCH') return result(await ctx.dbCall('updateContext', id, await parseBody(req)))
    if (id && method === 'DELETE') return result(await ctx.dbCall('deleteContext', id))
  }

  if (resource === 'projects') {
    if (!id && method === 'GET') {
      return data('projects', await ctx.dbCall('listProjects', boolParam(url.searchParams.get('includeArchived'))))
    }
    if (!id && method === 'POST') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('createProjectExplicit', body.name))
    }
    if (id === 'summaries' && method === 'GET') return data('summaries', await ctx.dbCall('getProjectSummaries'))
    if (!id) return null
    if (!action && method === 'GET') return data('project', await ctx.dbCall('getProjectDetail', id))
    if (!action && method === 'PATCH') return result(await ctx.dbCall('updateProject', id, await parseBody(req)))
    if (!action && method === 'DELETE') return result(await ctx.dbCall('deleteProject', id))
    if (action === 'rename' && method === 'POST') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('renameProject', id, body.name))
    }
    if (action === 'context' && method === 'PUT') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('setProjectContext', id, body.context))
    }
    if (action === 'archive' && method === 'POST') return result(await ctx.dbCall('archiveProject', id))
    if (action === 'unarchive' && method === 'POST') return result(await ctx.dbCall('unarchiveProject', id))
  }

  if (resource === 'agents') {
    if (!id && method === 'GET') return data('agents', await agentsForSettings(ctx))
    if (id === 'rescan' && method === 'POST') {
      await runAgentScan(ctx)
      return ok()
    }
    if (id === 'db' && method === 'GET') return data('agents', await ctx.dbCall('listAgentsDb'))
  }

  if (resource === 'capabilities') {
    const filterFromQuery = () => ({
      context: url.searchParams.get('context') ?? undefined,
      project: url.searchParams.get('project') ?? undefined,
      kind: url.searchParams.get('kind') ?? undefined,
      active: optionalBoolParam(url.searchParams.get('active')),
    })
    if (!id && method === 'GET') {
      const query = url.searchParams.get('query') ?? url.searchParams.get('q')
      if (query) {
        return data('capabilities', await ctx.dbCall('searchCapabilitiesDb', {
          ...filterFromQuery(),
          query,
          limit: parseInt(url.searchParams.get('limit') ?? '20', 10),
        }))
      }
      return data('capabilities', await ctx.dbCall('listCapabilitiesDb', filterFromQuery()))
    }
    if (id === 'search' && method === 'POST') {
      return data('capabilities', await ctx.dbCall('searchCapabilitiesDb', await parseBody(req)))
    }
    if (id === 'rescan' && method === 'POST') {
      const agents = await runAgentScan(ctx)
      return ok({ count: agents.length })
    }
    if (id && !action && method === 'GET') {
      const capability = await ctx.dbCall('getCapabilityDb', { id })
      if (!capability) return json({ error: 'Capability not found' }, 404)
      return data('capability', capability)
    }
  }

  if (resource === 'agent-jobs' && id && method === 'GET') {
    return data('job', await ctx.dbCall('getAgentJob', id))
  }

  if (resource === 'habits') {
    if (!id && method === 'GET') return data('habits', await ctx.dbCall('listHabits', dateParam(url.searchParams.get('date'))))
    if (!id && method === 'POST') return data('habit', await ctx.dbCall('createHabit', await parseBody(req)))
    if (id && !action && method === 'PATCH') return result(await ctx.dbCall('updateHabit', requireBodyId(id, await parseBody(req))))
    if (id && action === 'log' && method === 'POST') {
      const body = await parseBody(req)
      return result(await ctx.dbCall('logHabit', id, body.date, body.status, body.notes ?? null))
    }
    if (id && action === 'log' && method === 'DELETE') {
      return result(await ctx.dbCall('unlogHabit', id, url.searchParams.get('date')))
    }
  }

  if (resource === 'heartbeats') {
    if (!id && method === 'GET') return data('heartbeats', await ctx.dbCall('listHeartbeats'))
    if (!id && method === 'POST') return data('heartbeat', await ctx.dbCall('createHeartbeat', await parseBody(req)))
    if (id && !action && method === 'PATCH') return data('heartbeat', await ctx.dbCall('updateHeartbeat', id, await parseBody(req)))
    if (id && !action && method === 'DELETE') return result(await ctx.dbCall('deleteHeartbeat', id))
    if (id && action === 'toggle' && method === 'POST') return data('heartbeat', await ctx.dbCall('toggleHeartbeat', id))
    if (id && action === 'jobs' && method === 'GET') {
      return data('jobs', await ctx.dbCall('listHeartbeatJobs', id, parseInt(url.searchParams.get('limit') ?? '10', 10)))
    }
  }

  if (resource === 'settings') {
    if (!id && method === 'GET') return data('settings', ctx.loadSettings())
    if (!id && method === 'PUT') {
      ctx.saveSettings(await parseBody(req))
      return ok()
    }
    if (id === 'export' && method === 'GET') return ok({ json: JSON.stringify(ctx.loadSettings(), null, 2) })
    if (id === 'import' && method === 'POST') {
      const body = await parseBody(req)
      const parsed = JSON.parse(body.json)
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings JSON')
      ctx.saveSettings(parsed)
      return ok()
    }
  }

  if (resource === 'mcp') {
    if (!id && method === 'GET') {
      const settings = ctx.loadSettings()
      return ok({ port: parseInt(settings.mcpPort ?? '3457', 10), isHttpConfigured: false, currentEntry: null })
    }
    if (!id && method === 'PUT') {
      const body = await parseBody(req)
      const port = parseInt(body.port, 10)
      if (Number.isNaN(port) || port < 1024 || port > 65535) throw new Error('Invalid port')
      const settings = ctx.loadSettings()
      settings.mcpPort = port
      ctx.saveSettings(settings)
      return ok({ port, url: `http://127.0.0.1:${port}/mcp`, restartRequired: true })
    }
  }

  if (resource === 's3' && id === 'test' && method === 'POST') {
    return result(await testS3Connection(await parseBody(req)))
  }

  if (resource === 'attachments' && id === 'sync' && method === 'POST') {
    return result(await syncPendingAttachments(ctx))
  }

  if (resource === 'key') {
    if (!id && method === 'GET') return ok(keyStatus(ctx.dataDir))
    if (!id && method === 'POST') return result(generateKey(ctx.dataDir))
    if (id === 'export' && method === 'GET') return result(exportKey(ctx.dataDir))
    if (id === 'import' && method === 'PUT') {
      const body = await parseBody(req)
      return result(importKey(ctx.dataDir, body.base64))
    }
  }

  if (resource === 'backup') {
    if (!id && method === 'POST') return result(await runBackup(ctx))
    if (!id && method === 'GET') return result(await listBackups(ctx))
    if (id === 'status' && method === 'GET') return ok(backupStatus())
    if (id === 'restore' && method === 'POST') {
      const body = await parseBody(req)
      return result(await restoreBackup(ctx, body.key))
    }
  }

  return null
}
