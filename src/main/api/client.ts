// Cliente del backend (contrato chat-v1). Se ejecuta en el proceso main con el fetch global de
// Node: no usa `net` de Electron, que aplicaría el proxy del sistema a 127.0.0.1.
// No importa Electron, así que se prueba en Node contra un servidor HTTP simulado.

import type { AppError, Result } from '../../shared/bridge';
import {
  FINAL_EVENTS,
  type ChatEvent,
  type ConversationDetail,
  type ConversationSummary,
  type CreatedConversation,
  type ModelInfo,
} from '../../shared/chat-api';
import { SseParser } from './sse';
import {
  parseChatEvent,
  parseConversationDetail,
  parseConversations,
  parseCreatedConversation,
  parseErrorBody,
  parseModels,
  parseSummary,
} from './validate';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';

// Errores propios de la app (no vienen del backend). Sus mensajes se pueden mostrar.
export const LOCAL_ERRORS = {
  backendUnavailable: {
    code: 'backend_unavailable',
    message:
      'No se pudo conectar con el backend del asistente. Comprueba que está arrancado y vuelve a intentarlo.',
    retryable: true,
  },
  backendTimeout: {
    code: 'backend_timeout',
    message:
      'El backend del asistente no respondió a tiempo. Vuelve a intentarlo.',
    retryable: true,
  },
  unexpectedResponse: {
    code: 'unexpected_response',
    message: 'El backend del asistente respondió de forma inesperada.',
    retryable: false,
  },
  connectionLost: {
    code: 'connection_lost',
    message:
      'Se perdió la conexión con el backend antes de completar la respuesta.',
    retryable: true,
  },
  streamIdle: {
    code: 'stream_idle',
    message: 'El backend dejó de enviar datos antes de completar la respuesta.',
    retryable: true,
  },
} satisfies Record<string, AppError>;

export type StreamOutcome =
  | { kind: 'final' }
  | { kind: 'disconnected'; error: AppError }
  | { kind: 'aborted' };

export interface MessageStream {
  // Lee el stream hasta el evento final, un corte o el aborto de la señal recibida.
  run(onEvent: (event: ChatEvent) => void): Promise<StreamOutcome>;
}

export interface ChatApiClientOptions {
  baseUrl?: string;
  // Tiempo máximo hasta recibir la cabecera de la respuesta.
  requestTimeoutMs?: number;
  // Tiempo máximo sin recibir bytes del stream. El backend envía `: ping` cada 15 s.
  streamIdleTimeoutMs?: number;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: AppError): Result<T> => ({ ok: false, error });

export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`URL del backend no válida: ${raw}`);
  }
  return url.toString().replace(/\/+$/, '');
}

