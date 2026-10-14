<#
  dsh-download 设置向导

  给不想手改 JSON 的人用。全程菜单操作,不改动 dsh 的界面,也不影响运行时。
  本文件是 UTF-8;配套的 settings.cmd 会强制按 UTF-8 读取,避免中文变乱码。
#>

$ErrorActionPreference = 'Stop'

if ($env:DSH_HOME) { $dshHome = $env:DSH_HOME } else { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$settingsPath = Join-Path $dshHome 'dsh-download.settings.json'
$defaultThreshold = 1073741824

function Read-Settings {
  if (-not (Test-Path $settingsPath)) { return [ordered]@{} }
  try {
    $raw = Get-Content $settingsPath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return [ordered]@{} }
    $obj = $raw | ConvertFrom-Json
    $map = [ordered]@{}
    foreach ($p in $obj.PSObject.Properties) { $map[$p.Name] = $p.Value }
    return $map
  } catch {
    Write-Host ""
    Write-Host "  警告: 现有设置文件无法解析,将按默认值处理。" -ForegroundColor Yellow
    Write-Host "  文件: $settingsPath" -ForegroundColor DarkGray
    Write-Host ""
    return [ordered]@{}
  }
}

function Write-Settings($map) {
  $dir = Split-Path -Parent $settingsPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  # Write as UTF-8 WITHOUT a BOM. `Set-Content -Encoding UTF8` on PowerShell 5.1 emits a
  # BOM, and the plugin's JSON.parse rejected it — so the wizard used to write a settings
  # file that the plugin could not read at all. UTF8Encoding($false) omits the BOM.
  $json = $map | ConvertTo-Json -Depth 6
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($settingsPath, $json, $utf8NoBom)

  Write-Host ""
  Write-Host "  已保存: $settingsPath" -ForegroundColor Green
}

function Get-Val($map, $key, $fallback) {
  if ($map.Contains($key) -and $null -ne $map[$key] -and "$($map[$key])" -ne '') { return $map[$key] }
  return $fallback
}

function Format-Size($bytes) {
  if ($null -eq $bytes) { return '自动探测' }
  $b = [double]$bytes
  if ($b -le 1) { return "全部走分段下载 (>= $b 字节)" }
  if ($b -ge 1TB) { return "$([math]::Round($b/1TB,2)) TB" }
  if ($b -ge 1GB) { return "$([math]::Round($b/1GB,2)) GB" }
  if ($b -ge 1MB) { return "$([math]::Round($b/1MB,2)) MB" }
  return "$b 字节"
}

function Format-Monitor($mode) {
  if ($mode -eq 'none') { return '不等待 — 交给 NDM 后立即返回' }
  return '等待完成并返回结果 (默认)'
}

function Format-Engine($engine) {
  if ($engine -eq 'ndm') { return 'Neat Download Manager（有进度窗口，需要装软件）' }
  return '内置引擎（无需安装、国内镜像可直连，推荐）'
}

function Show-Current($map) {
  $threshold = Get-Val $map 'thresholdBytes' $defaultThreshold
  $monitor = Get-Val $map 'monitor' 'block'
  $poll = Get-Val $map 'pollIntervalMs' 1500
  $connections = Get-Val $map 'builtinConnections' 16
  $panelPoll = Get-Val $map 'uiPollIntervalMs' 1000
  $panelText = if ($panelPoll -ge 1000) { "$([math]::Round($panelPoll / 1000, 1)) 秒" } else { "$panelPoll 毫秒" }
  $ndm = Get-Val $map 'ndmPath' $null
  $dir = Get-Val $map 'downloadDir' $null
  $defaultDir = Join-Path $env:USERPROFILE 'Downloads'
  $dirText = if ($dir) { $dir } else { "$defaultDir (默认)" }
  $ndmText = if ($ndm) { $ndm } else { '自动探测' }

  Write-Host ""
  Write-Host "  当前设置" -ForegroundColor Cyan
  Write-Host "  ────────────────────────────────────────────────────────"
  Write-Host "  下载引擎               : $(Format-Engine (Get-Val $map 'engine' 'builtin'))"
  Write-Host "  多大的文件才走分段下载 : $(Format-Size $threshold)"
  Write-Host "  下载时是否等待         : $(Format-Monitor $monitor)"
  Write-Host "  监视间隔               : $poll 毫秒"
  Write-Host "  内置引擎并行连接数     : $connections"
  Write-Host "  下载面板刷新间隔       : $panelText"
  Write-Host "  NeatDM.exe 路径        : $ndmText"
  Write-Host "  完成文件保存目录       : $dirText"
  Write-Host "  ────────────────────────────────────────────────────────"
  Write-Host "  设置文件: $settingsPath" -ForegroundColor DarkGray
  Write-Host ""
}

