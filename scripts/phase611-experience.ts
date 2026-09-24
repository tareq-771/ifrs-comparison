// Phase 6.11 — بوابة تجربة الاستخدام (V1 Experience Fast Track).
// تشغيل: bun scripts/phase611-experience.ts
// (بوابة حتمية صافية — بلا قاعدة بيانات إطلاقًا: كل المنطق المُختبر
//  دوال نقية من lib/appearance وlib/insights وlib/permissions و
//  company-access وطبقة الرسوم الحتمية — لا يلمس custom.db ولا أي قاعدة)
//
// المجموعات:
//   A1 التحقق من تفضيلات المظهر + السقوط للافتراض
//   A2 الافتراضيات والاستعادة والثبات
//   A3 حساب التطبيق على DOM (حدود التكبير/الكثافة/الثيمات)
//   D1 تخصيص لوحة المعلومات: تطبيع الترتيب + قاعدة الإخفاء لا يمنح صلاحية
//   C1 سلامة بيانات الرسوم (الناقص != صفر، سالب يستثنى، BigInt دقيق)
//   I1 رؤى الموازنة الحتمية (مصطلحات سياقية كاملة)
//   I2 رؤى اكتمال الميزان والمطابقة
//   I3 التصنيف FACT/ANALYSIS/RECOMMENDATION + الخطورة + الترتيب الحتمي
//   P1 الصلاحيات ونطاق الشركات (fail-closed) + توريث الصلاحية للرؤى
//   S1 أمان السلاسل: لا NaN/Infinity، عربية سليمة، بلا ادعاءات تدقيق

import {
  APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE_PREFS, DEFAULT_DASHBOARD_ORDER,
  computeAppliedAppearance, isDefaultPrefs, normalizeDashboardOrder, parseAppearancePrefs,
  serializeAppearancePrefs,
} from "../src/lib/appearance";
import {
  INSIGHT_MODULE_LABELS, agingStatusInsights, budgetVarianceInsights, countBySeverity,
  sortInsightsForDisplay, tbReadinessInsights, type BudgetVarianceInsightRow,
} from "../src/lib/insights";
import { SEVERITY_LABELS } from "../src/lib/aging";
import { budgetVsActualChartSeries } from "../src/components/charts/amount-charts";
import {
  DEFAULT_USER_PERMISSIONS, canViewInsights, canConfigureInsightRules, parsePermissions,
} from "../src/lib/permissions";
import { companyVisible } from "../src/lib/company-access";

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passCount += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failCount += 1;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name} :: ${msg}`);
    console.log(`  FAIL  ${name} :: ${msg}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const row = (over: Partial<BudgetVarianceInsightRow>): BudgetVarianceInsightRow => ({
  statementLineCode: "L1",
  lineNameAr: "إيرادات التشغيل",
  lineNature: "REVENUE",
  budgetMinor: "100000",
  actualMinor: "120000",
  favorability: "FAVORABLE",
  ...over,
});

// ═══════════════════ A1 — التحقق من التفضيلات ═══════════════════
section("A1 appearance preference validation");

check("A1.1 null/غائب ⇒ الافتراضات كاملة", () => {
  const p = parseAppearancePrefs(null);
  assert(p.theme === DEFAULT_APPEARANCE_PREFS.theme, "theme default");
  assert(p.zoomPct === 100 && p.density === "comfortable", "zoom/density default");
  assert(p.dashboard.order.join("|") === DEFAULT_DASHBOARD_ORDER.join("|"), "order default");
});

check("A1.2 ثيم غير معروف ⇒ الافتراض", () => {
  assert(parseAppearancePrefs({ theme: "neon-party" }).theme === "corporate-green", "bad theme");
});

check("A1.3 كثافة غير معرفة ⇒ الافتراض", () => {
  assert(parseAppearancePrefs({ density: "ultra" }).density === "comfortable", "bad density");
});

