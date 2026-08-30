/* ============================================================
   build.js — بررسیِ ساده‌ی ساخت؛ فایلِ نهایی همان _worker.js است.
   اجرا:  node build.js
   ============================================================ */
const fs = require('fs');
const src = fs.readFileSync('_worker.js', 'utf8');
// فقط بررسیِ معتبر بودنِ سینتکس
try {
  new Function(src.replace(/export default[\s\S]*$/, 'return {};'));
  console.log('✅ _worker.js معتبر است');
} catch (e) {
  console.error('❌ خطای سینتکس:', e.message);
  process.exit(1);
}
