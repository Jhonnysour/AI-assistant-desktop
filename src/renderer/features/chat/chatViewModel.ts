// ViewModel del chat. No depende de React: expone un estado inmutable, suscripción a cambios
// y acciones. Toda la comunicación con el backend pasa por el puente del preload.

import type {
  AppError,
  AssistantBridge,
  StreamMessage,
} from '../../../shared/bridge';
import type {
  ChatEvent,
  ConversationDetail,
  ConversationSummary,
  ModelInfo,
  ResponseStatus,
} from '../../../shared/chat-api';

export interface UserItem {
  kind: 'user';
  key: string;
  text: string;
}

export interface AssistantItem {
  kind: 'assistant';
  key: string;
  responseId: string | null;
  text: string;
  status: ResponseStatus;
  // `retryable` solo se conoce en respuestas de esta sesión: el historial no lo guarda.
  error: AppError | null;
  // Texto del usuario al que responde: reintentar es enviarlo de nuevo.
  replyTo: string;
}

export type ChatItem = UserItem | AssistantItem;

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ChatState {
  models: ModelInfo[];
  modelsStatus: LoadStatus;
  modelsError: AppError | null;
  selectedModel: string | null;

  conversations: ConversationSummary[];
  conversationsStatus: LoadStatus;
  conversationsError: AppError | null;

  // null: conversación nueva que se crea en el backend con el primer envío.
  activeConversationId: string | null;
  conversationStatus: LoadStatus;
  // null hasta saberlo; false si el backend funciona sin base de datos.
  persisted: boolean | null;
  items: ChatItem[];

  draft: string;
  validation: string | null;
  // Último error de una acción, para mostrarlo hasta que se descarte o se haga otra acción.
  error: AppError | null;

  // 'starting': esperando a que el backend acepte el envío; 'streaming': recibiendo la respuesta.
  sendPhase: 'idle' | 'starting' | 'streaming';
  cancelling: boolean;
}

export const BACKEND_UNAVAILABLE = 'backend_unavailable';

export const initialChatState: ChatState = {
  models: [],
  modelsStatus: 'idle',
  modelsError: null,
  selectedModel: null,
  conversations: [],
  conversationsStatus: 'idle',
  conversationsError: null,
  activeConversationId: null,
  conversationStatus: 'ready',
  persisted: null,
  items: [],
  draft: '',
  validation: null,
  error: null,
  sendPhase: 'idle',
  cancelling: false,
};

interface ActiveStream {
  streamId: string;
  conversationId: string;
  assistantKey: string;
  unsubscribe: (() => void) | null;
}

export class ChatViewModel {
  private state: ChatState = initialChatState;
  private readonly listeners = new Set<() => void>();
  private stream: ActiveStream | null = null;
  private nextKey = 0;
  private conversationRequest = 0;

  constructor(private readonly bridge: AssistantBridge) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ChatState => this.state;

  // Derivados para la vista.
  get canSend(): boolean {
    return (
      this.state.sendPhase === 'idle' &&
      this.state.conversationStatus !== 'loading'
    );
  }

  get canCancel(): boolean {
    const item = this.activeAssistantItem();
    return (
      this.state.sendPhase === 'streaming' &&
      !this.state.cancelling &&
      !!item?.responseId
    );
  }

  // Backend apagado: ni el catálogo ni la lista de conversaciones han podido cargarse.
  get backendUnavailable(): boolean {
    const { modelsError, conversationsError } = this.state;
    return (
      modelsError?.code === BACKEND_UNAVAILABLE &&
      conversationsError?.code === BACKEND_UNAVAILABLE
    );
  }

  async init(): Promise<void> {
    await Promise.all([this.loadModels(), this.loadConversations()]);
  }

  async loadModels(): Promise<void> {
    this.set({ modelsStatus: 'loading', modelsError: null });
    const result = await this.bridge.listModels();
    if (!result.ok) {
      this.set({ modelsStatus: 'error', modelsError: result.error });
      return;
    }
    const models = result.value;
    const current = this.state.selectedModel;
    const keep = current !== null && models.some((m) => m.id === current);
    const preferred = models.find((m) => m.access === 'verified') ?? models[0];
    this.set({
      models,
      modelsStatus: 'ready',
      selectedModel: keep ? current : (preferred?.id ?? null),
    });
  }

  async loadConversations(): Promise<void> {
    this.set({ conversationsStatus: 'loading', conversationsError: null });
    const result = await this.bridge.listConversations();
    if (result.ok) {
      this.set({ conversations: result.value, conversationsStatus: 'ready' });
    } else {
      this.set({
        conversationsStatus: 'error',
        conversationsError: result.error,
      });
    }
  }

