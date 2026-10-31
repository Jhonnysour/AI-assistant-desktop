# AI Assistant Desktop

Electron + React + TypeScript. MVVM adaptado a React, organizado por funcionalidades.
Estado: primera entrega de [SPEC-001](../AI-assistant-backend/docs/specs/001-chat-texto.md) en curso.
Fase 1 (lógica y vista mínima sin diseño) implementada; el diseño de la interfaz está pendiente.
No hay instalador de producción.

## Lectura inicial

- [Arquitectura del escritorio](docs/architecture.md)
- [Visión del producto](../AI-assistant-backend/docs/product/vision.md)
- [SPEC-001: chat de texto](../AI-assistant-backend/docs/specs/001-chat-texto.md)
- [Contrato chat-v1](../AI-assistant-backend/docs/api/chat-v1.md)
- [Instrucciones de trabajo](AGENTS.md)

Las referencias compartidas requieren el clon vecino de AI-assistant-backend y acceso del agente a él.
No mantener copias divergentes. Cuando existan commits, la tarea puede identificar la revisión
de backend consultada. Estos enlaces se resuelven entre clones locales, no entre repositorios en GitHub.

## Versiones

Elegidas el 2026-10-31 con la documentación oficial y el registro de npm:

| Pieza | Versión | Fuente |
| --- | --- | --- |
| Electron Forge (`create-electron-app`) | 8.0.1 | `npx create-electron-app@latest --version`; [electronforge.io](https://www.electronforge.io/) |
| Electron | 45.2.1 (Node 24.22.1, Chromium 156) | [releases.electronjs.org](https://releases.electronjs.org/), última estable |
| Vite / plugin de Forge | 8.3.5 / 8.0.1 | instaladas por la plantilla |
| TypeScript | 6.0.3 | instalada por la plantilla |
| React / React DOM | 19.3.1 | `npm view react version` |
| @vitejs/plugin-react | 6.1.2 | `npm view`; requiere Vite ^8 |
| Vitest | 5.0.5 | `npm view`; admite Vite ^8 |

La guía web de la plantilla indica `--template=vite-typescript`, pero la CLI 8.0.1 lo rechaza
(«no longer exists»). El proyecto se creó con:

```bash
npx create-electron-app@latest init gen --template vite --typescript --package-manager npm --skip-git
```

Verificado en Windows 11 con Node 24.12.0 y npm 11.6.2.

## Instalación

```bash
npm install
```

Tras la primera instalación faltaba el binario de Electron (`node_modules/electron/dist`); se
descargó con `node node_modules/electron/install.js`. No se averiguó la causa.

## Desarrollo

Requiere el backend arrancado (ver su [guía de desarrollo](../AI-assistant-backend/docs/development.md#servidor-http-contrato-chat-v1)).
Para no consumir el plan ni créditos, con el proveedor simulado (en PowerShell, desde la carpeta
del backend):

```powershell
$env:AI_ASSISTANT_PROVIDER = 'fake'; .\.venv\Scripts\python.exe -m ai_assistant.infrastructure.bootstrap.server
```

Después, en este repositorio:

```bash
npm start
```

La URL del backend se configura con `AI_ASSISTANT_API_URL` (por defecto `http://127.0.0.1:8000`).

**Terminal de VS Code:** puede traer `ELECTRON_RUN_AS_NODE=1`, que hace que Electron arranque como
Node y la app falle (`Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`).
Se ejecutó así desde Git Bash:

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

En PowerShell, el equivalente sería `Remove-Item Env:ELECTRON_RUN_AS_NODE` antes de `npm start`
(no probado).

## Pruebas y comprobaciones

```bash
npm test            # vitest: ViewModel con puente falso, cliente de main contra servidor HTTP simulado
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint + oxfmt --check
```

Las pruebas no necesitan Electron, red ni el backend.

Compilación de producción (sin instalador): `npx electron-forge package` genera `.vite/` y
`out/AI Assistant-win32-x64/`. El recorrido real del 2026-10-31 se hizo lanzando Electron sobre
`.vite/` con Playwright (script fuera del repositorio) contra el backend en modo `fake`.

## Estructura

```
src/
  main/        proceso main: ventana, seguridad, IPC y cliente HTTP/SSE del backend (api/)
  preload/     puente window.assistant (contextBridge)
  renderer/    React: features/chat (ViewModel, hook y vista)
  shared/      tipos de chat-v1 y contrato del puente
tests/         pruebas con Vitest
```
