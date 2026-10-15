# ============================================================
#  邮箱助手 · 介绍视频生成器
#
#  无背景音乐、无配音；字幕直接烧进画面。
#  画帧用 System.Drawing，原始像素通过 stdin 直通 ffmpeg，
#  同时产出 GIF（适合放 README）和 MP4（适合发出去）。
#
#  用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-video.ps1
#
#  ⚠️ 本文件必须存为 UTF-8 with BOM —— PowerShell 5.1 只认这种编码的中文。
# ============================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# ---------------- 配置 ----------------
# 找 ffmpeg，按可靠性排序。这个顺序是有讲究的，别随便改：
#
#   1) 先看 PATH —— 最正常的位置，别人 clone 走一般就是这里；
#   2) 再看 winget 的用户级安装目录 —— winget 装完会改 PATH，但【已经开着
#      的终端不会更新】，所以刚装完的那个 shell 里 Get-Command 找不到。
#      这一步专治这种情况（本机真的踩到了）；
#   3) 都没有就报错退出，不猜、不退回残缺版本。
#      本机 SOLIDWORKS 自带一个没有 libx264、连 PNG 编解码都没有的最小构建，
#      误用它画质会悄悄变差而没有任何提示 —— 宁可报错。
function Find-Ffmpeg {
  # 1) PATH
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }

  # 2) winget 用户级安装目录
  $root = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path -LiteralPath $root) {
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue |
           Sort-Object FullName -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }

  # 3) winget 的链接目录（有时 PATH 没生效，但链接已经建好了）
  $link = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'
  if (Test-Path -LiteralPath $link) { return $link }

  throw '找不到 ffmpeg。请装一个完整构建（需要 libx264）：' + "`n" +
        '    winget install --id Gyan.FFmpeg --exact --scope user' + "`n" +
        '装完【重开一个终端】再跑本脚本。'
}

$FFMPEG = Find-Ffmpeg

$W      = 1280
$H      = 720
$FPS    = 60          # 视频帧率
$GIF_FPS = 30         # GIF 单独降帧：GIF 每帧都存全画幅，60fps 会让体积翻倍
$CRF    = 21          # x264 质量：数字越小越清晰、体积越大
                      #   18 ≈ 视觉无损（对这种大面积渐变的画面太奢侈，会到 20 MB）
                      #   21 在 720p 文字动画上肉眼无差，体积只有零头

# 输出目录按脚本自身位置推算，不写死绝对路径 ——
# 写死了别人 clone 走之后那行路径不存在，脚本直接跑不起来。
$REPO   = Split-Path -Parent $PSScriptRoot
$OUTDIR = Join-Path $REPO 'docs\media'
$GIF    = Join-Path $OUTDIR 'demo.gif'
$MP4    = Join-Path $OUTDIR 'demo.mp4'

if (-not (Test-Path $FFMPEG)) { throw "找不到 ffmpeg: $FFMPEG" }
if (-not (Test-Path $OUTDIR)) { New-Item -ItemType Directory -Path $OUTDIR -Force | Out-Null }

# 这个 ffmpeg 有没有 libx264？有就用它，没有只能退回老的 mpeg4。
#
# ⚠️ 检测方式踩过两个坑，别改回去：
#   1) 不能用 `Select-String '\slibx264\s'` —— 它会同时匹配到 libx264rgb，
#      看着像"有"，其实是另一个编码器。必须精确比对名字。
#   2) `Get-Command ffmpeg` 在新起的子进程里可能解析到 PATH 上另一个残缺
#      的 ffmpeg（这台机器上 SOLIDWORKS 自带一个），所以要把选中的路径打出来核实。
function Test-HasEncoder {
  param([string]$FfmpegPath, [string]$Name)
  # 编码器列表每行形如：" V....D libx264   libx264 H.264 ..."
  foreach ($line in (& $FfmpegPath -hide_banner -encoders 2>&1)) {
    $s = "$line"
    if (-not $s.StartsWith(' V')) { continue }
    $fields = $s.Trim() -split '\s+'
    if ($fields.Count -ge 2 -and $fields[1] -eq $Name) { return $true }
  }
  return $false
}

$HAS_X264 = Test-HasEncoder -FfmpegPath $FFMPEG -Name 'libx264'
Write-Host ("  ffmpeg : " + $FFMPEG) -ForegroundColor DarkGray
Write-Host ("  编码器 : " + $(if ($HAS_X264) { 'libx264 (H.264)  OK' } else { 'mpeg4 (老标准，压缩效率约为 H.264 的 1/3)' })) -ForegroundColor DarkGray

# ---------------- 配色 ----------------
$C = @{
  bg      = [System.Drawing.Color]::FromArgb(15, 18, 26)
  panel   = [System.Drawing.Color]::FromArgb(24, 28, 40)
  line    = [System.Drawing.Color]::FromArgb(45, 52, 70)
  fg      = [System.Drawing.Color]::FromArgb(235, 240, 250)
  dim     = [System.Drawing.Color]::FromArgb(140, 150, 170)
  accent  = [System.Drawing.Color]::FromArgb(88, 166, 255)
  green   = [System.Drawing.Color]::FromArgb(63, 185, 80)
  amber   = [System.Drawing.Color]::FromArgb(210, 153, 34)
  red     = [System.Drawing.Color]::FromArgb(248, 81, 73)
  purple  = [System.Drawing.Color]::FromArgb(163, 113, 247)
}

