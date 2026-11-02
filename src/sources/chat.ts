/**
 * DSH Web chat Source: turns composer messages (agent inbox inserts) into Triggers.
 * Skips orchestrator / worker sessions so Super Agent routing does not recurse into itself.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'chat'
const ACTOR = 'operator'

const ConfigSchema = z.object({
  /** When set, only messages starting with this prefix become Triggers (prefix is stripped). Empty = all. */
  prefix: z.string().default(''),
  /** Actor id stored on Triggers; must appear on Policy → Chat → allowed. */
  actorId: z.string().min(1).default(ACTOR),
}).strict()
export type ChatConfig = z.infer<typeof ConfigSchema>

export const chatChannel = (sessionId: string, messageId: string): ChannelRef =>
  ({ source: SOURCE, thread: `chat:${sessionId}`, address: { sessionId, messageId } })

export function messageText(message: UserMessage): string {
  const content = message.content as unknown
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object' && 'type' in part && (part as { type: string }).type === 'text'
      && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
      return (part as { text: string }).text
    }
    return ''
  }).join('').trim()
}

export function isManagedSession(sessionId: string): boolean {
  return sessionId.startsWith('orchestrator-') || sessionId.startsWith('worker-')
}

/** True when DSH should not call llm-deepseek (no key, or SCVD_CURSOR_ONLY=1). */
export function cursorOnlyMode(): boolean {
  if (process.env.SCVD_CURSOR_ONLY === '1' || process.env.SCVD_CURSOR_ONLY === 'true') return true
  return !String(process.env.DEEPSEEK_API_KEY ?? '').trim()
}

export function chatTrigger(input: {
  sessionId: string
  message: UserMessage
  actorId: string
  prefix: string
}): Trigger | undefined {
  if (isManagedSession(input.sessionId)) return undefined
  let text = messageText(input.message)
  if (!text) return undefined
  if (input.prefix) {
    if (!text.startsWith(input.prefix)) return undefined
    text = text.slice(input.prefix.length).trim()
    if (!text) return undefined
  }
  const messageId = String(input.message.id)
  return {
    id: key('chat', input.sessionId, messageId),
    source: SOURCE,
    threads: [{ source: SOURCE, id: input.sessionId }],
    actor: { source: SOURCE, id: input.actorId },
    human: true,
    addressed: 'direct',
    at: new Date().toISOString(),
    text,
    channel: chatChannel(input.sessionId, messageId),
    meta: { sessionId: input.sessionId, messageId },
  }
}

async function sendChat(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  // Replies surface in the Superagent panel / worker session; chat compose ack is optional.
  void host
  void message
  return 'sent'
}

export const chatKind: SourceKind<ChatConfig> = {
  kind: SOURCE,
  title: { zh: 'DSH 对话', en: 'DSH chat' },
  description: {
    zh: '把本机 DSH 网页聊天里的用户消息收成工单（替代 GitHub @）。',
    en: 'Turns user messages in this DSH Web chat into Tickets (instead of GitHub @-mentions).',
  },
  schema: ConfigSchema,
  fields: [
    {
      key: 'prefix', type: 'text',
      label: { zh: '触发前缀（可空）', en: 'Trigger prefix (optional)' },
      hint: {
        zh: '非空时只有以该前缀开头的消息会成工单，前缀会被去掉。留空则每条用户消息都成工单。',
        en: 'When set, only messages starting with this prefix become Tickets (prefix stripped). Empty = every user message.',
      },
    },
    {
      key: 'actorId', type: 'text',
      label: { zh: '策略中的发起人 ID', en: 'Policy actor id' },
      hint: {
        zh: '必须出现在「策略 → DSH 对话 → 能发起工作的用户」里（默认 operator）。',
        en: 'Must be listed under Policy → DSH chat → users who may originate work (default operator).',
      },
    },
  ],
  health: ['chat'],
  scope() {
    return { listened: true, observed: false, row: 'composer' }
  },
  channel: {
    send: sendChat,
    link: address => ({
      url: '',
      label: { zh: `会话 ${address.sessionId ?? ''}`, en: `Session ${address.sessionId ?? ''}` },
      triggerId: undefined,
    }),
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/\b[0-9a-f-]{8,}\b/gi) ?? [])] }),
  policy: {
    unnamed: { person: { zh: '本机用户', en: 'Local user' }, bot: { zh: '本机机器人', en: 'Local bot' } },
    schema: z.object({
      allowed: z.array(z.object({
        id: z.string().min(1),
        name: z.string().trim().max(100).optional(),
      }).strict()).default([{ id: ACTOR, name: 'Local operator' }]),
    }).strict(),
    fields: [
      {
        key: 'allowed', type: 'rows',
        label: { zh: '能发起工作的本机用户', en: 'Local users who may originate work' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'ID', en: 'ID' } },
          { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
        ],
      },
    ],
    explicit: {
      zh: '聊天里发给智能体的消息（视为私聊直达）',
      en: 'A chat message to the agent (treated as a direct request)',
    },
    rows: () => [{
      id: 'composer',
      label: { zh: '网页对话', en: 'Web composer' },
      note: { zh: '本机 DSH 会话', en: 'Local DSH sessions' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
    }],
  },
}

export const name = 'dsh-superagent-chat'
export const inject = ['orchestrator']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(chatKind), 'chat: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, chatKind)
    const dispose = watchInbox(ctx, source)
    source.report('chat', { state: 'ready', detail: 'Listening for DSH chat messages' })
    return dispose
  })
}

function watchInbox(ctx: Context, source: SourceContext): () => void {
  const handler = (payload: { agent: Agent; message: UserMessage }) => {
    try {
      const sessionId = String(payload.agent.id ?? '')
      if (!sessionId || sessionId.startsWith('worker-')) return

      const text = messageText(payload.message)
      if (!text) return
      // Avoid feedback: divert ack / system notes must not create more Cursor tickets.
      if (text.startsWith('Cursor-only mode:') || text.startsWith('Running Cursor SDK worker')) return

      // No DeepSeek key: never let the main Session / composer call llm-deepseek.
      // Park as a Cursor-owned ticket instead (same path as HTTP intake).
      if (cursorOnlyMode()) {
        const divert = ctx.orchestrator.divertComposerToCursor
        if (!divert) {
          source.report('chat', {
            state: 'error',
            detail: 'Cursor-only mode but divertComposerToCursor is unavailable',
          })
          return
        }
        void divert.call(ctx.orchestrator, payload.agent, text).then(
          result => {
            source.report('chat', {
              state: 'ready',
              detail: result.ticketId
                ? `Cursor divert → ticket ${result.ticketId}`
                : 'Cursor divert (no ticket id)',
            })
          },
          (error: unknown) => {
            source.report('chat', { state: 'error', detail: String(error) })
          },
        )
        return
      }

      // DeepSeek available: normal chat Source → Trigger → router (skip orchestrator/worker).
      if (isManagedSession(sessionId)) return
      const config = source.config<ChatConfig>(SOURCE) ?? ConfigSchema.parse({})
      const trigger = chatTrigger({
        sessionId,
        message: payload.message,
        actorId: config.actorId,
        prefix: config.prefix,
      })
      if (!trigger) return
      void Promise.resolve(source.receive(trigger)).catch((error: unknown) => {
        source.report('chat', { state: 'error', detail: String(error) })
      })
    } catch (error) {
      source.report('chat', { state: 'error', detail: String(error) })
    }
  }
  // Cordis event from @deepseek-ai/dsh-agent
  return ctx.on('agent/inbox/inserted', handler)
}
