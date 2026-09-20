/**
 * Account Matching & Income Statement Comparison Logic
 *
 * Implements a comparative Statement of Profit or Loss and Other Comprehensive
 * Income under IFRS (IAS 1 — function-of-expense method).
 *
 * Key conventions:
 *  - Revenue (sales, other income, OCI) is credit-positive:  net = دائن − مدين
 *  - Expenses (cost, selling, admin, finance, tax) are debit-positive: net = مدين − دائن
 *  - Discounts / returns appear as NEGATIVE amounts in parentheses.
 *  - Current period columns come first, comparative period second.
 *  - Totals are computed from LEAF accounts only (parents shown bold but not summed).
 *  - Revenue total uses the base account's own balance.
 */

import * as XLSX from "xlsx-js-style";
import * as JSZip from "jszip";

/* ──────────────────────────────────────────────────────────────────────────
 * Types
 * ────────────────────────────────────────────────────────────────────────── */

export interface AccountRow {
  nm: string;
  nk: string;
  num: string | null;
  m: number; // مدين (debit)
  d: number; // دائن (credit)
}

export interface FileData {
  A: AccountRow[];
  headers: string[];
  nameCol: number;
  /** Column index of the account number. Defaults to 0 when not detected. */
  numCol: number;
  debitCol: number;
  headerRow: number;
  rawRows: unknown[][];
}

export interface MatchedRow {
  nk: string;
  a1: AccountRow | null;
  a2: AccountRow | null;
  st: MatchStatus;
  /** Chart-of-accounts mode only: name similarity 0-100 (null when unmatched). */
  sim?: number | null;
  /** Chart-of-accounts mode only: category name in file 1. */
  cat1?: string;
  /** Chart-of-accounts mode only: category name in file 2. */
  cat2?: string;
  /** Chart-of-accounts mode only: true if num changed between files. */
  numChanged?: boolean;
  /** Chart-of-accounts mode only: true if account moved to a different category. */
  catChanged?: boolean;
  /** Chart-of-accounts mode only: true if account name changed between files. */
  nameChanged?: boolean;
  /** Chart-of-accounts mode only: how the match was made. */
  matchBy?: "both" | "name" | "number";
  /** Chart-of-accounts mode only: account balance in file 1 (debit−credit). */
  amt1?: number | null;
  /** Chart-of-accounts mode only: account balance in file 2 (debit−credit). */
  amt2?: number | null;
  /** Chart-of-accounts mode only: amount change = amt2 − amt1. */
  amtChange?: number | null;
  /** Chart-of-accounts mode only: percentage change = (amt2−amt1)/|amt1|*100. */
  amtChangePct?: number | null;
}

export type MatchStatus =
  | "مطابق"                    // both name AND number match → Sheet 1
  | "مطابق الاسم مختلف الرقم"   // name matches (≥90%), number differs, same category → Sheet 2
  | "تغير جوهري"               // fundamental change (category shift OR rename OR both differ) → Sheet 4
  | "في الملف الأول فقط"        // unmatched → Sheet 3
  | "في الملف الثاني فقط"        // unmatched → Sheet 3
  | "غير مطابق";                 // generic unmatched fallback → Sheet 3

export interface CategorySettings {
  /** Net-sales base account key (nk). */
  base: string | null;
  costPrefix: string; // cp — تكلفة الإيرادات
  sellPrefix: string; // sp — البيع والتوزيع
  adminPrefix: string; // gp — الإدارية والعمومية
  otherOpPrefix: string; // op — تشغيلية أخرى
  financePrefix: string; // fp — التمويل
  taxPrefix: string; // tp — ضريبة الدخل
  ociPrefix: string; // ocip — الدخل الشامل الآخر
}

export interface Categorized {
  sales: MatchedRow[]; // revenue tree (excl. base)
  cost: MatchedRow[]; // cost of sales
  sell: MatchedRow[]; // selling & distribution
  adm: MatchedRow[]; // general & administrative
  oth: MatchedRow[]; // other operating
  fin: MatchedRow[]; // finance costs
  tax: MatchedRow[]; // income tax
  oci: MatchedRow[]; // other comprehensive income
  othRev: MatchedRow[]; // other income (non-3 accounts, not in sales tree)
  net: MatchedRow[]; // صافي الدخل — excluded from calc, used for reconciliation
}

export interface Totals {
  rev1: number; rev2: number;
  cost1: number; cost2: number;
  gross1: number; gross2: number;
  sell1: number; sell2: number;
  adm1: number; adm2: number;
  oth1: number; oth2: number;
  opex1: number; opex2: number;
  oper1: number; oper2: number;
  othRev1: number; othRev2: number;
  fin1: number; fin2: number;
  pbt1: number; pbt2: number;
  tax1: number; tax2: number;
  net1: number; net2: number;
  oci1: number; oci2: number;
  comp1: number; comp2: number;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Normalization helpers
 * ────────────────────────────────────────────────────────────────────────── */

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function normalizeName(v: unknown): string {
  let t = String(v ?? "").normalize("NFKC");
  t = t.replace(/[\u200B-\u200F\uFEFF]/g, "");
  t = t.replace(/[\u064B-\u065F\u0670\u0640]/g, "");
  t = t.replace(/[^\w\u0600-\u06FF\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim().toLowerCase();
  t = t.replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[أإآ]/g, "ا");
  return t;
}

export function parseAmount(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  let s = String(v)
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[,،\s]/g, "");
  const neg = s[0] === "-";
  s = s.replace(/[-*]+/g, "");
  const x = parseFloat(s);
  return Number.isNaN(x) ? 0 : neg ? -x : x;
}

export function parseAccountNum(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return String(Math.round(v));
  const s = String(v)
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .trim();
  const d = s.replace(/\D/g, "");
  return d ? d.replace(/^0+(?=.)/, "") || "0" : null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Excel parsing
 * ────────────────────────────────────────────────────────────────────────── */

export function readExcelFile(file: File): Promise<FileData> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = (e) => {
      try {
        const buf = e.target?.result;
        if (!buf) throw new Error("ملف فارغ");
        const wb = XLSX.read(buf, { type: "array" });
        const sh = wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sh], {
          header: 1, raw: true, defval: null,
        });
        let hi = -1;
        const cap = Math.min(rows.length, 30);
        for (let i = 0; i < cap; i++) {
          const cells = (rows[i] || []).map((c) => String(c ?? "").trim());
          for (let j = 0; j < cells.length; j++) {
            if (cells[j].indexOf("اسم الحساب") >= 0) { hi = i; break; }
          }
          if (hi >= 0) break;
        }
        if (hi < 0) throw new Error("لا يوجد عمود «اسم الحساب»");
        const hdr = rows[hi].map((c) => String(c ?? "").trim());
        const sub = (rows[hi + 1] || []).map((c) => String(c ?? "").trim());
        let cN = 1, cD = -1, cNum = -1;
        for (let j = 0; j < hdr.length; j++) {
          const h = hdr[j];
          if (h.indexOf("اسم الحساب") >= 0) cN = j;
          if (sub[j] === "مدين" || h === "مدين") cD = j;
        }
        // Detect account number column AFTER name column — avoid picking "اسم الحساب"
        for (let j = 0; j < hdr.length; j++) {
          const h = hdr[j];
          if (j === cN) continue; // skip the name column
          if (
            h.indexOf("رقم الحساب") >= 0 ||
            h.indexOf("رقم") >= 0 ||
            h === "الحساب" ||
            h === "الرقم" ||
            h === "حساب"
          ) { cNum = j; break; }
        }
        if (cNum < 0) cNum = 0; // fallback: column 0
        if (cD < 0) {
          for (let j = 0; j < hdr.length; j++) {
            if (hdr[j] === "المبلغ") { cD = j; break; }
          }
        }
        if (cD < 0) cD = cN + 2;
        const A: AccountRow[] = [];
        for (let i = hi + 1; i < rows.length; i++) {
          const r = rows[i] || [];
          const g = (j: number) => (j >= 0 && j < r.length ? r[j] : null);
          const n = String(g(cN) ?? "").trim();
          if (!n || n === "*") continue;
          if (n.indexOf("الإجمالي") >= 0 || n.indexOf("الرصيد") >= 0) continue;
          A.push({ nm: n, nk: normalizeName(n), num: parseAccountNum(g(cNum)), m: parseAmount(g(cD)), d: parseAmount(g(cD + 1)) });
        }
        resolve({ A, headers: hdr, nameCol: cN, numCol: cNum, debitCol: cD, headerRow: hi, rawRows: rows });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    fr.onerror = () => reject(new Error("فشل قراءة الملف"));
    fr.readAsArrayBuffer(file);
  });
}

export function reExtract(file: FileData, nameCol: number, debitCol: number): AccountRow[] {
  // Files restored from a saved report (فتح تقرير محفوظ) carry pre-extracted rows
  // and NO raw sheet (rawRows = []). Re-parsing would yield an empty array and wipe
  // out the base-account selection — keep the stored rows as-is in that case.
  if (!file.rawRows || file.rawRows.length === 0) return file.A;
  const rows = file.rawRows;
  const hi = file.headerRow;
  const numCol = file.numCol ?? 0;
  const A: AccountRow[] = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const g = (j: number) => (j >= 0 && j < r.length ? r[j] : null);
    const n = String(g(nameCol) ?? "").trim();
    if (!n || n === "*") continue;
    if (n.indexOf("الإجمالي") >= 0 || n.indexOf("الرصيد") >= 0) continue;
    A.push({ nm: n, nk: normalizeName(n), num: parseAccountNum(g(numCol)), m: parseAmount(g(debitCol)), d: parseAmount(g(debitCol + 1)) });
  }
  return A;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Matching
 * ────────────────────────────────────────────────────────────────────────── */