  selectModel(modelId: string): void {
    if (this.state.models.some((m) => m.id === modelId)) {
      this.set({ selectedModel: modelId, validation: null });
    }
  }

  setDraft(text: string): void {
    this.set({ draft: text, validation: null });
  }

  dismissError(): void {
    this.set({ error: null });
  }

  // Mientras hay una respuesta activa no se cambia de conversación: primero hay que cancelarla.
  newConversation(): void {
    if (this.state.sendPhase !== 'idle') return;
    this.conversationRequest++;
    this.set({
      activeConversationId: null,
      conversationStatus: 'ready',
      persisted: null,
      items: [],
      validation: null,
      error: null,
    });
  }

  async openConversation(conversationId: string): Promise<void> {
    if (this.state.sendPhase !== 'idle') return;
    const request = ++this.conversationRequest;
    this.set({
      activeConversationId: conversationId,
      conversationStatus: 'loading',
      items: [],
      persisted: null,
      validation: null,
      error: null,
    });
    const result = await this.bridge.getConversation(conversationId);
    if (request !== this.conversationRequest) return;
    if (!result.ok) {
      this.set({ conversationStatus: 'error', error: result.error });
      return;
    }
    this.set({
      conversationStatus: 'ready',
      persisted: result.value.persisted,
      items: this.itemsFromHistory(result.value),
    });
  }

  // Un título vacío vuelve al derivado del primer mensaje.
  async renameConversation(
    conversationId: string,
    title: string,
  ): Promise<boolean> {
    const trimmed = title.trim();
    const result = await this.bridge.renameConversation(
      conversationId,
      trimmed === '' ? null : trimmed,
    );
    if (!result.ok) {
      this.set({ error: result.error });
      return false;
    }
    this.set({
      error: null,
      conversations: this.state.conversations.map((c) =>
        c.conversation_id === conversationId ? result.value : c,
      ),
    });
    void this.loadConversations();
    return true;
  }

  // La confirmación la pide la vista antes de llamar aquí: borrar es definitivo.
  async deleteConversation(conversationId: string): Promise<boolean> {
    if (this.stream?.conversationId === conversationId) return false;
    const result = await this.bridge.deleteConversation(conversationId);
    if (!result.ok) {
      this.set({ error: result.error });
      return false;
    }
    this.set({
      error: null,
      conversations: this.state.conversations.filter(
        (c) => c.conversation_id !== conversationId,
      ),
    });
    if (this.state.activeConversationId === conversationId)
      this.newConversation();
    void this.loadConversations();
    return true;
  }

  async send(): Promise<void> {
    if (!this.canSend) return;
    const text = this.state.draft;
    if (text.trim() === '') {
      this.set({ validation: 'Escribe un mensaje antes de enviar.' });
      return;
    }
    await this.startSend(text);
  }

  // Reintentar es enviar un mensaje nuevo con el mismo texto; solo si el error lo permite.
  async retry(assistantKey: string): Promise<void> {
    const item = this.state.items.find((i) => i.key === assistantKey);
    if (item?.kind !== 'assistant' || !item.error?.retryable || !this.canSend)
      return;
    await this.startSend(item.replyTo);
  }

  async cancel(): Promise<void> {
    const stream = this.stream;
    const item = this.activeAssistantItem();
    if (!stream || !item?.responseId || this.state.cancelling) return;
    this.set({ cancelling: true });
    const result = await this.bridge.cancelResponse(
      stream.conversationId,
      item.responseId,
    );
    this.set({ cancelling: false });
    if (this.stream !== stream) return; // El stream terminó mientras tanto.
    if (result.ok) {
      // El backend ya la registró como cancelada: se deja de leer el stream sin esperar más.
      stream.unsubscribe?.();
      this.finishStream('cancelled', null);
    } else if (result.error.code !== 'response_not_active') {
      // response_not_active: ya había terminado y su evento final está en camino.
      this.set({ error: result.error });
    }
  }

  // Al desmontar la vista o cerrar la ventana: se deja de leer el stream (main aborta).
  dispose(): void {
    this.stream?.unsubscribe?.();
    this.stream = null;
  }

