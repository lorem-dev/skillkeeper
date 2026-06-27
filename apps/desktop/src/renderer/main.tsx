/**
 * Renderer entry point.
 *
 * Creates the React root and mounts the application. This is a thin bootstrap;
 * all state and logic lives in App.tsx and store.ts.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element #root not found in the DOM.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
