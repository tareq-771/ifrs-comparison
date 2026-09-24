# MASTER DEVELOPMENT ROADMAP
## نظام التقارير المالية الموحدة — Unified Financial Reporting System

| Field | Value |
|---|---|
| Document version | **2.0 — V1 FAST-TRACK PRIORITY REVISION** |
| Date | 2026-09-24 |
| Baseline commit | `32c0861dcc6eb51cf6dbb1e4b5d74c6ccaad2f0b` (Phase 6.9 + 6.9R) |
| Document type | PLANNING / DOCUMENTATION ONLY — no implementation in this task |
| Owner priority | **Deliver a usable professional V1 in the shortest practical time** (owner decision 2026-09-24) |
| Status legend | **IMPLEMENTED** = working and committed · **PARTIALLY_IMPLEMENTED** = foundation working, remainder planned · **PLANNED** = approved direction, not started · **DEFERRED** = approved concept, blocked on a jurisdiction/professional-framework decision |
| Approval rule | Every phase below requires its own human approval, design document, isolated-DB gate and regression pass before implementation. This roadmap does **not** authorize any code change. |

**V2.0 revision summary:** per owner decision, eight capability groups were promoted to **V1 URGENT / MUST-HAVE** (aging, charts, smart alerts, appearance/themes, user/report/dashboard customization, responsive/mobile, PDF/Excel/report delivery, V1 stabilization & release readiness) and are now Phases **6.10–6.13**. Professional Practice Mode, audit sampling, advanced audit-office workflows, advanced consolidation ownership/NCI/elimination work and related professional-practice features moved to **POST-V1**. The full Permission Registry migration is **NOT a blanket blocker** for V1: every V1 feature ships with its own explicit permissions, fail-closed company scope and audit hooks (registry-ready), while the centralized RBAC evolution proceeds incrementally or in a later dedicated phase. **All previously approved ideas remain in this roadmap — nothing was deleted; items were re-sequenced.**

---

# A) EXECUTIVE PRODUCT VISION

## A.0 V1 primary goal (added in V2.0)

**Deliver a usable professional V1 in the shortest practical time.** V1 = the current committed financial-reporting core (statements, TB governance, budget, preliminary consolidation, presentation/comparison) **plus** the eight urgent capability groups delivered through Phases 6.10–6.13, stabilized, verified and released (Windows/LAN acceptance, clean source release). V1 must be a product an accountant can actually use daily — not a feature-complete end-state. Everything that does not block that goal is POST-V1 and must not slow V1 down.

## A.1 What the product is

نظام التقارير المالية الموحدة is a flexible, professional, Arabic-first financial reporting platform. It ingests authoritative trial balances per company and per fiscal period, applies governed classification and statement mappings, and produces governed financial statements, budgets, comparisons and consolidation working papers with professional print/export output and a strict control regime (append-only audit trail, workflow segregation of duties, optimistic locking, fail-closed company scoping, honest incomplete-data states, no forced balancing).

The system is designed for professional use by:

- Accountants
- Financial managers
- Legal / public accountants
- Audit and review practices
- Multi-client professional practices
- Multi-company groups

## A.2 Long-term conceptual hierarchy (DO NOT IMPLEMENT NOW — POST-V1)

The long-term object hierarchy the product should be able to express:

```
Professional Practice / Office (مكتب المهنة)
  → Client (العميل)
    → Company / Companies (الشركة / الشركات)
      → Activities (الأنشطة)
        → Fiscal Years (السنة المالية)
          → Fiscal Periods (الفترات)
            → Trial Balances and supporting datasets (ميازين المراجعة والبيانات المساندة)
              → Financial Statements (القوائم المالية)
                → Analysis (التحليل)
                  → Review / Audit Work (أعمال المراجعة / التدقيق)
                    → Reports (التقارير)
```

**This hierarchy is NOT implemented in V1 and must not be implemented without a separate approved post-V1 phase (7.1).** Architectural implications and dependencies (documented only):

1. **Company remains the pivot entity.** Every existing dataset (trial balances, budgets, mappings, consolidation memberships, adjustments) is already company-scoped. A Practice/Client layer must be added **above** Company without changing existing company-scoped keys, so all current services keep working unchanged.
2. **Scoping must evolve from company-scoped to practice→client→company-scoped.** Today's fail-closed gate is `companyVisible(user, companyId)` (viewAllCompanies / companyIds). A client layer multiplies the scope dimensions; permission scope evolution must define client scope before practice mode can be built.
3. **Data isolation is a hard requirement.** A practice sees only its clients; a client's data is never visible to another client or practice. Isolation tests must exist at every API boundary, mirroring the current fail-closed consolidation visibility rule.
4. **Engagement/review artifacts hang off (practice, client, company, fiscal year)** — engagement files, review notes, proposed adjustments, internal-control findings, report drafts — all append-only/audited like today's WorkflowHistory and AuditLog.
5. **Identity/display separation is preserved.** The system's established pattern (machine identity codes vs. Arabic/English display names, `code` vs `nameAr`/`nameEn`) extends naturally to clients and practices.
6. **Migration risk is concentrated in scoping, not schema.** Adding Client/Practice tables is additive (LOW risk); threading client scoping through every existing company-scoped query is the MEDIUM-HIGH work item and must be gated.

## A.3 Governing principles carried forward

- Committed Trial Balance is the **only** authoritative numeric source; reports are derived, never re-entered.
- Additive-only schema evolution; migrations are reviewed; canonical schema fingerprint is pinned.
- No plug figures, no silent zeros, no silent classification, no hidden reconciliation differences.
- `CUMULATIVE_YTD` vs `PERIOD_MOVEMENT` semantics are explicit everywhere; non-calendar fiscal years are first-class (period ordinals, never assumed calendar months).
- BigInt-safe minor-unit money; percentages compared without floating point.
- Arabic-first RTL UI; report language independent from system language; internal codes are never the primary user-facing wording.
- Fail-closed authorization; append-only audit for every sensitive action; segregation of duties.
- **No weakening of accounting/data-integrity controls for speed** (V1 time-compression principle — see D.2).

---

# B) CURRENT IMPLEMENTED BASELINE (through commit `32c0861`)

## B.1 Technology foundation

- Next.js 16 App Router + TypeScript 5, Bun runtime, Prisma 6.19.2 / SQLite (WAL), NextAuth v4 sessions, Tailwind 4 + shadcn/ui, Arabic RTL UI, dark-mode theme support.
- Single monolith deployable; production-hardened path exists for Linux (systemd/Caddy templates) and Windows compatibility (5B series).

## B.2 Phase history (delivered and committed)

| Track | Phases | Delivered |
|---|---|---|
| Pre-history | Legacy tool | IFRS statement-matching single-file app; charts report; HTML export — later preserved as a tool tab, never the primary path |
| Foundation | 0 – 3.5 | Multi-user proxy, append-only audit trail, optimistic locking (version), report workflow DRAFT→SUBMITTED→REVIEW→APPROVED with segregation of duties, review tracking dashboard (PENDING_APPROVAL, due dates) |
| Operations | 4A, 4A.1, 4B.1–4B.3 | Backup (VACUUM INTO, Manifest v3, canonical schema fingerprint), real restore engine with atomic swap, maintenance state machine, session epoch (JWT invalidation), RECOVERY_REQUIRED restricted mode, restore as an explicit high-risk permission (never granted implicitly by role) |
| Deployment | 5A, 5B.1–5B.3 | Fail-closed production config, health endpoint, startup recovery/preflight, loopback bind enforcement, XFF hardening, migration gate, Windows production compatibility + templates + host-prep readiness |
| Financial core | 6.1 | Companies (bilingual names, currencies), Fiscal Years (non-calendar, 1..24 periods, transitions OPEN/CLOSED/LOCKED with snapshots), Fiscal Periods (ordinal identity, zero-activity declaration), closing policy |
| Classification | 6.2A–6.2D | Account nature/classification rules + per-account overrides (reason-governed), Excel trial balance import (committed TB as authoritative source), financial statements P&L+OCI / SFP with visible equation difference, regression gates 62A–62D |
| Governance | 6.3 | Trial balance revision governance: revision chain (supersedes), mandatory reason, draft line replacement, revision-aware commit, provenance attached to every report |
| Statements II | 6.4 | SOCIE (equity component mappings, opening/movement/closing) + IAS 7 indirect cash flow (seeded system lines, per-company prefix mapping, account overrides, NON_CASH disclosure, visible reconciliation difference) |
| Budget | 6.5 | Budget versions DRAFT→SUBMITTED→APPROVED→LOCKED (no unlock), revisions with reason, minor-safe line editor, equal distribution, 5 proposal methods, actual-vs-budget variance across MONTH/QUARTER/SEMI_ANNUAL/ANNUAL/YTD with favorability separated from numeric variance |
| Consolidation I | 6.6 | Consolidation groups, memberships (effective dates + basic ownership%), group reporting lines + per-company mappings (different account codes converge), balanced manual adjustments/eliminations (AR/AP, Sales/Purchases, Loans, Dividends), preliminary consolidated report (per-company working paper → eliminations → consolidated, equation difference visible, PRELIMINARY labeling, INCOMPLETE_DATA per member) |
| Unified UI | 6.7A–6.7E | Dashboard-first home with RTL tab navigation, company/FY per-user context, TB + classification governance UI, StatementsView (4 statements with drill-down and honest states), BudgetView, ConsolidationView, admin tabs, deep links |
| Print/Export | 6.8A–6.8C | Unified report header (zero hard-coding), A4 portrait/landscape print portal (RTL-safe, thead repeat, no row splitting), Reports Center (7 report types + deep links), CSV export registry (RFC4180 + Arabic BOM, minor values as literal strings), Windows local-test package |
| Presentation | 6.9 | 5 presentation modes (ALL_ACCOUNTS, MAIN, LEAF, ACCOUNT_LEVEL, STATEMENT_MAPPING) × 6 comparison modes (NONE, PRIOR_PERIOD, PRIOR_YEAR_PERIOD, BUDGET, YTD, YTD_AVERAGE) via `comparison-engine.ts` (pure) + `comparison-server.ts` + statement-comparison API + RTL panel; deterministic account hierarchy derived from actual codes; review markers with central thresholds; deterministic interpretations + advisory hints; provenance + transparency notes |
| Corrections | 6.9R | Root-cause fix of SFP silent drop of main-item accounts with children (transparent LINE rows + renderedAccountCodes guarantee — no value can disappear, no plug); period semantics regression-locked; terminology governance (no «مواتٍ/غير مواتٍ» — contextual budget terms: «أعلى/أقل من الموازنة», «تجاوز/وفر عن الموازنة», «ضمن الموازنة»; neutral period terms: ارتفاع/انخفاض/دون تغير جوهري); `display-labels.ts` bilingual foundation (ReportLanguage ar/en/ar_en independent of UI language); technical codes hidden from primary wording; SOCIE credit-nature positive presentation; formatted currency in all notes (no raw minor values, no "plug" wording) |

## B.3 Regression & quality baseline

- Gate scripts on isolated DBs built **from migrations only**: 62A=30, 62B=16, 62C=9, 62D=6, 63=13, 64=9, 65=8, 66=8, 67=19, 68=14, 69=23, 69R=20 — **175 green checks** total.
- lint = 0; typecheck = 92 (measured baseline, zero errors in 6.x files).
- Browser-verified E2E (Arabic RTL, print PDF, mobile 390px, bilingual report toggle) on isolated DBs.
- Production `db/custom.db` never migrated/touched by development work.

## B.4 Invariant controls that every future phase MUST preserve

