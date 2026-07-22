import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './tokens.css';
import { App } from './App';

/** Browser entry point — mounts the studio into #root. */
const container = document.getElementById('root');

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
