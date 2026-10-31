// Handlers IPC del puente `window.assistant`. Cada handler comprueba que lo llama el frame
// principal de nuestra interfaz y valida sus argumentos antes de llamar al backend.

import { randomUUID } from 'node:crypto';
import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import {
  IPC,
  type AppError,
  type Result,
  type StreamMessage,
} from '../shared/bridge';
import type { ChatApiClient } from './api/client';
import {
  idAndTitle,
  isPathId,
  noArgs,
  oneId,
  sendArgs,
  twoIds,
  type Validator,
} from './ipcArgs';

const INVALID_REQUEST: AppError = {
  code: 'invalid_request',
  message: 'La aplicación hizo una petición no válida.',
};

interface ActiveStream {
  controller: AbortController;
  owner: WebContents;
}

export function registerIpc(
  client: ChatApiClient,
  isAllowedOrigin: (origin: string) => boolean,
): void {
  const streams = new Map<string, ActiveStream>();
  const watched = new WeakSet<WebContents>();

  const isTrustedSender = (
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): boolean => {
    const frame = event.senderFrame;
    return (
      frame !== null && frame.parent === null && isAllowedOrigin(frame.origin)
    );
  };

  const abortStreamsOf = (owner: WebContents) => {
    for (const [streamId, stream] of streams) {
      if (stream.owner === owner) {
        stream.controller.abort();
        streams.delete(streamId);
      }
    }
  };

  // Cerrar la ventana, recargarla o perder el proceso del renderer aborta sus streams.
  const watch = (owner: WebContents) => {
    if (watched.has(owner)) return;
    watched.add(owner);
    owner.once('destroyed', () => abortStreamsOf(owner));
    owner.on('render-process-gone', () => abortStreamsOf(owner));
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) abortStreamsOf(owner);
    });
  };

  function handle<A extends unknown[]>(
    channel: string,
    valid: Validator<A>,
    run: (event: IpcMainInvokeEvent, ...args: A) => Promise<Result<unknown>>,
  ) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) {
        console.warn(`IPC rechazado (${channel}): origen no permitido`);
        return { ok: false, error: INVALID_REQUEST };
      }
      if (!valid(args)) {
        console.warn(`IPC rechazado (${channel}): argumentos no válidos`);
        return { ok: false, error: INVALID_REQUEST };
      }
      return run(event, ...args);
    });
  }

  handle(IPC.listModels, noArgs, () => client.listModels());
  handle(IPC.createConversation, noArgs, () => client.createConversation());
  handle(IPC.listConversations, noArgs, () => client.listConversations());
  handle(IPC.getConversation, oneId, (_e, id) => client.getConversation(id));
  handle(IPC.renameConversation, idAndTitle, (_e, id, title) =>
    client.renameConversation(id, title),
  );
  handle(IPC.deleteConversation, oneId, (_e, id) =>
    client.deleteConversation(id),
  );
  handle(IPC.cancelResponse, twoIds, (_e, conversationId, responseId) =>
    client.cancelResponse(conversationId, responseId),
  );

  handle(
    IPC.sendMessage,
    sendArgs,
    async (event, conversationId, model, text) => {
      const owner = event.sender;
      watch(owner);
      const controller = new AbortController();
      const result = await client.sendMessage(
        conversationId,
        model,
        text,
        controller.signal,
      );
      if (!result.ok) return result;
      if (owner.isDestroyed()) {
        controller.abort();
        return { ok: false, error: INVALID_REQUEST };
      }

      const streamId = randomUUID();
      streams.set(streamId, { controller, owner });
      const forward = (message: StreamMessage) => {
        if (streams.has(streamId) && !owner.isDestroyed()) {
          owner.send(IPC.streamMessage, message);
        }
      };
      void result.value
        .run((chat) => forward({ streamId, kind: 'chat', chat }))
        .then((outcome) => {
          if (outcome.kind === 'disconnected') {
            forward({ streamId, kind: 'disconnected', error: outcome.error });
          }
        })
        .finally(() => streams.delete(streamId));
      return { ok: true, value: { streamId } };
    },
  );

  // El renderer se da de baja de un stream: se aborta la petición (no cancela en el backend).
  ipcMain.on(IPC.streamRelease, (event, streamId: unknown) => {
    if (!isTrustedSender(event) || !isPathId(streamId)) return;
    const stream = streams.get(streamId);
    if (stream && stream.owner === event.sender) {
      stream.controller.abort();
      streams.delete(streamId);
    }
  });
}
