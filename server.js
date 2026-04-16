require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { isEncryptedPayload, decryptPayload } = require('./decrypt');

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
  // Formato Paytic: details[].amount, payment_methods[].final_amount
  const det0 = Array.isArray(d.details) && d.details[0];
  if (det0 && typeof det0 === 'object') {
    const n = unwrap(det0.amount);
    if (n != null) return n;
  }
  const pm0 = Array.isArray(d.payment_methods) && d.payment_methods[0];
  if (pm0 && typeof pm0 === 'object') {
    for (const k of ['final_amount', 'amount']) {
      const n = unwrap(pm0[k]);
      if (n != null) return n;
    }
  }
  return 0;
}

/** Normaliza timestamp ISO (+0000, microsegundos) a ISO UTC */
function parseTimestamp(ts) {
  if (ts == null) return new Date().toISOString();
  if (typeof ts !== 'string') {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  let s = ts.replace(/(\.\d{3})\d+(?=\D|$)/, '$1');
  // "2025-12-17T18:19:16+0000" -> "+00:00"
  const tzOffset = s.match(/([+-])(\d{2})(\d{2})$/);
  if (tzOffset && !/[+-]\d{2}:\d{2}$/.test(s)) {
    s = s.replace(/([+-])(\d{2})(\d{2})$/, (_, sign, hh, mm) => `${sign}${hh}:${mm}`);
  }
  const d = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`);
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
  return true;
}

function normalizeEnvelopePayload(envelope) {
  const d = envelope.data;
  const payer = d.payer || envelope.payer;
  const collectorDetail = d.collector_detail || envelope.collector_detail;
  const payerName =
    typeof payer === 'object' && payer !== null
      ? (payer.name || payer.email || 'Desconocido')
      : (payer || (typeof collectorDetail === 'object' && collectorDetail ? (collectorDetail.name || collectorDetail.public_email) : null) || 'Desconocido');

  const pmArray = Array.isArray(d.payment_methods) && d.payment_methods.length > 0
    ? d.payment_methods
    : (Array.isArray(envelope.payment_methods) && envelope.payment_methods.length > 0 ? envelope.payment_methods : []);
  const firstPm = pmArray.length > 0 ? pmArray[0] : {};
  const methodParts = [];
  if (firstPm.media_payment_detail) methodParts.push(firstPm.media_payment_detail);
  if (firstPm.last_four_digits) methodParts.push(`****${firstPm.last_four_digits}`);
  if (firstPm.type && !firstPm.media_payment_detail) methodParts.push(String(firstPm.type));
  const methodLabel = methodParts.length > 0 ? methodParts.join(' ') : null;

  const timestamp = parseTimestamp(
    envelope.processed_at || d.last_update_date || d.paid_date || d.process_date
  );

  const id = d._id != null ? String(d._id) : (d.payment_id || d.id || d.subscription_id || uuidv4());
  const entityType = String(envelope.type || 'payment').toLowerCase();

  const det0 = Array.isArray(d.details) && d.details[0]
    ? d.details[0]
    : (Array.isArray(envelope.details) && envelope.details[0] ? envelope.details[0] : null);
  let description = d.description || d.concept_description || (det0 && (det0.concept_description || det0.description)) || envelope.description;
  if (!description) {
    description = entityType === 'subscription' ? 'Subscripción' : 'Pago recibido';
  }

  const refParts = [d.collector_id, d.entity_id].filter((x) => x != null && x !== '');
  const reference = refParts.length > 0 ? refParts.map(String).join(' / ') : null;

  const amount = coerceAmountFromDocument(d) || coerceAmountFromDocument(envelope);

  return {
    id,
    transactionId: d.payment_id || d.external_transaction_id || d.subscription_id || null,
    amount,
    currency: d.currency_id || d.currency || envelope.currency_id || envelope.currency || 'ARS',
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
    collectorId: d.collector_id != null ? String(d.collector_id) : (envelope.collector_id != null ? String(envelope.collector_id) : null),
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
    // Formato Paytic / webhooks: collector_detail, details[], payment_methods[], payer
    const collector = data.collector_detail || {};
    const payerObj = data.payer;
    const payerName =
      typeof payerObj === 'object' && payerObj !== null
        ? (payerObj.name || payerObj.email || collector.name || collector.public_email || 'Desconocido')
        : (collector.name || collector.public_email || 'Desconocido');

    const firstDetail =
      Array.isArray(data.details) && data.details.length > 0 ? data.details[0] : {};
    const firstPaymentMethod =
      Array.isArray(data.payment_methods) && data.payment_methods.length > 0
        ? data.payment_methods[0]
        : {};
    const gw = firstPaymentMethod.gateway && typeof firstPaymentMethod.gateway === 'object'
      ? firstPaymentMethod.gateway
      : {};

    const methodParts = [];
    if (firstPaymentMethod.media_payment_detail) {
      methodParts.push(String(firstPaymentMethod.media_payment_detail));
    } else if (firstPaymentMethod.type) {
      methodParts.push(String(firstPaymentMethod.type));
    }
    if (firstPaymentMethod.last_four_digits) {
      methodParts.push(`****${firstPaymentMethod.last_four_digits}`);
    }
    const methodLabel = methodParts.length > 0 ? methodParts.join(' ') : null;

    const timestamp = parseTimestamp(
      data.last_update_date ||
        data.process_date ||
        data.rejected_date ||
        data.paid_date ||
        data.request_date ||
        data.due_date
    );

    const status = data.status || gw.status || 'received';
    const responseCode =
      gw.status_code != null
        ? String(gw.status_code)
        : firstPaymentMethod.authorization_code != null
          ? String(firstPaymentMethod.authorization_code)
          : null;
    const responseMessage = gw.status_detail || data.status_detail || null;

    const tokens = {};
    if (firstPaymentMethod.pan_token) tokens.panToken = firstPaymentMethod.pan_token;
    const hasTokens = Object.keys(tokens).length > 0;

    const reference =
      firstDetail.external_reference ||
      data.by_subscription ||
      data.external_transaction_id ||
      null;

    return {
      id: data.id || uuidv4(),
      transactionId: data.external_transaction_id || gw.transaction_id || null,
      amount: coerceAmountFromDocument(data),
      currency:
        data.currency_id ||
        firstPaymentMethod.currency_id ||
        data.currency ||
        'ARS',
      status,
      type: data.type || null,
      description:
        firstDetail.concept_description ||
        firstDetail.concept_id ||
        'Pago recibido',
      payer: payerName,
      payerEmail: typeof payerObj === 'object' && payerObj ? payerObj.email || null : null,
      reference,
      bySubscription: data.by_subscription || null,
      collectorId: data.collector_id != null ? String(data.collector_id) : null,
      channel: data.channel || null,
      gatewayName: gw.name || null,
      timestamp,
      responseCode,
      responseMessage,
      paymentMethod: methodLabel,
      notificationUrl: data.notification_url || null,
      rawData: data,
      ...(hasTokens && { tokens })
    };
  } else {
    // Formato anterior: SQS con payment_id, payer object, etc.
    // Fallback: check data.data for nested fields
    const inner = (data.data && typeof data.data === 'object') ? data.data : null;
    const payer = data.payer || (inner && inner.payer);
    const payerName = typeof payer === 'object' && payer !== null
      ? (payer.name || payer.email || 'Desconocido')
      : (payer || data.pagador || 'Desconocido');

    const paymentMethod = data.paymentMethod;
    const methodLabel = typeof paymentMethod === 'object' && paymentMethod !== null
      ? [paymentMethod.brand || paymentMethod.type, paymentMethod.lastFourDigits ? `****${paymentMethod.lastFourDigits}` : ''].filter(Boolean).join(' ')
      : (data.paymentMethod || null);

    const tokens = {};
    if (typeof paymentMethod === 'object' && paymentMethod !== null) {
      if (paymentMethod.token) tokens.token = paymentMethod.token;
      if (paymentMethod.tokenId) tokens.tokenId = paymentMethod.tokenId;
      if (paymentMethod.panToken) tokens.panToken = paymentMethod.panToken;
      if (paymentMethod.commerceToken) tokens.commerceToken = paymentMethod.commerceToken;
    }
    const hasTokens = Object.keys(tokens).length > 0;

    const amount = coerceAmountFromDocument(data) || (inner ? coerceAmountFromDocument(inner) : 0);

    return {
      id: data.payment_id || data.id || uuidv4(),
      transactionId: data.transactionId || data.external_transaction_id || null,
      amount,
      currency: data.currency || data.currency_id || data.moneda || 'ARS',
      status: data.status || data.estado || 'received',
      type: data.type || null,
      description: data.description || data.descripcion || (inner && (inner.description || inner.concept_description)) || 'Pago recibido',
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
    let paymentData = req.body;

    let wasEncrypted = false;
    if (isEncryptedPayload(paymentData)) {
      try {
        paymentData = decryptPayload(paymentData);
        wasEncrypted = true;
        console.log('🔐 Payload desencriptado correctamente');
      } catch (decErr) {
        console.error('🔐 Error desencriptando payload:', decErr.message);
        return res.status(400).json({
          success: false,
          error: 'Error desencriptando payload: ' + decErr.message
        });
      }
    }

    console.log('📦 Payload recibido — keys:', Object.keys(paymentData), '| type:', paymentData.type, '| data keys:', paymentData.data ? Object.keys(paymentData.data) : 'N/A');
    const item = normalizePaymentPayload(paymentData);
    if (wasEncrypted) item.encrypted = true;
    console.log('📊 Normalizado — amount:', item.amount, '| payer:', item.payer, '| status:', item.status);
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
