# Project Worklog

---
Task ID: 0
Agent: main (Z.ai Code)
Task: ترقية المشروع من GLM-5.2 إلى GLM-5.3-Flash

Work Log:
- فحص المشروع: قالب Next.js 16 + Tailwind 4 + shadcn/ui + Prisma (SQLite) بدون أي استخدام سابق لنماذج GLM في الكود
- اختبار SDK (z-ai-web-dev-sdk): يدعم معامل `model` في chat.completions.create
- اختبار حي: نموذج `GLM-5.3-Flash` يعمل بنجاح عبر SDK (استجابة صحيحة بالعربية والإنجليزية)

Stage Summary:
- الخطة: بناء تطبيق محادثة AI كامل يستخدم GLM-5.3-Flash كنموذج افتراضي مع إبقاء GLM-5.2 كخيار قديم (legacy) لإظهار الترقية، مع streaming وحفظ المحادثات في SQLite عبر Prisma

---
Task ID: 1-7 (كامل)
Agent: main (Z.ai Code)
Task: تنفيذ ترقية المشروع إلى GLM-5.3-Flash كاملًا (واجهة + backend + تحقق بالمتصفح)

Work Log:
- Prisma: إضافة نموذجي Conversation و Message (حذف User/Post غير المستخدمين) + db:push ناجح
- src/lib/ai-config.ts: سجل نماذج مشترك — GLM-5.3-Flash (افتراضي، شارة "مُفعّل" خضراء) و GLM-5.2 (قديم، شارة "قديم" كهرمانية) + DEFAULT_MODEL
- الواجهة (src/components/chat/): chat-app (إدارة الحالة + بث NDJSON + AbortController)، model-selector، upgrade-banner (قابلة للإخفاء)، conversations-sidebar (إنشاء/فتح/حذف)، message-list (شاشة ترحيب + اقتراحات)، message-bubble (Markdown + شارات النموذج + collapsible للتفكير)، composer (إرسال/إيقاف + وضع التفكير)
- layout.tsx: lang=ar + dir=rtl + خط IBM Plex Sans Arabic + ThemeProvider (فاتح/داكن/نظام)
- Backend: POST /api/chat (بث NDJSON: meta/thinking/delta/done/error مع حفظ الرسائل حتى عند الانقطاع)، GET /api/conversations، GET/PATCH/DELETE /api/conversations/[id]
- إصلاحات: خطأ lint set-state-in-effect (rAF)، إصلاح ارتفاع التخطيط إلى h-dvh ليظهر الـ composer والتذييل دائمًا
- تحقق Agent Browser: إرسال رسالة → بث حي → حفظ؛ سياق متعدد الأدوار (فهم الضمائر)؛ تبديل النموذج 5.3↔5.2 مع شارات صحيحة؛ فتح/حذف محادثة؛ موبايل 390px (Sheet جانبي)؛ وضع داكن؛ وضع التفكير؛ footer ثابت أسفله؛ لا أخطاء console حرجة
- تنظيف: حذف بيانات الاختبار من DB + lint نظيف + dev.log سليم

Stage Summary:
- المشروع مُرقّى بنجاح من GLM-5.2 إلى GLM-5.3-Flash: تطبيق محادثة عربي RTL كامل بالبث المباشر، حفظ المحادثات، محدد نماذج يوضح الترقية (5.2 قديم ← 5.3-Flash الحالي)، دعم وضع التفكير، وضع داكن، وتصميم متجاوب — تم التحقق من كل المسارات الذهبية بالمتصفح

---
Task ID: 8
Agent: main (Z.ai Code)
Task: ترقية مشروع IFRS المرفوع (نظام مطابقة قوائم الحسابات وفق IFRS) من GLM-5.2 إلى GLM-5.3-Flash

Work Log:
- استخراج الأرشيف المرفوع workspace-0062213b...tar إلى /tmp/uploaded-projects والتحقق: مشروع "نظام مطابقة قوائم الحسابات وفق IFRS" (Next.js 16 + Prisma + NextAuth) بدون أي تكامل AI سابق
- نسخ احتياطي لتطبيق المحادثة السابق في /home/z/backup-chatapp-glm/
- ترحيل المشروع إلى /home/z/my-project: (src, public, prisma, db/custom.db, package.json, bun.lock, .env, README, CHANGELOG, LICENSE) + أرشفة worklog الأصلي في worklog-archive-ifrs.md
- bun install (أضاف bcryptjs, jszip, xlsx-js-style) + db:generate + db:push + إعادة تشغيل الخادم
- التحقق بالمتصفح من عمل المشروع بعد الترحيل (الصفحة الرئيسية، الملفات، المطابقة)
- الترقية الفعلية:
  * src/lib/ai-config.ts: سجل النماذج (GLM-5.3-Flash الحالي، GLM-5.2 قديم)
  * POST /api/ai/analyze: بث NDJSON (meta/delta/done/error) بنموذج GLM-5.3-Flash + تنقية المدخلات + prompt محلل مالي CFA بالعربية
  * src/components/accounts/ai-analysis-panel.tsx: لوحة "التحليل الذكي المعزّز" مع شارة GLM-5.3-Flash وشارة "ترقية من GLM-5.2"، بث مباشر، إيقاف، إعادة توليد، نسخ
  * الدمج في financial-analysis.tsx بعد شريط التنبيهات
- توليد 4 ملفات Excel اختبارية (ميزانا مراجعة + قائمتا مركز مالي) في tests/gen-test-files.ts واختبار التدفق الكامل بالمتصفح: رفع → مطابقة → تبويب التحليل → توليد التحليل الذكي → نتيجة دقيقة بأرقام حقيقية (CCC=87.19 يوم، دوران المخزون 3.3×)
- تحقق إضافي: الوضع الداكن، موبايل 390px، lint نظيف، dev.log سليم
- توثيق الترقية في CHANGELOG.md و README.md

Stage Summary:
- المشروع المرفوع أصبح هو المشروع النشط في مساحة العمل، وتمت ترقيته فعلياً من GLM-5.2 إلى GLM-5.3-Flash عبر ميزة "التحليل الذكي المعزّز" مع بث مباشر — تم التحقق من التدفق الكامل بالمتصفح ببيانات مالية واقعية

---
Task ID: 9
Agent: main (Z.ai Code)
Task: (1) إصلاح عدم استعادة «حساب صافي الإيرادات» عند فتح الملفات المحفوظة، (2) إضافة البحث عن الحساب في قائمة المركز المالي، (3) إعادة تسمية «جدول المقارنة» إلى «قائمة الربح والخسارة والدخل الشامل الآخر»

