# 009 QQ Source, step by step

This document walks through this repository's real QQ Source, `src/sources/qq.ts`, as a worked example of the recipe in [008 Cookbook](008-cookbook.md). It uses the terms of [001 Domain model](001-domain.md), the rules of [002 Authorization](002-authorization.md) and the components of [007 Architecture](007-architecture.md).

QQ speaks OneBot v11, not a CLI. The Source therefore ships `napq`, a small dependency-free Python CLI under `napq/` in this repository, which translates between a local OneBot v11 HTTP endpoint (such as [NapCat](https://napneko.github.io/)) and the CLI contract the host expects — the third transport alongside `gh` for GitHub and `lark-cli` for Feishu. A group message crosses two translations on its way in: OneBot JSON → `napq` items → a Trigger.

## The CLI contract

- `napq pull --groups <id,id> --after '<json map>' --json` prints `{"me": "<bot QQ number>", "items": […], "next": {"<group>": <seq>, …}}`. An item carries `id`, `conversation`, `thread`, `sender: {id, bot}`, `mentions_me`, `text`, `at`, `seq` (the group's per-group message sequence) and an optional `reply_to`. `napq` drops the bot's own messages itself.
- `napq reply --conversation <group> --to <message id> --key <key> --text <text>` posts one group message quoting the original, once per key (idempotency keys persist in `~/.config/napq/replied.json`). The contract reserves error code `410` for a conversation that can never receive the message again.
- `napq thread --conversation <group> --root <message id> --json` prints a page of the group's flat history, oldest first, without pagination.

## 1. Map the events onto the domain

| Concept | For QQ |
| --- | --- |
| Trigger | One group message |
| Thread | The group itself, flat: every message of a group shares one Thread `<group>` |
| Actor | The sender's QQ number, as the allowed list names it |
| Channel address | The group and the message id a reply quotes |
| Receiving scope | One group, with its own admission-table row |

A QQ group has no per-message reply trees the way GitHub comments do, so the Thread is the whole group. Replying quotes a message instead of splitting a Thread. This is the same shape the Feishu Source gives a chat.

## 2. Configuration: schema, fields, facts and health

`ConfigSchema` holds the configured groups and the poll interval:

```ts
const GroupSchema = z.object({
  id: z.string().regex(/^[0-9]{5,12}$/),
  name: z.string().trim().max(60).optional(),
  listen: z.enum(['mentions', 'all']),
}).strict()
const ConfigSchema = z.object({
  groups: z.array(GroupSchema).refine(…, 'Duplicate group IDs').default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
```

The kind declares `health: ['qq']` and the settings form fields for groups (`id`, `name`, `listen`) plus the advanced poll interval. It declares no `facts`: unlike `gh` and `lark-cli`, `napq` is not probed by setup, so there is no verified account fact to display — a broken setup surfaces later, through the Source's health (step 9).

## 3. Translate a message into a Trigger

```ts
export function qqTrigger(message: QqMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  return {
    id: key(SOURCE, `${message.conversation}:${message.id}`),
    source: SOURCE,
    threads: [{ source: SOURCE, id: message.conversation }],
    actor: { source: SOURCE, id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at, text: message.text,
    channel: { source: SOURCE, thread: threadKey({ source: SOURCE, id: message.conversation }),
      address: { conversation: message.conversation, message: message.id } },
    meta: { conversation: message.conversation, messageId: message.id, seq: message.seq,
      ...(message.reply_to ? { replyTo: message.reply_to } : {}) },
  }
}
```

- **Stable ids.** The Trigger id combines the group and the message id, so a re-poll that replays messages stores them as `duplicate` and duplicate accepts create one Ticket.
- **Threads.** One flat Thread per group. `threadKey` turns it into the persisted Thread key.
- **Sender and addressing.** `mentions_me` comes from `napq`, which matched `@<bot QQ number>` segments; it gives an allowed sender's message explicit strength. QQ numbers are readable names, so the kind declares `unnamed` labels only for list displays.
- **Search.** `find(query)` turns every 5–12-digit number in the panel's search box into a text-search term, so pasting a QQ number or a group id finds the Triggers that mention it.

## 4. What the Source receives: scope

```ts
scope({ meta }, config) {
  const group = config.groups.find(item => item.id === meta.conversation)
  if (!group) return { listened: false, reason: 'group_not_listed' }
  return { listened: true, observed: group.listen === 'all', row: group.id }
},
```

Each configured group is its own admission row. With "全部消息" (`listen: 'all'`) the row gains the unaddressed-message cells, letting the admission table turn ordinary group chatter into inferred candidates; with "仅 @" only mentions and follow-ups enter. Resuming an ended Ticket needs the group still configured (`listened`), not `observed`.

## 5. Replies: the Channel

```ts
channel: {
  allowed: (address, config) => config.groups.some(item => item.id === address.conversation),
  send: sendQq,
  link: address => ({ url: '', label: { zh: `QQ 群 ${address.conversation ?? ''}`, en: `QQ group ${address.conversation ?? ''}` } }),
},
```

`sendQq` runs `napq reply` with the Outbox message id as the idempotency key — `napq` records sent keys in `replied.json`, so an Outbox retry after an ambiguous failure never posts twice. Code `410` answers `gone` (the group is gone or the bot left it); every other failure throws, and Outbox retries after 5 seconds, doubling to 300 seconds. `link` returns no URL — QQ has no web permalink to point at — so the panel shows a label only.

## 6. Thread context for assessments

```ts
threadContext: {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, _part, _cursor) => {
    const page = ThreadPageSchema.parse(JSON.parse(await commands.run('napq', ['thread', '--conversation',
      String(trigger.meta.conversation), '--root', String(trigger.meta.messageId), '--json'])))
    const messages = page.items.map(…)
    return { messages, body: { messages } },
  },
},
repliesTo: trigger => typeof trigger.meta.replyTo === 'string' && typeof trigger.meta.conversation === 'string'
  ? key(SOURCE, `${trigger.meta.conversation}:${trigger.meta.replyTo}`) : undefined,
```

A group is flat, so `napq thread` prints the history up to the requested message in one page and the Source needs no cursor here. `repliesTo` connects a quoted reply to the Trigger it answers, letting follow-up notices and worker Inputs show the replied-to message.

## 7. Who may ask: the Source's part of the Policy

```ts
policy: {
  unnamed: { person: { zh: 'QQ 用户', en: 'QQ user' }, bot: { zh: 'QQ 账号', en: 'QQ account' } },
  schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[0-9]{5,12}$/), name: … }).strict())
    .refine(…, 'Duplicate QQ numbers').default([]) }).strict(),
  fields: […],
  explicit: { zh: '名单里的人在群里 @ 机器人。', en: 'Someone on the list mentions the bot in a group.' },
  rows: stored => ConfigSchema.parse(stored).groups.map(group => {
    const all = group.listen === 'all'
    return { id: group.id, label: group.name || group.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
      cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } },
  }),
},
```

The allowed list names QQ numbers; the `unnamed` labels keep list displays readable. Note the cells: `unlistedAddressed` is always `true`, so in a configured group anyone can @ the bot to make an explicit request — QQ groups are small and personal, closer to the Feishu support-chat case than to a public repository. Turn "全部消息" on to also receive unaddressed chatter for the admission table to judge. The kind declares no `bots` list: OneBot v11 does not reliably identify other bots, and `napq` reports every sender as a person.

## 8. Variables for the Executor

```ts
environment: {
  variables: [{ key: 'DSH_SUPERAGENT_QQ_GROUP', description: {
    zh: '接下工单的 QQ 群号；工单不是从这个来源来的时为空', … } }],
  values: ({ trigger }) => ({ DSH_SUPERAGENT_QQ_GROUP: trigger?.source === SOURCE ? String(trigger.meta.conversation ?? '') : '' }),
},
```

A worker replying in the group passes this group to `napq reply --conversation`.

## 9. The plugin entry and its loop

The entry registers `qqKind` and runs `watch` over a `SourceContext`, exactly as the recipe shows: it waits for `ctx.ready`, reports `setupPending` until setup resolves, reports `sourceOff` while the Source is switched off, and only then polls.

```ts
export async function pollGroups(ctx: SourceContext, signal: AbortSignal, config: QqConfig) {
  let after: Record<string, number> = {}
  const stored = ctx.state.get(KV.qq.cursor)
  if (stored) { try { after = JSON.parse(stored) } catch { after = {} } }
  // A group seen for the first time starts from now: its backlog is history, not requests.
  const firstSight = new Set(config.groups.filter(group => !(group.id in after)).map(group => group.id))
  const output = await ctx.commands.withSignal(signal).run('napq', ['pull', '--groups', …, '--after', JSON.stringify(after), '--json'])
  …
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The QQ Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    if (firstSight.has(message.data.conversation)) continue
    const trigger = qqTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    …ctx.threads.describe(threadKey(ref), { ...(group?.name ? { label: group.name } : {}), facts })
  }
  ctx.state.set(KV.qq.cursor, JSON.stringify(page.next))
  return { read: page.items.length, unreadable }
}
```

The interesting part is the **first-sight rule**: `pull` reads each group's recent history, so a newly configured group would otherwise flood the intake with old messages. The round records every first-seen group's cursor (its backlog counts as history, not requests) and takes in only the messages that arrive from the next round on. Cursor failures keep the old map, and stable ids make a replay safe regardless. The cursor map lives at `KV.qq.cursor` — one record for all groups, named in [src/kv.ts](../src/kv.ts) as the recipe requires.

Three consecutive failed rounds report the `qq` health entry as `error`; one failure just retries next round. The loop checks `signal.aborted` between items and passes the signal to `withSignal` and to `delay`, so a stop or restart ends it at once.

## 10. Register the plugin

`tsdown.config.ts` builds `'qq-watch': 'src/sources/qq.ts'`, `package.json` exports `"./qq-watch": "./lib/qq-watch.js"`, and the bundle's `cordis.patch.yml` inserts `dsh-superagent-qq`, disabled, after the Feishu plugin. `tests/docs.spec.ts` checks that the module and test tables of [007 Architecture](007-architecture.md) list both files.

## 11. Tests

`tests/qq.spec.ts` follows the recipe's `host()` pattern: a real Store in a temporary directory, a `SourceRegistry` on a `HealthBoard`, an Engine with stand-in ports, and a real `Commands` built on the deployment fixture. CLI answers are mocked by spying on `Commands.run` (and on `withSignal`, which otherwise returns a new instance) — no `napq` process is ever spawned. The tests cover:

- the translation: stable id `qq:<group>:<message id>`, the flat group Thread, the actor, `human` and `addressed`, the Channel address, `meta.seq` and `replyTo`; the agent's own message produces no Trigger;
- a poll round: a first-seen group records its cursor and takes in nothing, a malformed item counts as `unreadable`, an unlisted group arrives `filtered` as `group_not_listed`, an allowed sender's mention becomes an `explicit` candidate, a re-poll answers `duplicate`, and the cursor map persists to `KV.qq.cursor`;
- replies: the exact `napq reply` arguments, code `410` settling as `gone`, and any other failure rethrown for Outbox to retry.

## What this Source deliberately does not do

- No pull-request binding: QQ has no pull requests, so the kind implements none of `bindThread`/`threadClosed` — a Ticket that started on QQ ends through its reports, not through a Thread closing.
- No `bots` list and no `refreshLabels`: OneBot v11 reports no bot identities, and group names come from the operator's configuration instead of a chat-membership API.
- No per-source CLI setting: `napq` runs from the service PATH, as [006 Deployment](006-deployment.md) describes.
