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

// 1) Ordinary prompt sections are transformed immutably; runtime contexts are
// intentionally left alone here because their registered providers are scoped.
const presentation = deepFreeze({
  sections: [
    { name: 'tool:read', order: 100, text: 'Use the read tool — not shell commands like cat.', interpolate: true },
    { name: 'harness:source', order: 200, text: 'Current DeepSeek Harness implementation checkout: "C:\\dsh".', interpolate: false },
    { name: 'untouched', order: 300, text: 'keep me', interpolate: true },
  ],
  contexts: [
    { name: 'working-directory:current', text: 'Current working directory: "E:\\Work".', interpolate: false },
  ],
  marker: 'preserve',
})

const transformed = __test.transformPresentation(presentation, config, { logger: { warn() {} } })
assert.notEqual(transformed, presentation)
assert.match(transformed.sections.find(x => x.name === 'tool:read').text, /read 工具/)
assert.match(transformed.sections.find(x => x.name === 'harness:source').text, /源码目录/)
assert.equal(transformed.contexts[0].text, 'Current working directory: "E:\\Work".')
assert.equal(presentation.sections[0].text, 'Use the read tool — not shell commands like cat.')
assert.equal(transformed.marker, 'preserve')

// 2) Runtime-context providers preserve their dynamic facts and are registered
// in the Agent's scope with the original required flags.
const agentContextRegistrations = []
const agentPreStepListeners = []
const agent = {
  id: 'agent-test',
  session: { id: 'session-test' },
  ctx: {
    systemPrompt: {
      getContextOrder(name) {
        return ({
          WORKING_DIRECTORY: 10,
          SANDBOX_POLICY: 20,
          APPROVAL_POLICY: 30,
          SUBAGENT_DELEGATION: 40,
        })[name]
      },
      context(definition) {
        agentContextRegistrations.push(definition)
        return () => {
          const index = agentContextRegistrations.indexOf(definition)
          if (index >= 0) agentContextRegistrations.splice(index, 1)
        }
      },
    },
    on(event, handler, options) {
      const record = { event, handler, options }
      agentPreStepListeners.push(record)
      return () => {
        const index = agentPreStepListeners.indexOf(record)
        if (index >= 0) agentPreStepListeners.splice(index, 1)
      }
    },
  },
}

const services = {
  workingDirectory: { get: () => 'E:\\Work.Project' },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: 'E:\\Work.Project' }) },
  approval: { overrideOf: () => 'never', config: { policy: 'ask' } },
  subagents: { namesOf: () => ({ self: 'lead' }) },
  tools: { get: name => name === 'send_message' || name === 'list_agents' ? { name } : undefined },
  get: () => undefined,
}

const scopedDisposers = __test.installAgentOverrides(services, agent, () => config, { logger: { warn() {}, error() {} } })
assert.equal(agentContextRegistrations.length, 4)
assert.deepEqual(agentContextRegistrations.map(x => x.name), [
  'working-directory:current', 'sandbox:policy', 'approval:policy', 'subagent:identity',
])
assert.deepEqual(agentContextRegistrations.map(x => x.required), [true, false, false, true])
assert.equal(agentPreStepListeners.length, 1)
assert.equal(agentPreStepListeners[0].event, 'agent/pre-step')
assert.equal(agentPreStepListeners[0].options.prepend, true)

const byName = new Map(agentContextRegistrations.map(x => [x.name, x]))
assert.equal(
  byName.get('working-directory:current').text({ agent }).startsWith('当前工作目录：E:\\Work.Project'),
  true,
)
assert.match(byName.get('sandbox:policy').text({ agent }), /danger-full-access/)
assert.match(byName.get('approval:policy').text({ agent }), /审批模式：关闭/)
assert.match(byName.get('subagent:identity').text({ agent, scope: agent, toolSet: undefined }), /名称是 lead/)
const workspaceVariables = __test.extractVariables(
  'sandbox:policy',
  'Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: \"E:\\\\Work.Project\". Some platform temporary areas may also be writable.',
)
assert.equal(workspaceVariables.workspaceRoot, 'E:\\Work.Project')

// 3) Frozen time-context messages are cloned after the downstream pre-step
// listener has appended them. Both visible content and source metadata agree.
const timeText = 'Time sampled while preparing turn 12, step 1: 2026-11-23T18:58:00+08:00 [Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.\nElapsed since the preceding model-visible message: 42s.'
const timeMessage = deepFreeze({
  role: 'user',
  content: [{ type: 'text', text: timeText }],
  source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: timeText }] },
})
const decision = deepFreeze({ kind: 'enter', messages: [timeMessage], startsRequestSeries: true })
const transformedDecision = __test.transformPreStepDecision(decision, config)
assert.notEqual(transformedDecision, decision)
assert.notEqual(transformedDecision.messages[0], timeMessage)
assert.match(transformedDecision.messages[0].content[0].text, /当前时间记录：2026-11-23T18:58:00\+08:00/)
assert.match(transformedDecision.messages[0].content[0].text, /模型可见消息：42s/)
assert.equal(decision.messages[0].content[0].text, timeText)
assert.equal(transformedDecision.startsRequestSeries, true)
assert.equal(transformedDecision.messages[0].source.sections[0].text, transformedDecision.messages[0].content[0].text)

