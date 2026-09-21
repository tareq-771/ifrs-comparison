# Phase 5B.1 — قالب جدار نافذ Windows (PowerShell) — artifact داخل Git حصرًا.
#
# التنفيذ في 5B.2 فقط. القرارات الملزمة (نص المستخدم §14):
#   • لا قناع شبكة مفترض — -LanSubnet إلزامي بلا افتراضي (مثال: 192.168.1.0/24
#     بعد توثيقه فعليًا من ipconfig /all على المضيف).
#   • يرفض التنفيذ إن بقي أي placeholder أو صيغة غير CIDR.
#   • لا يمس port 80 ولا SSRS ولا قواعد Radmin إطلاقًا.
#   • 3000: التحكم الأساسي ربط loopback (HOSTNAME=127.0.0.1) — block صريح
#     مقترح كدفاع إضافي فقط عبر -BlockAppPort (لا يُنفذ افتراضيًا في 5B.1).

[CmdletBinding()]
param(
    # إلزامي بلا افتراضي — لا اختراع قناع (شرط §14)
    [Parameter(Mandatory = $true)]
    [string]$LanSubnet,

    # دفاع إضافي اختياري — OFF افتراضيًا في هذه المرحلة (الربط loopback هو التحكم)
    [switch]$BlockAppPort,

    # مراجعة جافة: اعرض الأوامر دون تنفيذ
    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

# ── رفض التنفيذ على أي placeholder متبقٍ (شرط §14) ──
$placeholders = @('<production-hostname>', '<LAN_SUBNET>', '<0-or-1>', '<GENERATED', '<remove-after')
foreach ($p in $placeholders) {
    if ($LanSubnet -like "*$p*") {
        Write-Error "REFUSED: -LanSubnet ما زال يحمل placeholder ($p) — وثّق القناع الفعلي أولًا (ipconfig /all)"
        exit 1
    }
}
if ($LanSubnet -notmatch '^(\d{1,3}\.){3}\d{1,3}/\d{1,2}$') {
    Write-Error "REFUSED: -LanSubnet ليس بصيغة CIDR (مثال صحيح: 192.168.1.0/24 من ipconfig /all)"
    exit 1
}

Write-Host "=== IFRS firewall template (5B.1) ==="
Write-Host "LanSubnet    = $LanSubnet"
Write-Host "BlockAppPort = $BlockAppPort"
Write-Host "القواعد المقترحة (لا يمس 80/SSRS/Radmin أبدًا):"
Write-Host " - IFRS-Caddy-443-In   : Allow TCP 443 from $LanSubnet (Profile Any)"
if ($BlockAppPort) {
    Write-Host " - IFRS-App-3000-Block : Block TCP 3000 from Any (defense-in-depth)"
}

if ($WhatIfOnly) {
    Write-Host "`n[WhatIfOnly] لم يُنفَّذ أي تغيير."
    exit 0
}

# ── تنفيذ صريح بالمعاملات — قاعدتان فقط، لا شيء آخر يُلمس ──
if (-not (Get-NetFirewallRule -DisplayName 'IFRS-Caddy-443-In' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'IFRS-Caddy-443-In' `
        -Description 'IFRS: Caddy HTTPS from documented LAN only (5B.2). Does NOT touch port 80 / SSRS / Radmin.' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort 443 `
        -RemoteAddress $LanSubnet -Profile Any -ErrorAction Stop | Out-Null
    Write-Host "created: IFRS-Caddy-443-In"
} else {
    Write-Host "exists:  IFRS-Caddy-443-In (لم يُعد إنشاؤه)"
}

if ($BlockAppPort) {
    if (-not (Get-NetFirewallRule -DisplayName 'IFRS-App-3000-Block' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName 'IFRS-App-3000-Block' `
            -Description 'IFRS: defense-in-depth deny for app port (primary control = loopback bind).' `
            -Direction Inbound -Action Block -Protocol TCP -LocalPort 3000 `
            -RemoteAddress Any -Profile Any -ErrorAction Stop | Out-Null
        Write-Host "created: IFRS-App-3000-Block"
    } else {
        Write-Host "exists:  IFRS-App-3000-Block"
    }
}

Write-Host "`nDONE — تحقق: Get-NetFirewallRule -DisplayName 'IFRS-*' | Format-Table DisplayName,Enabled,Action"
