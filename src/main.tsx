import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './fonts.css'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/spotlight/styles.css'
import './index.css'
import App from './App.tsx'
import { installGlobalErrorLogging } from './utils/rendererLog'

// Before the first render, so an error thrown while mounting reaches the log file too.
installGlobalErrorLogging()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
