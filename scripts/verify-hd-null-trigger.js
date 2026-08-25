// 回归：getHighResUrl 传入 null/undefined trigger 时不得抛 TypeError
// 背景：Utils._resolveDownloadUrl 按 src 反查 DOM 失败时传 null，
// X 视频 processor 直接读 trigger._mixStatusId 导致
// "Cannot read properties of null (reading '_mixStatusId')"。
const RESULTS = [];
function log(name, pass, extra = '') {
    RESULTS.push({ name, pass });
    console.log(`${pass ? 'PASS ✅' : 'FAIL ❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

// 最小 rules-engine 环境桩：只加载 Mix01Configs + processor 所需全局
global.window = {
    location: { hostname: 'x.com', pathname: '/user/status/1234567' },
    __mix01State: {},
};
global.document = { cookie: '' };
global.chrome = { runtime: { sendMessage: (msg, cb) => cb(undefined) } };
global.fetch = async () => { throw new Error('should not fetch in this test'); };

// 提取 rules-engine IIFE 并执行（文件以 (function(){...})() 包裹）
const fs = require('fs');
const path = require('path');
let code = fs.readFileSync(path.join(__dirname, '..', 'rules-engine.js'), 'utf8');

// LRUCache 桩（rules-engine 内部引用）
code = 'global.LRUCache = { get: () => undefined, set: () => {} };\n' + code;

try {
    eval(code);
} catch (e) {
    console.log('加载 rules-engine 失败:', e.message);
    process.exit(9);
}
const engine = global.window.Mix01RuleEngine || global.Mix01RuleEngine;
if (!engine) { console.log('Mix01RuleEngine 未暴露'); process.exit(9); }

(async () => {
    // 场景1：null trigger + 视频页 URL 路径 → 应走 pathname 提取 statusId，不抛错
    let ok = true, msg = '';
    try {
        const r = await engine.getHighResUrl(null, 'video/1234.mp4');
        msg = `返回=${r}`;
    } catch (e) { ok = false; msg = e.message; }
    log('R1 null trigger 不抛 TypeError', ok, msg.slice(0, 80));

    // 场景2：undefined trigger 同样安全
    ok = true;
    try {
        await engine.getHighResUrl(undefined, 'video/1234.mp4');
    } catch (e) { ok = false; msg = e.message; }
    log('R2 undefined trigger 不抛 TypeError', ok, String(msg).slice(0, 80));

    // 场景3：trigger 为断连节点（closest 可用但无 article）→ 安全降级
    const fakeNode = { _mixStatusId: '', closest: () => null, src: '' };
    ok = true;
    try {
        const r = await engine.getHighResUrl(fakeNode, 'video/999.mp4');
        msg = `返回=${r}`;
    } catch (e) { ok = false; msg = e.message; }
    log('R3 断连节点安全降级', ok, String(msg).slice(0, 80));

    // 场景4：图片 URL 正则规则不受影响（twimg media → orig）
    try {
        const r = await engine.getHighResUrl(null, 'https://pbs.twimg.com/media/ABC123?format=jpg&name=small');
        ok = r.includes('name=orig');
        msg = r;
    } catch (e) { ok = false; msg = e.message; }
    log('R4 twimg 图片 orig 升级仍正常', ok, String(msg).slice(0, 90));

    // 场景5：带 _mixStatusId 的正常节点仍走绑定路径
    const bound = { _mixStatusId: '777', closest: () => null, src: 'blob:x' };
    // fetch 会 throw（桩），processor 应捕获并降级返回 trigger.src，不外抛
    try {
        const r = await engine.getHighResUrl(bound, '');
        ok = r === 'blob:x';
        msg = `降级返回=${r}`;
    } catch (e) { ok = false; msg = e.message; }
    log('R5 绑定节点解析失败时降级到 trigger.src', ok, String(msg).slice(0, 80));

    const failed = RESULTS.filter(r => !r.pass);
    console.log(`\n===== 高清升级判空回归: ${RESULTS.length - failed.length}/${RESULTS.length} PASS =====`);
    process.exit(failed.length ? 4 : 0);
})();
