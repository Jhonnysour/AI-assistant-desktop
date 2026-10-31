import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './features/chat/ChatView';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Falta el elemento #root');

createRoot(container).render(
  <StrictMode>
    <ChatView bridge={window.assistant} />
  </StrictMode>,
);
