const qrcode = require('qrcode');
const url = 'exp://192.168.1.6:8081';
qrcode.toString(url, { type: 'terminal', small: true }, (err, str) => {
  if (err) { console.error(err); process.exit(1); }
  console.log('\n📱 Scan this QR code with Expo Go:\n');
  console.log(str);
  console.log('URL:', url);
});
