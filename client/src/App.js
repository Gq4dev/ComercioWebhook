import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { io } from 'socket.io-client';
import './App.css';

import HomeView from './views/HomeView';
import PagosView from './views/PagosView';
import SubscripcionesView from './views/SubscripcionesView';

// En producción usa la misma URL, en desarrollo usa localhost:3001
const SOCKET_URL = process.env.NODE_ENV === 'production' 
  ? window.location.origin 
  : 'http://localhost:3001';

function AppContent() {
  const [payments, setPayments] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [connected, setConnected] = useState(false);
  const [notification, setNotification] = useState(null);
  const [webhookEnabled, setWebhookEnabled] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [filterStatus, setFilterStatus] = useState(null);

  // Mostrar notificación temporal
  const showNotification = useCallback((payment) => {
    setNotification(payment);
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleQYAHI3O8teleQkAHI3O8+7RoFUZBj+QzfPp0aJYGwo4i8LVoF0nEDp0krDCwpZiNy8rAAAA');
    audio.volume = 0.3;
    audio.play().catch(() => {});
    
    setTimeout(() => {
      setNotification(null);
    }, 5000);
  }, []);

  // Conectar al WebSocket
  useEffect(() => {
    const socket = io(SOCKET_URL);

    socket.on('connect', () => {
      console.log('Conectado al servidor');
      setConnected(true);
    });

    socket.on('disconnect', () => {
      console.log('Desconectado del servidor');
      setConnected(false);
    });

    socket.on('payments-history', (history) => {
      setPayments(history);
    });

    socket.on('subscriptions-history', (history) => {
      setSubscriptions(history);
    });

    socket.on('new-payment', (payment) => {
      setPayments(prev => [payment, ...prev]);
      showNotification(payment);
    });

    socket.on('new-subscription', (subscription) => {
      setSubscriptions(prev => [subscription, ...prev]);
    });

    socket.on('webhook-status', (status) => {
      setWebhookEnabled(status.enabled);
    });

    fetch(`${SOCKET_URL}/webhook/status`)
      .then(res => res.json())
      .then(data => setWebhookEnabled(data.enabled))
      .catch(() => {});

    return () => {
      socket.disconnect();
    };
  }, [showNotification]);

  const toggleWebhook = async () => {
    setToggling(true);
    try {
      const res = await fetch(`${SOCKET_URL}/webhook/toggle`, { method: 'POST' });
      const data = await res.json();
      setWebhookEnabled(data.enabled);
    } catch (error) {
      console.error('Error toggling webhook:', error);
    }
    setToggling(false);
  };

  const formatCurrency = (amount, currency = 'ARS') => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency
    }).format(amount);
  };

  return (
    <div className="app">
      {/* Notificación flotante */}
      {notification && (
        <div className="notification-popup">
          <div className="notification-icon">💰</div>
          <div className="notification-content">
            <div className="notification-title">¡Nuevo Pago Recibido!</div>
            <div className="notification-amount">
              {formatCurrency(notification.amount, notification.currency)}
            </div>
            <div className="notification-payer">{notification.payer}</div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="logo">
            <span className="logo-icon">💳</span>
            <h1>Panel de Pagos</h1>
          </div>
          <div className="header-controls">
            <button 
              className={`webhook-toggle ${webhookEnabled ? 'enabled' : 'disabled'}`}
              onClick={toggleWebhook}
              disabled={toggling}
            >
              <span className="toggle-icon">{webhookEnabled ? '✅' : '🚫'}</span>
              <span className="toggle-text">
                {toggling ? 'Cambiando...' : (webhookEnabled ? 'Webhook ON' : 'Webhook OFF')}
              </span>
            </button>
            <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
              <span className="status-dot"></span>
              {connected ? 'Conectado' : 'Desconectado'}
            </div>
          </div>
        </div>
        {!webhookEnabled && (
          <div className="dlq-warning">
            ⚠️ Webhook deshabilitado - Los mensajes retornarán error 503 y serán enviados al DLQ
          </div>
        )}
      </header>

      {/* Rutas */}
      <main className="main-content">
        <Routes>
          <Route path="/" element={<HomeView paymentsCount={payments.length} />} />
          <Route 
            path="/pagos" 
            element={
              <PagosView 
                payments={payments} 
                filterStatus={filterStatus} 
                setFilterStatus={setFilterStatus}
              />
            } 
          />
          <Route path="/subscripciones" element={<SubscripcionesView subscriptions={subscriptions} />} />
        </Routes>
      </main>

      {/* Footer */}
      <footer className="footer">
        <p>Webhook: <code>{SOCKET_URL}/webhook</code></p>
      </footer>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
