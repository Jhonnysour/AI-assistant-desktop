// Comprobación de forma de las respuestas JSON del backend. Devuelven null si no encajan con
// chat-v1, para que main no reenvíe al renderer datos con una forma inesperada.

import type {
  ApiErrorBody,
  AssistantMessage,
  ChatEvent,
  ConversationDetail,
  ConversationSummary,
  CreatedConversation,
  ModelInfo,
  ResponseStatus,
  UserMessage,
} from '../../shared/chat-api';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const STATUSES: readonly ResponseStatus[] = [
  'streaming',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
];

function listOf<T>(
  value: unknown,
  parse: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const raw of value) {
    const item = parse(raw);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

export function parseErrorBody(json: unknown): ApiErrorBody | null {
  if (!isObj(json) || !isObj(json.error)) return null;
  const { code, message } = json.error;
  return isStr(code) && isStr(message) ? { code, message } : null;
}

function parseModel(v: unknown): ModelInfo | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.display_name)) return null;
  if (v.access !== 'verified' && v.access !== 'unverified') return null;
  return { id: v.id, display_name: v.display_name, access: v.access };
}

export function parseModels(json: unknown): ModelInfo[] | null {
  return isObj(json) ? listOf(json.models, parseModel) : null;
}

export function parseCreatedConversation(
  json: unknown,
): CreatedConversation | null {
  if (!isObj(json) || !isStr(json.conversation_id) || !isStr(json.created_at))
    return null;
  if (!isBool(json.persisted)) return null;
  return {
    conversation_id: json.conversation_id,
    created_at: json.created_at,
    persisted: json.persisted,
  };
}

export function parseSummary(v: unknown): ConversationSummary | null {
  if (!isObj(v) || !isStr(v.conversation_id) || !isStrOrNull(v.title))
    return null;
  if (
    !isBool(v.title_is_custom) ||
    !isStr(v.created_at) ||
    !isStr(v.updated_at)
  )
    return null;
  return {
    conversation_id: v.conversation_id,
    title: v.title,
    title_is_custom: v.title_is_custom,
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

export function parseConversations(
  json: unknown,
): ConversationSummary[] | null {
  return isObj(json) ? listOf(json.conversations, parseSummary) : null;
}

function parseHistoryMessage(
  v: unknown,
): UserMessage | AssistantMessage | null {
  if (!isObj(v)) return null;
  if (v.role === 'user') {
    if (!isStr(v.message_id) || !isStr(v.text) || !isStr(v.created_at))
      return null;
    return {
      role: 'user',
      message_id: v.message_id,
      text: v.text,
      created_at: v.created_at,
    };
  }
  if (v.role !== 'assistant') return null;
  if (!isStr(v.response_id) || !isStr(v.in_reply_to) || !isStr(v.text))
    return null;
  if (!STATUSES.includes(v.status as ResponseStatus)) return null;
  const error = v.error === null ? null : parseErrorBody({ error: v.error });
  if (v.error !== null && error === null) return null;
  if (
    !isStr(v.model_requested) ||
    !isStrOrNull(v.model_reported) ||
    !isStr(v.provider)
  ) {
    return null;
  }
  if (!isStr(v.created_at) || !isStrOrNull(v.finished_at)) return null;
  return {
    role: 'assistant',
    response_id: v.response_id,
    in_reply_to: v.in_reply_to,
    text: v.text,
    status: v.status as ResponseStatus,
    error,
    model_requested: v.model_requested,
    model_reported: v.model_reported,
    provider: v.provider,
    created_at: v.created_at,
    finished_at: v.finished_at,
  };
}

export function parseConversationDetail(
  json: unknown,
): ConversationDetail | null {
  const summary = parseSummary(json);
  if (summary === null || !isObj(json) || !isBool(json.persisted)) return null;
  const messages = listOf(json.messages, parseHistoryMessage);
  return messages === null
    ? null
    : { ...summary, persisted: json.persisted, messages };
}

// Devuelve undefined para eventos desconocidos (se ignoran) y null si un evento conocido
// tiene datos inválidos.
export function parseChatEvent(
  event: string,
  rawData: string,
): ChatEvent | null | undefined {
  const known = [
    'message.accepted',
    'response.delta',
    'response.completed',
    'response.failed',
    'response.cancelled',
  ];
  if (!known.includes(event)) return undefined;
  let d: unknown;
  try {
    d = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (!isObj(d) || !isStr(d.response_id)) return null;
  switch (event) {
    case 'message.accepted':
      if (!isStr(d.message_id) || !isStr(d.created_at)) return null;
      if (!isStr(d.model_requested) || !isStr(d.provider)) return null;
      return {
        event: 'message.accepted',
        data: {
          message_id: d.message_id,
          response_id: d.response_id,
          created_at: d.created_at,
          model_requested: d.model_requested,
          provider: d.provider,
        },
      };
    case 'response.delta':
      if (!isStr(d.text)) return null;
      return {
        event: 'response.delta',
        data: { response_id: d.response_id, text: d.text },
      };
    case 'response.completed':
      if (!isStr(d.finished_at) || !isStrOrNull(d.model_reported)) return null;
      return {
        event: 'response.completed',
        data: {
          response_id: d.response_id,
          finished_at: d.finished_at,
          model_reported: d.model_reported,
        },
      };
    case 'response.failed': {
      if (d.status !== 'failed' && d.status !== 'interrupted') return null;
      if (
        !isStr(d.finished_at) ||
        !isStrOrNull(d.model_reported) ||
        !isObj(d.error)
      ) {
        return null;
      }
      const { code, message, retryable } = d.error;
      if (!isStr(code) || !isStr(message) || !isBool(retryable)) return null;
      return {
        event: 'response.failed',
        data: {
          response_id: d.response_id,
          status: d.status,
          finished_at: d.finished_at,
          model_reported: d.model_reported,
          error: { code, message, retryable },
        },
      };
    }
    case 'response.cancelled':
      if (!isStr(d.finished_at)) return null;
      return {
        event: 'response.cancelled',
        data: { response_id: d.response_id, finished_at: d.finished_at },
      };
  }
  return undefined;
}
