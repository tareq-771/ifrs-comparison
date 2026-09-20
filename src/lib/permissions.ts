// Permission helpers for the application.
// Permissions are stored on the User model as a JSON string and parsed at runtime.

export interface Permissions {
  view: boolean;
  add: boolean;
  edit: boolean;
  delete: boolean;
  groups: boolean;
  export: boolean;
  settings: boolean;
  manageUsers: boolean;
  /**
   * Workflow (المرحلة 3): تعيين/تغيير المعد والمراجع والمعتمد للتقارير.
   * كون المستخدم مراجعًا أو معتمدًا لتقرير بعينه يأتي من الإسناد لا من هذه الصلاحية.
   * المدير (role=admin) يمتلكها ضمنيًا دون هذا المفتاح.
   */
  assignWorkflow?: boolean;
  /**
   * Workflow (المرحلة 3): إعادة فتح تقرير معتمد (REOPEN) — تتطلب سببًا إلزاميًا.
   * المدير (role=admin) يمتلكها ضمنيًا دون هذا المفتاح.
   */
  reopenReport?: boolean;
  /**
   * Phase 4A: إدارة النسخ الاحتياطي — عرض القائمة/الإنشاء/التنزيل/الرفع للتحقق/
   * Restore Drill/قراءة سجل الاسترجاع التشغيلي.
   * صريحًا (قرار D-5): امتلاك settings لا يمنح هذا المفتاح ولا أي شيء منه.
   * المدير (role=admin) يمتلكها ضمنيًا بالدور (نمط assignWorkflow).
   */
  manageBackups?: boolean;
  /**
   * Phase 4B.3 — Explicit High-Risk Permission: تنفيذ الاستعادة الفعلية
   * (استبدال قاعدة التشغيل بالكامل). صلاحية مستقلة عالية الخطورة تُمنح بمفتاح
   * صريح حصرًا (canRestoreDatabase) — لا تُمنح ضمنيًا بدور admin ولا بـsettings
   * ولا بـmanageBackups. يُمكن أن يوجد مدير كامل الصلاحيات الإدارية بلا هذا
   * المفتاح فلا يستطيع استبدال قاعدة البيانات (قرار المستخدم 4B.3).
   */
  restoreDatabase?: boolean;
  /**
   * Optional list of group IDs the user is allowed to see in the main page.
   *
   * Semantics:
   *   - `undefined` / `null` → no linkage; user falls back to "all groups they own"
   *     (existing behaviour — admin/creator sees their own groups).
   *   - `[]` (empty array) → still treated as "no linkage" so existing users
   *     aren't accidentally hidden from their own groups.
   *   - non-empty array → user is linked ONLY to those groups (regardless of
   *     ownership). Used to share a subset of groups with a non-admin user.
   *
   * See `src/app/api/groups/route.ts` GET handler for the server-side filter.
   */
  groupIds?: string[];
}

export const DEFAULT_USER_PERMISSIONS: Permissions = {
  view: true,
  add: true,
  edit: true,
  delete: false,
  groups: false,
  export: true,
  settings: false,
  manageUsers: false,
  assignWorkflow: false,
  reopenReport: false,
  manageBackups: false,
  restoreDatabase: false,
  groupIds: [],
};

export const ADMIN_PERMISSIONS: Permissions = {
  view: true,
  add: true,
  edit: true,
  delete: true,
  groups: true,
  export: true,
  settings: true,
  manageUsers: true,
  assignWorkflow: true,
  reopenReport: true,
  manageBackups: true,
  // 4B.3 — Explicit High-Risk Permission: قالب المدير لا يحمل الاستعادة إطلاقًا.
  // منحها يجري بمفتاح صريح عند الإنشاء/التعديل (body.permissions.restoreDatabase
  // === true) — تحويل مستخدم إلى admin لا يمنحها تلقائيًا (قرار المستخدم 4B.3).
  restoreDatabase: false,
  // Admins see all groups they own (no linkage restriction)
  groupIds: [],
};

export function parsePermissions(json: string | null | undefined): Permissions {
  try {
    if (!json) return { ...DEFAULT_USER_PERMISSIONS };
    const parsed = JSON.parse(json);
    const merged: Permissions = { ...DEFAULT_USER_PERMISSIONS, ...parsed };
    // Coerce groupIds into a clean string array (or undefined)
    if (Array.isArray(parsed?.groupIds)) {
      merged.groupIds = parsed.groupIds
        .filter((g: unknown): g is string => typeof g === "string" && g.length > 0)
        .map((g) => g);
    } else if (parsed?.groupIds === undefined || parsed?.groupIds === null) {
      delete merged.groupIds;
    } else {
      merged.groupIds = [];
    }
    return merged;
  } catch {
    return { ...DEFAULT_USER_PERMISSIONS };
  }
}

export function stringifyPermissions(permissions: Partial<Permissions>): string {
  // Build a clean object that omits `groupIds` when not provided, so legacy
  // JSON without the field remains compatible.
  const base: Permissions = { ...DEFAULT_USER_PERMISSIONS, ...permissions };
  if (permissions.groupIds === undefined) {
    delete base.groupIds;
  } else {
    base.groupIds = Array.isArray(permissions.groupIds)
      ? permissions.groupIds.filter((g) => typeof g === "string")
      : [];
  }
  return JSON.stringify(base);
}

export function hasPermission(
  permissions: Permissions,
  key: keyof Permissions
): boolean {
  // `groupIds` is an array, not a boolean — treat as "always allowed" here
  // so it doesn't accidentally throw a permission error elsewhere.
  if (key === "groupIds") return true;
  return permissions[key] === true;
}

/**
 * سماوية الإسناد (Workflow) — المدير يمتلكها ضمنيًا بالدور.
 */
export function canAssignWorkflow(perms: Permissions, role: string): boolean {
  return role === "admin" || perms.assignWorkflow === true;
}

/**
 * سماوية إعادة الفتح (REOPEN) — المدير يمتلكها ضمنيًا بالدور.
 */
export function canReopenReport(perms: Permissions, role: string): boolean {
  return role === "admin" || perms.reopenReport === true;
}

/**
 * Phase 4A — إدارة النسخ الاحتياطي: المدير ضمنيًا بالدور، وغيره بمفتاح صريح فقط.
 * settings وحدها لا تمنح شيئًا (D-5 حرفيًا).
 */
export function canManageBackups(perms: Permissions, role: string): boolean {
  return role === "admin" || perms.manageBackups === true;
}

/**
 * Phase 4B.3 — بوابة تنفيذ الاستعادة الفعلية (استبدال قاعدة التشغيل).
 *
 * Explicit High-Risk Permission (قرار المستخدم 4B.3، متسق مع D-5):
 *   تعتمد على permissions.restoreDatabase === true حصرًا.
 *   لا منح ضمني بدور admin — يمكن وجود مدير كامل الصلاحيات الإدارية
 *   (manageUsers/settings/…) بلا القدرة على استبدال قاعدة البيانات.
 *   عمدًا لا نستقبل role هنا حتى لا يُساء استخدامها كمنح ضمني مستقبلًا.
 */
export function canRestoreDatabase(perms: Permissions): boolean {
  return perms.restoreDatabase === true;
}