check("A1.4 تكبير تحت الحد الأدنى (80) ⇒ الافتراض 100", () => {
  assert(parseAppearancePrefs({ zoomPct: 80 }).zoomPct === 100, "zoom low");
});

check("A1.5 تكبير فوق الحد الأعلى (130) ⇒ الافتراض", () => {
  assert(parseAppearancePrefs({ zoomPct: 130 }).zoomPct === 100, "zoom high");
});

check("A1.6 تكبير داخل الحدود (90/125) يُقبل", () => {
  assert(parseAppearancePrefs({ zoomPct: 90 }).zoomPct === 90, "zoom 90");
  assert(parseAppearancePrefs({ zoomPct: 125 }).zoomPct === 125, "zoom 125");
});

check("A1.7 حجم خط الواجهة خارج الحدود ⇒ الافتراض، وداخله يُقبل", () => {
  assert(parseAppearancePrefs({ uiFontSizePx: 30 }).uiFontSizePx === 16, "ui big");
  assert(parseAppearancePrefs({ uiFontSizePx: 8 }).uiFontSizePx === 16, "ui small");
  assert(parseAppearancePrefs({ uiFontSizePx: 18 }).uiFontSizePx === 18, "ui edge ok");
});

check("A1.8 حجم خط الجداول خارج الحدود ⇒ الافتراض 14", () => {
  assert(parseAppearancePrefs({ tableFontSizePx: 40 }).tableFontSizePx === 14, "table big");
  assert(parseAppearancePrefs({ tableFontSizePx: 16 }).tableFontSizePx === 16, "table edge ok");
});

check("A1.9 قيم غير رقمية للأحجام ⇒ الافتراض", () => {
  assert(parseAppearancePrefs({ zoomPct: "abc" }).zoomPct === 100, "zoom NaN");
  assert(parseAppearancePrefs({ uiFontSizePx: null }).uiFontSizePx === 16, "ui null");
});

check("A1.10 chartsVisible غير منطقية ⇒ الافتراض true", () => {
  assert(parseAppearancePrefs({ chartsVisible: "yes" }).chartsVisible === true, "charts truthy string");
  assert(parseAppearancePrefs({ chartsVisible: false }).chartsVisible === false, "explicit false kept");
});

check("A1.11 كائن تالف (مصفوفة/نص/رقم) ⇒ الافتراضات بلا استثناء", () => {
  for (const bad of [[], "x", 42, true]) {
    const p = parseAppearancePrefs(bad);
    assert(p.theme === DEFAULT_APPEARANCE_PREFS.theme, `bad input ${JSON.stringify(bad)}`);
  }
});

check("A1.12 dashboard.dashboard تالف ⇒ ترتيب افتراضي مطبّع", () => {
  const p = parseAppearancePrefs({ dashboard: { order: ["bogus", "context", "context"], hidden: ["nope", "shortcuts"] } });
  assert(p.dashboard.order[0] === "context", "dedupe+drop");
  assert(p.dashboard.order.length === DEFAULT_DASHBOARD_ORDER.length, "missing appended");
  assert(p.dashboard.hidden.join("|") === "shortcuts", "hidden cleaned");
});

check("A1.13 دورة تخزين كاملة: serialize⇒parse تطابق تام", () => {
  const prefs = parseAppearancePrefs({
    theme: "financial-blue", arabicFont: "system", englishFont: "system",
    uiFontSizePx: 17, tableFontSizePx: 13, density: "compact", zoomPct: 110,
    chartsVisible: false, dashboard: { hidden: ["companies"], order: ["statusCards", "context"] },
  });
  const back = parseAppearancePrefs(JSON.parse(serializeAppearancePrefs(prefs)));
  assert(JSON.stringify(back) === JSON.stringify(prefs), "round-trip identity");
});

// ═══════════════════ A2 — الافتراضيات والاستعادة ═══════════════════
section("A2 defaults & restore");