Work Log:
- فحص الصورة المرفوعة: تطبيق القوائم المالية (React على / + نسخة HTML مستقلة على /قائمة-الربح-IFRS.html)
- اكتشاف 3 جذور جذرية لخلل الحفظ/الفتح:
  * الجذر 1 (الأخطر): غياب NEXTAUTH_SECRET في .env — next-auth v4 يعتمد hash(JSON.stringify(options)) كسر افتراضي، بينما getServerSession يستبدل providers:[] فيتولد مفتاح مختلف عن مسار /api/auth/* → فشل فك تشفير JWT → كل مسارات /api/reports و /api/users و /api/groups ترجع 401 (تأكيد بالمتصفح ثم بالإصلاح). أضفت NEXTAUTH_SECRET عشوائي + NEXTAUTH_URL في .env وأعدت تشغيل الخادم → GET /api/reports أصبح 200
  * الجذر 2: reExtract() كانت تعيد [] للملفات المستعادة من DB لأن rawRows=[] وأصبحت تُعيد file.A كما هي عند غياب rawRows (src/lib/accounts.ts) — كان هذا يفرّغ baseOptions فيُصفَّر الحساب الأساسي عبر التأثير التلقائي، ويكسر إعادة المطابقة بعد الفتح (0 حساب)
  * الجذر 3: الواجهة ترسل bsFile1Data/bsFile1Headers/bsFile1Cols بينما الخادم يقرأ body.bsFileData → بيانات ملف المركز المالي تُسقط صامتاً عند الحفظ. وحّدت القراءة في POST/PUT /api/reports لقبول التسميتين
- البحث عن الحساب في قائمة المركز المالي:
  * BsPrefixSelect: زر قائمة منسدلة (ScanSearch) مع بحث عربي مطبَّع + بحث برقم، قائمة الحسابات الرئيسية، إضافة chips متعددة دون إغلاق، إزالة datalist الأصلي (src/components/accounts/bs-prefix-select.tsx)
  * AccountSelect جديد قابل للبحث لحساب صافي الإيرادات (Popover + بحث + أرقام حسابات + Check) — src/components/accounts/account-select.tsx، مع تصدير filterAccounts وإضافة num إلى BaseOption في accounts.ts
  * النسخة HTML: حقل بحث bsSearch في شريط تبويب قائمة المركز المالي يرشّح صفوف الجدول ويحدّث العدّاد
- إعادة التسمية: تبويب React (page.tsx) و HTML (1144) من «جدول المقارنة» إلى «قائمة الربح والخسارة والدخل الشامل الآخر» + document.title وملف CSV في HTML + TabsList flex-wrap للالتفاف على الموبايل
- تحقق متصفح كامل (Agent Browser): رفع 3 ملفات → اختيار «إيرادات أخرى» كحساب أساس عبر البحث → إضافة chips عبر البحث → مطابقة (26 صف) → حفظ → reload → فتح التقرير → استعادة كل شيء: الحساب الأساسي «إيرادات أخرى» ✓، ملفات 6+6 حساب ✓، مركز مالي 14 حساب ✓ مع شارة «✓ مُفعّل» ✓، chip «11· الأصول المتداولة» ✓، إعادة المطابقة والتحليل المالي يعملان ✓
- تحقق النسخة HTML: تسجيل دخول، رفع ملفات برمجياً، المطابقة، التبويب المُعاد تسميته، بحث «الموردون» في العرض الخام رشّح للصف 2101 فقط ✓
- موبايل 390px + وضع داكن سليمان، lint نظيف، حذف 6 تقارير اختبار من DB، تحديث CHANGELOG.md

Stage Summary:
- الدورة الكاملة حفظ→فتح أصبحت تعمل فعلياً لأول مرة في تطبيق React (كانت معطلة بالكامل بسبب 401 + إفراغ البيانات + إسقاط بيانات المركز المالي). الحساب الأساسي وملفات القائمتين وإعدادات البادئات تُستعاد بالكامل، مع بحث جديد عن الحسابات في قائمة المركز المالي في النسختين، والتبويب يحمل الاسم الجديد
- ملاحظة للمستخدم: بسبب إضافة NEXTAUTH_SECRET يجب تسجيل الدخول من جديد مرة واحدة (الجلسات القديمة ألغيت)

---
Task ID: 10
Agent: main (Z.ai Code)
Task: (1) إصلاح «صافي ايرادات المبيعات غير متاح» عند عرض قائمة المركز المالي وفق طريقة العرض ومقارنتها مع صافي المبيعات، (2) إضافة طريقة عرض «البنود ومساهمتها في صافي الربح»، (3) إعادة تسمية «مقارنتها مع صافي المبيعات» إلى «البنود ومساهمتها في صافي المبيعات»

Work Log:
- تتبع جذر المشكلة: طريقة العرض ③ «البنود ومساهمتها في صافي المبيعات» (renderBSRevenue) تعتمد على S.T.rev1/rev2 التي تُحسب في calc() من S.baseRow، وS.baseRow تُشتق في categorize() من S.base — لذا عند فتح تقرير محفوظ دون استعادة الحساب الأساس أو عدم اختياره تكون القيم صفراً فتظهر شاشة «غير متاح»
- اكتشاف أن الجلسة السابقة (انقطعت) نفّذت معظم الأساس: حفظ base:S.base في التقرير، استعادة الحساب الأساس عبر fillBase() + إعادة تطبيق الاختيار المحفوظ قبل render()، إضافة الخيارين ③④ لقائمة bsViewSel، دالة renderBSRevenue مربوطة، ودالة renderBSProfit كُتبت لكنها لم تكن مربوطة بالموزّع
- الإصلاح الأساسي لهذه الجلسة: إضافة فرع view==='profit' إلى موزّع renderBalanceSheet لربط renderBSProfit (كان اختيار ④ يعرض العرض القياسي خفيةً)
- توليد ملفات اختبار جديدة tests/gen-bs-contribution-test-files.ts: ميزانا مراجعة بحساب أساس «صافي ايرادات المبيعات» (4100) بقيم محسوبة مسبقاً (rev 1,000,000/1,200,000، net 100,000/218,000) + قائمتا مركز مالي (قيم متطابقة التوازن)
- تحقق متصفح كامل (Agent Browser) على النسخة HTML المستقلة:
  * رفع 4 ملفات → الاختيار التلقائي للحساب الأساس «صافي ايرادات المبيعات» عمل ✓
  * المطابقة → S.T صحيحة تماماً (rev1/rev2/net1/net2 مطابقة للقيم المحسوبة يدوياً) ✓
  * طريقة العرض ③: صف مرجعي 100% + 14 بنداً بنسب صحيحة (النقدية 12.00%→12.50% = +0.50p.p) ✓
  * طريقة العرض ④ (المربوطة حديثاً): صف صافي الربح 100% + نسب صحيحة (إجمالي الأصول 800%→412.84%) ✓
  * الحفظ → إعادة تحميل الصفحة → فتح التقرير → rev/net مستعادة بالكامل والطريقتان ③④ تعرضان البيانات فوراً دون «غير متاح» ✓
  * محاكاة عدم اختيار الحساب الأساس: شاشة إرشادية واضحة «صافي المبيعات غير متاح + كيفية التفعيل» ✓ (وطريقة ④ تعمل حتى بدونه لأنها تعتمد صافي الربح فقط — سلوك صحيح)
  * العرضان ①② سليمان، البحث في الجدول يرشّح ضمن الطريقة ③، تصدير CSV وزر PDF دون أخطاء ✓
- تحقق انحداري لتطبيق React: رفع الملفين → اختيار الأساس تلقائياً → مطابقة → صافي الإيرادات 1,200,000/1,000,000 وصافي الربح 218,000/100,000 في الجدول، التبويب باسم «قائمة الربح والخسارة والدخل الشامل الآخر» ✓
- lint نظيف، dev.log بلا أخطاء، قاعدة البيانات بلا بيانات اختبار متبقية
- تحديث CHANGELOG.md ببنود Fixed/Added/Changed الجديدة

Stage Summary:
- دورة كاملة تعمل الآن: رفع → مطابقة → عرض المركز المالي وفق الطرق الأربع (① IAS 1، ② كما في الإكسل، ③ البنود ومساهمتها في صافي المبيعات — المُعاد تسميتها، ④ البنود ومساهمتها في صافي الربح — الجديدة والمربوطة) مع استعادة صحيحة للحساب الأساس عند فتح التقارير المحفوظة، ما يقضي على رسالة «صافي ايرادات المبيعات غير متاح» في سيناريو المستخدم

---
Task ID: 11
Agent: main (Z.ai Code)
Task: تطوير وتحسين «تقرير الرسوم البياني» في تبويب الرسوم (تطبيق React) ليصبح تقريراً مالياً ديناميكياً بمحدد نوع تقرير (5 خيارات) ورسوم ومؤشرات وتنبيهات مشتقة من البيانات الحقيقية

Work Log:
- استكشاف: تبويب charts في page.tsx كان يعرض ChartsView (4 رسوم فقط لقائمة الدخل) دون بيانات المركز المالي أو النسب؛ حددت مصادر البيانات الفعلية: T (Totals) وcat (Categorized) وbsTotals1/2 (BalanceSheetTotals) وratioGroups (computeRatios) — كلها محسوبة فعلياً في page.tsx
- طبقة البيانات (جديد src/lib/chart-data.ts): buildReportData({T, cat, L1, L2, bs1, bs2, ratioGroups}) تُنتج 4 مجموعات منفصلة عن العرض:
  * pl: 5 بطاقات KPI (مع deltas) + اتجاه زمني (مصروفات مكدسة + إيراد/صافي) + movers (أوراق كل الفئات بما فيها الضريبة مع favorable/unfavorable) + تنبيهات (خسارة، تراجع هامش ≥5 ن.م، تغير غير اعتيادي ±25% وأثر ≥2% من الإيراد)
  * bs: 4 KPI + هيكل أصول/تمويل (donut) + مقارنة مكونات + عناصر تفصيلية + تنبيهات (توازن المعادلة المحاسبية بتفسيرها، حقوق ملكية/رأس مال عامل سالب، رفع مالي >70%)
  * fa: 4 KPI (تداول/سريعة من ratioGroups، هامش وROE) + اتجاهات الهوامش من T مباشرة (تعمل حتى دون مركز مالي) + مجموعات النسب مقسمة حسب وحدة القياس (مضاعفات/نسب/مبالغ/أيام) + استبعاد Defensive Interval المكرر + تنبيهات معايير قياسية (تداول<1، تغطية فوائد<1، D/E>2، CCC>90...)
  * combined: ROA/ROE/دوران/مضاعف + تحليل دوپونت (3 مخططات مصغرة) + مؤشرات متقاطعة من القائمتين
- طبقة العرض (إعادة بناء charts-view.tsx ~1100 سطر): محدد نوع التقرير (Select بـ5 خيارات) يبدّل الأقسام فوراً بحالة React دون reload؛ أنواع الرسوم: KPI Cards، Bar (رأسي/أفقي مجمّع)، Pie/Donut (tooltip بنسبة %)، Line (هوامش)، Area مكدس (اتجاه الأداء) عبر ComposedChart — كلها ChartContainer مع Tooltips/Legends عربية وfmtAmount/fmtRatio وXAxis reversed لاتجاه زمني RTL
- معالجة الحالات: EmptyCard للأقسام غير المتاحة (بدون مركز مالي) و«لا توجد بنود تفصيلية» و«لا توجد تغيرات»، إخفاء السلاسل الصفرية تماماً، "—" للقيم المفقودة في KPI مع الحفاظ على الهوامش من قائمة الدخل
- page.tsx: تمرير bs1/bs2 (مع منطق monthCumulative المطابق لتبويب التحليل) وratioGroups إلى ChartsView + تسمية التبويب «تقرير الرسوم البياني»
- إصلاحان أثناء التحقق: (1) دقة pctDelta والهوامش r2→r4 لمنع تقريب 12.5% إلى 13.0%، (2) تقسيم مجموعات النسب حسب الوحدة بعد رصد خلط رأس المال العامل (مبلغ) مع المضاعفات في محور واحد — كان يجعل أعمدة النسب غير مرئية
- تحقق متصفح كامل (Agent Browser) بملفات gen-test-files.ts (ميزان مراجعة + مركزان ماليان 2024/2025):
  * pl: KPIs صحيحة يدوياً (1.2م +20%، مجمل 540ألف +35%، تشغيلي 285ألف +67.7%، صافي +90%، هامش 23.8% +8.8ن.م) ✓ تنبيه «لا تنبيهات» ✓ movers صحيحة (تمويل -25% مرغوب أخضر، تكلفة +10% غير مرغوب أحمر) ✓
  * bs: KPIs (900ألف +12.5%، خصوم 500ألف -3.9%، حقوق 400ألف +42.9%، رأس عامل 300ألف +36.4%) ✓ توازن المعادلة ✓ الدونات والمقارنات ✓
  * fa: تداول 2.00× +0.27، سريعة 1.33×، ROE 71% ✓ تنبيه «سيولة مريحة» ✓ رسم الهوامش ✓ مجموعات النسب بمحاور نظيفة بعد التقسيم ✓
  * combined: ROA 32%، دوران 1.33× +0.08، مضاعف 2.25× -0.61 ✓ دوپونت متسق (0.2375×1.333×2.25=71.25%) ✓
  * all: الأقسام الأربعة كلها بعناوينها (صفحة 10239px) ✓
  * بدون مركز مالي: BS/combined تعرضان EmptyCard إرشادية وFA تعرض الهوامش مع "—" للنسب المفقودة وتنبيه إرشادي ✓
  * موبايل 390px (KPIs عمودين، رسوم متجاوبة) ✓ وضع داكن عبر زر الثيم ✓
- تحقق انحداري: تبويبا الجدول والتحليل المالي يعملان كما هما، SummaryCards سليمة، lint نظيف، dev.log بلا أخطاء، console المتصفح نظيف
- تحديث CHANGELOG.md

Stage Summary:
- تقرير الرسوم البياني أصبح تقريراً مالياً ديناميكياً كامل الأركان: 5 أنواع تقارير تتبدل فوراً، بيانات 100% حقيقية من نتائج المطابقة (لا بيانات وهمية)، فصل كامل بين chart-data.ts (المنطق) وcharts-view.tsx (العرض)، تغطية كل مطلوبات المستخدم (KPIs، هوامش، أصول/خصوم/حقوق ملكية، سيولة/مديونية/ربحية/كفاءة، مقارنة فترتين، اتجاهات زمنية، أفضل/أسوأ عناصر، تنبيهات مرئية) مع حماية من المحاور المضللة (تقسيم بالوحدات، استبعاد النسبة المكررة، إخفاء الصفريات)

---
Task ID: 12
Agent: main (Z.ai Code)
Task: «حدث HTML واخراجه» — تحديث النسخة HTML المستقلة (قائمة-الربح-IFRS.html) لتقرير الرسوم البياني الديناميكي (مواكبة تقرير React من المهمة 11) مع إضافة الإخراج/التصدير (PDF/CSV/PNG)

Work Log:
- استكشاف: النسخة HTML (6955 سطراً قبل التعديل) كان بها تبويب رسوم قديم (6 رسوم قائمة الدخل فقط، دون KPIs/تنبيهات/مركز مالي/نسب)؛ حددت مصادر البيانات الفعلية: S.T (calc)، S.cat (categorize)، S.bsTotals1/2 (categorizeBs)، ومعادلات النسب داخل renderAnalysis — واكتشفت أن زر PDF القديم للرسوم كان معطلاً فعلياً (قواعد الطباعة تُظهر #analysisContainer فقط)
- CSS (~90 سطراً): نظام cr-* كامل — بطاقات KPI بستة tones مع وضع داكن (html.dark وليس data-theme — اكتشاف وتصحيح 24 موضعاً)، شارات تغير (نسبة/نقاط مئوية/مضاعف)، شبكة تنبيهات بأربع خطورات، لوحة movers، بطاقات DuPont، رقائق المعايير، بطاقات فراغ — وقواعد طباعة جديدة body.print-charts تُظهر #chartsGrid وحده
- HTML: استبدال شريط الأدوات القديم (نوع الرسم/النطاق/الفترة/الحد الأدنى/تطبيق/تحديث) بمحدد نوع التقرير crTypeSel (5 خيارات) + شارة «ديناميكي» + أزرار PDF/CSV/PNG
- طبقة البيانات (منقولة من chart-data.ts بنفس الحدود والصيغ): crPctDelta/crR4 بمنازل 4، collectChartMovers عبر leafItems باتجاهات مدين/دائن، buildChartReportData → pl/bs/fa/combined، computeChartRatioGroups بنفس معادلات renderAnalysis مع تحسين: حساب CCC الفعلي (DIO+DSO−DPO) الذي كان يظهر «—» في تبويب التحليل، وتقسيم مجموعات النسب حسب الوحدة مع استبعاد Defensive Interval
- طبقة العرض renderChartReport: 4 أقسام (pl/bs/fa/pl_bs) + «الكل» بعناوين أقسام؛ رسوم Chart.js: اتجاه الأداء (أعمدة مكدسة + خطا إيراد/صافي مع scales.x.reverse لـ RTL)، مقارنة المؤشرات، دونات المصروفات/الأصول/التمويل (tooltip بنسبة %)، ترتيب التغيرات Top15 ملون مرغوب/غير مرغوب، تفصيلات أفقية، هوامش Line، مجموعات النسب بارتفاعات ديناميكية، دوپونت مصغر، مؤشرات متقاطعة — إصلاح خطأين أثناء التطوير: مراجع T/cat غير المعرفة، وإغلاق var داخل حلقات (grp/d في callbacks) بعزلها في دوال ratioGroupCard/dupontCard
- التصدير: exportChartReportCSV (مؤشرات/تنبيهات/movers/نسب/دوپونت/متقاطعة حسب النوع المختار، BOM + اقتباس CSV)، PDF عبر window.print مع body.print-charts + إعادة تسمية الملف، PNG عبر exportChartsAsPNG الموجودة (تعمل على #chartsGrid canvas)
- الربط: render() وتبديل التبويب يستدعيان renderChartReport()، مستمع change للمحدد يعيد الرسم فوراً دون reload، حذف chartApplyBtn/chartsRefreshBtn القديمين
- إصلاح جذرية مكتشفة أثناء التحقق: المؤشرات المتقاطعة (combined.cross) كانت تقرأ v2 من useBs1 بدل useBs2 فأظهرت قيم الفترتين متطابقة — صُححت (الأصول/حقوق/رأس العامل)
- تحقق متصفح كامل (Agent Browser) بملفات gen-test-files.ts (فترة 2024 مقارنة + 2025 حالية + مركزا مالي):
  * pl: KPIs صحيحة يدوياً (1,000,000 −16.7% · 400,000 −25.9% · 170,000 −40.4% · 150,000 −47.4% · هامش 15.0% −8.8 ن.م) ✓ تنبيه «تراجع الربحية التشغيلية 6.7 ن.م» ✓ movers ملونة ✓ دونات/ترتيب/تفصيلات ✓
  * bs: 900,000 +12.5% · 500,000 −3.9% · 400,000 +42.9% · 300,000 +36.4% (مطابقة قيم المهمة 11 المرجعية) ✓ «المعادلة المحاسبية متوازنة» ✓ دونات ومقارنات ✓
  * fa: تداول 1.73× · سريعة 1.13× · ROE 54% ✓ 7 مجموعات نسب بمحاور نظيفة + رقائق معايير ✓
  * pl_bs: ROA 17% · ROE 38% · دوران 1.11× · مضاعف 2.25× ✓ دوپونت متسق (0.15×1.25×2.86≈53.6%≈ROE) ✓ المؤشرات المتقاطعة بعد الإصلاح: أصول 800→900ألف ✓
  * all: 4 أقسام · 17 KPI · 22 رسماً ✓ تبديل الأنواع الخمسة متتالياً دون أي استثناء ✓
  * بدون مركز مالي: bs «غير متاحة» إرشادية، fa تعرض الهوامش مع «—» وتنبيه إرشادي، pl_bs «غير متاح» ✓
  * CSV: التقاط المحتوى وتحقق منه (BOM، أقسام كاملة، قيم خام للإكسل) ✓ PNG دون أخطاء ✓ قاعدة طباعة print-charts موجودة ✓
  * وضع داكن (KPI tones/تنبيهات/محاور) ✓ موبايل 390px (KPI عمودين، رسوم بعرض كامل، RTL معكوس للمحور الزمني) ✓
  * وضع monthCumulative يعمل (bs2=S.bsTotals1 مطابقةً لـ React) ✓
  * انحدارية: جدول 25 صفاً ✓ تحليل مالي ✓ مركز مالي ✓ lint نظيف ✓ لا أخطاء console بعد الإصلاحات ✓
- تحديث CHANGELOG.md (Added: النسخة HTML + التصدير)

Stage Summary:
- النسخة HTML المستقلة أصبحت مواكبة تماماً لتقرير الرسوم البياني الديناميكي في تطبيق React: 5 أنواع تقارير تتبدل فوراً دون reload، KPIs وتنبيهات ورسوم مشتقة حصراً من بيانات المطابقة الحقيقية (مع حساب CCC الفعلي لأول مرة)، وثلاث قنوات إخراج: PDF بطباعة معزولة نظيفة (كانت معطلة كلياً)، CSV شامل جديد، وPNG لكل رسم — بالإضافة لإصلاح خلل حقيقي في قيم المؤشرات المتقاطعة (v2 من الفترة الخطأ)

---
Task ID: 13 (Phase 0 — التأسيس)
Agent: main (Z.ai Code)
Task: المرحلة 0 من خطة التحويل إلى نظام متعدد المستخدمين: نسخة أساس + WAL + حماية الصفحات (proxy) — وفق موافقة المستخدم وتعديلاته العشرة (بدون أي تعديل في accounts.ts أو منطق المطابقة)

Work Log:
- تقرير تحليل كامل للمشروع قبل التنفيذ: النظام Web كليًا بالفعل (Next.js 16 + NextAuth + Prisma/SQLite)، متطلبات مفقودة: Audit Trail، دورة اعتماد، قفل تفاؤلي، Backup/Restore — وافق المستخدم على الخطة مع تعديلاته
- Baseline: فحص integrity_check (ok) → نسخة قاعدة عبر VACUUM INTO (سليمة، integrity ok) → /home/z/backups/ifrs-db-baseline-phase0-20260919-184719.db + أرشيف كود كامل ifrs-src-baseline-phase0-*.tar.gz + وسم git phase0-baseline على e3ccf1d (شجرة نظيفة)
- WAL: PRAGMA journal_mode=delete → wal بنجاح (لاحظ: wal_checkpoint(TRUNCATE) الفوري اصطدم بقفل Prisma المتصل — متوقع؛ فُحصت الاستمرارية من اتصال جديد = wal، وPrisma يقرأ/يكتب طبيعي بعدها). ملاحظة لمرحلة Backup: النسخ يجب أن يستخدم VACUUM INTO أو checkpoint قبل النسخ
- حماية الصفحات: Next 16 يدعم middleware وproxy معًا (constants.js: MIDDLEWARE_FILENAME='middleware' + PROXY_FILENAME='proxy') — اعتمدت src/proxy.ts (الاصطلاح الجديد) مع getToken من next-auth/jwt: / تتطلب جلسة، /admin تتطلب role=admin، /login و /api غير معترضة. curl: / و/admin → 307 إلى /login للزائر
- مستخدمو اختبار مؤقتان (tadmin/tuser) أُدخلوا مباشرة بـ bcrypt (صيغة DateTime في DB: epoch ms) ثم حُذفا بعد الاختبار — DB عادت لمستخدم واحد (admin)
- تحقق متصفح كامل (Agent Browser): زائر → / و/admin يعادان لـ /login ✓؛ دخول tadmin → الصفحة الرئيسية تعمل عبر proxy (dev.log يُظهر "proxy.ts" في سطر GET) ✓؛ /admin تحمل لوحة التحكم (3 مستخدمين/2 مدراء) ✓؛ تسجيل خروج → /login ✓؛ دخول tuser (عادي) → الرئيسية تعمل ولا يرى رابط المستخدمين ✓؛ فتح /admin → إعادة توجيه تلقائية إلى / ✓؛ لا أخطاء console؛ /api/users و/api/reports بلا جلسة → 401 ✓
- lint نظيف، dev.log سليم (خطأ JWT_SESSION_ERROR الوحيد قديم — سطر 12 قبل العمل، من مشكلة الكوكيز الموثقة في المهمة 9)
- تحديث CHANGELOG.md (بنود المرحلة 0) — لا Prisma Migration (لا تغيير schema في هذه المرحلة)

Stage Summary:
- المرحلة 0 مكتملة ومُتحقق منها بالمتصفح: قاعدة SQLite بوضع WAL مستمر، حماية دخول على / وحماية admin-only على /admin عبر src/proxy.ts، نسخة أساس موسومة في git + نسخ DB/كود في /home/z/backups. صفر تغيير على محرك المطابقة والوظائف. بانتظار موافقة المستخدم على بدء المرحلة 1 (Audit Trail: نموذج AuditLog + تسجيل في كل API مُعدِّل + عارض في /admin)

---
Task ID: 14 (Phase 1 — Audit Trail)
Agent: main (Z.ai Code)
Task: المرحلة 1 — سجل تدقيق رقابي Append-Only وفق ضوابط المستخدم الاثني عشر (بدون أي تعديل في accounts.ts أو منطق المطابقة، وبدون بدء Optimistic Locking/Workflow/Backup/Polling)

Work Log:
- Prisma: نموذج AuditLog (userId nullable، username snapshot، action كود ثابت، entityType/entityId، description، beforeData/afterData/metadata JSON، ipAddress، createdAt) + 5 فهارس (createdAt/userId/action/entityType/entityId) + بلا FK عمدًا (يبقى السجل بعد حذف المستخدم + توافق PostgreSQL) — db push إضافي صرف دون أي فقد بيانات
- src/lib/audit-actions.ts (نقي/آمن للعميل): 15 كود عملية (REPORT/GROUP/USER CRUD، USER_DISABLED/ENABLED، ROLE_CHANGED، PERMISSIONS_CHANGED، LOGIN_SUCCEEDED/FAILED) + تسميات عربية + أولوية اختيار الكود عند تعدد التغييرات — لا أكواد لوظائف لم تُبنَ (Workflow/Backup لاحقًا)
- src/lib/audit.ts (خادم فقط): sanitize مركزي إلزامي (حجب مفاتيح password/secret/token/session/authorization/cookie/credential/apikey للقيم النصية والتركيبية، احترام الأعلام المنطقية مثل passwordChanged:true، اقتطاع نصوص >2000 حرف ومصفوفات >50 وJSON >120KB)، serializeAuditField، getClientIp (X-Forwarded-For/X-Real-IP)، writeAudit(tx اختياري للذرية)، writeAuditSafe (لأحداث المصادقة — لا تعطل الدخول أبدًا)، diffReportForAudit (diff حقول قياسية + إشارات تغير الكتل بأحجامها دون محتواها)، reportBlobSizes
- ربط التسجيل بمعاملات ذرية: reports POST/PUT/DELETE (REPORT_CREATED/UPDATED/DELETED — PUT يسجل الحقول المتغيرة فقط ولا يسجل عند لا تغيير)، groups POST/PUT/DELETE (مع عدد التقارير المفكوكة)، users POST + [id] PUT/DELETE (اختيار الكود: PERMISSIONS_CHANGED > ROLE_CHANGED > USER_DISABLED/ENABLED > USER_UPDATED + passwordChanged في metadata دون أي سر)، setup POST (USER_CREATED نظامي بلا جلسة)، auth.ts authorize (LOGIN_SUCCEEDED/FAILED مع سبب الفشل وIP — writeAuditSafe)
- قراءة: GET /api/audit (requireAdmin، فلاتر userId/action/entityType/entityId/q/from-to بحدود أيام UTC، pagination خادم كامل 20/50/100، count+find متوازيان) — GET /api/audit/export (نفس الفلاتر، CSV + BOM + اقتباس RFC4180 + حد 5000 + ترتيب تصاعدي + ISO-UTC) — لا وجود لأي PUT/DELETE للسجل إطلاقًا
- واجهة: src/components/admin/audit-trail.tsx (فلاتر فورية للقوائم والتواريخ + تصفية للنصوص بـ draft/applied، جدول max-h مع scroll-thin، شارات ملونة حسب نوع العملية، وقت محلي + ISO-UTC معًا، حوار تفاصيل بمعلومات كاملة وJSON منسق dir=ltr، pagination، تصدير CSV) — دمجها بتبويبين في admin/page.tsx (المستخدمون | سجل التدقيق) مع تغيير العنوان إلى «لوحة الإدارة»
- إصلاحان أثناء التطوير: (1) إعادة تشغيل dev server بعد db push لتحميل عميل Prisma الجديد (كانت auditLog undefined)، (2) خاصية username المستقلة في AuditInput لأحداث الدخول الفاشلة (كانت خاصية زائدة تُهمل — كشفها فحص tsc)
- إصلاحان مكتشفان بالاختبار: (1) false positive في Sanitizer كان يحجب passwordChanged (علم منطقي) — حسّنت القاعدة: الحجب للقيم النصية/التركيبية فقط، (2) [خلل قديم مسبق كشفه السجل] PUT /api/users/[id] كان يعيد بناء الصلاحيات من الافتراضي عند غيابها في الطلب فيمسح التخصيصات عند تبديل التفعيل — أصلح بحفظ الصلاحيات المحفوظة + عدم وراثة صلاحيات المدير عند التخفيض إلى user
- تحقق متصفح شامل (Agent Browser): دخول خاطئ → LOGIN_FAILED (username snapshot بعد الإصلاح، سبب bad_password، IP ::1) ✓ دخول ناجح → LOGIN_SUCCEEDED ✓ رفع 2 ملف + مطابقة + حفظ → REPORT_CREATED بـ blobSizes (260 حرف metadata) ✓ تعديل عبر PUT → REPORT_UPDATED قبل/بعد لـ name/label1/label2 + الكتل كحقول متغيرة دون محتواها ✓ دورة مجموعة كاملة (إنشاء/تعديل/حذف) ✓ إنشاء tuser3 من الواجهة → USER_DISABLED → PERMISSIONS_CHANGED (before/after للصلاحيات) → تفعيل → حذف ✓ تبويب السجل: 25 صفًا/صفحتين، فلتر LOGIN_FAILED=1 نتيجة، بحث الوصف، حوار التفاصيل كامل، pagination ✓
- تحقق الحماية: المستخدم العادي → GET /api/audit و/export = 403 + /admin يُعاد للرئيسية بـ proxy ✓ زائر = 401 ✓
- فحص التسريبات: مسح كل حقول 15 صفًا بحثًا عن كلمات مرور الاختبار الثلاث + $2a$ (bcrypt) + eyJ (JWT) = صفر تسريبات ✓ تصدير CSV: HTTP 200 + BOM (EF BB BF) + فلاتر مطبقة + 401 للزائر ✓
- فحص tsc: ملفات المرحلة كلها نظيفة (الأخطاء الظاهرة كلها في بقايا chat/examples/skills القديمة) + lint نظيف + dev.log بلا أخطاء
- تنظيف كامل: حذف صفوف السجل التجريبية والمستخدمين المؤقتين والتقرير والمجموعة التجريبية (users=1, reports=0, groups=0, audit=0) + integrity_check ok + حذف سكربت الاختبار

Stage Summary:
- سجل تدقيق رقابي كامل Append-Only يعمل: كل العمليات الحالية تُسجل بذرية (معاملة واحدة مع التعديل)، Sanitize مركزي قبل أي كتابة (صفر تسريبات مثبت بالمسح)، قراءة/تصدير للمدير فقط مع فلاتر وpagination، وواجهة تبويب عربية RTL كاملة — كشف السجل أثناء الاختبار خللًا قديمًا حقيقيًا في مسح الصلاحيات أُصلح أيضًا. بانتظار موافقة المستخدم على المرحلة 2 (Optimistic Locking لحقل version على Report + حوار التعارض 409)

---
Task ID: 15 (Phase 2 — Optimistic Locking)
Agent: main (Z.ai Code)
Task: المرحلة 2 — القفل التفاؤلي (Optimistic Locking) لحقل version على Report وفق المتطلبات الاثني عشر للمستخدم (بدون أي تعديل في accounts.ts أو محرك المطابقة، وبدون بدء Workflow/Backup/Polling)

Work Log:
- Schema: إضافة version Int @default(1) على Report + db push ناجح دون فقد بيانات (SQL مكافئ: ALTER TABLE "Report" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1 — متوافق مع PostgreSQL) + إعادة تشغيل dev server لتحميل عميل Prisma الجديد
- src/lib/audit-actions.ts: كود جديد REPORT_UPDATE_CONFLICT + تسمية عربية «تعارض حفظ تقرير (نسخة أقدم)»
- PUT /api/reports/[id] أُعيدت كتابته: version إلزامية (مفقودة → 400 VERSION_REQUIRED، 0/سالبة/نصية/عشرية → 400 VERSION_INVALID) — التحديث الذري عبر updateMany بشرط {id, version, userId} داخل $transaction مع writeAudit (UPDATE ... WHERE id=? AND version=? عبارة واحدة — لا يمكن لطلبين بنفس النسخة أن ينجحا) — النجاح: version {increment: 1} فقط + إعادة التقرير الكامل الجديد؛ الفشل (count=0): إعادة قراءة → 404 إن حُذف، أو 409 VERSION_CONFLICT structured (clientVersion/currentVersion/updatedAt/lastModifiedBy/lastModifiedAt من آخر REPORT_UPDATED في السجل) + تدقيق تعارض عبر writeAuditSafe بلا أي تعديل بيانات
- توسيع مبرر: صلاحية الكتابة PUT امتدت للمالك OR عضو مجموعة مرتبطة (groupIds) — بدونه يستحيل تعارض نسخ بين مستخدمَين حقيقيَين (القارئ المرتبط لا يستطيع الكتابة)؛ DELETE بقي للمالك حصريًا
- GET /api/reports (القائمة): إضافة version إلى select
- page.tsx: حالة openReport (id/groupId/version/updatedAt/canUpdate) تُضبط عند الفتح وبعد كل حفظ ناجح؛ استخراج applyReportToSession من handleLoadReport + trackOpenReport؛ حوار الحفظ بوضعين «تحديث التقرير المفتوح (vN + آخر تعديل من الخادم)» / «حفظ كنسخة جديدة»؛ handleSave يرسل version في PUT ويحدّث openReport من الاستجابة فورًا؛ حوار تعارض 409 عربي (الرسالة المطلوبة حرفيًا + تفاصيل الخادم + خيارا «إبقاء تعديلاتي»/«تحميل أحدث نسخة») + نافذة تأكيد ثانية قبل الاستبدال + reloadLatestReport يطبق أحدث نسخة على الحالة دون reload؛ شارة نسخة vN ومؤشر «مفتوح» في قائمة التقارير؛ حماية groupId في وضع التحديث (من لا يدير المجموعات لا يرسله فلا يُفكك الربط)؛ تنظيف openReport عند حذف التقرير المفتوح
- اختبار API فعلي (47 فحصًا، كلها نجحت) بمستخدمَين حقيقيين عبر NextAuth credentials: A ينشئ مجموعة وتقريرًا (v1) — كلاهما يفتح v1 — A يحفظ → v2 — B يحفظ بنسخته القديمة v1 → 409 VERSION_CONFLICT (currentVersion=2، lastModifiedBy=usera) — تعديلات A سليمة وversion لم تقفز — B يحمّل v2 ويحفظ → v3 — حفظان متتاليان (v4، v5) — الحالات الحدية (مفقودة/0/سالبة/نصية/عشرية → 400، غير موجود → 404، بلا جلسة → 401، حذف غير المالك → 404، لا تغيير إطلاقًا) — طلبان متزامنان بنفس النسخة → [200,409] بالضبط وversion=6 وبيانات الفائز مخزنة — التدقيق: REPORT_CREATED=1 وREPORT_UPDATED=5 (من النسخ 1-5 فقط، بلا صفوف لحفوص فاشلة) وREPORT_UPDATE_CONFLICT=2 بـ metadata مقتصدة — المدير يقرأ التعارضات عبر /api/audit والمستخدم العادي 403 — تنظيف كامل (users=1, reports=0, groups=0, audit=0) وintegrity ok
- ملاحظة تقنية مكتشفة: جلسات NextAuth تختم الصلاحيات عند الدخول (JWT) — ربط B بالمجموعة تم قبل دخوله؛ (تحديث الجلسات الحية عند تغيير الصلاحيات خارج نطاق المرحلة)
- تحقق متصفح E2E (Agent Browser) بمستخدم اختبار: رفع ملفين حقيقيين → مطابقة → حفظ POST → شارة v1 ومؤشر «مفتوح» → حفظ تحديث → v2 → جلسة خارجية مستقلة عدّلت التقرير إلى v3 → حفظ من المتصفح بنسخته القديمة v2 → 409 وحوار التعارض بالرسالة العربية المطلوبة وتفاصيل الخادم (صورة محفوظة) → «تحميل أحدث نسخة» → نافذة تأكيد الاستبدال → تأكيد → الحالة صارت v3 باسم الخادم الجديد وعلامة window.__noReloadMarker=42 بقيت (بلا إعادة تحميل صفحة) → حفظ نهائي ناجح v4 — موبايل 390px: حوار الحفظ 358px بلا تجاوز وبكل العناصر — لا أخطاء console
- lint نظيف + dev.log بلا أخطاء + تنظيف كامل لبيانات الاختبار ومستخدمَيها وسكربتاتها + integrity_check ok

Stage Summary:
- القفل التفاؤلي مكتمل ومثبت بالاختبار الفعلي: version إلزامية في كل تحديث، فحص+تحديث ذري واحد على مستوى SQL داخل معاملة مع الأثر الرقابي، 409 VERSION_CONFLICT structured بلا Last Write Wins ولا Force Overwrite، حوار عربي مزدوج التأكيد يحمي تعديلات المستخدم ويحدّث الحالة دون reload، وتدقيق يفصل الحفوص الناجحة عن المتعارضة تمامًا. التوسعة الوحيدة خارج نص المرحلة: كتابة أعضاء المجموعات المرتبطة (ضرورة منهجية لاختبار A/B الإلزامي — موثقة في CHANGELOG). بانتظار موافقة المستخدم على المرحلة 3 (دورة الاعتماد والأدوار DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED)

---
Task ID: 3-design (Phase 3 — Workflow & SoD)
Agent: main (Z.ai Code)
Task: المرحلة 3 — إعداد تصميم البيانات فقط (قبل أي تعديل Schema أو كود) وفق البند الرابع عشر من تعليمات المستخدم، وانتظار الموافقة قبل التنفيذ.

Work Log:
- التحقق من منتجات المراحل السابقة: git log (58f7f03 Phase 0، 7ce0236 Phase 1، 51b555a Phase 2) + قراءة prisma/schema.prisma (Report+version، AuditLog بلا FK) + src/lib/permissions.ts (view/add/edit/delete/groups/export/settings/manageUsers/groupIds) + src/lib/session.ts + src/app/api/reports/[id]/route.ts (PUT الذري + canWriteReport التعاوني) + audit-actions.ts (15 كودًا) + GET /api/users للمدير حصرًا
- كتابة وثيقة التصميم الكاملة: docs/phase3-workflow-design.md (12 قسمًا) تغطي البنود الثمانية المطلوبة: حقول Report الجديدة (20 عمودًا status/periodEnd/cycle/prepared*/reviewed*/approved*/returned*/reopened* مع snapshots أسماء)، جدول WorkflowHistory append-only مستقل (قرار D-1)، تمثيل الإسناد بحقول Report بلا جدول منفصل، مصفوفة انتقالات الحالة الست (لا قفزات مباشرة، RESUME_EDIT من RETURNED/REOPENED إلى DRAFT، SUBMIT يتطلب مراجع معينًا)، مصفوفة الصلاحيات بمستوييها (مفتاحان جديدان assignWorkflow/reopenReport + الإسناد لكل تقرير)، قواعد SoD الثلاث بطبقتي تنفيذ (عند الإسناد وعند كل انتقال)، مصير الكتابة التعاونية للمجموعات (تُستبدل بقراءة+أهلية إسناد)، آلية REOPEN الذرية (أرشفة roleSnapshot أولًا ثم مسح حقول الاعتماد + cycle+1) دون فقد التاريخ
- إضافة: أكواد AuditLog السبعة المطلوبة + شكل endpoints (POST workflow / PUT assignments / GET workflow-history / users?for=assignment) + أكواد أخطاء structured جديدة (INVALID_TRANSITION, NOT_ASSIGNED, SEGREGATION_VIOLATION, REASON_REQUIRED, WORKFLOW_LOCKED...) + تكامل القفل التفاؤلي (شرط status في where الذري للانتقالات وللـ PUT) + خطة backfill (المالك يصبح المعد للتقارير القائمة) + سيناريو اختبار إلزامي بثلاثة مستخدمين + 6 نقاط قرار (D-1..D-6) بتوصيات جاهزة

