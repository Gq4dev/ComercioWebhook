const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const fs = require('fs');

// Configuración para producción o desarrollo
// Detecta producción si existe la carpeta build O si NODE_ENV es production
const buildPath = path.join(__dirname, 'client/build');
const hasBuild = fs.existsSync(buildPath);
const isProduction = process.env.NODE_ENV === 'production' || hasBuild;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

console.log(`🔧 Modo: ${isProduction ? 'PRODUCCIÓN' : 'DESARROLLO'}`);
console.log(`🔧 Build existe: ${hasBuild}`);

const io = new Server(server, {
  cors: {
    origin: isProduction ? true : CLIENT_URL,
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Servir archivos estáticos de React en producción
if (isProduction && hasBuild) {
  console.log(`📁 Sirviendo archivos estáticos desde: ${buildPath}`);
  app.use(express.static(buildPath));
}

// Almacén temporal de pagos (en producción usar DB)
// Para mantener la experiencia de la UI mantenemos sólo los últimos 100 pagos,
// pero guardamos estadísticas de todos los mensajes recibidos por día.
const payments = [];

// Almacén temporal de subscripciones (en producción usar DB)
const subscriptions = [];

// Estadísticas agregadas por fecha. Ejemplo:
// statsByDate['2026-03-01'] = { total: 123, status: { approved: 45, pending: 78 } }
const statsByDate = {};

// Estado del webhook (habilitado/deshabilitado para probar DLQ)
let webhookEnabled = true;

// Endpoint para verificar que el servidor está activo
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Endpoint para obtener estado del webhook
app.get('/webhook/status', (req, res) => {
  res.json({ enabled: webhookEnabled });
});

// Endpoint para consultar estadísticas de notificaciones por día
// Se puede pasar ?date=YYYY-MM-DD (por defecto el día actual)
app.get('/stats', (req, res) => {
  const day = req.query.date || new Date().toISOString().split('T')[0];
  const stats = statsByDate[day] || { total: 0, status: {} };
  res.json({ date: day, stats });
});

// opcional: devolver todas las estadísticas acumuladas (para debugging)
app.get('/stats/all', (req, res) => {
  res.json({ statsByDate });
});

// Endpoint para activar/desactivar webhook (para probar DLQ)
app.post('/webhook/toggle', (req, res) => {
  webhookEnabled = !webhookEnabled;
  const status = webhookEnabled ? 'ACTIVADO' : 'DESACTIVADO';
  console.log(`⚡ Webhook ${status}`);
  
  // Notificar a todos los clientes del cambio de estado
  io.emit('webhook-status', { enabled: webhookEnabled });
  
  res.json({ 
    enabled: webhookEnabled,
    message: `Webhook ${status}. ${!webhookEnabled ? 'Los mensajes irán al DLQ.' : 'Recibiendo pagos normalmente.'}` 
  });
});

/**
 * Monto numérico desde documentos Mongo / APIs (Decimal128 {$numberDecimal}, strings, alias).
 */
function coerceAmountFromDocument(d) {
  if (!d || typeof d !== 'object') return 0;

  function unwrap(v) {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const s = v.trim().replace(/\s/g, '').replace(',', '.');
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    if (typeof v === 'object') {
      if (v.$numberDecimal != null) return unwrap(String(v.$numberDecimal));
      if (v.$numberDouble != null) return unwrap(v.$numberDouble);
      if (v.$numberLong != null) return unwrap(String(v.$numberLong));
      if (v.$numberInt != null) return unwrap(v.$numberInt);
    }
    return null;
  }

  const keys = [
    'amount',
    'final_amount',
    'total_amount',
    'transaction_amount',
    'paid_amount',
    'total_paid_amount',
    'monto'
  ];
  for (const k of keys) {
    const n = unwrap(d[k]);
    if (n != null) return n;
  }
  const td = d.transaction_details;
  if (td && typeof td === 'object') {
    for (const k of keys) {
      const n = unwrap(td[k]);
      if (n != null) return n;
    }
  }
  return 0;
}

/** Normaliza timestamp ISO (ej. con microsegundos) a algo que Date parsee bien */
function parseTimestamp(ts) {
  if (ts == null) return new Date().toISOString();
  if (typeof ts !== 'string') return new Date(ts).toISOString();
  const trimmed = ts.replace(/(\.\d{3})\d+(?=\D|$)/, '$1');
  const d = new Date(trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed : trimmed + 'Z');
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Envelope Mongo: { type, status, processed_at, data: { payment_id, payer, amount, ... } }
 */
function isEnvelopePayload(body) {
  if (!body || typeof body !== 'object') return false;
  const t = String(body.type || '').toLowerCase();
  if (t !== 'payment' && t !== 'subscription') return false;
  const inner = body.data;
  if (inner == null || typeof inner !== 'object') return false;
  if (t === 'subscription') return true;
  return inner.payment_id != null || inner._id != null || inner.subscription_id != null;
}

function normalizeEnvelopePayload(envelope) {
  const d = envelope.data;
  const payer = d.payer;
  const payerName =
    typeof payer === 'object' && payer !== null
      ? (payer.name || payer.email || 'Desconocido')
      : (payer || 'Desconocido');

  const firstPm =
    Array.isArray(d.payment_methods) && d.payment_methods.length > 0
      ? d.payment_methods[0]
      : {};
  const methodParts = [];
  if (firstPm.media_payment_detail) methodParts.push(firstPm.media_payment_detail);
  if (firstPm.last_four_digits) methodParts.push(`****${firstPm.last_four_digits}`);
  if (firstPm.type && !firstPm.media_payment_detail) methodParts.push(String(firstPm.type));
  const methodLabel = methodParts.length > 0 ? methodParts.join(' ') : null;

  const timestamp = parseTimestamp(
    envelope.processed_at || d.last_update_date || d.paid_date || d.process_date
  );

  const id = d._id != null ? String(d._id) : (d.payment_id || d.subscription_id || uuidv4());
  const entityType = String(envelope.type || 'payment').toLowerCase();

  let description = d.description || d.concept_description;
  if (!description) {
    description = entityType === 'subscription' ? 'Subscripción' : 'Pago recibido';
  }

  const refParts = [d.collector_id, d.entity_id].filter((x) => x != null && x !== '');
  const reference = refParts.length > 0 ? refParts.map(String).join(' / ') : null;

  return {
    id,
    transactionId: d.payment_id || d.subscription_id || null,
    amount: coerceAmountFromDocument(d),
    currency: d.currency_id || d.currency || 'ARS',
    status: envelope.status || d.status || 'received',
    type: entityType,
    description,
    payer: payerName,
    reference,
    timestamp,
    responseCode: firstPm.authorization_code || null,
    responseMessage: d.status_detail || envelope.status_detail || null,
    paymentMethod: methodLabel,
    notificationUrl: d.notification_url || null,
    collectorId: d.collector_id != null ? String(d.collector_id) : null,
    entityId: d.entity_id != null ? String(d.entity_id) : null,
    rawData: envelope
  };
}

// Normaliza el payload entrante (múltiples formatos soportados) a nuestro modelo de pago
function normalizePaymentPayload(data) {
  if (isEnvelopePayload(data)) {
    return normalizeEnvelopePayload(data);
  }

  // Detectar formato: nuevo formato de webhook (tiene collector_detail y payment_methods)
  const isWebhookFormat = data.collector_detail && Array.isArray(data.payment_methods);
  
  if (isWebhookFormat) {
    // Formato nuevo: webhook con collector_detail y payment_methods
    const collector = data.collector_detail || {};
    const payerName = collector.name || 'Desconocido';
    
    // Obtener primer detalle y método de pago
    const firstDetail = Array.isArray(data.details) && data.details.length > 0 ? data.details[0] : {};
    const firstPaymentMethod = Array.isArray(data.payment_methods) && data.payment_methods.length > 0 
      ? data.payment_methods[0] 
      : {};
    
    // Construir label del método de pago
    const methodParts = [];
    if (firstPaymentMethod.media_payment_detail) {
      methodParts.push(firstPaymentMethod.media_payment_detail);
    }
    if (firstPaymentMethod.last_four_digits) {
      methodParts.push(`****${firstPaymentMethod.last_four_digits}`);
    }
    const methodLabel = methodParts.length > 0 ? methodParts.join(' ') : null;
    
    // Timestamp: usar paid_date si existe, sino process_date, sino last_update_date
    const timestamp = data.paid_date || data.process_date || data.last_update_date || new Date().toISOString();
    
    return {
      id: data.id || uuidv4(),
      transactionId: data.external_transaction_id || firstPaymentMethod.gateway?.transaction_id || null,
      amount: coerceAmountFromDocument(data),
      currency: data.currency_id || data.currency || 'ARS',
      status: data.status || 'received',
      type: data.type || null,
      description: firstDetail.concept_description || firstDetail.concept_id || 'Pago recibido',
      payer: payerName,
      reference: firstDetail.external_reference || data.external_transaction_id || null,
      timestamp: timestamp,
      responseCode: firstPaymentMethod.authorization_code || null,
      responseMessage: data.status_detail || null,
      paymentMethod: methodLabel,
      rawData: data
    };
  } else {
    // Formato anterior: SQS con payment_id, payer object, etc.
    const payer = data.payer;
    const payerName = typeof payer === 'object' && payer !== null
      ? (payer.name || payer.email || 'Desconocido')
      : (payer || data.pagador || 'Desconocido');

    const paymentMethod = data.paymentMethod;
    const methodLabel = typeof paymentMethod === 'object' && paymentMethod !== null
      ? [paymentMethod.brand || paymentMethod.type, paymentMethod.lastFourDigits ? `****${paymentMethod.lastFourDigits}` : ''].filter(Boolean).join(' ')
      : (data.paymentMethod || null);

    // Tokens opcionales del paymentMethod (solo si vienen en el mensaje)
    const tokens = {};
    if (typeof paymentMethod === 'object' && paymentMethod !== null) {
      if (paymentMethod.token) tokens.token = paymentMethod.token;
      if (paymentMethod.tokenId) tokens.tokenId = paymentMethod.tokenId;
      if (paymentMethod.panToken) tokens.panToken = paymentMethod.panToken;
      if (paymentMethod.commerceToken) tokens.commerceToken = paymentMethod.commerceToken;
    }
    const hasTokens = Object.keys(tokens).length > 0;

    return {
      id: data.payment_id || data.id || uuidv4(),
      transactionId: data.transactionId || null,
      amount: coerceAmountFromDocument(data),
      currency: data.currency || data.moneda || 'ARS',
      status: data.status || data.estado || 'received',
      type: data.type || null,
      description: data.description || data.descripcion || 'Pago recibido',
      payer: payerName,
      reference: data.externalReference || data.reference || data.referencia || null,
      timestamp: data.processed_at || data.timestamp || new Date().toISOString(),
      responseCode: data.responseCode || null,
      responseMessage: data.responseMessage || null,
      paymentMethod: methodLabel,
      ...(hasTokens && { tokens }),
      rawData: data
    };
  }
}

// Webhook principal para recibir pagos desde Lambda/SQS
app.post('/webhook', (req, res) => {
  // Si el webhook está deshabilitado, retornar error 503 para que SQS reintente y vaya al DLQ
  if (!webhookEnabled) {
    console.log('🚫 Webhook deshabilitado - Rechazando mensaje (DLQ test)');
    return res.status(503).json({ 
      success: false, 
      error: 'Webhook temporalmente deshabilitado para pruebas de DLQ' 
    });
  }

  try {
    const paymentData = req.body;
    const item = normalizePaymentPayload(paymentData);
    const isSubscription = (item.type || '').toLowerCase() === 'subscription';

    if (isSubscription) {
      // Guardar en subscripciones (últimos 100)
      subscriptions.unshift(item);
      if (subscriptions.length > 100) {
        subscriptions.pop();
      }
      console.log('🔄 Subscripción recibida:', item);
      io.emit('new-subscription', item);
      res.status(200).json({ 
        success: true, 
        message: 'Subscripción recibida correctamente',
        id: item.id 
      });
    } else {
      // Guardar en pagos (últimos 100)
      payments.unshift(item);
      if (payments.length > 100) {
        payments.pop();
      }

      // Actualizar estadísticas agregadas
      const day = new Date(item.timestamp).toISOString().split('T')[0];
      if (!statsByDate[day]) {
        statsByDate[day] = { total: 0, status: {} };
      }
      statsByDate[day].total++;
      const st = item.status || 'unknown';
      statsByDate[day].status[st] = (statsByDate[day].status[st] || 0) + 1;

      console.log('💰 Pago recibido:', item);
      io.emit('new-payment', item);
      io.emit('stats-update', { date: day, stats: statsByDate[day] });

      res.status(200).json({ 
        success: true, 
        message: 'Pago recibido correctamente',
        paymentId: item.id 
      });
    }

  } catch (error) {
    console.error('Error procesando webhook:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error procesando el pago' 
    });
  }
});

// Endpoint para obtener historial de pagos
app.get('/payments', (req, res) => {
  res.json(payments);
});

// Endpoint para obtener subscripciones
app.get('/subscriptions', (req, res) => {
  res.json(subscriptions);
});

// WebSocket connection
io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado:', socket.id);
  
  socket.emit('payments-history', payments);
  socket.emit('subscriptions-history', subscriptions);
  const today = new Date().toISOString().split('T')[0];
  socket.emit('stats-update', { date: today, stats: statsByDate[today] || { total: 0, status: {} } });

  socket.on('disconnect', () => {
    console.log('❌ Cliente desconectado:', socket.id);
  });
});

// Catch-all para servir React en producción (debe ir al final)
if (isProduction && hasBuild) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   🚀 Servidor Webhook iniciado                             ║
║   📍 Puerto: ${PORT}                                          ║
║   📍 Modo: ${isProduction ? 'PRODUCCIÓN' : 'DESARROLLO'}                                  ║
║   📍 Webhook: /webhook                                     ║
║   Esperando pagos...                                       ║
╚════════════════════════════════════════════════════════════╝
  `);
});