check("A2.1 isDefaultPrefs صحيح للافتراض وخاطئ بعد تغيير واحد", () => {
  const d = parseAppearancePrefs(undefined);
  assert(isDefaultPrefs(d) === true, "default true");
  assert(isDefaultPrefs({ ...d, zoomPct: 105 }) === false, "one change false");
});

check("A2.2 الاستعادة تعيد الافتراضات تمامًا (بعد تخصيص عنيف)", () => {
  const changed = parseAppearancePrefs({
    theme: "dark", density: "compact", zoomPct: 125,
    dashboard: { hidden: ["context", "companies", "shortcuts"], order: ["companies"] },
  });
  assert(isDefaultPrefs(changed) === false, "changed");
  const restored = parseAppearancePrefs(JSON.parse(serializeAppearancePrefs(DEFAULT_APPEARANCE_PREFS)));
  assert(isDefaultPrefs(restored) === true, "restored to defaults");
  assert(restored.dashboard.hidden.length === 0, "hidden cleared");
});

check("A2.3 مفتاح التخزين ثابت معلن (سلوك الترطيب موثق)", () => {
  assert(APPEARANCE_STORAGE_KEY === "ifrs.appearance.prefs.v1", "storage key");
});

check("A2.4 الثيم الافتراضي لا يغيّر المظهر الحالي (corporate-green بلا سمة DOM)", () => {
  const applied = computeAppliedAppearance(DEFAULT_APPEARANCE_PREFS);
  assert(applied.appearanceAttr === null, "no data-appearance");
  assert(applied.densityAttr === null && applied.rootFontSizePx === null, "no density/zoom");
  assert(applied.tableFontSizePx === null && applied.uiFontSizePx === null, "no font sizes");
  assert(applied.fontArStack === null && applied.fontEnStack === null, "no font overrides");
});

// ═══════════════════ A3 — حساب التطبيق ═══════════════════
section("A3 applied appearance computation");

check("A3.1 ثيم فاتح غير افتراضي ⇒ data-appearance صحيح", () => {
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, theme: "financial-blue" }).appearanceAttr === "financial-blue", "blue attr");
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, theme: "high-contrast" }).appearanceAttr === "high-contrast", "hc attr");
});

check("A3.2 dark/system ⇒ بلا data-appearance (نطاق next-themes)", () => {
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, theme: "dark" }).appearanceAttr === null, "dark");
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, theme: "system" }).appearanceAttr === null, "system");
});

check("A3.3 التكبير 110 ⇒ جذر 17.6px، و100 ⇒ بلا لمس", () => {
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, zoomPct: 110 }).rootFontSizePx === 17.6, "17.6px");
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, zoomPct: 100 }).rootFontSizePx === null, "no zoom override");
});

check("A3.4 الكثافة المضغوطة ⇒ سمة فقط عند الانحراف عن الافتراض", () => {
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, density: "compact" }).densityAttr === "compact", "compact");
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, density: "comfortable" }).densityAttr === null, "comfortable none");
});

check("A3.5 خط النظام ⇒ stack صريح؛ خط التطبيق ⇒ بلا لمس", () => {
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, arabicFont: "system" }).fontArStack !== null, "ar system stack");
  assert(computeAppliedAppearance({ ...DEFAULT_APPEARANCE_PREFS, arabicFont: "tajawal" }).fontArStack === null, "tajawal default");
});

// ═══════════════════ D1 — تخصيص لوحة المعلومات ═══════════════════
section("D1 dashboard customization");

check("D1.1 ترتيب فارغ ⇒ الترتيب الافتراضي كاملًا", () => {
  assert(normalizeDashboardOrder([]).join("|") === DEFAULT_DASHBOARD_ORDER.join("|"), "empty normalized");
});

check("D1.2 تطبيع حتمي: إسقاط المجهول + إزالة التكرار + إلحاق الناقص", () => {
  const out = normalizeDashboardOrder(["companies", "bogus", "context", "companies"]);
  assert(out.join("|") === "companies|context|insights|statusCards|shortcuts", `got ${out.join("|")}`);
});

