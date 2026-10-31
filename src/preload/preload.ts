// Puente entre el renderer y main. Expone solo métodos concretos del chat: ni ipcRenderer
// genérico, ni Node, ni el objeto del evento IPC.

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AssistantBridge,
  type StreamMessage,
} from '../shared/bridge';

type Listener = (message: StreamMessage) => void;

const listeners = new Map<string, Listener>();
// Mensajes que llegan antes de que el renderer se suscriba a su stream.
const pending = new Map<string, StreamMessage[]>();
const released = new Set<string>();

const isFinal = (message: StreamMessage) =>
  message.kind === 'disconnected' ||
  message.chat.event === 'response.completed' ||
  message.chat.event === 'response.failed' ||
  message.chat.event === 'response.cancelled';

ipcRenderer.on(IPC.streamMessage, (_event, message: StreamMessage) => {
  const listener = listeners.get(message.streamId);
  if (listener) {
    if (isFinal(message)) listeners.delete(message.streamId);
    listener(message);
    return;
  }
  if (released.has(message.streamId)) return;
  const queue = pending.get(message.streamId) ?? [];
  queue.push(message);
  pending.set(message.streamId, queue);
});

const bridge: AssistantBridge = {
  listModels: () => ipcRenderer.invoke(IPC.listModels),
  createConversation: () => ipcRenderer.invoke(IPC.createConversation),
  listConversations: () => ipcRenderer.invoke(IPC.listConversations),
  getConversation: (conversationId) =>
    ipcRenderer.invoke(IPC.getConversation, conversationId),
  renameConversation: (conversationId, title) =>
    ipcRenderer.invoke(IPC.renameConversation, conversationId, title),
  deleteConversation: (conversationId) =>
    ipcRenderer.invoke(IPC.deleteConversation, conversationId),
  sendMessage: (conversationId, model, text) =>
    ipcRenderer.invoke(IPC.sendMessage, conversationId, model, text),
  cancelResponse: (conversationId, responseId) =>
    ipcRenderer.invoke(IPC.cancelResponse, conversationId, responseId),

  // Entrega primero los mensajes pendientes (de forma síncrona) y después los nuevos. Tras el
  // mensaje final la suscripción termina sola; darse de baja antes aborta la petición en main.
  onStreamEvent: (streamId, listener) => {
    if (typeof streamId !== 'string' || typeof listener !== 'function') {
      throw new TypeError('onStreamEvent: argumentos no válidos');
    }
    const queued = pending.get(streamId) ?? [];
    pending.delete(streamId);
    let finished = false;
    for (const message of queued) {
      listener(message);
      if (isFinal(message)) finished = true;
    }
    if (!finished) listeners.set(streamId, listener);
    return () => {
      if (listeners.get(streamId) !== listener) return;
      listeners.delete(streamId);
      released.add(streamId);
      ipcRenderer.send(IPC.streamRelease, streamId);
    };
  },
};

contextBridge.exposeInMainWorld('assistant', bridge);