1. Committed TB = sole authority; latest approved revision only; revisions immutable once committed.
2. Fail-closed company scoping on every report/API path; unauthorized = error, never empty-as-zero.
3. Append-only audit trail for sensitive actions; workflow snapshots (who/when) on state changes.
4. Optimistic locking on mutable governance objects; LOCKED is terminal (budget) or reason-gated (FY).
5. No plug balancing; equation/reconciliation differences displayed; INCOMPLETE_DATA explicit; UNCLASSIFIED visible as text (never silent zero).
6. `CUMULATIVE_YTD` movement = current cumulative − prior cumulative (never summing snapshots); missing prior cumulative ⇒ explicit incomplete, not treated as movement; period 1 cumulative(0)=0 documented; BALANCE as-of.
7. FLOW vs BALANCE semantic separation; SFP rows carry no favorability; P&L revenue negative-net normalized before comparison.
8. BigInt minor units end-to-end; >2^53 exact in display and CSV.
9. Migrations ADD-ONLY; canonical schema fingerprint pinned and verified on isolated DB before any release.
10. Permission model: explicit keys; high-risk actions get separate explicit permissions (restore-database precedent); no implicit grants by role.
11. Central single-source rules: sign presentation, favorability, display labels — never duplicated per feature.
12. Report language (ar/en/ar_en) independent of system UI language.

---

# C) CAPABILITY MATRIX

Statuses use the legend above. "Proposed phase" references §J numbering (advisory). **V1** = Phase 6.10–6.13 (owner urgent list); **POST-V1** = Track 7.x.

| # | Capability | Status | V1? | Existing foundation | Remaining work | Dependencies | Proposed phase | Risk / notes |
|---|---|---|---|---|---|---|---|---|
| C-1 | Auth, sessions, per-user permissions (flat JSON keys + companyIds scope) | PARTIALLY_IMPLEMENTED | **V1 (incremental)** | NextAuth, permission keys, explicit high-risk restore, company scope | Per-feature keys for 6.10–6.12 (additive); full central registry later | — | V1 keys in 6.10–6.12 · full registry 7.9 | Registry is NOT a V1 blanket blocker; keys defined registry-ready |
| C-2 | Permission copy / role templates | PLANNED | POST-V1 | User-permission editor, audit trail | Copy-from-user, templates, preview/diff, apply modes, escalation guard | C-1 registry | 7.9 | High-risk: privilege escalation guard mandatory |
| C-3 | Append-only audit trail | IMPLEMENTED | **V1 (extend)** | AuditLog append-only, action codes, IP/user metadata | New codes per V1 module (standing rule) | — | 6.10–6.12 + standing | Standing control |
| C-4 | Workflow & SoD (reports, budgets, TB revisions) | IMPLEMENTED | **V1 (preserve)** | Report workflow, budget states, TB revision commit | Aging snapshot SoD (upload≠approve); practice workflow later | — | 6.10 (aging SoD) · 7.1 (practice) | Keep preparer≠approver |
| C-5 | Backup / restore / recovery | IMPLEMENTED | **V1 (acceptance)** | VACUUM backups, Manifest v3, atomic-swap restore, maintenance states, epoch | Release-candidate restore-drill acceptance | — | 6.13 | Standing control |
| C-6 | Production deployment (Linux + Windows templates) | PARTIALLY_IMPLEMENTED | **V1 (verification)** | 5A/5B hardened templates + gates | Windows production deployment verification, LAN acceptance, release candidate, connection UX later | — | verification 6.13 · connection UX 7.12 | No networking changes in roadmap task |
| C-7 | Companies / fiscal years / periods (non-calendar) | IMPLEMENTED | — | 6.1 models + services + UI | Activity directory linkage (post-V1) | C-14 | 7.7 | LOW |
| C-8 | Account classification rules & overrides | IMPLEMENTED | — | Nature rules, overrides with mandatory reasons, unclassified visible | Suggested mappings from sector profiles (post-V1, advisory) | C-14 | 7.8 | Suggestion ≠ automation |
| C-9 | Trial balance import + revision governance | IMPLEMENTED | **V1 (reconciliation target)** | Excel import, revision chain, provenance | Aging reconciles to committed TB (6.10) | C-16 | 6.10 | Aging never feeds TB |
| C-10 | Financial statements (P&L+OCI, SFP, SOCIE, IAS7 CF) | IMPLEMENTED | **V1 (charts/alerts integration)** | 4 statements + honest states + visible differences | Charts + insights integration; presentation/customization | C-13, C-18, C-21 | 6.11–6.12 | LOW |
| C-11 | Budget + actual-vs-budget | IMPLEMENTED | **V1 (preserve + charts)** | Full workflow + variance (5 granularities) | Budget charts/alerts via shared engines | C-18, C-21 | 6.11 | Scenario planning remains future, not yet approved in detail |
| C-12 | Consolidation (groups, adjustments, preliminary report) | PARTIALLY_IMPLEMENTED | POST-V1 (defect-fix exception only) | Groups/memberships (basic ownership%), balanced eliminations (4 types), preliminary working paper | Ownership engine, NCI, worksheet expansion, report basis, scenarios | C-1, C-28 | 7.3–7.6 | **Must not block V1** unless required to correct an existing material defect |
| C-13 | Reporting presentation & comparison (5×6 modes) | IMPLEMENTED | **V1 (presentation/customization)** | comparison-engine/server + panel + CSV/print | Executive summary, saved report views, multi-period, collapse/expand polish | — | 6.12 | LOW |
| C-14 | Company activity directory | PLANNED | POST-V1 | Company model has **no** activity field today | Extensible activity catalog, primary/secondary/user-defined, sector-profile hooks | — | 7.7 | LOW; never a rigid enum |
| C-15 | Professional practice / multi-client mode | PLANNED | POST-V1 | Company pivot, fail-closed scoping precedent | Client/practice entities, engagement files, review artifacts, isolation | C-1 (client scope) | 7.1 | MEDIUM-HIGH; largest structural change; **must not block V1** |
| C-16 | Print / export | PARTIALLY_IMPLEMENTED | **V1** | A4 print portal + CSV registry + unified header | Native PDF, Excel, Word (where appropriate), bilingual delivery, page numbering | C-13, C-22 | 6.12 | LOW; registry is the extension point |
| C-17 | Approved report snapshots (immutable/revisioned) | PLANNED | **V1 (metadata part) + POST-V1 (engine)** | Provenance + committed-TB immutability precedent | V1: complete report metadata/status on every delivered artifact + preserved requirement; full snapshot engine later | C-16 | metadata 6.12 · engine 7.11 | Split mandated by owner: identify mandatory-before-V1 vs safe-post-V1 |
| C-18 | Charts / visualization | PARTIALLY_IMPLEMENTED | **V1** | Legacy chart report (tool tab) + chart-data.ts data layer | Central visualization layer + per-report charts + aging charts + drill-down | C-13, C-23 | 6.10 (foundation) · 6.11 (integration) | LOW |
| C-19 | Aging / receivables analytics | PLANNED | **V1** | Committed TB customer accounts (reconciliation target), flexible-import precedent (TB) | Full module: flexible Excel mapping, snapshots, buckets, analytics, risk-priority report | C-1 keys, C-9 | **6.10** | Advisory only; no auto-ECL; reconciliation difference disclosed |
| C-20 | Review / audit analytics | PARTIALLY_IMPLEMENTED | POST-V1 (full module) | Review markers (25% + amount thresholds) in comparison engine; insights foundation in V1 | Attention lists, sampling parameters with disclosed assumptions, full module | C-18/C-21 | 7.2 | Audit sampling explicitly POST-V1; draft-only report label; professional override |
| C-21 | Smart alerts / insights | PARTIALLY_IMPLEMENTED | **V1** | Deterministic interpretations + advisory hints per row | Central insights foundation, severity, explainable aging alerts, notification surface, integration into key reports | C-13, C-18 | 6.10 (foundation) · 6.11 (integration) | FACT/ANALYSIS/RECOMMENDATION separation |
| C-22 | Localization (system + report language) | PARTIALLY_IMPLEMENTED | **V1 (delivery) + POST-V1 (English UI)** | Report language ar/en/ar_en via display-labels.ts; Arabic RTL UI | V1: bilingual report delivery + terminology completion for delivered surfaces; POST-V1: English system UI | — | 6.12 · 7.10 | Dictionary single-source |
| C-23 | Appearance center (fonts/themes/density) | PARTIALLY_IMPLEMENTED | **V1** | Dark/light theme, IBM Plex Sans Arabic | Arabic/English font pickers, sizes, zoom, density, five professional themes, print-independence | — | **6.11** | LOW |
| C-24 | Dashboard & productivity | PARTIALLY_IMPLEMENTED | **V1 (customization)** | Dashboard-first home, context cards, shortcuts, reports center, deep links | Widgets, dashboard customization, saved user preferences; global search/favorites later | C-13 | 6.11 (customization) · 7.x (search/favorites) | LOW |
| C-25 | Mobile / responsive experience | PARTIALLY_IMPLEMENTED | **V1** | RTL responsive verified at 390px, horizontal scroll strategy | Dedicated mobile UX (nav, tables→cards, controls), acceptance testing | — | **6.11 + 6.13 acceptance** | LOW-MEDIUM |
| C-26 | Server connection configuration UX | PLANNED | POST-V1 | Deploy-time config only (5B) | Client-side connection settings UI, Test Connection (identity/version), priority chain | — | 7.12 | Never expose DB path/credentials |
| C-27 | Repository hygiene (runtime artifacts out of Git) | PLANNED (tech debt) | **V1 (release-critical subset)** | Tracked runtime paths identified; explicit allowlist commit discipline proven | Untrack runtime DB/PID, .gitignore, upload-route decision, clean release tree | — | **6.13** (TD-1 executed here) | Do NOT perform in this roadmap task |
| C-28 | Consolidation report basis & scenarios | PLANNED | POST-V1 | PRELIMINARY labeling + disclosure precedent | Basis selector (standards/management/custom), saved scenarios, mandatory management label | C-12, C-1 | 7.6 | Never mislabel management combination as IFRS |

---

# C.1–C.22 DIRECTION DEEP DIVES (approved product direction, per section)

## C.1 — Product positioning (Direction §1)

**Status: PARTIALLY_IMPLEMENTED positioning, PLANNED hierarchy (POST-V1, Phase 7.1)** — hierarchy not to be built in V1 (see §A.2 for documented implications only).

- All positioning/design decisions must keep the system suitable for the six user profiles in §A.1.
- **V1 lens:** every V1 feature must work for a single company AND remain structurally compatible with a multi-company group; full multi-client practice ergonomics arrive with 7.1.

## C.2 — Company activity directory (Direction §2)

**Status: PLANNED — POST-V1, Phase 7.7** (Company model currently has no activity field — verified against schema).

Design requirements (unchanged):

1. **Extensible directory, not a rigid closed enum.** An `Activity` catalog (code identity + nameAr/nameEn display) with seed entries, plus user-defined activities.
2. Seed/initial coverage (non-exhaustive; user-defined entries always allowed):
   - Commercial (تجاري), Industrial (صناعي), Services (خدمي), Agricultural (زراعي)
   - Information Technology / Software (تقنية المعلومات / برمجيات)
   - Contracting (مقاولات), Real Estate (عقار)
   - Exchange & Remittance Company — شركة صرافة وتحويلات
   - Money Transfer Network — شبكة تحويل أموال
   - Exchange, Remittance & Money Transfer Network Company — شركة صرافة وتحويلات وشبكة تحويل أموال
   - Electronic Money Wallet / Electronic Payment Services (محفظة أموال إلكترونية / خدمات دفع إلكتروني)
   - Banks / Banking Institutions (بنوك / مؤسسات مصرفية)
   - Finance companies (شركات تمويل), Insurance (تأمين), Telecommunications (اتصالات)
   - Transportation / Logistics (نقل / لوجستيات), Tourism / Hotels (سياحة / فنادق)
   - Healthcare (صحة), Education (تعليم), Non-profit organizations (منظمات غير ربحية)
   - Other / custom activities (أنشطة أخرى / مخصصة)
