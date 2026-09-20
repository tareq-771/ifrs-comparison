// Phase 4A.1 — هوية المخطط: بصمتان منفصلتان بغرضين منفصلين.
//
// 1) canonicalSchemaFingerprint — البصمة الحاكمة (معيار قبول/رفض النسخ):
//    تُبنى من metadata دلالية normalized (أسماء الجداول/الأعمدة/الأنواع/
//    الـnullability/دلالة الافتراضات/PK/unique/الفهارس المسماة/FKs) بعد فرز
//    كل شيء بالاسم — لذلك لا تتغير بمجرد اختلاف «الترتيب الفيزيائي للأعمدة»
//    بين مخططين متكافئين دلاليًا (حالة drift جدول Report الموثق).
//
// 2) physicalSchemaFingerprint — تشخيصية فقط (لا تدخل في أي قرار قبول/رفض):
//    تجزئة نص DDL من sqlite_master كما هو (normalized whitespace) — تلتقط
//    اختلاف الترتيب النصي وتُستخدم لتوثيق الـdrift الفيزيائي حصرًا.
//
// قرارات موثقة:
//  - _prisma_migrations مستبعدة من البصمتين (كتاب تشغيلي للترحيلات وليس جزءًا
//    من المخطط الدلالي) — كي لا تتغير الهوية بعد migrate resolve/deploy.
//  - جداول sqlite_% الداخلية مستبعدة.
//  - الـViews/Triggers غير موجودة في مخطط Prisma ولا تُحتسب (لو أُنشئت يدويًا
//    فيتغير physical فقط — والقرار يبقى على canonical).
//  - قيود CHECK غير معروضة عبر PRAGMA (لا يوجد أي CHECK في المخطط) — قيد
//    معروف وموثق على الخوارزمية canonical-v1.
//  - بادئة canonical: «csha256:» لتفادي الخلط مع البصمة الفيزيائية «sha256:».
//
// إصدار الخوارزمية: canonical-v1 — أي تغيير مستقبلي في بنية النموذج يجب أن
// يرفع رقم الإصدار (ويُسجل في KNOWN_SCHEMAS) كي لا تتطابق هويات غير متكافئة.

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/* ──────────────────────────────────────────────────────────────────────── */
/*  النموذج الدلالي                                                         */
/* ──────────────────────────────────────────────────────────────────────── */

/** دلالة الافتراض: lit=نص حرفي، kw=كلمة مفتاحية، num=رقم، expr=تعبير عام. */
export interface CanonicalDefault {
  kind: "lit" | "kw" | "num" | "expr";
  value: string;
}

export interface CanonicalColumn {
  name: string;
  type: string; // uppercase + whitespace موحد
  notNull: boolean; // دلاليًا: notnull=1 أو جزء من PK
  default: CanonicalDefault | null;
}

export interface CanonicalForeignKey {
  fromColumns: string[]; // بترتيب seq داخل القيد
  toTable: string;
  /** null = يحيل إلى PK للجدول الهدف ضمنيًا (to فارغ في PRAGMA) */
  toColumns: Array<string | null>;
  onUpdate: string;
  onDelete: string;
}

export interface CanonicalIndex {
  name: string; // فهارس مسماة (CREATE INDEX) حصرًا — أسماء autoindex تُتجاهل
  unique: boolean;
  columns: string[]; // بترتيب الأعمدة داخل الفهرس (دلالي للافتراضات)
}

export interface CanonicalTable {
  name: string;
  columns: CanonicalColumn[]; // مرتبة بالاسم — لا اعتبار للترتيب الفيزيائي
  primaryKey: string[]; // بترتيب ordinal داخل PK (دلالي)
  uniqueConstraints: string[][]; // من origin='u' — مجموعات أعمدة (مرتبة داخليًا والقائمة مرتبة)
  indexes: CanonicalIndex[]; // origin='c' فقط — مرتبة بالاسم
  foreignKeys: CanonicalForeignKey[]; // مرتبة بـ(fromTable..fromColumns)
}