Stage Summary:
- التصميم مكتمل وموثق في docs/phase3-workflow-design.md — لم يُعدَّل أي ملف Schema أو كود (التزامًا بالبند الرابع عشر). بانتظار موافقة المستخدم على التصميم وحسم نقاط القرار D-1..D-6 قبل بدء التنفيذ. لن تبدأ المرحلة 4 (Backup/Restore) أو 5 (Polling) قبل إنجاز هذه المرحلة وموافقة المستخدم.

---
Task ID: 16 (Phase 3 — Workflow & Segregation of Duties)
Agent: main (Z.ai Code)
Task: المرحلة 3 — تنفيذ دورة الاعتماد وفصل المهام كاملة وفق التصميم المعتمد (docs/phase3-workflow-design.md) + التعديلات الاثني عشر الإلزامية من المستخدم (D-1..D-6 كلها وفق التوصية) وبدون أي تعديل في accounts.ts أو محرك المطابقة، وبدون بدء Backup/Restore أو Polling.

Work Log:
- نسخة احتياطية قبل التنفيذ: /home/z/backups/ifrs-db-pre-phase3-20260919-205916.db (VACUUM INTO + integrity ok)
- Schema: 20 عمودًا على Report (status/periodEnd نص date-only/cycle + prepared·reviewed·approved·returned·reopened بمعرفات وsnapshots أسماء وأوقات وأسباب) + 4 فهارس + جدول WorkflowHistory append-only (cycle/action/from-to/actor snapshot/reason/comment/roleSnapshot JSON + 3 فهارس) — db push ناجح صفر فقد + backfill التقارير القائمة (المالك=المعد، preparedAt=null وفق تعديل رقم 1) — 0 صفوف قائمة (القاعدة نظيفة من المرحلة 2)
- src/lib/workflow.ts (نقي مشترك): الحالات الست وتسمياتها وألوان شاراتها، EDITABLE_STATUSES، مصفوفة الانتقالات transitionTarget (لا قفز مباشر)، validateSoD الثلاثية + رسالة عربية، normalizePeriodEndStrict (يميز غير المرسل عن غير الصالح ويصحح YYYY/MM/DD)، computeMyActions (canView/Edit/Submit/StartReview/Return/Approve/Reopen/Resume/Assign/Delete + isParticipant)، أنواع WorkflowInfo/WorkflowHistoryRow/AssignmentCandidate
- src/lib/audit-actions.ts: 7 أكواد جديدة (REPORT_SUBMITTED/REVIEW_STARTED/REPORT_RETURNED/REPORT_RESUBMITTED/REPORT_APPROVED/REPORT_REOPENED/ASSIGNMENT_CHANGED) بتسميات عربية؛ src/lib/permissions.ts: مفتاحا assignWorkflow/reopenReport (افتراضي false، المدير ضمنيًا بالدور) + مساعدا canAssignWorkflow/canReopenReport
- src/lib/workflow-server.ts: buildRoleSnapshot، writeWorkflowHistory (يدمج metadata داخل roleSnapshot JSON)، canViewReportRow (مالك/مجموعة/مشارك/مدير)، buildWorkflowInfo (الحالة + المشاركون بأسمائهم مع fallback استعلام لأسماء returned/reopened + myActions للمستخدم الحالي)
- POST /api/reports/[id]/workflow: نقطة واحدة للانتقالات الستة — version إلزامية، مصفوفة الحالات، فاعل الإجراء الوحيد، SoD دفاعي قبل التنفيذ، سبب إلزامي لـ RETURN/REOPEN، SUBMIT يتطلب مراجعًا ويثبت preparedAt ويشطف حقول الإرشاد (الأصل في التاريخ)، APPROVE يشترط reviewedAt، REOPEN بصلاحية reopenReport وأرشفة الحالة السابقة قبل مسح الاعتماد وcycle+1، RESUME_EDIT يوثق في WorkflowHistory فقط (D-2) — التحديث الذري WHERE id+version+status=fromStatus + صف تاريخ + AuditLog في معاملة واحدة، 409 VERSION_CONFLICT مع currentStatus، GET/PUT/DELETE على المسار = 405
- PUT /api/reports/[id]/assignments: سماوية assignWorkflow، أهداف موجودة وactive، بوابات الحالة (المعد في DRAFT/RETURNED/REOPENED فقط؛ استبدال المراجع/المعتمد في SUBMITTED/UNDER_REVIEW دون تفريغ — D-4)، APPROVED ممنوع الإسناد كليًا، SoD على الثلاثية الناتجة، استبدال المراجع بعد بدء المراجعة يفرغ reviewedAt ويعيد SUBMITTED (تعديل رقم 7)، تغيير الإسناد يرفع version (D-6) ويسجل from/to بالأسماء والسبب في السجلين
- GET /api/reports/[id]: كائن workflow محسوب خادميًا + رؤية المشاركين/المدير؛ PUT: بوابة المعد+edit+الحالة قبل كل شيء وشرطها داخل WHERE الذري مع رفض 403 WORKFLOW_LOCKED/NOT_ASSIGNED معالجة structured + periodEnd date-only + حماية حقول workflow من PUT؛ DELETE: مالك + DRAFT فقط (D-3)
- POST /api/reports: المنشئ=معد تلقائيًا + صف CREATED في WorkflowHistory + periodEnd + استجابة تتضمن workflow؛ GET القائمة: رؤية المشاركين والمدير + حقول الشارات + فلتر status اختياري
- GET /api/users?for=assignment: الحد الأدنى {id,username,displayName,active} لحيازي assignWorkflow (تعديل رقم 12)؛ GET /api/groups: المدير يرى كل المجموعات مع ownerName (حوكمة الإسناد/الإعادة)
- src/components/accounts/workflow-panel.tsx: WorkflowPanel (شارة/دورة/فترة/مشاركون/تنبيهات الأسباب/أزرار من myActions حصرًا) + ReasonDialog (سبب إلزامي RETURN/REOPEN) + ConfirmActionDialog (SUBMIT يعرض اسم المراجع، APPROVE تحذير القفل) + AssignmentDialog (3 قوائم من المرشحين + SoD فوري + سبب) + WorkflowHistoryDialog (خط زمني مجمع بالدورات + أرشيف الاعتماد السابق في REOPENED)
- src/app/page.tsx: حالة openWorkflow + trackOpenReport يقرأ workflow من الخادم (canUpdate من myActions) + handleWorkflowAction/handleAssign بمعالجة 409 عبر حوار التعارض القائم + اللوحة فوق الإعدادات عند فتح تقرير + حقل periodEnd (date) في حوار الحفظ + تنبيه القفل وإخفاء خيار التحديث عند القفل + شارات الحالة و«دوري» في ReportRow وزر الحذف للمسودة فقط + تنظيف openWorkflow عند الحذف
- اختبار API شامل (105 فحصًا كلها ناجحة) بأربعة مستخدمين حقيقيين + r2 بديل + p2 عضو مجموعة: الدورة المزدوجة الكاملة مع بقاء تاريخ الدورة 1 بعد الثانية + الحالات السلبية العشر (اعتماد المعد، مراجع=معتمد، مدير بلا إسناد، تعديل SUBMITTED/APPROVED حتى من المدير، REOPEN/RETURN بلا سبب، نسخة قديمة 409، اعتمادان متزامنان [200,409]، استبدال المراجع بعد بدء المراجعة: reviewedAt يفرغ والحالة تعود SUBMITTED وr1 يفقد الوصول) + users?for=assignment + metadata مقتصدة (<2000 حرف) — أخطاء أصلحتها أثناء الاختبار: reviewReset غير معرف (اسم المتغير resetReview) وPOST لم يكن يرجع workflow وnormalizePeriodEnd كان يخلط غير المرسل بالغير صالح، وبناء snapshot الاعتماد يجب أن يكون من الحالة اللاحقة للانتقال حتى يحمل approvedAt (ما عدا REOPEN يأخذ السابقة)
- ملاحظة مكتشفة: جلسة p2 لا ترى المجموعة الجديدة إلا بعد إعادة دخول (الصلاحيات تختم عند الدخول — معروف من المرحلة 2) والسكربت أرسل groupIds في غير موضعه ثم صحح إلى جذر الطلب
- تحقق متصفح E2E: دخول admin → حوار الفتح يظهر شارات الحالة و«دوري» → فتح تقرير معتمد (دورة 2) → اللوحة كاملة (مشاركون/تواريخ/أزرار الإسناد والسجل وإعادة الفتح فقط) → REOPEN بلا سبب مرفوض بالرسالة → REOPEN بسبب ⇒ مُعاد فتحه/الدورة 3/v18/تنبيه السبب باسم المدير → سجل الدورات يعرض الدورتين كاملتين مع «الاعتماد السابق المؤرشف» → حوار الإسناد بثلاث قوائم → موبايل 390px عمود واحد بلا تجاوز → صفر أخطاء console
- اكتشاف وإصلاح فجوة حوكمة أثناء E2E: حوار الفتح كان لا يظهر للمدير تقارير مجموعات الآخرين (GET /api/groups يرجع مجموعاته فقط) → المدير الآن يرى كل المجموعات مع اسم المالك وأزرار التعديل مخفية عن غير المالك
- lint نظيف + dev.log بلا أخطاء + تنظيف كامل (workflowHistory=150, audit=279, reports=14, groups=9, users=45 محذوفة؛ النهائي users=1/reports=0/groups=0/audit=0/workflowHistory=0) + integrity_check ok + حذف سكربتات الاختبار

