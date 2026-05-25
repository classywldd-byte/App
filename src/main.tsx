import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

window.addEventListener('unhandledrejection', function (event) {
  if (event.reason && typeof event.reason.message === 'string' && event.reason.message.includes('WebSocket closed without opened')) {
    event.preventDefault(); // hide vite hmr websocket errors from throwing a main crash
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