function Ask-Choice($prompt, $valid) {
  while ($true) {
    $answer = Read-Host $prompt
    if ($valid -contains $answer) { return $answer }
    Write-Host "  请输入 $($valid -join ' / ')" -ForegroundColor Yellow
  }
}

# ---------------------------------------------------------------- 具体修改动作

function Edit-Threshold($map) {
  Write-Host ""
  Write-Host "  多大的文件才该走 Neat Download Manager 的分段下载?" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "    1) 100 MB      (小文件也走,分段收益有限)"
  Write-Host "    2) 500 MB"
  Write-Host "    3) 1 GB        (默认,推荐)"
  Write-Host "    4) 2 GB"
  Write-Host "    5) 4 GB"
  Write-Host "    6) 10 GB"
  Write-Host "    7) 自定义(自己输入大小)"
  Write-Host "    8) 所有下载都走分段下载"
  Write-Host "    9) 完全不用 NDM — 全部直连"
  Write-Host "    0) 返回"
  Write-Host ""

  $choice = Ask-Choice "  请选择" @('1','2','3','4','5','6','7','8','9','0')
  switch ($choice) {
    '1' { $map['thresholdBytes'] = 104857600 }
    '2' { $map['thresholdBytes'] = 524288000 }
    '3' { $map['thresholdBytes'] = 1073741824 }
    '4' { $map['thresholdBytes'] = 2147483648 }
    '5' { $map['thresholdBytes'] = 4294967296 }
    '6' { $map['thresholdBytes'] = 10737418240 }
    '7' {
      Write-Host ""
      Write-Host "  输入大小,可以用 MB 或 GB,例如  1.5GB  或  800MB" -ForegroundColor DarkGray
      while ($true) {
        $text = Read-Host "  大小"
        if ($text -match '^\s*([0-9]+(?:\.[0-9]+)?)\s*(GB|MB|G|M|B)?\s*$') {
          $value = [double]$Matches[1]
          $unit = $Matches[2]
          switch -Regex ($unit) {
            '^(GB|G)$' { $value = $value * 1GB }
            '^(MB|M)$' { $value = $value * 1MB }
            default { }
          }
          if ($value -ge 1) { $map['thresholdBytes'] = [long][math]::Round($value); break }
        }
        Write-Host "  看不懂这个大小,再试一次(例如 1.5GB)" -ForegroundColor Yellow
      }
    }
    '8' { $map['thresholdBytes'] = 1 }
    '9' { $map['thresholdBytes'] = 1099511627776 }
    '0' { return }
  }
  Write-Host ""
  Write-Host "  已改为: $(Format-Size $map['thresholdBytes'])" -ForegroundColor Green
}

function Edit-Monitor($map) {
  Write-Host ""
  Write-Host "  下载时,要不要等它下完?" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "    1) 等待完成,并把结果告诉你 (默认)"
  Write-Host "       下载结束后返回一行结果,期间不占用对话额度"
  Write-Host "    2) 不等待,交给 NDM 就立刻返回"
  Write-Host "       适合你自己在 NDM 窗口里看着下;代价是不知道最终成功与否"
  Write-Host "    0) 返回"
  Write-Host ""

  $choice = Ask-Choice "  请选择" @('1','2','0')
  if ($choice -eq '0') { return }
  if ($choice -eq '1') { $map['monitor'] = 'block' } else { $map['monitor'] = 'none' }
  Write-Host ""
  Write-Host "  已改为: $(Format-Monitor $map['monitor'])" -ForegroundColor Green
}

