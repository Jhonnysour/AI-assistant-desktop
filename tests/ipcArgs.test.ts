import { describe, expect, it } from 'vitest';
import {
  idAndTitle,
  noArgs,
  oneId,
  sendArgs,
  twoIds,
} from '../src/main/ipcArgs';

describe('validación de argumentos IPC', () => {
  it('acepta los argumentos del contrato', () => {
    expect(noArgs([])).toBe(true);
    expect(oneId(['c1'])).toBe(true);
    expect(twoIds(['c1', 'r1'])).toBe(true);
    expect(idAndTitle(['c1', 'Sábado'])).toBe(true);
    expect(idAndTitle(['c1', null])).toBe(true);
    expect(sendArgs(['c1', 'deepseek/deepseek-v4.1-flash-1017', ''])).toBe(
      true,
    );
  });

  it('rechaza tipos, longitudes y argumentos de más', () => {
    expect(noArgs([1])).toBe(false);
    expect(oneId([123])).toBe(false);
    expect(oneId([''])).toBe(false);
    expect(oneId(['x'.repeat(257)])).toBe(false);
    expect(oneId(['c1', 'extra'])).toBe(false);
    expect(idAndTitle(['c1', { x: 1 }])).toBe(false);
    expect(idAndTitle(['c1', undefined])).toBe(false);
    expect(sendArgs(['c1', 'm', ['hola']])).toBe(false);
    expect(sendArgs(['c1', '', 'hola'])).toBe(false);
  });

  it('rechaza identificadores que alterarían la ruta de la URL', () => {
    expect(oneId(['.'])).toBe(false);
    expect(oneId(['..'])).toBe(false);
    expect(twoIds(['c1', '..'])).toBe(false);
    expect(sendArgs(['..', 'm', 'hola'])).toBe(false);
  });
});