const scopedTimeDecision = await agentPreStepListeners[0].handler(
  { agent, turn: 12, step: 1 },
  async () => decision,
)
assert.match(scopedTimeDecision.messages[0].content[0].text, /当前时间记录：/)

// Non-time messages and rejected decisions pass through untouched.
const ordinaryMessage = deepFreeze({ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
const ordinaryDecision = deepFreeze({ kind: 'enter', messages: [ordinaryMessage] })
assert.equal(__test.transformPreStepDecision(ordinaryDecision, config), ordinaryDecision)
const reject = deepFreeze({ kind: 'reject' })
assert.equal(__test.transformPreStepDecision(reject, config), reject)

// 4) apply() installs section transform globally, but installs runtime contexts
// and the time wrapper on each Agent scope (including existing live agents).
const tempProfile = mkdtempSync(join(tmpdir(), 'dsh-prompt-overrides-'))
const globalListeners = new Map()
const effects = []
const existingAgent = {
  ...agent,
  id: 'existing-agent',
  session: { id: 'existing-session' },
  ctx: {
    ...agent.ctx,
    systemPrompt: {
      ...agent.ctx.systemPrompt,
      context(definition) {
        existingContextRegistrations.push(definition)
        return () => {
          const index = existingContextRegistrations.indexOf(definition)
          if (index >= 0) existingContextRegistrations.splice(index, 1)
        }
      },
    },
    on(event, handler, options) {
      const record = { event, handler, options }
      existingScopedListeners.push(record)
      return () => {
        const index = existingScopedListeners.indexOf(record)
        if (index >= 0) existingScopedListeners.splice(index, 1)
      }
    },
  },
}
const existingContextRegistrations = []
const existingScopedListeners = []
const mockCtx = {
  agents: { list: () => [existingAgent] },
  systemPrompt: {},
  workingDirectory: services.workingDirectory,
  sandboxPolicy: services.sandboxPolicy,
  approval: services.approval,
  subagents: services.subagents,
  tools: services.tools,
  get(key) {
    return key === 'profileContext' ? { dir: tempProfile } : undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  on(event, handler, options) {
    globalListeners.set(event, { handler, options })
    return () => globalListeners.delete(event)
  },
  effect(callback) {
    const dispose = callback()
    effects.push(dispose)
    return () => dispose?.()
  },
}

apply(mockCtx, { configFile: 'prompt-overrides.json' })
assert.equal(existsSync(join(tempProfile, 'prompt-overrides.json')), true)
assert.equal(globalListeners.has('system-prompt/assemble'), true)
assert.equal(globalListeners.has('agent/created'), true)
assert.equal(globalListeners.has('agent/disposed'), true)
assert.equal(globalListeners.has('agent/pre-step'), false)
assert.equal(existingContextRegistrations.length, 4)
assert.equal(existingScopedListeners.length, 1)
assert.equal(existingScopedListeners[0].options.prepend, true)

const assembledByHook = await globalListeners.get('system-prompt/assemble').handler(
  {}, {}, async () => presentation,
)
assert.match(assembledByHook.sections.find(x => x.name === 'tool:read').text, /read 工具/)

const newAgent = {
  ...existingAgent,
  id: 'new-agent',
  session: { id: 'new-session' },
  ctx: {
    ...existingAgent.ctx,
    systemPrompt: {
      ...existingAgent.ctx.systemPrompt,
      context(definition) { newAgentContextRegistrations.push(definition); return () => {} },
    },
    on(event, handler, options) { newAgentScopedListeners.push({ event, handler, options }); return () => {} },
  },
}
const newAgentContextRegistrations = []
const newAgentScopedListeners = []
await globalListeners.get('agent/created').handler({ agent: newAgent })
assert.equal(newAgentContextRegistrations.length, 4)
assert.equal(newAgentScopedListeners.length, 1)

// 5) Plugin unload removes the per-agent scoped registrations it owns.
for (const dispose of effects.reverse()) dispose?.()
assert.equal(existingContextRegistrations.length, 0)
assert.equal(existingScopedListeners.length, 0)

for (const dispose of scopedDisposers.reverse()) dispose?.()
assert.equal(agentContextRegistrations.length, 0)
assert.equal(agentPreStepListeners.length, 0)

console.log('PASS: ordinary prompt sections transformed without mutating frozen objects')
console.log('PASS: four runtime contexts registered as Agent-scoped providers with required flags preserved')
console.log('PASS: time-context wrapper registered per Agent and clones new snapshots immutably')
console.log('PASS: existing and future Agents receive overrides; plugin unload disposes its scoped registrations')