# ---------------- 绘图小工具 ----------------
function New-Frame {
  $bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear($C.bg)
  return @{ bmp = $bmp; g = $g }
}

# ---------------- 缓动 ----------------
#
# 缓动函数决定动画"手感"，这里换过一次，改动原因值得记下来：
#
#   原来用 Ease-Out（先快后慢，1-(1-t)^3）：文字一上来冲得很快，然后急刹车。
#   单个元素看还行，但 8 个场景、每场好几行文字都这么来一次，
#   观感就是"一顿一顿的" —— 主人反馈"文字出现能不能圆滑一点"，就是指这个。
#
#   现在用 Smoothstep（3t²-2t³）：两头都慢、中间快，
#   起手和收尾的速度都趋近于 0，所以起步和停住都没有突变。
#   这是动画里做"圆滑"最常用的曲线。
function Ease-Smooth($t) {
  if ($t -le 0) { return 0.0 }
  if ($t -ge 1) { return 1.0 }
  return $t * $t * (3 - 2 * $t)
}

# 保留旧名字做别名，脚本里其它地方还在用
function Ease-Out($t) { return Ease-Smooth $t }

function Alpha($color, $a) {
  $v = [int]([Math]::Max(0, [Math]::Min(255, $a)))
  return [System.Drawing.Color]::FromArgb($v, $color.R, $color.G, $color.B)
}

# 淡入绘制：progress 0..1
#
# ⚠️ 这里改过两次，历史原因都记下来，别再走回头路：
#
#   第一版：透明度下限 0.35、位移 12px。
#          设下限是为了避免"每场第一帧整屏空白"（那看起来像卡了一下），
#          但副作用是 **t=0 时文字已经以 35% 可见、位移也已经跳了 12px**
#          —— 于是观感是"啪"地一下冒出来，后面的渐变只是在收尾。
#          主人反馈"可不可以平滑地出现而不是一下子就出来了"，说的就是这个。
#
#   第二版（当前）：透明度从 0 起步、位移按元素大小分档、缓动用 smoothstep。
#          真正的"从无到有"。之所以不再需要那个 35% 下限，是因为
#          位移让文字从下方浮上来 —— t=0 时完全透明且整体偏下，
#          画面确实是空的，但那是"还没浮上来"，不是"卡住了"。
#
#          位移量必须按元素大小分档：一开始统一用 14px，
#          结果大标题（54px 字、行距只有 110px）向上浮 14px 时会撞到下面那行，
#          早期帧全叠在一起，看起来像什么都没出现。
#          所以大元素用大位移、小元素用小位移，谁都不会越界。
[double]$RISE_SM = 6     # 小字、说明行
[double]$RISE_MD = 9     # 正文
[double]$RISE_LG = 14    # 大标题（字号大，行距也大，浮得起）

function Draw-TextFade {
  param($g, [string]$text, $font, $color, [single]$x, [single]$y, [single]$progress,
        [single]$rise = -1)
  $p = Ease-Smooth $progress
  if ($p -le 0.001) { return }          # 完全透明就别画，省点开销
  if ($rise -lt 0) {
    # 没显式指定就按字号自动分档
    if ($font.Size -ge 34) { $rise = $RISE_LG }
    elseif ($font.Size -ge 20) { $rise = $RISE_MD }
    else { $rise = $RISE_SM }
  }
  # ⚠️ 透明度用**独立且快得多**的曲线，不和位移共用 $p。
  #
  #   为什么：早先两者共用 smoothstep 的 $p，于是透明度爬到 17% 时位移才走了
  #   一小段 —— 而深色背景上的白字低于约 35% 根本看不见，观感就成了
  #   "先黑 0.7 秒、再突然出现"（实测证实：0.6s 时画面和纯空屏毫无区别）。
  #   主人说"一下子就出来了"，根因在这里，不在缓动曲线上。
  #
  #   现在：透明度在渐入窗口的前 40% 内冲到满（ease-out，起手快、尾部柔和），
  #         位移继续走完整条 smoothstep（慢起慢收）。
  #   于是"看得见"和"在移动"始终同时发生，没有任何一段是白等的。
  $oa = [Math]::Min(1, $progress / 0.40)
  $oa = 1 - [Math]::Pow(1 - $oa, 2)
  $brush = New-Object System.Drawing.SolidBrush (Alpha $color ([int](255 * $oa)))
  $g.DrawString($text, $font, $brush, $x, ($y + (1 - $p) * $rise))
  $brush.Dispose()
}

