# Comercio - Webhook de Pagos

Panel de notificaciones en tiempo real para recibir pagos desde Lambda/SQS.

## Instalación

```bash
# Instalar todas las dependencias (backend + frontend)
npm run install-all
```

## Instalar ngrok

1. Descarga ngrok: https://ngrok.com/download
2. Extrae y agrega al PATH, o colócalo en esta carpeta
3. Crea cuenta gratis en https://ngrok.com y obtén tu authtoken
4. Configura tu token:

```bash
ngrok config add-authtoken TU_TOKEN_AQUI
```

## Uso

### Sin túnel (solo local)
```bash
npm run dev
```

### Con túnel ngrok (acceso público)
```bash
npm run dev:tunnel
```

O en terminales separadas:
```bash
# Terminal 1: Servidor + Frontend
npm run dev

# Terminal 2: Túnel ngrok
ngrok http 3001
```

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001
- **Webhook local**: http://localhost:3001/webhook
- **Webhook público**: https://XXXXX.ngrok-free.app/webhook (ver consola de ngrok)

## Probar el Webhook

Envía un POST al webhook con datos de pago:

```bash
curl -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 15000,
    "currency": "ARS",
    "payer": "Juan Pérez",
    "description": "Compra de productos",
    "reference": "ORD-2024-001"
  }'
```

### Ejemplo con PowerShell

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/webhook" -Method POST -ContentType "application/json" -Body '{
  "amount": 25000,
  "currency": "ARS",
  "payer": "María García",
  "description": "Servicio premium",
  "reference": "SVC-2024-042"
}'
```

## Estructura del Payload

El webhook acepta los siguientes campos:

| Campo | Alternativo | Descripción |
|-------|-------------|-------------|
| `amount` | `monto` | Monto del pago |
| `currency` | `moneda` | Moneda (default: ARS) |
| `payer` | `pagador` | Nombre del pagador |
| `description` | `descripcion` | Descripción del pago |
| `reference` | `referencia` | Referencia/ID externo |
| `status` | `estado` | Estado del pago |

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/webhook` | Recibir notificación de pago |
| GET | `/payments` | Listar historial de pagos |
| GET | `/health` | Verificar estado del servidor |

## Integración con AWS Lambda

Configura tu Lambda para enviar POST a tu URL de ngrok cuando procese mensajes de SQS.

```javascript
// Ejemplo de Lambda
exports.handler = async (event) => {
  // Usa tu URL de ngrok aquí
  const WEBHOOK_URL = 'https://tu-subdominio.ngrok-free.app/webhook';
  
  for (const record of event.Records) {
    const body = JSON.parse(record.body);
    
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
  
  return { statusCode: 200 };
};
```

## Desplegar en Render

### Opción 1: Desde GitHub

1. Sube el código a un repositorio de GitHub:
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/comercio-webhook.git
git push -u origin main
```

2. Ve a [render.com](https://render.com) y crea una cuenta
3. Click en **New** → **Web Service**
4. Conecta tu repositorio de GitHub
5. Render detectará automáticamente la configuración del `render.yaml`
6. Click en **Create Web Service**

### Opción 2: Configuración manual en Render

Si prefieres configurar manualmente:

| Campo | Valor |
|-------|-------|
| **Build Command** | `npm run render-build` |
| **Start Command** | `npm start` |
| **Environment** | `NODE_ENV = production` |

### URL de tu webhook en Render

Una vez desplegado, tu webhook estará en:
```
https://comercio-webhook.onrender.com/webhook
```

(El nombre exacto depende del nombre que elijas en Render)

## Ngrok (desarrollo local)

Para tener siempre la misma URL (requiere cuenta de pago):

```bash
ngrok http 3001 --domain=tu-dominio.ngrok-free.app
```
