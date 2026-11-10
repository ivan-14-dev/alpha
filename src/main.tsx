import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { RealtimeProvider } from './lib/realtime';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><AuthProvider><RealtimeProvider><App /></RealtimeProvider></AuthProvider></BrowserRouter></React.StrictMode>,
);