export function matchFiles(f1: FileData, f2: FileData): MatchedRow[] {
  const out: MatchedRow[] = [];
  const m2: Record<string, AccountRow[]> = {};
  for (const a of f2.A) { (m2[a.nk] ||= []).push(a); }
  for (const a1 of f1.A) {
    const q = m2[a1.nk];
    out.push({ nk: a1.nk, a1, a2: q && q.length ? q.shift()! : null, st: "مطابق" });
  }
  for (const k in m2) for (const a2 of m2[k]) out.push({ nk: k, a1: null, a2, st: "مطابق" });
  for (const r of out) {
    r.st = r.a1 && r.a2 ? "مطابق" : r.a1 ? "في الملف الأول فقط" : "في الملف الثاني فقط";
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Chart-of-Accounts Matching — مطابقة دليل الحسابات
 *
 * Matches accounts by NAME AND NUMBER (OR logic):
 *  - Name match   — normalized name similarity >= threshold (default 90%)
 *  - Number match — account numbers are identical (exact match)
 *
 * Priority: both > number-only > name-only.
 * Statuses: مطابق / تغير اسم / تغير رقم / تغير الموقع / في الملف الأول فقط / في الملف الثاني فقط
 * ════════════════════════════════════════════════════════════════════════════ */

/** Levenshtein edit distance between two strings (classic DP). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

/** Name similarity ratio in [0, 1]. Levenshtein normalized by max length. */
export function nameSimilarity(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Character-level LCS-based diff. Returns segments of {text, op}. */
export type DiffOp = "same" | "add" | "del";
export interface DiffSegment { text: string; op: DiffOp; }

export function diffStrings(a: string, b: string): DiffSegment[] {
  if (!a && !b) return [];
  if (!a) return [{ text: b, op: "add" }];
  if (!b) return [{ text: a, op: "del" }];
  if (a === b) return [{ text: a, op: "same" }];
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const segs: DiffSegment[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
      segs.push({ text: a[i - 1], op: "same" }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      segs.push({ text: b[j - 1], op: "add" }); j--;
    } else {
      segs.push({ text: a[i - 1], op: "del" }); i--;
    }
  }
  segs.reverse();
  const merged: DiffSegment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.op === s.op) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged;
}

/** Compact human-readable diff summary for Excel: "−X +Y" or "مطابق تام". */
export function summarizeDiff(a: string, b: string): string {
  if (!a || !b) return "—";
  if (a === b) return "مطابق تام";
  const diff = diffStrings(a, b);
  let removed = "";
  let added = "";
  for (const s of diff) {
    if (s.op === "del") removed += s.text;
    else if (s.op === "add") added += s.text;
  }
  const parts: string[] = [];
  if (removed) parts.push(`−${removed}`);
  if (added) parts.push(`+${added}`);
  return parts.length ? parts.join(" ") : "مطابق تام";
}

/**
 * Account category by leading digit of account number.
 *
 * 4-category classification (per user's exact specification):
 *   1 → أصول       (assets)
 *   2 → خصوم       (liabilities)
 *   3 → مصروفات    (expenses — per user request, NOT equity)
 *   4 → إيرادات    (revenues)
 *   5 → مصروفات    (expenses — folded under expenses)
 *   6 → مصروفات    (taxes folded under expenses)
 *   7 → إيرادات    (other revenues folded under revenues)
 *   other → غير محدد
 */
export function accountCategory(num: string | null): string {
  if (!num) return "غير محدد";
  const d = num.charAt(0);
  switch (d) {
    case "1": return "أصول";
    case "2": return "خصوم";
    case "3":
    case "5":
    case "6": return "مصروفات";
    case "4":
    case "7": return "إيرادات";
    default: return "غير محدد";
  }
}

/**
 * Match two charts of accounts by NAME AND NUMBER (OR logic).
 * A pair is a candidate if EITHER number matches exactly OR name sim >= threshold.
 * Priority: both > number-only > name-only.
 */
export function matchChartOfAccounts(
  f1: FileData,
  f2: FileData,
  threshold = 0.9
): MatchedRow[] {
  const a1s = f1.A.slice();
  const a2s = f2.A.slice();
  type Pair = { i: number; j: number; sim: number; numMatch: boolean; nameMatch: boolean };
  const pairs: Pair[] = [];
  for (let i = 0; i < a1s.length; i++) {
    const a1 = a1s[i];
    if (!a1.nk && !a1.num) continue;
    for (let j = 0; j < a2s.length; j++) {
      const a2 = a2s[j];
      if (!a2.nk && !a2.num) continue;
      const numMatch = !!a1.num && !!a2.num && a1.num === a2.num;
      const sim = nameSimilarity(a1.nk, a2.nk);
      const nameMatch = sim >= threshold;
      if (numMatch || nameMatch) {
        pairs.push({ i, j, sim, numMatch, nameMatch });
      }
    }
  }
  function pairPriority(p: Pair): number {
    if (p.numMatch && p.nameMatch) return 3;
    if (p.numMatch) return 2;
    return 1;
  }
  pairs.sort((x, y) => {
    const px = pairPriority(x);
    const py = pairPriority(y);
    if (px !== py) return py - px;
    return y.sim - x.sim;
  });

  const used1 = new Set<number>();
  const used2 = new Set<number>();
  const out: MatchedRow[] = [];

  for (const p of pairs) {
    if (used1.has(p.i) || used2.has(p.j)) continue;
    used1.add(p.i);
    used2.add(p.j);
    const a1 = a1s[p.i];
    const a2 = a2s[p.j];
    const cat1 = accountCategory(a1.num);
    const cat2 = accountCategory(a2.num);
    const numChanged = (a1.num ?? null) !== (a2.num ?? null);
    const catChanged = cat1 !== cat2;
    const nameChanged = a1.nk !== a2.nk;
    let matchBy: "both" | "name" | "number";
    if (p.numMatch && p.nameMatch) matchBy = "both";
    else if (p.numMatch) matchBy = "number";
    else matchBy = "name";

    // ── 4-sheet classification (per user's new requirement) ──
    // Sheet 1 «مطابق الاسم والرقم»:   name AND number both match (priority to name)
    // Sheet 2 «مطابق الاسم مختلف الرقم»: name matches, number differs (any category)
    // Sheet 3 «غير مطابق الاسم»:        unmatched (in one file only) — handled below
    // Sheet 4 «التغير الجوهري»:         category CHANGED between the two files
    //                                    (e.g. account moved from أصول to خصوم,
    //                                     or from مصروفات to إيرادات)
    let st: MatchStatus;
    if (catChanged) {
      // Category change is the fundamental change → Sheet 4
      st = "تغير جوهري";
    } else if (!numChanged && !nameChanged) {
      // Both name AND number match → Sheet 1
      st = "مطابق";
    } else if (!nameChanged && numChanged) {
      // Name matches, number differs, same category → Sheet 2
      st = "مطابق الاسم مختلف الرقم";
    } else {
      // nameChanged && numChanged (both differ) — matched by one criterion only
      // Same category, but both name AND number differ
      // → keep in Sheet 2 if matched by name (name is the priority criterion)
      // → otherwise keep in Sheet 2 too (the user wants name-priority matching)
      st = "مطابق الاسم مختلف الرقم";
    }
    // Compute amount change + change percentage (debit−credit balance)
    const amt1 = a1.m - a1.d;
    const amt2 = a2.m - a2.d;
    const amtChange = amt2 - amt1;
    const amtChangePct = amt1 !== 0 ? (amtChange / Math.abs(amt1)) * 100 : null;
    out.push({
      nk: a1.nk, a1, a2, st,
      sim: Math.round(p.sim * 100),
      cat1, cat2,
      numChanged, catChanged, nameChanged, matchBy,
      amt1, amt2, amtChange, amtChangePct,
    });
  }

  for (let i = 0; i < a1s.length; i++) {
    if (used1.has(i)) continue;
    const a1 = a1s[i];
    out.push({
      nk: a1.nk, a1, a2: null, st: "في الملف الأول فقط",
      sim: null, cat1: accountCategory(a1.num), cat2: undefined,
      numChanged: false, catChanged: false, nameChanged: false, matchBy: undefined,
      amt1: a1.m - a1.d, amt2: null, amtChange: null, amtChangePct: null,
    });
  }
  for (let j = 0; j < a2s.length; j++) {
    if (used2.has(j)) continue;
    const a2 = a2s[j];
    out.push({
      nk: a2.nk, a1: null, a2, st: "في الملف الثاني فقط",
      sim: null, cat1: undefined, cat2: accountCategory(a2.num),
      numChanged: false, catChanged: false, nameChanged: false, matchBy: undefined,
      amt1: null, amt2: a2.m - a2.d, amtChange: null, amtChangePct: null,
    });
  }

  // Sort: matched → name-match-num-diff → fundamental → unmatched
  const order: Record<MatchStatus, number> = {
    "مطابق": 0,
    "مطابق الاسم مختلف الرقم": 1,
    "تغير جوهري": 2,
    "في الملف الأول فقط": 3,
    "في الملف الثاني فقط": 4,
    "غير مطابق": 5,
  };
  out.sort((x, y) => {
    const o = order[x.st] - order[y.st];
    if (o !== 0) return o;
    const sx = x.sim ?? -1;
    const sy = y.sim ?? -1;
    return sy - sx;
  });
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Base account selection
 * ────────────────────────────────────────────────────────────────────────── */

export interface BaseOption { nk: string; nm: string; num: string | null; sc: number; }

export function collectBaseOptions(files: (FileData | null)[]): BaseOption[] {
  const seen: Record<string, true> = {};
  const opts: BaseOption[] = [];
  for (const d of files) {
    if (!d) continue;
    for (const a of d.A) {
      if (seen[a.nk]) continue;
      seen[a.nk] = true;
      const x = normalizeName(a.nm);
      const sc = x.indexOf("صافي") >= 0 && x.indexOf("مبيعات") >= 0 ? 0 : x.indexOf("مبيعات") >= 0 ? 1 : 2;
      opts.push({ nk: a.nk, nm: a.nm, num: a.num ?? null, sc });
    }
  }
  opts.sort((a, b) => a.sc - b.sc);
  return opts;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Categorization — prefix-based (IAS 1 function-of-expense)
 * ────────────────────────────────────────────────────────────────────────── */

export function categorize(out: MatchedRow[], settings: CategorySettings): Categorized {
  const { base, costPrefix, sellPrefix, adminPrefix, otherOpPrefix, financePrefix, taxPrefix, ociPrefix } = settings;

  const ba = base ? out.find((r) => r.nk === base) ?? null : null;
  const netRow = findNetRow(out);
  const baseNum = (ba?.a1?.num ?? ba?.a2?.num ?? null) ?? null;

  const cat: Categorized = {
    sales: [], cost: [], sell: [], adm: [], oth: [], fin: [], tax: [], oci: [], othRev: [], net: [],
  };

  for (const r of out) {
    // Exclude base and net-income summary rows from categorization
    if (r === ba || r === netRow) continue;

    const num = String((r.a1?.num ?? r.a2?.num ?? "") as string);

    // Revenue tree — accounts whose number starts with base number
    if (baseNum && num && num.indexOf(baseNum) === 0) { cat.sales.push(r); continue; }
    // Cost of sales
    if (costPrefix && num && num.indexOf(costPrefix) === 0) { cat.cost.push(r); continue; }
    // Selling & distribution
    if (sellPrefix && num && num.indexOf(sellPrefix) === 0) { cat.sell.push(r); continue; }
    // General & administrative
    if (adminPrefix && num && num.indexOf(adminPrefix) === 0) { cat.adm.push(r); continue; }
    // Other operating
    if (otherOpPrefix && num && num.indexOf(otherOpPrefix) === 0) { cat.oth.push(r); continue; }
    // Finance
    if (financePrefix && num && num.indexOf(financePrefix) === 0) { cat.fin.push(r); continue; }
    // Tax
    if (taxPrefix && num && num.indexOf(taxPrefix) === 0) { cat.tax.push(r); continue; }
    // OCI
    if (ociPrefix && num && num.indexOf(ociPrefix) === 0) { cat.oci.push(r); continue; }
    // Unprefixed accounts starting with "3" → other operating
    if (num && num.indexOf("3") === 0) { cat.oth.push(r); continue; }
    // Everything else → other income
    cat.othRev.push(r);
  }

  const byNum = (a: MatchedRow, b: MatchedRow) => {
    const x = String((a.a1?.num ?? a.a2?.num ?? "") as string);
    const y = String((b.a1?.num ?? b.a2?.num ?? "") as string);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  cat.sales.sort(byNum); cat.cost.sort(byNum); cat.sell.sort(byNum);
  cat.adm.sort(byNum); cat.oth.sort(byNum); cat.fin.sort(byNum);
  cat.tax.sort(byNum); cat.oci.sort(byNum); cat.othRev.sort(byNum);
  return cat;
}

/** Find the "صافي الدخل" summary row (for reconciliation). */
export function findNetRow(out: MatchedRow[]): MatchedRow | null {
  for (const r of out) {
    const n = normalizeName((r.a1 ?? r.a2)?.nm ?? "");
    if (n.indexOf("صافي الدخل") >= 0 || n.indexOf("صافي دخ") >= 0) return r;
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Leaf detection — parents are shown bold but excluded from totals
 * ────────────────────────────────────────────────────────────────────────── */

export interface RowLeafInfo {
  leaf1: boolean;
  leaf2: boolean;
}

export function leafInfo(rows: MatchedRow[]): RowLeafInfo[] {
  return rows.map((r, i) => {
    let leaf1 = false, leaf2 = false;
    const a1 = r.a1;
    if (a1 && a1.num) {
      leaf1 = true;
      for (let j = 0; j < rows.length; j++) {
        if (j === i) continue;
        const o = rows[j].a1;
        if (!o || !o.num) continue;
        if (o.num.length > a1.num.length && o.num.indexOf(a1.num) === 0) { leaf1 = false; break; }
      }
    }
    const a2 = r.a2;
    if (a2 && a2.num) {
      leaf2 = true;
      for (let j = 0; j < rows.length; j++) {
        if (j === i) continue;
        const o = rows[j].a2;
        if (!o || !o.num) continue;
        if (o.num.length > a2.num.length && o.num.indexOf(a2.num) === 0) { leaf2 = false; break; }
      }
    }
    return { leaf1, leaf2 };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Totals — IFRS cascade with credit/debit sign convention
 * ────────────────────────────────────────────────────────────────────────── */

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Sum LEAF accounts of a category on one file side.
 * @param isRevenue  true → credit-positive (دائن − مدين), false → debit-positive (مدين − دائن)
 */
function sumLeaves(
  rows: MatchedRow[], info: RowLeafInfo[], side: "a1" | "a2", isRevenue: boolean
): number {
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    const isLeaf = side === "a1" ? info[i].leaf1 : info[i].leaf2;
    if (!isLeaf) continue;
    const a = rows[i][side]!;
    s += isRevenue ? a.d - a.m : a.m - a.d;
  }
  return r2(s);
}

/**
 * Compute all income-statement totals.
 * @param baseRow  The selected net-sales account (its OWN balance = revenue).
 */
export function calcTotals(
  cat: Categorized,
  baseRow: MatchedRow | null
): Totals {
  // Revenue = base account's own balance (credit − debit)
  const rev1 = baseRow?.a1 ? r2(baseRow.a1.d - baseRow.a1.m) : 0;
  const rev2 = baseRow?.a2 ? r2(baseRow.a2.d - baseRow.a2.m) : 0;

  const iCost = leafInfo(cat.cost);
  const iSell = leafInfo(cat.sell);
  const iAdm = leafInfo(cat.adm);
  const iOth = leafInfo(cat.oth);
  const iFin = leafInfo(cat.fin);
  const iTax = leafInfo(cat.tax);
  const iOci = leafInfo(cat.oci);
  const iOthRev = leafInfo(cat.othRev);

  const cost1 = sumLeaves(cat.cost, iCost, "a1", false);
  const cost2 = sumLeaves(cat.cost, iCost, "a2", false);
  const sell1 = sumLeaves(cat.sell, iSell, "a1", false);
  const sell2 = sumLeaves(cat.sell, iSell, "a2", false);
  const adm1 = sumLeaves(cat.adm, iAdm, "a1", false);
  const adm2 = sumLeaves(cat.adm, iAdm, "a2", false);
  const oth1 = sumLeaves(cat.oth, iOth, "a1", false);
  const oth2 = sumLeaves(cat.oth, iOth, "a2", false);
  const othRev1 = sumLeaves(cat.othRev, iOthRev, "a1", true);
  const othRev2 = sumLeaves(cat.othRev, iOthRev, "a2", true);
  const fin1 = sumLeaves(cat.fin, iFin, "a1", false);
  const fin2 = sumLeaves(cat.fin, iFin, "a2", false);
  const tax1 = sumLeaves(cat.tax, iTax, "a1", false);
  const tax2 = sumLeaves(cat.tax, iTax, "a2", false);
  const oci1 = sumLeaves(cat.oci, iOci, "a1", true);
  const oci2 = sumLeaves(cat.oci, iOci, "a2", true);

  const gross1 = r2(rev1 - cost1);
  const gross2 = r2(rev2 - cost2);
  const opex1 = r2(sell1 + adm1 + oth1);
  const opex2 = r2(sell2 + adm2 + oth2);
  const oper1 = r2(gross1 - opex1);
  const oper2 = r2(gross2 - opex2);
  const pbt1 = r2(oper1 + othRev1 - fin1);
  const pbt2 = r2(oper2 + othRev2 - fin2);
  const net1 = r2(pbt1 - tax1);
  const net2 = r2(pbt2 - tax2);
  const comp1 = r2(net1 + oci1);
  const comp2 = r2(net2 + oci2);

  return {
    rev1, rev2, cost1, cost2, gross1, gross2,
    sell1, sell2, adm1, adm2, oth1, oth2, opex1, opex2,
    oper1, oper2, othRev1, othRev2, fin1, fin2,
    pbt1, pbt2, tax1, tax2, net1, net2, oci1, oci2, comp1, comp2,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Formatting — parentheses for negatives (IAS 1 convention)
 * ────────────────────────────────────────────────────────────────────────── */

export function fmtAmount(n: number | null): string {
  if (n == null) return "";
  if (n === 0) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${abs})` : abs;
}

export function fmtPct(v: number | null): string {
  if (v == null) return "—";
  const abs = (Math.abs(v) * 100).toFixed(1) + "%";
  return v < 0 ? `(${abs})` : abs;
}

/**
 * Net amount for a side with sign convention.
 * @param isRevenue  true → credit-positive, false → debit-positive
 */
export function rowAmount(r: MatchedRow, side: "a1" | "a2", isRevenue: boolean): number | null {
  const a = r[side];
  if (!a) return null;
  return r2(isRevenue ? a.d - a.m : a.m - a.d);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Change analysis — desirability & percentage
 * ──────────────────────────────────────────────────────────────────────────
 *
 * For EXPENSE accounts (prefix 3, debit-positive):
 *   - Decrease (chg < 0) = savings = مرغوب  (desirable)
 *   - Increase (chg > 0) = overspend = غير مرغوب (undesirable)
 *
 * For REVENUE accounts (prefix 4, credit-positive):
 *   - Increase (chg > 0) = more income = مرغوب  (desirable)
 *   - Decrease (chg < 0) = lost income = غير مرغوب (undesirable)
 *
 * Change percentage = chg / base period (v1 = comparative/older period)
 */

export type ChangeStatus =
  | "مرغوب نمو"
  | "غير مرغوب انخفاض"
  | "مرغوب وفرة"
  | "غير مرغوب زيادة"
  | "—";

export function computeChangeStatus(
  chg: number | null,
  isRevenue: boolean
): ChangeStatus {
  if (chg == null || chg === 0) return "—";
  if (isRevenue) {
    // Revenue: increase = good (growth), decrease = bad (decline)
    return chg > 0 ? "مرغوب نمو" : "غير مرغوب انخفاض";
  }
  // Expense: decrease = good (savings), increase = bad (overspend)
  return chg < 0 ? "مرغوب وفرة" : "غير مرغوب زيادة";
}

export function computeChangePct(
  chg: number | null,
  v1: number | null
): number | null {
  if (chg == null || v1 == null || v1 === 0) return null;
  return chg / v1;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Comparison modes
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Mode 1 — "period": Current period vs Previous period (change analysis)
 * Mode 2 — "monthCumulative": Current month vs Year-to-date cumulative
 *          (month's contribution to the annual total)
 *
 * In mode 2, the key metric is monthRatio = month_value / cumulative_value.
 * A "normal" month should represent ~1/numMonths of the annual total.
 * Desirability:
 *   Revenue: month ratio > expected = مرغوب (strong month)
 *   Expense: month ratio > expected = غير مرغوب (high expense month)
 */

export type CompareMode = "period" | "monthCumulative" | "chart";

/** Month/cumulative ratio = month value (v2) / cumulative value (v1). */
export function computeMonthRatio(
  v2: number | null,
  v1: number | null
): number | null {
  if (v2 == null || v1 == null || v1 === 0) return null;
  return v2 / v1;
}

/** Remaining = cumulative − month (what other months contributed). */
export function computeRemaining(
  v1: number | null,
  v2: number | null
): number | null {
  if (v1 == null || v2 == null) return null;
  return r2(v1 - v2);
}

/** Average cumulative = cumulative value / number of months. */
export function computeAvgCumulative(
  v1: number | null,
  numMonths: number
): number | null {
  if (v1 == null || numMonths === 0) return null;
  return r2(v1 / numMonths);
}

/**
 * Ratio of month value to the cumulative average.
 * month / (cumulative / numMonths) = month × numMonths / cumulative.
 * Values > 1 mean the month exceeds the average.
 */
export function computeMonthToAvgRatio(
  v2: number | null,
  avgCumulative: number | null
): number | null {
  if (v2 == null || avgCumulative == null || avgCumulative === 0) return null;
  return v2 / avgCumulative;
}

/** Absolute difference: month value − average cumulative. */
export function computeMonthAvgDiff(
  v2: number | null,
  avgCumulative: number | null
): number | null {
  if (v2 == null || avgCumulative == null) return null;
  return r2(v2 - avgCumulative);
}

/** Percentage difference from average: (month − avg) / avg. */
export function computeMonthAvgDiffPct(
  v2: number | null,
  avgCumulative: number | null
): number | null {
  if (v2 == null || avgCumulative == null || avgCumulative === 0) return null;
  return (v2 - avgCumulative) / avgCumulative;
}

/**
 * Desirability of the month's concentration vs the expected average.
 * @param monthRatio  month/cumulative ratio (0..1)
 * @param isRevenue   true for revenue, false for expense
 * @param numMonths   number of months in the cumulative period (default 12)
 */
export function computeMonthStatus(
  monthRatio: number | null,
  isRevenue: boolean,
  numMonths = 12
): ChangeStatus {
  if (monthRatio == null || monthRatio === 0) return "—";
  const expected = 1 / numMonths;
  if (Math.abs(monthRatio - expected) < 0.005) return "—";
  if (isRevenue) {
    return monthRatio > expected ? "مرغوب نمو" : "غير مرغوب انخفاض";
  }
  return monthRatio > expected ? "غير مرغوب زيادة" : "مرغوب وفرة";
}

/* ──────────────────────────────────────────────────────────────────────────
 * Excel export — full IFRS statement
 * ────────────────────────────────────────────────────────────────────────── */

export interface ExportLabels { L1: string; L2: string; }

export async function exportToExcel(
  cat: Categorized,
  T: Totals,
  labels: ExportLabels,
  baseRow: MatchedRow | null,
  netRow: MatchedRow | null,
  compareMode: CompareMode = "period",
  numMonths = 12,
  bs1: BalanceSheetTotals | null = null,
  bs2: BalanceSheetTotals | null = null
): void {
  const { L1, L2 } = labels;
  const wb = XLSX.utils.book_new();
  const b1 = T.rev1, b2 = T.rev2;
  const isMonthMode = compareMode === "monthCumulative";
  const numCols = isMonthMode ? 13 : 10;

  // Column headers depend on mode
  const col2 = isMonthMode ? `${L2} (الشهر)` : `${L2} (الحالية)`;
  const col2pct = isMonthMode ? "نسبة الشهر من التراكمي" : `${L2} %`;
  const col1 = isMonthMode ? `${L1} (التراكمي)` : `${L1} (المقارنة)`;
  const col1pct = isMonthMode ? `${L1} % من الإيرادات` : `${L1} %`;
  // Month mode extra columns
  const colItemToSales = "نسبة البند لمبيعات الشهر";
  const colAvg = "المتوسط للتراكمي";
  const colMonthToAvg = "نسبة الشهر من المتوسط";
  const colAvgDiff = "فرق الشهر عن المتوسط";
  const colAvgDiffPct = "نسبة الفرق عن المتوسط";
  const col7 = isMonthMode ? colAvg : "التغير";
  const col8 = isMonthMode ? colMonthToAvg : "نسبة التغير %";
  const col9 = isMonthMode ? "حالة الشهر" : "حالة التغير";

  const emptyRow: (string | number | null)[] = new Array(numCols).fill("");
  const titleRow: (string | number | null)[] = ["قائمة الربح أو الخسارة والدخل الشامل الآخر — وفق المعايير الدولية IFRS (IAS 1)", ...new Array(numCols - 1).fill("")];
  const subtitleRow: (string | number | null)[] = [`للفترة: ${L2} — مقارنة مع: ${L1}`, ...new Array(numCols - 1).fill("")];
  const headerRow: (string | number | null)[] = isMonthMode
    ? ["رقم", "البند", col2, col2pct, colItemToSales, col1, col1pct, colAvg, colMonthToAvg, colAvgDiff, colAvgDiffPct, col9, "الحالة"]
    : ["رقم", "البند", col2, col2pct, col1, col1pct, col7, col8, col9, "الحالة"];

  type Cell = string | number | null;
  const aoa: Cell[][] = [titleRow, subtitleRow, headerRow];
  const boldRows: boolean[] = [true, true, true];

  const addRow = (num: string, name: string, v1: number | null, v2: number | null, st: string, bold?: boolean, isRevenue?: boolean) => {
    const rev = isRevenue ?? false;
    let cs: ChangeStatus;

    if (isMonthMode) {
      // 13 columns: num | name | v2 | monthRatio | itemToSales | v1 | v1% | avg | monthToAvg | avgDiff | avgDiffPct | status | st
      const monthRatio = computeMonthRatio(v2, v1);
      const itemToSales = b2 !== 0 && v2 != null ? v2 / b2 : null;
      const v1Pct = b1 !== 0 && v1 != null ? v1 / b1 : null;
      const avg = computeAvgCumulative(v1, numMonths);
      const monthToAvg = computeMonthToAvgRatio(v2, avg);
      const avgDiff = computeMonthAvgDiff(v2, avg);
      const avgDiffPct = computeMonthAvgDiffPct(v2, avg);
      cs = computeMonthStatus(monthRatio, rev, numMonths);
      aoa.push([num, name, v2, monthRatio, itemToSales, v1, v1Pct, avg, monthToAvg, avgDiff, avgDiffPct, cs, st || ""]);
    } else {
      // 10 columns (period mode)
      const chg = v1 != null && v2 != null ? r2(v2 - v1) : null;
      const cp = computeChangePct(chg, v1);
      cs = computeChangeStatus(chg, rev);
      aoa.push([num, name, v2, b2 !== 0 && v2 != null ? v2 / b2 : null, v1, b1 !== 0 && v1 != null ? v1 / b1 : null, chg, cp, cs, st || ""]);
    }
    boldRows.push(!!bold);
  };
  const addTot = (name: string, v1: number, v2: number, isRevenue: boolean) => addRow("", name, v1, v2, "", true, isRevenue);
  const addSec = (t: string) => { aoa.push(["", t, ...new Array(numCols - 2).fill("")]); boldRows.push(true); };

  const blk = (rows: MatchedRow[], isRevenue: boolean) => {
    const info = leafInfo(rows);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const a = r.a1 ?? r.a2!;
      const v1 = r.a1 ? r2(isRevenue ? r.a1.d - r.a1.m : r.a1.m - r.a1.d) : null;
      const v2 = r.a2 ? r2(isRevenue ? r.a2.d - r.a2.m : r.a2.m - r.a2.d) : null;
      const isParent = (r.a1 && !info[i].leaf1) || (r.a2 && !info[i].leaf2);
      addRow(a.num ?? "", a.nm, v1, v2, r.st, isParent, isRevenue);
    }
  };

  // Revenue
  addSec("الإيرادات — Revenue");
  blk(cat.sales, true);
  addTot("صافي الإيرادات (المبيعات − المردود)", T.rev1, T.rev2, true);

  // Cost
  addSec("تكلفة الإيرادات — Cost of Sales");
  blk(cat.cost, false);
  addTot("صافي تكلفة الإيرادات", T.cost1, T.cost2, false);

  // Gross profit
  addTot("مجمل الربح (الخسارة) — Gross Profit", T.gross1, T.gross2, true);

  // Operating expenses (function of expense)
  addSec("مصاريف التشغيل — Operating Expenses");
  addSec("مصاريف البيع والتوزيع"); blk(cat.sell, false); addTot("إجمالي البيع والتوزيع", T.sell1, T.sell2, false);
  addSec("المصاريف الإدارية والعمومية"); blk(cat.adm, false); addTot("إجمالي الإدارية والعمومية", T.adm1, T.adm2, false);
  addSec("مصاريف تشغيلية أخرى"); blk(cat.oth, false); addTot("إجمالي التشغيلية الأخرى", T.oth1, T.oth2, false);
  addTot("إجمالي مصاريف التشغيل", T.opex1, T.opex2, false);
  addTot("الربح (الخسارة) من العمليات التشغيلية", T.oper1, T.oper2, true);

  // Other income
  if (cat.othRev.length) {
    addSec("الدخل من مصادر أخرى"); blk(cat.othRev, true); addTot("إجمالي الدخل من مصادر أخرى", T.othRev1, T.othRev2, true);
  }

  // Finance & tax
  if (cat.fin.length) { addSec("تكاليف التمويل"); blk(cat.fin, false); addTot("إجمالي تكاليف التمويل", T.fin1, T.fin2, false); }
  if (cat.fin.length || cat.tax.length) addTot("الربح (الخسارة) قبل الضريبة", T.pbt1, T.pbt2, true);
  if (cat.tax.length) { addSec("ضريبة الدخل"); blk(cat.tax, false); addTot("إجمالي ضريبة الدخل", T.tax1, T.tax2, false); }

  // Net profit
  addTot("صافي الربح (الخسارة) للفترة — Net Profit", T.net1, T.net2, true);

  // OCI
  if (cat.oci.length) {
    addSec("الدخل الشامل الآخر"); blk(cat.oci, true); addTot("إجمالي الدخل الشامل الآخر", T.oci1, T.oci2, true);
    addTot("إجمالي الدخل الشامل للفترة", T.comp1, T.comp2, true);
  }

  // Reconciliation
  if (netRow) {
    const n1 = netRow.a1 ? r2(netRow.a1.d - netRow.a1.m) : null;
    const n2 = netRow.a2 ? r2(netRow.a2.d - netRow.a2.m) : null;
    const ok = (n1 != null && Math.abs(n1 - T.net1) < 0.05) && (n2 != null && Math.abs(n2 - T.net2) < 0.05);
    addRow((netRow.a1?.num ?? netRow.a2?.num ?? "0") ?? "0", "التسوية: حساب صافي الدخل في دفتر الأستاذ", n1, n2, ok ? "مطابق ✓" : "⚠ فرق — راجع البادئات", true, true);
  }

  // Footer note
  const footerText = isMonthMode
    ? "عرض وفق IAS 1: الشهر مقابل التراكمي · نسبة الشهر من التراكمي = الشهر ÷ التراكمي · نسبة البند لمبيعات الشهر = الشهر ÷ صافي مبيعات الشهر · المتوسط = التراكمي ÷ " + numMonths + " · نسبة الشهر من المتوسط = الشهر ÷ المتوسط · فرق الشهر عن المتوسط = الشهر − المتوسط · نسبة الفرق عن المتوسط = (الشهر − المتوسط) ÷ المتوسط · حالة الشهر: مرغوب نمو / غير مرغوب انخفاض (إيرادات) · مرغوب وفرة / غير مرغوب زيادة (مصروفات) · الإجماليات من الأوراق فقط"
    : "عرض وفق IAS 1: الفترة الحالية ثم المقارنة · الخصومات سالبة بين قوسين · النسب من صافي إيرادات كل فترة · الإجماليات من الأوراق فقط · حالة التغير: مرغوب نمو / غير مرغوب انخفاض (إيرادات) · مرغوب وفرة / غير مرغوب زيادة (مصروفات)";
  aoa.push(["", footerText, ...new Array(numCols - 2).fill("")]);
  boldRows.push(false);

  // Style
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const rg = XLSX.utils.decode_range(ws["!ref"]!);
  const TOTAL_KEYWORDS = ["مجمل", "صافي الربح", "التشغيلية", "قبل الضريبة", "إجمالي مصاريف", "إجمالي الدخل الشامل", "صافي الإيرادات", "صافي تكلفة", "إجمالي "];
  const lastCol = numCols - 1;
  for (let R = 0; R <= rg.e.r; R++) {
    for (let c = 0; c <= lastCol; c++) {
      const ad = XLSX.utils.encode_cell({ r: R, c });
      if (!ws[ad]) ws[ad] = { t: "s", v: "" };
      const cl = ws[ad]!;
      if (R <= 2) {
        cl.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: "1F4E79" } }, alignment: { horizontal: "center" } };
        continue;
      }
      if (cl.t === "n") {
        if (isMonthMode) {
          // Month mode 13 cols: col2=v2(amt), col3=monthRatio(%), col4=itemToSales(%), col5=v1(amt), col6=v1%(%), col7=avg(amt), col8=monthToAvg(%), col9=avgDiff(amt), col10=avgDiffPct(%)
          if (c === 2 || c === 5 || c === 7 || c === 9) cl.z = '#,##0.00;(#,##0.00);"—"';
          else if (c === 3 || c === 4 || c === 6 || c === 8 || c === 10) cl.z = '0.00%;(0.00%);"—"';
        } else {
          // Period mode: col2=v2(amt), col3=v2%(%), col4=v1(amt), col5=v1%(%), col6=chg(amt), col7=chgPct(%)
          if (c === 2 || c === 4 || c === 6) cl.z = '#,##0.00;(#,##0.00);"—"';
          else if (c === 3 || c === 5 || c === 7) cl.z = '0.00%;(0.00%);"—"';
        }
      }
      const label = aoa[R]?.[1] ? String(aoa[R][1]) : "";
      const isTot = TOTAL_KEYWORDS.some((k) => label.indexOf(k) >= 0);
      cl.s = { alignment: { vertical: "center" }, font: (isTot || boldRows[R]) ? { bold: true } : {} };
      if (isTot && cl.t === "n" && c === 2 && typeof cl.v === "number") {
        cl.s.fill = { patternType: "solid", fgColor: { rgb: cl.v >= 0 ? "E2EFDA" : "FDECEA" } };
      }
    }
  }
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
  ];
  const colWidths = isMonthMode
    ? [12, 34, 13, 13, 13, 13, 11, 13, 13, 13, 13, 13, 13]
    : [12, 44, 16, 13, 16, 13, 15, 12, 14, 14];
  ws["!cols"] = colWidths.map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, `IFRS ${L1} و ${L2}`.slice(0, 31));

  // ── Charts data sheet ──
  addChartsSheet(wb, cat, T, L1, L2);

  // ── Formulas sheet ──
  addFormulasSheet(wb, T, L1, L2);

  // ── Financial analysis sheet (only if balance sheet data exists) ──
  if (bs1 || bs2) {
    const ratioGroups = computeRatios(T, bs1, bs2);
    addFinancialAnalysisSheet(wb, ratioGroups, bs1, bs2, L1, L2);
  }

  wb.Workbook = { Views: [{ RTL: true }] };

  // Write workbook to buffer, then inject native Excel charts as XML
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const finalBuf = await injectExcelCharts(buf, wb.SheetNames, cat, T, L1, L2);
  // Write to file (browser-compatible via Blob download)
  if (typeof document !== "undefined") {
    // Browser environment — trigger download
    const blob = new Blob([finalBuf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "قائمة_الربح_والخسارة_IFRS.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }
}

/**
 * Inject native Excel charts into an xlsx buffer using JSZip.
 * Adds a bar chart for key metrics comparison and a pie chart for expense breakdown
 * to the charts sheet.
 */
async function injectExcelCharts(
  buf: ArrayBuffer | Buffer,
  sheetNames: string[],
  cat: Categorized,
  T: Totals,
  L1: string,
  L2: string
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(buf);

  // Find the charts sheet (it's the one named "الرسومات البيانية" or similar)
  const chartsSheetName = sheetNames.find((n) => n.includes("الرسومات") || n.includes("charts") || n.includes("بيان"));
  if (!chartsSheetName) return new Uint8Array(buf);

  // Determine the sheet's XML file path
  const chartsSheetIdx = sheetNames.indexOf(chartsSheetName);
  const sheetFile = `xl/worksheets/sheet${chartsSheetIdx + 1}.xml`;

  // Data layout in the charts sheet:
  // Row 0: Title
  // Row 1: (empty)
  // Row 2: Headers: البند | L2 (الحالية) | L1 (المقارنة) | التغير
  // Rows 3-15: metric data (13 rows)
  // Row 16: empty
  // Row 17: "توزيع المصروفات" title
  // Row 18: headers
  // Rows 19-24: expense breakdown (6 rows)

  const numMetrics = 13 + (T.comp2 !== T.net2 ? 1 : 0);
  const dataStartRow = 3; // 1-based in XML
  const dataEndRow = dataStartRow + numMetrics - 1;

  const expStartRow = dataEndRow + 4;
  const expEndRow = expStartRow + 5;

  // ── Chart 1: Bar chart for key metrics ──
  const chart1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/><a:rPr lang="ar-SA" altLang="en-US"/></a:pPr><a:r><a:rPr lang="ar-SA" altLang="en-US"/><a:t>مقارنة المؤشرات الرئيسية</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>الرسومات!$B$3</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${L2} (الحالية)</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>الرسومات!$A$${dataStartRow}:$A$${dataEndRow}</c:f><c:strCache><c:ptCount val="${numMetrics}"/>${Array.from({ length: numMetrics }, (_, i) => `<c:pt idx="${i}"><c:v>${["الإيرادات","تكلفة الإيرادات","مجمل الربح","مصاريف البيع","المصاريف الإدارية","تشغيلية أخرى","مصاريف التشغيل","الربح التشغيلي","دخل آخر","تكاليف التمويل","الربح قبل الضريبة","ضريبة الدخل","صافي الربح"].slice(0, numMetrics)[i]}</c:v></c:pt>`).join("")}</c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>الرسومات!$B$${dataStartRow}:$B$${dataEndRow}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${numMetrics}"/>${Array.from({ length: numMetrics }, (_, i) => `<c:pt idx="${i}"><c:v>${[T.rev2,T.cost2,T.gross2,T.sell2,T.adm2,T.oth2,T.opex2,T.oper2,T.othRev2,T.fin2,T.pbt2,T.tax2,T.net2].slice(0, numMetrics)[i]}</c:v></c:pt>`).join("")}</c:numCache></c:numRef></c:val>
<c:spPr><a:solidFill><a:srgbClr val="0D9488"/></a:solidFill></c:spPr>
</c:ser>
<c:ser><c:idx val="1"/><c:order val="1"/><c:tx><c:strRef><c:f>الرسومات!$C$3</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${L1} (المقارنة)</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>الرسومات!$A$${dataStartRow}:$A$${dataEndRow}</c:f></c:strRef></c:cat>
<c:val><c:numRef><c:f>الرسومات!$C$${dataStartRow}:$C$${dataEndRow}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${numMetrics}"/>${Array.from({ length: numMetrics }, (_, i) => `<c:pt idx="${i}"><c:v>${[T.rev1,T.cost1,T.gross1,T.sell1,T.adm1,T.oth1,T.opex1,T.oper1,T.othRev1,T.fin1,T.pbt1,T.tax1,T.net1].slice(0, numMetrics)[i]}</c:v></c:pt>`).join("")}</c:numCache></c:numRef></c:val>
<c:spPr><a:solidFill><a:srgbClr val="94A3B8"/></a:solidFill></c:spPr>
</c:ser>
<c:axId val="111111"/><c:axId val="222222"/>
</c:barChart>
<c:catAx><c:axId val="111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>
<c:valAx><c:axId val="222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>
</c:plotArea>
<c:plotVisOnly val="1"/>
<c:dispBlanksAs val="gap"/>
</c:chart>
</c:chartSpace>`;

  // ── Chart 2: Pie chart for expense breakdown ──
  const chart2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/><a:rPr lang="ar-SA" altLang="en-US"/></a:pPr><a:r><a:rPr lang="ar-SA" altLang="en-US"/><a:t>توزيع المصروفات</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/><c:pieChart><c:varyColors val="1"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>الرسومات!$B$${expStartRow - 1}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>المصروفات</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>الرسومات!$A$${expStartRow}:$A$${expEndRow}</c:f><c:strCache><c:ptCount val="6"/><c:pt idx="0"><c:v>تكلفة الإيرادات</c:v></c:pt><c:pt idx="1"><c:v>البيع والتوزيع</c:v></c:pt><c:pt idx="2"><c:v>الإدارية والعمومية</c:v></c:pt><c:pt idx="3"><c:v>تشغيلية أخرى</c:v></c:pt><c:pt idx="4"><c:v>تكاليف التمويل</c:v></c:pt><c:pt idx="5"><c:v>ضريبة الدخل</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>الرسومات!$B$${expStartRow}:$B$${expEndRow}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="6"/><c:pt idx="0"><c:v>${T.cost2}</c:v></c:pt><c:pt idx="1"><c:v>${T.sell2}</c:v></c:pt><c:pt idx="2"><c:v>${T.adm2}</c:v></c:pt><c:pt idx="3"><c:v>${T.oth2}</c:v></c:pt><c:pt idx="4"><c:v>${T.fin2}</c:v></c:pt><c:pt idx="5"><c:v>${T.tax2}</c:v></c:pt></c:numCache></c:numRef></c:val>
</c:ser>
<c:axId val="333333"/>
</c:pieChart>
</c:plotArea>
<c:plotVisOnly val="1"/>
<c:dispBlanksAs val="gap"/>
<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>
</c:chart>
</c:chartSpace>`;

  // ── Drawing XML that references both charts ──
  const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<xdr:twoCellAnchor>
<xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>30</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro="">
<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic>
</xdr:graphicFrame>
<xdr:clientData/>
</xdr:twoCellAnchor>
<xdr:twoCellAnchor>
<xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>31</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>55</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro="">
<xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 2"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId2"/></a:graphicData></a:graphic>
</xdr:graphicFrame>
<xdr:clientData/>
</xdr:twoCellAnchor>
</xdr:wsDr>`;

  // ── Drawing rels ──
  const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/>
</Relationships>`;

  // ── Sheet rels (link drawing to sheet) ──
  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;

  // ── Add drawing ref to the sheet XML ──
  // Per OOXML schema, <drawing> must come AFTER <mergeCells> and <ignoredErrors>,
  // but BEFORE </worksheet>. We insert it right before </worksheet>.
  const sheetXml = await zip.file(sheetFile)?.async("string");
  if (sheetXml) {
    const drawingRef = '<drawing r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>';
    // Remove any existing drawing element (avoid duplicates on re-export)
    const cleaned = sheetXml.replace(/<drawing[^>]*\/>/g, "");
    // Insert right before </worksheet>
    const newSheetXml = cleaned.replace("</worksheet>", drawingRef + "</worksheet>");
    zip.file(sheetFile, newSheetXml);
  }

  // ── Add chart files, drawing files, and rels ──
  zip.file("xl/charts/chart1.xml", chart1Xml);
  zip.file("xl/charts/chart2.xml", chart2Xml);
  zip.file("xl/drawings/drawing1.xml", drawingXml);
  zip.file("xl/drawings/_rels/drawing1.xml.rels", drawingRels);
  zip.file(`xl/worksheets/_rels/sheet${chartsSheetIdx + 1}.xml.rels`, sheetRels);

  // ── Update [Content_Types].xml to register new files ──
  const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
  if (contentTypes) {
    const newTypes = contentTypes.replace("</Types>",
      '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chart+xml"/>' +
      '<Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chart+xml"/>' +
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.drawing+xml"/>' +
      "</Types>");
    zip.file("[Content_Types].xml", newTypes);
  }

  // ── Generate the zip ──
  // JSZip automatically creates directory entries (e.g. "xl/charts/") for any
  // nested file path. These entries are valid per the ZIP spec, but some
  // Excel versions reject them. We generate the final zip and then use
  // the `fflate` library to re-compress without directory entries.
  const rawBuf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

  // Use fflate to re-zip without directory entries
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fflate = require("fflate");
  const rawFiles = fflate.unzipSync(rawBuf);
  const cleanFiles: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(rawFiles)) {
    // Skip directory entries (they end with / and have 0 length)
    if (!path.endsWith("/") && data.length > 0) {
      cleanFiles[path] = data;
    }
  }
  return fflate.zipSync(cleanFiles, { level: 6 });
}

/** Add a formulas sheet showing all calculation formulas used in the app. */
export function addFormulasSheet(
  wb: XLSX.WorkBook,
  T: Totals,
  L1: string,
  L2: string
): void {
  const aoa: (string | string | number | null)[][] = [
    ["الدوال والمعادلات المستخدمة في الاحتساب", "", "", "", ""],
    ["", "", "", "", ""],
    ["البند", "المعادلة", "المعادلة الإنجليزية", L2 + " (الحالية)", L1 + " (المقارنة)"],
    ["", "", "", "", ""],
    ["■ قائمة الدخل — Income Statement Formulas", "", "", "", ""],
    ["صافي الإيرادات", "رصيد حساب صافي المبيعات (دائن − مدين)", "Net Sales = Credit − Debit", T.rev2, T.rev1],
    ["صافي تكلفة الإيرادات", "مجموع الأوراق ضمن بادئة التكلفة (مدين − دائن)", "Net COGS = Σ Leaves (Debit − Credit)", T.cost2, T.cost1],
    ["مجمل الربح", "صافي الإيرادات − صافي تكلفة الإيرادات", "Gross Profit = Revenue − COGS", T.gross2, T.gross1],
    ["مصاريف البيع والتوزيع", "مجموع الأوراق ضمن بادئة البيع (مدين − دائن)", "Selling = Σ Leaves (D−C)", T.sell2, T.sell1],
    ["المصاريف الإدارية والعمومية", "مجموع الأوراق ضمن بادئة الإدارية (مدين − دائن)", "Admin = Σ Leaves (D−C)", T.adm2, T.adm1],
    ["مصاريف تشغيلية أخرى", "مجموع الأوراق ضمن بادئة تشغيلية أخرى (مدين − دائن)", "Other Op = Σ Leaves (D−C)", T.oth2, T.oth1],
    ["إجمالي مصاريف التشغيل", "البيع + الإدارية + تشغيلية أخرى", "Total Opex = Selling + Admin + Other", T.opex2, T.opex1],
    ["الربح التشغيلي", "مجمل الربح − إجمالي مصاريف التشغيل", "Operating Profit = Gross − Opex", T.oper2, T.oper1],
    ["الدخل من مصادر أخرى", "مجموع الأوراق غير المصنفة (دائن − مدين)", "Other Income = Σ Leaves (C−D)", T.othRev2, T.othRev1],
    ["تكاليف التمويل", "مجموع الأوراق ضمن بادئة التمويل (مدين − دائن)", "Finance Costs = Σ Leaves (D−C)", T.fin2, T.fin1],
    ["الربح قبل الضريبة", "الربح التشغيلي + الدخل من مصادر أخرى − تكاليف التمويل", "PBT = Op Profit + Other Inc − Finance", T.pbt2, T.pbt1],
    ["ضريبة الدخل", "مجموع الأوراق ضمن بادئة الضريبة (مدين − دائن)", "Tax = Σ Leaves (D−C)", T.tax2, T.tax1],
    ["صافي الربح", "الربح قبل الضريبة − ضريبة الدخل", "Net Profit = PBT − Tax", T.net2, T.net1],
    ["إجمالي الدخل الشامل", "صافي الربح + الدخل الشامل الآخر", "Total Comp Income = Net + OCI", T.comp2, T.comp1],
    ["", "", "", "", ""],
    ["■ النسب والمؤشرات المالية — Financial Ratios Formulas", "", "", "", ""],
    ["نسبة التداول", "الأصول المتداولة ÷ الخصوم المتداولة", "Current Ratio = CA / CL", null, null],
    ["النسبة السريعة", "(الأصول المتداولة − المخزون) ÷ الخصوم المتداولة", "Quick Ratio = (CA−Inv) / CL", null, null],
    ["نسبة النقدية", "النقدية ÷ الخصوم المتداولة", "Cash Ratio = Cash / CL", null, null],
    ["رأس المال العامل", "الأصول المتداولة − الخصوم المتداولة", "Working Capital = CA − CL", null, null],
    ["نسبة المديونية", "إجمالي الخصوم ÷ إجمالي الأصول", "Debt Ratio = TL / TA", null, null],
    ["الدين إلى حقوق الملكية", "إجمالي الخصوم ÷ حقوق الملكية", "Debt-to-Equity = TL / Equity", null, null],
    ["نسبة حقوق الملكية", "حقوق الملكية ÷ إجمالي الأصول", "Equity Ratio = Equity / TA", null, null],
    ["نسبة القروض للأصول", "إجمالي القروض ÷ إجمالي الأصول", "Debt-to-Assets = Total Debt / TA", null, null],
    ["تغطية الفوائد", "الربح التشغيلي ÷ تكاليف التمويل", "Interest Coverage = Op Profit / Finance", null, null],
    ["هامش مجمل الربح", "مجمل الربح ÷ الإيرادات", "Gross Margin = GP / Revenue", null, null],
    ["هامش الربح التشغيلي", "الربح التشغيلي ÷ الإيرادات", "Operating Margin = OP / Revenue", null, null],
    ["هامش صافي الربح", "صافي الربح ÷ الإيرادات", "Net Margin = NP / Revenue", null, null],
    ["العائد على الأصول (ROA)", "صافي الربح ÷ إجمالي الأصول", "ROA = NP / TA", null, null],
    ["العائد على حقوق الملكية (ROE)", "صافي الربح ÷ حقوق الملكية", "ROE = NP / Equity", null, null],
    ["معدل دوران الأصول", "الإيرادات ÷ إجمالي الأصول", "Asset Turnover = Rev / TA", null, null],
    ["معدل دوران الأصول الثابتة", "الإيرادات ÷ الأصول الثابتة", "Fixed Asset Turnover = Rev / FA", null, null],
    ["معدل دوران المخزون", "تكلفة الإيرادات ÷ المخزون", "Inventory Turnover = COGS / Inv", null, null],
    ["معدل دوران المدينين", "الإيرادات ÷ المدينون", "Receivables Turnover = Rev / AR", null, null],
    ["معدل دوران الدائنين", "تكلفة الإيرادات ÷ الدائنون", "Payables Turnover = COGS / AP", null, null],
    ["معدل دوران رأس المال العامل", "الإيرادات ÷ رأس المال العامل", "WC Turnover = Rev / WC", null, null],
    ["", "", "", "", ""],
    ["■ قواعد الكشف والتصنيف — Detection & Classification Rules", "", "", "", ""],
    ["الحسابات الأوراق (Leaf)", "حساب بلا أبناء (أطول رقم يبدأ به)", "Account with no children", null, null],
    ["الحسابات الرئيسية", "تُعرض عريضة ولا تُجمع في الإجماليات", "Parent accounts: shown bold, excluded from totals", null, null],
    ["الإيرادات", "مدين − دائن (سالب للمردودات)", "Revenue = Credit − Debit (negative for returns)", null, null],
    ["المصروفات", "مدين − دائن", "Expenses = Debit − Credit", null, null],
    ["الخصوم وحقوق الملكية", "دائن − مدين", "Liabilities/Equity = Credit − Debit", null, null],
    ["نسبة الشهر من التراكمي", "قيمة الشهر ÷ القيمة التراكمية", "Month Ratio = Month / Cumulative", null, null],
    ["المتوسط للتراكمي", "التراكمي ÷ عدد الأشهر", "Average = Cumulative / Num Months", null, null],
    ["نسبة الشهر من المتوسط", "الشهر ÷ المتوسط", "Month/Avg = Month / Average", null, null],
    ["فرق الشهر عن المتوسط", "الشهر − المتوسط", "Diff = Month − Average", null, null],
    ["نسبة الفرق عن المتوسط", "(الشهر − المتوسط) ÷ المتوسط", "Diff% = (Month − Avg) / Avg", null, null],
    ["حالة التغير (مرغوب نمو)", "الإيراد: زيادة", "Desirable (Growth): Revenue↑", null, null],
    ["حالة التغير (غير مرغوب انخفاض)", "الإيراد: نقصان", "Undesirable (Decline): Revenue↓", null, null],
    ["حالة التغير (مرغوب وفرة)", "المصروف: نقصان", "Desirable (Savings): Expense↓", null, null],
    ["حالة التغير (غير مرغوب زيادة)", "المصروف: زيادة", "Undesirable (Overspend): Expense↑", null, null],
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const rg = XLSX.utils.decode_range(ws["!ref"]!);
  for (let R = 0; R <= rg.e.r; R++) {
    for (let c = 0; c <= 4; c++) {
      const ad = XLSX.utils.encode_cell({ r: R, c });
      if (!ws[ad]) ws[ad] = { t: "s", v: "" };
      const cl = ws[ad]!;
      const label = aoa[R]?.[0] ? String(aoa[R][0]) : "";
      if (R <= 3 || label.startsWith("■")) {
        cl.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: "1F4E79" } } };
        continue;
      }
      if (cl.t === "n") {
        if (c === 3 || c === 4) cl.z = '#,##0.00;(#,##0.00);"—"';
      }
      cl.s = { alignment: { vertical: "center", wrapText: c === 1 || c === 2 }, font: {} };
    }
  }
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
  ];
  ws["!cols"] = [30, 42, 38, 16, 16].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "الدوال والمعادلات".slice(0, 31));
}

/* ════════════════════════════════════════════════════════════════════════════
 * Balance Sheet (قائمة المركز المالي) — parsing, categorization & ratios
 * ═══════════════════════════════════════════════════════════════════════════─ */

export interface BalanceSheetSettings {
  currentAssetsPrefix: string;    // الأصول المتداولة (e.g. "11")
  nonCurrentAssetsPrefix: string; // الأصول غير المتداولة (e.g. "12")
  currentLiabPrefix: string;      // الخصوم المتداولة (e.g. "21")
  nonCurrentLiabPrefix: string;   // الخصوم غير المتداولة (e.g. "22")
  equityPrefix: string;           // حقوق الملكية (e.g. "3")
  // ── Detailed item prefixes (optional — fallback to keyword detection if empty) ──
  inventoryPrefix: string;        // المخزون (e.g. "1105")
  cashPrefix: string;             // النقدية وما يعادلها (e.g. "1101")
  receivablesPrefix: string;      // المدينون / العملاء (e.g. "1103")
  fixedAssetsPrefix: string;      // الأصول الثابتة (e.g. "1201")
  payablesPrefix: string;         // الدائنون / الموردون (e.g. "2101")
  shortTermDebtPrefix: string;    // قروض قصيرة الأجل (e.g. "2102")
  longTermDebtPrefix: string;     // قروض طويلة الأجل (e.g. "2201")
}

export interface BalanceSheetTotals {
  currentAssets: number;
  nonCurrentAssets: number;
  totalAssets: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
  totalLiabilities: number;
  equity: number;
  // Detailed items (used in ratio calculations)
  inventory: number;
  cash: number;
  receivables: number;
  fixedAssets: number;
  payables: number;
  shortTermDebt: number;
  longTermDebt: number;
  totalDebt: number;        // short-term + long-term debt
}

export interface BalanceSheetData {
  /** All accounts from the balance sheet file. */
  A: AccountRow[];
  /** Totals computed from leaf accounts by category. */
  totals: BalanceSheetTotals;
}

/** Keywords for detecting specific balance-sheet items by normalized name (fallback when prefix is empty). */
const INVENTORY_KEYWORDS = ["مخزون", "بضاعه", "بضاعة"];
const CASH_KEYWORDS = ["نقديه", "نقدية", "صندوق", "بنك", "بنوك", "جاري بنك"];
const RECEIVABLES_KEYWORDS = ["مدينون", "ذمم مدين", "عملاء", "اوراق قبض", "أوراق قبض"];
const FIXED_ASSETS_KEYWORDS = ["اصول ثابته", "أصول ثابتة", "اثاث", "أثاث", "معدات", "سيارات", "مباني", "مبانى", "اراضي", "أراضي", "اجهزه", "أجهزة"];
const PAYABLES_KEYWORDS = ["دائنون", "ذمم دائن", "موردون", "موردين"];
const SHORT_TERM_DEBT_KEYWORDS = ["اوراق دفع", "أوراق دفع", "سحب على المكشوف", "تسهيلات بنكيه", "قروض قصيره", "قروض قصيرة"];
const LONG_TERM_DEBT_KEYWORDS = ["قروض طويله", "قروض طويلة", "سندات", "قروض حسنه"];

function hasKeyword(n: string, keywords: string[]): boolean {
  return keywords.some((k) => n.indexOf(k) >= 0);
}

/** Check if an account number matches a prefix (empty prefix = no match). */
function matchesPrefix(num: string, prefix: string): boolean {
  return !!prefix && num.indexOf(prefix) === 0;
}

/**
 * Parse a balance-sheet file and compute category totals.
 * Uses the same parsing as income-statement files (readExcelFile).
 * The `totals` are computed from LEAF accounts only (same logic as income statement).
 *
 * Detailed items (inventory, cash, etc.) are detected by PREFIX first;
 * if the prefix is empty, falls back to keyword-based name detection.
 */
export function categorizeBalanceSheet(
  file: FileData,
  settings: BalanceSheetSettings
): BalanceSheetTotals {
  const {
    currentAssetsPrefix, nonCurrentAssetsPrefix, currentLiabPrefix, nonCurrentLiabPrefix, equityPrefix,
    inventoryPrefix, cashPrefix, receivablesPrefix, fixedAssetsPrefix,
    payablesPrefix, shortTermDebtPrefix, longTermDebtPrefix,
  } = settings;

  // Mark leaves
  const nums = file.A.map((a) => a.num).filter(Boolean) as string[];
  for (const a of file.A) {
    if (!a.num) { (a as any).leaf = true; continue; }
    (a as any).leaf = true;
    for (const n of nums) {
      if (n !== a.num && n.length > a.num.length && n.indexOf(a.num) === 0) {
        (a as any).leaf = false;
        break;
      }
    }
  }

  let currentAssets = 0, nonCurrentAssets = 0;
  let currentLiabilities = 0, nonCurrentLiabilities = 0;
  let equity = 0;
  let inventory = 0, cash = 0, receivables = 0;
  let fixedAssets = 0, payables = 0, shortTermDebt = 0, longTermDebt = 0;

  for (const a of file.A) {
    if (!(a as any).leaf) continue;
    const num = a.num ?? "";
    const n = normalizeName(a.nm);
    const debitBal = a.m - a.d;   // asset = debit − credit
    const creditBal = a.d - a.m;  // liability/equity = credit − debit

    // ── Detailed item detection: prefix first, then keyword fallback ──
    // Inventory
    if (matchesPrefix(num, inventoryPrefix) || (!inventoryPrefix && hasKeyword(n, INVENTORY_KEYWORDS))) {
      inventory += debitBal;
    }
    // Cash & equivalents
    if (matchesPrefix(num, cashPrefix) || (!cashPrefix && hasKeyword(n, CASH_KEYWORDS))) {
      cash += debitBal;
    }
    // Receivables
    if (matchesPrefix(num, receivablesPrefix) || (!receivablesPrefix && hasKeyword(n, RECEIVABLES_KEYWORDS))) {
      receivables += debitBal;
    }
    // Fixed assets
    if (matchesPrefix(num, fixedAssetsPrefix) || (!fixedAssetsPrefix && hasKeyword(n, FIXED_ASSETS_KEYWORDS))) {
      fixedAssets += debitBal;
    }
    // Payables
    if (matchesPrefix(num, payablesPrefix) || (!payablesPrefix && hasKeyword(n, PAYABLES_KEYWORDS))) {
      payables += creditBal;
    }
    // Short-term debt
    if (matchesPrefix(num, shortTermDebtPrefix) || (!shortTermDebtPrefix && hasKeyword(n, SHORT_TERM_DEBT_KEYWORDS))) {
      shortTermDebt += creditBal;
    }
    // Long-term debt
    if (matchesPrefix(num, longTermDebtPrefix) || (!longTermDebtPrefix && hasKeyword(n, LONG_TERM_DEBT_KEYWORDS))) {
      longTermDebt += creditBal;
    }

    // ── Main category detection by prefix ──
    if (matchesPrefix(num, currentAssetsPrefix)) {
      currentAssets += debitBal;
    } else if (matchesPrefix(num, nonCurrentAssetsPrefix)) {
      nonCurrentAssets += debitBal;
    } else if (matchesPrefix(num, currentLiabPrefix)) {
      currentLiabilities += creditBal;
    } else if (matchesPrefix(num, nonCurrentLiabPrefix)) {
      nonCurrentLiabilities += creditBal;
    } else if (matchesPrefix(num, equityPrefix)) {
      equity += creditBal;
    } else if (num.indexOf("1") === 0) {
      currentAssets += debitBal;
    } else if (num.indexOf("2") === 0) {
      currentLiabilities += creditBal;
    } else if (num.indexOf("3") === 0) {
      equity += creditBal;
    }
  }

  const totalAssets = r2(currentAssets + nonCurrentAssets);
  const totalLiabilities = r2(currentLiabilities + nonCurrentLiabilities);
  const totalDebt = r2(shortTermDebt + longTermDebt);

  return {
    currentAssets: r2(currentAssets),
    nonCurrentAssets: r2(nonCurrentAssets),
    totalAssets,
    currentLiabilities: r2(currentLiabilities),
    nonCurrentLiabilities: r2(nonCurrentLiabilities),
    totalLiabilities,
    equity: r2(equity),
    inventory: r2(inventory),
    cash: r2(cash),
    receivables: r2(receivables),
    fixedAssets: r2(fixedAssets),
    payables: r2(payables),
    shortTermDebt: r2(shortTermDebt),
    longTermDebt: r2(longTermDebt),
    totalDebt,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════─
 * Financial Ratios (تحليل النسب والمؤشرات المالية)
 * ═══════════════════════════════════════════════════════════════════════════─ */

export interface FinancialRatios {
  // Liquidity ratios (نسب السيولة)
  currentRatio: number | null;       // Current Assets / Current Liabilities
  quickRatio: number | null;        // (Current Assets - Inventory) / Current Liabilities
  cashRatio: number | null;          // Cash / Current Liabilities
  workingCapital: number | null;     // Current Assets - Current Liabilities

  // Leverage ratios (نسب المديونية والرفع المالي)
  debtRatio: number | null;          // Total Liabilities / Total Assets
  debtToEquity: number | null;       // Total Liabilities / Total Equity
  equityRatio: number | null;        // Total Equity / Total Assets
  interestCoverage: number | null;   // Operating Profit / Finance Costs

  // Profitability ratios (نسب الربحية)
  grossMargin: number | null;        // Gross Profit / Revenue
  operatingMargin: number | null;    // Operating Profit / Revenue
  netMargin: number | null;          // Net Profit / Revenue
  roa: number | null;                // Net Profit / Total Assets
  roe: number | null;                // Net Profit / Total Equity

  // Activity/Efficiency ratios (نسب النشاط والكفاءة)
  assetTurnover: number | null;      // Revenue / Total Assets
  inventoryTurnover: number | null;   // Cost of Sales / Inventory
  receivablesTurnover: number | null; // Revenue / Receivables
  workingCapitalTurnover: number | null; // Revenue / Working Capital
}

export interface RatioGroup {
  title: string;
  titleEn: string;
  ratios: { name: string; nameEn: string; formula: string; v1: number | null; v2: number | null; unit: "ratio" | "percent" | "amount" | "days"; desirable: "high" | "low"; benchmark?: string }[];
}

/** Convert a turnover ratio (e.g. inventoryTurnover) to days (365 / turnover). Returns null if input is null/0.
 *  Module-level function declaration so it is hoisted and available everywhere (avoids Turbopack TDZ issues). */
function toDays(turnover: number | null): number | null {
  if (turnover == null || Number.isNaN(turnover) || turnover === 0) return null;
  return r2(365 / turnover);
}

/**
 * Compute all financial ratios.
 * @param T      Income statement totals
 * @param bs1    Comparative-period balance sheet totals (or null)
 * @param bs2    Current-period balance sheet totals (or null)
 */
export function computeRatios(
  T: Totals,
  bs1: BalanceSheetTotals | null,
  bs2: BalanceSheetTotals | null = null
): RatioGroup[] {
  const safeDiv = (a: number | null, b: number | null): number | null => {
    if (a == null || b == null || b === 0) return null;
    return r2(a / b);
  };

  if (!bs1 && !bs2) {
    // Return empty groups with null values
    const empty = { v1: null, v2: null };
    return [
      { title: "نسب السيولة", titleEn: "Liquidity Ratios", ratios: [
        { name: "نسبة التداول", nameEn: "Current Ratio", formula: "الأصول المتداولة ÷ الخصوم المتداولة", ...empty, unit: "ratio", desirable: "high" },
        { name: "النسبة السريعة", nameEn: "Quick Ratio", formula: "(الأصول المتداولة − المخزون) ÷ الخصوم المتداولة", ...empty, unit: "ratio", desirable: "high" },
        { name: "نسبة النقدية", nameEn: "Cash Ratio", formula: "النقدية ÷ الخصوم المتداولة", ...empty, unit: "ratio", desirable: "high" },
        { name: "رأس المال العامل", nameEn: "Working Capital", formula: "الأصول المتداولة − الخصوم المتداولة", ...empty, unit: "amount", desirable: "high" },
      ]},
      { title: "نسب المديونية والرفع المالي", titleEn: "Leverage Ratios", ratios: [
        { name: "نسبة المديونية", nameEn: "Debt Ratio", formula: "إجمالي الخصوم ÷ إجمالي الأصول", ...empty, unit: "percent", desirable: "low" },
        { name: "الدين إلى حقوق الملكية", nameEn: "Debt-to-Equity", formula: "إجمالي الخصوم ÷ حقوق الملكية", ...empty, unit: "ratio", desirable: "low" },
        { name: "نسبة حقوق الملكية", nameEn: "Equity Ratio", formula: "حقوق الملكية ÷ إجمالي الأصول", ...empty, unit: "percent", desirable: "high" },
        { name: "نسبة القروض للأصول", nameEn: "Debt-to-Assets", formula: "إجمالي القروض ÷ إجمالي الأصول", ...empty, unit: "percent", desirable: "low" },
        { name: "تغطية الفوائد", nameEn: "Interest Coverage", formula: "الربح التشغيلي ÷ تكاليف التمويل", ...empty, unit: "ratio", desirable: "high" },
        { name: "الأصول الثابتة إلى حقوق الملكية", nameEn: "Fixed Assets to Equity", formula: "الأصول الثابتة ÷ حقوق الملكية", ...empty, unit: "ratio", desirable: "low" },
        { name: "الأصول المتداولة إلى إجمالي الأصول", nameEn: "Current to Total Assets", formula: "الأصول المتداولة ÷ إجمالي الأصول", ...empty, unit: "percent", desirable: "high" },
      ]},
      { title: "نسب الربحية", titleEn: "Profitability Ratios", ratios: [
        { name: "هامش مجمل الربح", nameEn: "Gross Margin", formula: "مجمل الربح ÷ الإيرادات", ...empty, unit: "percent", desirable: "high" },
        { name: "هامش الربح التشغيلي", nameEn: "Operating Margin", formula: "الربح التشغيلي ÷ الإيرادات", ...empty, unit: "percent", desirable: "high" },
        { name: "هامش صافي الربح", nameEn: "Net Margin", formula: "صافي الربح ÷ الإيرادات", ...empty, unit: "percent", desirable: "high" },
        { name: "العائد على الأصول (ROA)", nameEn: "Return on Assets", formula: "صافي الربح ÷ إجمالي الأصول", ...empty, unit: "percent", desirable: "high" },
        { name: "العائد على حقوق الملكية (ROE)", nameEn: "Return on Equity", formula: "صافي الربح ÷ حقوق الملكية", ...empty, unit: "percent", desirable: "high" },
      ]},
      { title: "نسب النشاط والكفاءة", titleEn: "Activity & Efficiency Ratios", ratios: [
        { name: "معدل دوران الأصول", nameEn: "Asset Turnover", formula: "الإيرادات ÷ إجمالي الأصول", ...empty, unit: "ratio", desirable: "high" },
        { name: "معدل دوران الأصول الثابتة", nameEn: "Fixed Asset Turnover", formula: "الإيرادات ÷ الأصول الثابتة", ...empty, unit: "ratio", desirable: "high" },
        { name: "معدل دوران المخزون", nameEn: "Inventory Turnover", formula: "تكلفة الإيرادات ÷ المخزون", ...empty, unit: "ratio", desirable: "high" },
        { name: "معدل دوران المدينين", nameEn: "Receivables Turnover", formula: "الإيرادات ÷ المدينون", ...empty, unit: "ratio", desirable: "high" },
        { name: "معدل دوران الدائنين", nameEn: "Payables Turnover", formula: "تكلفة الإيرادات ÷ الدائنون", ...empty, unit: "ratio", desirable: "high" },
        { name: "معدل دوران رأس المال العامل", nameEn: "Working Capital Turnover", formula: "الإيرادات ÷ رأس المال العامل", ...empty, unit: "ratio", desirable: "high" },
      ]},
    ];
  }

  // Use bs1 for v1 (comparative), bs2 for v2 (current)
  // If only one BS is available, use it for both periods
  const useBs1 = bs1 ?? bs2;
  const useBs2 = bs2 ?? bs1;
  const wc1 = useBs1 ? r2(useBs1.currentAssets - useBs1.currentLiabilities) : null;
  const wc2 = useBs2 ? r2(useBs2.currentAssets - useBs2.currentLiabilities) : null;

  // v1 = period 1 (comparative) IS figures + BS1
  // v2 = period 2 (current) IS figures + BS2
  // BS-only ratios now differ between periods (BS1 vs BS2)
  const get = (key: string): { v1: number | null; v2: number | null } => {
    // BS-only ratios (now differ between periods with 2 BS files)
    const bsRatios1: Record<string, number | null> = useBs1 ? {
      currentRatio: safeDiv(useBs1.currentAssets, useBs1.currentLiabilities),
      quickRatio: safeDiv(useBs1.currentAssets - useBs1.inventory, useBs1.currentLiabilities),
      cashRatio: safeDiv(useBs1.cash, useBs1.currentLiabilities),
      workingCapital: wc1,
      debtRatio: safeDiv(useBs1.totalLiabilities, useBs1.totalAssets),
      debtToEquity: safeDiv(useBs1.totalLiabilities, useBs1.equity),
      equityRatio: safeDiv(useBs1.equity, useBs1.totalAssets),
      debtToAssets: safeDiv(useBs1.totalDebt, useBs1.totalAssets),
    } : {};
    const bsRatios2: Record<string, number | null> = useBs2 ? {
      currentRatio: safeDiv(useBs2.currentAssets, useBs2.currentLiabilities),
      quickRatio: safeDiv(useBs2.currentAssets - useBs2.inventory, useBs2.currentLiabilities),
      cashRatio: safeDiv(useBs2.cash, useBs2.currentLiabilities),
      workingCapital: wc2,
      debtRatio: safeDiv(useBs2.totalLiabilities, useBs2.totalAssets),
      debtToEquity: safeDiv(useBs2.totalLiabilities, useBs2.equity),
      equityRatio: safeDiv(useBs2.equity, useBs2.totalAssets),
      debtToAssets: safeDiv(useBs2.totalDebt, useBs2.totalAssets),
    } : {};
    if (key in bsRatios1 || key in bsRatios2) {
      return { v1: bsRatios1[key] ?? null, v2: bsRatios2[key] ?? null };
    }
    // IS+BS ratios (differ between periods — each uses its own BS)
    const isBsRatios: Record<string, [number | null, number | null]> = {
      interestCoverage: [
        safeDiv(T.oper1, T.fin1 === 0 ? null : T.fin1),
        safeDiv(T.oper2, T.fin2 === 0 ? null : T.fin2),
      ],
      grossMargin: [safeDiv(T.gross1, T.rev1), safeDiv(T.gross2, T.rev2)],
      operatingMargin: [safeDiv(T.oper1, T.rev1), safeDiv(T.oper2, T.rev2)],
      netMargin: [safeDiv(T.net1, T.rev1), safeDiv(T.net2, T.rev2)],
      roa: [useBs1 ? safeDiv(T.net1, useBs1.totalAssets) : null, useBs2 ? safeDiv(T.net2, useBs2.totalAssets) : null],
      roe: [useBs1 ? safeDiv(T.net1, useBs1.equity) : null, useBs2 ? safeDiv(T.net2, useBs2.equity) : null],
      // ── DuPont decomposition ──
      roeDuPont: [
        useBs1 ? r2((safeDiv(T.net1, T.rev1) ?? 0) * (safeDiv(T.rev1, useBs1.totalAssets) ?? 0) * (safeDiv(useBs1.totalAssets, useBs1.equity) ?? 0)) : null,
        useBs2 ? r2((safeDiv(T.net2, T.rev2) ?? 0) * (safeDiv(T.rev2, useBs2.totalAssets) ?? 0) * (safeDiv(useBs2.totalAssets, useBs2.equity) ?? 0)) : null,
      ],
      equityMultiplier: [
        useBs1 ? safeDiv(useBs1.totalAssets, useBs1.equity) : null,
        useBs2 ? safeDiv(useBs2.totalAssets, useBs2.equity) : null,
      ],
      // ── Extended profitability ──
      grossProfitToAssets: [useBs1 ? safeDiv(T.gross1, useBs1.totalAssets) : null, useBs2 ? safeDiv(T.gross2, useBs2.totalAssets) : null],
      operatingProfitToAssets: [useBs1 ? safeDiv(T.oper1, useBs1.totalAssets) : null, useBs2 ? safeDiv(T.oper2, useBs2.totalAssets) : null],
      fixedAssetToEquity: [
        useBs1 ? safeDiv(useBs1.fixedAssets, useBs1.equity) : null,
        useBs2 ? safeDiv(useBs2.fixedAssets, useBs2.equity) : null,
      ],
      currentAssetToTotalAsset: [
        useBs1 ? safeDiv(useBs1.currentAssets, useBs1.totalAssets) : null,
        useBs2 ? safeDiv(useBs2.currentAssets, useBs2.totalAssets) : null,
      ],
      // ── Activity ratios ──
      assetTurnover: [useBs1 ? safeDiv(T.rev1, useBs1.totalAssets) : null, useBs2 ? safeDiv(T.rev2, useBs2.totalAssets) : null],
      fixedAssetTurnover: [useBs1 ? safeDiv(T.rev1, useBs1.fixedAssets) : null, useBs2 ? safeDiv(T.rev2, useBs2.fixedAssets) : null],
      inventoryTurnover: [useBs1 ? safeDiv(T.cost1, useBs1.inventory) : null, useBs2 ? safeDiv(T.cost2, useBs2.inventory) : null],
      receivablesTurnover: [useBs1 ? safeDiv(T.rev1, useBs1.receivables) : null, useBs2 ? safeDiv(T.rev2, useBs2.receivables) : null],
      payablesTurnover: [useBs1 ? safeDiv(T.cost1, useBs1.payables) : null, useBs2 ? safeDiv(T.cost2, useBs2.payables) : null],
      workingCapitalTurnover: [wc1 != null && wc1 !== 0 ? safeDiv(T.rev1, wc1) : null, wc2 != null && wc2 !== 0 ? safeDiv(T.rev2, wc2) : null],
      // ── Days ratios (فترات التحصيل والسداد وعمر المخزون) ──
      daysInventoryOutstanding: [toDays(useBs1 ? safeDiv(T.cost1, useBs1.inventory) : null), toDays(useBs2 ? safeDiv(T.cost2, useBs2.inventory) : null)],
      daysSalesOutstanding: [toDays(useBs1 ? safeDiv(T.rev1, useBs1.receivables) : null), toDays(useBs2 ? safeDiv(T.rev2, useBs2.receivables) : null)],
      daysPayableOutstanding: [toDays(useBs1 ? safeDiv(T.cost1, useBs1.payables) : null), toDays(useBs2 ? safeDiv(T.cost2, useBs2.payables) : null)],
      cashConversionCycle: [
        toDays(useBs1 ? safeDiv(T.cost1, useBs1.inventory) : null) != null && toDays(useBs1 ? safeDiv(T.rev1, useBs1.receivables) : null) != null && toDays(useBs1 ? safeDiv(T.cost1, useBs1.payables) : null) != null
          ? r2(toDays(useBs1 ? safeDiv(T.cost1, useBs1.inventory) : null)! + toDays(useBs1 ? safeDiv(T.rev1, useBs1.receivables) : null)! - toDays(useBs1 ? safeDiv(T.cost1, useBs1.payables) : null)!)
          : null,
        toDays(useBs2 ? safeDiv(T.cost2, useBs2.inventory) : null) != null && toDays(useBs2 ? safeDiv(T.rev2, useBs2.receivables) : null) != null && toDays(useBs2 ? safeDiv(T.cost2, useBs2.payables) : null) != null
          ? r2(toDays(useBs2 ? safeDiv(T.cost2, useBs2.inventory) : null)! + toDays(useBs2 ? safeDiv(T.rev2, useBs2.receivables) : null)! - toDays(useBs2 ? safeDiv(T.cost2, useBs2.payables) : null)!)
          : null,
      ],
    };
    const pair = isBsRatios[key] ?? [null, null];
    return { v1: pair[0], v2: pair[1] };
  };

  return [
    {
      title: "نسب السيولة",
      titleEn: "Liquidity Ratios",
      ratios: [
        { name: "نسبة التداول", nameEn: "Current Ratio", formula: "الأصول المتداولة ÷ الخصوم المتداولة", ...get("currentRatio"), unit: "ratio", desirable: "high", benchmark: "1.5 – 2.0×" },
        { name: "النسبة السريعة", nameEn: "Quick Ratio", formula: "(الأصول المتداولة − المخزون) ÷ الخصوم المتداولة", ...get("quickRatio"), unit: "ratio", desirable: "high", benchmark: "≥ 1.0×" },
        { name: "نسبة النقدية", nameEn: "Cash Ratio", formula: "النقدية ÷ الخصوم المتداولة", ...get("cashRatio"), unit: "ratio", desirable: "high", benchmark: "0.2 – 0.5×" },
        { name: "نسبة الفاصل الدفاعي", nameEn: "Defensive Interval", formula: "(النقدية + المدينون) ÷ الخصوم المتداولة", ...get("cashRatio"), unit: "ratio", desirable: "high", benchmark: "≥ 1.0×" },
        { name: "رأس المال العامل", nameEn: "Working Capital", formula: "الأصول المتداولة − الخصوم المتداولة", ...get("workingCapital"), unit: "amount", desirable: "high", benchmark: "موجب" },
      ],
    },
    {
      title: "نسب المديونية والرفع المالي",
      titleEn: "Leverage Ratios",
      ratios: [
        { name: "نسبة المديونية", nameEn: "Debt Ratio", formula: "إجمالي الخصوم ÷ إجمالي الأصول", ...get("debtRatio"), unit: "percent", desirable: "low", benchmark: "< 50%" },
        { name: "الدين إلى حقوق الملكية", nameEn: "Debt-to-Equity", formula: "إجمالي الخصوم ÷ حقوق الملكية", ...get("debtToEquity"), unit: "ratio", desirable: "low", benchmark: "< 1.0×" },
        { name: "نسبة حقوق الملكية", nameEn: "Equity Ratio", formula: "حقوق الملكية ÷ إجمالي الأصول", ...get("equityRatio"), unit: "percent", desirable: "high", benchmark: "> 50%" },
        { name: "نسبة القروض للأصول", nameEn: "Debt-to-Assets", formula: "إجمالي القروض ÷ إجمالي الأصول", ...get("debtToAssets"), unit: "percent", desirable: "low", benchmark: "< 40%" },
        { name: "مضاعف حقوق الملكية", nameEn: "Equity Multiplier", formula: "إجمالي الأصول ÷ حقوق الملكية", ...get("equityMultiplier"), unit: "ratio", desirable: "low", benchmark: "< 2.0×" },
        { name: "تغطية الفوائد", nameEn: "Interest Coverage", formula: "الربح التشغيلي ÷ تكاليف التمويل", ...get("interestCoverage"), unit: "ratio", desirable: "high", benchmark: "≥ 3.0×" },
        { name: "الأصول الثابتة إلى حقوق الملكية", nameEn: "Fixed Assets to Equity", formula: "الأصول الثابتة ÷ حقوق الملكية", ...get("fixedAssetToEquity"), unit: "ratio", desirable: "low", benchmark: "< 1.0×" },
        { name: "الأصول المتداولة إلى إجمالي الأصول", nameEn: "Current to Total Assets", formula: "الأصول المتداولة ÷ إجمالي الأصول", ...get("currentAssetToTotalAsset"), unit: "percent", desirable: "high", benchmark: "> 30%" },
      ],
    },
    {
      title: "نسب الربحية",
      titleEn: "Profitability Ratios",
      ratios: [
        { name: "هامش مجمل الربح", nameEn: "Gross Margin", formula: "مجمل الربح ÷ الإيرادات", ...get("grossMargin"), unit: "percent", desirable: "high", benchmark: "> 30%" },
        { name: "هامش الربح التشغيلي", nameEn: "Operating Margin", formula: "الربح التشغيلي ÷ الإيرادات", ...get("operatingMargin"), unit: "percent", desirable: "high", benchmark: "> 15%" },
        { name: "هامش صافي الربح", nameEn: "Net Margin", formula: "صافي الربح ÷ الإيرادات", ...get("netMargin"), unit: "percent", desirable: "high", benchmark: "> 10%" },
        { name: "العائد على الأصول (ROA)", nameEn: "Return on Assets", formula: "صافي الربح ÷ إجمالي الأصول", ...get("roa"), unit: "percent", desirable: "high", benchmark: "> 5%" },
        { name: "العائد على حقوق الملكية (ROE)", nameEn: "Return on Equity", formula: "صافي الربح ÷ حقوق الملكية", ...get("roe"), unit: "percent", desirable: "high", benchmark: "> 15%" },
        { name: "ROE (تحليل دوپونت)", nameEn: "DuPont ROE", formula: "هامش صافي الربح × معدل دوران الأصول × مضاعف حقوق الملكية", ...get("roeDuPont"), unit: "percent", desirable: "high", benchmark: "> 15%" },
        { name: "مجمل الربح إلى الأصول", nameEn: "Gross Profit to Assets", formula: "مجمل الربح ÷ إجمالي الأصول", ...get("grossProfitToAssets"), unit: "percent", desirable: "high", benchmark: "> 20%" },
        { name: "الربح التشغيلي إلى الأصول", nameEn: "Operating Profit to Assets", formula: "الربح التشغيلي ÷ إجمالي الأصول", ...get("operatingProfitToAssets"), unit: "percent", desirable: "high", benchmark: "> 10%" },
      ],
    },
    {
      title: "نسب النشاط والكفاءة",
      titleEn: "Activity & Efficiency Ratios",
      ratios: [
        { name: "معدل دوران الأصول", nameEn: "Asset Turnover", formula: "الإيرادات ÷ إجمالي الأصول", ...get("assetTurnover"), unit: "ratio", desirable: "high", benchmark: "> 0.5×" },
        { name: "معدل دوران الأصول الثابتة", nameEn: "Fixed Asset Turnover", formula: "الإيرادات ÷ الأصول الثابتة", ...get("fixedAssetTurnover"), unit: "ratio", desirable: "high", benchmark: "> 1.0×" },
        { name: "معدل دوران المخزون", nameEn: "Inventory Turnover", formula: "تكلفة الإيرادات ÷ المخزون", ...get("inventoryTurnover"), unit: "ratio", desirable: "high", benchmark: "> 4×" },
        { name: "معدل دوران المدينين", nameEn: "Receivables Turnover", formula: "الإيرادات ÷ المدينون", ...get("receivablesTurnover"), unit: "ratio", desirable: "high", benchmark: "> 6×" },
        { name: "معدل دوران الدائنين", nameEn: "Payables Turnover", formula: "تكلفة الإيرادات ÷ الدائنون", ...get("payablesTurnover"), unit: "ratio", desirable: "high", benchmark: "4 – 8×" },
        { name: "معدل دوران رأس المال العامل", nameEn: "Working Capital Turnover", formula: "الإيرادات ÷ رأس المال العامل", ...get("workingCapitalTurnover"), unit: "ratio", desirable: "high", benchmark: "> 2×" },
      ],
    },
    {
      title: "فترات التحصيل والسداد (بالأيام)",
      titleEn: "Days & Cash Cycle",
      ratios: [
        { name: "عمر المخزون (DIO)", nameEn: "Days Inventory Outstanding", formula: "٣٦٥ ÷ معدل دوران المخزون", ...get("daysInventoryOutstanding"), unit: "days", desirable: "low", benchmark: "30 – 90 يوم" },
        { name: "فترة التحصيل (DSO)", nameEn: "Days Sales Outstanding", formula: "٣٦٥ ÷ معدل دوران المدينين", ...get("daysSalesOutstanding"), unit: "days", desirable: "low", benchmark: "30 – 60 يوم" },
        { name: "فترة سداد الموردين (DPO)", nameEn: "Days Payable Outstanding", formula: "٣٦٥ ÷ معدل دوران الدائنين", ...get("daysPayableOutstanding"), unit: "days", desirable: "high", benchmark: "30 – 90 يوم" },
        { name: "دورة التحويل النقدي (CCC)", nameEn: "Cash Conversion Cycle", formula: "عمر المخزون + فترة التحصيل − فترة السداد", ...get("cashConversionCycle"), unit: "days", desirable: "low", benchmark: "< 60 يوم" },
      ],
    },
  ];
}

/** Format a ratio value for display. */
export function fmtRatio(v: number | null, unit: "ratio" | "percent" | "amount" | "days"): string {
  if (v == null) return "—";
  if (unit === "percent") return (v * 100).toFixed(1) + "%";
  if (unit === "amount") return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (unit === "days") return v.toFixed(0) + " يوم";
  return v.toFixed(2) + "×";
}

/* ═══════════════════════════════════════════════════════════════════════════─
 * Excel export — Charts sheet & Financial Analysis sheet
 * ═══════════════════════════════════════════════════════════════════════════─ */

/** Add a charts-data sheet to the workbook (data tables formatted for charting). */
export function addChartsSheet(
  wb: XLSX.WorkBook,
  cat: Categorized,
  T: Totals,
  L1: string,
  L2: string
): void {
  const aoa: (string | number | null)[][] = [
    ["الرسومات البيانية — مقارنة المؤشرات الرئيسية", "", "", ""],
    ["", "", "", ""],
    ["البند", L2 + " (الحالية)", L1 + " (المقارنة)", "التغير"],
  ];
  const metrics: [string, number, number][] = [
    ["الإيرادات", T.rev2, T.rev1],
    ["تكلفة الإيرادات", T.cost2, T.cost1],
    ["مجمل الربح", T.gross2, T.gross1],
    ["مصاريف البيع والتوزيع", T.sell2, T.sell1],
    ["المصاريف الإدارية", T.adm2, T.adm1],
    ["مصاريف تشغيلية أخرى", T.oth2, T.oth1],
    ["إجمالي مصاريف التشغيل", T.opex2, T.opex1],
    ["الربح التشغيلي", T.oper2, T.oper1],
    ["الدخل من مصادر أخرى", T.othRev2, T.othRev1],
    ["تكاليف التمويل", T.fin2, T.fin1],
    ["الربح قبل الضريبة", T.pbt2, T.pbt1],
    ["ضريبة الدخل", T.tax2, T.tax1],
    ["صافي الربح", T.net2, T.net1],
  ];
  if (T.comp2 !== T.net2) metrics.push(["إجمالي الدخل الشامل", T.comp2, T.comp1]);

  for (const [name, v2, v1] of metrics) {
    aoa.push([name, v2, v1, r2(v2 - v1)]);
  }

  // Expense breakdown section
  aoa.push(["", "", "", ""]);
  aoa.push(["توزيع المصروفات — الفترة الحالية", "", "", ""]);
  aoa.push(["البند", "المبلغ", "% من الإجمالي", ""]);
  const expItems: [string, number][] = [
    ["تكلفة الإيرادات", T.cost2],
    ["البيع والتوزيع", T.sell2],
    ["الإدارية والعمومية", T.adm2],
    ["تشغيلية أخرى", T.oth2],
    ["تكاليف التمويل", T.fin2],
    ["ضريبة الدخل", T.tax2],
  ];
  const expTotal = expItems.reduce((s, [, v]) => s + v, 0);
  for (const [name, v] of expItems) {
    aoa.push([name, v, expTotal !== 0 ? v / expTotal : null, ""]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const rg = XLSX.utils.decode_range(ws["!ref"]!);
  for (let R = 0; R <= rg.e.r; R++) {
    for (let c = 0; c <= 3; c++) {
      const ad = XLSX.utils.encode_cell({ r: R, c });
      if (!ws[ad]) ws[ad] = { t: "s", v: "" };
      const cl = ws[ad]!;
      if (R === 0 || R === 2 || (R > 2 && aoa[R]?.[0] === "توزيع المصروفات")) {
        cl.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: "1F4E79" } } };
        if (R === 0) continue;
      }
      if (cl.t === "n") {
        if (c === 1 || c === 2) cl.z = '#,##0.00;(#,##0.00);"—"';
        else if (c === 3) cl.z = '#,##0.00;(#,##0.00);"—"';
      }
    }
  }
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
  ws["!cols"] = [28, 16, 16, 16].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "الرسومات البيانية".slice(0, 31));
}

/** Add a financial analysis sheet to the workbook. */
export function addFinancialAnalysisSheet(
  wb: XLSX.WorkBook,
  ratioGroups: RatioGroup[],
  bs1: BalanceSheetTotals | null,
  bs2: BalanceSheetTotals | null,
  L1: string,
  L2: string
): void {
  const useBs1 = bs1 ?? bs2;
  const useBs2 = bs2 ?? bs1;
  const aoa: (string | number | null)[][] = [
    ["التحليل المالي — النسب والمؤشرات المالية", "", "", "", ""],
    ["", "", "", "", ""],
    ["النسبة", "الاسم الإنجليزي", "المعادلة", L1 + " (المقارنة)", L2 + " (الحالية)"],
  ];

  for (const group of ratioGroups) {
    aoa.push(["", "", "", "", ""]);
    aoa.push([`■ ${group.title} — ${group.titleEn}`, "", "", "", ""]);
    for (const r of group.ratios) {
      aoa.push([r.name, r.nameEn, r.formula, r.v1, r.v2]);
    }
  }

  // Balance sheet summary (both periods)
  aoa.push(["", "", "", "", ""]);
  aoa.push(["■ ملخص قائمة المركز المالي", "", "", "", ""]);
  if (useBs1 && useBs2) {
    const bsItems: [string, number | null, number | null][] = [
      ["الأصول المتداولة", useBs1.currentAssets, useBs2.currentAssets],
      ["الأصول غير المتداولة", useBs1.nonCurrentAssets, useBs2.nonCurrentAssets],
      ["إجمالي الأصول", useBs1.totalAssets, useBs2.totalAssets],
      ["الخصوم المتداولة", useBs1.currentLiabilities, useBs2.currentLiabilities],
      ["الخصوم غير المتداولة", useBs1.nonCurrentLiabilities, useBs2.nonCurrentLiabilities],
      ["إجمالي الخصوم", useBs1.totalLiabilities, useBs2.totalLiabilities],
      ["حقوق الملكية", useBs1.equity, useBs2.equity],
      ["المخزون", useBs1.inventory, useBs2.inventory],
      ["النقدية وما يعادلها", useBs1.cash, useBs2.cash],
      ["المدينون", useBs1.receivables, useBs2.receivables],
      ["الأصول الثابتة", useBs1.fixedAssets, useBs2.fixedAssets],
      ["الدائنون / الموردون", useBs1.payables, useBs2.payables],
      ["قروض قصيرة الأجل", useBs1.shortTermDebt, useBs2.shortTermDebt],
      ["قروض طويلة الأجل", useBs1.longTermDebt, useBs2.longTermDebt],
      ["رأس المال العامل", r2(useBs1.currentAssets - useBs1.currentLiabilities), r2(useBs2.currentAssets - useBs2.currentLiabilities)],
    ];
    for (const [label, v1, v2] of bsItems) {
      aoa.push([label, "", "", v1, v2]);
    }
  } else if (useBs1) {
    const bsItems: [string, number | null][] = [
      ["الأصول المتداولة", useBs1.currentAssets],
      ["الأصول غير المتداولة", useBs1.nonCurrentAssets],
      ["إجمالي الأصول", useBs1.totalAssets],
      ["الخصوم المتداولة", useBs1.currentLiabilities],
      ["الخصوم غير المتداولة", useBs1.nonCurrentLiabilities],
      ["إجمالي الخصوم", useBs1.totalLiabilities],
      ["حقوق الملكية", useBs1.equity],
      ["المخزون", useBs1.inventory],
      ["النقدية وما يعادلها", useBs1.cash],
      ["المدينون", useBs1.receivables],
      ["الأصول الثابتة", useBs1.fixedAssets],
      ["الدائنون / الموردون", useBs1.payables],
      ["قروض قصيرة الأجل", useBs1.shortTermDebt],
      ["قروض طويلة الأجل", useBs1.longTermDebt],
      ["رأس المال العامل", r2(useBs1.currentAssets - useBs1.currentLiabilities)],
    ];
    for (const [label, v] of bsItems) {
      aoa.push([label, "", "", v, v]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const rg = XLSX.utils.decode_range(ws["!ref"]!);
  for (let R = 0; R <= rg.e.r; R++) {
    for (let c = 0; c <= 4; c++) {
      const ad = XLSX.utils.encode_cell({ r: R, c });
      if (!ws[ad]) ws[ad] = { t: "s", v: "" };
      const cl = ws[ad]!;
      const label = aoa[R]?.[0] ? String(aoa[R][0]) : "";
      if (R <= 2 || label.startsWith("■")) {
        cl.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: "1F4E79" } } };
        continue;
      }
      if (cl.t === "n") {
        if (c === 3 || c === 4) cl.z = '#,##0.00;(#,##0.00);"—"';
      }
      cl.s = { alignment: { vertical: "center" }, font: {} };
    }
  }
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }];
  ws["!cols"] = [30, 26, 38, 16, 16].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "التحليل المالي".slice(0, 31));
}

/* ════════════════════════════════════════════════════════════════════════════
 * Chart-of-Accounts Excel Export — 3 sheets
 *
 *   Sheet 1: «مطابقة دليل الحسابات» — full comparison (all rows)
 *   Sheet 2: «تغير رقم الحساب»     — only rows whose account number changed
 *   Sheet 3: «تغير الموقع الجوهري» — only rows whose category changed
 * ════════════════════════════════════════════════════════════════════════════ */

export interface ChartExportLabels { L1: string; L2: string; }

const CHART_STATUS_COLORS: Record<MatchStatus, string> = {
  "مطابق": "1F7A3A",                      // green — Sheet 1
  "مطابق الاسم مختلف الرقم": "B8860B",   // amber — Sheet 2
  "تغير جوهري": "B22222",                // red — Sheet 4
  "في الملف الأول فقط": "6B7280",         // slate — Sheet 3
  "في الملف الثاني فقط": "6B7280",         // slate — Sheet 3
  "غير مطابق": "9CA3AF",                  // grey — Sheet 3
};

function chartRowToAoa(r: MatchedRow): (string | number | null)[] {
  const num1 = r.a1?.num ?? "";
  const name1 = r.a1?.nm ?? "";
  const cat1 = r.cat1 ?? "";
  const num2 = r.a2?.num ?? "";
  const name2 = r.a2?.nm ?? "";
  const cat2 = r.cat2 ?? "";
  const sim = r.sim != null ? r.sim : "";
  const diff = name1 && name2 ? summarizeDiff(name1, name2) : "—";
  const amt1 = r.amt1 ?? null;
  const amt2 = r.amt2 ?? null;
  const amtChange = r.amtChange ?? null;
  const amtChangePct = r.amtChangePct != null ? Math.round(r.amtChangePct * 100) / 100 : null;
  return [num1, name1, cat1, num2, name2, cat2, sim, diff, amt1, amt2, amtChange, amtChangePct, r.st];
}

function styleChartSheet(ws: XLSX.WorkSheet, aoa: (string | number | null)[][], numCols: number): void {
  const rg = XLSX.utils.decode_range(ws["!ref"]);
  // 0=num1 1=name1 2=cat1 3=num2 4=name2 5=cat2 6=sim% 7=diff 8=amt1 9=amt2 10=amtChange 11=amtChangePct 12=status
  const SIM_COL = 6, DIFF_COL = 7, AMT1_COL = 8, AMT2_COL = 9, CHG_COL = 10, CHG_PCT_COL = 11, ST_COL = numCols - 1;
  for (let R = 0; R <= rg.e.r; R++) {
    for (let c = 0; c < numCols; c++) {
      const ad = XLSX.utils.encode_cell({ r: R, c });
      if (!ws[ad]) ws[ad] = { t: "s", v: "" };
      const cl = ws[ad];
      if (R <= 2) {
        cl.s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { patternType: "solid", fgColor: { rgb: "1F4E79" } },
          alignment: { horizontal: "center", vertical: "center" },
        };
        continue;
      }
      const stCell = ws[XLSX.utils.encode_cell({ r: R, c: ST_COL })];
      const st = String(stCell?.v ?? "");
      const color = CHART_STATUS_COLORS[st as MatchStatus] || "374151";
      const isCenter = c === 0 || c === 3 || c === SIM_COL || c === ST_COL;
      cl.s = {
        alignment: { vertical: "center", horizontal: isCenter ? "center" : "right" },
        font: c === ST_COL ? { bold: true, color: { rgb: color } } : {},
      };
      // Numeric formats
      if (cl.t === "n") {
        if (c === SIM_COL) cl.z = '0"%"';
        else if (c === AMT1_COL || c === AMT2_COL || c === CHG_COL) cl.z = '#,##0.00;(#,##0.00);"—"';
        else if (c === CHG_PCT_COL) cl.z = '0.00"%";(0.00"%");"—"';
      }
      // Similarity tier coloring
      if (c === SIM_COL && typeof cl.v === "number") {
        const v = cl.v;
        if (v === 100) cl.s = { ...cl.s, font: { bold: true, color: { rgb: "1F7A3A" } } };
        else if (v >= 90) cl.s = { ...cl.s, font: { color: { rgb: "16A34A" } } };
        else if (v >= 80) cl.s = { ...cl.s, font: { color: { rgb: "65A30D" } } };
        else if (v >= 50) cl.s = { ...cl.s, font: { color: { rgb: "B8860B" } } };
      }
      // Diff cell highlighting
      if (c === DIFF_COL) {
        const dv = String(cl.v ?? "");
        if (dv && dv !== "—" && dv !== "مطابق تام") {
          cl.s = {
            ...cl.s,
            fill: { patternType: "solid", fgColor: { rgb: "FFF7E0" } },
            font: { color: { rgb: "92400E" } },
          };
        }
      }
      // Amount change coloring (green for increase, red for decrease)
      if (c === CHG_COL && typeof cl.v === "number") {
        if (cl.v > 0) cl.s = { ...cl.s, font: { color: { rgb: "16A34A" } } };
        else if (cl.v < 0) cl.s = { ...cl.s, font: { color: { rgb: "DC2626" } } };
      }
      if (c === CHG_PCT_COL && typeof cl.v === "number") {
        if (cl.v > 0) cl.s = { ...cl.s, font: { color: { rgb: "16A34A" } } };
        else if (cl.v < 0) cl.s = { ...cl.s, font: { color: { rgb: "DC2626" } } };
      }
      // Highlight category cells when category changed (fundamental change)
      if ((c === 2 || c === 5) && st === "تغير جوهري") {
        cl.s = { ...cl.s, fill: { patternType: "solid", fgColor: { rgb: "FDECEA" } } };
      }
      // Highlight number cells when num changed (Sheet 2 + Sheet 4)
      if ((c === 0 || c === 3) && (st === "مطابق الاسم مختلف الرقم" || st === "تغير جوهري")) {
        cl.s = { ...cl.s, fill: { patternType: "solid", fgColor: { rgb: "FFF7E0" } } };
      }
    }
  }
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: numCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: numCols - 1 } },
  ];
}

function addChartSheet(
  wb: XLSX.WorkBook,
  rows: MatchedRow[],
  sheetName: string,
  title: string,
  L1: string,
  L2: string
): void {
  const numCols = 13;
  const hdrRow = [
    `رقم (${L1})`, `اسم الحساب (${L1})`, `التصنيف (${L1})`,
    `رقم (${L2})`, `اسم الحساب (${L2})`, `التصنيف (${L2})`,
    "نسبة التطابق %", "الفارق في التطابق",
    `رصيد ${L1}`, `رصيد ${L2}`, "التغير", "نسبة التغير %",
    "الحالة",
  ];
  const titleRow = [title, ...new Array(numCols - 1).fill("")];
  const subRow = [`مقارنة بين: ${L1} — و: ${L2}`, ...new Array(numCols - 1).fill("")];
  const aoa: (string | number | null)[][] = [titleRow, subRow, hdrRow];
  for (const r of rows) aoa.push(chartRowToAoa(r));

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  styleChartSheet(ws, aoa, numCols);
  ws["!cols"] = [12, 30, 12, 12, 30, 12, 12, 22, 14, 14, 14, 14, 18].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
}

/** Export chart-of-accounts comparison as a 4-sheet xlsx workbook.
 *   Sheet 1 «مطابق الاسم والرقم»     — both name AND number match
 *   Sheet 2 «مطابق الاسم مختلف الرقم» — name matches (≥90%), number differs, same category
 *   Sheet 3 «غير المطابق»            — unmatched (in one file only)
 *   Sheet 4 «التغيرات الجوهرية»      — fundamental changes (category shift OR rename OR both differ)
 */
export async function exportChartToExcel(
  rows: MatchedRow[],
  labels: ChartExportLabels
): Promise<void> {
  const { L1, L2 } = labels;
  const wb = XLSX.utils.book_new();

  // Sheet 1: matched (both name AND number)
  const matchedRows = rows.filter((r) => r.st === "مطابق");
  addChartSheet(wb, matchedRows, "مطابق الاسم والرقم", "الحسابات المطابقة بالاسم والرقم", L1, L2);

  // Sheet 2: matched name, different number, same category
  const nameMatchNumDiffRows = rows.filter((r) => r.st === "مطابق الاسم مختلف الرقم");
  addChartSheet(wb, nameMatchNumDiffRows, "مطابق الاسم مختلف الرقم", "الحسابات المطابقة بالاسم والمختلفة برقم الحساب (نفس التصنيف)", L1, L2);

  // Sheet 3: unmatched (in one file only)
  const unmatchedRows = rows.filter((r) => r.st === "في الملف الأول فقط" || r.st === "في الملف الثاني فقط" || r.st === "غير مطابق");
  addChartSheet(wb, unmatchedRows, "غير المطابق", "الحسابات غير المطابقة (موجودة في ملف واحد فقط)", L1, L2);

  // Sheet 4: fundamental changes (category shift OR rename OR both differ)
  const fundamentalRows = rows.filter((r) => r.st === "تغير جوهري");
  addChartSheet(wb, fundamentalRows, "التغيرات الجوهرية", "التغيرات الجوهرية: تغير التصنيف (أصول ↔ خصوم ↔ مصروفات ↔ إيرادات) أو إعادة تسمية الحساب أو تغير الاسم والرقم معًا", L1, L2);

  wb.Workbook = { Views: [{ RTL: true }] };
  if (typeof document !== "undefined") {
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "مطابقة_دليل_الحسابات.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  }
}