# 在某个 y 位置画一行「标签 + 说明」，说明的位置按标签实际宽度算 ——
# 固定偏移会在标签较长时把说明压住（第一版「引用与签名清洗」就压住了）。
function Draw-LabelRow {
  param($g, $fontLabel, $fontDesc, $colLabel, [string]$label, [string]$desc,
        [single]$x, [single]$y, [single]$progress, [single]$gap = 26)
  $p = Ease-Smooth $progress
  if ($p -le 0.001) { return }
  # 透明度同样用快速曲线（理由见 Draw-TextFade 的注释）
  $oa = [Math]::Min(1, $progress / 0.40)
  $oa = 1 - [Math]::Pow(1 - $oa, 2)
  $dy = (1 - $p) * $RISE_MD
  $g.DrawString($label, $fontLabel, (New-Object System.Drawing.SolidBrush (Alpha $colLabel ([int](255 * $oa)))), $x, ($y + $dy))
  $lw = $g.MeasureString($label, $fontLabel).Width
  $g.DrawString($desc, $fontDesc, (New-Object System.Drawing.SolidBrush (Alpha $C.dim ([int](255 * $oa)))), ($x + $lw + $gap), ($y + 6 + $dy))
}

function Draw-Line {
  param($g, [int]$x1, [int]$y1, [int]$x2, [int]$y2, $color, [single]$alpha = 1.0)
  $pen = New-Object System.Drawing.Pen (Alpha $color ([int](255 * $alpha))), 2
  $g.DrawLine($pen, $x1, $y1, $x2, $y2)
  $pen.Dispose()
}

function Draw-RoundRect {
  param($g, [int]$x, [int]$y, [int]$w, [int]$h, $fill, $stroke, [single]$alpha = 1.0)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 10
  $path.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
  $path.AddArc($x + $w - $r * 2, $y, $r * 2, $r * 2, 270, 90)
  $path.AddArc($x + $w - $r * 2, $y + $h - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc($x, $y + $h - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $b = New-Object System.Drawing.SolidBrush (Alpha $fill ([int](255 * $alpha)))
  $g.FillPath($b, $path)
  $b.Dispose()
  if ($stroke) {
    $p = New-Object System.Drawing.Pen (Alpha $stroke ([int](255 * $alpha))), 2
    $g.DrawPath($p, $path)
    $p.Dispose()
  }
  $path.Dispose()
}

function Draw-FullRect {
  param($g, [int]$x, [int]$y, [int]$w, [int]$h, $color, [single]$alpha = 1.0)
  $b = New-Object System.Drawing.SolidBrush (Alpha $color ([int](255 * $alpha)))
  $g.FillRectangle($b, $x, $y, $w, $h)
  $b.Dispose()
}

# ---------------- 字幕条 ----------------
function Draw-Subtitle {
  param($g, [string]$text, $fontSub, $fontSubEn)
  if ([string]::IsNullOrEmpty($text)) { return }
  # 底部半透明黑条
  Draw-FullRect $g 0 ($H - 104) $W 104 ([System.Drawing.Color]::Black) 0.55
  Draw-Line $g 0 ($H - 104) $W ($H - 104) $C.line 0.8
  # 居中
  $size = $g.MeasureString($text, $fontSub)
  if ($size.Width -gt ($W - 120)) {
    # 太长就换用小一号
    $size = $g.MeasureString($text, $fontSubEn)
    $g.DrawString($text, $fontSubEn, (New-Object System.Drawing.SolidBrush $C.fg), ($W - $size.Width) / 2, ($H - 104 + (104 - $size.Height) / 2))
  } else {
    $g.DrawString($text, $fontSub, (New-Object System.Drawing.SolidBrush $C.fg), ($W - $size.Width) / 2, ($H - 104 + (104 - $size.Height) / 2))
  }
}

# ---------------- 字体 ----------------
$F = @{
  hero   = New-Object System.Drawing.Font('Microsoft YaHei', 54, [System.Drawing.FontStyle]::Bold)
  h1     = New-Object System.Drawing.Font('Microsoft YaHei', 38, [System.Drawing.FontStyle]::Bold)
  h2     = New-Object System.Drawing.Font('Microsoft YaHei', 27, [System.Drawing.FontStyle]::Bold)
  body   = New-Object System.Drawing.Font('Microsoft YaHei', 21)
  small  = New-Object System.Drawing.Font('Microsoft YaHei', 17)
  tiny   = New-Object System.Drawing.Font('Microsoft YaHei', 14)
  mono   = New-Object System.Drawing.Font('Consolas', 18)
  monoSm = New-Object System.Drawing.Font('Consolas', 15)
  sub    = New-Object System.Drawing.Font('Microsoft YaHei', 25)
  subSm  = New-Object System.Drawing.Font('Microsoft YaHei', 20)
}

# ============================================================
#  场景定义：{ 时长秒, 字幕, 绘制脚本块 }
#  绘制块参数： $g 图形, $p 本场景进度 0..1, $t 全局已播秒数
# ============================================================

# 渐入时长（占场景总时长的比例）。这个参数调过好几轮，把结论记下来：
#
#   0.30~0.35 + Ease-Out          → 太快，一上来就冲出去，观感"一顿一顿"
#   0.50 + smoothstep + 位移 14px → 太慢。实测标题到 2.2 秒才看清，
#                                    前面 1.5 秒画面空着，看起来像"卡住了"
#   0.32 + smoothstep             → 还是慢。实测 1.0 秒时画面仍和纯空屏毫无区别
#   0.22 + smoothstep             → 当前值
#
# ⚠️ 关键认识：**数学上的透明度曲线不等于眼睛看到的**
#   深色背景（15,18,26）上的白字，透明度低于约 35% 时基本看不出来。
#   所以"透明 0→1 花 1.5 秒"的实际效果是"先黑 1 秒、再突然看见"——
#   反而是最像"一下子冒出来"的。
#   窗口必须短到让透明度迅速越过那段"看不见"的区间。
#   0.22 配 smoothstep：约 0.9 秒完成；两头仍然慢（所以不突兀），
#   中间爬得快（所以不拖）。
# ⚠️ 必须显式声明成 [double]！
#
#   这两个数踩过一个大坑：PowerShell 的 `/` 运算遇到两个整数会做**截断除法**。
#   脚本里的绘图函数有 `[int]$x` `[int]$w` 这类类型约束，一旦 $FADE / $STAGGER
#   被赋成整数，`$progress / $FADE` 就变成整数除法：
#       0.0859 / 0.22  →  0      （期望 0.39）
#       0.1146 / 0.22  →  1      （期望 0.52）
#   结果是透明度在 0 和 1 之间**直接跳变**，中间没有任何过渡 ——
#   看起来就是"啪"地一下冒出来，前面还先黑着一段。
#   这就是"文字一下子就冒出来"的真正原因，跟缓动曲线无关。
#   为此白调了好几轮参数，直到把每个中间值都打出来、看见 "/FADE=0.0000"
#   才找到它。加 [double] 之后除法才是浮点除法。
[double]$FADE = 0.22
[double]$STAGGER = 0.10

$scenes = New-Object System.Collections.ArrayList

# ---------- 场景 1：标题 ----------
[void]$scenes.Add(@{
  dur = 7.0
  sub = '邮箱助手 · 用一封邮件，遥控家里的电脑干活'
  draw = {
    param($g, $p, $t)
    # 居中标题（标题和下面两行留足间距；第一版挨太近，'dsh-mail-bridge' 蹭到标题底部）
    $s = $g.MeasureString('邮箱助手', $F.hero)
    Draw-TextFade $g '邮箱助手' $F.hero $C.fg (($W - $s.Width) / 2) 190 ([Math]::Min(1, $p / $FADE))
    $s2 = $g.MeasureString('dsh-mail-bridge', $F.mono)
    Draw-TextFade $g 'dsh-mail-bridge' $F.mono $C.accent (($W - $s2.Width) / 2) 300 ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER) / $FADE)))
    $s3 = $g.MeasureString('Email as a command channel for DSH', $F.small)
    Draw-TextFade $g 'Email as a command channel for DSH' $F.small $C.dim (($W - $s3.Width) / 2) 355 ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER * 2) / $FADE)))
    Draw-Line $g 440 425 840 425 $C.line ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER * 3) / $FADE)))
  }
})