Stage Summary:
- المرحلة 3 مكتملة ومثبتة بالاختبار: دورة اعتماد DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED مع RETURN/RESUBMIT وREOPEN لدورات مرقمة، فصل مهام بلا استثناء بطبقتين، إسناد لكل تقرير بصلاحيتين نظاميتين جديدتين، WorkflowHistory append-only يلخص كل دورة ويحفظ الاعتماد السابق قبل أي مسح، انتقالات وحفظ ذرية تحترم version، المدير لا يتجاوز القفل ولا SoD، الكتابة التعاونية للمجموعات أُلغيت لصالح الإسناد، وواجهة عربية كاملة تعرض ما يسمح به الخادم فقط. لا تعديل على accounts.ts أو خوارزمية المطابقة إطلاقًا. بانتظار موافقة المستخدم قبل بدء المرحلة 4 (Backup/Restore) — لن تبدأ دون موافقته.

---
Task ID: env-restore
Agent: main (Z.ai Code)
Task: إصلاح بيئة العمل بعد انقطاع الجلسة — استعادة مشروع IFRS إلى /home/z/my-project (المسار الذي يتوقعه النظام: dev.log وCaddy وworklog)

Work Log:
- اكتشاف أن مشروع IFRS (بمرحلته 3 المنفذة) نُقل إلى /tmp/my-project (PolarFS دائم) بلا node_modules، بينما كان /home/z/my-project يخدم تطبيق محادثة قديمًا مختلفًا على المنفذ 3000
- إيقاف الخادم الخاطئ + حفظ نسخة من تطبيق المحادثة القديم في /home/z/backup-chatapp-glm-restore
- rsync للمشروع من /tmp/my-project إلى /home/z/my-project (استثناء upload لأنه mount OSS وnode_modules) + bun install (857 حزمة) + prisma generate
- إعادة تشغيل dev server على 3000 (nohup bun run dev → dev.log) — صفحة /login تُجيب 200 بعنوان عربي صحيح
- التحقق من قاعدة البيانات: User=1 / Report=0 / Group=0 / WorkflowHistory=0 / AuditLog=0 — مطابقة تمامًا لحالة ما بعد تنظيف المرحلة 3
- ملاحظة: تاريخ git القديم (58f7f03/7ce0236/51b555a) فُقد مع نقل مساحة العمل — أُنشئ مستودع git جديد بلقطة أمان للحالة الحالية

