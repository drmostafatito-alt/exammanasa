# تقرير تحديث لوحات الفلاسفة (Philosophy Artwork Refresh)

تعديل **بصري فقط**: استبدال رسوم الفلاسفة/الأكاديميا المستخدمة كأقنعة (masks) في واجهات المنصة
بلوحات بأسلوب **Premium academic editorial engraving** (نقش تحريري أكاديمي بطابع الرخام الكلاسيكي)،
مع الإبقاء الكامل على التصميم والـlayout والـtypography وبيانات المعلم وبيانات الأسئلة/الامتحانات.

## 1) ما الذي تم استبداله

| الأصل | قبل | بعد |
|---|---|---|
| `cloudflare/public/art/socrates.svg` | رسم خطي تبسيطي (خطوط متناثرة) | تمثال رخامي منقوش (صلع + لحية كثّة + himation + قاعدة herm) |
| `cloudflare/public/art/plato.svg` | رسم خطي تبسيطي | تمثال منقوش بإكليل غار ولحية مدببة وقاعدة |
| `cloudflare/public/art/aristotle.svg` | رسم خطي تبسيطي | تمثال منقوش بلفافة برقٍ + قاعدة |
| `cloudflare/public/art/marx.svg` | رسم خطي تبسيطي | bust منقوش بمعطف وكتاب |
| `cloudflare/public/art/columns.svg` | أعمدة بخطوط بسيطة | لوحة معمارية كلاسيكية (pediment + 4 أعمدة مخدّدة + stylobate) |
| `cloudflare/public/art/open-book.svg` | كتاب بخطوط بسيطة | مخطوطة مفتوحة منقوشة بفاصلة شريطية |
| `cloudflare/public/art/logic.svg` | مخطط منطق بسيط | لوحة قياس/استلزام أنظف وأمتن |

**لم يُلمس:** `wave.svg` (فاصل وظيفي بين الأقسام وليس لوحة فيلسوف، وتُختبَر في `tests/run-all.mjs`).

## 2) أماكن الظهور في الواجهات (بلا تغيير مواضع)

- `socrates`: `.hero-media .fig-soc` (خلف بورتريه المعلم، opacity .46/.3) + `.quote-fig` (شريط الأقوال .42)
- `plato`: `.hero .fig-plato` (.14/.12/.1) + `.quote-fig`
- `marx`: `.hero .fig-marx` (.1) + `.quote-fig`
- `aristotle`: `.hero .fig-arist` (.11) + `.grade-card.philosophy .gc-art` + `footer .fa-bust`
- `open-book`: `.grade-card.psychology .gc-art` + `footer .fa-book`
- `columns`: `.hero-cols` + `footer .fa-cols`
- `logic`: `.features .feat-art`

نفس الملفات بنفس الأسماء وبنفس `viewBox` السابق حرفيًا (400×480 / 960×320 / 480×360 / 480×320)
لذلك **لم يُعدّل أي سطر CSS/JS/HTML**: نظام الأقنعة (`mask-image` بالألفا) والأحجام والـopacity والمواضع كما هي.

## 3) أسلوب الصور الجديدة

نقش تحريري أكاديمي (steel-engraving / intaglio) أحادي اللون: خطوط حبر واثقة + hatching خفيف
لنمذجة الرخام، قواعد herm، طيّات himation، إكليل غار، أعمدة دورية — مُتتبَّع إلى **متجه SVG**
(potrace) فيُعرض حادًا على أي دقة (desktop/mobile) وبلا artifacts وبلا نصوص أو watermarks.
التلاشي الشعاعي/العمودي للألفا محفوظ كما في الأصول السابقة حتى تذوب اللوحات في الخلفية
(كحلي/أزرق فاتح/كريمي/بيج/ذهبي) ولا تبدو منفصلة عن التصميم.

- المصادر (النقوش المولّدة): `tools/artwork-src/*.png`
- أداة إعادة التوليد: `tools/build-art.mjs` (أداة تطوير فقط؛ تحتاج `npm i --no-save sharp potrace`)
- اللقطات قبل/بعد: `tools/shots/before/` و`tools/shots/after/` (خارج Git وفق `.gitignore`)

## 4) صورة المعلم وبياناته: لم تتغير (NO)

- لا تعديل على `portraitHtml()`/`photo`/`photoFit`/الـcrop/الشفافية في `app.js`/`worker.js`/`admin.js` — الملفات نفسها غير معدّلة.
- صورة المعلم في الـHero بموضعها وشفافيتها، و`fig-soc` خلفها بنفس الموضع والـopacity السابقين.
- `tools/audit-assets/*` (صور المعلم) مطابقة بايتًا (sha256 -c OK).
- الاسم/التخصص/Bio/الهاتف/WhatsApp/Facebook/TikTok/ID/slug/student-link/إعدادات الملف العام: خارج نطاق التعديل تمامًا.

## 5) بيانات الأسئلة/الامتحانات: لم تتغير (NO)

- `cloudflare/src/data/banks.json` مطابق بايتًا (sha256 -c OK).
- بوابة D2 في `tools/validate-banks.mjs`: **Psychology SHA-256 = 8851437be88724537693cbf1ad57c0531e36eca4b55dcea102f7c077b44a8198 — مطابق ✓**

## 6) التحقق البصري (Chromium حقيقي + خطوط عربية مثبتة)

- Desktop: 1280×720، 1366×768، 1440×900، 1920×1080 — اللوحات واضحة ومتزنة داخل حاوياتها، لا تغطي نصًا، لا distortion.
- Mobile: 360×800، 390×844، 430×932 — لا horizontal overflow (`scrollWidth == clientWidth`)، لا كسر للـHero، وارتفاع الصفحة **مطابق رقميًا** قبل/بعد (3386 desktop / 4831-4731-4617 mobile) ⇒ لا layout shift ولا تطويل.
- الهندسة (bounding boxes للـhero/figs/quote-fig/gc-art/portrait) **مطابقة حرفيًا** قبل/بعد في كل المقاسات (`tools/shots/*/geo.json`).

## 7) الاختبارات

- `npm test` (cloudflare/tests/run-all.mjs): **335 ✓ / 0 ✗**
- `tools/validate-banks.mjs`: **ALL CHECKS PASSED ✓** (يشمل بوابة psychology SHA)
- `tools/ui-qa.mjs`: **128 ✓ / 0 ✗**
- `tools/visual-qa.mjs`: **97 ✓ / 0 ✗**
