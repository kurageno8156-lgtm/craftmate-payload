// 配布物に oauth-clients.json（Client Secret を含み得る）が含まれないことを検証するテスト。
// 実行: node tests/payload-oauth-clients.test.mjs
//   CM_PAYLOAD_ZIP=<path> を指定すると、そのZIPアーカイブ内も検査する。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
}

test('Build-Release.ps1 がペイロードに oauth-clients.json を含めない', () => {
  const src = fs.readFileSync(path.join(root, 'installer', 'Build-Release.ps1'), 'utf8');
  // 同梱リスト（foreach のファイル配列）に oauth-clients.json が無いこと
  const m = src.match(/foreach \(\$file in @\(([^)]*)\)\)/);
  assert.ok(m, 'payload file list not found');
  assert.ok(!m[1].includes('oauth-clients.json'), 'oauth-clients.json is in payload file list');
});

test('build-release.sh が oauth-clients.json をコピーしない', () => {
  const src = fs.readFileSync(path.join(root, 'build-release.sh'), 'utf8');
  assert.ok(!/cp\s+oauth-clients\.json/.test(src), 'build-release.sh still copies oauth-clients.json');
});

test('GitHub Actions が Secrets から oauth-clients.json を生成しない', () => {
  const src = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.ok(!src.includes('Generate oauth-clients.json'), 'workflow still generates oauth-clients.json');
  assert.ok(!/secrets\.(GOOGLE|GITHUB|DISCORD)_CLIENT_(ID|SECRET)/.test(src), 'workflow still references OAuth client secrets');
});

test('oauth-clients.json は .gitignore 対象（誤コミット防止）', () => {
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const lines = gi.split(/\r?\n/).map(l => l.trim());
  assert.ok(lines.includes('oauth-clients.json'), 'oauth-clients.json missing from .gitignore');
});

test('webServer の候補パスにユーザー設定場所が残っている', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'server', 'webServer.ts'), 'utf8');
  assert.ok(src.includes('LOCALAPPDATA'), 'LOCALAPPDATA fallback missing');
  assert.ok(src.includes('oauth-clients.json'), 'oauth-clients.json resolution missing');
});

// 実ZIPが指定された場合は中身も検査（PowerShell Compress-Archive / .NET で一覧取得）
const zipPath = process.env.CM_PAYLOAD_ZIP;
if (zipPath) {
  test(`payload ZIP に oauth-clients.json が含まれない: ${zipPath}`, () => {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}').Entries | ForEach-Object { $_.FullName }`],
      { encoding: 'utf8' });
    assert.ok(!out.split(/\r?\n/).some(l => /(^|\/)oauth-clients\.json$/.test(l.trim())), 'oauth-clients.json found inside payload zip');
  });
} else {
  console.log('  skip  ZIP内容検査（CM_PAYLOAD_ZIP 未指定）');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
