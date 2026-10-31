// Cliente de main contra un servidor HTTP simulado que habla chat-v1.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChatApiClient,
  LOCAL_ERRORS,
  normalizeBaseUrl,
} from '../src/main/api/client';
import type { ChatEvent } from '../src/shared/chat-api';

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

let server: Server | null = null;

async function startServer(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));
    server = null;
  }
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sseHead = (res: ServerResponse) =>
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const ACCEPTED = {
  message_id: 'm1',
  response_id: 'r1',
  created_at: '2026-10-31T10:00:00Z',
  model_requested: 'fake-model',
  provider: 'fake',
};

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Un puerto donde no escucha nadie: se abre un servidor, se toma su puerto y se cierra.
async function closedPortUrl(): Promise<string> {
  const url = await startServer(() => undefined);
  await new Promise((resolve) => server!.close(resolve));
  server = null;
  return url;
}

describe('peticiones simples', () => {
  it('lista modelos', async () => {
    const baseUrl = await startServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/v1/models');
      json(res, 200, {
        models: [
          {
            id: 'fake-model',
            display_name: 'Modelo simulado',
            access: 'verified',
          },
        ],
      });
    });
    const result = await new ChatApiClient({ baseUrl }).listModels();
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: 'fake-model',
          display_name: 'Modelo simulado',
          access: 'verified',
        },
      ],
    });
  });

  it('devuelve el error del backend tal cual', async () => {
    const baseUrl = await startServer((_req, res) =>
      json(res, 503, {
        error: { code: 'usage_limit', message: 'Se alcanzó el límite.' },
      }),
    );
    const result = await new ChatApiClient({ baseUrl }).listModels();
    expect(result).toEqual({
      ok: false,
      error: { code: 'usage_limit', message: 'Se alcanzó el límite.' },
    });
  });

  it('trata un cuerpo que no es de chat-v1 como respuesta inesperada', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid host header');
    });
    const client = new ChatApiClient({ baseUrl });
    expect(await client.listConversations()).toEqual({
      ok: false,
      error: LOCAL_ERRORS.unexpectedResponse,
    });
  });

  it('rechaza un 200 con forma inválida', async () => {
    const baseUrl = await startServer((_req, res) =>
      json(res, 200, { models: [{ id: 1 }] }),
    );
    const result = await new ChatApiClient({ baseUrl }).listModels();
    expect(result).toEqual({
      ok: false,
      error: LOCAL_ERRORS.unexpectedResponse,
    });
  });

  it('da un error propio y recuperable si el backend no está arrancado (AC-04)', async () => {
    const baseUrl = await closedPortUrl();
    const result = await new ChatApiClient({ baseUrl }).listModels();
    expect(result).toEqual({
      ok: false,
      error: LOCAL_ERRORS.backendUnavailable,
    });
    expect(LOCAL_ERRORS.backendUnavailable.retryable).toBe(true);
  });

  it('agota el tiempo si el backend no responde', async () => {
    const baseUrl = await startServer(() => undefined);
    const client = new ChatApiClient({ baseUrl, requestTimeoutMs: 100 });
    expect(await client.listModels()).toEqual({
      ok: false,
      error: LOCAL_ERRORS.backendTimeout,
    });
  });

  it('renombra, borra y cancela con las rutas y cuerpos del contrato', async () => {
    const seen: string[] = [];
    const baseUrl = await startServer((req, res, body) => {
      seen.push(`${req.method} ${req.url} ${body}`);
      if (req.method === 'PATCH') {
        json(res, 200, {
          conversation_id: 'c/1',
          title: 'Sábado',
          title_is_custom: true,
          created_at: '2026-10-31T10:00:00Z',
          updated_at: '2026-10-31T10:01:00Z',
        });
      } else {
        res.writeHead(204);
        res.end();
      }
    });
    const client = new ChatApiClient({ baseUrl });
    expect((await client.renameConversation('c/1', 'Sábado')).ok).toBe(true);
    expect(await client.deleteConversation('c/1')).toEqual({
      ok: true,
      value: null,
    });
    expect(await client.cancelResponse('c/1', 'r1')).toEqual({
      ok: true,
      value: null,
    });
    expect(seen).toEqual([
      'PATCH /v1/conversations/c%2F1 {"title":"Sábado"}',
      'DELETE /v1/conversations/c%2F1 ',
      'POST /v1/conversations/c%2F1/responses/r1/cancel ',
    ]);
  });

  it('devuelve los errores 409 de borrar y cancelar', async () => {
    const baseUrl = await startServer((req, res) =>
      req.method === 'DELETE'
        ? json(res, 409, {
            error: { code: 'send_in_progress', message: 'En curso.' },
          })
        : json(res, 409, {
            error: { code: 'response_not_active', message: 'Ya terminó.' },
          }),
    );
    const client = new ChatApiClient({ baseUrl });
    expect(await client.deleteConversation('c1')).toMatchObject({
      ok: false,
      error: { code: 'send_in_progress' },
    });
    expect(await client.cancelResponse('c1', 'r1')).toMatchObject({
      ok: false,
      error: { code: 'response_not_active' },
    });
  });

  it('solo acepta URLs http o https', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8000/')).toBe(
      'http://127.0.0.1:8000',
    );
    expect(() => normalizeBaseUrl('file:///etc')).toThrow();
  });
});