# ---------- 场景 2：问题 ----------
[void]$scenes.Add(@{
  dur = 6.0
  sub = '问题：家里的电脑没有公网 IP，外面连不进来'
  draw = {
    param($g, $p, $t)
    $s = $g.MeasureString('家里的电脑没有公网 IP', $F.h1)
    Draw-TextFade $g '家里的电脑没有公网 IP' $F.h1 $C.fg (($W - $s.Width) / 2) 150 ([Math]::Min(1, $p / $FADE))
    $s2 = $g.MeasureString('运营商级 NAT —— 外面连不进来', $F.body)
    Draw-TextFade $g '运营商级 NAT —— 外面连不进来' $F.body $C.amber (($W - $s2.Width) / 2) 215 ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER) / $FADE)))

    # 画一个"被封住"的示意图（也从 0 淡入，不再直接跳到 35%）
    $a = [Math]::Min(1, [Math]::Max(0, ($p - $STAGGER * 2) / $FADE))
    $pa = Ease-Smooth $a
    $dy = (1 - $pa) * $RISE_MD
    Draw-RoundRect $g 300 300 300 150 $C.panel $C.line $pa
    $g.DrawString('家里的电脑', $F.h2, (New-Object System.Drawing.SolidBrush (Alpha $C.fg ([int](255*$pa)))), 355, (350 + $dy))
    $g.DrawString('没有公网 IP', $F.small, (New-Object System.Drawing.SolidBrush (Alpha $C.red ([int](255*$pa)))), 365, (395 + $dy))

    # 从外面来的箭头被打断
    if ($p -gt 0.45) {
      $pa = Ease-Smooth ([Math]::Min(1, ($p - 0.45) / $FADE))
      $pen = New-Object System.Drawing.Pen (Alpha $C.dim 200), 3
      $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
      $g.DrawLine($pen, 120, 375, 260, 375)
      $pen.Dispose()
      $g.DrawString('外网', $F.small, (New-Object System.Drawing.SolidBrush (Alpha $C.dim 220)), 90, 385)
      # 大红叉
      $pen2 = New-Object System.Drawing.Pen (Alpha $C.red ([int](255*$pa))), 6
      $g.DrawLine($pen2, 275, 355, 305, 395)
      $g.DrawLine($pen2, 305, 355, 275, 395)
      $pen2.Dispose()
    }
  }
})

