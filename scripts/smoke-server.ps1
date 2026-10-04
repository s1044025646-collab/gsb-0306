$env:BUDDY_DATA_DIR = Join-Path $PSScriptRoot '..\data-smoke-server'
Remove-Item -Recurse -Force $env:BUDDY_DATA_DIR -ErrorAction SilentlyContinue
$env:PORT = ''
$job = Start-Job -ScriptBlock {
  param($dir)
  Set-Location $dir
  $env:BUDDY_DATA_DIR = Join-Path $dir 'data-smoke-server'
  node dist/src/server.js
} -ArgumentList (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Start-Sleep -Seconds 2
Receive-Job $job
# 找端口：直接让服务器选空闲端口不易抓取，这里用固定端口重试
Stop-Job $job; Remove-Job $job -Force
$env:PORT = '18123'
$job = Start-Job -ScriptBlock {
  param($dir)
  Set-Location $dir
  $env:BUDDY_DATA_DIR = Join-Path $dir 'data-smoke-server'
  $env:PORT = '18123'
  node dist/src/server.js
} -ArgumentList (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Start-Sleep -Seconds 2
$base = 'http://127.0.0.1:18123'
$r = Invoke-RestMethod -Method Post -Uri "$base/regions" -Body '{"sizeBytes":16,"name":"api"}' -ContentType 'application/json'
"region id: $($r.region.id)"
$a = Invoke-RestMethod -Method Post -Uri "$base/regions/1/allocations" -Body '{"requestId":"r1","bytes":3}' -ContentType 'application/json'
"alloc r1 offset=$($a.allocation.offset) size=$($a.allocation.size)"
Invoke-RestMethod -Method Post -Uri "$base/regions/1/allocations" -Body '{"requestId":"r2","bytes":5}' -ContentType 'application/json' | Out-Null
(Invoke-RestMethod -Uri "$base/regions/1/address?offset=9") | ConvertTo-Json -Compress
(Invoke-RestMethod -Uri "$base/regions/1/status").verify | ConvertTo-Json -Compress
try { Invoke-RestMethod -Method Post -Uri "$base/regions/1/allocations" -Body '{"requestId":"bad","bytes":0}' -ContentType 'application/json' } catch { "reject: $($_.ErrorDetails.Message)" }
try { Invoke-RestMethod -Method Post -Uri "$base/regions/1/free" -Body '{"requestId":"nope"}' -ContentType 'application/json' } catch { "reject: $($_.ErrorDetails.Message)" }
Invoke-RestMethod -Method Post -Uri "$base/regions/1/free" -Body '{"requestId":"r1"}' -ContentType 'application/json' | Out-Null
Invoke-RestMethod -Method Post -Uri "$base/regions/1/free" -Body '{"requestId":"r2"}' -ContentType 'application/json' | Out-Null
(Invoke-RestMethod -Uri "$base/regions/1/replay").state.freeBlocks | ConvertTo-Json -Compress
"events: $((Invoke-RestMethod -Uri "$base/regions/1/events").events.Count)"
Stop-Job $job; Remove-Job $job -Force
