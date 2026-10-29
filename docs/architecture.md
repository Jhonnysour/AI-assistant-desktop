# Desktop: MVVM adaptado a React

## Decisión confirmada

Electron + React, organizado por funcionalidades. TypeScript propuesto.

## Responsabilidades

- View: componentes que muestran estado y recogen interacciones.
- ViewModel: hooks y módulos de estado que ofrecen datos y acciones a la vista.
- Model/datos: modelos y clientes o repositorios que encapsulan backend y almacenamiento permitido.
- Ejecutor local: casos de uso que validan y realizan las operaciones autorizadas sobre Windows.

Un hook no es un ViewModel solo por su nombre. Debe separar la coordinación de presentación
del JSX. Los hooks no contienen las reglas centrales del agente ni detalles de credenciales.
Agrupar por chat, recordatorios, documentos, dispositivos y ajustes conforme se implementen.
Compartir solo componentes y contratos realmente reutilizados.

## Electron

- Renderer: React, estado de presentación y cliente de la API de la aplicación.
- Preload: puente con métodos concretos; no expone ipcRenderer genérico, shell ni credenciales.
- Main: ciclo de vida, ventanas, bandeja y coordinación de operaciones locales autorizadas.
- Procesos auxiliares: tareas intensivas que no deben bloquear el proceso principal.

Mantener aislamiento de contexto, sandbox del renderer e integración Node deshabilitada en él.
Validar origen y argumentos en los handlers IPC. Las políticas de archivos se hacen cumplir en
el ejecutor local; ocultar un botón no concede ni revoca permisos.
El backend guarda las credenciales del proveedor; la sesión de la aplicación es una identidad distinta.

## Primera entrega

Vista de chat, ViewModel con estados explícitos y cliente de streaming del backend.
Pruebas de presentación con cliente falso; al menos una comprobación del recorrido real completo.
No implementar acceso a archivos, comandos, voz o arranque automático en SPEC-001.

## Referencias

- [Visión](../../AI-assistant-backend/docs/product/vision.md)
- [SPEC-001](../../AI-assistant-backend/docs/specs/001-chat-texto.md)
