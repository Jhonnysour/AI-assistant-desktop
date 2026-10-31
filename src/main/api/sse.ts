// Parser incremental de Server-Sent Events (formato de la especificación HTML):
// campos `event` y `data`, comentarios con `:` (el `: ping` del backend) y línea en blanco
// para despachar. Los campos `id` y `retry` no se usan en chat-v1 y se ignoran.

export interface SseMessage {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  // Recibe texto ya decodificado y devuelve los mensajes completos que contiene.
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // Un \r al final del bloque puede ser la primera mitad de \r\n: esperar al siguiente.
      if (ch === '\r' && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, i);
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
      const message = this.processLine(line);
      if (message) messages.push(message);
    }
    this.buffer = this.buffer.slice(start);
    return messages;
  }

  private processLine(line: string): SseMessage | null {
    if (line === '') {
      const message =
        this.dataLines.length > 0
          ? {
              event: this.eventName || 'message',
              data: this.dataLines.join('\n'),
            }
          : null;
      this.eventName = '';
      this.dataLines = [];
      return message;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    return null;
  }
}