check("D1.3 نفس المدخل ⇒ نفس الناتج (حتمية)", () => {
  const a = normalizeDashboardOrder(["shortcuts", "x", "insights"]);
  const b = normalizeDashboardOrder(["shortcuts", "x", "insights"]);
  assert(a.join("|") === b.join("|"), "deterministic");
});

check("D1.4 التفضيل لا يمنح صلاحية: مستخدم بلا viewInsights لا يرى العنصر حتى لو ظهر تفضيله", () => {
  const userPerms = { ...DEFAULT_USER_PERMISSIONS, viewInsights: false };
  assert(canViewInsights(userPerms, "user") === false, "user denied");
  assert(canViewInsights(userPerms, "admin") === true, "admin implicit by role");
  // القاعدة المطبقة في الواجهة: العنصر يُعرض فقط عند (ظاهر بالتفضيل) && (مصرح به)
  const visibleInPrefs = true;
  const rendered = visibleInPrefs && canViewInsights(userPerms, "user");
  assert(rendered === false, "pref cannot reveal unauthorized widget");
});

check("D1.5 صلاحيات الرؤى: الافتراضي للمستخدم عرض=true وتكوين=false", () => {
  assert(DEFAULT_USER_PERMISSIONS.viewInsights === true, "viewInsights default");
  assert(DEFAULT_USER_PERMISSIONS.configureInsightRules === false, "configure default");
  assert(canConfigureInsightRules(DEFAULT_USER_PERMISSIONS, "user") === false, "no config for user");
  assert(canConfigureInsightRules(DEFAULT_USER_PERMISSIONS, "admin") === true, "admin config implicit");
});

// ═══════════════════ C1 — بيانات الرسوم ═══════════════════
section("C1 chart data integrity");

check("C1.1 الناقص يُستبعد ولا يُرسم صفرًا", () => {
  const s = budgetVsActualChartSeries([
    { label: "أ", budgetMinor: "1000", actualMinor: "900" },
    { label: "ب", budgetMinor: "1000", actualMinor: null },
    { label: "ج", budgetMinor: null, actualMinor: "500" },
  ]);
  assert(s.rows.length === 1 && s.skippedMissing === 2, `rows=${s.rows.length} skipped=${s.skippedMissing}`);
});

check("C1.2 القيم السالبة تُستثنى من رسم يبدأ من الصفر (بلا تضليل)", () => {
  const s = budgetVsActualChartSeries([{ label: "س", budgetMinor: "-500", actualMinor: "700" }]);
  assert(s.rows.length === 0 && s.skippedNegative === 1, "negative skipped");
});

check("C1.3 التلميحات نص دقيق formatMinor — لا فقد دقة", () => {
  const s = budgetVsActualChartSeries([{ label: "ك", budgetMinor: "12345678901234567890", actualMinor: "1" }]);
  assert(s.rows.length === 1, "included");
  assert(s.rows[0].budgetLabel === "123,456,789,012,345,678.90", `label=${s.rows[0].budgetLabel}`);
  assert(s.rows[0].actualLabel === "0.01", "actual label");
});

check("C1.4 لا NaN/Infinity في أرقام الرسم", () => {
  const s = budgetVsActualChartSeries([
    { label: "أ", budgetMinor: "1", actualMinor: "2" },
    { label: "ب", budgetMinor: "99999999999999999999", actualMinor: "0" },
  ]);
  for (const r of s.rows) {
    assert(Number.isFinite(r.budgetChart) && Number.isFinite(r.actualChart), "finite only");
  }
});

// ═══════════════════ I1 — رؤى الموازنة ═══════════════════
section("I1 budget insight rules (deterministic)");

check("I1.1 إيراد أعلى من الموازنة ⇒ INFO «أعلى من الموازنة» واقعة", () => {
  const [ins] = budgetVarianceInsights([row({ actualMinor: "120000" })]);
  assert(ins.titleAr.includes("أعلى من الموازنة"), ins.titleAr);
  assert(ins.severity === "INFO" && ins.kind === "FACT", "severity/kind");
});

