// أكواد عمليات سجل التدقيق — وحدة نقية (آمنة للاستيراد في العميل والخادم).
// لا تستورد أي شيء من الخادم (Prisma إلخ) حتى يمكن استخدامها في مكونات الواجهة.

// أكواد ثابتة قابلة للتقرير — تُضاف أكواد جديدة فقط عند تنفيذ وظائفها فعليًا
// (SUBMIT/REVIEW/APPROVE... في مرحلة Workflow، وBACKUP/RESTORE في مرحلة النسخ الاحتياطي).
export const AUDIT_ACTIONS = {
  REPORT_CREATED: "REPORT_CREATED",
  REPORT_UPDATED: "REPORT_UPDATED",
  REPORT_UPDATE_CONFLICT: "REPORT_UPDATE_CONFLICT",
  REPORT_DELETED: "REPORT_DELETED",
  // Workflow (المرحلة 3) — دورة الاعتماد وفصل المهام
  REPORT_SUBMITTED: "REPORT_SUBMITTED",
  REVIEW_STARTED: "REVIEW_STARTED",
  REVIEW_COMPLETED: "REVIEW_COMPLETED", // المرحلة 3.5 — توقيع المراجع وانتقال إلى PENDING_APPROVAL
  REPORT_RETURNED: "REPORT_RETURNED",
  REPORT_RESUBMITTED: "REPORT_RESUBMITTED",
  REPORT_APPROVED: "REPORT_APPROVED",
  REPORT_REOPENED: "REPORT_REOPENED",
  ASSIGNMENT_CHANGED: "ASSIGNMENT_CHANGED",
  DUE_DATE_CHANGED: "DUE_DATE_CHANGED", // المرحلة 3.5 — تغيير تاريخ الاستحقاق (حوكمة assignWorkflow)
  GROUP_CREATED: "GROUP_CREATED",
  GROUP_UPDATED: "GROUP_UPDATED",
  GROUP_DELETED: "GROUP_DELETED",
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_DISABLED: "USER_DISABLED",
  USER_ENABLED: "USER_ENABLED",
  USER_DELETED: "USER_DELETED",
  // Phase 6.1 (RECOVERY) — الأساس المالي: الشركات والسنوات والفترات وسياسة الإقفال
  COMPANY_CREATED: "COMPANY_CREATED",
  COMPANY_UPDATED: "COMPANY_UPDATED",
  COMPANY_DEACTIVATED: "COMPANY_DEACTIVATED",
  COMPANY_REACTIVATED: "COMPANY_REACTIVATED",
  COMPANY_DELETE_DENIED: "COMPANY_DELETE_DENIED",
  CLOSING_POLICY_UPDATED: "CLOSING_POLICY_UPDATED",
  FISCAL_YEAR_CREATED: "FISCAL_YEAR_CREATED",
  FISCAL_YEAR_BULK_CREATED: "FISCAL_YEAR_BULK_CREATED",
  FISCAL_YEAR_CLOSED: "FISCAL_YEAR_CLOSED",
  FISCAL_YEAR_LOCKED: "FISCAL_YEAR_LOCKED",
  FISCAL_YEAR_UNLOCKED: "FISCAL_YEAR_UNLOCKED",
  FISCAL_YEAR_REOPENED: "FISCAL_YEAR_REOPENED",
  FISCAL_YEAR_PROVISIONAL_CONFIRMED: "FISCAL_YEAR_PROVISIONAL_CONFIRMED",
  FISCAL_PERIOD_STATUS_CHANGED: "FISCAL_PERIOD_STATUS_CHANGED",
  ROLE_CHANGED: "ROLE_CHANGED",
  PERMISSIONS_CHANGED: "PERMISSIONS_CHANGED",
  LOGIN_SUCCEEDED: "LOGIN_SUCCEEDED",
  LOGIN_FAILED: "LOGIN_FAILED",
  // Phase 4A — النسخ الاحتياطي (أكواد إنشاء/تحقق/رفع/تنزيل/Drill)
  // أكواد RESTORE_* تُضاف في 4B عند وجود الوظيفة فعليًا
  BACKUP_CREATED: "BACKUP_CREATED",
  BACKUP_FAILED: "BACKUP_FAILED",
  BACKUP_VALIDATED: "BACKUP_VALIDATED",
  BACKUP_UPLOADED: "BACKUP_UPLOADED",
  BACKUP_DOWNLOADED: "BACKUP_DOWNLOADED",
  BACKUP_DRILLED: "BACKUP_DRILLED",
  // Phase 4B.1 — الاستعادة الفعلية (أكواد تُكتب داخل قاعدة التشغيل في مراحلها
  // الآمنة فقط — سياسة محاسبة موثقة: الدليل الحاكم لأحداث الاستعادة هو سجل
  // عمليات الاسترجاع الخارجي لأن AuditLog نفسه يرجع تاريخيًا مع القاعدة المستبدلة)
  DATABASE_RESTORE_INITIATED: "DATABASE_RESTORE_INITIATED",
  DATABASE_RESTORE_ABORTED: "DATABASE_RESTORE_ABORTED",
  DATABASE_RESTORE_COMPLETED: "DATABASE_RESTORE_COMPLETED",
  DATABASE_RESTORE_ROLLED_BACK: "DATABASE_RESTORE_ROLLED_BACK",
  // Phase 6.2B (RECOVERY) — ميزان المراجعة (أكواد مستخدمة فعليًا — تسجيلها يثبّت التسميات)
  TRIAL_BALANCE_SAVED: "TRIAL_BALANCE_SAVED",
  TRIAL_BALANCE_COMMITTED: "TRIAL_BALANCE_COMMITTED",
  TRIAL_BALANCE_REVALIDATED: "TRIAL_BALANCE_REVALIDATED",
  TRIAL_BALANCE_DELETED: "TRIAL_BALANCE_DELETED",
  // Phase 6.3 — حوكمة مراجعات ميزان المراجعة
  TRIAL_BALANCE_REVISION_CREATED: "TRIAL_BALANCE_REVISION_CREATED",
  TRIAL_BALANCE_REVISION_COMMITTED: "TRIAL_BALANCE_REVISION_COMMITTED",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  REPORT_CREATED: "إنشاء تقرير",
  REPORT_UPDATED: "تعديل تقرير",
  REPORT_UPDATE_CONFLICT: "تعارض حفظ تقرير (نسخة أقدم)",
  REPORT_DELETED: "حذف تقرير",
  REPORT_SUBMITTED: "إرسال تقرير للمراجعة",
  REVIEW_STARTED: "بدء مراجعة تقرير",
  REVIEW_COMPLETED: "إتمام مراجعة تقرير (توقيع المراجع)",
  REPORT_RETURNED: "إرجاع تقرير للتصحيح",
  REPORT_RESUBMITTED: "إعادة إرسال تقرير بعد التصحيح",
  REPORT_APPROVED: "اعتماد تقرير",
  REPORT_REOPENED: "إعادة فتح تقرير معتمد",
  ASSIGNMENT_CHANGED: "تغيير إسناد أدوار التقرير",
  DUE_DATE_CHANGED: "تغيير تاريخ استحقاق تقرير",
  GROUP_CREATED: "إنشاء مجموعة",
  GROUP_UPDATED: "تعديل مجموعة",
  GROUP_DELETED: "حذف مجموعة",
  USER_CREATED: "إنشاء مستخدم",
  USER_UPDATED: "تعديل مستخدم",
  USER_DISABLED: "تعطيل مستخدم",
  USER_ENABLED: "تفعيل مستخدم",
  USER_DELETED: "حذف مستخدم",
  ROLE_CHANGED: "تغيير دور",
  PERMISSIONS_CHANGED: "تغيير الصلاحيات",
  LOGIN_SUCCEEDED: "تسجيل دخول ناجح",
  LOGIN_FAILED: "محاولة دخول فاشلة",
  // Phase 4A
  BACKUP_CREATED: "إنشاء نسخة احتياطية",
  BACKUP_FAILED: "فشل عملية نسخ/تحقق",
  BACKUP_VALIDATED: "التحقق من نسخة احتياطية",
  BACKUP_UPLOADED: "رفع نسخة احتياطية للتحقق",
  BACKUP_DOWNLOADED: "تنزيل نسخة احتياطية",
  BACKUP_DRILLED: "تشغيل Restore Drill (قاعدة مؤقتة معزولة)",
  DATABASE_RESTORE_INITIATED: "بدء عملية استعادة قاعدة البيانات (قبل أي تبديل)",
  DATABASE_RESTORE_ABORTED: "إلغاء منظم لعملية الاستعادة قبل التبديل — القاعدة لم تُلمس",
  DATABASE_RESTORE_COMPLETED: "اكتمال استعادة قاعدة البيانات (استبدال ذري + تحقق بعدي)",
  DATABASE_RESTORE_ROLLED_BACK: "اكتمال التراجع التلقائي إلى نسخة الأمان قبل الاستعادة",
  // Phase 6.2B/6.3
  TRIAL_BALANCE_SAVED: "حفظ ميزان مراجعة",
  TRIAL_BALANCE_COMMITTED: "اعتماد ميزان مراجعة",
  TRIAL_BALANCE_REVALIDATED: "إعادة تحقق خريطة ميزان مراجعة",
  TRIAL_BALANCE_DELETED: "حذف مسودة ميزان مراجعة",
  TRIAL_BALANCE_REVISION_CREATED: "إنشاء مسودة مراجعة لميزان مراجعة معتمد",
  TRIAL_BALANCE_REVISION_COMMITTED: "اعتماد مراجعة ميزان مراجعة (نسخة جديدة تصبح المعتمدة)",
};

