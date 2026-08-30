/* =============================================================================
 *  تخت‌ساز Railway | TAKHT-SAZ RAILWAY
 *  بات تلگرامیِ لانچرِ خودکارِ پنلِ «تخت جمشید» روی Railway
 *  نسخه 0.1.0
 *
 *  کاربر توکنِ Account Token ریلیو (token_...) را می‌فرستد؛
 *  بات به‌صورتِ خودکار روی حسابِ خودِ کاربر: پروژه + سرویس + دامنه می‌سازد،
 *  استقرار را آغاز می‌کند و در پایان لینکِ پنل را تحویل می‌دهد.
 *
 *  پیش‌نیازها:
 *    • یک Worker روی Cloudflare (پلن رایگان کافی است)
 *    • یک KV با Binding به نامِ دقیقِ KV
 *    • متغیرهای محیطی (رازها):
 *        TELEGRAM_TOKEN   → توکنِ رباتِ تلگرام (از BotFather)
 *        WEBHOOK_SECRET   → رازِ وب‌هوک (اختیاری، توصیه‌شده)
 *    • متغیرهای معمولی:
 *        RAILWAY_REPO, RAILWAY_BRANCH, etc. (اختیاری)
 *
 *  راه‌اندازی وب‌هوک:  GET  https://<worker>.workers.dev/setup
 * ============================================================================= */

// ---------------------------------------------------------------------------
// ثابت‌ها
// ---------------------------------------------------------------------------
const VERSION = '0.1.0';
const BOT_NAME = 'تخت‌ساز Railway';
const TELEGRAM_API = 'https://api.telegram.org/bot';
const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

// ---------------------------------------------------------------------------
// متغیرهای محیطی — در Workerِ ماژولار از طریق پارامترِ env (در fetch) می‌آیند.
//   این توابع فقط مقادیرِ پیکربندی (نهSecret) را برمی‌گردانند.
// ---------------------------------------------------------------------------
function env(k, d, envObj) {
  try { return envObj && envObj[k] !== undefined && envObj[k] !== null ? envObj[k] : d; }
  catch (e) { return d; }
}
function cfg(envObj) {
  return {
    repo: env('RAILWAY_REPO', 'takhtejamshid-panel/takht-e-jamshid-backend', envObj),
    branch: env('RAILWAY_BRANCH', 'main', envObj),
    prefix: env('RAILWAY_SERVICE_PREFIX', 'takht-panel', envObj),
    domSuf: env('RAILWAY_DOMAIN_SUFFIX', 'up.railway.app', envObj),
    maxPerH: parseInt(env('MAX_DEPLOYS_PER_HOUR', '3', envObj), 10) || 3,
    maxGlobal: parseInt(env('MAX_GLOBAL_PER_HOUR', '40', envObj), 10) || 40,
  };
}

// ---------------------------------------------------------------------------
// ابزارهای کمکی
// ---------------------------------------------------------------------------
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });

async function tg(token, method, body) {
  const r = await fetch(TELEGRAM_API + token + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}
const sendMsg = (t, c, text, kb) =>
  tg(t, 'sendMessage', { chat_id: c, text, parse_mode: 'HTML', ...(kb ? { reply_markup: JSON.stringify({ keyboard: kb, resize_keyboard: true, one_time_keyboard: true }) } : {}) });
const editMsg = (t, c, m, text) => tg(t, 'editMessageText', { chat_id: c, message_id: m, text, parse_mode: 'HTML' });

// نرمالیزه‌کردنِ توکنِ ریلیو (حذفِ فاصله/افزودنِ "Bearer")
function cleanToken(raw) {
  let t = String(raw || '').trim();
  if (t.startsWith('Bearer ')) t = t.slice(7);
  return t.replace(/[\s"'`]/g, '');
}

// GraphQL با توکنِ ریلیو
async function gql(token, query, variables) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
    body: JSON.stringify({ query, variables }),
  });
  const txt = await res.text();
  let d; try { d = JSON.parse(txt); } catch (e) { throw new Error('پاسخ نامعتبر از ریلیو: ' + txt.slice(0, 160)); }
  if (d.errors && d.errors.length) throw new Error(d.errors[0].message || 'خطای API ریلیو');
  return d.data || {};
}

