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

// Match the services used by the shipped time-context plugin so this bundle
// normally activates after the core agent/session services are ready.
export const inject = ['agents', 'sessionProjections']

const DEFAULT_CONFIG_URL = new URL('./prompt-overrides.default.json', import.meta.url)
const DISABLED_CONFIG = Object.freeze({
  version: 1,
  enabled: false,
  overrides: {},
  extraSections: [],
  extraContexts: [],
})

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
  const variables = {
    original,
    variant: 'default',
  }

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
    const match = original.match(/You are the\s+(.+?)\s+agent\.\s+Your name is\s+(.+?)\.(?:\n|$)/s)
    if (match) {
      variables.agentRole = match[1].trim()
      variables.agentName = parseJsonishString(match[2])
      variables.variant = variables.agentRole
    }
    const lines = original.split(/\r?\n/)
    variables.communicationHelp = lines.slice(1).join('\n')
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

function renderOverride(config, name, originalText) {
  if (!config?.enabled) return undefined
  const entry = config.overrides?.[name]
  if (!entry || entry.enabled === false) return undefined

  const variables = extractVariables(name, originalText)
  const template = templateFor(entry, variables)
  if (template === undefined) return undefined
  return renderTemplate(template, variables)
}

function sortSections(sections) {
  return [...sections].sort((a, b) => {
    const ao = Number.isFinite(a?.order) ? a.order : 0
    const bo = Number.isFinite(b?.order) ? b.order : 0
    if (ao !== bo) return ao - bo
    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
  })
}

function transformPresentation(result, config, ctx) {
  if (!result || !config?.enabled) return result

  let sections = Array.isArray(result.sections) ? result.sections : undefined
  let contexts = Array.isArray(result.contexts) ? result.contexts : undefined

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

  if (contexts) {
    contexts = contexts.map((context) => {
      const replacement = renderOverride(config, context?.name, context?.text)
      if (replacement === undefined) return context
      return cloneWith(context, { text: replacement, interpolate: false })
    })

    for (const extra of config.extraContexts ?? []) {
      if (!extra || extra.enabled === false || !extra.name || extra.text == null) continue
      if (contexts.some((context) => context?.name === extra.name)) {
        log(ctx, 'warn', `extraContexts contains duplicate name ${JSON.stringify(extra.name)}; skipped`)
        continue
      }
      contexts.push({
        name: String(extra.name),
        text: String(extra.text),
        interpolate: false,
      })
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
  const textIndex = content.findIndex((part) => part?.type === 'text')
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
    } catch (error) {
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

export function apply(ctx, pluginConfig = {}) {
  const configPath = resolveConfigPath(ctx, pluginConfig)
  ensureConfigFile(ctx, configPath)
  const loadConfig = createConfigLoader(ctx, configPath)

  log(ctx, 'info', `editable prompt file: ${configPath}`)

  // 1) System prompt sections + runtime contexts (tool:read and items 2-7).
  // Never mutate DSH-owned presentation objects; always return cloned replacements.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    return transformPresentation(result, loadConfig(), ctx)
  })

  // 2) time-context is a separate durable user-role snapshot produced at pre-step.
  // Delegate first so the shipped plugin can append its reading, then replace only
  // that sourced message by constructing fresh immutable objects.
  ctx.on('agent/pre-step', async (_event, next) => {
    const decision = await next()
    return transformPreStepDecision(decision, loadConfig())
  }, { prepend: true })
}

// Export pure helpers for the bundled self-test. They are not part of the DSH API.
export const __test = {
  cloneWith,
  extractVariables,
  renderTemplate,
  renderOverride,
  transformPresentation,
  transformTimeMessage,
  transformPreStepDecision,
}
