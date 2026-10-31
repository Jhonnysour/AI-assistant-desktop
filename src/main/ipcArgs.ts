// Validación de los argumentos que llegan por IPC desde el renderer. Sin dependencias de
// Electron para poder probarla en Node. Son límites de cordura: el backend aplica sus reglas.

const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 1_000;
const MAX_TEXT_LENGTH = 1_000_000;

// Los identificadores van en la ruta de la URL. `.` y `..` sobreviven a encodeURIComponent y
// el analizador de URL los resolvería como segmentos de ruta (/v1/conversations/.. → /v1/).
export const isPathId = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= MAX_ID_LENGTH &&
  v !== '.' &&
  v !== '..';
// El modelo va en el cuerpo JSON y puede llevar `/` (p. ej. slugs de OpenRouter).
const isModel = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_TEXT_LENGTH;
const isTitle = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && v.length <= MAX_TITLE_LENGTH);

export type Validator<A extends unknown[]> = (args: unknown[]) => args is A;

export const noArgs = (args: unknown[]): args is [] => args.length === 0;
export const oneId = (args: unknown[]): args is [string] =>
  args.length === 1 && isPathId(args[0]);
export const twoIds = (args: unknown[]): args is [string, string] =>
  args.length === 2 && isPathId(args[0]) && isPathId(args[1]);
export const idAndTitle = (args: unknown[]): args is [string, string | null] =>
  args.length === 2 && isPathId(args[0]) && isTitle(args[1]);
export const sendArgs = (args: unknown[]): args is [string, string, string] =>
  args.length === 3 && isPathId(args[0]) && isModel(args[1]) && isText(args[2]);
