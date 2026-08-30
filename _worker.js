/* =============================================================================
 *  تخت‌ساز Railway | TAKHT-SAZ RAILWAY  v0.2.0
 *  بات تلگرامیِ لانچرِ خودکارِ پنلِ «تخت جمشید» روی Railway
 *
 *  معماری (step-driven):
 *    ──/start────► منو (دکمه‌ی قابلاستفاده)
 *    ─توکن──► اعتبارسنجی (query me + workspaces) ► ساختِ پروژه/سرویس/دامنه ► آغازِ استقرار
 *    ─"بررسی وضعیت"──► پولِ deployment(status) و تحویلِ لینکِ نهایی + QR
 *
 *  پیش‌نیاز: Worker + KV (binding به نام KV) + رازها:
 *      TELEGRAM_TOKEN (secret) ، WEBHOOK_SECRET (اختیاری)
 *  وب‌هوک: GET /setup
 * ============================================================================= */

const VERSION = '0.2.0';
const BOT_NAME = 'تخت‌ساز Railway';
const TELEGRAM_API = 'https://api.telegram.org/bot';
const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
const QR_API = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=';

// --- پیکربندی (از env) ---
function env(k, d, e) { try { return e && e[k] !== undefined && e[k] !== null ? e[k] : d; } catch (_) { return d; } }
function cfg(e) {
  return {
    repo: env('RAILWAY_REPO', 'takhtejamshid-panel/takht-e-jamshid-backend', e),
    branch: env('RAILWAY_BRANCH', 'main', e),
    prefix: env('RAILWAY_SERVICE_PREFIX', 'takht-panel', e),
    domSuf: env('RAILWAY_DOMAIN_SUFFIX', 'up.railway.app', e),
    maxPerH: parseInt(env('MAX_DEPLOYS_PER_HOUR', '3', e), 10) || 3,
    maxGlobal: parseInt(env('MAX_GLOBAL_PER_HOUR', '40', e), 10) || 40,
    base: env('PANEL_BASE_URL', '', e),
  };
}

