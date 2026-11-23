import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __test, apply } from './index.js'

const config = JSON.parse(readFileSync(new URL('./prompt-overrides.default.json', import.meta.url), 'utf8'))

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

// 1) The exact class of failure that killed the previous plugin: frozen prompt objects.
const presentation = deepFreeze({
  sections: [
    { name: 'tool:read', order: 100, text: 'Use the read tool — not shell commands like cat.', interpolate: true },
    { name: 'untouched', order: 200, text: 'keep me', interpolate: true },
  ],
  contexts: [
    { name: 'working-directory:current', text: 'Current working directory: "E:\\\\Work".', interpolate: true },
    { name: 'sandbox:policy', text: 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.' },
    { name: 'approval:policy', text: 'Approval prompts are disabled in this session: actions that require approval are rejected automatically.' },
    { name: 'subagent:identity', text: 'You are the root agent. Your name is "lead".\nTo message other agents, use send_message(...).\nUse list_agents({}) to find collaborators.' },
  ],
  marker: 'preserve',
})

const transformed = __test.transformPresentation(presentation, config, { logger: { warn() {} } })
assert.notEqual(transformed, presentation)
assert.equal(presentation.sections[0].text, 'Use the read tool — not shell commands like cat.')
assert.match(transformed.sections.find(x => x.name === 'tool:read').text, /read 工具/)
assert.equal(transformed.contexts.find(x => x.name === 'working-directory:current').text, '当前工作目录：E:\\Work。')
assert.match(transformed.contexts.find(x => x.name === 'sandbox:policy').text, /danger-full-access/)
assert.match(transformed.contexts.find(x => x.name === 'approval:policy').text, /审批模式：关闭/)
assert.match(transformed.contexts.find(x => x.name === 'subagent:identity').text, /名称是 lead/)
assert.equal(transformed.marker, 'preserve')

// 2) Frozen time-context message: must clone, never mutate.
const timeMessage = deepFreeze({
  role: 'user',
  content: [{
    type: 'text',
    text: 'Time sampled while preparing turn 12, step 1: 2026-11-23T18:58:00+08:00 [Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.\nElapsed since the preceding model-visible message: 42s.',
  }],
  source: {
    kind: 'time-context',
    form: 'snapshot',
    sections: [{
      name: 'time-context',
      text: 'Time sampled while preparing turn 12, step 1: 2026-11-23T18:58:00+08:00 [Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.\nElapsed since the preceding model-visible message: 42s.',
    }],
  },
})

const decision = deepFreeze({ kind: 'enter', messages: [timeMessage], startsRequestSeries: true })
const transformedDecision = __test.transformPreStepDecision(decision, config)
assert.notEqual(transformedDecision, decision)
assert.notEqual(transformedDecision.messages[0], timeMessage)
assert.match(transformedDecision.messages[0].content[0].text, /当前时间记录：2026-11-23T18:58:00\+08:00/)
assert.match(transformedDecision.messages[0].content[0].text, /模型可见消息：42s/)
assert.equal(decision.messages[0].content[0].text.startsWith('Time sampled'), true)
assert.equal(transformedDecision.startsRequestSeries, true)
assert.equal(transformedDecision.messages[0].source.sections[0].text, transformedDecision.messages[0].content[0].text)

// 3) Unknown / non-target data must pass through untouched.
const reject = deepFreeze({ kind: 'reject', reason: 'test', messages: [timeMessage] })
assert.equal(__test.transformPreStepDecision(reject, config), reject)

console.log('PASS: frozen prompt presentation transformed without mutation')
console.log('PASS: frozen time-context message transformed without mutation')
console.log('PASS: non-target/rejected decisions remain untouched')


// 4) Mock the actual Cordis hook shape: apply(), then execute both waterfalls.
const tempProfile = mkdtempSync(join(tmpdir(), 'dsh-prompt-overrides-'))
const listeners = new Map()
const mockCtx = {
  get(key) {
    return key === 'profileContext' ? { dir: tempProfile } : undefined
  },
  logger: {
    info() {},
    warn() {},
    error() {},
  },
  on(event, handler, options) {
    listeners.set(event, { handler, options })
    return () => listeners.delete(event)
  },
}

apply(mockCtx, { configFile: 'prompt-overrides.json' })
assert.equal(existsSync(join(tempProfile, 'prompt-overrides.json')), true)
assert.equal(listeners.has('system-prompt/assemble'), true)
assert.equal(listeners.has('agent/pre-step'), true)
assert.equal(listeners.get('agent/pre-step').options.prepend, true)

const assembledByHook = await listeners.get('system-prompt/assemble').handler(
  {},
  {},
  async () => presentation,
)
assert.match(assembledByHook.sections.find(x => x.name === 'tool:read').text, /read 工具/)

const decisionByHook = await listeners.get('agent/pre-step').handler(
  {},
  async () => decision,
)
assert.match(decisionByHook.messages[0].content[0].text, /当前时间记录/)

console.log('PASS: apply() registers safe hooks and creates profile-local editable JSON')