function Edit-Poll($map) {
  Write-Host ""
  Write-Host "  监视间隔 — 多久看一下下载进度(越小越灵敏,越费性能)" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "    1) 1000 毫秒 (1 秒)"
  Write-Host "    2) 1500 毫秒 (默认)"
  Write-Host "    3) 3000 毫秒 (3 秒)"
  Write-Host "    4) 5000 毫秒 (5 秒)"
  Write-Host "    5) 自定义"
  Write-Host "    0) 返回"
  Write-Host ""

  $choice = Ask-Choice "  请选择" @('1','2','3','4','5','0')
  switch ($choice) {
    '1' { $map['pollIntervalMs'] = 1000 }
    '2' { $map['pollIntervalMs'] = 1500 }
    '3' { $map['pollIntervalMs'] = 3000 }
    '4' { $map['pollIntervalMs'] = 5000 }
    '5' {
      while ($true) {
        $text = Read-Host "  毫秒数(100 - 60000)"
        $value = 0
        if ([int]::TryParse($text, [ref]$value) -and $value -ge 100 -and $value -le 60000) {
          $map['pollIntervalMs'] = $value
          break
        }
        Write-Host "  请输入 100 到 60000 之间的整数" -ForegroundColor Yellow
      }
    }
    '0' { return }
  }
  Write-Host ""
  Write-Host "  已改为: $($map['pollIntervalMs']) 毫秒" -ForegroundColor Green
}

function Edit-NdmPath($map) {
  Write-Host ""
  Write-Host "  NeatDM.exe 的完整路径" -ForegroundColor Cyan
  Write-Host "  留空 = 自动探测(推荐)。除非自动探测失败,否则不用改。" -ForegroundColor DarkGray
  Write-Host ""
  $text = Read-Host "  路径(直接回车保持自动探测)"
  if ([string]::IsNullOrWhiteSpace($text)) {
    $map.Remove('ndmPath')
    Write-Host ""
    Write-Host "  已改为: 自动探测" -ForegroundColor Green
  } else {
    $map['ndmPath'] = $text.Trim().Trim('"')
    Write-Host ""
    Write-Host "  已改为: $($map['ndmPath'])" -ForegroundColor Green
  }
}

function Edit-DownloadDir($map) {
  Write-Host ""
  Write-Host "  下载好的文件保存到哪个目录?" -ForegroundColor Cyan
  Write-Host "  留空 = 用 Neat Download Manager 自己的设置。" -ForegroundColor DarkGray
  Write-Host ""
  $text = Read-Host "  目录(直接回车保持默认)"
  if ([string]::IsNullOrWhiteSpace($text)) {
    $map.Remove('downloadDir')
    Write-Host ""
    Write-Host "  已改为: 默认(用户 Downloads 目录)" -ForegroundColor Green
  } else {
    $map['downloadDir'] = $text.Trim().Trim('"')
    Write-Host ""
    Write-Host "  已改为: $($map['downloadDir'])" -ForegroundColor Green
  }
}

