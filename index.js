import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'prompt-overrides'

// These services are the owners of the facts whose wording we replace. We do
// not replace their enforcement or state; we only register scoped presenters.
export const inject = [
  'agents',
  'sessionProjections',
  'systemPrompt',
  'workingDirectory',
  'sandboxPolicy',
  'approval',
  'subagents',
  'tools',
]

const DEFAULT_CONFIG_URL = new URL('./prompt-overrides.default.json', import.meta.url)
const DISABLED_CONFIG = Object.freeze({
  version: 1,
  enabled: false,
  overrides: {},
  extraSections: [],
  extraContexts: [],
})

const APPROVAL_NEVER = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
const APPROVAL_ASK = 'Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'

function log(ctx, level, message, ...args) {
  const logger = ctx?.logger
  if (logger && typeof logger[level] === 'function') {
    logger[level](`dsh-prompt-overrides: ${message}`, ...args)
    return
  }
  const fallback = level === 'warn' || level === 'error' ? console.error : console.log
  fallback(`[dsh-prompt-overrides] ${message}`, ...args)
}

function cloneWith(object, patch) {
  if (object === null || typeof object !== 'object') return object

  const descriptors = Object.getOwnPropertyDescriptors(object)
  for (const [key, value] of Object.entries(patch)) {
    const current = descriptors[key]
    if (current && Object.prototype.hasOwnProperty.call(current, 'value')) {
      descriptors[key] = { ...current, value }
    } else {
      descriptors[key] = {
        value,
        writable: true,
        enumerable: current?.enumerable ?? true,
        configurable: true,
      }
    }
  }

  return Object.create(Object.getPrototypeOf(object), descriptors)
}

function parseJsonishString(raw) {
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, '')
  }
}

