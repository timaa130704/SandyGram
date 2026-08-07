$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = (Resolve-Path ".").Path
$src  = Join-Path $root "icon.png"
$srcImg = [System.Drawing.Image]::FromFile($src)

function New-SizePng {
  param(
    [string]$outPath,
    [int]$size,
    [double]$scalePct = 100,
    [switch]$Circle,
    [string]$bgColor,
    [switch]$Mono
  )
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $bmp.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  if ($bgColor) { $g.Clear([System.Drawing.ColorTranslator]::FromHtml($bgColor)) }

  if ($Circle) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(0, 0, $size - 1, $size - 1)
    $region = New-Object System.Drawing.Region($path)
    $g.SetClip($region, [System.Drawing.Drawing2D.CombineMode]::Replace)
  }

  $w = $size * $scalePct / 100.0
  $x = ($size - $w) / 2

  if (-not $Mono) {
    $g.DrawImage($srcImg, [single]$x, [single]$x, [single]$w, [single]$w)
  } else {
    # белый силуэт: берём альфу исходника, красим в белый
    $mm = New-Object System.Drawing.Bitmap($size, $size)
    $mg = [System.Drawing.Graphics]::FromImage($mm)
    $mg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $mg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $mg.Clear([System.Drawing.Color]::Transparent)
    $mg.DrawImage($srcImg, [single]$x, [single]$x, [single]$w, [single]$w)
    $mg.Dispose()
    for ($yy = 0; $yy -lt $size; $yy++) {
      for ($xx = 0; $xx -lt $size; $xx++) {
        $c = $mm.GetPixel($xx, $yy)
        if ($c.A -gt 0) {
          $bmp.SetPixel($xx, $yy, [System.Drawing.Color]::FromArgb([int]$c.A, 255, 255, 255))
        }
      }
    }
    $mm.Dispose()
  }

  $g.Dispose()
  $dir = Split-Path $outPath -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# --- Веб favicon ---
New-SizePng (Join-Path $root "web\public\favicon.png") 64
New-SizePng (Join-Path $root "web\public\apple-touch-icon.png") 180

# --- Expo assets ---
New-SizePng (Join-Path $root "app\assets\icon.png") 1024
New-SizePng (Join-Path $root "app\assets\favicon.png") 64
New-SizePng (Join-Path $root "app\assets\android-icon-foreground.png") 1024 -scalePct 55
New-SizePng (Join-Path $root "app\assets\android-icon-background.png") 1024 -bgColor "#0A0A0A"
New-SizePng (Join-Path $root "app\assets\android-icon-monochrome.png") 1024 -Mono -scalePct 72

# --- desktop: многоразмерный ICO (DIB/BMP; PNG-in-ICO csc не принимает) ---
$icoSizes = @(16, 24, 32, 48, 64, 128, 256)
$layers = New-Object System.Collections.Generic.List[object]
foreach ($sz in $icoSizes) {
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $bmp.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($srcImg, [single]0, [single]0, [single]$sz, [single]$sz)
  $g.Dispose()
  $rect = New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)
  $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $bd.Stride
  $raw = New-Object byte[] ($stride * $sz)
  [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $raw, 0, $raw.Length)
  $bmp.UnlockBits($bd)
  $bmp.Dispose()
  # XOR: строки в обратном порядке (снизу вверх), BGRA
  $xor = New-Object System.Collections.Generic.List[byte]
  for ($y = $sz - 1; $y -ge 0; $y--) {
    $rowStart = $y * $stride
    for ($i = 0; $i -lt $sz * 4; $i++) { $xor.Add($raw[$rowStart + $i]) }
  }
  # AND-маска (1 бит на пиксель, выравнивание до 4 байт)
  $maskRow = [int]([math]::Ceiling($sz / 32.0) * 4)
  $mask = New-Object byte[] ($maskRow * $sz)
  $layerMs = New-Object System.IO.MemoryStream
  $layerBw = New-Object System.IO.BinaryWriter($layerMs)
  $layerBw.Write([uint32]40)
  $layerBw.Write([uint32]$sz)
  $layerBw.Write([uint32]($sz * 2))
  $layerBw.Write([uint16]1)
  $layerBw.Write([uint16]32)
  $layerBw.Write([uint32]0)
  $layerBw.Write([uint32]($xor.Count + $mask.Length))
  $layerBw.Write([uint32]0); $layerBw.Write([uint32]0); $layerBw.Write([uint32]0); $layerBw.Write([uint32]0)
  $layerBw.Write($xor.ToArray())
  $layerBw.Write($mask)
  $layerBw.Flush()
  $layerBytes = $layerMs.ToArray()
  $layerBw.Dispose(); $layerMs.Dispose()
  $layers.Add(@{ Size = $sz; Data = $layerBytes })
}
$icoMs = New-Object System.IO.MemoryStream
$icoBw = New-Object System.IO.BinaryWriter($icoMs)
$icoBw.Write([uint16]0); $icoBw.Write([uint16]1); $icoBw.Write([uint16]$layers.Count)
$offset = 6 + 16 * $layers.Count
foreach ($l in $layers) {
  $s = [int]$l.Size
  $icoBw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $icoBw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $icoBw.Write([byte]0); $icoBw.Write([byte]0)
  $icoBw.Write([uint16]1); $icoBw.Write([uint16]32)
  $icoBw.Write([uint32]$l.Data.Length)
  $icoBw.Write([uint32]$offset)
  $offset += $l.Data.Length
}
foreach ($l in $layers) { $icoBw.Write($l.Data) }
$icoBw.Flush()
$ico = Join-Path $root "desktop\icon.ico"
[System.IO.File]::WriteAllBytes($ico, $icoMs.ToArray())
$icoBw.Dispose(); $icoMs.Dispose()

# --- Android mipmap (png вместо webp) ---
$dens = @{ "mdpi" = 48;  "hdpi" = 72;  "xhdpi" = 96;  "xxhdpi" = 144; "xxxhdpi" = 192 }
$adap = @{ "mdpi" = 108; "hdpi" = 162; "xhdpi" = 216; "xxhdpi" = 324; "xxxhdpi" = 432 }
foreach ($d in $dens.Keys) {
  $dir = Join-Path $root "app\android\app\src\main\res\mipmap-$d"
  New-SizePng (Join-Path $dir "ic_launcher.png") $dens[$d]
  New-SizePng (Join-Path $dir "ic_launcher_round.png") $dens[$d] -Circle
  New-SizePng (Join-Path $dir "ic_launcher_monochrome.png") $dens[$d] -Mono -scalePct 78
  New-SizePng (Join-Path $dir "ic_launcher_foreground.png") $adap[$d] -scalePct 58
  New-SizePng (Join-Path $dir "ic_launcher_background.png") $adap[$d] -bgColor "#0A0A0A"
  Remove-Item (Join-Path $dir "*.webp") -ErrorAction SilentlyContinue
}

$srcImg.Dispose()
Write-Output "Icons generated OK"