check("I1.2 إيراد أقل من الموازنة >5% ⇒ ATTENTION «أقل من الموازنة»", () => {
  const [ins] = budgetVarianceInsights([row({ actualMinor: "90000" })]);
  assert(ins.titleAr.includes("أقل من الموازنة"), ins.titleAr);
  assert(ins.severity === "ATTENTION", "attention");
});

check("I1.3 مصروف تجاوز >5% ⇒ ATTENTION «تجاوز الموازنة»", () => {
  const [ins] = budgetVarianceInsights([row({ lineNature: "EXPENSE", budgetMinor: "100000", actualMinor: "120000", favorability: "UNFAVORABLE" })]);
  assert(ins.titleAr.includes("تجاوز الموازنة"), ins.titleAr);
  assert(ins.severity === "ATTENTION", "attention");
});

check("I1.4 مصروف أقل ⇒ INFO «وفر عن الموازنة»", () => {
  const [ins] = budgetVarianceInsights([row({ lineNature: "EXPENSE", actualMinor: "80000", favorability: "FAVORABLE" })]);
  assert(ins.titleAr.includes("وفر عن الموازنة"), ins.titleAr);
  assert(ins.severity === "INFO", "info");
});

check("I1.5 ضمن حد التسامح (±5%) ⇒ «ضمن الموازنة» ونسبة محسوبة فعلًا", () => {
  const [ins] = budgetVarianceInsights([row({ actualMinor: "104000" })]);
  assert(ins.titleAr.includes("ضمن الموازنة"), ins.titleAr);
  // قفل انحدار: النسبة يجب أن تُحسب (400bp) — لا تُفقد أبدًا (Number.isFinite على BigInt)
  assert(ins.pctBp === 400, `pctBp=${ins.pctBp}`);
});

check("I1.6 بند OTHER ⇒ اتجاه عام (ارتفاع/انخفاض) بلا تقييم زيادة/وفر", () => {
  const [rise] = budgetVarianceInsights([row({ lineNature: "ASSET", statementLineCode: "NCA", lineNameAr: "أصول ثابتة", actualMinor: "120000" })]);
  assert(rise.titleAr.includes("ارتفاع"), rise.titleAr);
  assert(!rise.titleAr.includes("وفر") && !rise.titleAr.includes("تجاوز"), "no P&L verdict on BS lines");
  const [fall] = budgetVarianceInsights([row({ lineNature: "ASSET", statementLineCode: "NCA", lineNameAr: "أصول ثابتة", actualMinor: "80000" })]);
  assert(fall.titleAr.includes("انخفاض"), fall.titleAr);
});

check("I1.7 بلا بيانات مقارنة ⇒ «لا تتوفر بيانات للمقارنة» مجمّعة بعدّاد", () => {
  const out = budgetVarianceInsights([
    row({ actualMinor: null }),
    row({ budgetMinor: null, statementLineCode: "L2" }),
  ]);
  const missing = out.find((i) => i.code === "BUDGET_COMPARISON_DATA_MISSING");
  assert(missing !== undefined, "missing insight present");
  assert(missing.titleAr.includes("لا تتوفر بيانات للمقارنة"), "terminology");
  assert(missing.affectedCount === 2, "affected count");
});

check("I1.8 الناقص != صفر: صف بلا فعلي لا يولّد فارقًا صفرًا", () => {
  const out = budgetVarianceInsights([row({ actualMinor: null })]);
  assert(!out.some((i) => i.code.startsWith("BUDGET_REVENUE") || i.code.startsWith("BUDGET_EXPENSE")), "no fake variance");
});