function extractVariables(name, originalText) {
  const original = String(originalText ?? '')
  const variables = { original, variant: 'default', additionalWritableRoots: '' }

  if (name === 'working-directory:current') {
    const match = original.match(/Current working directory:\s*(.+?)\.\s*$/s)
    if (match) variables.cwd = parseJsonishString(match[1])
  }

  if (name === 'sandbox:policy') {
    const match = original.match(/Current DSH file policy:\s*([^\.\n]+)\./)
    if (match) {
      variables.policy = match[1].trim()
      variables.variant = variables.policy
    }
    const workspace = original.match(/session workspace:\s*(\"(?:\\\\.|[^\"\\\\])*\"|[^.]+)\./s)
    if (workspace) variables.workspaceRoot = parseJsonishString(workspace[1].trim())
    const additional = original.match(/Additional writable directories:\s*(.+?)\.\s*On Windows/s)
    if (additional) variables.additionalWritableRoots = additional[1]
  }

  if (name === 'approval:policy') {
    if (/Approval prompts are disabled/i.test(original)) {
      variables.approvalMode = 'never'
      variables.variant = 'never'
    } else if (/Approval prompts are enabled/i.test(original)) {
      variables.approvalMode = 'ask'
      variables.variant = 'ask'
    }
  }

  if (name === 'subagent:identity') {
    const rootMatch = original.match(/^You are the root agent\. Your name is (.+?)\./s)
    const childMatch = original.match(/^You are a subagent delegated by agent (.+?)\.\s*\nYour name is (.+?)\.\s*\nThe root agent of your collaboration tree is (.+?)\./s)

    if (rootMatch) {
      variables.agentRole = 'root'
      variables.agentName = parseJsonishString(rootMatch[1])
      variables.rootAgentName = variables.agentName
      variables.parentAgentName = ''
    } else if (childMatch) {
      variables.agentRole = 'child'
      variables.parentAgentName = parseJsonishString(childMatch[1])
      variables.agentName = parseJsonishString(childMatch[2])
      variables.rootAgentName = parseJsonishString(childMatch[3])
    } else {
      const legacyMatch = original.match(/You are the\s+(.+?)\s+agent\.\s+Your name is\s+(.+?)\.(?:\n|$)/s)
      if (legacyMatch) {
        variables.agentRole = legacyMatch[1].trim()
        variables.agentName = parseJsonishString(legacyMatch[2])
        variables.variant = variables.agentRole
      }
    }

    const lines = original.split(/\r?\n/)
    const identityLineCount = childMatch ? 3 : 1
    variables.communicationHelp = lines.slice(identityLineCount).join('\n').trim()
  }

  if (name === 'harness:source') {
    const match = original.match(/Current DeepSeek Harness implementation checkout:\s*(.+?)\.\s*$/s)
    if (match) variables.sourceRoot = parseJsonishString(match[1])
  }

  if (name === 'app:web-surface') {
    const match = original.match(/Current DeepSeek Harness Web GUI URL:\s*(.+?)\.\s*$/s)
    if (match) variables.webUrl = parseJsonishString(match[1])
  }

  if (name === 'time-context') {
    const lines = original.split(/\r?\n/)
    variables.timeLine = lines[0] ?? ''
    variables.browserContext = lines[1] ?? ''
    variables.elapsedLine = lines[2] ?? ''

    const timeMatch = (lines[0] ?? '').match(
      /Time sampled while preparing turn\s+(\d+),\s+step\s+(\d+):\s*(.+)$/,
    )
    if (timeMatch) {
      variables.turn = timeMatch[1]
      variables.step = timeMatch[2]
      variables.timestamp = timeMatch[3]
    }

    const elapsedMatch = (lines[2] ?? '').match(
      /Elapsed since the preceding\s+(.+?):\s*(.+?)\.?$/,
    )
    if (elapsedMatch) {
      variables.baseline = elapsedMatch[1]
      variables.elapsed = elapsedMatch[2]
      variables.baselineZh = elapsedMatch[1] === 'model-visible message'
        ? '模型可见消息'
        : elapsedMatch[1] === 'step context'
          ? '步骤上下文'
          : elapsedMatch[1]
    }
  }

  return variables
}

function renderTemplate(template, variables) {
  const text = String(template ?? '')
  return text.replace(/\{\{([A-Za-z0-9_.:-]+)\}\}/g, (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return whole
    const value = variables[key]
    return value == null ? '' : String(value)
  })
}

function templateFor(entry, variables) {
  if (!entry || entry.enabled === false) return undefined

  if (entry.variants && typeof entry.variants === 'object') {
    const key = variables.variant ?? 'default'
    const selected = entry.variants[key] ?? entry.variants.default
    if (selected != null) return String(selected)
  }

  if (entry.text != null) return String(entry.text)
  return undefined
}

function renderOverride(config, contextName, originalText) {
  if (!config?.enabled) return undefined
  const entry = config.overrides?.[contextName]
  if (!entry || entry.enabled === false) return undefined

  const variables = extractVariables(contextName, originalText)
  const template = templateFor(entry, variables)
  if (template === undefined) return undefined
  return renderTemplate(template, variables)
}

function renderSandboxPolicy(policy) {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write': {
      const additional = policy.additionalWritableRoots
      const extra = additional === undefined
        ? ''
        : ` Additional writable directories: ${JSON.stringify(additional)}. On Windows, these additional grants apply to file tools only, not sandboxed processes.`
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}.${extra} Some platform temporary areas may also be writable.`
    }
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    default:
      return `Current DSH file policy: ${String(policy.mode)}.`
  }
}

function renderApprovalPolicy(ctx, agent) {
  const policy = ctx.approval.overrideOf(agent.session)
    ?? ctx.approval.config?.policy
    ?? 'ask'
  return policy === 'never' ? APPROVAL_NEVER : APPROVAL_ASK
}

function renderSubagentIdentity(ctx, agent, assemblyContext) {
  try {
    const names = ctx.subagents.namesOf(agent)
    let identity = names.parent === undefined
      ? `You are the root agent. Your name is ${JSON.stringify(names.self)}.`
      : `You are a subagent delegated by agent ${JSON.stringify(names.parent)}.\n`
        + `Your name is ${JSON.stringify(names.self)}.\n`
        + `The root agent of your collaboration tree is "lead".`

    const scope = assemblyContext?.scope ?? agent
    const toolSet = assemblyContext?.toolSet
    const guidance = []

    if (ctx.tools.get('send_message', scope, toolSet) !== undefined) {
      guidance.push('To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).')
      if (names.parent !== undefined && ctx.get('agentTeams')?.isEnabled(agent) !== true) {
        guidance.push('When you finish, use send_message to send a self-contained result to the agent that delegated you. '
          + 'Message any agent as soon as a finding changes what it should do next; sending a message does not end your turn.')
      }
    }
    if (ctx.tools.get('list_agents', scope, toolSet) !== undefined) {
      guidance.push('Use list_agents({}) to find your collaborator agents and their names.')
    }
    if (guidance.length > 0) identity += '\n\n' + guidance.join('\n')
    return identity
  } catch (error) {
    const rootUnavailable = typeof error === 'object' && error !== null
      && error.name === 'SubagentError' && error.code === 'UNAUTHORIZED'
    if (!rootUnavailable) throw error
    return `Your agent id is ${JSON.stringify(agent.id)}. Your subagent tree root is unavailable. `
      + 'Continue independent work; subagent discovery and messaging require an active root.'
  }
}

function contextSourceText(ctx, agent, contextName, assemblyContext) {
  const session = agent.session
  switch (contextName) {
    case 'working-directory:current':
      return `Current working directory: ${JSON.stringify(ctx.workingDirectory.get(session))}.`
    case 'sandbox:policy':
      return renderSandboxPolicy(ctx.sandboxPolicy.resolve({ session }))
    case 'approval:policy':
      return renderApprovalPolicy(ctx, agent)
    case 'subagent:identity':
      return renderSubagentIdentity(ctx, agent, assemblyContext)
    default:
      return undefined
  }
}

function sortSections(sections) {
  return [...sections].sort((a, b) => {
    const ao = Number.isFinite(a?.order) ? a.order : 0
    const bo = Number.isFinite(b?.order) ? b.order : 0
    if (ao !== bo) return ao - bo
    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
  })
}

// Only ordinary system sections are transformed here. Runtime contexts are
// overridden at their owning registry scope below; changing their assembled
// snapshot is insufficient because refreshContext() resolves their providers.
function transformPresentation(result, config, ctx) {
  if (!result || !config?.enabled) return result

  let sections = Array.isArray(result.sections) ? result.sections : undefined
  if (sections) {
    sections = sections.map((section) => {
      const replacement = renderOverride(config, section?.name, section?.text)
      if (replacement === undefined) return section
      return cloneWith(section, { text: replacement, interpolate: false })
    })

    for (const extra of config.extraSections ?? []) {
      if (!extra || extra.enabled === false || !extra.name || extra.text == null) continue
      if (sections.some((section) => section?.name === extra.name)) {
        log(ctx, 'warn', `extraSections contains duplicate name ${JSON.stringify(extra.name)}; skipped`)
        continue
      }
      sections.push({
        name: String(extra.name),
        order: Number.isFinite(extra.order) ? Number(extra.order) : 9500,
        text: String(extra.text),
        interpolate: false,
      })
    }
    sections = sortSections(sections)
  }

  let contexts = Array.isArray(result.contexts) ? [...result.contexts] : undefined
  if (contexts) {
    // extraContexts are genuinely new contributions, so refreshContext() keeps
    // them when no registered provider owns their names.
    for (const extra of config.extraContexts ?? []) {
      if (!extra || extra.enabled === false || !extra.name || extra.text == null) continue
      if (contexts.some((context) => context?.name === extra.name)) {
        log(ctx, 'warn', `extraContexts contains duplicate name ${JSON.stringify(extra.name)}; skipped`)
        continue
      }
      contexts.push({ name: String(extra.name), text: String(extra.text), interpolate: false })
    }
  }

  const patch = {}
  if (sections) patch.sections = sections
  if (contexts) patch.contexts = contexts
  return Object.keys(patch).length === 0 ? result : cloneWith(result, patch)
}

function transformTimeMessage(message, config) {
  if (!message || message?.source?.kind !== 'time-context') return message

  const entry = config?.enabled ? config.overrides?.['time-context'] : undefined
  if (!entry || entry.enabled === false) return message

  const content = Array.isArray(message.content) ? message.content : []
  const textIndex = content.findIndex(part => part?.type === 'text')
  if (textIndex < 0) return message

  const originalText = String(content[textIndex]?.text ?? '')
  const replacement = renderOverride(config, 'time-context', originalText)
  if (replacement === undefined || replacement === originalText) return message

  const newContent = content.map((part, index) => {
    if (index !== textIndex) return part
    return cloneWith(part, { text: replacement })
  })

  let newSource = message.source
  if (Array.isArray(message.source?.sections)) {
    const newSections = message.source.sections.map((section) => {
      if (section?.name !== 'time-context') return section
      return cloneWith(section, { text: replacement })
    })
    newSource = cloneWith(message.source, { sections: newSections })
  }

  return cloneWith(message, { content: newContent, source: newSource })
}

function transformPreStepDecision(decision, config) {
  if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
  if (!config?.enabled || !config.overrides?.['time-context']?.enabled) return decision

  let changed = false
  const messages = decision.messages.map((message) => {
    const transformed = transformTimeMessage(message, config)
    if (transformed !== message) changed = true
    return transformed
  })
  return changed ? cloneWith(decision, { messages }) : decision
}

function resolveConfigPath(ctx, config) {
  const configured = typeof config?.configFile === 'string' && config.configFile.trim() !== ''
    ? config.configFile.trim()
    : 'prompt-overrides.json'

  if (isAbsolute(configured)) return configured

  const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
  const base = profileContext?.dir || process.cwd()
  return resolve(base, configured)
}

function ensureConfigFile(ctx, configPath) {
  if (existsSync(configPath)) return
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    copyFileSync(fileURLToPath(DEFAULT_CONFIG_URL), configPath)
    log(ctx, 'info', `created editable config at ${configPath}`)
  } catch (error) {
    log(ctx, 'warn', `could not create editable config at ${configPath}: %o`, error)
  }
}

function createConfigLoader(ctx, configPath) {
  let lastStamp
  let lastGood
  let lastWarnedStamp

  return () => {
    let stamp
    try {
      const stat = statSync(configPath)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch {
      if (lastWarnedStamp !== 'missing') {
        log(ctx, 'warn', `config is unavailable at ${configPath}; using last known good config`)
        lastWarnedStamp = 'missing'
      }
      return lastGood ?? DISABLED_CONFIG
    }

    if (stamp === lastStamp && lastGood) return lastGood

    try {
      let raw = readFileSync(configPath, 'utf8')
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('top-level JSON value must be an object')
      }
      lastGood = parsed
      lastStamp = stamp
      lastWarnedStamp = undefined
      return parsed
    } catch (error) {
      if (lastWarnedStamp !== stamp) {
        log(ctx, 'warn', `config parse failed at ${configPath}; keeping last known good config: %o`, error)
        lastWarnedStamp = stamp
      }
      return lastGood ?? DISABLED_CONFIG
    }
  }
}

const CONTEXT_REGISTRATIONS = [
  { name: 'working-directory:current', orderName: 'WORKING_DIRECTORY', required: true },
  { name: 'sandbox:policy', orderName: 'SANDBOX_POLICY', required: false },
  { name: 'approval:policy', orderName: 'APPROVAL_POLICY', required: false },
  { name: 'subagent:identity', orderName: 'SUBAGENT_DELEGATION', required: true },
]

function installAgentOverrides(ctx, agent, loadConfig, loggerCtx) {
  const disposers = []
  try {
    const scopedPrompt = agent.ctx.systemPrompt

    for (const definition of CONTEXT_REGISTRATIONS) {
      const dispose = scopedPrompt.context({
        name: definition.name,
        order: scopedPrompt.getContextOrder(definition.orderName),
        required: definition.required,
        interpolate: false,
        text: (assemblyContext) => {
          const original = contextSourceText(ctx, agent, definition.name, assemblyContext)
          if (original === undefined) return ''
          const replacement = renderOverride(loadConfig(), definition.name, original)
          return replacement === undefined ? original : replacement
        },
      })
      disposers.push(dispose)
    }

    // time-context is a durable message appended by a global prepended
    // pre-step listener. Register this scoped prepended wrapper at agent/created
    // time, after the global package has mounted, so it is the outer wrapper:
    // await next() sees the newly appended snapshot and can clone it safely.
    const disposeTimeContext = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return transformPreStepDecision(decision, loadConfig())
    }, { prepend: true })
    disposers.push(disposeTimeContext)

    return disposers
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch {}
    }
    log(loggerCtx, 'error', `failed to install scoped overrides for agent ${agent.id}: %o`, error)
    throw error
  }
}

export function apply(ctx, pluginConfig = {}) {
  const configPath = resolveConfigPath(ctx, pluginConfig)
  ensureConfigFile(ctx, configPath)
  const loadConfig = createConfigLoader(ctx, configPath)
  const perAgentDisposers = new Map()

  log(ctx, 'info', `editable prompt file: ${configPath}`)

  // Ordinary system-prompt sections (tool:read, harness:source, app:web-surface).
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    return transformPresentation(result, loadConfig(), ctx)
  })

  const install = (agent) => {
    if (!agent || perAgentDisposers.has(agent)) return
    const disposers = installAgentOverrides(ctx, agent, loadConfig, ctx)
    perAgentDisposers.set(agent, disposers)
    log(ctx, 'info', `installed scoped runtime-context overrides for agent ${agent.id}`)
  }

  // agent/created is serial and fires before the first prompt assembly.
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => { perAgentDisposers.delete(agent) })

  // Also cover agents that were already live when this plugin was hot-loaded.
  for (const agent of ctx.agents.list()) install(agent)

  // Agent-scoped registrations are owned by agent.ctx, so explicitly dispose
  // their exact handles if THIS plugin unloads before those Agents do.
  ctx.effect(() => () => {
    for (const disposers of perAgentDisposers.values()) {
      for (const dispose of [...disposers].reverse()) {
        try { dispose?.() } catch (error) {
          log(ctx, 'warn', `scoped registration disposal failed: %o`, error)
        }
      }
    }
    perAgentDisposers.clear()
  }, 'dsh-prompt-overrides.disposeAgentScopes()')
}

export const __test = {
  cloneWith,
  extractVariables,
  renderTemplate,
  renderOverride,
  renderSandboxPolicy,
  renderApprovalPolicy,
  renderSubagentIdentity,
  contextSourceText,
  transformPresentation,
  transformTimeMessage,
  transformPreStepDecision,
  installAgentOverrides,
}
