// scripts/pack.js
// 打包可分发的扩展 zip（带版本号与日期），并做端到端验证
//
// 用法：
//   node scripts/pack.js                 # 打包 + 真实浏览器加载验证
//   node scripts/pack.js --no-verify     # 仅打包
//   node scripts/pack.js --out=<file>    # 自定义输出名
//
// 这个脚本固化了三个踩过的坑：
//   1) ZIP 内路径必须用正斜杠 —— PowerShell Compress-Archive 会写成反斜杠
//      (`Basic\x.js`)，在 Linux/macOS 解压会变成文件名里带反斜杠的怪文件。
//      故统一走 bsdtar（Windows 10+ 自带 /c/Windows/System32/tar.exe，-a 自动识别 zip）。
//   2) 包内不能有 `_` 前缀的根条目（Chromium 保留名，会直接无法加载）。
//   3) 只打扩展运行所需文件：不夹带 node_modules/.git/docs/scripts/test-artifacts/_metadata
//      以及本机配置(.mcp.json/reasonix.toml/.reasonix)。
//
// 验证方式：解压到临时目录 → 用真实 Chrome 调 CDP `Extensions.loadUnpacked`
// （与 chrome://extensions 的「加载已解压的扩展程序」同一代码路径）。
// 工件：test-artifacts/pack-report.json
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
    ROOT, findBrowserExecutable, describeBrowser, loadUnpackedViaCDP
} = require('./lib/mix01-harness');

const REPORT_PATH = path.join(ROOT, 'test-artifacts', 'pack-report.json');
const NO_VERIFY = process.argv.includes('--no-verify');
const OUT_ARG = process.argv.find(a => a.startsWith('--out='));
const VERBOSE = process.argv.includes('--verbose');

// 只包含扩展运行 + 安装说明；新增运行期文件时要在 manifest 中被引用才会被自动带上，
// 因此这里显式列出目录/文件，避免误把整个仓库打进去。
const INCLUDE = [
    'manifest.json',
    'background.js',
    'rules.json',
    'rules-engine.js',
    'immersive-rules.js',
    'content.js',
    'content.css',
    'options.html',
    'options.js',
    'README.md',
    'Basic'
];

function findTar() {
    const candidates = [
        'C:/Windows/System32/tar.exe',   // Windows 10+ bsdtar
        '/usr/bin/tar', '/bin/tar',      // 类 Unix
        'tar'
    ];
    for (const c of candidates) {
        const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
        if (r.status === 0 && /bsdtar|libarchive/i.test((r.stdout || '') + (r.stderr || ''))) return c;
    }
    return null;
}

function zipEntryNames(zipPath) {
    const r = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.split(/\r?\n/).filter(Boolean);
}

