param(
  [Parameter(Mandatory=$true)][string]$DocxPath,
  [Parameter(Mandatory=$true)][string]$PdfPath
)
$ErrorActionPreference = "Stop"

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($DocxPath, $false, $true)
  try {
    # 17 = wdFormatPDF
    $doc.SaveAs2($PdfPath, 17)
  } finally {
    $doc.Close($false)
  }
} finally {
  $word.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
}