  private async startSend(text: string): Promise<void> {
    const model = this.state.selectedModel;
    if (model === null) {
      this.set({ validation: 'Elige un modelo antes de enviar.' });
      return;
    }

    // Se bloquea el envío antes de cualquier espera: un doble clic no inicia dos solicitudes.
    const userKey = this.key();
    this.set({
      sendPhase: 'starting',
      draft: '',
      validation: null,
      error: null,
      items: [...this.state.items, { kind: 'user', key: userKey, text }],
    });

    let conversationId = this.state.activeConversationId;
    if (conversationId === null) {
      const created = await this.bridge.createConversation();
      if (!created.ok) {
        this.rollbackSend(userKey, text, created.error);
        return;
      }
      conversationId = created.value.conversation_id;
      this.conversationRequest++;
      this.set({
        activeConversationId: conversationId,
        persisted: created.value.persisted,
      });
    }

    const result = await this.bridge.sendMessage(conversationId, model, text);
    if (!result.ok) {
      this.rollbackSend(userKey, text, result.error);
      return;
    }

    const assistantKey = this.key();
    const stream: ActiveStream = {
      streamId: result.value.streamId,
      conversationId,
      assistantKey,
      unsubscribe: null,
    };
    this.stream = stream;
    this.set({
      sendPhase: 'streaming',
      items: [
        ...this.state.items,
        {
          kind: 'assistant',
          key: assistantKey,
          responseId: null,
          text: '',
          status: 'streaming',
          error: null,
          replyTo: text,
        },
      ],
    });
    // Puede entregar mensajes pendientes de forma síncrona, incluso el final.
    const unsubscribe = this.bridge.onStreamEvent(stream.streamId, (message) =>
      this.onStreamMessage(stream, message),
    );
    if (this.stream === stream) stream.unsubscribe = unsubscribe;
  }

  // Error antes del stream: el mensaje no se registró. Se quita y se devuelve el texto al cuadro.
  private rollbackSend(userKey: string, text: string, error: AppError): void {
    this.set({
      sendPhase: 'idle',
      items: this.state.items.filter((i) => i.key !== userKey),
      draft: this.state.draft === '' ? text : this.state.draft,
      error,
    });
    void this.loadConversations();
  }

  private onStreamMessage(stream: ActiveStream, message: StreamMessage): void {
    if (this.stream !== stream) return;
    if (message.kind === 'disconnected') {
      // Corte sin evento final: se conserva el parcial y no se presenta como completo (AC-05).
      const partial = this.activeAssistantItem()?.text ?? '';
      this.finishStream(
        partial === '' ? 'failed' : 'interrupted',
        message.error,
      );
      return;
    }
    this.applyChatEvent(message.chat);
  }

  private applyChatEvent(chat: ChatEvent): void {
    const item = this.activeAssistantItem();
    if (!item) return;
    if (chat.event === 'message.accepted') {
      this.updateAssistant({ responseId: chat.data.response_id });
      return;
    }
    if (item.responseId !== null && chat.data.response_id !== item.responseId)
      return;
    switch (chat.event) {
      case 'response.delta':
        this.updateAssistant({ text: item.text + chat.data.text });
        break;
      case 'response.completed':
        this.finishStream('completed', null);
        // Un modelo pasa a "acceso comprobado" tras una respuesta completada.
        void this.loadModels();
        break;
      case 'response.failed':
        this.finishStream(chat.data.status, chat.data.error);
        break;
      case 'response.cancelled':
        this.finishStream('cancelled', null);
        break;
    }
  }

  private finishStream(status: ResponseStatus, error: AppError | null): void {
    this.updateAssistant({ status, error });
    this.stream = null;
    this.set({ sendPhase: 'idle', cancelling: false });
    // El título y el orden de la lista cambian con cada envío.
    void this.loadConversations();
  }

  private activeAssistantItem(): AssistantItem | undefined {
    const key = this.stream?.assistantKey;
    const item = this.state.items.find((i) => i.key === key);
    return item?.kind === 'assistant' ? item : undefined;
  }

  private updateAssistant(patch: Partial<AssistantItem>): void {
    const key = this.stream?.assistantKey;
    this.set({
      items: this.state.items.map((i) =>
        i.key === key && i.kind === 'assistant' ? { ...i, ...patch } : i,
      ),
    });
  }

  private itemsFromHistory(detail: ConversationDetail): ChatItem[] {
    const userTexts = new Map<string, string>();
    return detail.messages.map((m): ChatItem => {
      if (m.role === 'user') {
        userTexts.set(m.message_id, m.text);
        return { kind: 'user', key: m.message_id, text: m.text };
      }
      return {
        kind: 'assistant',
        key: m.response_id,
        responseId: m.response_id,
        text: m.text,
        status: m.status,
        error: m.error,
        replyTo: userTexts.get(m.in_reply_to) ?? '',
      };
    });
  }

  private key(): string {
    return `local-${++this.nextKey}`;
  }

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
