import '@maxhub/max-ui/dist/styles.css';
import './styles.css';
import { MaxUI } from '@maxhub/max-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { uiPlatform } from './bridge';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* colorScheme не задаём: MaxUI сам следует теме устройства */}
    <MaxUI platform={uiPlatform()}>
      <App />
    </MaxUI>
  </StrictMode>,
);
