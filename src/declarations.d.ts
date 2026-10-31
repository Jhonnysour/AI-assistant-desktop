/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';

interface Window {
  assistant: import('./shared/bridge').AssistantBridge;
}
