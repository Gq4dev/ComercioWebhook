import React, { useState, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import './App.css';

// En producción usa la misma URL, en desarrollo usa localhost:3001
const SOCKET_URL = process.env.NODE_ENV === 'production' 
  ? window.location.origin 
  : 'http://localhost:3001';

function App() {
  const [payments, setPayments] = useState([]);
  const [connected, setConnected] = useState(false);
  const [notification, setNotification] = useState(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [webhookEnabled, setWebhookEnabled] = useState(true);
  const [toggling, setToggling] = useState(false);

  // Calcular total cuando cambian los pagos
  useEffect(() => {
    const total = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    setTotalAmount(total);
  }, [payments]);

  // Mostrar notificación temporal
  const showNotification = useCallback((payment) => {
    setNotification(payment);
    // Reproducir sonido de notificación
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

    socket.on('new-payment', (payment) => {
      setPayments(prev => [payment, ...prev]);
      showNotification(payment);
    });

    socket.on('webhook-status', (status) => {
      setWebhookEnabled(status.enabled);
    });

    // Obtener estado inicial del webhook
    fetch(`${SOCKET_URL}/webhook/status`)
      .then(res => res.json())
      .then(data => setWebhookEnabled(data.enabled))
      .catch(() => {});

    return () => {
      socket.disconnect();
    };
  }, [showNotification]);

  // Función para activar/desactivar webhook
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

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
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

      {/* Stats */}
      <div className="stats-container">
        <div className="stat-card">
          <div className="stat-icon">📊</div>
          <div className="stat-info">
            <span className="stat-value">{payments.length}</span>
            <span className="stat-label">Pagos Recibidos</span>
          </div>
        </div>
        <div className="stat-card highlight">
          <div className="stat-icon">💵</div>
          <div className="stat-info">
            <span className="stat-value">{formatCurrency(totalAmount)}</span>
            <span className="stat-label">Total Recaudado</span>
          </div>
        </div>
      </div>

      {/* Lista de pagos */}
      <main className="main-content">
        <div className="payments-header">
          <h2>Historial de Pagos</h2>
          <span className="payments-count">{payments.length} registros</span>
        </div>

        {payments.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📭</div>
            <h3>Esperando pagos...</h3>
            <p>Los pagos aparecerán aquí cuando sean recibidos</p>
            <div className="webhook-info">
              <code>POST https://comerciowebhook.onrender.com/webhook</code>
            </div>
          </div>
        ) : (
          <div className="payments-list">
            {payments.map((payment, index) => (
              <div 
                key={payment.id} 
                className={`payment-card ${index === 0 && notification?.id === payment.id ? 'new' : ''}`}
              >
                <div className="payment-status-indicator"></div>
                <div className="payment-main">
                  <div className="payment-header">
                    <span className="payment-payer">{payment.payer}</span>
                    <div className="payment-header-right">
                      {payment.status && payment.status !== 'received' && (
                        <span className={`payment-status-badge status-${payment.status}`}>{payment.status}</span>
                      )}
                      <span className="payment-amount">
                        {formatCurrency(payment.amount, payment.currency)}
                      </span>
                    </div>
                  </div>
                  <div className="payment-details">
                    <span className="payment-description">{payment.description}</span>
                    {payment.reference && (
                      <span className="payment-reference">Ref: {payment.reference}</span>
                    )}
                    {payment.paymentMethod && (
                      <span className="payment-method">{payment.paymentMethod}</span>
                    )}
                  </div>
                  <div className="payment-footer">
                    <span className="payment-id">
                      {payment.transactionId ? `TXN: ${payment.transactionId}` : `ID: ${payment.id.substring(0, 8)}...`}
                    </span>
                    <span className="payment-time">
                      {formatDate(payment.timestamp)} - {formatTime(payment.timestamp)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="footer">
        <p>Webhook: <code>{SOCKET_URL}/webhook</code></p>
      </footer>
    </div>
  );
}

export default App;
