# Kleiner lokaler Webserver fuer die Lieferschein-Maske.
# Nur auf diesem PC erreichbar (127.0.0.1).
#
# Bewusst kein LAN-Server wie bei der Auftragsuebersicht: Diese Anwendung
# kann Belege in Lexware anlegen und gehoert nicht offen ins Netz.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = 8781
$file = 'index.html'

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
try {
  $listener.Start()
} catch {
  Write-Host ''
  Write-Host '!! Der Server konnte nicht gestartet werden.'
  Write-Host ("   Grund: {0}" -f $_.Exception.Message)
  Write-Host "   Vermutlich ist Port $port schon belegt - laeuft der Server bereits?"
  Write-Host ''
  Read-Host 'Zum Schliessen Enter druecken'
  exit 1
}

Write-Host ''
Write-Host '======================================================================'
Write-Host "  Server laeuft:  http://localhost:$port/$file"
Write-Host ''
Write-Host '  Dieses Fenster bitte offen lassen.'
Write-Host '  Zum Beenden das Fenster einfach schliessen.'
Write-Host '======================================================================'
Write-Host ''

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.sql'  = 'text/plain; charset=utf-8'
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = $file }
    $path = Join-Path $root $rel

    if (Test-Path $path -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      if ($types.ContainsKey($ext)) { $res.ContentType = $types[$ext] }
      # Kein Zwischenspeichern: nach einer Aenderung soll sofort die neue
      # Fassung erscheinen, ohne dass jemand den Cache leeren muss.
      $res.Headers.Add('Cache-Control', 'no-store')
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host "[200] $rel"
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("Nicht gefunden: $rel")
      $res.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host "[404] $rel"
    }
    $res.OutputStream.Close()
  } catch {
    Write-Host "[Fehler] $($_.Exception.Message)"
  }
}