3. **Primary activity + multiple secondary activities per company.**
4. **Future sector profiles** (per activity) may drive: KPIs, analytics, alerts, report templates, review procedures, suggested mappings — all advisory, all separately approved (Phase 7.8).
5. **Regulated-sector behavior must be configurable by jurisdiction/regulator/framework** — never globally assumed because an activity is "regulated".

Risk: LOW (additive; Company backfill optional and explicit).

## C.3 — Professional practice / multi-client mode (Direction §3)

**Status: PLANNED — POST-V1, Phase 7.1** (see §A.2 implications; largest structural future change; **must not block V1**).

Scope of the future mode:

- Multiple clients; multiple companies per client; strict client/company data isolation
- Engagement/review files; assigned staff; fiscal years (per company, as today)
- Supporting documents; review notes; proposed adjustments; internal-control findings
- Status/workflow on engagements; report drafts; audit trail (reusing existing append-only patterns)

**Hard rule: the system must never claim automated audit opinion generation.** The audit-report artifact remains a draft: «مسودة مقترحة لتقرير المدقق المستقل».

Dependencies: permission scope evolution with client scope. Risk: MEDIUM-HIGH (scoping threading through all company-scoped services).

## C.4 — Permissions & access control evolution (Direction §4)

**Status: PARTIALLY_IMPLEMENTED — V1 INCREMENTAL (keys per feature), full registry POST-V1 (Phase 7.9).**

**V2.0 policy (owner decision): the full centralized RBAC/Permission Registry migration is NOT a blanket blocker for V1 modules.** Instead:

1. **Every V1 feature defines its own permissions** at design time, using additive keys on the existing (flat JSON) permission model — the established, tested house pattern.
2. **Every V1 feature enforces existing company scope / fail-closed controls** unchanged.
3. **Every V1 feature adds audit requirements for sensitive actions** (upload, approve, export, configure).
4. **Keys are defined registry-ready** (documented with action dimension + scope + risk class per §F) so the later registry migration (7.9) adopts them without rework.
5. The full registry evolution proceeds **incrementally where safe** (e.g., new modules could read from a registry table behind the existing helper API) or in the dedicated later phase (7.9) — its own approval, own gate.

Full evolution plan (unchanged, for 7.9):

- Central Permission Registry: one authoritative catalog of permission definitions (key, description ar/en, risk class, module).
- Action-type dimensions (as applicable per resource): VIEW, CREATE, EDIT, DELETE, UPLOAD, SUBMIT, APPROVE, REJECT, LOCK, UNLOCK/REOPEN, PRINT, EXPORT, POST, REVERSE, CONFIGURE, ADMINISTER.
- Scope dimensions (as architecture evolves): all companies · selected companies (exists today as companyIds) · client · consolidation group · own assignments.
- High-risk actions always get separate explicit permissions (precedent: `canRestoreDatabase`).
- Segregation of duties: preparer ≠ approver wherever a governance workflow exists.
- Standing Definition-of-Done rule: every future feature/module is **incomplete** unless its permission model, scope rules, audit trail entries and sensitive actions are defined and tested. **This rule applies to V1 phases and is satisfied by the per-feature keys above.**

Risk: MEDIUM for the 7.9 migration itself (user-record JSON; backward compatibility); LOW for V1 additive keys.

## C.5 — Copy / import user permissions (Direction §5)

**Status: PLANNED — POST-V1, Phase 7.9** (part of registry work; not needed for V1 owner priorities).

1. Two sources: **A)** copy from an existing user; **B)** apply a saved Role/Permission Template.
2. Copy modes: all functional permissions + scope · functional permissions only · selective permission groups.
3. **Never copy**: password, authentication secrets, personal account information.
4. **Preview/differences screen before applying** (added vs removed permissions, scope changes).
5. **Audit**: source user, target user, administrator, date/time, permissions added/removed, scope changes — append-only.
6. **Prevent privilege escalation according to policy** (an administrator cannot grant a permission they do not hold — policy confirmed at design time); restore-database-class permissions follow the 4B.3 independent-grant pattern only.

## C.6 — Financial reporting presentation (Direction §6)

**Status: IMPLEMENTED (6.9 + 6.9R) — presentation/customization extensions V1 (Phase 6.12).**

Preserved foundation: 5 presentation modes × 6 comparison modes (§B.2); deterministic interpretations; review markers; provenance; transparency notes; CSV/print integration.

V1 development (6.12 — report presentation/customization):

- Executive summary view (top-line narrative numbers, no new computation engine)
- Saved report views/filters (per user; sharing is permission-gated and may be post-V1)
- Multi-period comparisons (several periods as columns — reuse comparison engine, no double-summing) as ready within the phase
- Collapse/expand + drill-down polish
- Report status/data-quality indicators surfaced consistently (header already carries them)

Must always respect: FLOW vs BALANCE; CUMULATIVE_YTD vs PERIOD_MOVEMENT; non-calendar fiscal years; no double-summing; no fake zeros; explicit incomplete states.

## C.7 — Consolidation scope & ownership engine (Direction §7)

**Status: PLANNED — POST-V1, Phase 7.3.** **Must not block V1 unless required to correct an existing material defect in the current consolidation foundation** (owner rule).

Planned "Consolidation Scope & Investments" registry per company/investee:

- company · legal ownership % · voting rights % · effective group ownership % · non-controlling interest %
- relationship type (subsidiary / associate / joint venture / joint operation / branch / …)
- control assessment (documented professional judgment) · significant influence · joint control
- acquisition/control effective date · disposal/loss-of-control date where relevant
- accounting treatment (full consolidation / equity method / proportionate / …) **decided by professionals, never derived from ownership % alone**
- inclusion status · rationale/basis (mandatory free-text reason, per house pattern) · notes · supporting documentation references

Standards-based processing must be configurable and professionally reviewable (every derived inclusion/treatment is visible with its basis and can be overridden with an audited reason).

Dependencies: consolidation foundation (exists); permission scopes. Risk: LOW-MEDIUM additive schema; HIGH reputational risk if treatment automation is over-promised (see §M).

## C.8 — Consolidation report basis (Direction §9→§8)

**Status: PLANNED — POST-V1, Phase 7.6.**

Report-basis selection for consolidated output:

| Basis | Label | Behavior |
|---|---|---|
| A) Standards-based | «وفق المعايير» | Uses the approved accounting treatment of each entity per the applicable reporting framework (from the ownership engine) |
| B) Full Management Combination | «دمج إداري كامل» | Selected companies combined 100% for management analysis. **Mandatory label: «تقرير مالي مجمع لأغراض إدارية»** + disclosure that it may differ from consolidated financial statements prepared under the applicable framework |
| C) Custom Treatment | «معالجة مخصصة» | Entity-by-entity treatment, each with documented reason and audit trail |

Hard rules (unchanged):

- **Never label a non-compliant management combination as IFRS consolidated financial statements.**
- Future saved scenarios: IFRS/Standards scenario · Management full combination · Management scenario · Reviewer scenario (each scenario stores basis + entity treatments + reason; reproducible and auditable).

Dependencies: 7.3 ownership engine. Risk: MEDIUM (labeling/governance controls must be gate-tested).

## C.9 — NCI / non-controlling interests (Direction §9)

**Status: PLANNED — POST-V1, Phase 7.4.** Advanced ownership/NCI must not block V1 (owner rule) except for material-defect correction in the existing foundation.

Track per group/investee: parent/group ownership · NCI % · acquisition date · ownership changes · opening NCI · NCI share of profit/loss · NCI share of OCI · dividends/distributions where applicable · closing NCI · ownership changes without loss of control · loss of control handled separately.

Future consolidated presentation must distinguish **equity attributable to owners of parent** vs **non-controlling interests** (SFP equity section and SOCIE-style attribution).

Not in any roadmap task: acquisition accounting (goodwill computation mechanics etc.) — separate professional-methodology decisions required (see §L).

Dependencies: 7.3. Risk: MEDIUM (presentation correctness; gate fixtures must prove attribution identities).

## C.10 — Consolidation worksheet (Direction §10)

**Status: PARTIALLY_IMPLEMENTED — advanced expansion POST-V1, Phase 7.5.** (Per-company working paper → eliminations → consolidated exists; elimination types today: AR/AP, Sales/Purchases, Loans, Dividends only.)

Future worksheet concept (columns):

```
Company A | Company B | Company C | Total Before Eliminations | Adjustments |
Eliminations | NCI / attribution where relevant | Consolidated
```

Future elimination coverage (each a dedicated future phase — none assumed here):

- Intercompany receivables/payables (exists in basic form)
- Intercompany sales/purchases (exists in basic form)
- Dividends (exists in basic form)
- **Unrealized profit in inventories/assets — POST-V1 (7.5)**
- **Investment/equity elimination — POST-V1 (7.5)**
- **Goodwill — POST-V1 (7.5; methodology deferred, see §L)**
- **NCI attribution — POST-V1 (7.4)**
- **FX / foreign operations translation where applicable — POST-V1 (7.5 hooks; rate policy deferred, see §L)**
- **Period alignment policies between companies — enhanced policies POST-V1 (7.5)**

Risk: MEDIUM-HIGH (accounting correctness; every elimination stays a balanced, audited, POSTED-only entry as today).

## C.11 — Receivables / debt aging analytics (Direction §11)

