$ErrorActionPreference = 'Stop'
try {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
  if ([version]$nodeVersion -lt [version]'24.5.0') { throw '请安装 Node.js 24.5 或更新版本后再启动。' }
  # Read an existing HTTP system proxy only for this child process.
  if (-not $env:HTTPS_PROXY -and -not $env:https_proxy) {
    $proxySettings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($proxySettings.ProxyEnable -eq 1 -and $proxySettings.ProxyServer -match '^[A-Za-z0-9.-]+:\d+$') {
      $env:HTTPS_PROXY = 'http://' + $proxySettings.ProxyServer
    }
  }
  $env:NO_PROXY = '127.0.0.1,localhost,::1'
  & $nodeCommand.Source --use-env-proxy (Join-Path $PSScriptRoot 'server.mjs')
} catch { Write-Host $_.Exception.Message -ForegroundColor Red }
Read-Host '按回车关闭窗口'