Stage Summary:
- البيئة مستعادة بالكامل: مشروع IFRS بمرحلته 3 المنفذة يعمل على المنفذ 3000 بقاعدة بيانات نظيفة، وworklog موحد في /home/z/my-project/worklog.md — جاهز لمتابعة المراحل من هنا

---
Task ID: 3.5-design
Agent: main (Z.ai Code)
Task: المرحلة 3.5 — لوحة متابعة المطابقات: تصميم فقط دون أي تنفيذ (بعد موافقة المستخدم على المرحلة 3 وطلبه مرحلة وسيطة قبل المرحلة 4)

Work Log:
- تأكيد حالة المرحلة 3 المنفذة (Task 16) وقراءة مصادر الحقيقة: prisma/schema.prisma (حقول workflow الـ20 + WorkflowHistory + الفهارس القائمة)، src/lib/workflow.ts (الحالات/الانتقالات/myActions/SoD)، src/lib/workflow-server.ts (canViewReportRow = قاعدة الرؤية)، src/lib/permissions.ts (مفتاحا assignWorkflow/reopenReport)، src/app/api/reports/route.ts (baseVisibility + غياب pagination في القائمة الحالية)، بنية ترويسة page.tsx (زر /admin)
- كتابة وثيقة التصميم الكاملة docs/phase3.5-dashboard-design.md (16 قسمًا) تغطي بنود المستخدم الاثني عشر حرفيًا:
  * dueDate على مستوى Report (نص date-only مثل periodEnd) مع مسار تطوير Group/سياسة إقفال يكتب في نفس العمود، وطريقان لضبطه: المعد عبر PUT (حالات قابلة للتعديل) + حائز assignWorkflow عبر PUT assignments (أي حالة عدا APPROVED) — بلا endpoint جديد
  * تعريف «متأخر» الخادمي الصارم: dueDate≠null ∧ status≠APPROVED ∧ today>dueDate، بحد يومي (يوم الاستحقاق نفسه ليس متأخرًا)، و«اليوم» من الخادم بإزاحة أعمال قابلة للتهيئة (افتراضي UTC+3) ولا قبول بتوقيت العميل
  * دالة deriveStage نقية (7 مراحل حصرية متبادلة من حقول Report وحدها بلا استعلامات تاريخ، مستغلة بقاء returned*/reopened* في المسودات البعدية) = تعريف خادمي واحد للبطاقات والفلاتر والصفوف (خاصية تكافؤ إلزامية بالاختبار)، مع فصل صريح بين حالة Workflow ومرحلة الأعمال، و«متأخرة» كعلم متراكب خارج التقسيم الحصري
  * تحليل فجوة UNDER_REVIEW (المراجع والمعتمد كلاهما يملك إجراءً) وتحليل كامل لاعتماد PENDING_APPROVAL عبر COMPLETE_REVIEW: الأثر على آلة الحالات وWorkflowHistory وAuditLog (REVIEW_COMPLETED + صمامات) وmyActions والقفل والإسناد وSoD والتقارير الحالية (صفر ترحيل) والتقارير الزمنية المستقبلية — مع توصية بالتبني وقرار D-4/D-5 للمستخدم
  * قواعد المسؤولية الحالية deriveOwnerRole لكل حالة + تعريف APPROVED = مقفول بلا مسؤولية إنجاز
  * مصفوفة الرؤية لست شخصيات بإعادة استخدام baseVisibility حرفيًا + facets مبنية من التقارير المرئية فقط (منع تسريب الأسماء والمعرفات بلا 404)
  * API قراءة فقط: GET /api/dashboard/summary + /reconciliations (ترقيم 20/50/100 + قائمة بيضاء للترتيب + 400 DASHBOARD_INVALID_PARAM) + /facets مع أشكال استجابة JSON كاملة وأمثلة
  * Wireframe نصي RTL: مفتاح ترويسة «مساحة العمل | لوحة المتابعة» بلا route جديد، 9-10 بطاقات KPI قابلة للنقر، شريط فلاتر chips، جدول 16 عمودًا بالمطلوبة حرفيًا + إجراءات من myActions حصرًا، ترقيم خادمي
  * فهارس مقترحة إضافية: periodEnd, dueDate, (groupId,status), updatedAt, cycle — كلها إضافية صرفة + ملاحظات الأداء (GROUP BY واحد للبطاقات، count+findMany متوازيان، بلا N+1)
  * دلالات القيم المفقودة (لا اختلاق تواريخ): periodEnd/dueDate/preparedAt/reviewedAt/approvedAt null تظهر «—» وخيار «بدون فترة/استحقاق» و«المتأخرة» تستثنيها
  * خطة تنفيذ واختبار: احتياطي VACUUM INTO → schema إضافية → (تعديل المرحلة 3 المكمّل إن اعتُمد) → dashboard.ts نقية → API → واجهة → مصفوفة اختبار إلزامية (تكافؤ البطاقات، حدود المتأخر، 6 شخصيات رؤية، فلاتر غير صالحة 400، التقارير القديمة، إثبات قراءة فقط بعدّ الصفوف قبل/بعد، سيناريو PENDING_APPROVAL الكامل) → تنظيف كامل
  * 8 نقاط قرار D-1..D-8 بتوصيات جاهزة (موضع dueDate، من يضبطه، توقيت اليوم، تبني PENDING_APPROVAL، صماماته، دلالة «أعيد فتحها»، facets منفصلة، نطاق البطاقات)