check("I1.9 حساب الفارق BigInt دقيق فوق 2^53", () => {
  const big = "90071992547409930";
  const [ins] = budgetVarianceInsights([row({ budgetMinor: big, actualMinor: big })]);
  assert(ins.amountMinor === "0" && ins.titleAr.includes("ضمن الموازنة"), "exact BigInt equality");
  const [over] = budgetVarianceInsights([row({ lineNature: "EXPENSE", budgetMinor: "100000000000000000", actualMinor: "200000000000000000" })]);
  assert(over.amountMinor === "100000000000000000", `amount=${over.amountMinor}`);
});

// ═══════════════════ I2 — اكتمال الميزان والمطابقة ═══════════════════
section("I2 TB readiness & reconciliation insights");

check("I2.1 لا ميزان معتمد ⇒ INFO صريحة بلا اختراع", () => {
  const out = tbReadinessInsights({ hasCommittedTB: false, unclassifiedCount: null, totalDebitMinor: null, totalCreditMinor: null });
  assert(out.length === 1 && out[0].code === "TB_NO_COMMITTED" && out[0].severity === "INFO", "no TB");
});

check("I2.2 حسابات بلا تصنيف ⇒ ATTENTION بعدّاد متأثر", () => {
  const out = tbReadinessInsights({ hasCommittedTB: true, unclassifiedCount: 7, totalDebitMinor: "100", totalCreditMinor: "100" });
  const unc = out.find((i) => i.code === "TB_UNCLASSIFIED_ACCOUNTS");
  assert(unc !== undefined && unc.severity === "ATTENTION" && unc.affectedCount === 7, "unclassified");
});

check("I2.3 مدين != دائن ⇒ CRITICAL معلن بلا سد تلقائي", () => {
  const out = tbReadinessInsights({ hasCommittedTB: true, unclassifiedCount: 0, totalDebitMinor: "100000", totalCreditMinor: "99900" });
  const diff = out.find((i) => i.code === "TB_DEBIT_CREDIT_DIFFERENCE");
  assert(diff !== undefined && diff.severity === "CRITICAL", "critical difference");
  assert(diff.amountMinor === "100", `amount=${diff.amountMinor}`);
});

check("I2.4 ميزان متوازن مصنف ⇒ لا رؤى (بلا ضجيج)", () => {
  const out = tbReadinessInsights({ hasCommittedTB: true, unclassifiedCount: 0, totalDebitMinor: "500", totalCreditMinor: "500" });
  assert(out.length === 0, `got ${out.length}`);
});

check("I2.5 فرق مطابقة الأعمار ⇒ IMPORTANT معلن لا مخفى", () => {
  const out = agingStatusInsights({ hasApprovedSnapshot: true, reconciliationStatus: "DIFFERENCE", totals: null });
  assert(out.some((i) => i.code === "AGING_RECONCILIATION_DIFFERENCE" && i.severity === "IMPORTANT"), "difference disclosed");
});

check("I2.6 لا لقطة معتمدة ⇒ INFO توجيهية", () => {
  const out = agingStatusInsights({ hasApprovedSnapshot: false, reconciliationStatus: null, totals: null });
  assert(out.length === 1 && out[0].code === "AGING_NO_APPROVED_SNAPSHOT" && out[0].severity === "INFO", "no snapshot");
});

check("I2.7 لا ربط حسابات مدينين ⇒ INFO حالة معلنة", () => {
  const out = agingStatusInsights({ hasApprovedSnapshot: true, reconciliationStatus: "NO_RECEIVABLE_MAPPING", totals: null });
  assert(out.some((i) => i.code === "AGING_NO_RECEIVABLE_MAPPING"), "mapping status");
});

// ═══════════════════ I3 — التصنيف والخطورة والترتيب ═══════════════════
section("I3 classification, severity, deterministic order");