// ---------------------------------------------------------------------------
// محدودیتِ نرخ (ساده با KV)
// ---------------------------------------------------------------------------
const hourKey = () => { const d = new Date(); return d.toISOString().slice(0, 13); };
async function checkRate(kv, uid, maxPerH, maxGlobal) {
  if (!kv) return { ok: true };
  const h = hourKey();
  const uK = 'rate:' + h + ':u:' + uid, gK = 'rate:' + h + ':g';
  const [uRaw, gRaw] = await Promise.all([kv.get(uK).then(v => v || '0'), kv.get(gK).then(v => v || '0')]);
  const u = +uRaw, g = +gRaw;
  if (u >= maxPerH) return { ok: false, msg: 'در یک ساعت بیش از ' + maxPerH + ' پنل نمی‌توانی بسازی. کمی صبر کن.' };
  if (g >= maxGlobal) return { ok: false, msg: 'سهمیه‌ی بات در این ساعت پر شده؛ بعداً تلاش کن.' };
  await Promise.all([kv.put(uK, String(u + 1), { expirationTtl: 3600 }), kv.put(gK, String(g + 1), { expirationTtl: 3600 })]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ساختِ پنل روی ریلیو
// ---------------------------------------------------------------------------
async function provision(userToken, chatId, tgToken, cf) {
  // 0) اعتبارسنجیِ توکن و گرفتنِ هویتِ صاحب
  const me = await gql(userToken, 'query { me { id name email } }', {});
  const user = me.me || {};
  const email = user.email || (user.name || 'کاربر');

  await sendMsg(tgToken, chatId, '👤 توکن معتبر است — صاحبِ حساب: <code>' + (email) + '</code>\n⚙️ در حالِ ساختِ پروژه…');

  // 1) ساختِ پروژه
  const projName = 'takht-' + Math.random().toString(36).slice(2, 8);
  const pj = await gql(userToken,
    'mutation($name:String!){ projectCreate(input:{ name:$name }){ id name } }',
    { name: projName });
  const projectId = pj.projectCreate && pj.projectCreate.id;
  if (!projectId) throw new Error('ساختِ پروژه ناموفق بود.');

  // 2) یافتنِ محیطِ production (پیش‌فرضِ پروژه‌ی جدید: production)
  const envQ = await gql(userToken,
    `query($p:String!){ project(id:$p){ environments{ edges{ node{ id name } } } } }`, { p: projectId });
  const envs = (envQ.project && envQ.project.environments && envQ.project.environments.edges) || [];
  let envObj = envs.find(e => e.node.name === 'production') || envs[0];
  if (!envObj) {
    // ساختِ محیط اگر نبود
    const ec = await gql(userToken,
      'mutation($p:String!,$n:String!){ environmentCreate(input:{ projectId:$p, name:$n }){ id name } }',
      { p: projectId, n: 'production' });
    if (ec.environmentCreate) envObj = { node: { id: ec.environmentCreate.id, name: 'production' } };
  }
  const environmentId = envObj && envObj.node.id;
  if (!environmentId) throw new Error('محیطِ پروژه پیدا نشد.');

  await sendMsg(tgToken, chatId, '📦 گروهِ ساخته شد؛ در حالِ اتصال به مخزنِ پنل…');

  // 3) ساختِ سرویس از مخزِنِ گیت‌هاب (public repo)
  const srvName = cf.prefix + '-' + Math.random().toString(36).slice(2, 6);
  const sv = await gql(userToken,
    `mutation($s:ServiceCreateInput!){ serviceCreate(input:$s){ id name } }`,
    { s: { name: srvName, projectId, environmentId, source: { repo: cf.repo }, branch: cf.branch } });
  const serviceId = sv.serviceCreate && sv.serviceCreate.id;
  if (!serviceId) throw new Error('ساختِ سرویس ناموفق بود.');

  await sendMsg(tgToken, chatId, '🔗 سرویس متصل شد؛ در حالِ افزودنِ متغیرِ محیطی…');

  // 4) افزودنِ متغیرِ محیطی لازم برای پنل (اختیاری/نیمه‌الزامی)
  try {
    await gql(userToken,
      'mutation($e:String!,$v:EnvironmentVariables){ variableCollectionUpsert(input:{ environmentId:$e, variables:$v }) }',
      { e: environmentId, v: { ADMIN_USER: 'admin' } });
  } catch (e) { /* غیرِ کشنده */ }

  // 5) ساختِ دامنه‌ی عمومی (up.railway.app)
  const dm = await gql(userToken,
    'mutation($e:String!,$s:String!){ serviceDomainCreate(input:{ environmentId:$e, serviceId:$s }){ id domain } }',
    { e: environmentId, s: serviceId });
  let domain = dm.serviceDomainCreate && dm.serviceDomainCreate.domain;
  if (Array.isArray(domain)) domain = domain[0];

  await sendMsg(tgToken, chatId, '🌐 دامنه‌ی عمومی آماده شد؛ در حالِ آغازِ استقرار…');

  // 6) آغازِ استقرار
  let deployId = null;
  try {
    const dep = await gql(userToken,
      'mutation($s:String!,$e:String!){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e) }',
      { s: serviceId, e: environmentId });
    deployId = dep && dep.serviceInstanceDeployV2;
  } catch (e) { /* شاید استقرار خودکار با سرویس آغاز شود */ }

  return {
    projectId, projectName: projName, environmentId, serviceId, deployId, domain,
    email: email, hostname: (domain || projName + '.' + cf.domSuf),
  };
}

// ---------------------------------------------------------------------------
// صفحه‌ی «در حالِ ساخت»: هم پیامِ شروع، هم در پایان لینکِ کامل را می‌دهد
// ---------------------------------------------------------------------------
async function deliverPanel(info, tgToken, chatId) {
  await sendMsg(tgToken, chatId,
    '🚀 <b>پنلِ تو در حالِ ساخت است!</b>\n\n' +
    '🔗 آدرسِ پنل (به‌محضِ آماده‌شدن فعال می‌شود):\n<b>' + info.hostname + '</b>\n\n' +
    'نکته: اولین استقرار ممکن است ۱ تا ۵ دقیقه طول بکشد. آدرسِ بالا را بعداً باز کنید تا پنلِ «تخت جمشید» را ببینید.\n\n' +
    '🔑 ورودِ پیش‌فرض: <code>admin</code> / <code>admin123</code>\n' +
    '⚙️ پس از ورود حتماً رمز را در «تنظیمات» تغییر دهید.');
}

// ---------------------------------------------------------------------------
// پردازشِ پیام‌های تلگرام
// ---------------------------------------------------------------------------
async function handleMessage(token, msg, envObj) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const from = msg.from;
  const uid = String(from && from.id ? from.id : chatId);
  const first = from && from.first_name ? from.first_name : 'کاربر';

  if (text === '/start' || text === '/help' || text === '🏛 شروع' || text === '/راهنما') {
    return sendMsg(token, chatId,
      '🏛 <b>' + BOT_NAME + '</b>\n\n' +
      'این ربات با گرفتنِ <b>Account Token</b> ریلیو، روی حسابِ <b>خودِ تو</b> یک پنلِ «تخت جمشید» (FastAPI) می‌سازد و لینکِ آن را می‌دهد.\n\n' +
      '👇 برای شروع، توکنِ ریلیو را همین‌جا بفرست:\n<code>token_xxxxxxxx</code>\n\n' +
      '🔒 توکن فقط برای ساختِ پنل استفاده می‌شود و در هیچ‌جا ذخیره نمی‌گردد.',
      [['🏛 شروع'], ['📖 دریافت توکن'], ['ℹ️ راهنما']]);
  }

  if (text === '📖 دریافت توکن') {
    return sendMsg(token, chatId,
      '🔑 <b>دریافتِ توکنِ ریلیو (Account Token)</b>\n\n' +
      '۱. برو به <a href="https://railway.com">railway.com</a> و وارد حساب شو.\n' +
      '۲. از منویِ بالا: <b>Settings → Tokens</b> (یا <a href="https://railway.com/account/tokens">این لینک</a>).\n' +
      '۳. دکمه‌ی <b>New Token</b> را بزن.\n' +
      '۴. در کادرِ «Workspace» <b>No workspace</b> را انتخاب کن (این نکته‌ی کلیدی است!).\n' +
      '۵. یک نام بگذار (مثلاً takht-saz) و Create.\n' +
      '۶. توکنِ ساخته‌شده که با <code>token_</code> شروع می‌شود را کپی و برایم بفرست.\n\n' +
      '⚠️ این توکن فقط یک‌بار نمایش داده می‌شود؛ همان‌جا کپی‌اش کن.',
      [['🏛 شروع']]);
  }

  if (text === 'ℹ️ راهنما') {
    return sendMsg(token, chatId,
      'ℹ️ <b>راهنما</b>\n\n' +
      '۱. توکنِ ریلیو را بفرست (<code>token_...</code>).\n' +
      '۲. ربات روی حسابِ تو پروژه و سرویس می‌سازد و استقرار را آغاز می‌کند.\n' +
      '۳. لینکِ پنل را تحویل می‌دهد.\n\n' +
      '🔐 <b>امنیت:</b>\n' +
      '• توکن از سرورهای تلگرام عبور می‌کند و سپس واردِ Workerِ بات می‌شود.\n' +
      '• ما آن را ذخیره نمی‌کنیم؛ فقط لحظه‌ای برای فراخوانیِ API ریلیو استفاده می‌شود.\n' +
      '• پیشنهاد: بعد از پایانِ کار، توکن را از ریلیو باطل (revoke) کن.',
      [['🏛 شروع']]);
  }

  // تشخیصِ توکنِ ریلیو در متن
  const m = text.match(/(token_[A-Za-z0-9\-_]{6,})/i);
  if (m) {
    const userToken = cleanToken(m[1]);
    const cf = cfg(envObj);
    const rate = await checkRate(envObj.KV, uid, cf.maxPerH, cf.maxGlobal);
    if (!rate.ok) return sendMsg(token, chatId, '⛔ ' + rate.msg);

    await sendMsg(token, chatId, '⚙️ شروعِ ساختِ پنل… (۱ تا ۵ دقیقه)');
    try {
      const info = await provision(userToken, chatId, token, cf);
      await deliverPanel(info, token, chatId);
    } catch (e) {
      await sendMsg(token, chatId, '❌ <b>خطا در ساختِ پنل</b>\n\n' + (e.message || 'نامشخص') +
        '\n\nمطمئن شو که توکن، <b>Account Token</b> (<code>token_...</code>) باشد و حسابِ تو دسترسیِ کافی دارد.',
        [['🏛 شروع'], ['📖 دریافت توکن']]);
    }
    return;
  }

  return sendMsg(token, chatId,
    'متنِ درست را نفهمیدم. لطفاً توکنِ ریلیو (<code>token_...</code>) را بفرست یا <b>/start</b> را بزن.',
    [['🏛 شروع'], ['📖 دریافت توکن']]);
}

// ---------------------------------------------------------------------------
// روتر
// ---------------------------------------------------------------------------
async function handleRequest(request, envObj) {
  const url = new URL(request.url);
  const TELEGRAM_TOKEN = envObj.TELEGRAM_TOKEN || '';
  const WEBHOOK_SECRET = env('WEBHOOK_SECRET', 'tj', envObj);

  if (url.pathname === '/health') return json({ ok: true, name: BOT_NAME, version: VERSION });
  if (url.pathname === '/') return json({ ok: true, message: 'تخت‌ساز Railway در حال اجراست. مسیرِ وب‌هوک: /tg/<secret>' });

  // راه‌اندازیِ وب‌هوک (GET)
  if (url.pathname === '/setup' && request.method === 'GET') {
    const r = await tg(TELEGRAM_TOKEN, 'setWebhook', {
      url: url.origin + '/tg/' + WEBHOOK_SECRET, secret_token: WEBHOOK_SECRET, allowed_updates: ['message'],
    });
    return json({ ok: !!(r && r.ok), result: r });
  }

  // وب‌هوکِ تلگرام
  if (url.pathname.startsWith('/tg/') && request.method === 'POST') {
    const supplied = url.pathname.slice(4);
    if (WEBHOOK_SECRET && supplied !== WEBHOOK_SECRET) return json({ ok: false }, 403);
    const body = await request.json().catch(() => ({}));
    if (body && body.message) await handleMessage(TELEGRAM_TOKEN, body.message, envObj);
    return json({ ok: true }, 200);
  }

  return json({ ok: false }, 404);
}

export default {
  async fetch(request, envObj, ctx) {
    try { return await handleRequest(request, envObj); }
    catch (e) {
      console.error(e);
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
};