(async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const date = new Date().toISOString().slice(0, 10);
    const zipName = OUT_ARG ? OUT_ARG.slice('--out='.length) : `IMGX2-v${manifest.version}-${date}.zip`;
    const zipPath = path.isAbsolute(zipName) ? zipName : path.join(ROOT, zipName);

    const report = {
        test: 'pack',
        generatedAt: new Date().toISOString(),
        extensionVersion: manifest.version,
        zip: path.basename(zipPath),
        included: INCLUDE,
        checks: {},
        browserVerify: null
    };
    const results = [];
    const check = (name, pass, extra = '') => {
        report.checks[name] = pass;
        results.push(pass);
        console.log(`${pass ? 'PASS ✅' : 'FAIL ❌'} ${name}${extra ? ' — ' + extra : ''}`);
    };

    // ---------- 1) 打包前静态检查 ----------
    const missing = INCLUDE.filter(f => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) {
        console.error('❌ 待打包文件缺失:', missing.join(', '));
        process.exit(9);
    }

    const reservedAtRoot = INCLUDE.filter(f => f.startsWith('_'));
    check('待打包清单无 `_` 前缀根条目（Chromium 保留名）', reservedAtRoot.length === 0, reservedAtRoot.join(',') || 'ok');

    // manifest 引用完整性（防止打包后缺文件）
    const referenced = [manifest.background.service_worker];
    for (const cs of manifest.content_scripts || []) referenced.push(...(cs.js || []), ...(cs.css || []));
    for (const rr of (manifest.declarative_net_request?.rule_resources) || []) referenced.push(rr.path);
    const notIncluded = referenced.filter(f => !INCLUDE.includes(f) && !INCLUDE.includes(f.split('/')[0]));
    check('manifest 引用的文件都在打包清单内', notIncluded.length === 0, notIncluded.join(',') || `${referenced.length} 个引用`);

    // ---------- 2) 打包（bsdtar，保证正斜杠路径） ----------
    const tar = findTar();
    if (!tar) {
        console.error('❌ 未找到支持 zip 的 bsdtar（Windows 10+ 自带 C:/Windows/System32/tar.exe）');
        process.exit(9);
    }
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
    const packed = spawnSync(tar, ['-a', '-c', '-f', zipPath, ...INCLUDE], { cwd: ROOT, encoding: 'utf8' });
    if (packed.status !== 0) {
        console.error('❌ 打包失败:', (packed.stderr || '').slice(0, 400));
        process.exit(9);
    }
    const sizeKB = Math.round(fs.statSync(zipPath).size / 1024);
    console.log(`📦 已生成 ${path.basename(zipPath)} (${sizeKB} KB)`);

    // ---------- 3) 包内结构检查 ----------
    const names = zipEntryNames(zipPath);
    check('可读取包内条目列表', Array.isArray(names) && names.length > 0, names ? `${names.length} 个条目` : 'unzip 不可用');
    if (names) {
        const backslash = names.filter(n => n.includes('\\'));
        check('包内路径全部使用正斜杠（跨平台解压正确）', backslash.length === 0, backslash.slice(0, 3).join(',') || 'ok');

        const rootReserved = names.filter(n => n.split('/')[0].startsWith('_'));
        check('包内无 `_` 前缀根条目', rootReserved.length === 0, rootReserved.slice(0, 3).join(',') || 'ok');

        const forbidden = names.filter(n => /^(node_modules|\.git|docs|scripts|test-artifacts|_metadata|\.reasonix)\//.test(n)
            || /^\.(mcp\.json|gitignore)/.test(n) || n === 'reasonix.toml' || /\.zip$/.test(n));
        check('包内无开发/本机配置残留', forbidden.length === 0, forbidden.slice(0, 4).join(',') || 'ok');

        const hasBasic = names.some(n => n === 'Basic/mediaIdentity.js');
        check('Basic/mediaIdentity.js 已随包（v3.4.1 新增运行期文件）', hasBasic, hasBasic ? 'ok' : '缺失会导致 InputController 运行时报错');
        report.entryCount = names.length;
    }

    // ---------- 4) 解压 + 真实浏览器加载验证 ----------
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix01-pack-'));
    try {
        const unzip = spawnSync('unzip', ['-q', zipPath, '-d', extractDir], { encoding: 'utf8' });
        if (unzip.status !== 0) {
            check('解压包到临时目录', false, (unzip.stderr || '').slice(0, 200));
        } else {
            check('解压包到临时目录', true);
            // 解压后的 manifest 必须与源一致
            const zippedManifest = JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8'));
            check('包内 manifest 版本与源一致', zippedManifest.version === manifest.version,
                `${zippedManifest.version} vs ${manifest.version}`);

            if (!NO_VERIFY) {
                const exe = findBrowserExecutable();
                if (!exe) {
                    check('真实浏览器加载解压包', false, '未找到 Chrome/Edge');
                } else {
                    const load = await loadUnpackedViaCDP(exe, extractDir);
                    report.browserVerify = { browser: describeBrowser(exe), ...load, extractDir: path.basename(extractDir) };
                    check('真实浏览器加载解压包', load.ok, load.ok ? `extensionId=${load.id}` : String(load.error).slice(0, 180));
                }
            }
        }
        if (VERBOSE) console.log('解压目录:', extractDir);
    } finally {
        if (!VERBOSE) fs.rmSync(extractDir, { recursive: true, force: true });
    }

    // ---------- 5) 工件 ----------
    const failed = results.filter(r => !r).length;
    report.pass = failed === 0;
    report.zipSizeKB = sizeKB;
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    console.log(`\n===== 打包校验: ${results.length - failed}/${results.length} PASS =====`);
    console.log(`📦 ${path.basename(zipPath)}  (${sizeKB} KB)`);
    console.log(`🧾 工件: ${path.relative(ROOT, REPORT_PATH)}`);
    process.exit(failed ? 4 : 0);
})().catch(e => { console.error('❌ 打包脚本异常:', e && e.stack || e); process.exit(9); });
