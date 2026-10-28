param(
  [Parameter(Mandatory = $true)][string]$TasksPath,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [string]$Sizes = '64'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct NativeSize { public int cx; public int cy; }

[Flags]
public enum SIIGBF {
    RESIZETOFIT = 0x00,
    BIGGERSIZEOK = 0x01,
    MEMORYONLY = 0x02,
    ICONONLY = 0x04,
    THUMBNAILONLY = 0x08,
    INCACHEONLY = 0x10
}

[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItemImageFactory {
    [PreserveSig]
    int GetImage(NativeSize size, SIIGBF flags, out IntPtr phbm);
}

public static class Win2MacShellIcon {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        string pszPath, IntPtr pbc,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    public static IntPtr GetHBitmap(string path, int size) {
        IShellItemImageFactory item;
        SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out item);
        IntPtr hbm;
        int hr = item.GetImage(
            new NativeSize { cx = size, cy = size },
            SIIGBF.RESIZETOFIT,
            out hbm);
        if (hr != 0 || hbm == IntPtr.Zero) {
            throw new Exception("GetImage failed: 0x" + hr.ToString("X8"));
        }
        return hbm;
    }
}
"@

function Save-HBitmapPng([IntPtr]$hBitmap, [string]$path) {
  $source = [System.Windows.Interop.Imaging]::CreateBitmapSourceFromHBitmap(
    $hBitmap,
    [IntPtr]::Zero,
    [System.Windows.Int32Rect]::Empty,
    [System.Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions()
  )
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($source))
  $stream = [System.IO.File]::Create($path)
  try { $encoder.Save($stream) } finally { $stream.Close() }
}

function New-FallbackIcon([string]$path, [string]$text, [int]$size = 512) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)
    $pad = [int]($size * 0.085)
    $rect = New-Object System.Drawing.Rectangle($pad, $pad, ($size - $pad * 2), ($size - $pad * 2))
    $radius = [int]($size * 0.19)
    $pathObj = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $pathObj.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $pathObj.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
    $pathObj.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
    $pathObj.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
    $pathObj.CloseFigure()
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $rect,
      [System.Drawing.Color]::FromArgb(255, 18, 20, 24),
      [System.Drawing.Color]::FromArgb(255, 45, 50, 58),
      45.0
    )
    $g.FillPath($brush, $pathObj)
    $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 190, 242, 100))
    $g.FillEllipse($accent, ($rect.Right - [int]($size * 0.29)), ($rect.Bottom - [int]($size * 0.29)), [int]($size * 0.16), [int]($size * 0.16))
    $letter = 'W'
    if (-not [string]::IsNullOrWhiteSpace($text)) {
      $letter = $text.Trim().Substring(0, 1).ToUpperInvariant()
    }
    $font = New-Object System.Drawing.Font('Segoe UI', ([float]($size * 0.36)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object System.Drawing.RectangleF(0, 0, $rect.Width, $rect.Height)
    $g.DrawString($letter, $font, [System.Drawing.Brushes]::White, $textRect, $format)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}

function Resize-Png([string]$source, [string]$dest, [int]$size) {
  $img = [System.Drawing.Image]::FromFile($source)
  try {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($img, 0, 0, $size, $size)
    } finally { $g.Dispose() }
    $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally {
    $img.Dispose()
  }
}

$tasks = Get-Content -LiteralPath $TasksPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }
$sizeList = @($Sizes -split ',' | ForEach-Object { [int]$_.Trim() } | Where-Object { $_ -gt 0 })
$results = New-Object System.Collections.ArrayList

foreach ($task in $tasks) {
  $id = [string]$task.id
  $exe = (([string]$task.exe) -replace '/', '\')
  $text = [string]$task.text
  $item = [pscustomobject]@{
    id = $id
    success = $false
    source = $null
    master = $null
    files = @()
    error = $null
  }
  try {
    $masterPath = Join-Path $OutputDir ("$id" + '_master.png')
    $hBitmap = [IntPtr]::Zero
    try {
      if ($exe -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
        $hBitmap = [Win2MacShellIcon]::GetHBitmap($exe, 512)
        if ($hBitmap -ne [IntPtr]::Zero) {
          Save-HBitmapPng $hBitmap $masterPath
          $item.source = 'shell'
        }
      }
    } catch {
      $item.error = $_.Exception.Message
    } finally {
      if ($hBitmap -ne [IntPtr]::Zero) {
        [void][Win2MacShellIcon]::DeleteObject($hBitmap)
      }
    }
    if (-not (Test-Path -LiteralPath $masterPath)) {
      New-FallbackIcon $masterPath $text 512
      $item.source = 'fallback'
    }
    $item.master = $masterPath
    $files = New-Object System.Collections.ArrayList
    foreach ($size in $sizeList) {
      $dest = Join-Path $OutputDir ("$id" + "_$size.png")
      if ($size -eq 512) {
        Copy-Item -LiteralPath $masterPath -Destination $dest -Force
      } else {
        Resize-Png $masterPath $dest $size
      }
      [void]$files.Add($dest)
    }
    $item.files = @($files)
    $item.success = $true
  } catch {
    $item.error = $_.Exception.Message
  }
  [void]$results.Add($item)
}

$outputPath = Join-Path $OutputDir 'icons.json'
$json = $results | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($outputPath, $json, (New-Object System.Text.UTF8Encoding($false)))
