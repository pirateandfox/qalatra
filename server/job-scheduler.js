import { resolveMaxConcurrentJobs } from './settings.js'

/** One admission loop per server, including asynchronous claims and launch preparation. */
export function createJobScheduler({ launchJob, failJob, logger = console }) {
  let admittedJobs = 0
  let admitting = false
  let lastState = ''
  const status = settings => {
    const maxConcurrentJobs = resolveMaxConcurrentJobs(settings, message => logger.error(message))
    return { maxConcurrentJobs, admittedJobs, paused: maxConcurrentJobs === 0 }
  }
  const report = settings => {
    const state = status(settings)
    const encoded = JSON.stringify(state)
    if (encoded !== lastState) logger.error(`[workers] admission ${encoded}`)
    lastState = encoded
    return state
  }
  return {
    status,
    async process(ctx) {
      if (admitting) return
      admitting = true
      try {
        const { maxConcurrentJobs } = report(ctx.loadSettings())
        if (admittedJobs >= maxConcurrentJobs) return
        const jobs = await ctx.dbCall('getQueuedJobs', maxConcurrentJobs - admittedJobs)
        for (const job of jobs) {
          // Recheck after every await: a drain must also stop the rest of a slow batch.
          const settings = ctx.loadSettings()
          if (admittedJobs >= report(settings).maxConcurrentJobs) break
          admittedJobs++
          let released = false
          const release = () => {
            if (released) return
            released = true
            admittedJobs--
            report(ctx.loadSettings())
          }
          report(settings)
          let claimed = false
          let handedOff = false
          try {
            const claim = await ctx.dbCall('startAgentJob', job.id)
            if (claim?.claimed === false) continue
            claimed = true
            // A successful launch owns the slot until scope cleanup on its terminal event.
            handedOff = await launchJob({ ...ctx, job, settings, release }) === true
          } catch (err) {
            logger.error(`[workers] ${claimed ? 'launch' : 'claim'} failed for job ${job.id}: ${err.message}`)
            if (claimed) await failJob(ctx, job, err)
          } finally {
            if (!handedOff) release()
          }
        }
      } finally {
        admitting = false
      }
    },
  }
}
