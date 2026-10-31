# Desktop: MVVM adaptado a React

## Decisión confirmada

Electron + React + TypeScript, organizado por funcionalidades. El proyecto se monta con Electron Forge
y su plantilla de Vite con TypeScript ([SPEC-001, D1](../../AI-assistant-backend/docs/specs/001-chat-texto.md#decisiones-de-integración-desktopbackend-2026-10-30)).

## Responsabilidades

- View: componentes que muestran estado y recogen interacciones.
- ViewModel: módulos de estado que ofrecen datos y acciones a la vista, y un hook que los conecta a React.
- Model/datos: contratos y el cliente del backend. El cliente vive en el proceso main (ver abajo);
  el renderer solo ve el puente del preload.
- Ejecutor local: casos de uso que validan y realizan las operaciones autorizadas sobre Windows.

Un hook no es un ViewModel solo por su nombre. Debe separar la coordinación de presentación
del JSX. Los hooks no contienen las reglas centrales del agente ni detalles de credenciales.
Agrupar por chat, recordatorios, documentos, dispositivos y ajustes conforme se implementen.
Compartir solo componentes y contratos realmente reutilizados.

## Electron

Decisiones D2–D5 de [SPEC-001](../../AI-assistant-backend/docs/specs/001-chat-texto.md#decisiones-de-integración-desktopbackend-2026-10-30).

- Renderer: React, ViewModel y estado de presentación. **No hace peticiones de red**: su política de
  contenido (CSP) tiene `connect-src 'none'` en producción; en desarrollo solo permite el servidor de
  Vite. Así, un fallo al mostrar texto generado por el LLM no da acceso a la API ni a credenciales.
- Preload: puente con métodos concretos (`window.assistant`) expuesto con `contextBridge`. No expone
  `ipcRenderer` genérico, Node, shell ni credenciales. Los callbacks del renderer nunca reciben el
  objeto del evento IPC.
- Main: ciclo de vida, ventanas y **cliente HTTP/SSE del backend**. Hace las peticiones con el `fetch`
  global de Node (no con `net` de Electron, que aplicaría el proxy del sistema), lee el SSE y reenvía
  los eventos al renderer por IPC. Valida el origen del frame y los argumentos de cada handler IPC.
  Cualquier credencial futura de la aplicación vivirá aquí y nunca llegará al renderer (D5).
- Procesos auxiliares: tareas intensivas que no deben bloquear el proceso principal.

El backend mantiene CORS desactivado (D3): las peticiones de main no son de navegador.

Mantener aislamiento de contexto, sandbox del renderer e integración Node deshabilitada en él.
Sin navegación ni ventanas nuevas; permisos del navegador denegados. En producción la interfaz se sirve
con un protocolo propio (`app://`) en lugar de `file://`. Las políticas de archivos se hacen cumplir en
el ejecutor local; ocultar un botón no concede ni revoca permisos.
El backend guarda las credenciales del proveedor; la sesión de la aplicación es una identidad distinta.

## Puente e IPC del chat

- Peticiones simples (`listModels`, `createConversation`, `listConversations`, `getConversation`,
  `renameConversation`, `deleteConversation`, `cancelResponse`): `invoke` que devuelve
  `{ok: true, value}` o `{ok: false, error: {code, message}}`. `message` siempre se puede mostrar.
- Envío (`sendMessage`): main espera la cabecera de la respuesta. Un error previo al stream
  (`empty_message`, `send_in_progress`, backend apagado…) vuelve como error; si el backend acepta,
  devuelve un identificador de stream. El renderer se suscribe a ese stream (`onStreamEvent`) y recibe
  los eventos de [chat-v1](../../AI-assistant-backend/docs/api/chat-v1.md) tal cual, más un aviso local si
  la conexión se cierra sin evento final. El preload guarda los eventos que llegan antes de suscribirse.
- Darse de baja de un stream activo o cerrar la ventana aborta la petición en main. Cancelar es otra
  cosa: llama al endpoint `…/cancel` del backend, que registra la respuesta como cancelada.

## Primera entrega

Vista de chat, ViewModel con estados explícitos y cliente de streaming del backend en main.
Pruebas de presentación con un puente falso, del cliente de main contra un servidor HTTP simulado y
al menos una comprobación del recorrido real completo.
No implementar acceso a archivos, comandos, voz o arranque automático en SPEC-001.

## Referencias

- [Visión](../../AI-assistant-backend/docs/product/vision.md)
- [SPEC-001](../../AI-assistant-backend/docs/specs/001-chat-texto.md)
- [Contrato chat-v1](../../AI-assistant-backend/docs/api/chat-v1.md)
