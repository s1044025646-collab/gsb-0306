$env:BUDDY_DATA_DIR = Join-Path $PSScriptRoot '..\data-smoke'
Remove-Item -Recurse -Force $env:BUDDY_DATA_DIR -ErrorAction SilentlyContinue
node dist/src/cli.js create 16 demo
node dist/src/cli.js alloc 1 r1 3
node dist/src/cli.js alloc 1 r2 5
node dist/src/cli.js status 1
node dist/src/cli.js query 1 5
node dist/src/cli.js free 1 r1
node dist/src/cli.js free 1 r1
node dist/src/cli.js replay 1 1
node dist/src/cli.js verify 1
node dist/src/cli.js export 1 | Select-Object -First 5
