#!/usr/bin/env python3
"""4B.1 — أداة تطبيق حراس الصيانة على معالجات HTTP (guardWrite/guardRead).

تلفّ جسم كل handler محدد بـ guardWrite/guardRead من api-guard مع إضافة
الاستيراد إن غاب. تتعامل مع تعليقات وسلاسل TS (بما فيها template literals
مع تعابير ${...}) عند مطابقة الأقواس.
"""
import re, sys

TARGETS = {
    "src/app/api/setup/route.ts": [
        ("GET", "read", "/api/setup"),
        ("POST", "write", "/api/setup"),
    ],
    "src/app/api/users/route.ts": [
        ("GET", "read", "/api/users"),
        ("POST", "write", "/api/users"),
    ],
    "src/app/api/users/[id]/route.ts": [
        ("PUT", "write", "/api/users/[id]"),
        ("DELETE", "write", "/api/users/[id]"),
    ],
    "src/app/api/groups/route.ts": [
        ("GET", "read", "/api/groups"),
        ("POST", "write", "/api/groups"),
    ],
    "src/app/api/groups/[id]/route.ts": [
        ("PUT", "write", "/api/groups/[id]"),
        ("DELETE", "write", "/api/groups/[id]"),
    ],
    "src/app/api/reports/route.ts": [
        ("GET", "read", "/api/reports"),
        ("POST", "write", "/api/reports"),
    ],
    "src/app/api/reports/[id]/route.ts": [
        ("GET", "read", "/api/reports/[id]"),
        ("PUT", "write", "/api/reports/[id]"),
        ("DELETE", "write", "/api/reports/[id]"),
    ],
    "src/app/api/reports/[id]/workflow-history/route.ts": [
        ("GET", "read", "/api/reports/[id]/workflow-history"),
    ],
    "src/app/api/reports/[id]/assignments/route.ts": [
        ("PUT", "write", "/api/reports/[id]/assignments"),
    ],
    "src/app/api/reports/[id]/due-date/route.ts": [
        ("PATCH", "write", "/api/reports/[id]/due-date"),
    ],
    "src/app/api/reports/[id]/workflow/route.ts": [
        ("POST", "write", "/api/reports/[id]/workflow"),
    ],
    "src/app/api/backups/route.ts": [
        ("POST", "write", "/api/backups"),
    ],
    "src/app/api/backups/[id]/validate/route.ts": [
        ("POST", "write", "/api/backups/[id]/validate"),
    ],
    "src/app/api/backups/[id]/drill/route.ts": [
        ("POST", "write", "/api/backups/[id]/drill"),
    ],
    "src/app/api/backups/upload/route.ts": [
        ("POST", "write", "/api/backups/upload"),
    ],
    "src/app/api/dashboard/summary/route.ts": [
        ("GET", "read", "/api/dashboard/summary"),
    ],
    "src/app/api/dashboard/facets/route.ts": [
        ("GET", "read", "/api/dashboard/facets"),
    ],
    "src/app/api/dashboard/reconciliations/route.ts": [
        ("GET", "read", "/api/dashboard/reconciliations"),
    ],
    "src/app/api/audit/route.ts": [
        ("GET", "read", "/api/audit"),
    ],
    "src/app/api/ai/analyze/route.ts": [
        ("POST", "read", "/api/ai/analyze"),
    ],
    "src/app/api/conversations/route.ts": [
        ("GET", "read", "/api/conversations"),
    ],
    "src/app/api/conversations/[id]/route.ts": [
        ("GET", "read", "/api/conversations/[id]"),
        ("PATCH", "write", "/api/conversations/[id]"),
        ("DELETE", "write", "/api/conversations/[id]"),
    ],
}


def match_braces(src: str, open_idx: int) -> int:
    """من index قوس فتح '{' يعيد index قوس الإغلاق المطابق (TS-aware بمكدس كامل)."""
    depth = 0  # عمق أقواس الكود على المستوى الأعلى
    stack: list[tuple[str, object]] = []  # ("tpl",None) | ("expr",d) | ("str",q) | ("line",None)
    i = open_idx
    n = len(src)
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if not stack:
            # كود أعلى مستوى
            if c == "/" and nxt == "/":
                i += 2
                while i < n and src[i] != "\n":
                    i += 1
                continue
            if c == "/" and nxt == "*":
                i = src.find("*/", i + 2)
                if i < 0:
                    raise ValueError("unterminated comment")
                i += 2
                continue
            if c == '"':
                stack.append(("str", '"'))
                i += 1
                continue
            if c == "'":
                stack.append(("str", "'"))
                i += 1
                continue
            if c == "`":
                stack.append(("tpl", None))
                i += 1
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return i
            i += 1
            continue
        kind, arg = stack[-1]
        if kind == "line":
            if c == "\n":
                stack.pop()
            i += 1
            continue
        if kind == "str":
            if c == "\\":
                i += 2
                continue
            if c == arg:
                stack.pop()
            i += 1
            continue
        if kind == "tpl":
            if c == "\\":
                i += 2
                continue
            if c == "`":
                stack.pop()
                i += 1
                continue
            if c == "$" and nxt == "{":
                stack.append(("expr", 1))
                i += 2
                continue
            i += 1
            continue
        if kind == "expr":
            d = arg
            if c == "/" and nxt == "/":
                # تعليق سطر داخل تعبير
                i += 2
                while i < n and src[i] != "\n":
                    i += 1
                continue
            if c == "/" and nxt == "*":
                i = src.find("*/", i + 2)
                if i < 0:
                    raise ValueError("unterminated comment")
                i += 2
                continue
            if c == '"':
                stack.append(("str", '"'))
                i += 1
                continue
            if c == "'":
                stack.append(("str", "'"))
                i += 1
                continue
            if c == "`":
                stack.append(("tpl", None))
                i += 1
                continue
            if c == "{":
                stack[-1] = ("expr", d + 1)
            elif c == "}":
                if d == 1:
                    stack.pop()
                else:
                    stack[-1] = ("expr", d - 1)
            i += 1
            continue
    raise ValueError("unbalanced")


