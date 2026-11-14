Add-Type -AssemblyName System.Drawing
$iconBitmap = New-Object System.Drawing.Bitmap 256, 256
$iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
$iconGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$backgroundBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#12243a'))
$accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#33c8ac'))
$outlinePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 9
$codePen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#33c8ac')), 8
$iconGraphics.FillRectangle($backgroundBrush, 0, 0, 256, 256)
$robotPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$robotPath.AddArc(39, 62, 36, 36, 180, 90)
$robotPath.AddArc(181, 62, 36, 36, 270, 90)
$robotPath.AddArc(181, 172, 36, 36, 0, 90)
$robotPath.AddArc(39, 172, 36, 36, 90, 90)
$robotPath.CloseFigure()
$iconGraphics.DrawPath($outlinePen, $robotPath)
$iconGraphics.DrawLine($outlinePen, 128, 38, 128, 62)
$iconGraphics.FillEllipse($accentBrush, 119, 24, 18, 18)
$iconGraphics.DrawLines($codePen, [System.Drawing.Point[]]@([System.Drawing.Point]::new(91, 111), [System.Drawing.Point]::new(71, 135), [System.Drawing.Point]::new(91, 159)))
$iconGraphics.DrawLines($codePen, [System.Drawing.Point[]]@([System.Drawing.Point]::new(165, 111), [System.Drawing.Point]::new(185, 135), [System.Drawing.Point]::new(165, 159)))
$iconGraphics.DrawLine($outlinePen, 139, 106, 117, 165)
$iconOutput = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\media\icon.png'))
$iconBitmap.Save($iconOutput, [System.Drawing.Imaging.ImageFormat]::Png)
$robotPath.Dispose()
$outlinePen.Dispose()
$codePen.Dispose()
$backgroundBrush.Dispose()
$accentBrush.Dispose()
$iconGraphics.Dispose()
$iconBitmap.Dispose()
Write-Output $iconOutput
