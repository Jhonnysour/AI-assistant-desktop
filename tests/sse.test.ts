import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/main/api/sse';

describe('SseParser', () => {
  it('despacha eventos con línea en blanco e ignora comentarios', () => {
    const parser = new SseParser();
    const messages = parser.push(
      ': ping\n\nevent: response.delta\ndata: {"a":1}\n\n',
    );
    expect(messages).toEqual([{ event: 'response.delta', data: '{"a":1}' }]);
  });

  it('reconstruye eventos partidos entre fragmentos, también con \\r\\n', () => {
    const parser = new SseParser();
    const text =
      'event: x\r\ndata: uno\r\ndata: dos\r\n\r\nevent: y\r\ndata: 3\r\n\r\n';
    const messages = [...text].flatMap((ch) => parser.push(ch));
    expect(messages).toEqual([
      { event: 'x', data: 'uno\ndos' },
      { event: 'y', data: '3' },
    ]);
  });

  it('no despacha bloques sin data y usa "message" si falta event', () => {
    const parser = new SseParser();
    expect(parser.push('event: solo\n\ndata: hola\n\n')).toEqual([
      { event: 'message', data: 'hola' },
    ]);
  });
});
