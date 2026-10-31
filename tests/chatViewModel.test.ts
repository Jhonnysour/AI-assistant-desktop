// ViewModel del chat con un puente falso: sin Electron, sin red y sin React.

import { describe, expect, it, vi } from 'vitest';
import type {
  AppError,
  AssistantBridge,
  Result,
  StreamMessage,
} from '../src/shared/bridge';
import type { ChatEvent, ConversationDetail } from '../src/shared/chat-api';
import {
  ChatViewModel,
  type AssistantItem,
} from '../src/renderer/features/chat/chatViewModel';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: AppError): Result<T> => ({ ok: false, error });

const BACKEND_DOWN: AppError = {
  code: 'backend_unavailable',
  message: 'No se pudo conectar con el backend del asistente.',
  retryable: true,
};

class FakeBridge implements AssistantBridge {
  persisted = true;
  sendResult: Result<{ streamId: string }> | null = null;
  cancelResult: Result<null> = ok(null);
  private streamCount = 0;
  private readonly streamListeners = new Map<
    string,
    (m: StreamMessage) => void
  >();
  readonly pending = new Map<string, StreamMessage[]>();
  readonly unsubscribed: string[] = [];

  listModels = vi.fn(async () =>
    ok([
      { id: 'otro', display_name: 'Otro', access: 'unverified' as const },
      {
        id: 'fake-model',
        display_name: 'Modelo simulado',
        access: 'verified' as const,
      },
    ]),
  );
  listConversations = vi.fn(async () => ok([]));
  createConversation = vi.fn(async () =>
    ok({ conversation_id: 'c1', created_at: 't', persisted: this.persisted }),
  );
  getConversation = vi.fn(
    async (_id: string): Promise<Result<ConversationDetail>> =>
      fail({ code: 'conversation_not_found', message: 'No existe.' }),
  );
  renameConversation = vi.fn(async (id: string, title: string | null) =>
    ok({
      conversation_id: id,
      title,
      title_is_custom: title !== null,
      created_at: 't',
      updated_at: 't',
    }),
  );
  deleteConversation = vi.fn(async (_id: string) => ok(null));
  sendMessage = vi.fn(async (_c: string, _m: string, _t: string) => {
    if (this.sendResult) return this.sendResult;
    return ok({ streamId: `s${++this.streamCount}` });
  });
  cancelResponse = vi.fn(async (_c: string, _r: string) => this.cancelResult);

  onStreamEvent(streamId: string, listener: (m: StreamMessage) => void) {
    for (const message of this.pending.get(streamId) ?? []) listener(message);
    this.streamListeners.set(streamId, listener);
    return () => {
      this.streamListeners.delete(streamId);
      this.unsubscribed.push(streamId);
    };
  }

  emit(streamId: string, chat: ChatEvent) {
    this.streamListeners.get(streamId)?.({ streamId, kind: 'chat', chat });
  }

  disconnect(streamId: string, error: AppError) {
    this.streamListeners.get(streamId)?.({
      streamId,
      kind: 'disconnected',
      error,
    });
  }
}

const accepted = (responseId = 'r1'): ChatEvent => ({
  event: 'message.accepted',
  data: {
    message_id: 'm1',
    response_id: responseId,
    created_at: 't',
    model_requested: 'fake-model',
    provider: 'fake',
  },
});
const delta = (text: string): ChatEvent => ({
  event: 'response.delta',
  data: { response_id: 'r1', text },
});
const completed: ChatEvent = {
  event: 'response.completed',
  data: { response_id: 'r1', finished_at: 't', model_reported: 'fake-model' },
};

async function setup() {
  const bridge = new FakeBridge();
  const vm = new ChatViewModel(bridge);
  await vm.init();
  return { bridge, vm };
}

const lastAssistant = (vm: ChatViewModel) =>
  vm
    .getSnapshot()
    .items.findLast((i) => i.kind === 'assistant') as AssistantItem;

async function sendText(vm: ChatViewModel, text: string) {
  vm.setDraft(text);
  await vm.send();
}

