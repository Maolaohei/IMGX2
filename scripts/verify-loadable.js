// scripts/verify-loadable.js
// 「扩展可被 Chrome/Edge 加载」回归验证
//
// 背景（真实事故）：测试工件曾写在扩展根目录的 `_metadata/` 下。Chromium 的
// unpacked 加载器拒绝扩展根目录里任何 `_` 开头的条目（`_metadata` 也不豁免）：
//   Cannot load extension with file or directory name _metadata.
//   Filenames starting with "_" are reserved for use by the system.
// 静态检查能挡住 99% 的情况，但「能不能真的加载」必须由浏览器说了算——
// 本脚本用 CDP `Extensions.loadUnpacked`（与 chrome://extensions 的
// 「加载已解压的扩展程序」同一代码路径）做端到端验证。
//
// 用法：
//   node scripts/verify-loadable.js            # 静态检查 + 真实浏览器加载
//   node scripts/verify-loadable.js --static   # 仅静态检查（无浏览器环境时）
// 工件：test-artifacts/loadable-report.json
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
    ROOT, findBrowserExecutable, describeBrowser, loadUnpackedViaCDP
} = require('./lib/mix01-harness');

const REPORT_PATH = path.join(ROOT, 'test-artifacts', 'loadable-report.json');
const STATIC_ONLY = process.argv.includes('--static');