# ---------- 场景 3：思路 ----------
[void]$scenes.Add(@{
  dur = 7.0
  sub = '办法：用邮箱当中转站 —— 两边都能主动连出去'
  draw = {
    param($g, $p, $t)
    $s = $g.MeasureString('用邮箱当中转站', $F.h1)
    Draw-TextFade $g '用邮箱当中转站' $F.h1 $C.green (($W - $s.Width) / 2) 110 ([Math]::Min(1, $p / $FADE))
    $s2 = $g.MeasureString('不需要公网 IP、不需要端口转发、不需要内网穿透', $F.body)
    Draw-TextFade $g '不需要公网 IP、不需要端口转发、不需要内网穿透' $F.body $C.dim (($W - $s2.Width) / 2) 175 ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER) / $FADE)))

    # 三格对比：三格依次浮现，每格再错开一点
    $boxes = @(
      @{ x = 120; title = '端口转发'; need = '需要公网 IP'; ok = $false },
      @{ x = 500; title = '内网穿透'; need = '需要中转服务'; ok = $false },
      @{ x = 880; title = '邮箱中转'; need = '只需要能上网'; ok = $true }
    )
    $bi = 0
    foreach ($b in $boxes) {
      $a = Ease-Smooth ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER * 2 - $bi * 0.10) / $FADE)))
      $col = if ($b.ok) { $C.green } else { $C.line }
      Draw-RoundRect $g $b.x 270 280 190 $C.panel $col $a
      $g.DrawString($b.title, $F.h2, (New-Object System.Drawing.SolidBrush (Alpha $C.fg ([int](255*$a)))), ($b.x + 30), (305 + (1 - $a) * 5))
      $c2 = if ($b.ok) { $C.green } else { $C.dim }
      $g.DrawString($b.need, $F.small, (New-Object System.Drawing.SolidBrush (Alpha $c2 ([int](255*$a)))), ($b.x + 30), (355 + (1 - $a) * 5))
      if ($b.ok) {
        $g.DrawString('✓ 本项目', $F.small, (New-Object System.Drawing.SolidBrush (Alpha $C.green ([int](255*$a)))), ($b.x + 30), (400 + (1 - $a) * 5))
      }
      $bi++
    }
  }
})

# ---------- 场景 4：工作流程（动画） ----------
[void]$scenes.Add(@{
  dur = 12.0
  sub = '流程：手机发邮件 → 电脑收信 → 交给 DSH → 回信'
  draw = {
    param($g, $p, $t)
    $s = $g.MeasureString('工作流程', $F.h1)
    Draw-TextFade $g '工作流程' $F.h1 $C.fg (($W - $s.Width) / 2) 70 ([Math]::Min(1, $p / $FADE))

    # 四个节点（布局：总宽 1100，右侧留 90；框高 120）
    # 四个框依次浮现，每个错开一点，像"一路铺过去"
    $nodes = @(
      @{ x = 90;  label = '你的手机';   sub = '发一封邮件';   col = $C.accent },
      @{ x = 380; label = '邮件服务器'; sub = 'IMAP / SMTP';  col = $C.purple },
      @{ x = 670; label = '本地脚本';   sub = '轮询收件箱';   col = $C.green },
      @{ x = 960; label = 'DSH';        sub = '干活';         col = $C.amber }
    )
    $NW = 230; $NH = 120
    $y = 215
    $ni = 0
    foreach ($n in $nodes) {
      $a = Ease-Smooth ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER - $ni * 0.09) / $FADE)))
      Draw-RoundRect $g $n.x $y $NW $NH $C.panel $n.col $a
      $g.DrawString($n.label, $F.h2, (New-Object System.Drawing.SolidBrush (Alpha $C.fg ([int](255*$a)))), ($n.x + 26), ($y + 22 + (1 - $a) * 5))
      $g.DrawString($n.sub, $F.small, (New-Object System.Drawing.SolidBrush (Alpha $n.col ([int](255*$a)))), ($n.x + 26), ($y + 64 + (1 - $a) * 5))
      $ni++
    }
    # 连线和光点等四个框都出来之后再开始
    $a = Ease-Smooth ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER - 0.27) / $FADE)))

    # 连线 + 流动光点。
    # ⚠️ 各段间隙宽度不一（20/60/60），所以光点必须按段推进，
    #    不能拿"总长度 × 进度"线性插值 —— 第一版那样算，光点会跑进方框里。
    $span = @()
    for ($i = 0; $i -lt 3; $i++) {
      # 显式转 int：否则 '$nodes[$i].x + $NW' 可能被当成字符串拼接
      $gx1 = [int]$nodes[$i].x + [int]$NW
      $gx2 = [int]$nodes[$i + 1].x
      Draw-Line $g $gx1 ($y + $NH / 2) $gx2 ($y + $NH / 2) $C.line $a
      $span += ,@($gx1, ($gx2 - $gx1))
    }
    $totalGap = ($span | ForEach-Object { $_[1] } | Measure-Object -Sum).Sum

    # 光点也走 smoothstep，起步和到达都不突兀
    $flow = [Math]::Max(0, ($p - 0.40) / 0.50)
    if ($flow -gt 0) {
      $fp = Ease-Smooth ([Math]::Min(1, $flow))
      $travelled = $totalGap * $fp
      $cx = $span[0][0]
      foreach ($sg in $span) {
        if ($travelled -le $sg[1]) { $cx = $sg[0] + $travelled; break }
        $travelled -= $sg[1]
        $cx = $sg[0] + $sg[1]
      }
      $b = New-Object System.Drawing.SolidBrush $C.accent
      $g.FillEllipse($b, ($cx - 9), ($y + $NH / 2 - 9), 18, 18)
      $b.Dispose()
    }

    # 说明行（放在方框和字幕条之间），一行行错开浮现
    $lines = @(
      @{ at = 0.48; txt = '1. 手机发出邮件（收件人是自己的邮箱）'; col = $C.fg },
      @{ at = 0.60; txt = '2. 家里电脑主动轮询收件箱，只认白名单来信'; col = $C.fg },
      @{ at = 0.72; txt = '3. 正文清洗后交给 DSH，拿到答复'; col = $C.fg },
      @{ at = 0.84; txt = '4. 通过 SMTP 把结果回信给你'; col = $C.fg }
    )
    $ly = 400
    foreach ($l in $lines) {
      $la = [Math]::Min(1, [Math]::Max(0, ($p - $l.at) / $FADE))
      if ($la -gt 0) {
        Draw-TextFade $g $l.txt $F.small $l.col 180 $ly $la
      }
      $ly += 42
    }
  }
})