export interface CanonicalSchemaModel {
  algorithm: "canonical-v1";
  tables: CanonicalTable[]; // مرتبة بالاسم
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  أدوات التطبيع                                                           */
/* ──────────────────────────────────────────────────────────────────────── */

function normalizeType(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** تطبيع دلالي لقيمة DEFAULT من PRAGMA table_info (dflt_value نص SQL خام). */
function normalizeDefault(raw: unknown): CanonicalDefault | null {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (text.length === 0) return null;
  // نص حرفي: '...' مع معالجة التهريب '' — يُحفظ كقيمة داخلية (لا لحظة الإعلان)
  const lit = text.match(/^'(.*)'$/s);
  if (lit) {
    return { kind: "lit", value: lit[1].replace(/''/g, "'") };
  }
  const upper = text.toUpperCase();
  if (upper === "CURRENT_TIMESTAMP" || upper === "TRUE" || upper === "FALSE" || upper === "NULL") {
    // SQLite قد يخزن true/false كـ1/0 — وحّد الدلالة الثنائية
    if (upper === "TRUE") return { kind: "kw", value: "TRUE" };
    if (upper === "FALSE") return { kind: "kw", value: "FALSE" };
    if (upper === "NULL") return { kind: "kw", value: "NULL" };
    return { kind: "kw", value: "CURRENT_TIMESTAMP" };
  }
  if (/^-?\d+$/.test(text)) {
    // أرقام صحيحة: وحّد الصيغة (زائد مبتسر، أصفار مبتثرة غير واردة في SQL المعياري لكن احتياطًا)
    text = String(parseInt(text, 10));
    return { kind: "num", value: text };
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    return { kind: "num", value: text };
  }
  // 1/0 قد يرمزان لـ true/false (SQLite يخزن BOOLEAN هكذا) — يُترك num كما هو:
  // نفس النص في الطرفين يعني نفس الدلالة، ولا نزيله لتفادي خلط حرفي.
  return { kind: "expr", value: text.replace(/\s+/g, " ").trim() };
}

function sortPairs(a: string[], b: string[]): number {
  return a.join("\u0000").localeCompare(b.join("\u0000"));
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  بناء النموذج من قاعدة فعلية (Prisma client على ملف/تشغيل)               */
/* ──────────────────────────────────────────────────────────────────────── */

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: "c" | "u" | "pk";
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  name: string | null;
}

interface FkListRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

/**
 * PRAGMA يعيد أعدادًا كـBigInt عبر $queryRawUnsafe (علّة موثقة منذ 4A) —
 * تُحوّل لـnumber هنا بشكل دفاعي شامل حتى لا تتسرب إلى النموذج/التجزئة.
 */
function num<T>(row: T, keys: Array<keyof T>): T {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "bigint") (row as Record<string, unknown>)[k as string] = Number(v);
  }
  return row;
}

