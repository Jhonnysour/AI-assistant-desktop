// Tipos del contrato chat-v1 del backend (AI-assistant-backend/docs/api/chat-v1.md).
// Solo describen datos: los usan main (cliente HTTP) y el renderer (ViewModel).

export type ModelAccess = 'verified' | 'unverified';

export interface ModelInfo {
  id: string;
  display_name: string;
  access: ModelAccess;
}

export interface CreatedConversation {
  conversation_id: string;
  created_at: string;
  persisted: boolean;
}

export interface ConversationSummary {
  conversation_id: string;
  title: string | null;
  title_is_custom: boolean;
  created_at: string;
  updated_at: string;
}

export type ResponseStatus =
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface UserMessage {
  role: 'user';
  message_id: string;
  text: string;
  created_at: string;
}

export interface AssistantMessage {
  role: 'assistant';
  response_id: string;
  in_reply_to: string;
  text: string;
  status: ResponseStatus;
  error: ApiErrorBody | null;
  model_requested: string;
  model_reported: string | null;
  provider: string;
  created_at: string;
  finished_at: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  persisted: boolean;
  messages: Array<UserMessage | AssistantMessage>;
}

// Eventos SSE de POST /v1/conversations/{id}/messages, tal como los define chat-v1.
export interface MessageAcceptedData {
  message_id: string;
  response_id: string;
  created_at: string;
  model_requested: string;
  provider: string;
}

export interface ResponseDeltaData {
  response_id: string;
  text: string;
}

export interface ResponseCompletedData {
  response_id: string;
  finished_at: string;
  model_reported: string | null;
}

export interface ResponseFailedData {
  response_id: string;
  status: 'failed' | 'interrupted';
  finished_at: string;
  model_reported: string | null;
  error: ApiErrorBody & { retryable: boolean };
}

export interface ResponseCancelledData {
  response_id: string;
  finished_at: string;
}

export type ChatEvent =
  | { event: 'message.accepted'; data: MessageAcceptedData }
  | { event: 'response.delta'; data: ResponseDeltaData }
  | { event: 'response.completed'; data: ResponseCompletedData }
  | { event: 'response.failed'; data: ResponseFailedData }
  | { event: 'response.cancelled'; data: ResponseCancelledData };

export type ChatEventName = ChatEvent['event'];

export const FINAL_EVENTS: ReadonlySet<ChatEventName> = new Set([
  'response.completed',
  'response.failed',
  'response.cancelled',
]);