- لم يُعدَّل أي ملف Schema أو كود (الالتزام بـ«التصميم فقط») — الإنتاج الوحيد: وثيقة التصميم + هذا المدخل + لقطة git أمان

Stage Summary:
- تصميم المرحلة 3.5 مكتمل وموثق في docs/phase3.5-dashboard-design.md: لوحة قراءة فقط خادمية البطاقات والفلاتر والترقيم ضمن نطاق الرؤية الحالي، مع استحقاق dueDate قابل للتوسع، وتعريف «متأخر» صارم، واشتقاق مرحلة أعمال ومسؤولية حالية بدوال نقية، وتحليل معمق لفجوة UNDER_REVIEW وتوصية باعتماد PENDING_APPROVAL كتعديل مكمّل للمرحلة 3. بانتظار موافقة المستخدم وحسم D-1..D-8 قبل أي تنفيذ — ولن تبدأ المرحلة 4 (Backup/Restore) قبل إنجاز هذه المرحلة وموافقته.

---
Task ID: 3.5A
Agent: main (Z.ai Code)
Task: تنفيذ المرحلة 3.5A — إضافة حالة PENDING_APPROVAL وانتقال COMPLETE_REVIEW + فصل reviewStartedAt/reviewedAt + dueDate وحوكمة الرقابية (وفق قرار المستخدم D-1 حتى D-9)

Work Log:
- نسخة احتياطية قبل التغيير: backups/pre-3.5A-2026-09-20T04-07-58.db (VACUUM INTO + integrity ok) — لم يُحذف أي نسخة قائمة ولم يُعاد كتابة تاريخ Git
- Schema: Report.dueDate (نص date-only)، Report.reviewStartedAt، فهارس (periodEnd, dueDate, updatedAt, cycle, groupId+status) — db push بلا فقد
- ترحيل الدلالة (قرار D-5): scripts/migrate-reviewed-at-3.5a.ts — نقل reviewedAt القديم (بدلالة البدء) إلى reviewStartedAt ثم تصفير reviewedAt (صفر صفوف — القاعدة نظيفة، موثق ومكرر التشغيل)
- src/lib/workflow.ts: +PENDING_APPROVAL (شارة rose، تسمية «بانتظار الاعتماد»)، +WORKFLOW_ACTION.COMPLETE_REVIEW، +WORKFLOW_HISTORY_ACTION.REVIEW_COMPLETED، مصفوفة الانتقالات: APPROVE لم يعد يعمل إلا من PENDING_APPROVAL، RETURN من UNDER_REVIEW (مراجع) أو PENDING_APPROVAL (معتمد بسبب إلزامي)، +deriveOwnerRole القاعدة الخادمية الواحدة (DRAFT/RETURNED/REOPENED→المعد، SUBMITTED/UNDER_REVIEW→المراجع، PENDING_APPROVAL→المعتمد، APPROVED→لا أحد)، +normalizeDueDateStrict، computeMyActions: +canCompleteReview، canApprove => PENDING_APPROVAL حصرًا، canReturn للحالتين
- src/lib/business-time.ts: إزاحة توقيت الأعمال المركزية BUSINESS_TZ_OFFSET_MINUTES (افتراضي 180، غير مثبتة بالكود) + businessToday + calendarDaysBetween (أيام تقويمية)
- src/lib/audit-actions.ts: +REVIEW_COMPLETED، +DUE_DATE_CHANGED
- workflow route: START_REVIEW يثبت reviewStartedAt؛ COMPLETE_REVIEW (مراجع فقط) يثبت reviewedAt=التوقيع وينتقل PENDING_APPROVAL؛ SUBMIT/REOPEN يمسحان أدلة المراجعة (بعد الأرشفة في REOPEN)؛ RETURN يتحقق من الفاعل حسب الحالة + metadata returnedFromPendingApproval؛ APPROVE metadata.pendingSince=reviewedAt
- assignments route: استبدال المراجع في PENDING_APPROVAL يبطل التوقيع ويعيد SUBMITTED؛ PENDING_APPROVAL أُضيف لبوابة «استبدال فقط لا تفريغ»؛ resetReview يمسح reviewStartedAt أيضًا
- POST /api/reports: dueDate عند الإنشاء لحائز assignWorkflow فقط (DUE_DATE_FORBIDDEN/DUE_DATE_INVALID)
- PATCH /api/reports/[id]/due-date (جديد): الحوكمة — assignWorkflow + الرؤية أولًا (404 لغير المرئي) + كل الحالات عدا APPROVED + قفل تفاؤلي version + تدقيق DUE_DATE_CHANGED (oldDueDate,newDueDate,changedBy,cycle) بلا صف WorkflowHistory
- UI: workflow-panel زر «إتمام المراجعة (توقيع المراجع)» + شارة الاستحقاق + حوار حوكمة الاستحقاق + بطاقة المراجع تعرض البدء والإتمام؛ page.tsx handleDueDate + عنوان COMPLETE_REVIEW + حقل الاستحقاق عند إنشاء نسخة جديدة (للحوكمة فقط)
- اختبارات 3.5A الإلزامية: scripts/verify-3.5a.ts (HTTP حقيقي + 6 مستخدمين) — 64/64 PASS (الدورة الكاملة، الإرجاع من PENDING_APPROVAL، القفل على المعد والمعتمد، رفض APPROVE من UNDER_REVIEW، رفض COMPLETE_REVIEW لغير المراجع، تعارض النسخ في COMPLETE_REVIEW/APPROVE/due-date، حوكمة الاستحقاق بالصلاحية وبدونها، SoD regression، بطلان التوقيع عند استبدال المراجع، REOPEN يمسح الأدلة مع الأرشفة، تسلسل السجل) ثم تنظيف كامل: users=1 reports=0 groups=0 audit=0 workflowHistory=0 + integrity ok
- Commit: 07f7873 (append-only فوق 821156e — بلا أي إعادة كتابة تاريخ)

Stage Summary:
- 3.5A مكتملة ومجازة بالاختبار: آلة الحالات أصبحت DRAFT→SUBMITTED→UNDER_REVIEW→PENDING_APPROVAL→APPROVED مع توقيع مراجع مستقل، والاستحقاق حقل رقابي محوكَم بالتدقيق الكامل
- ملاحظة معمارية: الحوكمة غير الإدارية (assignWorkflow) تعمل ضمن نطاق رؤية المستخدم فقط (404 لغير المرئي) — نفس قواعد الإسناد في المرحلة 3
- فهارس الجديدة ستُدقّق بـ EXPLAIN QUERY PLAN على بيانات اختبار معقولة في 3.5B وقد تُقلّص

---
Task ID: 3.5B
Agent: main (Z.ai Code)
Task: تنفيذ المرحلة 3.5B — لوحة متابعة المطابقات (قراءة فقط): APIs + KPIs + فلاتر + جدول RTL (بعد نجاح 3.5A كاملًا)