function Edit-Engine($map) {
  Write-Host ""
  Write-Host "  用哪个下载引擎?" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "    1) 内置引擎 (默认,推荐)" -ForegroundColor Green
  Write-Host "       本插件自带,不用装任何软件;自己决定 UA,所以国内镜像"
  Write-Host "       (清华/中科大/上交等)都能直连;文件直接写到目标位置。"
  Write-Host "       实测 4.44GB 用 4 线程 75 秒(约 63MB/s)。"
  Write-Host "       风险: 是新代码,面对奇葩服务器的经验不如 NDM。"
  Write-Host ""
  Write-Host "    2) Neat Download Manager"
  Write-Host "       久经考验,而且有进度窗口可以看着下。"
  Write-Host "       代价: 需要安装该软件;它总是先下到自己的目录再搬运;"
  Write-Host "       它的 UA 会被部分国内镜像拒绝(403 或假网页)。"
  Write-Host ""
  Write-Host "    0) 返回"
  Write-Host ""

  $choice = Ask-Choice "  请选择" @('1','2','0')
  if ($choice -eq '0') { return }
  if ($choice -eq '1') { $map['engine'] = 'builtin' } else { $map['engine'] = 'ndm' }
  Write-Host ""
  Write-Host "  已改为: $(Format-Engine $map['engine'])" -ForegroundColor Green
}

function Reset-Settings($map) {
  Write-Host ""
  $answer = Read-Host "  确定恢复默认设置吗? 输入 y 确认"
  if ($answer -ne 'y') { Write-Host "  已取消"; return }
  # Every key the wizard can set, and every key the plugin reads. `engine` and
  # `builtinConnections` were missing from this list, so "恢复默认" used to leave a machine
  # pinned to Neat Download Manager — the one setting a person is most likely to want back.
  foreach ($key in @('engine','thresholdBytes','builtinConnections','monitor','pollIntervalMs','stallTimeoutMs','taskAppearTimeoutMs','settleMs','uiPollIntervalMs','ndmPath','downloadDir','taskRoot')) {
    $map.Remove($key)
  }
  Write-Host ""
  Write-Host "  已恢复默认(删掉的键会在下一次下载时回落到内置默认值)" -ForegroundColor Green
}

# ---------------------------------------------------------------------- 主循环

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║        dsh-download  设置向导                    ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan

if (-not (Test-Path $settingsPath)) {
  Write-Host ""
  Write-Host "  还没找到设置文件:" -ForegroundColor Yellow
  Write-Host "    $settingsPath" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  它会在插件第一次加载时自动生成 —— 也就是安装后第一次启动 dsh 的时候。"
  Write-Host "  先启动一次 dsh,再回来运行本向导。"
  Write-Host ""
  Read-Host "  按回车退出"
  exit 1
}

$settings = Read-Settings

while ($true) {
  Show-Current $settings
  Write-Host "  请选择:" -ForegroundColor Cyan
  Write-Host "    1) 修改「多大的文件才走分段下载」"
  Write-Host "    2) 修改「下载时是否等待完成」"
  Write-Host "    3) 修改「监视间隔」"
  Write-Host "    4) 修改 NeatDM.exe 路径"
  Write-Host "    5) 修改 完成文件保存目录"
  Write-Host "    6) 查看设置文件原文"
  Write-Host "    7) 恢复默认设置"
  Write-Host "    8) 切换下载引擎（内置 / Neat Download Manager）"
  Write-Host "    0) 退出"
  Write-Host ""

  $choice = Ask-Choice "  请选择" @('1','2','3','4','5','6','7','8','0')

  switch ($choice) {
    '1' { Edit-Threshold $settings; Write-Settings $settings }
    '2' { Edit-Monitor $settings;   Write-Settings $settings }
    '3' { Edit-Poll $settings;      Write-Settings $settings }
    '4' { Edit-NdmPath $settings;   Write-Settings $settings }
    '5' { Edit-DownloadDir $settings; Write-Settings $settings }
    '6' {
      Write-Host ""
      Get-Content $settingsPath -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
      Write-Host ""
      Read-Host "  按回车继续"
    }
    '7' { Reset-Settings $settings; Write-Settings $settings }
    '8' { Edit-Engine $settings;    Write-Settings $settings }
    '0' {
      Write-Host ""
      Write-Host "  改完的设置会在**下一次下载时立即生效**,不需要重启 dsh。" -ForegroundColor Green
      Write-Host ""
      exit 0
    }
  }
}
