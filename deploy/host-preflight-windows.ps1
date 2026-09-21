# Phase 5B.1 — Host Preflight (Windows) — قراءة فقط — artifact داخل Git حصرًا.
#
# الغرض: جمع الحقائق الإلزامية قبل 5B.2 (نص المستخدم §14 + تقرير 5B-Windows §U)
# دون أي تغيير على المضيف. لا يعدّل شيئًا — يجمع ويطبع ويقيّم.
# التشغيل: PowerShell (admin غير مطلوب لمعظم الفحوص؛ قارن المخرجات بالتقرير).

$ErrorActionPreference = 'Continue'

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Need($name, $value, $why) {
    Write-Host ("[إلزامي] {0} = {1}" -f $name, $value)
    if ($why) { Write-Host ("          ({0})" -f $why) }
}

Section "OS / Hardware"
$os = Get-CimInstance Win32_OperatingSystem
Write-Host ("OS: {0} — Build {1}" -f $os.Caption, $os.BuildNumber)
Write-Host ("RAM visible: {0:N1} GB" -f ($os.TotalVisibleMemorySize / 1MB))

Section "Network — قناع الشبكة (فحص إلزامي §14)"
Get-NetIPConfiguration | Where-Object { $_.IPv4Address } | ForEach-Object {
    Write-Host ("Interface : {0}" -f $_.InterfaceAlias)
    Write-Host ("  IPv4    : {0}" -f $_.IPv4Address.IPAddress)
    Write-Host ("  Prefix  : {0}" -f $_.IPv4Address.PrefixLength)   # ← القناع الفعلي — يوثّق حرفيًا
    Write-Host ("  Gateway : {0}" -f ($_.IPv4DefaultGateway.NextHop -join ','))
}

Section "Ports (443 / 3000 / 80)"
foreach ($port in 443, 3000, 80) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        $procId = $conn.OwningProcess
        $pname = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "?" }
        Write-Host ("port {0}: LISTENING — pid={1} proc={2}" -f $port, $procId, $pname)
    } else {
        Write-Host ("port {0}: free" -f $port)
    }
}
Write-Host "ملاحظة: 80 = HTTP.sys/SSRS متوقع LISTENING — لا يُمس إطلاقًا."

Section "Node / Git / Bun"
$node = Get-Command node -ErrorAction SilentlyContinue
Write-Host ("node: {0}" -f $(if ($node) { (node --version) } else { "MISSING" }))
$git = Get-Command git -ErrorAction SilentlyContinue
Write-Host ("git:  {0}" -f $(if ($git) { (git --version) } else { "MISSING" }))
$bun = Get-Command bun -ErrorAction SilentlyContinue
Write-Host ("bun (build-time فقط): {0}" -f $(if ($bun) { (bun --version) } else { "MISSING — يثبت في 5B.2 للبناء حصرًا" }))

Section "Disks"
Get-Volume | Where-Object { $_.DriveLetter -in 'C','D' } | ForEach-Object {
    Write-Host ("{0}: NTFS={1} Size={2:N1}GB Free={3:N1}GB" -f $_.DriveLetter, ($_.FileSystem -eq 'NTFS'), ($_.Size/1GB), ($_.SizeRemaining/1GB))
}
Write-Host "شرط: C: حر ≥ 2GB (إصدارات + أدوات) · D: للبيانات والنسخ."

Section "Antivirus / Defender (قرار الاستثناءات 5B.2)"
$av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue
if ($av) { $av | ForEach-Object { Write-Host ("AV: {0}" -f $_.displayName) } } else { Write-Host "AV: غير معروف عبر SecurityCenter2 — وثّق يدويًا" }

Section "Power / Sleep (تشغيل 24/7)"
$ap = Get-NetAdapterPowerManagement -ErrorAction SilentlyContinue | Select-Object -First 3
Write-Host "راجع خطة الطاقة: powercfg /getactivescheme — ممنوع السبات على خادم الإنتاج (يعالج في 5B.2)."

Section "Router capabilities (يؤكد المشغّل يدويًا — لا يكتشف آليًا)"
Need "DHCP reservation لـ192.168.1.103" "نعم/لا" "شرط ثبات الاسم (§H)"
Need "DNS static entry للـhostname" "نعم/لا" "شرط https://<production-hostname>"

Write-Host "`n=== انتهى preflight المضيف (قراءة فقط — لا تغييرات) ==="