Work Log:
- src/lib/reconciliation.ts (نقية مشتركة): deriveStage بسبع مراحل حصرية + stageToWhere (ترجمة حرفية مطابقة)، deriveOwner فوق deriveOwnerRole (القاعدة الواحدة)، computeOverdue/buildOverdueWhere (dueDate≠null ∧ status≠APPROVED ∧ today>dueDate — أيام تقويمية، الحد: يوم الاستحقاق ليس متأخرًا)، تعريفات البطاقات وقائمة بيضاء للترتيب، نوع DashboardRow
- src/lib/dashboard-server.ts: buildDashboardVisibility (نفس predicate حشو GET /api/reports) يُعاد استخدامه في الثلاثة endpoints حرفيًا؛ تحقق صارم للباراميترات (400 DASHBOARD_INVALID_PARAM)؛ بحث الاسم برموز % _ حرفيًا عبر مسار SQL مع ESCAPE (Prisma contains لا يهرب LIKE في SQLite)
- APIs (GET فقط — الكتابة 405): /api/dashboard/summary (بطاقات من نفس الرؤية والدوال النقية — فلاتر النطاق فقط قرار D-8)، /api/dashboard/reconciliations (count+findMany بنفس WHERE بالتوازي + pagination {20,50,100} + sort whitelist + myActions لكل صف من computeMyActions)، /api/dashboard/facets (periods/groups/users ضمن الرؤية — لا تسريب أسماء خارجها)
- UI: مفتاح الترويسة «مساحة العمل | لوحة المتابعة» (بلا route جديد — حالة مساحة العمل محفوظة)؛ kpi-cards (نقر = فلتر خادمي ثابت؛ «متأخرة» و«أعيد فتحها» علمان متراكبان خارج التقسيم)؛ filters-bar (chips + مسح الكل + ownerMe)؛ reconciliations-table (18 عمودًا incl. المسؤول الحالي/الاستحقاق/أيام التأخير + شارة د² + تظليل المتأخر؛ إجراءات الصفوف تستدعي endpoint الانتقالات الحالي بـ myActions الخادمية؛ «الإسناد» يفتح التقرير — انحراف موثق عن القسم 7)؛ ترقيم/ترتيب خادمي بالكامل
- الفهارس (قرار الفحص): EQP على 2500 صف + ANALYZE — updatedAt (الترتيب الافتراضي)، dueDate (المتأخر)، status (OR المراحل)، groupId+status، cycle>1، periodEnd (covering لـ DISTINCT facets) — كلها مستخدمة فعلًا بلا تكرار، لم يُحذف شيء
- اختبارات 3.5B الإلزامية: scripts/verify-3.5b.ts — 87/87 PASS (تكافؤ بطاقة↔فلتر↔صفوف لكل مرحلة، مجموع الحصري = الإجمالي 27، مصفوفة المتأخر أمس/اليوم/غد/null × معتمد/غير معتمد مع daysOverdue 1 و2، ownerRole/ownerMe، الرؤية لستة أدوار incl. عضو مجموعة قراءة فقط وoutsider أصفار، facets بلا تسريب + فلتر غير مرئي 200 فارغ لا 404، ترقيم 20+7 وصفحة خارج النطاق، ترتيب بالاسم/الدورة، فلاتر مركبة، 10 باراميترات غير صالحة ⇒ 400، بحث % _ حرفي، فلاتر النطاق على البطاقات، إثبات قراءة فقط: لا تغيير في Report/WorkflowHistory/AuditLog/versions بعد جلسة كاملة + كل أفعال الكتابة 405)
- تحقق متصفح E2E (agent-browser): لوحة المستخدم المدير تعرض البطاقات بأعداد مطابقة، نقر بطاقة «بانتظار الاعتماد» ⇒ فلتر + صف واحد، مسح الكل، جدول 20 صفًا، فتح تقرير من اللوحة ⇒ مساحة العمل بلوحة دورة الاعتماد، تجاوب موبايل (بطاقتان/صف)، تذييل مثبت يُدفع طبيعيًا مع المحتوى الطويل، لا أخطاء console
- تنظيف كامل بعد الاختبار: users=1 reports=0 groups=0 audit=0 workflowHistory=0 + integrity ok
- Commit: append-only بعد 3.5A (لا إعادة كتابة تاريخ)، النسخ الاحتياطية قائمة

Stage Summary:
- Phase 3.5 (A+B) مكتملة: آلة الحالات مع PENDING_APPROVAL + حوكمة dueDate + لوحة متابعة قراءة-فقط بمصدر رؤية واشتقاق واحد لا تتباين أرقامه مع صفوفه أبدًا
- الفرق الموثق الوحيد عن التصميم: زر «تغيير الإسناد» في صف اللوحة يفتح التقرير في مساحة العمل (حوار الإسناد الكامل هناك) بدل تكرار الحوار — الإجراءات الأخرى كاملة
- JWT يخبز الصلاحيات وقت الدخول: تغيير groupIds يتطلب إعادة دخول (اكتُشف أثناء الاختبار — سلوك NextAuth المعتمد)

---
Task ID: 4-design (Phase 4 — Backup, Restore & Operational Recovery)
Agent: main (Z.ai Code)
Task: المرحلة 4 — تصميم فقط دون أي تنفيذ (بعد موافقة المستخدم على Phase 3.5A/3.5B المنفذتين والمختبرتين)

Work Log:
- تأكيد حالة المشروع: المراحل 0/1/2/3/3.5A/3.5B منجزة (64/64 و87/87 PASS، commits 821156e→07f7873→ede4838، append-only)
- جرد فعلي شامل لتحديد نطاق النسخ (لا افتراض): db/custom.db (1.4MB، WAL، 5 جداول، integrity ok) — صفر استدعاءات fs.write في src كاملة وصفر معالجات multipart ⇒ كل بيانات المستخدمين والمرفوعات JSON داخل DB حصرًا — .env يحوي DATABASE_URL فقط (لا NEXTAUTH_SECRET مثبت!) — BUSINESS_TZ_OFFSET_MINUTES الإعداد المركزي الوحيد — لا مجلد prisma/migrations إطلاقًا (db push فقط) — backups/pre-3.5A داخل المشروع بينما نسخة pre-phase3 في /home/z/backups فُقدت نهائيًا مع نقل البيئة (دليل واقعي لمسألة off-device DR)
- كتابة وثيقة التصميم الكاملة docs/phase4-backup-restore-design.md (24 قسمًا) تغطي بنود المستخدم العشرين حرفيًا: جرد ما يُنسخ/لا يُنسخ بالأدلة، VACUUM INTO مقابل Backup API (القرار: VACUUM INTO — النمط المجرَّب، بلا تصادم checkpoint مع Prisma)، المعمارية والمسارات (خارج public، 0600، أسماء خادمية، معرفات مغلاقة ضد traversal)، صيغة Manifest الكاملة (schemaFingerprint + counts + dataRange + configFingerprint)، أكواد AuditLog الستة الجديدة + السجل التشغيلي الخارجي JSONL var/recovery/recovery-log.jsonl الذي يحل مشكلة «AuditLog يعود للماضي عند استعادة قاعدة أقدم»، نموذج الصلاحيات (مفتاحان manageBackups + restoreDatabase — لا اشتقاق ضمني من settings)، خط التحقق الثماني على staging حصرًا، تسلسل الاستعادة العشري (Upload→Validate→Preview→Confirm→Pre-Restore→Maintenance→Restore→Integrity→Restart/Reconnect→Completion) برسم ASCII، Maintenance Mode (علم ملفي + assertWritable في كل endpoints الكتابة + عداد in-flight + 503 + شريط استطلاع)، التحقق البعدي بالقراءة Prisma الفعلية + Rollback التلقائي للـ pre-restore، إبطال الجلسات بتدوير NEXTAUTH_SECRET عند مرحلة Restart (تحليل خطر JWT المخبوز الذي يمر عبر Edge بلا DB)، Retention بلا أي حذف تلقائي (عرض فقط)، التنزيل ZIP + الرفع بلا ثقة بالاسم وبحد 200MB، جدول تهديدات/تخفيف عشري + نقاش التشفير at rest (توصية التأجيل)، خطة Prisma migrations baseline كاملة (diff→init على نسخة مؤقتة→resolve --applied→فحص drift) بمخاطرها المعلنة قبل التنفيذ، DR خارج الجهاز بالدليل الواقعي للمشروع نفسه، RPO 24h/RTO 30 دقيقة كتوصيات قابلة للتغيير، خطة اختبارات 4 محاور (نسخ أثناء كتابة متزامنة، مصفوفة ملفات فاسدة/غريبة، استعادة ذهبية + rollback + صيانة + جلسات + بقاء JSONL، migrations)، 10 نقاط قرار D-1..D-10 بتوصيات جاهزة، وتقسيم تنفيذي مقترح 4A (أساس النسخ)/4B (الاستعادة)
- لم يُعدَّل أي ملف Schema أو Prisma أو API أو UI أو accounts.ts أو Workflow أو Dashboard — الإنتاج الوحيد: وثيقة التصميم + هذا المدخل + commit انتقائي append-only للوثيقة والمدخل فقط

Stage Summary:
- تصميم Phase 4 مكتمل وموثق: نطاق النسخ أثبت فحصًا أنه قاعدة البيانات كاملة بلا أي حالة خارجية عدا الإعدادات، النسخ بـ VACUUM INTO المجرَّب، كل استعادة خلف خط تحقق ثماني + pre-restore إلزامي + صيانة + Rollback، وأدلة الاسترجاع في سجل خارجي لا يمحوه الاستبدال — بانتظار موافقة المستخدم على الوثيقة وحسم D-1..D-10 قبل أي كود، ولن يبدأ أي تنفيذ (4A أو 4B) قبل ذلك

---
Task ID: 4-design-v2 (Phase 4 — Final Design Addendum)
Agent: main (Z.ai Code)
Task: مراجعة تصميم Phase 4 وفق القرارات المعدلة من المستخدم (D-2/D-3/D-7/D-9 معدلة + إضافات إلزامية: Restore Drill، مستويات التحقق الثلاثة، آلة حالات الاستعادة، RECOVERY_REQUIRED، Session Epoch، أمن ZIP، Recovery Test) — تصميم فقط بلا تنفيذ

Work Log:
- إعادة كتابة docs/phase4-backup-restore-design.md إلى v2 (25 قسمًا) بدمج كل القرارات:
  * D-2: فصل BACKUP_DIR القابل للتهيئة عن مجلد التطبيق (افتراضي var/backups داخل مساحة العمل الدائمة بسبب درس فقدان /home/z — لكن بلا افتراض معماري لوجوده في source tree) + .gitignore للأمام فقط
  * D-3: منع ترحيل أي نسخة على قاعدة التشغيل — Restore Drill يرحّل نسخة مؤقتة في staging (integrity + Prisma read tests + counts sanity) والناتج يصبح Candidate؛ الأحدث/غير المعروف: رفض قاطع (SCHEMA_NEWER/SCHEMA_UNKNOWN)
  * D-7: Session Epoch — ملف var/auth/session-epoch خارج DB المستبدلة؛ jwt callback يوقع epoch عند الدخول ويفحصه في كل استدعاء؛ التوكن المخالف يُقتل (بلا user) فترفضه كل مصادر البيانات Node-runtime؛ حدوثة Edge proxy موثقة صراحة (غلاف صفحات فقط بلا وصول بيانات)؛ فصل كامل عن NEXTAUTH_SECRET الثابت (D-10: يثبت قويًا ولا يدخل ZIP/Manifest/API/سجلات)
  * D-9: مستويا صيانة (write-block أثناء التحقق/العرض، full-block من disconnect حتى التحقق البعدي+الإبطال) + تسلسل الثماني المراحل الحرفي + reconnectDb عبر export let db (ESM live bindings) مع بديل restart مضمون + PRAGMA journal_mode=WAL بعد التبديل (VACUUM INTO يخرج بوضع rollback)
  * إضافات المستخدم: مستويات CREATED/VALIDATED/RESTORE_VERIFIED في manifest.verification (لا كلمة «متحقق» لمجرد integrity) — Restore Drill وظيفة أساسية بزر UI وAPI لا اختبار يدوي — آلة حالات الاستعادة الكاملة بحالات نهائية ثلاث (COMPLETED/ROLLED_BACK/RECOVERY_REQUIRED) وقاعدة «لا خروج من الصيانة إلا بنجاح الاستعادة أو التراجع» — مصفوفة فشل/تراجع بثمانية صفوف مع إجراء الطوارئ اليدوي — سجل الاسترجاع بـ eventId/timestamp/operationId/event/actor/backupId/result/details + append-only بلا أي update/delete endpoint — Manifest v2 بحقول formatVersion/appVersion/schemaVersion/createdAt/createdBy (وصفي لا أمني)/backupType/databaseSha256/databaseBytes/integrityCheck/counts/periodRange — أمن ZIP: حدود مضغوط/غير مضغوط/نسبة/عدد مداخل + رفض zip-slip/symlinks/متداخلات + مقبول v1 حصرًا database.db+manifest.json — Recovery Test سيناريو التسعة خطوات إلزامي — RPO/RTO مع التصريح «اليدوي لا يضمن 24h» — off-device interface مستقبلية فقط مع اشتراط التشفير
  * D-4: إجراء baseline الآمن بست خطوات (diff بلا لمس أي قاعدة → بناء فارغ من migrations → مقارنة ثنائية incl. fingerprint → اختبار سكربتات التحقق على المبنية → فقط بعدها migrate resolve --applied على الأصلية → status clean) مع خطوة drift منفصلة
  * قوائم ملفات 4A (14 ملفًا: 8 جديدة) و4B (15 ملفًا: 5 جديدة + 13 مسارًا كتابيًا يضاف له assertWritable) مع «لا يُعدل إطلاقًا» صريح
