// Contrato entre el renderer y el preload (window.assistant) y nombres de los canales IPC.

import type {
  ChatEvent,
  ConversationDetail,
  ConversationSummary,
  CreatedConversation,
  ModelInfo,
} from './chat-api';

// `message` siempre se puede mostrar al usuario: viene del backend (sin detalles técnicos)
// o es un mensaje propio de la app.
export interface AppError {
  code: string;
  message: string;
  retryable?: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

// Mensajes de un stream que main reenvía al renderer. `chat` son los eventos de chat-v1 sin
// modificar; `disconnected` es local: la conexión terminó sin evento final (AC-05).
export type StreamMessage =
  | { streamId: string; kind: 'chat'; chat: ChatEvent }
  | { streamId: string; kind: 'disconnected'; error: AppError };

export interface AssistantBridge {
  listModels(): Promise<Result<ModelInfo[]>>;
  createConversation(): Promise<Result<CreatedConversation>>;
  listConversations(): Promise<Result<ConversationSummary[]>>;
  getConversation(conversationId: string): Promise<Result<ConversationDetail>>;
  renameConversation(
    conversationId: string,
    title: string | null,
  ): Promise<Result<ConversationSummary>>;
  deleteConversation(conversationId: string): Promise<Result<null>>;
  // Resuelve cuando el backend acepta el envío (o lo rechaza antes de empezar el stream).
  sendMessage(
    conversationId: string,
    model: string,
    text: string,
  ): Promise<Result<{ streamId: string }>>;
  // Recibe también los mensajes que llegaron antes de suscribirse. Darse de baja antes del
  // final aborta la petición en main (no cancela en el backend: eso es cancelResponse).
  onStreamEvent(
    streamId: string,
    listener: (message: StreamMessage) => void,
  ): () => void;
  cancelResponse(
    conversationId: string,
    responseId: string,
  ): Promise<Result<null>>;
}

export const IPC = {
  listModels: 'assistant:list-models',
  createConversation: 'assistant:create-conversation',
  listConversations: 'assistant:list-conversations',
  getConversation: 'assistant:get-conversation',
  renameConversation: 'assistant:rename-conversation',
  deleteConversation: 'assistant:delete-conversation',
  sendMessage: 'assistant:send-message',
  cancelResponse: 'assistant:cancel-response',
  streamMessage: 'assistant:stream-message',
  streamRelease: 'assistant:stream-release',
} as const;
