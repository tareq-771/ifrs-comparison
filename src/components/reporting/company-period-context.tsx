"use client";

// 6.7 — سياق مشترك للشركة/السنة المالية عبر عروض النظام (لوحة المعلومات، القوائم، الموازنة، التوحيد).
// الاختيار يُحفظ لكل مستخدم في localStorage — الصلاحيات تبقى مفروضة من الخادم (fail-closed).

import * as React from "react";
import { useSession } from "next-auth/react";
import { minorUnitsFor } from "@/lib/money";

export interface CompanyOption {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  status: string;
  functionalCurrency: string;
  reportingCurrency: string;
}

export interface FiscalPeriodOption {
  id: string;
  ordinal: number;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
  displayLabel: string;
}

export interface FiscalYearOption {
  id: string;
  code: string;
  displayNameAr: string;
  startDate: string;
  endDate: string;
  status: string;
  periodCount: number;
  periods: FiscalPeriodOption[];
}

interface CompanyPeriodValue {
  companies: CompanyOption[];
  companiesLoading: boolean;
  companiesError: string | null;
  reloadCompanies: () => Promise<void>;
  selectedCompanyId: string | null;
  setSelectedCompanyId: (id: string | null) => void;
  selectedCompany: CompanyOption | null;
  fiscalYears: FiscalYearOption[];
  fiscalYearsLoading: boolean;
  fiscalYearsError: string | null;
  selectedFiscalYearId: string | null;
  setSelectedFiscalYearId: (id: string | null) => void;
  selectedFiscalYear: FiscalYearOption | null;
  /** minor units للعملة الوظيفية للشركة المختارة */
  minorUnits: number;
}

const CompanyPeriodContext = React.createContext<CompanyPeriodValue | null>(null);

function storageKey(userId: string | undefined): string {
  return `ifrs-6.7-context:${userId ?? "anon"}`;
}

export function CompanyPeriodProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const userId = (session?.user as { id?: string } | undefined)?.id;

  const [companies, setCompanies] = React.useState<CompanyOption[]>([]);
  const [companiesLoading, setCompaniesLoading] = React.useState(true);
  const [companiesError, setCompaniesError] = React.useState<string | null>(null);
  const [selectedCompanyId, setSelectedCompanyIdRaw] = React.useState<string | null>(null);

  const [fiscalYears, setFiscalYears] = React.useState<FiscalYearOption[]>([]);
  const [fiscalYearsLoading, setFiscalYearsLoading] = React.useState(false);
  const [fiscalYearsError, setFiscalYearsError] = React.useState<string | null>(null);
  const [selectedFiscalYearId, setSelectedFiscalYearIdRaw] = React.useState<string | null>(null);

  const hydratedRef = React.useRef(false);

  const reloadCompanies = React.useCallback(async () => {
    setCompaniesLoading(true);
    setCompaniesError(null);
    try {
      const res = await fetch("/api/companies", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const rows = (await res.json()) as CompanyOption[];
      setCompanies(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setCompaniesError(err instanceof Error ? err.message : "تعذر جلب الشركات");
      setCompanies([]);
    } finally {
      setCompaniesLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reloadCompanies();
  }, [reloadCompanies]);

  // استرجاع الاختيار المحفوظ مرة واحدة عند توفر الشركات
  React.useEffect(() => {
    if (companiesLoading || companiesError) return;
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(storageKey(userId)) : null;
      if (raw) {
        const saved = JSON.parse(raw) as { companyId?: string; fiscalYearId?: string };
        if (saved.companyId && companies.some((c) => c.id === saved.companyId)) {
          setSelectedCompanyIdRaw(saved.companyId);
        }
        if (saved.fiscalYearId) setSelectedFiscalYearIdRaw(saved.fiscalYearId);
      }
    } catch {
      // تجاهل — بداية نظيفة
    }
  }, [companies, companiesLoading, companiesError, userId]);

  // ضمان اختيار صالح عند فقدان الشركات أو عدم اختيار
  React.useEffect(() => {
    if (companiesLoading || companiesError) return;
    if (selectedCompanyId && companies.some((c) => c.id === selectedCompanyId)) return;
    setSelectedCompanyIdRaw(companies[0]?.id ?? null);
  }, [companies, companiesLoading, companiesError, selectedCompanyId]);

  const setSelectedCompanyId = React.useCallback((id: string | null) => {
    setSelectedCompanyIdRaw(id);
    setSelectedFiscalYearIdRaw(null);
  }, []);

  // جلب السنوات المالية للشركة المختارة
  React.useEffect(() => {
    if (!selectedCompanyId) {
      setFiscalYears([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setFiscalYearsLoading(true);
      setFiscalYearsError(null);
      try {
        const res = await fetch(`/api/fiscal-years?companyId=${encodeURIComponent(selectedCompanyId)}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const rows = (await res.json()) as FiscalYearOption[];
        if (cancelled) return;
        setFiscalYears(Array.isArray(rows) ? rows : []);
      } catch (err) {
        if (cancelled) return;
        setFiscalYearsError(err instanceof Error ? err.message : "تعذر جلب السنوات المالية");
        setFiscalYears([]);
      } finally {
        if (!cancelled) setFiscalYearsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCompanyId]);

  // ضمان سنة مختارة صالحة
  React.useEffect(() => {
    if (fiscalYearsLoading || fiscalYearsError) return;
    if (!fiscalYears.length) {
      if (selectedFiscalYearId !== null) setSelectedFiscalYearIdRaw(null);
      return;
    }
    if (selectedFiscalYearId && fiscalYears.some((f) => f.id === selectedFiscalYearId)) return;
    setSelectedFiscalYearIdRaw(fiscalYears[0]?.id ?? null);
  }, [fiscalYears, fiscalYearsLoading, fiscalYearsError, selectedFiscalYearId]);

  // حفظ الاختيار
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        storageKey(userId),
        JSON.stringify({ companyId: selectedCompanyId, fiscalYearId: selectedFiscalYearId })
      );
    } catch {
      // ignore
    }
  }, [selectedCompanyId, selectedFiscalYearId, userId]);

  const selectedCompany = React.useMemo(
    () => companies.find((c) => c.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId]
  );
  const selectedFiscalYear = React.useMemo(
    () => fiscalYears.find((f) => f.id === selectedFiscalYearId) ?? null,
    [fiscalYears, selectedFiscalYearId]
  );
  const minorUnits = minorUnitsFor(selectedCompany?.functionalCurrency);

  const value = React.useMemo<CompanyPeriodValue>(
    () => ({
      companies, companiesLoading, companiesError, reloadCompanies,
      selectedCompanyId, setSelectedCompanyId, selectedCompany,
      fiscalYears, fiscalYearsLoading, fiscalYearsError,
      selectedFiscalYearId, setSelectedFiscalYearId: setSelectedFiscalYearIdRaw,
      selectedFiscalYear, minorUnits,
    }),
    [
      companies, companiesLoading, companiesError, reloadCompanies,
      selectedCompanyId, setSelectedCompanyId, selectedCompany,
      fiscalYears, fiscalYearsLoading, fiscalYearsError,
      selectedFiscalYearId, selectedFiscalYear, minorUnits,
    ]
  );

  return <CompanyPeriodContext.Provider value={value}>{children}</CompanyPeriodContext.Provider>;
}

export function useCompanyPeriod(): CompanyPeriodValue {
  const ctx = React.useContext(CompanyPeriodContext);
  if (!ctx) throw new Error("useCompanyPeriod must be used within CompanyPeriodProvider");
  return ctx;
}
