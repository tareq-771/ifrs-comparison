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
  REPORT_RETURNED: "REPORT_RETURNED",
  REPORT_RESUBMITTED: "REPORT_RESUBMITTED",
  REPORT_APPROVED: "REPORT_APPROVED",
  REPORT_REOPENED: "REPORT_REOPENED",
  ASSIGNMENT_CHANGED: "ASSIGNMENT_CHANGED",
  GROUP_CREATED: "GROUP_CREATED",
  GROUP_UPDATED: "GROUP_UPDATED",
  GROUP_DELETED: "GROUP_DELETED",
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_DISABLED: "USER_DISABLED",
  USER_ENABLED: "USER_ENABLED",
  USER_DELETED: "USER_DELETED",
  ROLE_CHANGED: "ROLE_CHANGED",
  PERMISSIONS_CHANGED: "PERMISSIONS_CHANGED",
  LOGIN_SUCCEEDED: "LOGIN_SUCCEEDED",
  LOGIN_FAILED: "LOGIN_FAILED",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  REPORT_CREATED: "إنشاء تقرير",
  REPORT_UPDATED: "تعديل تقرير",
  REPORT_UPDATE_CONFLICT: "تعارض حفظ تقرير (نسخة أقدم)",
  REPORT_DELETED: "حذف تقرير",
  REPORT_SUBMITTED: "إرسال تقرير للمراجعة",
  REVIEW_STARTED: "بدء مراجعة تقرير",
  REPORT_RETURNED: "إرجاع تقرير للتصحيح",
  REPORT_RESUBMITTED: "إعادة إرسال تقرير بعد التصحيح",
  REPORT_APPROVED: "اعتماد تقرير",
  REPORT_REOPENED: "إعادة فتح تقرير معتمد",
  ASSIGNMENT_CHANGED: "تغيير إسناد أدوار التقرير",
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
};

export const AUDIT_ENTITY_TYPES = {
  Report: "Report",
  Group: "Group",
  User: "User",
  Auth: "Auth",
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  Report: "تقرير",
  Group: "مجموعة",
  User: "مستخدم",
  Auth: "مصادقة",
};

// ترتيب أولوية اختيار كود العملية عند تعدد التغييرات في طلب واحد (الأخطر أولًا)
export const AUDIT_ACTION_PRIORITY: string[] = [
  AUDIT_ACTIONS.PERMISSIONS_CHANGED,
  AUDIT_ACTIONS.ROLE_CHANGED,
  AUDIT_ACTIONS.USER_DISABLED,
  AUDIT_ACTIONS.USER_ENABLED,
  AUDIT_ACTIONS.USER_UPDATED,
];