- تحقق تقني قبل التصميم: getServerSession في session.ts يعمل Node runtime ⇒ فحص epoch في jwt/session callbacks يغطي كل مسارات API — jszip موجود أصلًا في dependencies للحزم والفك المضبوط
- لم يُعدَّل أي ملف كود/Schema/API/UI — الإنتاج: الوثيقة v2 + هذا المدخل + commit انتقائي append-only

Stage Summary:
- تصميم Phase 4 v2 جاهز: النسخ بـ VACUUM INTO في BACKUP_DIR منفصل، كل استعادة خلف خط تحقق ثماني + Drill للمخططات الأقدم على نسخ مؤقتة + pre-restore مدقق إلزامي + صيانة بمستويين + آلة حالات لا تخرج إلا بنجاح أو تراجع صحيح وإلا RECOVERY_REQUIRED، وإبطال الجلسات بـ Session Epoch خارج القاعدة، وأدلة الاسترجاع في سجل خارجي append-only بعناوين operationId — بانتظار الموافقة النهائية على الملخص المرسل قبل كتابة أي كود (4A أو 4B)

---
Task ID: 4A (Phase 4A — أساس النسخ الاحتياطي)
Agent: main (Z.ai Code)
Task: تنفيذ Phase 4A المعتمدة حصرًا: إنشاء النسخ (VACUUM INTO) + Manifest v2 + مستويات التحقق الثلاثة + Restore Drill على قاعدة مؤقتة معزولة + سجل استرجاع خارجي append-only + أمن ZIP + واجهة إدارة + Migration Baseline (تحضير/اختبار فقط بلا resolve على الإنتاج) — ثم توقف قبل 4B

Work Log:
- مكتبات جديدة: backup-config.ts (BACKUP_DIR قابل للتهيئة افتراضي var/backups خارج public/ وGit — لا افتراض معماري لـ source tree؛ حدود الرفع؛ سجل المخططات المعروفة؛ مولدات backupId/operationId)، zip-secure.ts (قارئ Central Directory يدوي صارم: رفض ZIP64/تشفير/symlink/مجلدات/تكرار/أسماء خارج database.db+manifest.json/حدود مضغوط-غير مضغوط/نسبة bomb)، backup-manifest.ts (Manifest v2 بكل الحقول الإلزامية + periodRange + authenticity.note الموثق «VALIDATED ≠ أصالة تشفيرية» + حقل manifestHmac محجوز null)، recovery-log.ts (JSONL append-only بـ eventId/timestamp/operationId/event/actor/backupId/result/details عبر Sanitizer مركزي — لا توجد أي دالة تعديل/حذف بنيويًا)، backup-server.ts (createBackup: VACUUM INTO عبر $executeRawUnsafe + integrity + fingerprint + counts/periodRange/dataRange + SHA-256 بثّ + ZIP database.db+manifest.json + sidecar متزامن + تحقق تلقائي فوري؛ validateBackupArtifact خط ثماني بـ CHECKSUM قاطع + COUNTS_MISMATCH؛ runRestoreDrillById: فك معزول→checksum→integrity→مخطط→اتصال Prisma حقيقي على مؤقتة→قراءة 5 جداول→مطابقة counts/period→sanity→RESTORE_VERIFIED؛ uploadBackupZip staging فقط؛ listBackups من Manifestات مع INVALID للمتلف/الناقص)
- الصلاحيات: manageBackups + restoreDatabase (محجوز 4B بلا أي API يشير إليه) + canManageBackups/canRestoreDatabase — settings لا تمنح شيئًا (D-5) + requireManageBackups في session.ts + 6 أكواد AuditLog (BACKUP_CREATED/FAILED/VALIDATED/UPLOADED/DOWNLOADED/DRILLED) + Backup entity
- APIs سبعة: GET/POST /api/backups، [id] details، [id]/download (stream بفحص صلاحية)، [id]/validate، [id]/drill، upload (base64 بحد مضغوط قبل الفك)، recovery-log (قراءة فقط) — كلها خلف manageBackups حصرًا
- واجهة: backup-manager.tsx (بطاقات ملخص + إنشاء حي + رفع للتحقق + جدول من Manifestات بشارات CREATED/VALIDATED/RESTORE_VERIFIED/INVALID + تفاصيل Manifest مع SHA-256 كامل + تقارير فحوص بالمدد + سجل استرجاع مرئي بـ operationId + بطاقة سياسة: RPO يدوي لا يضمن 24h / 0600≠تشفير / لا حذف تلقائي / قيد أصالة Manifest) + تبويب ثالث محصور بـ canManageBackups + خانة manageBackups في محرر المستخدمين
- .gitignore: /var/ و/backups/ للأمام فقط (الملف القديم المتتبع دون مساس)
- Migration Baseline (D-4 خطوات 0-4 حصرًا): prisma/migrations/0_init/migration.sql (5,353 بايت من migrate diff --from-empty) + migration_lock.toml + سكربت تحقق: نسخة أمان VACUUM INTO → بناء قاعدة فارغة كاملة بمigrate deploy → migrate diff (built→schema) و(built→production) فارغان دلاليًا → مطابقة بصمة sqlite_master بنفس خوارزمية الـ Manifest → كشف drift نصي حقيقي: جدول Report فقط (dueDate/reviewStartedAt أُضيفا تاريخيًا بـ ALTER TABLE فجاءا بنهاية ترتيب الأعمدة) — عرضه على المستخدم لتقرير 4B (resolve --applied يقبل drift دلاليًا متطابقًا أو إعادة بناء لاحقة) → Prisma CRUD على المبنية → ⛔ لم يُنفذ resolve على الإنتاج عمدًا (بانتظار موافقة منفصلة) — الإنتاج بلا _prisma_migrations وعدّه لم يتغير
- سكربتات التحقق الأربعة (كلها نجاح كامل):
  * isolation (19/19): Dataset موسوم → Backup A VALIDATED → تعديل التشغيل (تقرير ثالث + اسم معدل) → Drill ثانٍ → ⭐ المؤقتة تحوي Dataset A حرفيًا (الاسم الأصلي + بيانات موسومة، لا A3 ولا المعدل) والتشغيل بقيت على الحالة الجديدة → Audit (CREATED/VALIDATED/DRILLED) + Recovery (7 أحداث بتسلسل كامل) → تنظيف كامل وعودة العدّ للأصل + integrity ok
  * zip-security (15/15): zip-slip/مطلق/symlink/ملف ثالث/تكرار/متداخل/حد مضغوط 2MB>1MB/حجم CD مزيّف 4GB/10 مداخل/SQLite مزيفة/checksum كاذب/Manifest مكسور/Manifest مفقود/مخطط غريب MISSING_TABLES/جدول مستقبلي SCHEMA_UNKNOWN — كل رفض = صف Audit + حدث Recovery واحدًا بالضبط + صفر بقايا staging + جداول البيانات لم تُلمس
  * consistency: كاتب كعملية bun منفصلة (محاولة Worker أسقطت Bun نفسه — علة بيئة موثقة) 20,050 دفعة، اللقطة التقطت منتصف الكتابة (19,379/20,050 · counter=rows=96,895 بالضبط = معاملة مكتملة وحيدة) والكتابة استمرت بعدها لـ100,250 — integrity ok في كل ملف — الإنتاج لم يُستخدم
  * permissions (HTTP فعلي ضد الخادم): بلا manageBackups: 403 على الثمانية كلها؛ settings:true فقط: 403 (D-5 مثبت)؛ حامل غير مدير: 200 قائمة+سجل و404 لغير الموجود؛ مدير بالدور: 200 ضمني؛ غير مصدق: 401 — مستخدمو الاختبار حُذفوا
- انحراف موثق (سلف بند 4B بضرورة): تثبيت NEXTAUTH_SECRET قوي في .env الآن — الدليل: JWEDecryptionFailed بين chunks Next 16+Turbopack مع الغياب (أثبت بـ /api/auth/session=200 مقابل كل API=401 بعد إعادة تشغيل نظيف) — بند D-10 إلزامي قبل التشغيل الفعلي وشرط ضروري لاختبارات 4A الإلزامية عبر HTTP — السر خارج أي كود للنسخ/السجلات ولا يقرؤه أي مسار جديد، و.env خارج Git
- إصلاحات أثناء التحقق: BigInt من PRAGMA page_size (Number())، حدث BACKUP_VALIDATED للتحقق التلقائي (Audit+Recovery)، توحيد أثر الرفض (كل رفض = Audit+Recovery مرة واحدة)، تقفية In-flight: POST أول من واجهة الرفع رجع 403 لحظة إعادة تجميع dev — أعيد إثباته 201 (وHTTP مستقل 201 كامل الفحوص)
- تحقق متصفح E2E (Agent Browser): دخول→تبويب→إنشاء حي (نسخة جديدة VALIDATED بالشارة)→Drill (تقرير 8 مراحل بالمدد + قراءات Prisma 5/5 + RESTORE_VERIFIED)→تفاصيل Manifest (SHA-256 كامل + تنبيه الأصالة)→سجل الاسترجاع بـ operationId→رفع صالح (201 بالخادم)→تذييل ثابت سطح المكتب وأسفل الصفحة على الموبايل (844=844)→لا أخطاء console/page
- نظافة النهاية: production integrity ok، مستخدم وحيد (admin)، staging نظيف من الرفوض، نسخ الاختبار الرسمية محفوظة كأدلة (3 نسخ bk-* + 2 مرفوعات staging + 7 نسخ أمان pre-4A-* بأذونات 600) — لا حذف لأي نسخة قائمة

Stage Summary:
- 4A مكتملة ومثبتة: نسخ متسقة بـ VACUUM INTO في BACKUP_DIR منفصل (افتراضي var/backups)، Manifest v2 بلا أسرار/هاشات/مسارات، ثلاثة مستويات تحقق لا تُمنح مجانًا، Drill وظيفة أساسية تعمل عبر Prisma حقيقي على مؤقتة معزولة (فشل أي خطوة = لا RESTORE_VERIFIED)، سجل استرجاع خارجي append-only بلا أي update/delete endpoint، أمن ZIP فشل كل الهجمات الخمسة عشر قبل لمس الإنتاج، baseline جاهز بنتيجة صادقة (تطابق دلالي كامل + drift نصي موثق بقرار 4B مؤجل)، صلاحية manageBackups منفصلة تمامًا عن settings — قاعدة التشغيل لم تُستبدل ولم يُلمس سلوك أي نظام قائم — **توقف هنا: لا 4B (استبدال الإنتاج/الصيانة/الEpoch/التراجع) إلا بموافقة صريحة**