describe('streaming', () => {
  async function send(
    client: ChatApiClient,
    signal = new AbortController().signal,
  ) {
    const result = await client.sendMessage('c1', 'fake-model', 'Hola', signal);
    if (!result.ok) throw new Error(`envío rechazado: ${result.error.code}`);
    const events: ChatEvent[] = [];
    const outcome = await result.value.run((e) => events.push(e));
    return { events, outcome };
  }

  it('reenvía los eventos en orden hasta el final, con pings y fragmentos partidos (AC-02)', async () => {
    let requestBody = '';
    const baseUrl = await startServer(async (req, res, body) => {
      requestBody = body;
      expect(req.url).toBe('/v1/conversations/c1/messages');
      sseHead(res);
      const payload =
        sse('message.accepted', ACCEPTED) +
        ': ping\n\n' +
        sse('response.delta', { response_id: 'r1', text: 'Hola, ' }) +
        sse('response.delta', { response_id: 'r1', text: 'mundo' }) +
        sse('response.completed', {
          response_id: 'r1',
          finished_at: '2026-10-31T10:00:02Z',
          model_reported: 'fake-model',
        });
      for (let i = 0; i < payload.length; i += 7) {
        res.write(payload.slice(i, i + 7));
        await tick(1);
      }
      res.end();
    });
    const { events, outcome } = await send(new ChatApiClient({ baseUrl }));
    expect(JSON.parse(requestBody)).toEqual({
      model: 'fake-model',
      text: 'Hola',
    });
    expect(outcome).toEqual({ kind: 'final' });
    expect(events.map((e) => e.event)).toEqual([
      'message.accepted',
      'response.delta',
      'response.delta',
      'response.completed',
    ]);
  });

  it('devuelve el error previo al stream (409 send_in_progress)', async () => {
    const baseUrl = await startServer((_req, res) =>
      json(res, 409, {
        error: { code: 'send_in_progress', message: 'Ya hay una respuesta.' },
      }),
    );
    const result = await new ChatApiClient({ baseUrl }).sendMessage(
      'c1',
      'fake-model',
      'Hola',
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'send_in_progress', message: 'Ya hay una respuesta.' },
    });
  });

  it('reenvía response.failed con su error (AC-04)', async () => {
    const baseUrl = await startServer((_req, res) => {
      sseHead(res);
      res.end(
        sse('message.accepted', ACCEPTED) +
          sse('response.failed', {
            response_id: 'r1',
            status: 'failed',
            finished_at: '2026-10-31T10:00:01Z',
            model_reported: null,
            error: {
              code: 'provider_unavailable',
              message: 'No se pudo contactar con el proveedor.',
              retryable: true,
            },
          }),
      );
    });
    const { events, outcome } = await send(new ChatApiClient({ baseUrl }));
    expect(outcome).toEqual({ kind: 'final' });
    expect(events[1]).toMatchObject({
      event: 'response.failed',
      data: { error: { code: 'provider_unavailable', retryable: true } },
    });
  });

  it('marca como desconectado un corte a mitad de respuesta (AC-05)', async () => {
    const baseUrl = await startServer(async (_req, res) => {
      sseHead(res);
      res.write(sse('message.accepted', ACCEPTED));
      res.write(sse('response.delta', { response_id: 'r1', text: 'parcial' }));
      await tick(20);
      res.socket?.destroy();
    });
    const { events, outcome } = await send(new ChatApiClient({ baseUrl }));
    expect(events.map((e) => e.event)).toEqual([
      'message.accepted',
      'response.delta',
    ]);
    expect(outcome).toEqual({
      kind: 'disconnected',
      error: LOCAL_ERRORS.connectionLost,
    });
  });

  it('marca como desconectado un cierre limpio sin evento final', async () => {
    const baseUrl = await startServer((_req, res) => {
      sseHead(res);
      res.end(sse('message.accepted', ACCEPTED));
    });
    const { outcome } = await send(new ChatApiClient({ baseUrl }));
    expect(outcome).toEqual({
      kind: 'disconnected',
      error: LOCAL_ERRORS.connectionLost,
    });
  });

  it('corta el stream si deja de recibir datos', async () => {
    const baseUrl = await startServer((_req, res) => {
      sseHead(res);
      res.write(sse('message.accepted', ACCEPTED));
    });
    const { outcome } = await send(
      new ChatApiClient({ baseUrl, streamIdleTimeoutMs: 100 }),
    );
    expect(outcome).toEqual({
      kind: 'disconnected',
      error: LOCAL_ERRORS.streamIdle,
    });
  });

  it('corta el stream ante datos inválidos de un evento conocido e ignora los desconocidos', async () => {
    const baseUrl = await startServer((_req, res) => {
      sseHead(res);
      res.write(sse('message.accepted', ACCEPTED));
      res.write(sse('evento.futuro', { x: 1 }));
      res.write('event: response.delta\ndata: {no es json}\n\n');
    });
    const { events, outcome } = await send(new ChatApiClient({ baseUrl }));
    expect(events.map((e) => e.event)).toEqual(['message.accepted']);
    expect(outcome).toEqual({
      kind: 'disconnected',
      error: LOCAL_ERRORS.unexpectedResponse,
    });
  });

  it('al abortar cierra la conexión con el backend sin informar de un corte', async () => {
    let closed!: () => void;
    const serverSawClose = new Promise<void>((resolve) => (closed = resolve));
    const baseUrl = await startServer((_req, res) => {
      sseHead(res);
      res.write(sse('message.accepted', ACCEPTED));
      res.on('close', () => closed());
    });
    const controller = new AbortController();
    const result = await new ChatApiClient({ baseUrl }).sendMessage(
      'c1',
      'fake-model',
      'Hola',
      controller.signal,
    );
    if (!result.ok) throw new Error('envío rechazado');
    const events: ChatEvent[] = [];
    const running = result.value.run((e) => {
      events.push(e);
      controller.abort();
    });
    expect(await running).toEqual({ kind: 'aborted' });
    await serverSawClose;
    expect(events).toHaveLength(1);
  });

  it('reenvía response.cancelled tras cancelar (AC-06)', async () => {
    let finishStream: (() => void) | null = null;
    const baseUrl = await startServer((req, res) => {
      if (req.url?.endsWith('/cancel')) {
        res.writeHead(204);
        res.end();
        finishStream?.();
        return;
      }
      sseHead(res);
      res.write(sse('message.accepted', ACCEPTED));
      res.write(sse('response.delta', { response_id: 'r1', text: 'algo' }));
      finishStream = () =>
        res.end(
          sse('response.cancelled', { response_id: 'r1', finished_at: 'x' }),
        );
    });
    const client = new ChatApiClient({ baseUrl });
    const result = await client.sendMessage(
      'c1',
      'fake-model',
      'Hola',
      new AbortController().signal,
    );
    if (!result.ok) throw new Error('envío rechazado');
    const events: ChatEvent[] = [];
    const running = result.value.run((e) => {
      events.push(e);
      if (e.event === 'response.delta') void client.cancelResponse('c1', 'r1');
    });
    expect(await running).toEqual({ kind: 'final' });
    expect(events.at(-1)?.event).toBe('response.cancelled');
  });
});