const RESULTS = [];
function log(name, pass, extra = '') {
    RESULTS.push({ name, pass, extra });
    console.log(`${pass ? 'PASS ✅' : 'FAIL ❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

// 加载器会把带 `_` 前缀的根条目判为保留名（大小写不敏感），
// 唯一例外：Chrome 自己生成的 DNR 索引规则集目录 `_metadata/`。
// 但该豁免要求 `_metadata/` 内容恰好是 Chrome 自己的布局——
// 一旦里面出现其它文件（例如把测试报表写进去），豁免立即失效并报：
//   Cannot load extension with file or directory name _metadata.
const RESERVED = /^_/;
const CHROME_METADATA_DIR = '_metadata';
const CHROME_INDEX_DIR = 'generated_indexed_rulesets';

/**
 * 扫描根目录保留名违规。
 * @returns {{violations: Array, chromeGenerated: boolean, foreignFiles: string[]}}
 */
function scanReservedEntries(root) {
    const violations = [];
    const foreignFiles = [];
    let chromeGenerated = false;

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!RESERVED.test(entry.name)) continue;

        if (entry.name === CHROME_METADATA_DIR && entry.isDirectory()) {
            // `_metadata` 是 Chrome 管理目录：只允许 generated_indexed_rulesets/<ruleset 索引>
            const inner = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true });
            const unexpected = inner.filter(e => e.name !== CHROME_INDEX_DIR);
            if (unexpected.length) {
                foreignFiles.push(...unexpected.map(e => `${entry.name}/${e.name}`));
                violations.push({ name: entry.name, dir: true, reason: 'Chrome 豁免失效：目录内出现非 Chrome 生成的文件' });
            } else {
                const indexDir = path.join(root, entry.name, CHROME_INDEX_DIR);
                const indexEntries = fs.existsSync(indexDir) ? fs.readdirSync(indexDir) : [];
                if (indexEntries.length > 0) chromeGenerated = true;
            }
            continue;
        }

        violations.push({ name: entry.name, dir: entry.isDirectory(), reason: '保留名（下划线前缀）' });
    }

    return { violations, chromeGenerated, foreignFiles };
}

// 真实浏览器加载验证复用共享实现（scripts/lib/mix01-harness.js），避免两份拷贝漂移
(async () => {
    const report = {
        test: 'verify-loadable',
        generatedAt: new Date().toISOString(),
        extensionRoot: ROOT,
        checks: RESULTS,
        staticScan: null,
        browserLoad: null
    };

    // ---------- 1) 静态检查：根目录不得有 `_` 前缀条目 ----------
    // （例外：Chrome 自己生成的 _metadata/generated_indexed_rulesets/）
    const scan = scanReservedEntries(ROOT);
    report.staticScan = {
        violations: scan.violations,
        chromeGeneratedMetadata: scan.chromeGenerated,
        foreignFilesInMetadata: scan.foreignFiles
    };
    log('静态: 扩展根目录无违规保留名条目',
        scan.violations.length === 0,
        scan.violations.length
            ? scan.violations.map(v => `${v.name}${v.dir ? '/' : ''}（${v.reason}）`).join(', ')
            : (scan.chromeGenerated ? '_metadata 仅含 Chrome 生成的索引规则集 ✓' : 'ok'));

    // ---------- 1a) 防止再次把工件写进 _metadata ----------
    const scriptDir = path.join(ROOT, 'scripts');
    const offenders = [];
    const walkScripts = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walkScripts(full); continue; }
            if (!entry.name.endsWith('.js')) continue;
            const src = fs.readFileSync(full, 'utf8');
            for (const line of src.split(/\r?\n/)) {
                const code = line.replace(/\/\/.*$/, '');
                if (/['"]_metadata['"]/.test(code) && /path\.join|writeFileSync|mkdirSync/.test(code)) {
                    offenders.push(path.relative(ROOT, full) + ': ' + line.trim().slice(0, 70));
                }
            }
        }
    };
    walkScripts(scriptDir);
    report.metadataWriteGuards = offenders;
    log('静态: 测试脚本不向扩展目录内写保留名路径', offenders.length === 0, offenders.join(' | '));

    // ---------- 1b) 顺带确认 manifest 引用的文件都真实存在 ----------
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const referenced = [];
    referenced.push(manifest.background.service_worker);
    for (const cs of manifest.content_scripts || []) referenced.push(...(cs.js || []), ...(cs.css || []));
    for (const rr of (manifest.declarative_net_request?.rule_resources) || []) referenced.push(rr.path);
    const missing = referenced.filter(f => !fs.existsSync(path.join(ROOT, f)));
    log('静态: manifest 引用的文件全部存在', missing.length === 0, missing.join(', ') || `${referenced.length} 个文件`);

    // ---------- 1c) content_scripts 顺序：依赖必须先加载 ----------
    const cs = (manifest.content_scripts || [])[0] || { js: [] };
    const idx = (f) => cs.js.indexOf(f);
    const orderOk = idx('Basic/mediaIdentity.js') >= 0 &&
        idx('Basic/mediaIdentity.js') < idx('Basic/InputController.js') &&
        idx('Basic/ConfigManager.js') < idx('Basic/MediaRenderer.js') &&
        idx('Basic/MediaRenderer.js') < idx('Basic/InputController.js');
    log('静态: content_scripts 依赖顺序正确', orderOk, cs.js.join(' → '));

    // ---------- 2) 端到端：真实浏览器 loadUnpacked ----------
    if (STATIC_ONLY) {
        console.log('\n(--static: 跳过真实浏览器加载验证)');
    } else {
        const exe = findBrowserExecutable();
        if (!exe) {
            log('端到端: 真实浏览器 loadUnpacked', false, '未找到 Chrome/Edge 可执行文件');
        } else {
            const load = await loadUnpackedViaCDP(exe, ROOT);
            report.browserLoad = { browser: describeBrowser(exe), ...load };
            log('端到端: 真实浏览器 loadUnpacked 成功', load.ok,
                load.ok ? `extensionId=${load.id}` : String(load.error).slice(0, 180));
        }
    }

    const failed = RESULTS.filter(r => !r.pass);
    report.pass = failed.length === 0;
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    console.log(`\n===== 扩展可加载性: ${RESULTS.length - failed.length}/${RESULTS.length} PASS =====`);
    console.log(`🧾 工件: ${path.relative(ROOT, REPORT_PATH)}`);
    process.exit(failed.length ? 4 : 0);
})().catch(e => { console.error('❌ 脚本异常:', e && e.stack || e); process.exit(9); });
