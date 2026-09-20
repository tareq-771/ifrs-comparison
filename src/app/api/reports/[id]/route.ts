import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import {
  writeAudit,
  writeAuditSafe,
  getClientIp,
  diffReportForAudit,
  reportBlobSizes,
} from "@/lib/audit";
import { buildWorkflowInfo, canViewReportRow } from "@/lib/workflow-server";
import {
  EDITABLE_STATUSES,
  WORKFLOW_STATUS_LABELS,
  isEditableStatus,
  normalizePeriodEndStrict,
} from "@/lib/workflow";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

// GET /api/reports/[id] — get a single report by ID
//   Allowed if: owner OR linked-group member OR workflow participant
//   (prepared/reviewed/approved) OR admin.
//   الاستجابة تتضمن version + updatedAt (القفل التفاؤلي) + كائن workflow محسوب
//   خادميًا (الحالة + المشاركون + myActions — الواجهة تعرض ما يسمح به الخادم فقط).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireAuth();
    const { id } = await params;
    const report = await db.report.findUnique({ where: { id } });
    if (!report || !canViewReportRow(report, user)) {
      return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
    }
    const workflow = await buildWorkflowInfo(report, user);
    return NextResponse.json({ ...report, workflow });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في جلب التقرير: " + msg : msg },
      { status }
    );
  }
}

/**
 * صلاحية تعديل بيانات المطابقة (المرحلة 3 — تحل محل الكتابة التعاونية للمجموعات):
 *   - المعدّ المعيّن (preparedById) فقط.
 *   - + صلاحية edit نظامية (شرط لازم).
 *   - + حالة قابلة للتعديل (DRAFT / RETURNED / REOPENED).
 * عضوية المجموعة تمنح الرؤية والأهلية للإسناد فقط — لا الكتابة.
 * المدير لا يتجاوز هذا القفل (REOPEN هو مساره لتعديل معتمد).
 */
function editGate(
  report: { status: string; preparedById: string | null; version: number },
  user: { id: string; role: string; permissions: { edit?: boolean } }
): { ok: true } | { ok: false; status: 403; body: Record<string, unknown> } {
  if (report.preparedById !== user.id) {
    const isParticipantWithoutEdit =
      report.preparedById !== null && report.preparedById !== user.id;
    return {
      ok: false,
      status: 403,
      body: {
        error: isParticipantWithoutEdit
          ? "تعديل بيانات المطابقة يتم من المعدّ المعيّن لهذا التقرير فقط."
          : "لا تملك صلاحية تعديل هذا التقرير — التعديل للمعدّ المعيّن فقط.",
        code: "NOT_ASSIGNED",
        currentStatus: report.status,
        currentVersion: report.version,
      },
    };
  }
  if (!user.permissions.edit && user.role !== "admin") {
    return {
      ok: false,
      status: 403,
      body: {
        error: "لا تملك صلاحية التعديل (edit) في النظام.",
        code: "FORBIDDEN",
        currentStatus: report.status,
        currentVersion: report.version,
      },
    };
  }
  if (!isEditableStatus(report.status)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: `التقرير مقفل حاليًا — الحالة: «${WORKFLOW_STATUS_LABELS[report.status as keyof typeof WORKFLOW_STATUS_LABELS] ?? report.status}». لا يمكن تعديل بيانات المطابقة في هذه الحالة.`,
        code: "WORKFLOW_LOCKED",
        currentStatus: report.status,
        currentVersion: report.version,
      },
    };
  }
  return { ok: true };
}

/** آخر من عدّل التقرير — من سجل التدقيق (مصدر موثوق منذ المرحلة 1). */
async function getLastModifier(reportId: string) {
  const last = await db.auditLog.findFirst({
    where: { entityId: reportId, action: AUDIT_ACTIONS.REPORT_UPDATED },
    orderBy: { createdAt: "desc" },
    select: { username: true, createdAt: true },
  });
  return last
    ? { username: last.username || null, at: last.createdAt.toISOString() }
    : null;
}

