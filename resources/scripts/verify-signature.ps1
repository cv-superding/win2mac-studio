param(
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'
try {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if (-not $signature -or -not $signature.SignerCertificate) {
    Write-Output 'NoCertificate|'
    exit 2
  }
  $subject = $signature.SignerCertificate.Subject
  Write-Output ("{0}|{1}" -f $signature.Status, $subject)
  if ($signature.Status -ne 'Valid') { exit 1 }
  exit 0
} catch {
  Write-Output ("Error|" + $_.Exception.Message)
  exit 2
}
