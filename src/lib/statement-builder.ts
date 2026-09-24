// Phase 6.2D — باني القوائم المالية (وحدة نقية — Statement Builder).
//
// المدخل: صفوف حسابات من البيانات المحفوظة (عبر reporting-server) + مرجع بنود
// القوائم المالية (FinancialStatementLine) — بلا hard-code لأكواد حسابات إطلاقًا.
//
// الضوابط المعتمدة:
//   - علامات العرض (presentation) مشتقة من التصنيف حصرًا (domain-driven):
//       REVENUE ⇒ −net (دائن موجب) | EXPENSE ⇒ net (مدين موجب)
//       ASSET ⇒ net | LIABILITY/EQUITY ⇒ −net (دائن موجب)
//   - المجاميع الجزئية تُحسب من أعضائها (Σ الحسابات/البنود الأبناء) — لا اعتماد
//     على نص اسم البند إطلاقًا (قرار 6.2D-2).
//   - باب اكتمال الخريطة (6.2D-6): أي حساب بقيمة مادية وmappingStatus ≠
//     FULLY_MAPPED ⇒ القائمة «غير مكتملة» مع قائمة الحسابات — لا إصدار نهائي بصمت.
//   - المعادلة المحاسبية (6.2D-5): الأصول = الالتزامات + حقوق الملكية — أي فرق
//     يُعرض كتحذير واضح ولا يُصحح تلقائيًا ولا يُخفى.
//   - OCI (6.2D-3): قسم منفصل فقط عند وجود حسابات مرتبطة ببنود OCI — بلا بيانات
//     لا يُختلق صفر مؤكد، وتُعرض الحالة المناسبة.

import { isStatementLineConsistent } from "./account-nature";

export interface StatementInputRow {
  accountCode: string;
  accountName: string;
  mappingStatus: string | null;
  classification: string | null;
  statementLineCode: string | null;
  /** القيمة المحسوبة للفترة بوحدات secondary (net = مدين − دائن). */
  valueMinor: bigint | null;
  valueStatus: string; // OK | INCOMPLETE_DATA
}

export interface StatementLineMeta {
  id: string;
  code: string;
  nameAr: string;
  statementType: string;
  parentId: string | null;
  displayOrder: number;
}

export interface StatementRowDTO {
  kind: "LINE" | "ACCOUNT_GROUP" | "TOTAL" | "NET_RESULT" | "GRAND_TOTAL";
  key: string;
  label: string;
  statementLineCode: string | null;
  valueMinor: string | null;
  valueStatus: string;
  previousValueMinor?: string | null;
  depth: number;
  accounts?: Array<{ accountCode: string; accountName: string; valueMinor: string | null }>;
}

export interface StatementSection {
  key: string;
  title: string;
  rows: StatementRowDTO[];
  totalMinor: string;
}

export interface MappingCompleteness {
  ready: boolean;
  incompleteAccounts: Array<{ accountCode: string; accountName: string; mappingStatus: string; valueMinor: string | null }>;
}

export interface ProfitOrLossStatement {
  kind: "PROFIT_OR_LOSS";
  revenue: StatementSection;
  expenses: StatementSection;
  netResultMinor: string;
  oci: { section: StatementSection; totalMinor: string } | null;
  ociStatus: "NO_DATA" | "PRESENT";
  totalComprehensiveIncomeMinor: string;
  completeness: MappingCompleteness;
}

export interface FinancialPositionStatement {
  kind: "STATEMENT_OF_FINANCIAL_POSITION";
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  netResultRowMinor: string | null;
  netResultRowStatus: string;
  equation: { assetsMinor: string; liabilitiesPlusEquityMinor: string; differenceMinor: string; balanced: boolean };
  unclassified: { rows: Array<{ accountCode: string; accountName: string; valueMinor: string | null }>; totalMinor: string };
  completeness: MappingCompleteness;
}

function totalOf(values: Array<bigint | null>): bigint {
  let t = BigInt(0);
  for (const v of values) if (v !== null) t += v;
  return t;
}