// --- ابزارهای تلگرام ---
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });
async function tg(token, method, body) {
  const r = await fetch(TELEGRAM_API + token + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
const sendMsg = (t, c, text, kb) => tg(t, 'sendMessage', { chat_id: c, text, parse_mode: 'HTML' , ...(kb ? { reply_markup: kb } : {}) });
const editMsg = (t, c, m, text, kb) => tg(t, 'editMessageText', { chat_id: c, message_id: m, text, parse_mode: 'HTML', ...(kb ? { reply_markup: kb } : {}) });

// کیبوردهای قابلاستفاده (inline)
const kb = {
  main: { inline_keyboard: [
    [{ text: '🏛 شروع', callback_data: 'start' }, { text: '📖 دریافت توکن', callback_data: 'guide' }],
    [{ text: '🧪 بررسی وضعیت استقرار', callback_data: 'status' }, { text: 'ℹ️ راهنما', callback_data: 'help' }],
  ]},
  back: { inline_keyboard: [[{ text: '‹ بازگشت', callback_data: 'start' }]] },
};
const kbCancel = { inline_keyboard: [[{ text: '⬅ بازگشت به منو', callback_data: 'start' }]] };

// --- توکن ریلیو ---
function cleanToken(raw) { let t = String(raw || '').trim(); if (t.startsWith('Bearer ')) t = t.slice(7); return t.replace(/[\s"'`]/g, ''); }
function extractRailwayToken(text) {
  let m = text.match(/(token_[A-Za-z0-9\-_]{6,})/i); if (m) return cleanToken(m[1]);
  m = text.match(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/); if (m) return m[0];
  return null;
}

// --- GraphQL ریلیو ---
async function gql(token, query, variables) {
  const res = await fetch(RAILWAY_API, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token }, body: JSON.stringify({ query, variables }) });
  const txt = await res.text();
  let d; try { d = JSON.parse(txt); } catch (_) { throw new Error('پاسخ نامعتبر: ' + txt.slice(0, 120)); }
  if (d.errors && d.errors.length) throw new Error(d.errors[0].message || 'خطا در API');
  return d.data || {};
}

// --- KV helpers ---
const getK = (kv, k) => kv.get(k).then(v => v || null);
const putK = (kv, k, v) => kv.put(k, v);

// --- محدودیت نرخ ---
const hourKey = () => new Date().toISOString().slice(0, 13);
async function checkRate(kv, uid, maxPerH, maxGlobal) {
  if (!kv) return { ok: true };
  const h = hourKey(); const uK = 'rate:' + h + ':u:' + uid, gK = 'rate:' + h + ':g';
  const [u, g] = await Promise.all([getK(kv, uK).then(v => +v || 0), getK(kv, gK).then(v => +v || 0)]);
  if (u >= maxPerH) return { ok: false, msg: 'در یک ساعت بیش از ' + maxPerH + ' پنل نمی‌توانی بسازی.' };
  if (g >= maxGlobal) return { ok: false, msg: 'سهمیه‌ی بات در این ساعت پر شده.' };
  await Promise.all([kv.put(uK, String(u + 1), { expirationTtl: 3600 }), kv.put(gK, String(g + 1), { expirationTtl: 3600 })]);
  return { ok: true };
}

// ===========================================================================
//  بخشِ اصلی: ساختِ پنل روی ریلیو
// ===========================================================================
async function provision(userToken, chatId, tgToken, cf) {
  // ۰) هویت + workspace
  const me = await gql(userToken, 'query { me { id email name workspaces { id name } } }', {});
  const user = me.me || {};
  const email = user.email || user.name || 'کاربر';
  const ws = (user.workspaces && user.workspaces[0]) || {};
  const workspaceId = ws.id;

  await sendMsg(tgToken, chatId, '👤 توکن معتبر است — <code>' + email + '</code>\n⚙️ در حال ساختِ پروژه…');

  // ۱) ساخت پروژه
  const projName = 'takht-' + Math.random().toString(36).slice(2, 8);
  const pj = await gql(userToken, 'mutation($name:String!,$wid:String!){ projectCreate(input:{ name:$name, workspaceId:$wid }){ id name } }', { name: projName, wid: workspaceId });
  const projectId = pj.projectCreate && pj.projectCreate.id;
  if (!projectId) throw new Error('ساخت پروژه ناموفق بود (شاید سقف پلن رایگان پر است یا workspace نادرست).');

  // ۲) محیط production
  let envId = null;
  const envQ = await gql(userToken, 'query($p:String!){ project(id:$p){ environments{ edges{ node{ id name } } } } }', { p: projectId });
  const envs = (envQ.project && envQ.project.environments && envQ.project.environments.edges) || [];
  const eObj = envs.find(x => x.node.name === 'production') || envs[0];
  if (eObj) envId = eObj.node.id;
  else {
    const ec = await gql(userToken, 'mutation($p:String!,$n:String!){ environmentCreate(input:{ projectId:$p, name:$n }){ id name } }', { p: projectId, n: 'production' });
    envId = ec.environmentCreate && ec.environmentCreate.id;
  }
  if (!envId) throw new Error('محیط پروژه پیدا نشد.');

  await sendMsg(tgToken, chatId, '📦 پروژه ساخته شد؛ در حال اتصال به مخزن…');

  // ۳) سرویس از مخزن
  const srvName = cf.prefix + '-' + Math.random().toString(36).slice(2, 6);
  const sv = await gql(userToken, 'mutation($s:ServiceCreateInput!){ serviceCreate(input:$s){ id name } }', { s: { name: srvName, projectId, environmentId: envId, source: { repo: cf.repo }, branch: cf.branch } });
  const serviceId = sv.serviceCreate && sv.serviceCreate.id;
  if (!serviceId) throw new Error('ساخت سرویس ناموفق بود.');

  // ۴) متغیر محیطی (غیرکشنده)
  try { await gql(userToken, 'mutation($e:String!,$v:EnvironmentVariables){ variableCollectionUpsert(input:{ environmentId:$e, variables:$v }) }', { e: envId, v: { ADMIN_USER: 'admin' } }); } catch (_) {}

  // ۵) دامنه
  const dm = await gql(userToken, 'mutation($e:String!,$s:String!){ serviceDomainCreate(input:{ environmentId:$e, serviceId:$s }){ id domain } }', { e: envId, s: serviceId });
  let domain = dm.serviceDomainCreate && dm.serviceDomainCreate.domain;
  if (Array.isArray(domain)) domain = domain[0];

  // ۶) آغاز استقرار
  let deploymentId = null;
  try {
    const dep = await gql(userToken, 'mutation($s:String!,$e:String!){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e) }', { s: serviceId, e: envId });
    deploymentId = dep && dep.serviceInstanceDeployV2;
  } catch (_) {}

  return { projectId, projectName: projName, environmentId: envId, serviceId, deploymentId, domain, email, hostname: (domain || projName + '.' + cf.domSuf) };
}

// --- پولِ وضعیت استقرار ---
async function pollDeployment(userToken, deploymentId) {
  if (!deploymentId) return { status: 'UNKNOWN', detail: 'شناسه استقرار موجود نیست.' };
  try {
    const d = await gql(userToken, 'query($id:String!){ deployment(id:$id){ id status createdAt } }', { id: deploymentId });
    const dep = d.deployment || {};
    return { status: dep.status || 'UNKNOWN', createdAt: dep.createdAt };
  } catch (e) {
    return { status: 'ERROR', detail: e.message };
  }
}

// ===========================================================================
//  پردازشِ پیام‌ها و کلیک‌ها
// ===========================================================================
async function handleMessage(token, msg, envObj) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const from = msg.from; const uid = String(from ? from.id : chatId);
  const cf = cfg(envObj); const kv = envObj.KV;

  // دستورِ وضعیت (تشخیص با /status یا کلیکِ status)
  if (text === '/status' || text === '🧪 بررسی وضعیت استقرار' || text.startsWith('/status ')) {
    let depId = text.split(' ')[1] || null;
    if (!depId) depId = await getK(kv, 'dep:' + chatId);
    if (!depId) return sendMsg(token, chatId, 'هنوز استقراری ندارید. ابتدا یک توکن بفرستید.', kb.main);
    const userToken = await getK(kv, 'rtok:' + chatId);
    if (!userToken) return sendMsg(token, chatId, 'توکن ذخیره نشده؛ دوباره توکن را بفرستید.', kb.main);
    const st = await pollDeployment(userToken, depId);
    let label = { PENDING: '🕓 در صف', BUILDING: '⚙️ در حال ساخت', DEPLOYING: '🚀 در حال استقرار', SUCCEEDED: '✅ تکمیل شد', FAILED: '❌ ناموفق', CANCELLED: '⏹ لغو شد', UNKNOWN: '❓ نامشخص', ERROR: '⚠️ خطا' }[st.status] || st.status;
    return sendMsg(token, chatId, '🧪 وضعیت استقرار: <b>' + label + '</b>' + (st.detail ? '\n<code>' + st.detail + '</code>' : '') + '\n\n(پس از تکمیل، لینک پنل را از همان پیامِ ساخت بردارید یا دوباره بررسی کنید.)', kb.main);
  }

  // دانلودِ فایلِ (اختیاری) - نادیده‌گیر
  if (text === '/start' || text === '🚀 ساخته شود' || text === '🏛 شروع' || text === 'start') {
    await putK(kv, 'state:' + chatId, 'idle');
    return sendMsg(token, chatId,
      '🏛 <b>' + BOT_NAME + '</b> (v' + VERSION + ')\n\n' +
      'این ربات با گرفتنِ <b>Account Token</b> ریلیو، روی حسابِ <b>خودِ تو</b> یک پنلِ «تخت جمشید» (FastAPI) می‌سازد و لینک و QR آن را می‌دهد.\n\n' +
      '👉 <b>توکن ریلیو</b> را همین‌جا بفرست تا شروع کنیم:\n<code>token_xxxxxxxx</code> یا <code>UUID</code>', kb.main);
  }

  if (text === '📖 دریافت توکن' || text === 'guide') {
    return sendMsg(token, chatId,
      '🔑 <b>دریافت توکن ریلیو (Account Token)</b>\n\n' +
      '۱. وارد <a href="https://railway.com">railway.com</a> شو.\n' +
      '۲. از منو: <b>Settings → Tokens</b> (یا <a href="https://railway.com/account/tokens">لینک مستقیم</a>).\n' +
      '۳. <b>New Token</b>\n' +
      '۴. در «Workspace» گزینه‌ی <b>No workspace</b> (نکته‌ی کلیدی!).\n' +
      '۵. نام بگذار (مثلاً takht-saz) و Create.\n' +
      '۶. توکن (فرمت <code>UUID</code> یا <code>token_</code>) را کپی و همین‌جا بفرست.\n\n⚠️ توکن فقط یک‌بار نمایش داده می‌شود.', kb.back);
  }

  if (text === 'ℹ️ راهنما' || text === 'help') {
    return sendMsg(token, chatId,
      'ℹ️ <b>راهنما</b>\n\n• توکن ریلیو را بفرست؛ ربات پروژه/سرویس/دامنه می‌سازد و استقرار را آغاز می‌کند.\n• با «بررسی وضعیت» پیشرفت را ببین؛ پس از تکمیل، لینک و QR پنل تحویل داده می‌شود.\n• ورود پیش‌فرض پنل: <code>admin / admin123</code>\n\n🔐 هرگز توکن را جای دیگری نشر نده و پس از پایانِ کار، آن را از ریلیو باطل کن.', kb.back);
  }

  // تشخیص توکن
  const userToken = extractRailwayToken(text);
  if (userToken) {
    const rate = await checkRate(kv, uid, cf.maxPerH, cf.maxGlobal);
    if (!rate.ok) return sendMsg(token, chatId, '⛔ ' + rate.msg, kb.main);

    await sendMsg(token, chatId, '⚙️ شروعِ ساخت_… (۱ تا ۳ دقیقه)');
    try {
      const info = await provision(userToken, chatId, token, cf);
      await putK(kv, 'dep:' + chatId, info.deploymentId || 'none');
      await putK(kv, 'rtok:' + chatId, userToken);
      await putK(kv, 'host:' + chatId, info.hostname);
      const link = (info.domain ? '' : 'https://') + info.hostname;
      const qr = QR_API + encodeURIComponent(link);
      await sendMsg(token, chatId,
        '🚀 <b>پنل تو در حال ساخت است!</b>\n\n' +
        '🔗 آدرس پنل:\n<b>' + link + '</b>\n\n' +
        '⚙️ اولین استقرار ۱ تا ۵ دقیقه طول می‌کشد. پس از ساخت، این آدرس را باز کن.\n' +
        '🔑 ورود: <code>admin / admin123</code>\n\n🧪 برای پیگیری، دکمه‌ی «بررسی وضعیت استقرار» را بزن.',
        kb.main);
      try {
        const ph = await tg(token, 'sendPhoto', { chat_id: chatId, photo: qr,
          caption: '📍 QR کدِ پنل تو — اسکن کن', reply_markup: kb.main });
        if (!(ph && ph.ok)) {
          await sendMsg(token, chatId, 'QR: ' + qr, kb.main);
        }
      } catch (_) {}
    } catch (e) {
      let msg2 = e.message || 'نامشخص';
      if (/limit exceeded|upgrade/i.test(msg2)) msg2 = 'حساب ریلیوی تو به سقف ساختِ منابع رسیده (پلن رایگان). یا پلن را ارتقا بده یا از حساب/ورک‌اسپیسِ دیگری استفاده کن.';
      else if (/workspace/i.test(msg2)) msg2 = 'توکن Account (نه Project Token) و «No workspace» لازم است.';
      await sendMsg(token, chatId, '❌ <b>خطا در ساختِ پنل</b>\n\n' + msg2, kb.main);
    }
    return;
  }

  // متن ناشناخته
  return sendMsg(token, chatId,
    'متن را نفهمیدم. توکن ریلیو (<code>token_...</code> یا <code>UUID</code>) بفرست یا از منو استفاده کن.', kb.main);
}

// --- کلیکِ دکمه‌ها ---
async function handleCallback(token, cb, envObj) {
  const chatId = cb.message.chat.id;
  const mid = cb.message.message_id;
  const data = cb.data;
  if (data === 'start') { await editMsg(token, chatId, mid, 'خانه. توکن ریلیو را بفرست.', kb.main); return; }
  if (data === 'guide') { await editMsg(token, chatId, mid, '🔑 توکن را از railway.com/account/tokens بگیر (No workspace)، سپس بفرست.', kb.back); return; }
  if (data === 'help') { await editMsg(token, chatId, mid, 'ℹ️ توکن بفرست تا پنل ساخته شود؛ با «بررسی وضعیت» پیگیری کن.', kb.back); return; }
  if (data === 'status') { await handleMessage(token, { chat: { id: chatId }, text: '/status', from: cb.from }, envObj); return; }
  tg(token, 'answerCallbackQuery', { callback_query_id: cb.id });
}

// ===========================================================================
//  روتر
// ===========================================================================
async function handleRequest(request, envObj) {
  const url = new URL(request.url);
  const TELEGRAM_TOKEN = envObj.TELEGRAM_TOKEN || '';
  const WEBHOOK_SECRET = env('WEBHOOK_SECRET', 'tj', envObj);

  if (url.pathname === '/health') return json({ ok: true, name: BOT_NAME, version: VERSION });
  if (url.pathname === '/') return json({ ok: true, message: 'تخت‌ساز Railway در حال اجراست. مسیر وب‌هوک /tg/<secret>' });

  if (url.pathname === '/setup' && request.method === 'GET') {
    const r = await tg(TELEGRAM_TOKEN, 'setWebhook', { url: url.origin + '/tg/' + WEBHOOK_SECRET, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    return json({ ok: !!(r && r.ok), result: r });
  }

  if (url.pathname.startsWith('/tg/') && request.method === 'POST') {
    const supplied = url.pathname.slice(4);
    if (WEBHOOK_SECRET && supplied !== WEBHOOK_SECRET) return json({ ok: false }, 403);
    const body = await request.json().catch(() => ({}));
    if (body && body.message) await handleMessage(TELEGRAM_TOKEN, body.message, envObj);
    else if (body && body.callback_query) await handleCallback(TELEGRAM_TOKEN, body.callback_query, envObj);
    return json({ ok: true }, 200);
  }

  return json({ ok: false }, 404);
}

export default {
  async fetch(request, envObj, ctx) {
    try { return await handleRequest(request, envObj); }
    catch (e) { console.error(e); return json({ ok: false, error: String(e && e.message || e) }, 500); }
  },
};
