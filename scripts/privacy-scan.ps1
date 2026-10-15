# ============================================================
#  Pre-publish privacy scan (ASCII only -- PS 5.1 reads .ps1 as ANSI
#  when there is no BOM, so no non-ASCII characters in this file).
#
#  Scans EVERY commit in the history, every file.
#
#  Usage:
#    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/privacy-scan.ps1
#
#  Add your own values to the list below before you publish. It is a template:
#  the defaults cover generic leaks (home paths, Windows user paths), and a
#  couple of placeholder entries show the shape of a project-specific rule.
# ============================================================
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

# Each entry: label = what it is, and the literal to search for.
#
# ⚠️ READ THIS BEFORE ADDING A SECRET
#    This file is itself published. To search for a secret you must name it,
#    which would place the secret in the repository -- the exact opposite of
#    what this script is for.
#
#    So:
#      · an IDENTIFIER (mailbox address, OS username, machine name) is fine to
#        store here, even abbreviated -- a prefix is plenty to catch a paste;
#      · a CREDENTIAL (auth code, API token, password) must NEVER appear here in
#        full. Use a distinctive PREFIX only. It still catches an accidental
#        paste of the real value, but the value itself cannot be recovered from
#        this file.
#
#    The real values live in config.json, which is never committed.
$targets = @(
  # --- generic, safe to ship ---
  @{ label = 'windows-path';   ascii = 'C:\Users';  hex = @() },
  @{ label = 'home-path';      ascii = '/home/';    hex = @() },
  #
  # NOTE: "AppData" is deliberately NOT scanned for. It is the standard Windows
  # location for npm global packages (%APPDATA%\npm\node_modules), so any code
  # that finds globally-installed tools contains it legitimately. Scanning for it
  # produced a false positive on the first audit here -- see docs/LESSONS.md.

  # --- project-specific: REPLACE THESE WITH YOUR OWN ---
  # ascii for plain text; hex for non-ASCII (keeps this file ASCII-only).
  #   @{ label = 'my-mailbox-prefix';  ascii = '12345678';    hex = @() },
  #   @{ label = 'my-token-prefix';    ascii = 'abcd1234';    hex = @() },   # prefix only!
  #   @{ label = 'my-machine-name';    ascii = '';            hex = @(0x4E03,0x6208) },
  @{ label = 'placeholder';         ascii = 'ZZZ-NOT-A-REAL-PATTERN-ZZZ';  hex = @() }
)

# ------------------------------------------------------------
#  私有模式（仓库外面）
#
#  这个脚本是要公开发布的，所以不能把「我自己的邮箱 / 代号 / 本地路径」
#  写进来。但只留通用模式又等于放弃了对本人信息的检测。
#
#  解法：从仓库**外面**读一个可选的模式文件。文件不在仓库里，就永远不会被提交；
#  别人 clone 走这份脚本，读不到那个文件，就只用通用模式 —— 两边都对。
#
#  文件格式（每行一条，# 开头是注释）：
#     我的邮箱前缀
#     我的助手代号
#     D:\我的工作目录
#
#  位置按脚本自身推算（仓库的上一级目录），不写死绝对路径 ——
#  写死了别人 clone 走之后那行路径不存在，脚本直接报错。
#  也可以用环境变量 DSH_MAIL_BRIDGE_PRIVATE_PATTERNS 指定别处。
# ------------------------------------------------------------
$PRIVATE_PATTERNS = $env:DSH_MAIL_BRIDGE_PRIVATE_PATTERNS
if (-not $PRIVATE_PATTERNS) {
  $PRIVATE_PATTERNS = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'privacy-patterns.txt'
}
if (Test-Path -LiteralPath $PRIVATE_PATTERNS) {
  $n = 0
  foreach ($line in (Get-Content -LiteralPath $PRIVATE_PATTERNS -Encoding UTF8)) {
    $v = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($v)) { continue }
    if ($v.StartsWith('#')) { continue }
    $n++
    $targets += @{ label = ('private-' + $n); ascii = $v; hex = @() }
  }
  Write-Host ("  已载入 $n 条私有模式（来自 " + $PRIVATE_PATTERNS + "）") -ForegroundColor DarkGray
} else {
  Write-Host '  没有私有模式文件，只跑通用模式' -ForegroundColor DarkGray
}

# This script is excluded from its own scan: it necessarily CONTAINS the very
# patterns it searches for. That is a genuine self-reference, not a loophole --
# hence an explicit pathspec exclusion rather than obfuscating the pattern list.
$EXCLUDE = ':!scripts/privacy-scan.ps1'

$fail = 0
Write-Host '=============================================='
Write-Host '  Pre-publish privacy scan'
Write-Host '=============================================='

function To-Text($t) {
  if ($t.ascii) { return $t.ascii }
  return (-join ($t.hex | ForEach-Object { [char]$_ }))
}

$commits = @(& git rev-list --all)
Write-Host ''
Write-Host "--- commits in history: $($commits.Count) ---"
foreach ($c in $commits) {
  Write-Host ("  " + (& git log -1 --format='%h %s' $c))
}

Write-Host ''
Write-Host '--- scanning every commit for every pattern ---'
foreach ($t in $targets) {
  $needle = To-Text $t
  $hits = @()
  foreach ($c in $commits) {
    $r = & git grep -n -I -F -- $needle $c -- . $EXCLUDE 2>$null
    if ($LASTEXITCODE -eq 0 -and $r) {
      $short = & git log -1 --format='%h' $c
      foreach ($line in $r) { $hits += "[$short] $line" }
    }
  }
  if ($hits.Count -gt 0) {
    Write-Host ("  FAIL  found: " + $t.label) -ForegroundColor Red
    $hits | Select-Object -First 15 | ForEach-Object { Write-Host "        $_" }
    $fail++
  } else {
    Write-Host ("  OK    absent: " + $t.label) -ForegroundColor Green
  }
}

Write-Host ''
Write-Host '--- commit authorship ---'
& git log --format='  %h | author=%an <%ae> | committer=%cn <%ce>' | Sort-Object -Unique

Write-Host ''
Write-Host '--- remotes configured? ---'
$remote = & git remote -v
if ($remote) { $remote | ForEach-Object { Write-Host "  $_" } } else { Write-Host '  none (nothing has been pushed)' }

Write-Host ''
Write-Host '--- branches / tags ---'
& git branch -a | ForEach-Object { Write-Host "  $_" }
$tags = & git tag
if ($tags) { $tags | ForEach-Object { Write-Host "  tag: $_" } } else { Write-Host '  no tags' }

Write-Host ''
Write-Host '--- working tree ---'
$st = & git status --short
if ($st) { $st | ForEach-Object { Write-Host "  $_" } } else { Write-Host '  clean' }

Write-Host ''
Write-Host '=============================================='
if ($fail -eq 0) {
  Write-Host '  RESULT: CLEAN -- no private data in any commit' -ForegroundColor Green
} else {
  Write-Host "  RESULT: $fail pattern group(s) found -- see FAIL lines above" -ForegroundColor Red
}
Write-Host '=============================================='
exit $fail
