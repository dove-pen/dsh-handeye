// The single `capability` tool: list, show, save, run.
//
// Confirmation policy:
//   - read  : first run needs one user confirmation, then it is trusted
//   - write : every run needs a fresh user confirmation
//   - destructive : same as write; never remembered
// Confirmations are minted by an explicit user action (panel grant) or a token.

import { compileEpisode } from '../runtime/compile.js'

export function createCapabilityTool({ state, store, executor, confirm, episodes, getActiveEpisode }) {
  return {
    name: 'capability',
    description:
      'Work with recorded capabilities. action="list" shows name/status/risk and run statistics; action="show" returns one capability as JSON; action="save" compiles a recorded episode into a draft capability (human must review and enable it); action="run" executes an enabled capability and returns its outputs. Prefer a matching capability over raw tools, and fall back to raw tools when it fails.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'save', 'run'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'Capability name (snake_case) for show/run/save.' },
        title: { type: 'string', description: 'Human title for save.' },
        description: { type: 'string', description: 'Short description for save.' },
        episode_id: { type: 'string', description: 'Episode to compile for save; defaults to the current/latest one.' },
        risk: { type: 'string', enum: ['read', 'write', 'destructive'], description: 'Optional risk override for save.' },
        params: { type: 'object', description: 'Capability parameters for run.' },
        token: { type: 'string', description: 'Optional confirmation token from the user.' },
      },
      required: ['action'],
    },
    timeoutMs: 130000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String(args?.action ?? '')

      if (action === 'list') {
        const listed = await store.list()
        if (!listed.ok) return `capability list failed: ${listed.message}`
        if (listed.value.length === 0) return 'No capabilities installed.'
        return listed.value
          .map((cap) => {
            const stats = cap.stats ?? {}
            return `${cap.name}  ${cap.status}  ${cap.risk}  ${cap.origin ?? 'user'}  runs=${stats.runs ?? 0} ok=${stats.success ?? 0}  ${cap.title}`
          })
          .join('\n')
      }

      if (action === 'show') {
        const found = await store.get(args?.name)
        if (!found.ok) return `capability show failed: ${found.message}`
        return JSON.stringify(found.value, null, 2)
      }

      if (action === 'save') {
        const name = String(args?.name ?? '')
        const title = String(args?.title ?? '').trim()
        if (!/^[a-z][a-z0-9_]{2,40}$/.test(name)) {
          return 'capability save needs a snake_case name (3-40 chars, lowercase letters/digits/underscore)'
        }
        if (!title) return 'capability save needs a title'

        let episode = null
        if (args?.episode_id) {
          if (!episodes) return 'capability save: episode storage is unavailable'
          const found = await episodes.read(String(args.episode_id))
          if (!found.ok) return `capability save failed: ${found.message}`
          episode = found.value
        } else {
          const active = typeof getActiveEpisode === 'function' ? getActiveEpisode() : null
          if (active && (!state.episodeId || active.id === state.episodeId)) episode = active
          else if (episodes) {
            const listed = await episodes.list({ limit: 1 })
            if (listed.ok && listed.value[0]) episode = listed.value[0]
          }
        }
        if (!episode) return 'capability save: no episode to compile; run the task once first'

        const compiled = compileEpisode(episode, {
          name,
          title,
          description: args?.description,
          risk: args?.risk,
        })
        const warnings = compiled.warnings?.length
          ? `\nwarnings:\n${compiled.warnings.map((w) => `- ${w}`).join('\n')}`
          : ''
        if (!compiled.ok) {
          return `capability save failed: ${compiled.message}${warnings}`
        }

        const saved = await store.saveDraft(compiled.capability)
        if (!saved.ok) return `capability save failed: ${saved.message}`
        return `Draft "${name}" saved from episode ${episode.id} (${compiled.capability.steps.length} steps, risk ${compiled.capability.risk}). Review and enable it in the panel before running.${warnings}`
      }

      if (action !== 'run') return `Unknown action "${action}". Use list, show, save or run.`

      const name = String(args?.name ?? '')
      const found = await store.get(name)
      if (!found.ok) return `capability run failed: ${found.message}`
      const cap = found.value
      if (cap.status !== 'enabled') {
        return `Capability "${name}" is ${cap.status}. Enable it in the panel before running.`
      }

      const risk = cap.risk === 'destructive' ? 'destructive' : cap.risk === 'write' ? 'write' : 'read'
      if (risk === 'read' && cap.firstRunConfirmed !== true) {
        const granted = confirm.consumeFor(name, 'read') || (args?.token ? confirm.consume(args.token, 'read') : { ok: false })
        if (!granted.ok) {
          return `CONFIRM_REQUIRED: this is the first run of "${name}". Ask the user to allow one run, then retry.`
        }
        await store.markFirstRun(name)
      } else if (risk !== 'read') {
        const granted = confirm.consumeFor(name, risk) || (args?.token ? confirm.consume(args.token, risk) : { ok: false })
        if (!granted.ok) {
          return `CONFIRM_REQUIRED: "${name}" is a ${risk} capability. Ask the user to allow this run, then retry.`
        }
      }

      const result = await executor.run(cap, args?.params ?? {}, { confirmed: true })
      await store.recordRun(name, { ok: result.ok, error: result.ok ? '' : result.message })

      if (!result.ok) {
        const details = result.details ? `\n${JSON.stringify(result.details, null, 2)}` : ''
        return `capability run failed: ${result.message}${details}`
      }

      const outputs = result.value && Object.keys(result.value).length ? JSON.stringify(result.value) : '(no outputs)'
      const assumptions =
        result.assumptions && Object.keys(result.assumptions).length
          ? `\nassumptions: ${JSON.stringify(result.assumptions)}`
          : ''
      const trace =
        Array.isArray(result.trace) && result.trace.length
          ? `\nsteps: ${result.trace.map((t) => `${t.index + 1}.${t.op}:${t.ok ? 'ok' : 'fail'} ${t.ms}ms`).join(' | ')}`
          : ''
      return `capability ${name} succeeded\noutputs: ${outputs}${assumptions}${trace}`
    },
  }
}