def find_handler(src: str, method: str, start: int = 0) -> tuple[int, int, int, int]:
    """يعيد (sig_idx, open_brace_idx, close_brace_idx, end_idx) لـ export async function METHOD."""
    m = re.compile(r"export async function " + method + r"\s*\(", re.M).search(src, start)
    if not m:
        raise ValueError(f"handler {method} not found")
    j = m.end() - 1
    depth = 0
    n = len(src)
    stack: list[tuple[str, object]] = []
    while j < n:
        c = src[j]
        nxt = src[j + 1] if j + 1 < n else ""
        if not stack:
            if c == "/" and nxt == "/":
                j += 2
                while j < n and src[j] != "\n":
                    j += 1
                continue
            if c == "/" and nxt == "*":
                j = src.find("*/", j + 2)
                if j < 0:
                    raise ValueError("unterminated comment")
                j += 2
                continue
            if c == '"':
                stack.append(("str", '"'))
                j += 1
                continue
            if c == "'":
                stack.append(("str", "'"))
                j += 1
                continue
            if c == "`":
                stack.append(("tpl", None))
                j += 1
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            elif c == "{" and depth == 0:
                open_idx = j
                close_idx = match_braces(src, j)
                return m.start(), open_idx, close_idx, close_idx + 1
            j += 1
            continue
        kind, arg = stack[-1]
        if kind == "str":
            if c == "\\":
                j += 2
                continue
            if c == arg:
                stack.pop()
            j += 1
            continue
        if kind == "tpl":
            if c == "\\":
                j += 2
                continue
            if c == "`":
                stack.pop()
            j += 1
            continue
    raise ValueError("brace not found")


def json_quote(s: str) -> str:
    return '"' + s + '"'


def add_import(src: str) -> str:
    guard_used = [n for n in ("guardWrite", "guardRead") if n in src]
    if not guard_used or 'from "@/lib/api-guard"' in src:
        return src
    lines = src.split("\n")
    last_import = -1
    in_import = False
    for i, ln in enumerate(lines):
        if ln.startswith("import "):
            in_import = 'from "' not in ln
            last_import = i
        elif in_import and 'from "' in ln:
            in_import = False
            last_import = i
        elif in_import and ln.strip() == "":
            in_import = False
    imp = 'import { ' + ", ".join(guard_used) + ' } from "@/lib/api-guard";'
    lines.insert(last_import + 1, imp)
    return "\n".join(lines)


def process(path: str, targets) -> None:
    src = open(path).read()
    original = src
    if 'guardWrite(' in src or 'guardRead(' in src or 'api-guard' in src:
        print(f"⏭️  {path}: already wrapped — skipped")
        return
    # عالج من الأسفل للأعلى لتبقى المواقع صحيحة
    offset = 0
    jobs = []
    search_from = 0
    for method, kind, route in targets:
        sig, open_idx, close_idx, end_idx = find_handler(src, method, search_from)
        jobs.append((sig, open_idx, close_idx, end_idx, method, kind, route))
        search_from = end_idx
    for sig, open_idx, close_idx, end_idx, method, kind, route in reversed(jobs):
        guard = "guardWrite" if kind == "write" else "guardRead"
        line_start = src.rfind("\n", 0, sig) + 1
        indent = re.match(r"[ \t]*", src[line_start:sig]).group(0)
        inner_indent = indent + "  "
        after_open = open_idx + 1
        body = src[after_open:close_idx]
        shifted = []
        for ln in body.split("\n"):
            if ln.strip() == "":
                shifted.append(ln)
            else:
                shifted.append("  " + ln)
        new_body = "\n" + f"{inner_indent}return {guard}({json_quote(route)}, async () => {{" + "\n".join(shifted) + inner_indent + "});\n"
        src = src[:after_open] + new_body + src[close_idx:]
    src = add_import(src)
    if src != original:
        open(path, "w").write(src)
        print(f"✅ {path}: {len(jobs)} handlers wrapped")
    else:
        print(f"⚠️  {path}: no change")


def main() -> None:
    root = "/home/z/my-project/"
    for path, targets in TARGETS.items():
        process(root + path, targets)


if __name__ == "__main__":
    main()
