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
const payments = [];

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

// Normaliza el payload entrante (formato SQS nuevo o legacy) a nuestro modelo de pago
function normalizePaymentPayload(data) {
  const payer = data.payer;
  const payerName = typeof payer === 'object' && payer !== null
    ? (payer.name || payer.email || 'Desconocido')
    : (payer || data.pagador || 'Desconocido');

  const paymentMethod = data.paymentMethod;
  const methodLabel = typeof paymentMethod === 'object' && paymentMethod !== null
    ? [paymentMethod.brand || paymentMethod.type, paymentMethod.lastFourDigits ? `****${paymentMethod.lastFourDigits}` : ''].filter(Boolean).join(' ')
    : (data.paymentMethod || null);

  return {
    id: data.payment_id || data.id || uuidv4(),
    transactionId: data.transactionId || null,
    amount: data.amount ?? data.monto ?? 0,
    currency: data.currency || data.moneda || 'ARS',
    status: data.status || data.estado || 'received',
    description: data.description || data.descripcion || 'Pago recibido',
    payer: payerName,
    reference: data.externalReference || data.reference || data.referencia || null,
    timestamp: data.processed_at || data.timestamp || new Date().toISOString(),
    responseCode: data.responseCode || null,
    responseMessage: data.responseMessage || null,
    paymentMethod: methodLabel,
    rawData: data
  };
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
    const payment = normalizePaymentPayload(paymentData);

    // Guardar en memoria
    payments.unshift(payment);
    
    // Limitar a últimos 100 pagos
    if (payments.length > 100) {
      payments.pop();
    }

    console.log('💰 Pago recibido:', payment);

    // Emitir a todos los clientes conectados
    io.emit('new-payment', payment);

    res.status(200).json({ 
      success: true, 
      message: 'Pago recibido correctamente',
      paymentId: payment.id 
    });

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

// WebSocket connection
io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado:', socket.id);
  
  // Enviar pagos existentes al conectarse
  socket.emit('payments-history', payments);

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