/** عرض القيمة بالعلامة الصحيحة حسب التصنيف (null تمر كما هي — حالة ناقصة). */
function present(net: bigint | null, classification: string | null): bigint | null {
  if (net === null) return null;
  if (classification === "REVENUE" || classification === "LIABILITY" || classification === "EQUITY") return -net;
  return net;
}

/**
 * قاعدة الإشارة الواحدة (6.9): نفس قاعدة عرض القوائم مُصدَّرة لإعادة الاستخدام
 * (خدمة المقارنة المركزية) — بلا نسخ للمنطق إطلاقًا.
 */
export function presentSignedValue(net: bigint | null, classification: string | null): bigint | null {
  return present(net, classification);
}

function completenessOf(rows: readonly StatementInputRow[]): MappingCompleteness {
  const incomplete = rows
    .filter((r) => r.mappingStatus !== "FULLY_MAPPED" && (r.valueMinor === null || r.valueMinor !== BigInt(0)))
    .map((r) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      mappingStatus: r.mappingStatus ?? "NEEDS_CLASSIFICATION",
      valueMinor: r.valueMinor === null ? null : r.valueMinor.toString(),
    }));
  return { ready: incomplete.length === 0, incompleteAccounts: incomplete };
}

/* ──────────────────────────────────────────────────────────────────────────
 * قائمة الربح أو الخسارة (+ تهيئة الدخل الشامل الآخر)
 * ────────────────────────────────────────────────────────────────────────── */

