const WebSocket = require('ws');

const ws = new WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr');

ws.on('open', () => {
  console.log('Connected');
});

ws.on('message', (data) => {
  const raw = data.toString();
  console.log('Message received:', raw.slice(0, 200));
  ws.close();
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('Error:', err);
  process.exit(1);
});

setTimeout(() => {
  console.log('Timeout');
  ws.close();
  process.exit(0);
}, 3000);