export const AUDIT_ENTITY_TYPES = {
  Report: "Report",
  Group: "Group",
  User: "User",
  Auth: "Auth",
  Backup: "Backup", // Phase 4A — الكيان = backupId
  // Phase 6.1 (RECOVERY) — كيانات الأساس المالي
  Company: "Company",
  ClosingPolicy: "ClosingPolicy",
  FiscalYear: "FiscalYear",
  FiscalPeriod: "FiscalPeriod",
  Backfill: "Backfill",
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  Report: "تقرير",
  Group: "مجموعة",
  User: "مستخدم",
  Auth: "مصادقة",
  Company: "شركة",
  ClosingPolicy: "سياسة إقفال",
  FiscalYear: "سنة مالية",
  FiscalPeriod: "فترة محاسبية",
  Backfill: "ربط خلفي",
};

// ترتيب أولوية اختيار كود العملية عند تعدد التغييرات في طلب واحد (الأخطر أولًا)
export const AUDIT_ACTION_PRIORITY: string[] = [
  AUDIT_ACTIONS.PERMISSIONS_CHANGED,
  AUDIT_ACTIONS.ROLE_CHANGED,
  AUDIT_ACTIONS.USER_DISABLED,
  AUDIT_ACTIONS.USER_ENABLED,
  AUDIT_ACTIONS.USER_UPDATED,
];
