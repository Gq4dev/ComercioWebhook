import React from 'react';
import { useNavigate } from 'react-router-dom';
import { formatMoney } from '../moneyUtils';
import './PagosView.css';

function PagosView({ payments = [], filterStatus, setFilterStatus }) {
  const navigate = useNavigate();

  // Contar por estado para los filtros
  const countByStatus = payments.reduce((acc, p) => {
    const s = p.status || 'unknown';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

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

  const statusLabel = (status) => {
    if (!status) return '—';
    const labels = { approved: 'Aprobado', pending: 'Pendiente', rejected: 'Rechazado', received: 'Recibido' };
    return labels[status] || status;
  };

  const filteredPayments = filterStatus
    ? payments.filter(p => p.status === filterStatus)
    : payments;

  return (
    <div className="pagos-view">
      <div className="view-header">
        <button className="back-btn" onClick={() => navigate('/')}>
          ← Volver
        </button>
        <h1>Pagos Recibidos</h1>
        <span className="view-count">{filteredPayments.length} registros</span>
      </div>

      <div className="filter-bar">
        <div className="filter-pills">
          {['approved', 'pending', 'rejected'].map((status) => (
            <button
              key={status}
              className={`filter-pill ${filterStatus === status ? 'active' : ''}`}
              onClick={() => setFilterStatus(filterStatus === status ? null : status)}
            >
              {statusLabel(status)}
              {countByStatus[status] != null && (
                <span className="filter-count">({countByStatus[status]})</span>
              )}
            </button>
          ))}
        </div>
        {filterStatus && (
          <button className="clear-filter" onClick={() => setFilterStatus(null)}>
            Mostrar todos
          </button>
        )}
      </div>

      {filteredPayments.length === 0 ? (
        <div className="empty-table-state">
          <div className="empty-icon">📭</div>
          <h3>Sin pagos</h3>
          <p>Los pagos aparecerán aquí cuando sean recibidos</p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Fecha / Hora</th>
                <th>Pagador</th>
                <th>Descripción</th>
                <th>Medio</th>
                <th>Monto</th>
                <th>Estado</th>
                <th>Ref / ID</th>
              </tr>
            </thead>
            <tbody>
              {filteredPayments.map((payment) => (
                <tr key={payment.id} className={`status-${payment.status || 'unknown'}`}>
                  <td>
                    <span className="cell-date">{formatDate(payment.timestamp)}</span>
                    <span className="cell-time">{formatTime(payment.timestamp)}</span>
                  </td>
                  <td>{payment.payer || '—'}</td>
                  <td>{payment.description || '—'}</td>
                  <td className="cell-muted">{payment.paymentMethod || payment.gatewayName || payment.type || '—'}</td>
                  <td className="cell-amount">
                    {formatMoney(payment)}
                  </td>
                  <td>
                    <span className={`status-badge status-${payment.status || 'unknown'}`}>
                      {statusLabel(payment.status)}
                    </span>
                  </td>
                  <td className="cell-ref">
                    {payment.encrypted && <span className="encrypted-badge" title="Payload desencriptado">🔐</span>}
                    {payment.transactionId || payment.reference || payment.id?.substring(0, 8) || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default PagosView;
