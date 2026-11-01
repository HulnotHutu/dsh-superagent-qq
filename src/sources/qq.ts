/** QQ (OneBot v11) Source kind: the napq CLI contract, trigger translation, Channel, thread context, and plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ChannelLink, ContextMessage, Localized, SourceKind, ThreadContext } from './kind.ts'

export const SOURCE = 'qq'

const GroupSchema = z.object({
  id: z.string().regex(/^[0-9]{5,12}$/),
  name: z.string().trim().max(60).optional(),
  listen: z.enum(['mentions', 'all']),
}).strict()
const ConfigSchema = z.object({
  groups: z.array(GroupSchema)
    .refine(groups => new Set(groups.map(group => group.id)).size === groups.length, 'Duplicate group IDs').default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type QqConfig = z.infer<typeof ConfigSchema>

/** One group message as `napq pull` and `napq thread` print it; `seq` is the group's per-group message sequence. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().min(1),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), seq: z.number().int().default(0), reply_to: z.string().optional(),
})
type QqMessage = z.infer<typeof MessageSchema>
/** The answer of `napq pull`, whose items are read one by one; `next` holds each group's sequence to continue after. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.record(z.string(), z.number().int()) })
/** The answer of `napq thread`: one page of the group's flat history, oldest first. */
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema) })

/** The Trigger of one group message; the agent's own messages produce none. A group is one flat Thread. */
export function qqTrigger(message: QqMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  return {
    id: key(SOURCE, `${message.conversation}:${message.id}`),
    source: SOURCE,
    threads: [{ source: SOURCE, id: message.conversation }],
    actor: { source: SOURCE, id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: SOURCE, thread: threadKey({ source: SOURCE, id: message.conversation }),
      address: { conversation: message.conversation, message: message.id } },
    meta: { conversation: message.conversation, messageId: message.id, seq: message.seq,
      ...(message.reply_to ? { replyTo: message.reply_to } : {}) },
  }
}

export async function sendQq(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing QQ reply target')
  try {
    await host.commands.run('napq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id, '--text', message.text])
    return 'sent'
  } catch (error) {
    // The reply CLI reports a conversation it can no longer reach with code 410 on standard error.
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}

const threadContext: ThreadContext<QqConfig> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  // A QQ group is one flat Thread: a page is the messages up to the requested one, oldest first, without pagination.
  read: async (commands, trigger, _part, _cursor) => {
    const page = ThreadPageSchema.parse(JSON.parse(await commands.run('napq', ['thread', '--conversation',
      String(trigger.meta.conversation), '--root', String(trigger.meta.messageId), '--json'])))
    const messages: ContextMessage[] = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
      ...(item.sender.bot ? { bot: true as const } : {}), ...(item.reply_to ? { reply_to: item.reply_to } : {}) }))
    return { messages, body: { messages } }
  },
}

export const qqKind: SourceKind<QqConfig> = {
  kind: SOURCE,
  title: { zh: 'QQ', en: 'QQ' },
  description: { zh: '接收下列 QQ 群里发给机器人的消息。', en: 'Receives messages to the bot in these QQ groups.' },
  schema: ConfigSchema,
  fields: [
    { key: 'groups', type: 'rows', label: { zh: '接收的群', en: 'Groups' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的群里的后续；“全部消息”也接收其余消息，评估可以按规则从中推断工作。', en: '"@ only" receives messages that mention the bot and follow-ups in groups with Tickets; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '群号', en: 'Group ID' }, pattern: '[0-9]{5,12}' },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
          { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['qq'],
  scope({ meta }, config) {
    const group = config.groups.find(item => item.id === meta.conversation)
    if (!group) return { listened: false, reason: 'group_not_listed' }
    return { listened: true, observed: group.listen === 'all', row: group.id }
  },
  channel: {
    allowed: (address, config) => config.groups.some(item => item.id === address.conversation),
    send: sendQq,
    link: address => ({ url: '', label: { zh: `QQ 群 ${address.conversation ?? ''}`, en: `QQ group ${address.conversation ?? ''}` } }) satisfies ChannelLink,
  },
  threadContext,
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' && typeof trigger.meta.conversation === 'string'
    ? key(SOURCE, `${trigger.meta.conversation}:${trigger.meta.replyTo}`) : undefined,
  find: query => ({ threads: [], terms: [...new Set(query.match(/[0-9]{5,12}/g) ?? [])] }),
  policy: {
    unnamed: { person: { zh: 'QQ 用户', en: 'QQ user' }, bot: { zh: 'QQ 账号', en: 'QQ account' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[0-9]{5,12}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate QQ numbers').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 QQ 号', en: 'QQ numbers who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'QQ 号', en: 'QQ number' }, pattern: '[0-9]{5,12}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单里的人在群里 @ 机器人。', en: 'Someone on the list mentions the bot in a group.' },
    rows: stored => ConfigSchema.parse(stored).groups.map(group => {
      const all = group.listen === 'all'
      return { id: group.id, label: group.name || group.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_QQ_GROUP', description: {
      zh: '接下工单的 QQ 群号；工单不是从这个来源来的时为空',
      en: 'The QQ group that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_QQ_GROUP: trigger?.source === SOURCE ? String(trigger.meta.conversation ?? '') : '' }),
  },
}

export const name = 'dsh-superagent-qq'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(qqKind), 'qq: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, qqKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('qq', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('qq', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<QqConfig>(SOURCE)
    if (!config) ctx.report('qq', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollGroups(ctx, signal, config)
        failures = 0
        ctx.report('qq', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('qq', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read each listed group after its cursor, take in each message, then move the cursors past them. */
export async function pollGroups(ctx: SourceContext, signal: AbortSignal, config: QqConfig): Promise<{ read: number; unreadable: number }> {
  if (!config.groups.length) return { read: 0, unreadable: 0 }
  let after: Record<string, number> = {}
  const stored = ctx.state.get(KV.qq.cursor)
  if (stored) { try { after = JSON.parse(stored) as Record<string, number> } catch { after = {} } }
  // A group seen for the first time starts from now: its backlog is history, not requests.
  const firstSight = new Set(config.groups.filter(group => !(group.id in after)).map(group => group.id))
  const output = await ctx.commands.withSignal(signal).run('napq', ['pull', '--groups', config.groups.map(group => group.id).join(','),
    '--after', JSON.stringify(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The QQ Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    if (firstSight.has(message.data.conversation)) continue
    const trigger = qqTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const group = config.groups.find(entry => entry.id === message.data.conversation)
    const facts = { group: { label: { zh: '群号', en: 'Group' } as Localized, value: message.data.conversation } }
    for (const ref of trigger.threads) {
      ctx.threads.describe(threadKey(ref), { ...(group?.name ? { label: group.name } : {}), facts })
    }
  }
  ctx.state.set(KV.qq.cursor, JSON.stringify(page.next))
  return { read: page.items.length, unreadable }
}