# ---------- 场景 5：特性 ----------
[void]$scenes.Add(@{
  dur = 9.0
  sub = '特性：防套娃、防伪造、防积压、会话续接'
  draw = {
    param($g, $p, $t)
    $s = $g.MeasureString('几个关键设计', $F.h1)
    Draw-TextFade $g '几个关键设计' $F.h1 $C.fg (($W - $s.Width) / 2) 60 ([Math]::Min(1, $p / $FADE))

    # 五行特性依次浮现。每行的渐入窗口给足 0.18，
    # 且两行间隔 0.18 —— 保证"上一行还没完全停稳，下一行已经开始"，
    # 这样整体是连续流动的，不会出现"停一下、再动一下"的顿感。
    $items = @(
      @{ at = 0.08; t = '防套娃';       d = '回信带标记头，不会被当成新指令反复执行'; col = $C.green },
      @{ at = 0.26; t = '防伪造';       d = '白名单 + SPF/DKIM 校验 + 可选暗号'; col = $C.accent },
      @{ at = 0.44; t = '引用与签名清洗'; d = '各家客户端的引用格式、自动签名都能剥掉'; col = $C.purple },
      @{ at = 0.62; t = '积压保护';     d = '每轮只处理固定封数，收件箱爆了也不拖垮轮询'; col = $C.amber },
      @{ at = 0.80; t = '权限自愈';     d = '发现会话被旧权限卡住，自动换新会话重跑一次'; col = $C.red }
    )
    $y = 140
    foreach ($it in $items) {
      $a = [Math]::Min(1, [Math]::Max(0, ($p - $it.at) / 0.18))
      if ($a -gt 0) {
        Draw-FullRect $g 170 ($y + 8) 5 44 $it.col $a
        # 说明的位置按标签实际宽度算，避免长标签压住说明
        Draw-LabelRow $g $F.h2 $F.body $it.col $it.t $it.d 200 $y $a
      }
      $y += 92
    }
  }
})

# ---------- 场景 6：安全提醒 ----------
[void]$scenes.Add(@{
  dur = 6.0
  sub = '提醒：授权码等于密码，别提交、别截图'
  draw = {
    param($g, $p, $t)
    $a = Ease-Smooth ([Math]::Min(1, $p / $FADE))
    Draw-RoundRect $g 140 150 1000 400 $C.panel $C.red $a
    $g.DrawString('⚠  注意', $F.h1, (New-Object System.Drawing.SolidBrush (Alpha $C.red ([int](255*$a)))), 190, (195 + (1 - $a) * 5))

    $rows = @(
      '授权码 ≈ 密码，泄露了别人就能收发你的邮件',
      '它只存在本地 config.json，已被 gitignore 排除',
      'allowFrom 决定谁能遥控这台电脑 —— 收紧到只有你自己',
      '它能执行命令：读写文件、跑程序。这是设计如此，也是风险所在'
    )
    $y = 275
    $ri = 0
    foreach ($r in $rows) {
      # 每行渐入窗口 0.20，行间距 0.14 —— 上一行没停稳下一行就起步，整体是连续的
      $ra = [Math]::Min(1, [Math]::Max(0, ($p - $STAGGER - $ri * 0.14) / 0.20))
      if ($ra -gt 0) {
        Draw-TextFade $g ('· ' + $r) $F.body $C.fg 200 $y $ra
      }
      $y += 62
      $ri++
    }
  }
})