// PUT /api/reports/[id] — update a report with optimistic locking + workflow gate
//
// العقد (المراحل 2+3):
//   - version إلزامية؛ التحديث ذري عبر UPDATE ... WHERE id=? AND version=?
//     AND status IN (DRAFT,RETURNED,REOPENED) AND preparedById=? — عبارة واحدة ذرية
//     تحمي من تعارض النسخ ومن السباق مع انتقالات Workflow (مثل SUBMIT المتزامن).
//   - النجاح: version +1 فقط وتُعاد النسخة الكاملة الجديدة + كائن workflow.
//   - التعارض: 409 VERSION_CONFLICT structured بلا Last Write Wins ولا Force Overwrite
//     + تدقيق REPORT_UPDATE_CONFLICT بلا أي تعديل بيانات.
//   - القفل: حفظ على SUBMITTED/UNDER_REVIEW/APPROVED أو من غير المعدّ ⇒ 403 قبل كل شيء.
//   - حقول Workflow لا تتغير عبر هذا المسار إطلاقًا (مسارها endpoint الانتقالات والإسناد).
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireAuth();
    const { id } = await params;
    const existing = await db.report.findUnique({ where: { id } });
    if (!existing || !canViewReportRow(existing, user)) {
      return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
    }

    /* ── 0) بوابة Workflow: المعدّ المعيّن + صلاحية edit + حالة قابلة للتعديل ── */
    const gate = editGate(existing, user);
    if (!gate.ok) {
      return NextResponse.json(gate.body, { status: gate.status });
    }

    const body = await req.json();

    /* ── 1) التحقق من نسخة العميل (إلزامية وصحيحة) ─────────────────────── */
    const clientVersion = body.version;
    if (clientVersion === undefined || clientVersion === null || clientVersion === "") {
      return NextResponse.json(
        {
          error:
            "الحفظ يتطلب إرسال نسخة التقرير (version) التي فتحتها. أعد تحميل التقرير ثم حاول مجددًا.",
          code: "VERSION_REQUIRED",
          currentVersion: existing.version,
          currentStatus: existing.status,
          updatedAt: existing.updatedAt.toISOString(),
        },
        { status: 400 }
      );
    }
    const versionNum = Number(clientVersion);
    if (!Number.isInteger(versionNum) || versionNum < 1) {
      return NextResponse.json(
        {
          error: "قيمة النسخة (version) غير صحيحة — يجب أن تكون عددًا صحيحًا موجبًا.",
          code: "VERSION_INVALID",
          currentVersion: existing.version,
          currentStatus: existing.status,
          updatedAt: existing.updatedAt.toISOString(),
        },
        { status: 400 }
      );
    }

    /* ── 2) periodEnd — مفهوم أعمال date-only بلا timezone ─────────────── */
    const pe = normalizePeriodEndStrict(body.periodEnd);
    if (pe.invalid) {
      return NextResponse.json(
        {
          error: "تاريخ نهاية الفترة المالية غير صحيح — الصيغة المطلوبة YYYY-MM-DD.",
          code: "PERIOD_END_INVALID",
          currentVersion: existing.version,
          currentStatus: existing.status,
        },
        { status: 400 }
      );
    }

    /* ── 3) تغيير المجموعة (اختياري — كما كان) ─────────────────────────── */
    let groupId: string | null | undefined = undefined;
    if (body.groupId !== undefined) {
      if (body.groupId === null || body.groupId === "") {
        groupId = null;
      } else {
        const gid = body.groupId.toString();
        const group = await db.group.findUnique({ where: { id: gid } });
        const linkedGroupIds = Array.isArray(user.permissions.groupIds)
          ? user.permissions.groupIds
          : [];
        if (!group || (group.userId !== user.id && !linkedGroupIds.includes(gid))) {
          return NextResponse.json(
            { error: "المجموعة غير موجودة" },
            { status: 404 }
          );
        }
        groupId = gid;
      }
    }

    const data: Record<string, unknown> = {
      name: body.name,
      label1: body.label1,
      label2: body.label2,
      compareMode: body.compareMode,
      numMonths: body.numMonths,
      isSettings: JSON.stringify(body.isSettings || {}),
      bsSettings: JSON.stringify(body.bsSettings || {}),
      isFile1Data: JSON.stringify(body.isFile1Data || []),
      isFile2Data: JSON.stringify(body.isFile2Data || []),
      isFile1Headers: JSON.stringify(body.isFile1Headers || []),
      isFile2Headers: JSON.stringify(body.isFile2Headers || []),
      isFile1Cols: JSON.stringify(body.isFile1Cols || {}),
      isFile2Cols: JSON.stringify(body.isFile2Cols || {}),
      bsFileData: JSON.stringify(body.bsFile1Data ?? body.bsFileData ?? []),
      bsFileHeaders: JSON.stringify(body.bsFile1Headers ?? body.bsFileHeaders ?? []),
      bsFileCols: JSON.stringify(body.bsFile1Cols ?? body.bsFileCols ?? {}),
      bsFile2Data: JSON.stringify(body.bsFile2Data || []),
      bsFile2Headers: JSON.stringify(body.bsFile2Headers || []),
      bsFile2Cols: JSON.stringify(body.bsFile2Cols || {}),
    };
    if (groupId !== undefined) data.groupId = groupId;
    if (pe.value !== undefined) data.periodEnd = pe.value;

    // حساب الفروق قبل التحديث (للأثر الرقابي — دون تخزين الكتل الضخمة)
    const diff = diffReportForAudit(existing, body as Record<string, unknown>);
    const hasChanges = diff.changedFields.length > 0;

    /* ── 4) التحديث الذري المشروط بالنسخة والحالة والمعدّ + أثره في نفس المعاملة ── */
    const updatedCount = await db.$transaction(async (tx) => {
      const res = await tx.report.updateMany({
        where: {
          id,
          version: versionNum,
          status: { in: EDITABLE_STATUSES },
          preparedById: user.id,
        },
        data: { ...data, version: { increment: 1 } },
      });
      if (res.count === 0) return 0;
      if (hasChanges) {
        await writeAudit(tx, {
          user,
          action: AUDIT_ACTIONS.REPORT_UPDATED,
          entityType: AUDIT_ENTITY_TYPES.Report,
          entityId: id,
          description: `تعديل التقرير «${body.name ?? existing.name}» (v${versionNum} → v${versionNum + 1}) — الحقول المتغيرة: ${diff.changedFields.join(", ")}`,
          before: diff.before,
          after: diff.after,
          metadata: {
            changedFields: diff.changedFields,
            blobChanges: diff.blobChanges,
            fromVersion: versionNum,
            toVersion: versionNum + 1,
            status: existing.status,
          },
          ip: getClientIp(req),
        });
      }
      return res.count;
    });

    if (updatedCount === 0) {
      /* ── 5) تعارض أو قفل متزامن أو حذف متزامن: لا تعديل إطلاقًا ────────── */
      const current = await db.report.findUnique({
        where: { id },
        select: { version: true, updatedAt: true, name: true, status: true, preparedById: true },
      });
      if (!current) {
        // حُذف التقرير بين فحص البوابة والتحديث — لا شيء للتعارض معه
        return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
      }
      // لو تغيرت الحالة/المعدّ بين القراءة والكتابة ⇒ قفل وليس تعارض نسخ
      if (!isEditableStatus(current.status) || current.preparedById !== user.id) {
        return NextResponse.json(
          {
            error: `تعذر الحفظ لأن حالة/إسناد التقرير تغيّر للتو — الحالة الحالية: «${WORKFLOW_STATUS_LABELS[current.status as keyof typeof WORKFLOW_STATUS_LABELS] ?? current.status}». أعد تحميل التقرير.`,
            code: "WORKFLOW_LOCKED",
            currentStatus: current.status,
            currentVersion: current.version,
            updatedAt: current.updatedAt.toISOString(),
          },
          { status: 403 }
        );
      }
      const lastModifier = await getLastModifier(id);
      // تدقيق محاولة الحفظ المتعارضة (حدث مستقل — لا يرافق أي تعديل بيانات)
      await writeAuditSafe({
        user,
        action: AUDIT_ACTIONS.REPORT_UPDATE_CONFLICT,
        entityType: AUDIT_ENTITY_TYPES.Report,
        entityId: id,
        description: `محاولة حفظ التقرير «${current.name}» بنسخة أقدم (العميل v${versionNum} · الخادم v${current.version}) — لم يُنفذ أي تعديل`,
        metadata: {
          reportId: id,
          clientVersion: versionNum,
          currentVersion: current.version,
          changedFields: diff.changedFields,
        },
        ip: getClientIp(req),
      });
      return NextResponse.json(
        {
          error:
            "تعذر حفظ التغييرات لأن هذا التقرير تم تعديله من مستخدم آخر بعد فتحه لديك.",
          code: "VERSION_CONFLICT",
          clientVersion: versionNum,
          currentVersion: current.version,
          currentStatus: current.status,
          updatedAt: current.updatedAt.toISOString(),
          lastModifiedBy: lastModifier?.username ?? null,
          lastModifiedAt: lastModifier?.at ?? null,
        },
        { status: 409 }
      );
    }

    /* ── 6) نجاح: أعِد النسخة الكاملة الجديدة + كائن workflow ───────────── */
    const report = await db.report.findUnique({ where: { id } });
    const workflow = report ? await buildWorkflowInfo(report, user) : null;
    return NextResponse.json({ ...(report ?? {}), workflow });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في تحديث التقرير: " + msg : msg },
      { status }
    );
  }
}