describe('ChatViewModel', () => {
  it('prefiere un modelo de acceso comprobado al cargar el catálogo', async () => {
    const { vm } = await setup();
    expect(vm.getSnapshot().selectedModel).toBe('fake-model');
  });

  it('AC-01: no envía un mensaje vacío y muestra validación', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, '   \n ');
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(bridge.createConversation).not.toHaveBeenCalled();
    expect(vm.getSnapshot().validation).toBeTruthy();
  });

  it('AC-02: muestra fragmentos y después el estado completado', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, 'Hola');
    const state = vm.getSnapshot();
    expect(state.items[0]).toMatchObject({ kind: 'user', text: 'Hola' });
    expect(state.sendPhase).toBe('streaming');
    expect(state.draft).toBe('');
    expect(bridge.sendMessage).toHaveBeenCalledWith('c1', 'fake-model', 'Hola');

    bridge.emit('s1', accepted());
    bridge.emit('s1', delta('Hola, '));
    expect(lastAssistant(vm)).toMatchObject({
      status: 'streaming',
      text: 'Hola, ',
    });
    expect(vm.canSend).toBe(false);
    bridge.emit('s1', delta('mundo'));
    bridge.emit('s1', completed);

    expect(lastAssistant(vm)).toMatchObject({
      status: 'completed',
      text: 'Hola, mundo',
    });
    expect(vm.getSnapshot().sendPhase).toBe('idle');
    expect(vm.canSend).toBe(true);
    expect(bridge.listModels).toHaveBeenCalledTimes(2); // refresca el acceso comprobado
  });

  it('AC-07: un doble envío solo inicia una solicitud', async () => {
    const { bridge, vm } = await setup();
    vm.setDraft('Hola');
    await Promise.all([vm.send(), vm.send()]);
    expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
    expect(bridge.createConversation).toHaveBeenCalledTimes(1);
    vm.setDraft('Otra');
    await vm.send();
    expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('AC-04: un fallo del proveedor termina la actividad con error recuperable y reintento', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, 'Hola');
    bridge.emit('s1', accepted());
    bridge.emit('s1', {
      event: 'response.failed',
      data: {
        response_id: 'r1',
        status: 'failed',
        finished_at: 't',
        model_reported: null,
        error: {
          code: 'provider_unavailable',
          message: 'No se pudo contactar.',
          retryable: true,
        },
      },
    });
    const item = lastAssistant(vm);
    expect(item).toMatchObject({
      status: 'failed',
      error: { retryable: true },
    });
    expect(vm.getSnapshot().sendPhase).toBe('idle');

    await vm.retry(item.key);
    expect(bridge.sendMessage).toHaveBeenLastCalledWith(
      'c1',
      'fake-model',
      'Hola',
    );
    expect(bridge.createConversation).toHaveBeenCalledTimes(1);
  });

  it('no reintenta si el error no es recuperable', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, 'Hola');
    bridge.emit('s1', accepted());
    bridge.emit('s1', {
      event: 'response.failed',
      data: {
        response_id: 'r1',
        status: 'failed',
        finished_at: 't',
        model_reported: null,
        error: {
          code: 'model_unavailable',
          message: 'No disponible.',
          retryable: false,
        },
      },
    });
    await vm.retry(lastAssistant(vm).key);
    expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('AC-05: un corte a mitad conserva el parcial como interrumpido', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, 'Hola');
    bridge.emit('s1', accepted());
    bridge.emit('s1', delta('parcial'));
    bridge.disconnect('s1', {
      code: 'connection_lost',
      message: 'Se perdió.',
      retryable: true,
    });
    expect(lastAssistant(vm)).toMatchObject({
      status: 'interrupted',
      text: 'parcial',
      error: { code: 'connection_lost' },
    });
    expect(vm.canSend).toBe(true);
  });

  it('un corte sin texto queda como fallida', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, 'Hola');
    bridge.disconnect('s1', {
      code: 'connection_lost',
      message: 'Se perdió.',
      retryable: true,
    });
    expect(lastAssistant(vm).status).toBe('failed');
  });

  it('AC-06: cancelar llama al backend, marca el parcial y vuelve a permitir enviar', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, 'Hola');
    expect(vm.canCancel).toBe(false); // aún sin response_id
    bridge.emit('s1', accepted());
    bridge.emit('s1', delta('algo'));
    expect(vm.canCancel).toBe(true);

    await vm.cancel();
    expect(bridge.cancelResponse).toHaveBeenCalledWith('c1', 'r1');
    expect(bridge.unsubscribed).toEqual(['s1']);
    expect(lastAssistant(vm)).toMatchObject({
      status: 'cancelled',
      text: 'algo',
    });
    expect(vm.canSend).toBe(true);
  });

  it('si la respuesta ya había terminado al cancelar, espera su evento final', async () => {
    const { bridge, vm } = await setup();
    bridge.cancelResult = fail({
      code: 'response_not_active',
      message: 'Ya terminó.',
    });
    await sendText(vm, 'Hola');
    bridge.emit('s1', accepted());
    await vm.cancel();
    expect(vm.getSnapshot().error).toBeNull();
    expect(vm.getSnapshot().sendPhase).toBe('streaming');
    bridge.emit('s1', completed);
    expect(lastAssistant(vm).status).toBe('completed');
  });

  it('procesa mensajes entregados de forma síncrona al suscribirse, incluido el final', async () => {
    const { bridge, vm } = await setup();
    bridge.pending.set('s1', [
      { streamId: 's1', kind: 'chat', chat: accepted() },
      { streamId: 's1', kind: 'chat', chat: delta('rápido') },
      { streamId: 's1', kind: 'chat', chat: completed },
    ]);
    await sendText(vm, 'Hola');
    expect(lastAssistant(vm)).toMatchObject({
      status: 'completed',
      text: 'rápido',
    });
    expect(vm.getSnapshot().sendPhase).toBe('idle');
  });

  it('un error antes del stream devuelve el texto al cuadro y lo muestra', async () => {
    const { bridge, vm } = await setup();
    bridge.sendResult = fail(BACKEND_DOWN);
    await sendText(vm, 'Hola');
    const state = vm.getSnapshot();
    expect(state.items).toEqual([]);
    expect(state.draft).toBe('Hola');
    expect(state.error).toEqual(BACKEND_DOWN);
    expect(state.sendPhase).toBe('idle');
  });

  it('avisa si el backend no persiste la conversación', async () => {
    const { bridge, vm } = await setup();
    bridge.persisted = false;
    await sendText(vm, 'Hola');
    expect(vm.getSnapshot().persisted).toBe(false);
  });

  it('detecta el backend apagado y se recupera al reintentar', async () => {
    const bridge = new FakeBridge();
    bridge.listModels.mockResolvedValueOnce(fail(BACKEND_DOWN));
    bridge.listConversations.mockResolvedValueOnce(fail(BACKEND_DOWN));
    const vm = new ChatViewModel(bridge);
    await vm.init();
    expect(vm.backendUnavailable).toBe(true);
    await vm.init();
    expect(vm.backendUnavailable).toBe(false);
    expect(vm.getSnapshot().selectedModel).toBe('fake-model');
  });

  it('abre una conversación con su historial y estados', async () => {
    const { bridge, vm } = await setup();
    bridge.getConversation.mockResolvedValueOnce(
      ok({
        conversation_id: 'c9',
        title: 'Hola',
        title_is_custom: false,
        created_at: 't',
        updated_at: 't',
        persisted: true,
        messages: [
          { role: 'user', message_id: 'm1', text: 'Hola', created_at: 't' },
          {
            role: 'assistant',
            response_id: 'r1',
            in_reply_to: 'm1',
            text: 'Hol',
            status: 'interrupted',
            error: { code: 'interrupted', message: 'Se interrumpió.' },
            model_requested: 'fake-model',
            model_reported: null,
            provider: 'fake',
            created_at: 't',
            finished_at: 't',
          },
        ],
      }),
    );
    await vm.openConversation('c9');
    const state = vm.getSnapshot();
    expect(state.activeConversationId).toBe('c9');
    expect(state.items[1]).toMatchObject({
      status: 'interrupted',
      text: 'Hol',
      replyTo: 'Hola',
    });

    await sendText(vm, 'Sigue');
    expect(bridge.createConversation).not.toHaveBeenCalled();
    expect(bridge.sendMessage).toHaveBeenCalledWith(
      'c9',
      'fake-model',
      'Sigue',
    );
  });

  it('no cambia de conversación mientras hay una respuesta activa', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, 'Hola');
    await vm.openConversation('c2');
    vm.newConversation();
    expect(bridge.getConversation).not.toHaveBeenCalled();
    expect(vm.getSnapshot().activeConversationId).toBe('c1');
  });

  it('renombra (vacío vuelve al título derivado) y borra la conversación activa', async () => {
    const { bridge, vm } = await setup();
    await vm.renameConversation('c1', '  Sábado ');
    expect(bridge.renameConversation).toHaveBeenLastCalledWith('c1', 'Sábado');
    await vm.renameConversation('c1', '   ');
    expect(bridge.renameConversation).toHaveBeenLastCalledWith('c1', null);

    await sendText(vm, 'Hola');
    bridge.emit('s1', accepted());
    expect(await vm.deleteConversation('c1')).toBe(false); // respuesta en curso
    bridge.emit('s1', completed);
    expect(await vm.deleteConversation('c1')).toBe(true);
    expect(vm.getSnapshot()).toMatchObject({
      activeConversationId: null,
      items: [],
    });
  });

  it('al desmontar se da de baja del stream activo', async () => {
    const { bridge, vm } = await setup();
    await sendText(vm, 'Hola');
    vm.dispose();
    expect(bridge.unsubscribed).toEqual(['s1']);
  });
});