check("I3.1 كل رؤية بنوع صحيح FACT/ANALYSIS/RECOMMENDATION", () => {
  const all = [
    ...budgetVarianceInsights([
      row({}), row({ actualMinor: null }), row({ lineNature: "EXPENSE", actualMinor: "200000" }),
    ]),
    ...tbReadinessInsights({ hasCommittedTB: true, unclassifiedCount: 3, totalDebitMinor: "1", totalCreditMinor: "2" }),
    ...agingStatusInsights({ hasApprovedSnapshot: true, reconciliationStatus: "DIFFERENCE", totals: null }),
  ];
  for (const ins of all) {
    assert(["FACT", "ANALYSIS", "RECOMMENDATION"].includes(ins.kind), `bad kind ${ins.kind}`);
    assert(["INFO", "ATTENTION", "IMPORTANT", "CRITICAL"].includes(ins.severity), `bad severity ${ins.severity}`);
  }
});

check("I3.2 الترتيب حتمي: الخطورة تنازليًا ثم الوحدة ثم الكود", () => {
  const out = sortInsightsForDisplay([
    ...budgetVarianceInsights([row({ actualMinor: null })]),
    ...tbReadinessInsights({ hasCommittedTB: true, unclassifiedCount: 0, totalDebitMinor: "10", totalCreditMinor: "5" }),
    ...agingStatusInsights({ hasApprovedSnapshot: true, reconciliationStatus: "DIFFERENCE", totals: null }),
  ]);
  const ranks = out.map((i) => ({ CRITICAL: 4, IMPORTANT: 3, ATTENTION: 2, INFO: 1 }[i.severity]));
  for (let i = 1; i < ranks.length; i++) assert(ranks[i - 1]! >= ranks[i]!, "non-increasing severity");
  const again = sortInsightsForDisplay([
    ...budgetVarianceInsights([row({ actualMinor: null })]),
    ...tbReadinessInsights({ hasCommittedTB: true, unclassifiedCount: 0, totalDebitMinor: "10", totalCreditMinor: "5" }),
    ...agingStatusInsights({ hasApprovedSnapshot: true, reconciliationStatus: "DIFFERENCE", totals: null }),
  ]);
  assert(JSON.stringify(out) === JSON.stringify(again), "deterministic repeat");
});

check("I3.3 عدّ الخطورة يطابق الأطوال", () => {
  const out = sortInsightsForDisplay([
    ...budgetVarianceInsights([row({}), row({ actualMinor: null })]),
  ]);
  const c = countBySeverity(out);
  assert((c.INFO + c.ATTENTION + c.IMPORTANT + c.CRITICAL) === out.length, "counts sum");
});

// ═══════════════════ P1 — الصلاحيات ونطاق الشركات ═══════════════════
section("P1 permissions & company scope");

check("P1.1 نطاق الشركات fail-closed: قائمة فارغة/مفقودة ⇒ لا رؤية", () => {
  const u = { role: "user", permissions: { companyIds: [], viewAllCompanies: false } };
  assert(companyVisible(u, "c1") === false, "empty list none");
  const u2 = { role: "user", permissions: { viewAllCompanies: false } };
  assert(companyVisible(u2, "c1") === false, "missing none");
});

check("P1.2 قائمة صريحة تسمح بالعضو فقط", () => {
  const u = { role: "user", permissions: { companyIds: ["c1", "c2"], viewAllCompanies: false } };
  assert(companyVisible(u, "c1") === true, "member allowed");
  assert(companyVisible(u, "c3") === false, "non-member denied");
});

check("P1.3 المدير يرى الكل بالدور (تفويض موثق)", () => {
  assert(companyVisible({ role: "admin", permissions: { companyIds: [] } }, "any") === true, "admin ALL");
});

check("P1.4 تفضيلات العرض ليست بيانات صلاحيات: parsePermissions لا ينتج viewInsights من نص عرض", () => {
  const p = parsePermissions(JSON.stringify({ theme: "dark", zoomPct: 500, viewAging: true }));
  // مفتاح غريب يُحتفظ به كنص JSON لكنه لا يمنح أي مفتاح غير معرف سلوكًا
  assert(p.viewAging === true, "explicit key respected");
  assert((p as unknown as Record<string, unknown>).theme !== undefined, "unknown key inert for authz");
  // لا دالة صلاحيات تقرأ theme/zoomPct — الإثبات: canViewInsights يعتمد المفتاح فقط
  const noInsights = parsePermissions("{}");
  assert(canViewInsights(noInsights, "user") === DEFAULT_USER_PERMISSIONS.viewInsights, "defaults rule insights");
});

