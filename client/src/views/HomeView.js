import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './HomeView.css';

const SOCKET_URL = process.env.NODE_ENV === 'production' 
  ? window.location.origin 
  : 'http://localhost:3001';

function HomeView({ paymentsCount = 0 }) {
  const navigate = useNavigate();
  const [subscriptionsCount, setSubscriptionsCount] = useState(0);

  useEffect(() => {
    fetch(`${SOCKET_URL}/subscriptions`)
      .then(res => res.json())
      .then(data => setSubscriptionsCount(Array.isArray(data) ? data.length : 0))
      .catch(() => {});
  }, []);

  return (
    <div className="home-view">
      <div className="home-cards">
        <div 
          className="home-card home-card-pagos"
          onClick={() => navigate('/pagos')}
        >
          <div className="home-card-icon">💳</div>
          <h2 className="home-card-title">Pagos</h2>
          <span className="home-card-count">{paymentsCount}</span>
          <p className="home-card-desc">Ver historial de pagos recibidos en tabla</p>
          <span className="home-card-arrow">→</span>
        </div>

        <div 
          className="home-card home-card-subscripciones"
          onClick={() => navigate('/subscripciones')}
        >
          <div className="home-card-icon">🔄</div>
          <h2 className="home-card-title">Subscripciones</h2>
          <span className="home-card-count">{subscriptionsCount}</span>
          <p className="home-card-desc">Ver subscripciones activas en tabla</p>
          <span className="home-card-arrow">→</span>
        </div>
      </div>
    </div>
  );
}

export default HomeView;
