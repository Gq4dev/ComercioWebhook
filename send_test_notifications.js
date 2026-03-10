// script para enviar muchas notificaciones de prueba al webhook
// Uso: node send_test_notifications.js [url] [count]
// url por defecto http://localhost:3001/webhook
// count por defecto 50000

const url = process.argv[2] || 'http://localhost:3001/webhook';
const total = parseInt(process.argv[3], 10) || 50000;

console.log(`Enviando ${total} notificaciones a ${url}`);

function randomStatus() {
  const statuses = ['approved', 'pending', 'rejected', 'error', 'received'];
  return statuses[Math.floor(Math.random() * statuses.length)];
}

function randomAmount() {
  return (Math.random() * 1000).toFixed(2);
}

function makePayload(i) {
  return {
    id: `test-${i}-${Date.now()}`,
    amount: randomAmount(),
    currency: 'ARS',
    status: randomStatus(),
    payer: `Usuario ${i}`,
    timestamp: new Date().toISOString()
  };
}

async function sendOne(i) {
  const payload = makePayload(i);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return true;
  } catch (err) {
    console.error(`Error en envío ${i}:`, err.message);
    return false;
  }
}

async function run() {
  const concurrency = 200;
  let inFlight = 0;
  let sent = 0;
  let success = 0;

  const queue = [];
  for (let i = 1; i <= total; i++) {
    const promise = new Promise((resolve) => {
      const trySend = async () => {
        inFlight++;
        const ok = await sendOne(i);
        inFlight--;
        if (ok) success++;
        sent++;
        process.stdout.write(`\rEnviados ${sent}/${total} (ok ${success}) inFlight ${inFlight}`);
        resolve();
        if (i < total) scheduleNext();
      };
      const scheduleNext = () => {
        if (inFlight < concurrency) {
          trySend();
        } else {
          setTimeout(scheduleNext, 1);
        }
      };
      scheduleNext();
    });
    queue.push(promise);
  }
  await Promise.all(queue);
  console.log(`\nTerminó: success=${success} / ${total}`);
}

run().catch(console.error);