# ---------- 场景 7：测试 ----------
[void]$scenes.Add(@{
  dur = 6.0
  sub = '测试：495 项断言 / 13 个套件，不需要邮箱和 DSH 就能跑'
  draw = {
    param($g, $p, $t)
    $s = $g.MeasureString('495', $F.hero)
    Draw-TextFade $g '495' $F.hero $C.green (($W - $s.Width) / 2) 130 ([Math]::Min(1, $p / $FADE))
    $s2 = $g.MeasureString('项断言 · 13 个测试套件', $F.h2)
    Draw-TextFade $g '项断言 · 13 个测试套件' $F.h2 $C.fg (($W - $s2.Width) / 2) 230 ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER) / $FADE)))

    $lines = @(
      @{ at = 0.30; t = '自带假 DSH 与假收发信层 —— 无需真邮箱、无需装 DSH'; col = $C.dim },
      @{ at = 0.46; t = '覆盖：超时、会话失效、权限被拒、畸形邮件、积压'; col = $C.dim },
      @{ at = 0.62; t = '静态自检：未解析的 require、undefined 导出、凭据进日志'; col = $C.dim }
    )
    $y = 330
    foreach ($l in $lines) {
      # 渐入窗口给足 0.30，且行间距 0.16 —— 上一行没停稳下一行就起步，整体连续
      $la = [Math]::Min(1, [Math]::Max(0, ($p - $l.at) / 0.30))
      if ($la -gt 0) { Draw-TextFade $g $l.t $F.body $l.col 200 $y $la }
      $y += 50
    }

    # 终端样式的小方块
    $a = [Math]::Min(1, [Math]::Max(0, ($p - 0.70) / 0.30))
    if ($a -gt 0) {
      $pa = Ease-Smooth $a
      Draw-RoundRect $g 200 500 880 60 ([System.Drawing.Color]::FromArgb(10,12,18)) $C.line $pa
      $g.DrawString('$ npm test', $F.mono, (New-Object System.Drawing.SolidBrush (Alpha $C.green ([int](255*$pa)))), 225, (517 + (1 - $pa) * $RISE_SM))
    }
  }
})

# ---------- 场景 8：结尾 ----------
[void]$scenes.Add(@{
  dur = 6.0
  sub = '开源 · MIT 许可 · 欢迎试用和反馈'
  draw = {
    param($g, $p, $t)
    $s = $g.MeasureString('dsh-mail-bridge', $F.h1)
    Draw-TextFade $g 'dsh-mail-bridge' $F.h1 $C.accent (($W - $s.Width) / 2) 220 ([Math]::Min(1, $p / $FADE))
    $s2 = $g.MeasureString('github.com/QIKO0721/dsh-mail-bridge', $F.body)
    Draw-TextFade $g 'github.com/QIKO0721/dsh-mail-bridge' $F.body $C.fg (($W - $s2.Width) / 2) 300 ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER) / $FADE)))
    $s3 = $g.MeasureString('MIT License', $F.small)
    Draw-TextFade $g 'MIT License' $F.small $C.dim (($W - $s3.Width) / 2) 360 ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER * 2) / $FADE)))
    Draw-Line $g 480 420 800 420 $C.line ([Math]::Min(1, [Math]::Max(0, ($p - $STAGGER * 3) / $FADE)))
  }
})

# ============================================================
#  渲染
# ============================================================
$totalFrames = 0
foreach ($s in $scenes) { $totalFrames += [int]($s.dur * $FPS) }
$totalSec = [Math]::Round($totalFrames / $FPS, 1)
Write-Host "共 $($scenes.Count) 个场景，$totalFrames 帧，约 $totalSec 秒" -ForegroundColor Cyan
Write-Host "分辨率 ${W}x${H} @ ${FPS}fps"
Write-Host ''