// DELETE /api/reports/[id] — delete a report (owner only, DRAFT only)
// المرحلة 3: الحذف مسموح في حالة DRAFT فقط حفاظًا على الأثر الرقابي للتقارير
// قيد الدورة أو المعتمدة (قرار D-3). الحذف الناعم/الأرشفة سيأتي في مرحلة Backup/Restore.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireAuth();
    const { id } = await params;
    const existing = await db.report.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
    }
    if (existing.status !== "DRAFT") {
      return NextResponse.json(
        {
          error: `لا يمكن حذف التقرير في حالة «${WORKFLOW_STATUS_LABELS[existing.status as keyof typeof WORKFLOW_STATUS_LABELS] ?? existing.status}» — الحذف متاح للمسودة فقط.`,
          code: "WORKFLOW_LOCKED",
          currentStatus: existing.status,
        },
        { status: 403 }
      );
    }
    // الحذف + تسجيل أثره الرقابي في نفس المعاملة (ذرية كاملة)
    await db.$transaction(async (tx) => {
      await tx.report.delete({ where: { id } });
      await writeAudit(tx, {
        user,
        action: AUDIT_ACTIONS.REPORT_DELETED,
        entityType: AUDIT_ENTITY_TYPES.Report,
        entityId: id,
        description: `حذف التقرير «${existing.name}» (مسودة)`,
        before: {
          name: existing.name,
          label1: existing.label1,
          label2: existing.label2,
          compareMode: existing.compareMode,
          numMonths: existing.numMonths,
          groupId: existing.groupId,
          version: existing.version,
          status: existing.status,
        },
        metadata: {
          blobSizes: reportBlobSizes(existing as unknown as Record<string, unknown>),
        },
        ip: getClientIp(req),
      });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في حذف التقرير: " + msg : msg },
      { status }
    );
  }
}
