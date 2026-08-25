// 沉浸模式守卫逻辑验证脚本（无依赖，node scripts/verify-immersive-guard.js）
// 模拟 InputController.handleKeyDown 真实 else-if 分支顺序 + dismissMenus 的
// isDismissingMenu 标志机制，断言 6 个关键场景，全部通过则退出码 0。
(function () {
    'use strict';
    const window = {};
    window.__mix01State = {};
    let cfg = { state: { isImmersive: true }, keys: { immersive: 'ctrl+f12' } };

    // 与 Basic/InputController.js handleKeyDown 一致的分支顺序：
    // 1) matchCombo(immersive) 分支（2214 行，含 isDismissingMenu 守卫）
    // 2) else if Escape 分支（2337 行，含 isDismissingMenu 守卫）
    function handleKeyDown(e) {
        const combo = (e.ctrlKey ? 'ctrl+' : '') + e.key.toLowerCase();
        if (combo === cfg.keys.immersive) {
            if (window.__mix01State && window.__mix01State.isDismissingMenu) return 'IGNORED-TOGGLE';
            return cfg.state.isImmersive ? 'EXIT_TOGGLE' : 'ENTER_IMMERSIVE';
        } else if (e.key === 'Escape') {
            if (window.__mix01State && window.__mix01State.isDismissingMenu) return 'IGNORED-ESC';
            if (cfg.state.isImmersive) return 'EXIT_IMMERSIVE';
            return 'NOOP-ESC';
        }
        return 'NOOP';
    }

    // 与 immersive-rules.js dismissMenus 一致的标志机制（dispatchEvent 是同步的）
    function dismissMenus() {
        window.__mix01State = window.__mix01State || {};
        window.__mix01State.isDismissingMenu = true;
        const r = handleKeyDown({ key: 'Escape', ctrlKey: false });
        window.__mix01State.isDismissingMenu = false;
        return r;
    }

    const cases = [
        ['默认键 ctrl+f12, 沉浸中 dismissMenus', () => dismissMenus(), 'IGNORED-ESC',
            () => { cfg = { state: { isImmersive: true }, keys: { immersive: 'ctrl+f12' } }; }],
        ['自定义 esc 键, 沉浸中 dismissMenus', () => dismissMenus(), 'IGNORED-TOGGLE',
            () => { cfg = { state: { isImmersive: true }, keys: { immersive: 'escape' } }; }],
        ['自定义 esc 键, 非沉浸中 dismissMenus', () => dismissMenus(), 'IGNORED-TOGGLE',
            () => { cfg = { state: { isImmersive: false }, keys: { immersive: 'escape' } }; }],
        ['用户真实 Esc, 默认键, 沉浸中', () => handleKeyDown({ key: 'Escape', ctrlKey: false }), 'EXIT_IMMERSIVE',
            () => { cfg = { state: { isImmersive: true }, keys: { immersive: 'ctrl+f12' } }; }],
        ['用户真实 Esc=自定义沉浸键, 沉浸中', () => handleKeyDown({ key: 'Escape', ctrlKey: false }), 'EXIT_TOGGLE',
            () => { cfg = { state: { isImmersive: true }, keys: { immersive: 'escape' } }; }],
        ['用户真实 Esc=自定义沉浸键, 非沉浸中', () => handleKeyDown({ key: 'Escape', ctrlKey: false }), 'ENTER_IMMERSIVE',
            () => { cfg = { state: { isImmersive: false }, keys: { immersive: 'escape' } }; }],
    ];

    let failed = 0;
    for (const [name, fn, expect, setup] of cases) {
        setup();
        window.__mix01State.isDismissingMenu = undefined;
        const got = fn();
        const ok = got === expect;
        console.log((ok ? 'PASS ✅ ' : 'FAIL ❌ ') + name + (ok ? '' : ' got ' + got + ' want ' + expect));
        if (!ok) failed++;
    }
    if (failed) {
        console.error(failed + ' scenario(s) failed');
        process.exit(1);
    }
    console.log('All immersive-guard scenarios passed.');
})();