# ---- 先用原始像素喂 ffmpeg 出 MP4 ----
function Start-FfmpegPipe {
  param([string[]]$ffargs)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FFMPEG
  $psi.Arguments = ($ffargs -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  return $p
}

$commonIn = @('-y','-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','bgr24','-s',"${W}x${H}",'-r',"$FPS",'-i','pipe:0')

Write-Host '渲染 MP4 ...' -ForegroundColor Yellow
# 注意：ProcessStartInfo.Arguments 是一个整串，路径里有空格才需要加引号，
# 这里直接给干净路径，别自己塞转义引号（第一版塞了 " 导致输出文件名被污染）。
if ($HAS_X264) {
  # libx264 软编码：质量比同码率的硬编码好，720p 这点量也就一两分钟。
  # yuv420p 保证所有播放器都能放；+faststart 让网页能边下边播。
  $mp4Proc = Start-FfmpegPipe (@($commonIn) + @('-c:v','libx264','-preset','medium','-crf',"$CRF",'-pix_fmt','yuv420p','-movflags','+faststart', $MP4))
} else {
  # 退回老 mpeg4：这台机器没有 libx264 时的唯一选择
  $mp4Proc = Start-FfmpegPipe (@($commonIn) + @('-c:v','mpeg4','-q:v','2','-pix_fmt','yuv420p', $MP4))
}
$mp4in = $mp4Proc.StandardInput.BaseStream

$rendered = 0
$sceneIdx = 0
foreach ($s in $scenes) {
  $sceneFrames = [int]($s.dur * $FPS)
  for ($i = 0; $i -lt $sceneFrames; $i++) {
    $p = if ($sceneFrames -le 1) { 1.0 } else { $i / ($sceneFrames - 1) }
    $fr = New-Frame
    & $s.draw $fr.g $p ($rendered / $FPS)
    Draw-Subtitle $fr.g $s.sub $F.sub $F.subSm

    $rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
    $d = $fr.bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $bytes = New-Object byte[] ($d.Stride * $H)
    [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $bytes.Length)
    $fr.bmp.UnlockBits($d)

    if ($d.Stride -eq $W * 3) {
      $mp4in.Write($bytes, 0, $bytes.Length)
    } else {
      for ($y = 0; $y -lt $H; $y++) { $mp4in.Write($bytes, ($y * $d.Stride), ($W * 3)) }
    }
    $fr.g.Dispose(); $fr.bmp.Dispose()

    $rendered++
    if ($rendered % 48 -eq 0) { Write-Host ("  已画 $rendered / $totalFrames 帧") }
  }
  $sceneIdx++
}
$mp4in.Flush(); $mp4in.Close()
$mp4Proc.WaitForExit()
$err = $mp4Proc.StandardError.ReadToEnd()
if ($err) { Write-Host "  ffmpeg stderr: $err" -ForegroundColor DarkYellow }
Write-Host "  MP4 退出码 $($mp4Proc.ExitCode)"

Write-Host ''
Write-Host '渲染 GIF ...' -ForegroundColor Yellow
# ⚠️ GIF 这段踩过一个大坑，结论写死在这里：
#
#   【调色板必须留着】。直觉上"256 色调色板丢画质，不如直接全彩"，
#   实测恰恰相反 —— 去掉 palettegen/paletteuse 之后体积是灾难性的
#   （同样 10 秒素材，1280 宽 24fps）：
#        有调色板  →    213 KB
#        无调色板  →  60263 KB      ← 涨 280 倍
#   GIF 格式本身就是 256 色索引色；交给 ffmpeg 硬转全彩，它会做逐帧
#   全画幅量化再自己挑调色板，体积直接爆掉。
#
#   【帧率对体积几乎没影响】。同一段素材：
#        15fps  900 宽  → 214 KB
#        24fps 1280 宽  → 213 KB    ← 差 1 KB
#   因为视频里大量帧是静止的，重复帧会被压得极小，体积由颜色复杂度决定。
#   所以早期"为了压体积把帧率降到 15"是完全错误的取舍：
#   白白牺牲流畅度，一个字节都没省下。
#
#   结论：满帧率、满分辨率、保留调色板。
$gifArgs = @($commonIn) + @(
  '-vf', "fps=$GIF_FPS,scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
  '-loop','0', $GIF
)
$gifProc = Start-FfmpegPipe $gifArgs
$gifin = $gifProc.StandardInput.BaseStream

$rendered = 0
foreach ($s in $scenes) {
  $sceneFrames = [int]($s.dur * $FPS)
  for ($i = 0; $i -lt $sceneFrames; $i++) {
    $p = if ($sceneFrames -le 1) { 1.0 } else { $i / ($sceneFrames - 1) }
    $fr = New-Frame
    & $s.draw $fr.g $p ($rendered / $FPS)
    Draw-Subtitle $fr.g $s.sub $F.sub $F.subSm

    $rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
    $d = $fr.bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $bytes = New-Object byte[] ($d.Stride * $H)
    [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $bytes.Length)
    $fr.bmp.UnlockBits($d)

    if ($d.Stride -eq $W * 3) { $gifin.Write($bytes, 0, $bytes.Length) }
    else { for ($y = 0; $y -lt $H; $y++) { $gifin.Write($bytes, ($y * $d.Stride), ($W * 3)) } }
    $fr.g.Dispose(); $fr.bmp.Dispose()

    $rendered++
    if ($rendered % 96 -eq 0) { Write-Host ("  已画 $rendered / $totalFrames 帧") }
  }
}
$gifin.Flush(); $gifin.Close()
$gifProc.WaitForExit()
$err2 = $gifProc.StandardError.ReadToEnd()
if ($err2) { Write-Host "  ffmpeg stderr: $err2" -ForegroundColor DarkYellow }
Write-Host "  GIF 退出码 $($gifProc.ExitCode)"

Write-Host ''
Write-Host '================ 产物 ================' -ForegroundColor Cyan
# ⚠️ 这里踩过三个坑，都写下来免得重犯：
#   1) 循环变量别用 $f —— 它是 PowerShell 自动变量（format specifier）；
#   2) 进程对象别叫 $mp4 / $gif —— PowerShell 变量名不分大小写，
#      会把存路径的 $MP4 / $GIF 覆盖掉；
#   3) Split-Path -LiteralPath ... -Leaf 在 PS 5.1 里参数集有歧义 ——
#      直接用 .NET 的 GetFileName / File.Exists，简单且不会错。
foreach ($artifact in @($GIF, $MP4)) {
  $leaf = [System.IO.Path]::GetFileName($artifact)
  if ([System.IO.File]::Exists($artifact)) {
    $kb = [math]::Round((New-Object System.IO.FileInfo $artifact).Length / 1KB, 1)
    Write-Host ("  {0}  {1} KB" -f $leaf, $kb) -ForegroundColor Green
  } else {
    Write-Host ("  ✗ 没生成 " + $leaf) -ForegroundColor Red
  }
}