// ═══════════════════ S1 — سلامة السلاسل والمصطلح ═══════════════════
section("S1 string safety & wording rules");

check("S1.1 لا NaN/Infinity في أي نسب أو نصوص مولدة", () => {
  const all = [
    ...budgetVarianceInsights([row({}), row({ budgetMinor: "0", actualMinor: "5" }), row({ actualMinor: null })]),
    ...tbReadinessInsights({ hasCommittedTB: true, unclassifiedCount: 1, totalDebitMinor: "0", totalCreditMinor: "0" }),
  ];
  for (const ins of all) {
    assert(!(ins.pctBp !== undefined && !Number.isFinite(ins.pctBp)), "finite pctBp");
    for (const s of [ins.titleAr, ins.detailAr, ins.titleEn, ins.detailEn, ins.suggestedActionAr ?? "", ins.suggestedActionEn ?? ""]) {
      assert(!s.includes("NaN") && !s.includes("Infinity"), `bad token in: ${s}`);
    }
  }
});

check("S1.2 مقام صفر ⇒ نسبة null لا قسمة على صفر", () => {
  const [ins] = budgetVarianceInsights([row({ lineNature: "EXPENSE", budgetMinor: "0", actualMinor: "500", favorability: "UNFAVORABLE" })]);
  // موازنة صفر: الفارق موجب لكن النسبة null (لا Infinity) — والبند يبقى تجاوزًا معلنًا
  assert(ins.pctBp === undefined || ins.pctBp === null || Number.isFinite(ins.pctBp), "no Infinity");
  assert(ins.titleAr.includes("تجاوز الموازنة"), "overrun still disclosed");
});

check("S1.3 التوصيات استشارية وبلا ادعاءات تدقيق/احتيال/ECL", () => {
  const all = [
    ...budgetVarianceInsights([row({}), row({ lineNature: "EXPENSE", actualMinor: "900000" }), row({ actualMinor: null })]),
    ...tbReadinessInsights({ hasCommittedTB: true, unclassifiedCount: 2, totalDebitMinor: "3", totalCreditMinor: "4" }),
    ...agingStatusInsights({ hasApprovedSnapshot: true, reconciliationStatus: "DIFFERENCE", totals: null }),
  ];
  const forbidden = ["احتيال", "تلاعب", "رأي مراجعة", "رأي المراجعة", "خسارة ائتمانية", "مخصص ائتماني"];
  for (const ins of all) {
    for (const s of [ins.titleAr, ins.detailAr, ins.suggestedActionAr ?? ""]) {
      for (const f of forbidden) assert(!s.includes(f), `forbidden phrase «${f}» in: ${s}`);
    }
    if (ins.suggestedActionAr) assert(ins.suggestedActionAr.startsWith("توصية استشارية"), "advisory prefix");
  }
});

check("S1.4 تسميات عربية لكل الوحدات والخطورات (غير فارغة)", () => {
  for (const m of Object.values(INSIGHT_MODULE_LABELS)) assert(m.ar.length > 0 && m.en.length > 0, "module labels");
  for (const s of Object.values(SEVERITY_LABELS)) assert(s.ar.length > 0 && s.en.length > 0, "severity labels");
});

// ═══════════════════ الخلاصة ═══════════════════
console.log("\n════════════════════════════════════════");
console.log(`Phase 6.11 gate: ${passCount} PASS / ${failCount} FAIL (إجمالي ${passCount + failCount})`);
if (failCount > 0) {
  console.log("الفشل:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("ALL GREEN");
