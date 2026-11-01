import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Engine, key, type Trigger } from '../src/core/index.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { pollGroups, qqKind, qqTrigger, sendQq } from '../src/sources/qq.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const ME = '2000000001'
const GROUP = '2000000002'

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'qq-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { qq: { enabled: true, config: { groups: [{ id: GROUP, listen: 'mentions' }] } } },
    policy: { sources: { qq: { allowed: [{ id: '2000000003' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(qqKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(async () => {}) }, executor: { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, qqKind) }
}

/** One group message as `napq` prints it. */
function message(id: string, fields: Record<string, unknown> = {}) {
  return { id, conversation: GROUP, thread: GROUP, sender: { id: '2000000003', bot: false },
    mentions_me: true, text: '@2000000001 帮我修一下这个 bug', at: '2026-11-02T00:00:00Z', seq: 3, ...fields }
}

function answer(h: ReturnType<typeof host>, page: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockResolvedValue(JSON.stringify(page()))
}

it('translates a group message into a Trigger and drops the agent\'s own message', () => {
  const trigger = qqTrigger(message('m1') as never, ME)
  expect(trigger?.id).toBe(key('qq', `${GROUP}:m1`))
  expect(trigger?.threads).toEqual([{ source: 'qq', id: GROUP }])
  expect(trigger?.actor).toEqual({ source: 'qq', id: '2000000003' })
  expect(trigger?.addressed).toBe('mention')
  expect(trigger?.human).toBe(true)
  expect(trigger?.channel?.address).toEqual({ conversation: GROUP, message: 'm1' })
  expect(trigger?.meta).toMatchObject({ conversation: GROUP, messageId: 'm1', seq: 3 })
  expect(qqTrigger(message('m2', { sender: { id: ME, bot: false } }) as never, ME)).toBeUndefined()
  // Without a mention the message carries no addressed marker.
  expect(qqTrigger(message('m3', { mentions_me: false }) as never, ME)?.addressed).toBeUndefined()
})

it('starts a newly listed group from now, then takes in what it holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  const config = qqKind.schema.parse({ groups: [{ id: GROUP, listen: 'mentions' }] }) as { groups: { id: string; listen: 'mentions' | 'all' }[]; pollSeconds: number }
  const run = answer(h, () => ({ me: ME, items: [message('m1'), { id: 'broken' }], next: { [GROUP]: 5 } }))
  // The first sight of a group records where to continue and takes in nothing: its backlog is history.
  expect(await pollGroups(h.ctx, new AbortController().signal, config)).toEqual({ read: 2, unreadable: 1 })
  expect(h.receive).not.toHaveBeenCalled()
  expect(h.store.get(KV.qq.cursor)).toBe(JSON.stringify({ [GROUP]: 5 }))
  // After the first sight, the same page is taken in, together with a message of a group that is not listed.
  run.mockResolvedValue(JSON.stringify({ me: ME,
    items: [message('m1'), { id: 'broken' }, message('m2', { conversation: '2000000004', mentions_me: false })], next: { [GROUP]: 5 } }))
  await pollGroups(h.ctx, new AbortController().signal, config)
  expect(h.receive.mock.results[0]!.value).toBe('stored')
  // A message of a group that is not listed is filtered with the Source's reason.
  expect(h.receive.mock.results[1]!.value).toBe('filtered')
  // A mention of an allowed sender is an explicit request.
  expect(h.engine.candidate(key('qq', `${GROUP}:m1`))?.strength).toBe('explicit')
  // A further round over the same page stores nothing new.
  await pollGroups(h.ctx, new AbortController().signal, config)
  expect(h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})

it('replies through the CLI once per message id, and treats a gone conversation as permanent', async () => {
  const h = host()
  const run = vi.spyOn(h.commands, 'run').mockResolvedValue('ok')
  const outbound = { id: 'r1', kind: 'reply' as const, text: '已收到，开始处理', channel: { source: 'qq', thread: `qq:${GROUP}`,
    address: { conversation: GROUP, message: 'm1' } } }
  expect(await sendQq({ commands: h.commands }, outbound)).toBe('sent')
  expect(run).toHaveBeenCalledWith('napq', ['reply', '--conversation', GROUP, '--to', 'm1', '--key', 'r1', '--text', '已收到，开始处理'])
  run.mockRejectedValue(new CliError('gone', 410, 1))
  expect(await sendQq({ commands: h.commands }, outbound)).toBe('gone')
  run.mockRejectedValue(new CliError('network down', 500, 1))
  await expect(sendQq({ commands: h.commands }, outbound)).rejects.toThrow('network down')
  h.store.close()
})
