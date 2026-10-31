// Endurecimiento de Electron: protocolo propio para la interfaz empaquetada, CSP, permisos,
// navegación y ventanas nuevas (https://www.electronjs.org/docs/latest/tutorial/security).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app, protocol, type Session } from 'electron';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://main`;

// El renderer no necesita red (SPEC-001, D4): todas las peticiones al backend las hace main.
const BASE_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
];

export const PRODUCTION_CSP = [
  ...BASE_CSP,
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'none'",
].join('; ');

// En desarrollo, Vite inyecta estilos y el preámbulo de React Refresh en línea y usa un
// WebSocket para la recarga en caliente. Solo se permite el propio servidor de Vite.
export function developmentCsp(devServerUrl: string): string {
  const origin = new URL(devServerUrl);
  const ws = `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`;
  return [
    ...BASE_CSP,
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${ws}`,
  ].join('; ');
}

// Debe llamarse antes de `app.ready`.
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Sirve solo los archivos de la interfaz compilada, en lugar de cargarla desde file://.
export function serveRenderer(rendererDir: string): void {
  const root = path.resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const filePath = path.resolve(
      root,
      `.${pathname === '/' ? '/index.html' : pathname}`,
    );
    const relative = path.relative(root, filePath);
    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()];
    if (
      url.host !== 'main' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      mime === undefined
    ) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const body = await readFile(filePath);
      return new Response(body, {
        headers: {
          'Content-Type': mime,
          'Content-Security-Policy': PRODUCTION_CSP,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

export function applySessionPolicies(
  ses: Session,
  devServerUrl: string | undefined,
): void {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  ses.setPermissionCheckHandler(() => false);

  if (devServerUrl) {
    const csp = developmentCsp(devServerUrl);
    const devOrigin = new URL(devServerUrl).origin;
    ses.webRequest.onHeadersReceived((details, callback) => {
      const fromDevServer = new URL(details.url).origin === devOrigin;
      callback({
        responseHeaders: fromDevServer
          ? { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
          : details.responseHeaders,
      });
    });
  }
}

// Sin navegación, ventanas nuevas ni <webview> en ningún webContents.
export function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
