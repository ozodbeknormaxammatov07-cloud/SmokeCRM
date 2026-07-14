import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { StoreProvider } from './store'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* HashRouter: works on any static host with no rewrite rules to configure. */}
    <HashRouter>
      <StoreProvider>
        <App />
      </StoreProvider>
    </HashRouter>
  </StrictMode>,
)