export class ChatApiClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(options: ChatApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 45_000;
  }

  listModels(): Promise<Result<ModelInfo[]>> {
    return this.request('GET', '/v1/models', undefined, parseModels);
  }

  createConversation(): Promise<Result<CreatedConversation>> {
    return this.request(
      'POST',
      '/v1/conversations',
      undefined,
      parseCreatedConversation,
    );
  }

  listConversations(): Promise<Result<ConversationSummary[]>> {
    return this.request(
      'GET',
      '/v1/conversations',
      undefined,
      parseConversations,
    );
  }

  getConversation(conversationId: string): Promise<Result<ConversationDetail>> {
    return this.request(
      'GET',
      conversationPath(conversationId),
      undefined,
      parseConversationDetail,
    );
  }

  renameConversation(
    conversationId: string,
    title: string | null,
  ): Promise<Result<ConversationSummary>> {
    return this.request(
      'PATCH',
      conversationPath(conversationId),
      { title },
      parseSummary,
    );
  }

  deleteConversation(conversationId: string): Promise<Result<null>> {
    return this.request(
      'DELETE',
      conversationPath(conversationId),
      undefined,
      null,
    );
  }

  cancelResponse(
    conversationId: string,
    responseId: string,
  ): Promise<Result<null>> {
    const path = `${conversationPath(conversationId)}/responses/${encodeURIComponent(responseId)}/cancel`;
    return this.request('POST', path, undefined, null);
  }

  // Envía el mensaje y espera la cabecera. Si el backend lo rechaza antes del stream, devuelve
  // el error; si lo acepta, devuelve el stream para leerlo. Abortar `signal` corta la conexión
  // (el backend lo registra como interrumpido: no es una cancelación).
  async sendMessage(
    conversationId: string,
    model: string,
    text: string,
    signal: AbortSignal,
  ): Promise<Result<MessageStream>> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) controller.abort();
    const cleanup = () => signal.removeEventListener('abort', onAbort);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}${conversationPath(conversationId)}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ model, text }),
          signal: controller.signal,
        },
      );
    } catch {
      cleanup();
      return fail(
        timedOut
          ? LOCAL_ERRORS.backendTimeout
          : LOCAL_ERRORS.backendUnavailable,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const error = await errorFromResponse(response);
      cleanup();
      return fail(error);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const body = response.body;
    if (!contentType.startsWith('text/event-stream') || body === null) {
      controller.abort();
      cleanup();
      return fail(LOCAL_ERRORS.unexpectedResponse);
    }
    return ok({
      run: (onEvent) =>
        this.readStream(
          body,
          controller,
          () => signal.aborted,
          onEvent,
        ).finally(cleanup),
    });
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    controller: AbortController,
    abortedByCaller: () => boolean,
    onEvent: (event: ChatEvent) => void,
  ): Promise<StreamOutcome> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let idleTimedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, this.streamIdleTimeoutMs);
    };

    resetIdle();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return abortedByCaller()
            ? { kind: 'aborted' }
            : { kind: 'disconnected', error: LOCAL_ERRORS.connectionLost };
        }
        resetIdle();
        for (const message of parser.push(
          decoder.decode(value, { stream: true }),
        )) {
          const event = parseChatEvent(message.event, message.data);
          if (event === undefined) continue;
          if (event === null) {
            controller.abort();
            return {
              kind: 'disconnected',
              error: LOCAL_ERRORS.unexpectedResponse,
            };
          }
          onEvent(event);
          if (FINAL_EVENTS.has(event.event)) {
            controller.abort();
            return { kind: 'final' };
          }
        }
      }
    } catch {
      if (abortedByCaller()) return { kind: 'aborted' };
      return {
        kind: 'disconnected',
        error: idleTimedOut
          ? LOCAL_ERRORS.streamIdle
          : LOCAL_ERRORS.connectionLost,
      };
    } finally {
      clearTimeout(idleTimer);
    }
  }

  // `parse` null indica que el éxito esperado es 204 sin cuerpo.
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    parse: ((json: unknown) => T | null) | null,
  ): Promise<Result<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers:
          body === undefined
            ? undefined
            : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      const timedOut =
        err instanceof DOMException && err.name === 'TimeoutError';
      return fail(
        timedOut
          ? LOCAL_ERRORS.backendTimeout
          : LOCAL_ERRORS.backendUnavailable,
      );
    }

    if (!response.ok) return fail(await errorFromResponse(response));
    if (parse === null) {
      await response.body?.cancel();
      return response.status === 204
        ? ok(null as T)
        : fail(LOCAL_ERRORS.unexpectedResponse);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return fail(LOCAL_ERRORS.unexpectedResponse);
    }
    const value = parse(json);
    return value === null ? fail(LOCAL_ERRORS.unexpectedResponse) : ok(value);
  }
}

function conversationPath(conversationId: string): string {
  return `/v1/conversations/${encodeURIComponent(conversationId)}`;
}

// El backend responde {"error": {"code", "message"}}; cualquier otra forma (p. ej. el 400 en
// texto plano por cabecera Host no válida) se trata como respuesta inesperada.
async function errorFromResponse(response: Response): Promise<AppError> {
  try {
    const body = parseErrorBody(await response.json());
    if (body !== null) return body;
  } catch {
    // Cuerpo vacío o no JSON.
  }
  return LOCAL_ERRORS.unexpectedResponse;
}
