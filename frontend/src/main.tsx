import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './index.css';
import App from './App';
import { useAiStore } from './stores/aiStore';
import { useChatHistoryStore } from './stores/chatHistoryStore';

// Load AI settings + saved chat history from the backend's local files
// (migrating any legacy localStorage data on first run).
void useAiStore.getState().loadState();
void useChatHistoryStore.getState().loadConversations();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