export function buildProfitOrLoss(
  rows: readonly StatementInputRow[],
  lineMeta: readonly StatementLineMeta[],
  previousRows?: readonly StatementInputRow[]
): ProfitOrLossStatement {
  const metaByCode = new Map(lineMeta.map((m) => [m.code, m]));
  const prevByCode = new Map((previousRows ?? []).map((r) => [r.accountCode, r]));
  const pnlLines = new Map(
    lineMeta
      .filter((m) => m.statementType === "PROFIT_OR_LOSS")
      .map((m) => [m.code, m])
  );
  const ociLines = new Map(
    lineMeta.filter((m) => m.statementType === "OTHER_COMPREHENSIVE_INCOME").map((m) => [m.code, m])
  );

  type Bucket = { values: bigint[]; accounts: NonNullable<StatementRowDTO["accounts"]>; incomplete: boolean };
  const byLine: Record<"REVENUE" | "EXPENSE", Record<string, Bucket>> = { REVENUE: {}, EXPENSE: {} };
  const byOciLine: Record<string, Bucket> = {};
  const unattachedRevenue: NonNullable<StatementRowDTO["accounts"]> = [];
  const unattachedExpenses: NonNullable<StatementRowDTO["accounts"]> = [];

  for (const r of rows) {
    const value = present(r.valueMinor, r.classification);
    if (r.statementLineCode && ociLines.has(r.statementLineCode)) {
      const bucket = (byOciLine[r.statementLineCode] ??= { values: [], accounts: [], incomplete: false });
      if (value !== null) bucket.values.push(value); else bucket.incomplete = true;
      bucket.accounts.push({ accountCode: r.accountCode, accountName: r.accountName, valueMinor: value === null ? null : value.toString() });
      continue;
    }
    if (
      r.statementLineCode && pnlLines.has(r.statementLineCode) &&
      (r.classification === "REVENUE" || r.classification === "EXPENSE")
    ) {
      const sectionKey = r.classification;
      const bucket = (byLine[sectionKey][r.statementLineCode] ??= { values: [], accounts: [], incomplete: false });
      if (value !== null) bucket.values.push(value); else bucket.incomplete = true;
      bucket.accounts.push({ accountCode: r.accountCode, accountName: r.accountName, valueMinor: value === null ? null : value.toString() });
      continue;
    }
    // حساب FLOW بلا بند P&L — يدخل في مجمل قسمه بالتصنيف ويُعرض شفافًا.
    // حسابات المركز المالي (ASSET/LIABILITY/EQUITY) لا تعبر هنا إطلاقًا.
    if (r.classification === "REVENUE" || r.classification === "EXPENSE") {
      const entry = { accountCode: r.accountCode, accountName: r.accountName || r.accountCode, valueMinor: value === null ? null : value.toString() };
      if (r.classification === "REVENUE") unattachedRevenue.push(entry);
      else unattachedExpenses.push(entry);
    }
  }

  const buildSection = (
    key: string,
    title: string,
    classificationFilter: "REVENUE" | "EXPENSE"
  ): StatementSection => {
    const codes = Array.from(pnlLines.keys()).sort((a, b) => {
      const ma = pnlLines.get(a)!;
      const mb = pnlLines.get(b)!;
      return ma.displayOrder - mb.displayOrder || a.localeCompare(b);
    });
    const rws: StatementRowDTO[] = [];
    const lineTotals: bigint[] = [];
    for (const code of codes) {
      const meta = metaByCode.get(code)!;
      const agg = byLine[classificationFilter][code];
      if (!agg) continue;
      const total = totalOf(agg.values);
      lineTotals.push(total);
      // 6.9R (R7): صف بلا أي قيمة مشتقّة ⇒ null مع الحالة الناقصة — لا صفر يوحي بحركة صفرية.
      const noDerivedValue = agg.values.length === 0 && agg.incomplete;
      rws.push({
        kind: "LINE",
        key: code,
        label: meta.nameAr,
        statementLineCode: code,
        valueMinor: noDerivedValue ? null : total.toString(),
        valueStatus: agg.incomplete ? "INCOMPLETE_DATA" : "OK",
        depth: meta.parentId ? 1 : 0,
        accounts: agg.accounts,
      });
    }
    for (const a of key === "REVENUE" ? unattachedRevenue : unattachedExpenses) {
      const v = a.valueMinor === null ? null : BigInt(a.valueMinor);
      if (v !== null) lineTotals.push(v);
      rws.push({
        kind: "ACCOUNT_GROUP",
        key: `unattached-${a.accountCode}`,
        label: `${a.accountName} (بلا بند قائمة)`,
        statementLineCode: null,
        valueMinor: a.valueMinor,
        valueStatus: "OK",
        depth: 1,
      });
    }
    const total = totalOf(lineTotals);
    rws.push({
      kind: "TOTAL",
      key: `total-${key}`,
      label: key === "REVENUE" ? "إجمالي الإيرادات" : "إجمالي المصروفات",
      statementLineCode: null,
      valueMinor: total.toString(),
      valueStatus: "OK",
      depth: 0,
    });
    return { key, title, rows: rws, totalMinor: total.toString() };
  };

  const revenue = buildSection("REVENUE", "الإيرادات", "REVENUE");
  const expenses = buildSection("EXPENSES", "المصروفات", "EXPENSE");
  const netResult = BigInt(revenue.totalMinor) - BigInt(expenses.totalMinor);

  // OCI — فقط عند وجود حسابات مرتبطة ببنود OCI فعليًا
  let oci: ProfitOrLossStatement["oci"] = null;
  let ociStatus: ProfitOrLossStatement["ociStatus"] = "NO_DATA";
  const ociCodes = Array.from(ociLines.keys()).sort((a, b) => ociLines.get(a)!.displayOrder - ociLines.get(b)!.displayOrder);
  const hasOciAccounts = ociCodes.some((c) => (byOciLine[c]?.accounts?.length ?? 0) > 0);
  if (hasOciAccounts) {
    ociStatus = "PRESENT";
    const rws: StatementRowDTO[] = [];
    const vals: bigint[] = [];
    for (const code of ociCodes) {
      const agg = byOciLine[code];
      if (!agg) continue;
      const total = totalOf(agg.values);
      vals.push(total);
      rws.push({
        kind: "LINE",
        key: code,
        label: ociLines.get(code)!.nameAr,
        statementLineCode: code,
        valueMinor: total.toString(),
        valueStatus: "OK",
        depth: 0,
        accounts: agg.accounts,
      });
    }
    const ociTotal = totalOf(vals);
    rws.push({ kind: "TOTAL", key: "total-OCI", label: "إجمالي الدخل الشامل الآخر", statementLineCode: null, valueMinor: ociTotal.toString(), valueStatus: "OK", depth: 0 });
    oci = { section: { key: "OCI", title: "الدخل الشامل الآخر", rows: rws, totalMinor: ociTotal.toString() }, totalMinor: ociTotal.toString() };
  }
  const tci = netResult + (oci ? BigInt(oci.totalMinor) : BigInt(0));

  // أعمدة المقارنة (الصفوف المشتركة بالكود) — غياب السابقة لا يمنع العرض
  if (previousRows) {
    const prevValue = (lineCode: string | null, accounts: StatementRowDTO["accounts"] | undefined): string | null => {
      if (!accounts) return null;
      let t = BigInt(0);
      let any = false;
      for (const a of accounts) {
        const pr = prevByCode.get(a.accountCode);
        if (pr && pr.valueMinor !== null) {
          any = true;
          t += present(pr.valueMinor, pr.classification) ?? BigInt(0);
        }
      }
      return any ? t.toString() : null;
    };
    for (const r of [...revenue.rows, ...expenses.rows, ...(oci?.section.rows ?? [])]) {
      if (r.kind === "LINE" || r.kind === "ACCOUNT_GROUP") {
        r.previousValueMinor = prevValue(r.statementLineCode, r.accounts);
      }
    }
  }

  return {
    kind: "PROFIT_OR_LOSS",
    revenue,
    expenses,
    netResultMinor: netResult.toString(),
    oci,
    ociStatus,
    totalComprehensiveIncomeMinor: tci.toString(),
    completeness: completenessOf(rows),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * قائمة المركز المالي
 * ────────────────────────────────────────────────────────────────────────── */

export function buildFinancialPosition(
  rows: readonly StatementInputRow[],
  lineMeta: readonly StatementLineMeta[],
  netResult: { valueMinor: bigint | null; status: string },
  previousRows?: readonly StatementInputRow[]
): FinancialPositionStatement {
  const metaByCode = new Map(lineMeta.map((m) => [m.code, m]));
  const sfpLines = lineMeta.filter((m) => m.statementType === "STATEMENT_OF_FINANCIAL_POSITION");
  const prevByCode = new Map((previousRows ?? []).map((r) => [r.accountCode, r]));

  interface Acc { accountCode: string; accountName: string; value: bigint | null; prev: bigint | null }
  const buckets: Record<"ASSET" | "LIABILITY" | "EQUITY", Acc[]> = { ASSET: [], LIABILITY: [], EQUITY: [] };
  const unclassified: Acc[] = [];

  for (const r of rows) {
    const acc: Acc = {
      accountCode: r.accountCode,
      accountName: r.accountName || r.accountCode,
      value: present(r.valueMinor, r.classification),
      prev: (() => {
        const pr = prevByCode.get(r.accountCode);
        if (!pr || pr.valueMinor === null) return null;
        return present(pr.valueMinor, pr.classification);
      })(),
    };
    if (r.classification === "ASSET") buckets.ASSET.push(acc);
    else if (r.classification === "LIABILITY") buckets.LIABILITY.push(acc);
    else if (r.classification === "EQUITY") buckets.EQUITY.push(acc);
    else if (r.classification === "REVENUE" || r.classification === "EXPENSE") {
      // حسابات FLOW لا تنتمي للمركز المالي — أثرها يُعرض عبر «صافي نتيجة الفترة».
      continue;
    } else unclassified.push(acc);
  }

  const buildSection = (key: "ASSET" | "LIABILITY" | "EQUITY", title: string): StatementSection => {
    const rws: StatementRowDTO[] = [];
    // مجموعات الجذر (parentId = null) ثم أوراقها — الترتيب displayOrder
    const roots = sfpLines.filter((m) => m.parentId === null).sort((a, b) => a.displayOrder - b.displayOrder);
    // byParent مفتاحه **كود** الأب — parentId المخزن هو id فيُترجم عبر codeById.
    const codeById = new Map(lineMeta.map((m) => [m.id, m.code]));
    const byParent = new Map<string, StatementLineMeta[]>();
    for (const m of sfpLines) {
      if (!m.parentId) continue;
      const parentCode = codeById.get(m.parentId);
      if (!parentCode) continue;
      (byParent.get(parentCode) ?? byParent.set(parentCode, []).get(parentCode)!).push(m);
    }
    const accountsByLine = new Map<string, Acc[]>();
    for (const acc of buckets[key]) {
      const code = rows.find((r) => r.accountCode === acc.accountCode)?.statementLineCode ?? null;
      if (code && sfpLines.some((m) => m.code === code)) {
        (accountsByLine.get(code) ?? accountsByLine.set(code, []).get(code)!).push(acc);
      }
    }
    const renderedCodes = new Set<string>(); // 6.9R: حاجز «لا قيمة تضيع» — كل حساب معروض يُسجل هنا
    for (const g of roots) {
      const children = byParent.get(g.code) ?? [];
      const leafRows: StatementRowDTO[] = [];
      let groupTotal = BigInt(0);
      const renderLeaf = (leaf: StatementLineMeta) => {
        const accs = accountsByLine.get(leaf.code) ?? [];
        if (accs.length === 0) return;
        const total = totalOf(accs.map((a) => a.value));
        groupTotal += total;
        for (const a of accs) renderedCodes.add(a.accountCode);
        leafRows.push({
          kind: "LINE",
          key: leaf.code,
          label: leaf.nameAr,
          statementLineCode: leaf.code,
          valueMinor: total.toString(),
          valueStatus: "OK",
          depth: 1,
          accounts: accs.map((a) => ({ accountCode: a.accountCode, accountName: a.accountName, valueMinor: a.value === null ? null : a.value.toString() })),
        });
      };
      if (children.length > 0) {
        for (const leaf of children.sort((a, b) => a.displayOrder - b.displayOrder)) renderLeaf(leaf);
        // 6.9R (عهدة A — جذر خلل المركز المالي): الحسابات المربوطة بالبند الرئيسي نفسه
        // (ذو الأبناء) لا تُسقط صمتًا — صف LINE شفاف تحت المجموعة يدخل groupTotal.
        const direct = accountsByLine.get(g.code) ?? [];
        if (direct.length > 0) {
          const total = totalOf(direct.map((a) => a.value));
          groupTotal += total;
          for (const a of direct) renderedCodes.add(a.accountCode);
          leafRows.push({
            kind: "LINE",
            key: `${g.code}::direct`,
            label: "حسابات معروضة على البند الرئيسي مباشرة",
            statementLineCode: g.code,
            valueMinor: total.toString(),
            valueStatus: "OK",
            depth: 1,
            accounts: direct.map((a) => ({ accountCode: a.accountCode, accountName: a.accountName, valueMinor: a.value === null ? null : a.value.toString() })),
          });
        }
      } else {
        renderLeaf(g);
      }
      if (leafRows.length > 0) {
        rws.push({
          kind: "LINE",
          key: g.code,
          label: g.nameAr,
          statementLineCode: g.code,
          valueMinor: groupTotal.toString(), // المجموعة = Σ أبنائها (domain-driven)
          valueStatus: "OK",
          depth: 0,
        });
        rws.push(...leafRows);
      }
    }
    // 6.9R (عهدة A): حاجز renderedAccountCodes — أي حساب قسم لم تعرضه شجرة البنود
    // (بند عميق لا يزوره المسح، أو بلا بند) يظهر صفًا شفافًا ويدخل الإجمالي — لا قيمة تضيع إطلاقًا.
    const fallthrough = buckets[key].filter((a) => !renderedCodes.has(a.accountCode));
    for (const a of fallthrough) {
      const code = rows.find((r) => r.accountCode === a.accountCode)?.statementLineCode ?? null;
      const hasLine = !!code && sfpLines.some((m) => m.code === code);
      rws.push({
        kind: "ACCOUNT_GROUP",
        key: `unattached-${a.accountCode}`,
        label: hasLine ? `${a.accountName} (بند قائمة لم تُعرض تفاصيله)` : `${a.accountName} (بلا بند قائمة)`,
        statementLineCode: hasLine ? code : null,
        valueMinor: a.value === null ? null : a.value.toString(),
        valueStatus: a.value === null ? "INCOMPLETE_DATA" : "OK",
        depth: 1,
      });
    }
    // إجمالي القسم = بنود مرتبطة + الصفوف الشفافة (بالتصنيف حصرًا — لا plug)
    const attachedTotal = totalOf(rws.filter((r) => r.kind === "LINE" && r.statementLineCode !== null && r.depth === 0).map((r) => (r.valueMinor === null ? null : BigInt(r.valueMinor))));
    const grand = attachedTotal + totalOf(fallthrough.map((a) => a.value));
    rws.push({
      kind: "GRAND_TOTAL",
      key: `total-${key}`,
      label: key === "ASSET" ? "إجمالي الأصول" : key === "LIABILITY" ? "إجمالي الالتزامات" : "إجمالي حقوق الملكية",
      statementLineCode: null,
      valueMinor: grand.toString(),
      valueStatus: "OK",
      depth: 0,
    });
    return { key, title, rows: rws, totalMinor: grand.toString() };
  };

  const assets = buildSection("ASSET", "الأصول");
  const liabilities = buildSection("LIABILITY", "الالتزامات");
  const equity = buildSection("EQUITY", "حقوق الملكية");

  // نتيجة الفترة داخل حقوق الملكية (إن أمكن حسابها) — لا صفر مؤكد عند عدم الجاهزية
  const netResultRowMinor = netResult.valueMinor === null ? null : netResult.valueMinor.toString();
  if (netResultRowMinor !== null) {
    equity.totalMinor = (BigInt(equity.totalMinor) + netResult.valueMinor!).toString();
    equity.rows = [
      ...equity.rows.slice(0, -1),
      {
        kind: "NET_RESULT",
        key: "net-result-fy",
        label: "صافي نتيجة الفترة المالية حتى تاريخه",
        statementLineCode: null,
        valueMinor: netResultRowMinor,
        valueStatus: netResult.status,
        depth: 1,
      },
      equity.rows[equity.rows.length - 1],
    ];
  } else {
    equity.rows = [
      ...equity.rows.slice(0, -1),
      {
        kind: "NET_RESULT",
        key: "net-result-fy",
        label: "صافي نتيجة الفترة المالية حتى تاريخه",
        statementLineCode: null,
        valueMinor: null,
        valueStatus: netResult.status,
        depth: 1,
      },
      equity.rows[equity.rows.length - 1],
    ];
  }

  const assetsMinor = BigInt(assets.totalMinor);
  const liabPlusEq = BigInt(liabilities.totalMinor) + BigInt(equity.totalMinor);
  const difference = assetsMinor - liabPlusEq;

  return {
    kind: "STATEMENT_OF_FINANCIAL_POSITION",
    assets,
    liabilities,
    equity,
    netResultRowMinor,
    netResultRowStatus: netResult.status,
    equation: {
      assetsMinor: assetsMinor.toString(),
      liabilitiesPlusEquityMinor: liabPlusEq.toString(),
      differenceMinor: difference.toString(),
      balanced: difference === BigInt(0),
    },
    unclassified: {
      rows: unclassified.map((a) => ({ accountCode: a.accountCode, accountName: a.accountName, valueMinor: a.value === null ? null : a.value.toString() })),
      totalMinor: totalOf(unclassified.map((a) => a.value)).toString(),
    },
    completeness: completenessOf(rows),
  };
}

/** حاجز اتساق إعادة استخدام — تصنيف القائمة لا يخالف نوع البند. */
export { isStatementLineConsistent };
