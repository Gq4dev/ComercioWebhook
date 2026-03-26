import React from 'react';
import { useNavigate } from 'react-router-dom';
import { formatMoney } from '../moneyUtils';
import './SubscripcionesView.css';

function SubscripcionesView({ subscriptions = [] }) {
  const navigate = useNavigate();

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  };

  const statusLabel = (status) => {
    if (!status) return '—';
    const labels = { active: 'Activa', cancelled: 'Cancelada', pending: 'Pendiente', expired: 'Expirada', approved: 'Aprobado', rejected: 'Rechazado' };
    return labels[status] || status;
  };

  return (
    <div className="subscripciones-view">
      <div className="view-header">
        <button className="back-btn" onClick={() => navigate('/')}>
          ← Volver
        </button>
        <h1>Subscripciones</h1>
        <span className="view-count">{subscriptions.length} registros</span>
      </div>

      {subscriptions.length === 0 ? (
        <div className="empty-table-state">
          <div className="empty-icon">🔄</div>
          <h3>Sin subscripciones</h3>
          <p>Las subscripciones aparecerán aquí cuando sean recibidas</p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Suscriptor</th>
                <th>Plan / Descripción</th>
                <th>Monto</th>
                <th>Estado</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((sub) => (
                <tr key={sub.id} className={`status-${sub.status || 'unknown'}`}>
                  <td>{formatDate(sub.timestamp || sub.createdAt)}</td>
                  <td>{sub.subscriber || sub.payer || '—'}</td>
                  <td>{sub.plan || sub.description || '—'}</td>
                  <td className="cell-amount">
                    {formatMoney(sub)}
                  </td>
                  <td>
                    <span className={`status-badge status-${sub.status || 'unknown'}`}>
                      {statusLabel(sub.status)}
                    </span>
                  </td>
                  <td className="cell-ref">{sub.id?.substring(0, 8) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default SubscripcionesView;