export async function buildCanonicalSchemaModel(client: PrismaClient): Promise<CanonicalSchemaModel> {
  const tables = await client.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name != '_prisma_migrations'
     ORDER BY name`
  );

  const model: CanonicalTable[] = [];

  for (const { name: tableName } of tables) {
    // ── الأعمدة (مرتبة بالاسم — إبطال الترتيب الفيزيائي عمدًا)
    const cols = (await client.$queryRawUnsafe<TableInfoRow[]>(`PRAGMA table_info('${tableName.replace(/'/g, "''")}')`)).map(
      (c) => num(c, ["cid", "notnull", "pk"])
    );
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const columns: CanonicalColumn[] = cols
      .map((c) => ({
        name: c.name,
        type: normalizeType(c.type),
        notNull: c.notnull === 1 || c.pk > 0,
        default: normalizeDefault(c.dflt_value),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // ── الفهارس: نفصل unique constraints (origin='u') عن الفهارس المسماة (origin='c')
    const idxList = (
      await client.$queryRawUnsafe<IndexListRow[]>(`PRAGMA index_list('${tableName.replace(/'/g, "''")}')`)
    ).map((i) => num(i, ["seq", "unique", "partial"]));
    const uniqueConstraints: string[][] = [];
    const indexes: CanonicalIndex[] = [];
    for (const idx of idxList) {
      const info = (
        await client.$queryRawUnsafe<IndexInfoRow[]>(`PRAGMA index_info('${idx.name.replace(/'/g, "''")}')`)
      ).map((r) => num(r, ["seqno"]));
      const ordered = [...info].sort((a, b) => a.seqno - b.seqno);
      const colNames = ordered.map((r) => r.name ?? "<expr>");
      if (idx.origin === "u") {
        // قيد UNIQUE — الاسم autoindex لا يُعتبر؛ المجموعة الدلالية فقط
        uniqueConstraints.push([...colNames].sort((a, b) => a.localeCompare(b)));
      } else if (idx.origin === "c") {
        // فهرس مسمى صريح — الاسم جزء من الهوية (سلوك الاستعلامات يعتمد عليه)
        indexes.push({ name: idx.name, unique: idx.unique === 1, columns: colNames });
      }
      // origin='pk' يغطيه primaryKey أعلاه
    }
    uniqueConstraints.sort(sortPairs);
    indexes.sort((a, b) => a.name.localeCompare(b.name));

    // ── المفاتيح الأجنبية (تجميع حسب id للفهارس المركبة)
    const fkRows = (
      await client.$queryRawUnsafe<FkListRow[]>(`PRAGMA foreign_key_list('${tableName.replace(/'/g, "''")}')`)
    ).map((r) => num(r, ["id", "seq"]));
    const fkGroups = new Map<number, FkListRow[]>();
    for (const r of fkRows) {
      const list = fkGroups.get(r.id) ?? [];
      list.push(r);
      fkGroups.set(r.id, list);
    }
    const foreignKeys: CanonicalForeignKey[] = [...fkGroups.values()].map((rows) => {
      const ordered = [...rows].sort((a, b) => a.seq - b.seq);
      return {
        fromColumns: ordered.map((r) => r.from),
        toTable: ordered[0].table,
        toColumns: ordered.map((r) => (r.to === null || r.to === "" ? null : r.to)),
        onUpdate: String(ordered[0].on_update ?? "NO ACTION").toUpperCase(),
        onDelete: String(ordered[0].on_delete ?? "NO ACTION").toUpperCase(),
      };
    });
    foreignKeys.sort(
      (a, b) =>
        a.toTable.localeCompare(b.toTable) || sortPairs(a.fromColumns, b.fromColumns)
    );

    model.push({ name: tableName, columns, primaryKey: pkCols, uniqueConstraints, indexes, foreignKeys });
  }

  model.sort((a, b) => a.name.localeCompare(b.name));
  return { algorithm: "canonical-v1", tables: model };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  البصمتان                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

/** البصمة الحاكمة — من النموذج الدلالي المرتب. ثابتة أمام إعادة ترتيب الأعمدة الفيزيائي. */
export async function canonicalSchemaFingerprint(client: PrismaClient): Promise<string> {
  const model = await buildCanonicalSchemaModel(client);
  const canon = JSON.stringify(model);
  return "csha256:" + createHash("sha256").update(canon).digest("hex");
}

/**
 * البصمة الفيزيائية (تشخيصية فقط) — تجزئة نص sqlite_master normalized.
 * نفس خوارزمية Manifest v2 السابقة حرفيًا (computeSchemaFingerprint) كي تبقى
 * قيم schemaFingerprint في النسخ القديمة (legacy v2) قابلة للمقارنة.
 */
export async function physicalSchemaFingerprint(client: PrismaClient): Promise<string> {
  const rows = await client.$queryRawUnsafe<{ type: string; name: string; sql: string }[]>(
    `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name != '_prisma_migrations'
     ORDER BY type, name`
  );
  const canon = rows
    .map((r) => `${r.type}|${r.name}|${(r.sql ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return "sha256:" + createHash("sha256").update(canon).digest("hex");
}

/** اسم قديم محفوظ للتوافق — هو نفسه البصمة الفيزيائية. */
export const computeSchemaFingerprint = physicalSchemaFingerprint;

export function shortFingerprint(fp: string): string {
  return fp.replace(/^(c)?sha256:/, "").slice(0, 12);
}
