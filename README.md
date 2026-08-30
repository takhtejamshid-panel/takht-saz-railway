<div dir="rtl">

# 🏛️ تخت‌ساز Railway | Takht-Saz Railway

**بات تلگرامیِ لانچرِ خودکارِ پنلِ «تخت جمشید» روی Railway**

کاربر **توکنِ Account ریلیو** را به ربات می‌دهد؛ ربات روی حسابِ **خودِ کاربر**
یک پنلِ FastAPI (تخت جمشید) می‌سازد و لینکِ آن را تحویل می‌دهد — **بدون هیچ سرور، روی Cloudflare Workers رایگان.**

```
کاربر ──► تلگرام ──► Workerِ ربات (روی کلودفلر)
                          │
                          ├─ query { me }               → اعتبارسنجیِ توکن
                          ├─ projectCreate              → ساختِ پروژه‌ی ریلیو
                          ├─ serviceCreate(repo)        → اتصال به پنلِ گیت‌هاب
                          └─ serviceDomainCreate        → دامنه‌ی عمومی
                          │
                          └──▶ https://takht-xxxx.up.railway.app
```

| | |
|---|---|
| 🆓 **هزینه** | ربات روی پلنِ رایگانِ کلودفلر؛ پنل از سهمیه‌ی **خودِ کاربرِ ریلیو** کم می‌شود، نه از تو |
| 🧩 **زیرساخت** | یک Worker + یک KV — همین |
| 🔒 **توکن‌ها** | توکنِ ریلیو فقط لحظه‌ای استفاده می‌شود و ذخیره نمی‌گردد |
| 🌐 **زبان** | فارسی |

---

## ✅ وضعیت استقرار (شروع‌شده)

- **نام Worker (Cloudflare):** `takht-saz-railway`
- **آدرس Worker:** `https://takht-saz-railway.amirhesamfathalian7.workers.dev`
- **بات تلگرام:** `@takhtejamshidlanuncherrbot`
- **Webhook:** تنظیم‌شده و فعال (مسیرِ `/tg/<secret>` سفارشی)
- **KV:** `KV` (Binding) با id در `wrangler.toml`

---

## ✨ امکانات

- واکنش به `/start`، `/help` و منویِ `🏛 شروع` / `📖 دریافت توکن` / `ℹ️ راهنما`
- دریافتِ توکنِ ریلیو، اعتبارسنجیِ آن (`query me`) و نمایشِ صاحبِ حساب
- ساختِ خودکار: پروژه → سرویس → دامنه → آغازِ استقرار
- تحویلِ لینکِ پنل + مشخصاتِ ورودِ پیش‌فرض
- محدودیتِ نرخِ ساده (`MAX_DEPLOYS_PER_HOUR` = ۳، `MAX_GLOBAL_PER_HOUR` = ۴۰) برای محافظت از سهمیه
- مسیرِ راهنما `/setup` برای اتصالِ خودکارِ Webhook

---

## 🎯 استفاده (برای کاربرِ نهایی)

1. با `@takhtejamshidlanuncherrbot` شروع کن (یک `/start` بزن).
2. توکنِ ریلیوی خودت (`token_...`) را بفرست.
3. ربات چند پیامِ پیشرفت می‌فرستد و در پایان لینکِ پنل را می‌دهد.
4. آدرس را باز کن؛ با `admin / admin123` وارد شو و حتماً رمز را در «تنظیمات» تغییر بده.
5. در پایان، توکنِ ریلیوی خودت را از [railway.com/account/tokens](https://railway.com/account/tokens) **باطل (revoke)** کن.

---

## 🚀 استقرار (برای توسعه‌دهنده)

```bash
npm install            # نصب wrangler
npx wrangler kv namespace create KV    # → id را در wrangler.toml بگذار
npx wrangler secret put TELEGRAM_TOKEN   # توکنِ BotFather
npx wrangler secret put WEBHOOK_SECRET   # یک رشته‌ی تصادفی (اختیاری)
npx wrangler deploy
# سپس در مرورگر:  https://<worker>.workers.dev/setup  تا Webhook وصل شود
```

---

## 🗂️ ساختار

```
takht-e-jamshid-launcher-rw/
├── _worker.js      # باتِ کامل (Webhook تلگرام + GraphQL ریلیو) — یک فایل، export default
├── wrangler.toml   # پیکربندیِ کلودفلر (name, main, KV id, vars)
├── package.json    # اسکریپت‌های dev/deploy/build
├── build.js        # بررسیِ سینتکس
└── README.md
```

---

## ⚠️ نکته‌های فنی و امنیتی

- **Workers ماژولار:** بایندینگ‌ها (توکن‌ها و KV) از طریقِ پارامترِ `env` در `fetch(request, env, ctx)` خوانده می‌شوند، نه `globalThis`.
- **توکن‌ها در هیچ فایلی ذخیره نمی‌شوند**؛ فقط در Secret های کلودفلر و از طریقِ `wrangler secret put`.
- ریپازیتوریِ پنل (`takht-e-jamshid-backend`) باید **Public** باشد تا از طریقِ API ریلیو قابلِ اتصال باشد — که هست.
- برای ساختِ سرویس در ریلیو به **Account Token** نیاز است، نه Project Token.

---

ساخته‌شده با ❤️ و الهام از پروژه‌ی `takht-e-jamshid-launcher` (نسخه‌ی کلودفلر) برای سازگاری با Railway و پنلِ FastAPI.

</div>