**Status: PLANNED — PROMOTED TO V1, Phase 6.10 (owner urgent list #1).**

1. **Independent Aging module with its own Excel upload** — flexible column mapping (user maps their file's columns to fields; no single rigid layout).
2. Possible fields: customer code · customer name · outstanding balance · invoice number/date/amount · due date · debt age days · last sale/invoice date + amount · last collection date + amount · credit limit · guarantees/insurance if available · salesperson/responsible person · notes.
3. **Configurable aging buckets** (per company; e.g. 0–30/31–60/… but user-defined).
4. Analytics: total receivables · overdue · overdue % · average age · inactive customers · long periods without collection · largest debtors · concentration · credit-limit breaches · old invoices · weak collections · unusual/negative balances.
5. **Risk-priority report**: customer · balance · age · last sale · last collection · risk indicator · reason · suggested review action.
6. **Recommendations are advisory only.**
7. **Do NOT automatically calculate IFRS 9 ECL solely from aging.** A full ECL engine requires a separate methodology/policy phase (§L; POST-V1 7.13, deferred).
8. Uploads stored as **Aging Snapshots** by company/period (immutable once approved, like committed TB pattern).
9. **Reconcile aging totals to authoritative TB customer accounts and disclose differences before approval** — no silent acceptance.
10. **Permissions/audit (V1, registry-ready keys — registry NOT a blocker):** `viewAging` (VIEW, company scope), `uploadAging` (UPLOAD, company scope, audited), `approveAgingSnapshot` (APPROVE, separate from upload — SoD), `configureAging` (CONFIGURE buckets/column mapping, audited). New audit codes: `AGING_UPLOADED`, `AGING_SNAPSHOT_APPROVED`, `AGING_RECONCILIATION_DIFFERENCE_DISCLOSED`, `AGING_CONFIG_CHANGED`. Charts/insights over aging follow parent VIEW + `exportReport` for exports.

Dependencies: permission keys (additive, in-phase), committed-TB reconciliation services (exist), visualization/insights foundations (same phase). Risk: LOW additive schema; MEDIUM operational if reconciliation UX is weak — difference disclosure is mandatory.

## C.12 — Review / audit analytics (Direction §12)

**Status: PARTIALLY_IMPLEMENTED — V1 carries the insights foundation only (6.10/6.11); the full review/audit analytics module incl. audit sampling is POST-V1, Phase 7.2 (owner rule: audit sampling POST-V1).**

Full module (POST-V1, unchanged):

- Accounts requiring attention · unusual movements · large variances · incomplete classification · reconciliation differences · risk indicators
- Suggested review priority · suggested sampling parameters

Hard rules (unchanged, and V1 insights inherit them):

- Sampling must **disclose assumptions**: materiality · population · risk · confidence · method.
- **Professional override required** on all suggestions.
- Do not claim the system automatically determines a sufficient audit sample or an audit opinion.
- The future audit report remains: **«مسودة مقترحة لتقرير المدقق المستقل»**.
- Jurisdiction / reporting framework / auditing framework must be selectable when relevant.

Dependencies: insights engine (6.10), comparison engine (exists). Risk: MEDIUM (overpromise control, see §M).

## C.13 — Charts & visualization (Direction §13)

**Status: PARTIALLY_IMPLEMENTED — PROMOTED TO V1: foundation in Phase 6.10, integration into key financial reports in Phase 6.11 (owner urgent list #2).**

Plan (unchanged in content, re-sequenced):

- **Central Visualization Layer** built once as shared infrastructure — charts appropriate to each report, not generic: revenue/expense trends · budget variance · asset/liability structure · cash-flow trends · **aging distribution** · consolidation composition · multi-period trends
- Support: show/hide charts · drill-down from chart · print/export compatibility (charts must not break A4 output or CSV) · responsive layout
- **Time-compression rule (D.2):** build the shared chart engine once in 6.10; per-report adoption in 6.11 is configuration/data-plumbing, not new engines per report.

Dependencies: comparison/statement services (exist), display-labels (exist), aging data (same phase 6.10). Risk: LOW.

## C.14 — Smart alerts / insights (Direction §14)

**Status: PARTIALLY_IMPLEMENTED — PROMOTED TO V1: foundation in Phase 6.10 (explainable aging alerts), integration into key reports in Phase 6.11 (owner urgent list #3).**

Plan (unchanged in content, re-sequenced):

- **Central Smart Insights Engine foundation**: severity levels INFO · ATTENTION · IMPORTANT · CRITICAL
- Every alert explains: what happened · affected amount · percentage if applicable · affected accounts/lines · reason/rule · suggested action
- Clearly distinguish: **FACT · ANALYSIS · RECOMMENDATION** — no unsupported automated professional conclusions
- **Explainable aging alerts in V1** (e.g., overdue concentration, credit-limit breach, long no-collection periods — each alert names its rule and inputs)
- Unified notification surface across companies/reports (full notification center may extend post-V1; V1 needs a usable, explainable in-product surface)

Dependencies: statement/comparison/aging data; display-labels; permission-aware delivery. Risk: LOW.

## C.15 — Internationalization / language (Direction §15)

**Status: PARTIALLY_IMPLEMENTED — V1: bilingual report delivery + localization improvements (Phase 6.12); POST-V1: English system UI (Phase 7.10).**

Plan (unchanged in content):

- **Two independent language controls**: System language (العربية / English) and Report language (العربية / English / عربي + English). Arabic = RTL, English = LTR. Report language never requires changing system language (already true for statements panel; extend to all delivered reports in 6.12).
- **Central Financial Terminology Dictionary** (extend display-labels.ts): one catalog of Arabic/English terms; internal stable codes may remain English; primary user-facing UI uses localized human-readable labels. V1 scope: complete coverage for every delivered report/surface; full system-UI English mode is 7.10.
- Errors and important alerts support Arabic + English (V1 for delivered reports and alerts).
- Technical codes (INCOMPLETE_DATA, NO_COMPARISON_DATA, UNCLASSIFIED_ACCOUNT, …) must never be primary user-facing wording (6.9R precedent: «بيانات غير مكتملة», «لا تتوفر بيانات للمقارنة»).

Risk: MEDIUM for 7.10 (touches every UI string); LOW-MEDIUM for 6.12 delivery scope.

## C.16 — Mobile / responsive experience (Direction §16)

**Status: PARTIALLY_IMPLEMENTED — PROMOTED TO V1: improvements in Phase 6.11, acceptance in Phase 6.13 (owner urgent list #6).**

Plan responsive desktop/tablet/mobile — **mobile must not simply be a scaled desktop page**. Priorities: navigation · report controls · tables (→ cards/stacked) · cards · charts · alerts · drill-down · authentication/session UX.

Future LAN/mobile testing strategy is exercised in 6.13 (mobile acceptance + LAN/client acceptance) — **no network settings are changed by the roadmap task itself**.

Risk: LOW-MEDIUM (pure UX; no schema).

## C.17 — Appearance / fonts / themes (Direction §17)

**Status: PARTIALLY_IMPLEMENTED — PROMOTED TO V1, Phase 6.11 (owner urgent list #4).**

Plan a **central Appearance Center** (unchanged): Arabic font · English font · UI font size · table font size · report-detail font size · zoom · density · professional themes (**financial blue · corporate green · professional gray · high contrast · dark**) · restore defaults. Preferences are user-specific (saved user preferences — owner urgent list #5). **Print/report appearance must remain independently controlled from screen theme** (6.8 print CSS is the boundary).

Risk: LOW (pure presentation).

## C.18 — Dashboard & productivity (Direction §18)

**Status: PARTIALLY_IMPLEMENTED — PROMOTED TO V1 (dashboard customization + saved user preferences, Phase 6.11); global search/favorites/recent reports may follow post-V1.**

V1 scope (owner urgent list #5): customizable dashboards (widget layout) · saved user preferences (appearance + layout + report options persisted per user).

Post-V1 backlog (unchanged): widgets catalog expansion · global search · favorites · recent reports · saved filters shared across users · full-screen report mode · tooltips polish · data-status indicators in more surfaces.

Dependencies: appearance center (same phase); saved report views (6.12). Risk: LOW.

## C.19 — Export / print / report delivery (Direction §19)

**Status: PARTIALLY_IMPLEMENTED — PROMOTED TO V1, Phase 6.12 (owner urgent list #7).**

V1 scope: browser print (exists) · **native/export-quality PDF where appropriate** · **Excel export** · **Word only where appropriate/necessary** · **bilingual report delivery** · consistent headers/footers carrying: company · fiscal year · period · report basis (where applicable) · currency · preparation date · page numbering (header exists; page numbering + basis extend it) · report metadata/status on every delivered artifact.

Snapshot requirement handling (owner instruction — preserved and split):

- **Mandatory before V1:** every delivered report (print/PDF/Excel/CSV) carries complete metadata/status (company, FY, period, data type, status DRAFT/APPROVED/PRELIMINARY/INCOMPLETE_DATA, currency, preparation date, page numbers where applicable) — this extends the existing 6.8 header; plus the approved-snapshot requirement stays documented as a product commitment (§C.17).
- **Safe post-V1:** the full immutable/revisioned approved-report snapshot engine (Phase 7.11) with browsing and revision chains.
- An optional minimal V1 increment (if time permits within 6.12): store approved-statement output hashes for integrity evidence. Not a V1 blocker.

Wide reports → A4 Landscape; narrow reports → A4 Portrait (rule already enforced).

## C.20 — Data governance & auditability (Direction §20)

**Status: IMPLEMENTED (standing controls) — preserved in V1; snapshots engine POST-V1 (7.11).**

Maintained: authoritative TB source · company scoping fail-closed · audit trail · workflow · optimistic locking · approved/locked protections · no silent classification · no forced balancing · no hidden reconciliation differences · BigInt-safe money · explicit completeness states.

Future: approved report snapshots immutable/revisioned (7.11). **No V1 speed shortcut weakens any standing control** (D.2).

## C.21 — Deployment / connection configuration (Direction §21)

**Status: PARTIALLY_IMPLEMENTED — verification in V1 (6.13); end-user connection settings UX POST-V1 (7.12).**

V1 (6.13): Windows production deployment verification, LAN/client acceptance, mobile acceptance — using the existing 5B deployment path; **no networking changes in the roadmap task itself**.

POST-V1 (7.12, unchanged): default server address · manual hostname/IP override · port where relevant · HTTPS · **Test Connection** (verifies application identity/version, not merely an open port) · save locally · Restore Default · recent servers/environments where useful. Priority chain: **manual saved URL → configured hostname → detected/default**. Never expose DB path or DB credentials to clients.

## C.22 — Repository hygiene — technical debt (Direction §22)

**Status: PLANNED — release-critical subset EXECUTED IN V1, Phase 6.13 (TD-1 folded into the stabilization & release phase).**

Currently tracked/runtime-sensitive paths:

- `db/custom.db` · `db/custom.db-wal` · `db/custom.db-shm` · `.zscripts/dev.pid`

Also pre-existing unrelated deletion: `src/app/api/backups/upload/route.ts` (still an unstaged working-tree deletion). Generated test artifacts exist untracked: `db/dev-*.db` / `db/dev-*.db-*` and `public/ifrs-phase-6.8-windows-local-test.zip`.

Plan (executed within 6.13, safe-release subset):

1. Inspect history/requirements first (why these paths entered tracking).
2. Protect production/user data — **never delete production DB merely for Git cleanliness**.
3. Remove runtime DB/PID artifacts from **future** Git tracking safely (`git rm --cached` pattern, not history rewrite).
4. Add appropriate `.gitignore` rules (db artifacts, PID, tool-results, local packages).
5. Decide the backup upload-route deletion **separately** on its own merits.
6. Release gate: **no production DB / runtime artifact included in the source release** (V1 DoD).
7. Explicitly out of scope: any history rewrite, any push.

---

# D) RECOMMENDED IMPLEMENTATION SEQUENCE (V2.0 — V1 FAST TRACK)

Advisory sequence — each phase still requires its own approval, design document, gate and STOP points.

## V1 track (owner urgent list → Phases 6.10–6.13)

| Order | Phase | Title | Content (owner-mandated) |
|---|---|---|---|
| 1 | **6.10** | **V1 ANALYTICS FAST TRACK** | Debt Aging module · flexible Excel column mapping · aging snapshots (company/period) · configurable aging buckets · TB reconciliation with disclosed differences · collection/debtor analytics + risk-priority report · **Visualization Layer foundation** (shared chart engine) · charts for Aging + reusable chart infrastructure · **Smart Insights foundation** (severities, alert anatomy) · explainable aging alerts · permissions/audit hooks required by these features (additive keys, fail-closed scope, audit codes) |
| 2 | **6.11** | **V1 EXPERIENCE FAST TRACK** | Central Appearance Center · themes (financial blue / corporate green / professional gray / high contrast / dark) · Arabic/English fonts · UI/table/report font sizing · density/zoom · responsive/mobile improvements · dashboard customization · saved user preferences · reusable visualization integration into key financial reports · smart alerts integration into key reports |
| 3 | **6.12** | **V1 REPORTING & DELIVERY** | Native/export-quality PDF where appropriate · Excel export · Word only where appropriate/necessary · bilingual report delivery · localization improvements · report presentation/customization (executive summary, saved report views, multi-period where ready, collapse/expand) · print/export consistency · report metadata/status · **approved-report snapshot requirement preserved and split: mandatory-before-V1 (metadata/status on every delivered artifact) vs safe-post-V1 (full immutable engine, 7.11)** |
| 4 | **6.13** | **V1 STABILIZATION & RELEASE** | Complete regression · security/company isolation verification · required permissions for all V1 modules (matrix audit) · session/auth stability · backup/restore acceptance (restore drill on release candidate) · Windows production deployment verification · LAN/client acceptance · mobile acceptance · performance checks · repository hygiene required for safe release (TD-1 executed here) · release documentation · source-code delivery structure · production package/release candidate |

## POST-V1 track (must not block V1)

| Order | Phase | Title |
|---|---|---|
| 5+ | 7.1 | Professional Practice / Accounting Firm Mode foundation |
| 6+ | 7.2 | Review/audit analytics full module + audit sampling + advanced audit/review files |
| 7+ | 7.3 | Consolidation scope & ownership engine |
| 8+ | 7.4 | NCI & attribution |
| 9+ | 7.5 | Consolidation worksheet expansion (advanced eliminations) |
| 10+ | 7.6 | Consolidation report basis & scenarios |
| 11+ | 7.7 | Company activity directory |
| 12+ | 7.8 | Sector profiles & regulated packs |
| 13+ | 7.9 | Full permission registry migration (+ templates/copy) — if not completed incrementally |
| 14+ | 7.10 | Localization expansion: English system UI |
| 15+ | 7.11 | Approved report snapshots — full immutable/revisioned engine |
| 16+ | 7.12 | Server connection configuration UX |
| 17+ | 7.13 | Full ECL engine — DEFERRED (jurisdiction/professional decision required first) |

Sequencing rationale: 6.10 builds the two shared engines (charts, insights) + the one new module (aging) — the long pole. 6.11 is mostly presentation/preference work that can start in parallel where it does not depend on 6.10 engines; its integration step waits for 6.10. 6.12 delivery builds on stable surfaces. 6.13 freezes, verifies and releases. **Parallelization is encouraged where safe (D.2) — e.g., appearance-center work (6.11) can proceed while aging backend (6.10) is in flight, provided shared files are coordinated.**

---

# D.1) V1 FAST-TRACK DEFINITION OF DONE

**V1 is considered ready only when ALL of the following are verified** (each with its verification method):

| # | DoD item | Verification method |
|---|---|---|
| 1 | Core financial statements remain regression-green (P&L+OCI, SFP, SOCIE, IAS7 CF) | Full gate suite green on isolated DBs from migrations only: existing 175 checks + all new phase gates; lint 0; typecheck at/below baseline |
| 2 | TB and budget workflows remain safe | 62A–62D + 63 + 65 gates green; committed-TB immutability + revision chain + budget LOCKED semantics re-asserted; no V1 code path writes to committed TB |
| 3 | Aging is operational | Upload (flexible mapping) → snapshot → buckets → analytics → risk-priority report → TB reconciliation with disclosed difference → approval (SoD upload≠approve) — proven by gate + browser E2E on isolated DB |
| 4 | Key reports have useful charts | Charts present on: P&L, SFP, cash flow, budget variance, aging, comparison — each chart ties numerically to its report (gate asserts data identity); show/hide works; print/export not broken |
| 5 | Smart alerts are explainable | Every V1 alert shows what happened / amount / % / affected lines / rule / suggested action; FACT/ANALYSIS/RECOMMENDATION labels asserted in gate; no professional-conclusion wording |
| 6 | Appearance/themes/customization work | All five themes + Arabic/English fonts + font sizes + density/zoom + restore defaults verified in browser; print output unaffected by screen theme (6.8 regression re-run); preferences persist per user |
| 7 | Mobile is practically usable | Acceptance pass at 360–430px: navigation, report controls, tables→stacked/cards, charts, alerts, login; no uncontrolled horizontal body scroll |
| 8 | Required PDF/Excel delivery works | Native PDF and Excel exports of key reports open correctly; bilingual delivery (ar/en/ar_en) verified; >2^53 exact; headers carry company/FY/period/basis(where applicable)/currency/date/status; wide→landscape, narrow→portrait |
| 9 | Permissions/company isolation are enforced | Permission matrix per V1 module (VIEW/UPLOAD/APPROVE/CONFIGURE/EXPORT) tested over HTTP: denied = fail-closed, never empty-as-zero; cross-company access attempts blocked; audit codes written for every sensitive action |
| 10 | Backup/restore is verified | Restore drill executed against the release candidate build; session epoch invalidation verified; RECOVERY_REQUIRED path intact |
| 11 | Windows/LAN deployment is accepted | Windows production deployment verification completed; LAN/client acceptance checklist signed; health endpoint + preflight green on the deployed candidate |
| 12 | No production DB/runtime artifact in source release | Release tree contains no `db/custom.db*`, no WAL/SHM, no PID, no dev/test DBs; .gitignore rules active; tracked runtime paths untracked (TD-1 executed) |
| 13 | Source tree and deployment documentation are deliverable | README/runbook covers deployment, environment, first-run admin, backup/restore, known limits; source structure documented; release candidate packaged |

**Anything not on this list — however desirable — must not delay V1** (post-V1 backlog unless it corrects an existing material defect).

---

# D.2) V1 TIME-COMPRESSION PRINCIPLES

Standing rules for all V1 phases:

1. **Reuse existing services.** Aging, charts and insights consume committed-TB data through the existing central bridges (`trial-balance-data`, `reporting-server`, `comparison-server`) — no second data engine, ever.
2. **Build shared engines once, not per report.** One visualization engine + one insights engine, adopted by reports via configuration/data-mapping — never a chart or alert implementation duplicated per report.
3. **Parallelize independent work where safe.** Appearance center, preferences and delivery-format work can run in parallel with aging/analytics backend, provided shared-file coordination and merge discipline are explicit in each phase's plan.
4. **Avoid unnecessary schema changes.** Only 6.10 (aging storage) strictly requires additive tables; preferences/appearance are client-side or additive-light; delivery needs none. Every schema change must justify why existing structures cannot serve.
5. **No cosmetic perfection blocking V1.** Polish that does not appear in D.1 is deferred; "good, professional, honest" beats "pixel-perfect" for V1.
6. **No post-V1 professional-practice functionality blocking V1.** Practice mode, audit sampling, ownership/NCI/advanced eliminations, sector packs stay out of V1 scope and its critical path (exception: correcting an existing material defect).
7. **Automated gates before browser verification.** Every phase proves itself first by gate scripts on isolated DBs (migrations only); browser E2E comes after gates are green — never as a substitute for them.
8. **Browser verification only after gates are green.** E2E confirms integration/UX; it does not gate-unblock broken logic.
9. **No destructive migration shortcuts.** ADD-ONLY migrations only; no resets of production data; canonical fingerprint discipline maintained.
10. **No weakening of accounting/data-integrity controls for speed.** All §B.4 invariants hold under time pressure; if a deadline conflicts with a control, the control wins and scope shrinks instead.

---

# E) EXPLICIT DEPENDENCY GRAPH (V2.0 — what must be built before what)

```
V1 CRITICAL PATH
═══════════════════════════════════════════════════════════════════════

Existing foundation (committed, 32c0861): statements + TB governance +
budget + consolidation + comparison engine + display-labels + print/CSV
   │
   ├─────────────────────────► PHASE 6.10 V1 ANALYTICS FAST TRACK
   │                            ├─ Aging module (upload→snapshot→buckets→
   │                            │  reconciliation→approval)   [additive schema]
   │                            ├─ Visualization Layer FOUNDATION (shared engine)
   │                            ├─ Smart Insights FOUNDATION (shared engine)
   │                            └─ permissions/audit hooks (additive keys)
   │                                        │
   │            (appearance/preferences/mobile work can run in PARALLEL)
   │                                        │
   ├─────────────────────────► PHASE 6.11 V1 EXPERIENCE FAST TRACK
   │                            ├─ Appearance Center (themes/fonts/sizes/density)
   │                            ├─ Responsive/mobile improvements
   │                            ├─ Dashboard customization + saved preferences
   │                            ├─ Charts integration into key reports ◄─ depends on
   │                            │                                        6.10 chart engine
   │                            └─ Alerts integration into key reports ◄─ depends on
   │                                                                     6.10 insights engine
   │                                        │
   ├─────────────────────────► PHASE 6.12 V1 REPORTING & DELIVERY
   │                            ├─ PDF/Excel(/Word) via report-export registry ◄─ needs
   │                            │    stable report surfaces (exist) + labels (exist)
   │                            ├─ Bilingual delivery + localization improvements
   │                            ├─ Report presentation/customization (saved views,
   │                            │    executive summary, multi-period where ready)
   │                            └─ Report metadata/status on every artifact
   │                                        │
   └─────────────────────────► PHASE 6.13 V1 STABILIZATION & RELEASE
                                ◄─ depends on ALL of 6.10 + 6.11 + 6.12
                                ├─ full regression + isolation/permission matrix audit
                                ├─ backup/restore acceptance + session/auth stability
                                ├─ Windows deployment verification + LAN/client + mobile
                                ├─ performance checks
                                ├─ repository hygiene (TD-1) + clean release tree
                                └─ release docs + source delivery + RC package

NOT a V1 blocker: full Permission Registry (7.9). V1 features carry their own
additive keys, fail-closed scope and audit codes (registry-ready definitions §F).

POST-V1 DEPENDENCY CHAIN (must not block V1; defect-fix exception only)
═══════════════════════════════════════════════════════════════════════
7.1 Practice mode ──► needs client-scope permission evolution (7.9 or incremental)
7.2 Review analytics + audit sampling ──► builds on 6.10 insights engine
7.3 Ownership engine ──► 7.4 NCI ──► 7.5 Worksheet expansion (NCI column,
                                      investment elimination, unrealized profit,
                                      goodwill, FX hooks) ──► 7.6 Report basis
7.7 Activity directory ──► 7.8 Sector profiles & regulated packs
7.9 Full permission registry (if not completed incrementally) ──► enables
                                      client scope (7.1) + templates/copy
7.10 English system UI ──► independent (after surfaces stabilize)
7.11 Full snapshot engine ──► builds on 6.12 metadata/status + export formats
7.12 Connection UX ──► independent
7.13 ECL engine ──► DEFERRED (§L jurisdiction/professional decision first)
```

Standing cross-dependencies: audit trail + scoping + BigInt money + honest-state rules apply to **every** arrow above.

---

# F) SECURITY / PERMISSIONS IMPLICATIONS FOR EVERY FUTURE MODULE

**V2.0 V1 policy:** the full registry is not a blanket blocker. For each V1 feature: **(1) define the permissions it needs (additive keys, registry-ready), (2) enforce existing company scope/fail-closed controls, (3) add audit requirements for sensitive actions, (4) preserve existing security.** The house pattern (explicit keys on the user JSON permission object + `canXxx()` helpers + session guards) is the V1 vehicle; it is already tested by the 175-check suite.

### V1 per-feature permission definitions (draft — finalized at each phase design gate)

| Phase / feature | Additive permission keys (action dimension) | Sensitive actions (audit codes) | Scope | SoD |
|---|---|---|---|---|
| 6.10 Aging — view | `viewAging` (VIEW) | — | company | — |
| 6.10 Aging — upload | `uploadAging` (UPLOAD) | `AGING_UPLOADED` (file name, rows, mapping version) | company | uploader ≠ snapshot approver |
| 6.10 Aging — approve snapshot | `approveAgingSnapshot` (APPROVE) | `AGING_SNAPSHOT_APPROVED`, `AGING_RECONCILIATION_DIFFERENCE_DISCLOSED` (difference amounts shown) | company | separate key, like restore precedent pattern |
| 6.10 Aging — configure | `configureAging` (CONFIGURE) | `AGING_CONFIG_CHANGED` (buckets/mapping, before/after) | company | — |
| 6.10 Charts (foundation) | none new — follows parent report VIEW | chart render is read-only | parent report scope | — |
| 6.10 Insights (foundation) | `viewInsights` (VIEW, default-on for report viewers); `configureInsightRules` (CONFIGURE, admin) | `INSIGHT_RULE_CONFIGURED` | company (rules), viewer (display) | — |
| 6.11 Appearance/preferences | none — per-user preference | none (user-local data) | per-user | — |
| 6.11 Dashboard customization | none — per-user layout | none | per-user | — |
| 6.12 Export PDF/Excel/Word | `exportReport` (EXPORT — new explicit dimension; CSV/print keep existing guards) | `REPORT_EXPORTED` (who/what/format/when/report identity) | parent report scope | EXPORT ≠ APPROVE |
| 6.12 Report presets/saved views | per-user create/edit; sharing (if any) permission-gated | none (user-local) | per-user | — |
| 6.13 Release verification | none new | release checklist evidence archived | — | — |

All V1 keys are documented with (key, action dimension, scope, risk class, module) — the exact shape the 7.9 registry will ingest, so nothing is thrown away.

### Full-module permission implications (unchanged from V1.0, for POST-V1 phases)

| Module | New permissions (draft) | Sensitive actions (separate/audit) | Scope | SoD |
|---|---|---|---|---|
| 7.9 Registry | ADMINISTER permissions; CONFIGURE templates | Copy-permissions apply (audit source/target/added/removed/scope); escalation guard | all/selected/client/group/assignments | Admin ≠ target user; restore-class keys independent |
| 7.7 Activities | CONFIGURE activities; VIEW for all | Catalog edits audited | system-wide catalog, per-company assignment | Assignment ≠ approval where workflow applies |
| 7.1 Practice mode | ADMINISTER clients; VIEW client; manage engagements; assign staff | Engagement state changes audited; cross-client access fail-closed | practice→client→company | Preparer ≠ reviewer ≠ approver per engagement |
| 7.2 Review analytics | VIEW analytics; EXPORT | none new | company scope | Professional override recorded |
| 7.3 Ownership engine | CONFIGURE investments; EDIT treatment | Treatment decisions require documented reason; every change audited | consolidation group | Suggester ≠ acceptor |
| 7.4 NCI | follow 7.3 | Attribution runs audited as POSTED adjustments | group | as consolidation today |
| 7.5 Worksheet | POST adjustments/eliminations (exists) + REVERSE | REVERSE is new high-risk: separate permission + reason | group | Preparer ≠ approver (exists) |
| 7.6 Basis | CONFIGURE scenarios; RUN report-basis | Basis/scenario runs recorded with basis label | group | Scenario config ≠ report approver |
| 7.8 Sector profiles | CONFIGURE profiles | Profile activation audited per jurisdiction | activity+jurisdiction | — |
| 7.11 Snapshots | CREATE snapshot (post-approve); VIEW snapshots | Immutability enforced server-side; no delete/edit API | company/report scope | Preparer cannot approve own snapshot |
| 7.12 Connection | none (local settings); identity endpoint public-safe | none | per-device | — |

---

# G) ACCOUNTING / CONTROL IMPLICATIONS

1. **Committed TB supremacy is never relaxed.** Aging snapshots, insights, charts and analytics are consumers of committed data; nothing writes back to TB. Aging reconciles **to** TB; differences are disclosed, never absorbed.
2. **Report metadata/status on every V1-delivered artifact** is a control, not cosmetics: a reader can always tell company, period, data type, status and preparation date (extends 6.8 header).
3. **Snapshot requirement preserved:** approved reports are a product commitment; V1 ships the metadata/status substrate, the full immutable engine follows (7.11). No V1 delivery may claim an approved snapshot is immutable when the engine is not yet built — wording stays honest.
4. **Ownership engine (7.3, post-V1)**: relationship/treatment is a documented professional judgment with mandatory reason; the system may *suggest* only. Control assessment can never be reduced to a percentage threshold without an override path.
5. **Report basis (7.6, post-V1)**: basis label is a first-class part of the report header; management combination carries «تقرير مالي مجمع لأغراض إدارية» + framework-difference disclosure; custom treatment requires per-entity reason + audit trail.
6. **NCI (7.4) / worksheet (7.5), post-V1**: owners-of-parent vs NCI split; every elimination a balanced POSTED entry; loss of control distinct from ownership-change-without-loss-of-control; identity checks gate-mandatory.
7. **Aging (6.10, V1)**: bucket math is presentation, not valuation; no ECL auto-calculation; reconciliation difference to TB is displayed and must be acknowledged before snapshot approval; snapshots immutable once approved.
8. **Insights (6.10/6.11, V1)**: every alert is FACT/ANALYSIS/RECOMMENDATION-separated; recommendations advisory; no professional conclusions.
9. **Terminology (6.12, V1 delivery)**: budget favorability terms stay contextual (revenue vs expense) per 6.9R; period-vs-period stays neutral (ارتفاع/انخفاض); SFP rows stay favorability-free.
10. **Period semantics**: any new time dimension (multi-period columns, trend charts, aging over periods) reuses the central temporal aggregation (`CUMULATIVE_YTD` movement = Δ cumulative; BALANCE as-of) — never a second engine.
11. **No speed shortcut weakens §B.4 invariants** — the explicit V1 time-compression guard (D.2 #10).

---

# H) TESTING REQUIREMENTS FOR EVERY PROPOSED PHASE

House testing pattern (mandatory for each phase):

1. **Gate script** (`scripts/phase<NN>-*.ts`) on an isolated DB created **from migrations only** — numbered PASS/FAIL assertions; fixtures hand-balanced where accounting identities apply; zero plug fixtures.
2. **Full regression suite** must stay green: 62A=30, 62B=16, 62C=9, 62D=6, 63=13, 64=9, 65=8, 66=8, 67=19, 68=14, 69=23, 69R=20 (175 checks — the suite grows by each new phase's gate).
3. **lint 0 + typecheck at/below measured baseline** (92 as of 6.9R), zero errors in the phase's files.
4. **Browser E2E only after gates are green** (D.2 #7–8): Arabic RTL rendering, honest states visible, print output spot-check, mobile width.

Phase-specific additions:

| Phase | Additional mandatory tests |
|---|---|
| 6.10 | Aging: flexible column mapping (≥2 different layouts succeed); bucket boundaries exact; reconciliation difference disclosed (non-zero difference blocks approval); snapshot immutable server-side; SoD upload≠approve enforced; BigInt totals >2^53 exact; chart data ties to aging snapshot; insight alerts name rule+inputs; permission matrix over HTTP (VIEW/UPLOAD/APPROVE/CONFIGURE denied paths fail-closed); audit codes written |
| 6.11 | Chart engine: every integrated chart ties numerically to its report (gate asserts identity); charts excluded from print/CSV or rendered print-safe; null data → no fake series; appearance: all themes/fonts/sizes applied and persisted per user; restore-defaults works; print output unaffected by any screen theme/font choice (6.8 regression); mobile 360–430px nav/tables/cards/charts; dashboard customization persists |
| 6.12 | Native PDF/Excel byte-level checks; Word where produced; >2^53 exact; Arabic BOM in exports; bilingual delivery (ar/en/ar_en) correctness; metadata/status present on every artifact; page numbering; wide→landscape / narrow→portrait; presentation customizations do not alter underlying values (display-only asserted); export audit codes |
| 6.13 | Full regression green (all gates); isolation re-verification (cross-company fail-closed matrix); permission matrix audit for ALL V1 modules; session/auth stability (login, epoch, expiry); restore drill on release candidate; Windows deployment verification checklist; LAN/client acceptance checklist; mobile acceptance checklist; performance smoke (report render times, upload size limits); release tree contains no DB/PID/dev artifacts; documentation completeness check |
| 7.1 | Cross-client isolation fail-closed at every endpoint; engagement workflow SoD; assignment-scoped visibility |
| 7.2 | Sampling disclosures present; override recorded; «مسودة مقترحة لتقرير المدقق المستقل» label asserted |
| 7.3 | Treatment never auto-derived from %; reason mandatory; inclusion status drives consolidation scope deterministically |
| 7.4 | NCI identity equation exact (BigInt); loss-of-control path distinct; owners-vs-NCI split displayed |
| 7.5 | Each new elimination type balances; POSTED-only totals; period-alignment policy assertions |
| 7.6 | Wrong-basis labeling impossible (management report cannot print IFRS title); scenario reproducibility |
| 7.7 | Primary+secondary assignment; user-defined activity CRUD audited; no enum lock-in (custom survives seed updates) |
| 7.8 | Jurisdiction switch changes behavior only where configured; nothing regulated assumed globally |
| 7.9 | Permission matrix per resource (denied = fail-closed); legacy JSON keys still honored; copy-permission audit trail exact; escalation attempts blocked; preview diff matches applied result |
| 7.10 | Dictionary single-source (no per-feature strings); both languages render for every surface; technical codes absent from primary wording |
| 7.11 | Immutability enforced server-side (no PATCH/DELETE); revision chain browsable; provenance exact |
| 7.12 | Test Connection verifies identity/version (wrong app = fail); priority chain order; no DB path/credential leakage |
| 7.13 | ECL methodology gate — only after §L decision; staging/inputs audited; advisory-only wording |

---

# I) MIGRATION / DATA-RISK CLASSIFICATION (V2.0)

| Phase | Schema change | Risk class | Rationale / notes |
|---|---|---|---|
| 6.10 | LOW–MEDIUM (aging snapshot + mapping tables — additive only) | **LOW (data), MEDIUM (process)** | The only V1 phase needing new tables; reconciliation-before-approval flow must be airtight; SoD enforced |
| 6.11 | NONE (preferences client-side/additive-light) | **NONE–LOW** | Pure presentation/preference; saved preferences additive-light if persisted server-side |
| 6.12 | NONE | **LOW** | Format registry extension + presentation options; no accounting change |
| 6.13 | NONE | **MEDIUM (operational)** | Hygiene touches Git tracking + packaging; production data untouched; no history rewrite |
| 7.1 | MEDIUM (client/practice/engagement tables) | **MEDIUM–HIGH** | Scoping threading through all company-scoped queries; full isolation gate mandatory |
| 7.2 | NONE–LOW | **LOW** | Derived analytics |
| 7.3 | LOW–MEDIUM (investments registry) | **LOW (data), MEDIUM (accounting)** | Treatment governance |
| 7.4 | LOW (additive to 7.3) | **MEDIUM (accounting)** | Attribution correctness |
| 7.5 | MEDIUM (elimination extensions) | **HIGH (accounting correctness)** | Unrealized profit/goodwill are classical error sources; dedicated gates per type |
| 7.6 | LOW | **MEDIUM (labeling/governance)** | Mislabeling risk is the controlled hazard |
| 7.7 | LOW (additive) | **LOW** | Optional backfill only |
| 7.8 | LOW | **MEDIUM** | Jurisdiction configurability |
| 7.9 | LOW (registry tables) + user-JSON migration | **MEDIUM** | Backward compatibility with existing permission JSON; dual-read transition gated |
| 7.10 | LOW (dictionary storage if persisted) | **MEDIUM (surface-wide)** | Risk is translation coverage, not data |
| 7.11 | LOW (snapshot tables) | **LOW–MEDIUM** | Immutability semantics must be exact |
| 7.12 | NONE | **NONE** | Client-side settings; identity endpoint design-reviewed |
| 7.13 | MEDIUM (ECL models) | **HIGH (methodology)** | Blocked on §L decision |

Standing policy: any phase that would touch the committed-TB flow, run migrations on production `db/custom.db`, or alter restore paths is **HIGH** by definition and requires an explicit STOP-and-approve gate (this roadmap authorizes none). **No destructive migration shortcuts in V1 or ever** (D.2 #9).

---

# J) SUGGESTED FUTURE PHASE NUMBERING (V2.0)

**V1 does NOT absorb everything.** Numbering proposal (advisory; adjust at approval time):

**V1 track (owner urgent):**

| Phase | Title |
|---|---|
| 6.10 | V1 Analytics Fast Track — Debt Aging module (flexible Excel mapping, snapshots, buckets, TB reconciliation, collection/debtor analytics, risk-priority report) + Visualization Layer foundation + Smart Insights foundation + explainable aging alerts + permissions/audit hooks |
| 6.11 | V1 Experience Fast Track — Appearance Center (themes, Arabic/English fonts, sizing, density/zoom) + responsive/mobile improvements + dashboard customization + saved user preferences + charts & alerts integration into key financial reports |
| 6.12 | V1 Reporting & Delivery — native/export-quality PDF + Excel export + Word where appropriate + bilingual report delivery + localization improvements + report presentation/customization + print/export consistency + report metadata/status (snapshot requirement: mandatory metadata before V1, full engine 7.11) |
| 6.13 | V1 Stabilization & Release — complete regression, security/isolation verification, V1 permission matrix, session/auth stability, backup/restore acceptance, Windows deployment verification, LAN/client + mobile acceptance, performance checks, repository hygiene (TD-1), release documentation, source delivery structure, production package/release candidate |

**POST-V1 track:**

| Phase | Title |
|---|---|
| 7.1 | Professional Practice / Accounting Firm Mode foundation (clients, engagement files, isolation, staff assignment) |
| 7.2 | Review/audit analytics full module + audit sampling + advanced audit/review files |
| 7.3 | Consolidation scope & ownership engine (investments registry, control assessment) |
| 7.4 | NCI & attribution (owners-of-parent vs NCI presentation) |
| 7.5 | Consolidation worksheet expansion (unrealized profit, investment/equity elimination, goodwill entries, FX hooks, period alignment) |
| 7.6 | Consolidation report basis & saved scenarios (standards / management / custom) |
| 7.7 | Company activity directory (extensible, primary/secondary/user-defined) |
| 7.8 | Sector profiles & regulated packs (KPIs, templates, suggested mappings — advisory) |
| 7.9 | Full permission registry migration (+ templates/copy) — if not completed incrementally |
| 7.10 | Localization expansion — English system UI |
| 7.11 | Approved report snapshots — full immutable/revisioned engine |
| 7.12 | Server connection configuration UX (Test Connection, priority chain) |
| 7.13 | Full ECL engine — DEFERRED until jurisdiction/professional decision |

Sub-phase lettering (6.10A/B/C …) follows the established house style when a phase is large; 6.10 and 6.11 are expected to need it.

---

# K) APPROVED IDEAS NOT YET IMPLEMENTED

Consolidated checklist so no approved requirement is lost (source: Direction §1–§22). Status markers: **[V1 → phase]** or **[POST-V1 → phase]** — nothing deleted.

**Positioning & structure**
- [ ] Long-term hierarchy Practice→Client→Company→Activities→FY→Periods→TB→Statements→Analysis→Review→Reports **[POST-V1 → 7.1, documented §A.2]**
- [ ] Professional practice mode: clients, companies-per-client, strict isolation, engagement files, assigned staff, supporting documents, review notes, proposed adjustments, internal-control findings, engagement status/workflow, report drafts **[POST-V1 → 7.1]**
- [ ] Advanced audit/review files **[POST-V1 → 7.1/7.2]**
- [ ] No automated audit opinion generation — standing negation (§3)

**Activity & sector**
- [ ] Extensible activity directory with the full seed list incl. exchange/remittance/money-transfer/e-wallet/banking entries (Arabic names preserved verbatim) **[POST-V1 → 7.7]**
- [ ] Primary + multiple secondary activities; user-defined activities **[POST-V1 → 7.7]**
- [ ] Sector profiles driving KPIs / analytics / alerts / report templates / review procedures / suggested mappings — advisory **[POST-V1 → 7.8]**
- [ ] Regulated-sector behavior configurable by jurisdiction/regulator/framework **[POST-V1 → 7.8]**

**Permissions**
- [ ] Central permission registry; action dimensions VIEW…ADMINISTER **[POST-V1 → 7.9; V1 uses registry-ready additive keys per §F]**
- [ ] Scope dimensions: all/selected companies (exists) + client + consolidation group + own assignments **[POST-V1 → 7.9/7.1]**
- [ ] Copy permissions from user / role templates; 3 copy modes; never copy secrets; preview/diff; full audit; escalation prevention **[POST-V1 → 7.9]**
- [ ] SoD preparer-vs-approver wherever applicable **[standing; V1 aging snapshot SoD in 6.10]**

**Reporting**
- [ ] Executive summary view **[V1 → 6.12]**
- [ ] Saved views/filters; sharing permission-gated **[V1 → 6.12 (personal); sharing may extend post-V1]**
- [ ] Multi-period comparison columns **[V1 → 6.12 where ready]**
- [ ] Collapse/expand + drill-down polish **[V1 → 6.12]**
- [ ] Report status/data-quality indicators across more surfaces **[V1 → 6.12]**

**Consolidation (all POST-V1; defect-fix exception only)**
- [ ] Consolidation Scope & Investments registry with all listed fields; treatment never from % alone **[POST-V1 → 7.3]**
- [ ] Report basis A/B/C with mandatory Arabic labels + management-combination disclosure **[POST-V1 → 7.6]**
- [ ] Saved scenarios: IFRS/Standards, Management full combination, Management scenario, Reviewer scenario **[POST-V1 → 7.6]**
- [ ] NCI tracking: opening/closing, profit/OCI share, dividends, ownership changes, loss of control **[POST-V1 → 7.4]**
- [ ] Equity presentation split: owners of parent vs NCI **[POST-V1 → 7.4]**
- [ ] Worksheet columns incl. NCI/attribution **[POST-V1 → 7.4/7.5]**
- [ ] Eliminations: unrealized profit, investment/equity, goodwill, FX/foreign operations, enhanced period alignment **[POST-V1 → 7.5]**

**Analytics**
- [ ] Aging module: own Excel upload, flexible mapping, all listed fields, configurable buckets, full analytics list, risk-priority report, Aging Snapshots, TB reconciliation before approval **[V1 → 6.10]**
- [ ] No auto-IFRS-9-ECL from aging — standing negation; full ECL engine separate **[POST-V1 → 7.13, DEFERRED §L]**
- [ ] Review/audit analytics: attention accounts, unusual movements, large variances, incomplete classification, reconciliation differences, risk indicators, review priority **[POST-V1 → 7.2; V1 insights foundation covers explainable alerts]**
- [ ] Sampling parameters with disclosed assumptions + professional override **[POST-V1 → 7.2 — audit sampling explicitly post-V1 per owner]**
- [ ] Draft-only audit report label «مسودة مقترحة لتقرير المدقق المستقل» + framework selection **[standing rule; full use POST-V1 → 7.2]**

**Experience**
- [ ] Central visualization layer with per-report chart types **[V1 → 6.10 foundation + 6.11 integration]**
- [ ] Smart insights engine: severities, alert anatomy, FACT/ANALYSIS/RECOMMENDATION, notification surface **[V1 → 6.10 foundation + 6.11 integration; full notification center may extend post-V1]**
- [ ] System language English mode **[POST-V1 → 7.10]**
- [ ] Report language عربي+English mixed delivery **[V1 → 6.12]**
- [ ] Central terminology dictionary **[V1 → 6.12 for delivered surfaces; completion POST-V1 → 7.10]**
- [ ] Bilingual errors/alerts **[V1 → 6.12 for delivered reports/alerts]**
- [ ] Dedicated mobile UX (nav, tables→cards, charts, alerts, drill-down, auth UX) **[V1 → 6.11 + 6.13 acceptance]**
- [ ] LAN/mobile testing strategy **[V1 → 6.13 acceptance; no network changes by roadmap task]**
- [ ] Appearance center: Arabic/English fonts, UI/table/report-detail sizes, zoom, density, five professional themes, restore defaults, print independence **[V1 → 6.11]**
- [ ] Dashboard customization + saved user preferences **[V1 → 6.11]**
- [ ] Widgets catalog expansion, global search, favorites, recents, shared saved filters, full-screen mode, tooltips, data-status indicators **[POST-V1 backlog → 7.x]**

**Delivery & governance**
- [ ] Native PDF/Excel; Word where appropriate **[V1 → 6.12]**
- [ ] Bilingual reports; consistent headers/footers with basis + page numbering **[V1 → 6.12]**
- [ ] Immutable/revisioned approved report snapshots **[metadata substrate V1 → 6.12; engine POST-V1 → 7.11]**
- [ ] Connection settings UX: default/override/HTTPS/Test Connection/save/restore/recent; identity-verified test; no DB credential exposure **[POST-V1 → 7.12]**
- [ ] Repository hygiene: untrack runtime artifacts, .gitignore, upload-route decision — safely, data first **[V1 → 6.13 (TD-1 executed here)]**

---

# L) DEFERRED / REQUIRES JURISDICTION OR PROFESSIONAL FRAMEWORK DECISION

These approved concepts are **deferred**: they require a jurisdiction, regulator, or professional-framework decision before design can be finalized. The system must not hard-code assumptions for them. **None of them blocks V1.**

1. **IFRS 9 ECL engine** — full expected-credit-loss methodology (staging, PD/LGD/EAD, forward-looking info) is a separate policy phase (7.13); aging alone never computes ECL.
2. **Goodwill computation methodology** — full vs partial goodwill, measurement-period adjustments, contingent consideration (blocks final 7.5 design).
3. **FX / foreign-operations translation (CTR)** — functional vs presentation currency pairs, closing/average/historical rate policies, where translation differences land (OCI vs P&L); deferred until a target jurisdiction/currency matrix is chosen.
4. **Audit report formats per jurisdiction** — ISA / local auditing standards wording, key-audit-matter sections, signature blocks; the system produces drafts only, per selected framework.
5. **Regulated-sector behavior packs** — e.g. exchange/remittance/money-transfer, banking, insurance reporting templates and alerts; activated per jurisdiction/regulator/framework, never globally.
6. **Tax / Zakat computations** — not part of any approved direction to date; out of scope until separately approved.
7. **Consolidation classification automation** — control/joint-control/influence determination remains a documented professional judgment; no percentage-based auto-classification will be built.
8. **Sampling sufficiency attestation** — the system never asserts that a sample is sufficient or that an opinion is supported; parameters are suggestions with disclosed assumptions.

---

# M) DO NOT OVERPROMISE

Standing language rules for UI, documentation and marketing of this product — they apply with full force to V1 (speed pressure is never an excuse for overclaiming):

| Area | The system must NOT claim | The system may claim |
|---|---|---|
| **Audit opinion** | Automated audit opinion generation; assurance; sufficiency | «مسودة مقترحة لتقرير المدقق المستقل» — a suggested draft for the independent auditor's report; analytics support the auditor, never replace judgment |
| **Sampling** | That the system automatically determines a sufficient audit sample | Suggested sampling parameters with disclosed assumptions (materiality, population, risk, confidence, method) and mandatory professional override |
| **IFRS compliance** | That output is "IFRS-compliant" or an IFRS attestation | Statements are prepared **from committed trial balances per recorded mappings and the selected framework**; compliance is the preparer's professional responsibility |
| **ECL / impairment** | Automatic IFRS 9 ECL from aging data | Aging analytics and risk indicators as **advisory** input to the entity's own ECL methodology |
| **Consolidation classification** | Automatic control/joint-control/associate classification from ownership % | Documented control assessments with reasons; treatment applied as professionally approved; suggestions always overridable |
| **Regulatory reporting** | That regulated-sector outputs satisfy a regulator by default | Configurable templates/behaviors per jurisdiction/regulator/framework, validated by professionals |
| **Management combination** | (Never) labeling a non-compliant management combination as IFRS consolidated financial statements | Mandatory «تقرير مالي مجمع لأغراض إدارية» label + framework-difference disclosure |

Additionally: every automated text stays within **FACT / ANALYSIS / RECOMMENDATION**; recommendations are advisory; the words «مواتٍ/غير مواتٍ» remain banned from user-facing labels (6.9R governance).

---

# N) V1 FAST-TRACK ADDITIONS — OWNER-APPROVED 2026-09-24 (V2.1)

These requirements are **newly approved additions** to the roadmap. All previously approved content above (including every C-section and the V1 Fast-Track sequence in D) remains in force unchanged. The additions below extend the architecture direction; they are part of the architecture/roadmap immediately, while **implementation inside V1 is foundations-only** (see N.8 Scope Control).

## N.1 — Advanced Budget Planning & Scenario Assistant

Budget creation must support three creation paths, coexisting:

1. **Upload an already-prepared budget.**
2. **Manual budget creation/editing** (extends the existing 6.5 manual editor).
3. **Intelligent proposed/generated budget** — system proposals from historical data and drivers.

Budget generation must **NOT** rely on one growth percentage applied to all accounts. The system must support **configurable budget drivers per account / account group / cost center** (where applicable), from a driver catalog:

- `FIXED`
- `SALES_GROWTH`
- `SALES_PERCENTAGE`
- `HISTORICAL_RATIO`
- `HISTORICAL_AVERAGE`
- `TREND`
- `DRIVER_BASED`
- `CUSTOM_GROWTH_RATE`
- `MANUAL`

Illustrative patterns that must be expressible:
- sales growth rate selected by management (applied to revenue accounts);
- expenses/revenues derived as a historical percentage of net sales;
- fixed items such as rent/depreciation where management chooses no change;
- different growth rates for different accounts;
- operational drivers such as employees × cost-per-employee, units × cost, branches × cost.

The system must always expose the full reasoning chain, end to end:
**historical basis → selected driver → assumption → system proposal → management override → final budget.**

- Generated budgets are **DRAFT** and must follow the existing budget workflow exactly: **DRAFT → SUBMITTED → APPROVED → LOCKED** (6.5 semantics; no new parallel workflow).
- Supported scenarios: **Conservative / Base / Optimistic / Custom** (map onto the existing `Budget.scenario` dimension; custom scenario labels allowed per company).
- System suggestions must be **explainable and advisory, never silently approved** — every generated value carries its driver, basis and assumption, and approval stays a human act inside the existing workflow (SoD unchanged).

## N.2 — Base Years for Forecasting

**Base Years are an analytical/forecasting concept** — a selection of historical periods used as the basis for projections. Management can select:

- current year only;
- last N years;
- selected years;
- historical average of selected years;
- trend across selected years.

Base Years may drive: budget forecasting, historical ratios, seasonality analysis, growth assumptions, and trend analysis.

**Hard rule:** Base Years must never be confused (in UI labels, APIs or storage) with financial-statement **comparative presentation periods** (N.3). They are different concepts serving different purposes and must remain separately named and separately stored.

## N.3 — Current Period / Comparative Period

For financial statements and reporting, the presentation model is:

- **Current Period** · **Comparative Period(s)** · **Variance** · **Variance %**

Current/comparative periods may be: year, quarter, month, YTD, and valid custom periods where supported.

- Comparisons must be **temporally consistent**: Jan–Sep 2026 compares with Jan–Sep 2025 (same length / same phase), not full-year 2025.
- Respect **FLOW vs BALANCE** semantics exactly as established (6.2A): FLOW statements present activity during the period; BALANCE statements present the closing/as-of balance. Variance semantics follow the statement's classification.
- Multiple comparative periods may be shown for management analysis; this must not be conflated with statutory/accounting comparative presentation requirements (single legal comparative column) — management views are additive layers, never replacements.

## N.4 — Seasonality Engine / Commercial Calendar

A future **Seasonality Engine** supports three calendar families:

1. **Gregorian seasons** (e.g. summer, winter, back-to-school).
2. **Hijri seasons** (e.g. Sha'ban, Ramadan, Eid al-Fitr, Hajj / Eid al-Adha).
3. **Custom commercial seasons** (user-defined campaigns/events).

A **Seasons & Commercial Calendar** screen lets the user configure per season: name; calendar type (Gregorian / Hijri / Custom); start rule; end rule; days before/after the event where relevant; active/inactive; applicable company/activity/branch/cost-center where supported.

Rules:

- **Hijri seasons must move correctly across Gregorian years. Ramadan must never be hard-coded to a Gregorian month** — Hijri rules are computed from the Hijri calendar.
- Management can **override actual commercial start/end dates** for any occurrence.
- When **daily sales data** exists, the engine automatically analyzes: historical season sales, average daily sales, comparison with normal/non-season days, season growth, seasonal uplift/decline, and the historical seasonal profile.
- When only **monthly data** exists, the system must clearly disclose reduced precision and **never invent daily sales**.
- **Overlapping seasons must be handled explicitly** so aggregate analytics never double-count sales.
- Future budget generation should be able to distribute annual/monthly forecasts using historical seasonality instead of simple equal monthly allocation.
- The engine **may suggest** recurring unexplained sales peaks as possible seasons, but must **never create or approve seasons automatically**.

## N.5 — Cost Centers

Cost Centers are an **optional company-level analytical dimension** — never mandatory, never implicit.

- **Do NOT equate** Account = Cost Center, or Branch = Cost Center. They are independent dimensions that may interact.
- Support **hierarchical cost centers** where practical.
- Future-ready analytical grain: **Company + Period + Account + Cost Center**.
- When cost-center detail exists: **preserve original accounting totals**; **reconcile cost-center totals to the Trial Balance/source**; **never invent missing allocations** (unallocated is an explicit, visible state).
- Budgeting must support **Account × Cost Center**, with different drivers/assumptions per cost center.
- **Transparent allocation rules for shared costs**, always preserving the audit chain: before allocation → allocation basis → allocated amount → after allocation. Supported bases: fixed percentage, sales, employee count, area, units, custom basis.
- Future reports: P&L by Cost Center; Actual vs Budget by Cost Center; comparative center analysis; expense/revenue trends; profitability where inputs support it; drill-down matrix Accounts × Cost Centers.
- Seasonality and budget engines should eventually support Cost Center / Branch level patterns where source data supports them.

## N.6 — Company Activity Directory Additions

- Preserve the previously approved extensible activity directory (C.2) **with no removals**.
- Explicitly add: **Shopping Mall / Commercial Center** · **Supermarket / Hypermarket** · **Retail**.
- Preserve previously approved remittance/payment activity names **exactly** as approved.
- Activity classification must **not hard-code analytical behavior** — seasonality (N.4) remains usable for any activity.

## N.7 — Smart Management Assistance

Budget/seasonality/cost-center suggestions must distinguish three knowledge tiers, machine-readable and human-labeled:

- **FACT** — what the recorded data says.
- **ANALYSIS** — what the system derives from that data (with its assumptions).
- **RECOMMENDATION** — what management may consider (advisory only).

Example insight families: expense growth materially exceeds the sales-growth assumption; historical expense-to-sales ratio differs materially from the proposed budget; season uplift differs materially from the historical pattern; cost-center spending grows faster than its activity driver.

These are **management insights, not audit conclusions or automatic accounting judgments** (consistent with §M Do-Not-Overpromise and the 6.9R FACT/ANALYSIS/RECOMMENDATION foundation).

## N.8 — V1 Scope Control for the Additions

The N.1–N.7 requirements are **architecture/roadmap commitments now**, but:

- They must **not delay the V1 Fast Track** (D: 6.10 Receivables Aging → Themes → Charts → Smart Alerts → Customization → Responsive → stabilization).
- Design Phase 6.10 and subsequent V1 work so the **architecture does not block** these capabilities (e.g., aging snapshots remain trend-ready; insights foundation is generic, not aging-only; charts foundation is module-agnostic; permission keys remain per-feature additive).
- Implement **only the foundations naturally required by current V1 phases**.
- Advanced seasonality, the full budget forecasting engine, the advanced allocation engine, and extensive cost-center analytics are delivered **incrementally in later phases** unless already low-risk and directly reusable.

**V1 urgent priorities remain, unchanged:** 1) Receivables / Debt Aging · 2) Themes · 3) Charts / Visualization · 4) Smart Alerts / Insights · 5) Customization · 6) Responsive/mobile usability · 7) Reporting/export/release stabilization. Professional Practice / Accounting Firm Mode and audit sampling remain **POST-V1**.

---

# DOCUMENT CONTROL

- This roadmap is **planning/documentation only**. Nothing in it authorizes implementation.
- **V2.0 revision (2026-09-24):** V1 fast-track re-prioritization per owner decision — V1 urgent list promoted to Phases 6.10–6.13; professional-practice/audit-sampling/advanced-consolidation moved POST-V1; permission registry made non-blocking for V1 (per-feature keys, §F); added D.1 (V1 Definition of Done) and D.2 (Time-Compression Principles); capability matrix, dependency graph, phase sequence, test and risk tables re-keyed. All approved ideas retained.
- **V2.1 revision (2026-09-24):** Owner-approved additions recorded as §N — N.1 Advanced Budget Planning & Scenario Assistant (per-account/group/cost-center drivers, DRAFT workflow, scenarios, explainable proposals), N.2 Base Years for forecasting, N.3 Current/Comparative Period semantics, N.4 Seasonality Engine & commercial calendar (Gregorian/Hijri/custom; Hijri never hard-coded to Gregorian months), N.5 Cost Centers (optional analytical dimension; Account × Cost Center budgeting; transparent allocation), N.6 activity directory additions (Shopping Mall / Commercial Center, Supermarket / Hypermarket, Retail), N.7 Smart Management Assistance (FACT/ANALYSIS/RECOMMENDATION), N.8 V1 scope control (foundations-only inside V1; fast track unchanged). Recovery baseline note: the lost Phase 6.9/6.9R commit `32c0861dcc6eb51cf6dbb1e4b5d74c6ccaad2f0b` is replaced as the verified practical baseline by recovered commit `add770df129021a79ba1b3dbb69eaa0e9a764b42` (gates 23/23 + 20/20, regression 175/175, milestone backed up off-platform).
- The proposed documentation-only commit title (for review approval): **"Master Development Roadmap V2: V1 fast-track priorities — analytics/experience/delivery/stabilization phases, V1 DoD and time-compression principles, post-V1 re-sequencing"**
- Next step (updated 2026-09-24): V2.1 additions approved by the owner; **Phase 6.10 (Receivables Aging & Collections) implementation authorized** on baseline `add770d` — roadmap-only commit remains deferred until the owner authorizes explicit-path staging.
