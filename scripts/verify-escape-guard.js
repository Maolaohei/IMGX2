// 验证「合成 Escape 守卫」：dismissMenus 派发的合成 Escape 不得触发沉浸模式退出
// （无依赖，node scripts/verify-escape-guard.js）
// 提取自修复后的实现：
//   immersive-rules.js dismissMenus：派发前设置 window.__mix01State.isDismissingMenu = true，
//   派发（同步）完成后立即复位；
//   Basic/InputController.js handleKeyDown Escape 分支：isDismissingMenu 为 true 时
//   直接 return（不执行 exitImmersive），真实 Escape 照常退出沉浸。

const window = {};
window.__mix01State = {};
const cfg = { state: { isImmersive: true } };
let exitCount = 0;

// InputController.js Escape 分支（修复后，同步语义）
function handleEscape() {
    if (window.__mix01State && window.__mix01State.isDismissingMenu) {
        return 'IGNORED'; // 合成 Escape：只关 X 菜单，不退出沉浸
    }
    if (cfg.state.isImmersive) {
        exitCount += 1;
        return 'EXIT';
    }
    return 'NOOP';
}

// immersive-rules.js dismissMenus（修复后，同步语义）
function dismissMenus() {
    window.__mix01State = window.__mix01State || {};
    window.__mix01State.isDismissingMenu = true;
    const result = handleEscape(); // 合成 Escape 同步派发期间 InputController 的处理结果
    window.__mix01State.isDismissingMenu = false;
    return result;
}

const fails = [];
const check = (name, cond, detail) => {
    if (!cond) fails.push(name);
    console.log(name + ':', cond ? 'PASS ✅' : 'FAIL ❌', detail || '');
};

// 场景 1：沉浸模式中 dismissMenus 的合成 Escape → 不退出沉浸（修复核心）
const r1 = dismissMenus();
check('场景1 沉浸中合成Escape不退出', r1 === 'IGNORED' && exitCount === 0,
    'result=' + r1 + ', exitCount=' + exitCount + '（修复前会 EXIT 并退出沉浸）');

// 场景 2：用户真实按 Esc（标志未设置）→ 正常退出沉浸
const r2 = handleEscape();
check('场景2 真实Escape退出沉浸', r2 === 'EXIT' && exitCount === 1, 'result=' + r2);

// 场景 3：非沉浸模式，合成 Escape → 守卫短路（无副作用，X 菜单照常关闭）
cfg.state.isImmersive = false;
const r3 = dismissMenus();
check('场景3 非沉浸合成Escape无副作用', r3 === 'IGNORED' && exitCount === 1, 'result=' + r3);

// 场景 4：合成 Escape 不影响 X 自己的监听器（事件照常派发，本模拟中 handleEscape
// 每次调用都会执行——守卫只拦 InputController 分支，不阻止事件本身）
cfg.state.isImmersive = true;
window.__mix01State.isDismissingMenu = true;
const r4 = handleEscape();
window.__mix01State.isDismissingMenu = false;
check('场景4 守卫只拦逻辑不吞事件', r4 === 'IGNORED' && exitCount === 1, 'result=' + r4);

// ============ 完整分支链（InputController.handleKeyDown 真实顺序）============
// matchCombo(immersive) 分支先于 Escape 分支：自定义沉浸键为裸 escape 时，
// 合成 Escape 必须先被 matchCombo 分支的守卫拦下（双向误触：退出/进入沉浸）。
let enterCount = 0;
function handleKeyDown(key, ctrlKey) {
    const combo = (ctrlKey ? 'ctrl+' : '') + key.toLowerCase();
    if (combo === cfg.keys.immersive) { // 2214 分支（修复后带守卫）
        if (window.__mix01State && window.__mix01State.isDismissingMenu) {
            return 'IGNORED-TOGGLE';
        }
        if (cfg.state.isImmersive) {
            exitCount += 1;
            cfg.state.isImmersive = false;
            return 'EXIT_TOGGLE';
        }
        enterCount += 1;
        cfg.state.isImmersive = true;
        return 'ENTER_IMMERSIVE';
    }
    if (key === 'Escape') { // 2346 分支（修复后带守卫）
        if (window.__mix01State && window.__mix01State.isDismissingMenu) {
            return 'IGNORED-ESC';
        }
        if (cfg.state.isImmersive) {
            exitCount += 1;
            cfg.state.isImmersive = false;
            return 'EXIT_IMMERSIVE';
        }
        return 'NOOP-ESC';
    }
    return 'NOOP';
}
// dismissMenus 完整流程（含守卫）
function dismissMenusFull() {
    window.__mix01State = window.__mix01State || {};
    window.__mix01State.isDismissingMenu = true;
    const r = handleKeyDown('Escape', false); // 合成 Escape：无 ctrl
    window.__mix01State.isDismissingMenu = false;
    return r;
}

// 场景 5：自定义沉浸键 = 裸 escape，沉浸中 dismissMenus → 守卫拦下（不退出）
cfg.keys = { immersive: 'escape' };
cfg.state.isImmersive = true;
exitCount = 0;
const r5 = dismissMenusFull();
check('场景5 自定义escape键+沉浸中合成Escape不退出', r5 === 'IGNORED-TOGGLE' && exitCount === 0 && cfg.state.isImmersive === true,
    'result=' + r5 + ', exitCount=' + exitCount + '（修复前会 EXIT_TOGGLE 退出沉浸）');

// 场景 6：自定义沉浸键 = 裸 escape，非沉浸中 dismissMenus → 守卫拦下（不误入沉浸）
cfg.state.isImmersive = false;
enterCount = 0;
const r6 = dismissMenusFull();
check('场景6 自定义escape键+非沉浸中合成Escape不误入', r6 === 'IGNORED-TOGGLE' && enterCount === 0 && cfg.state.isImmersive === false,
    'result=' + r6 + ', enterCount=' + enterCount + '（修复前会 ENTER_IMMERSIVE 误入沉浸）');

// 场景 7：自定义沉浸键 = 裸 escape，用户真实按 Esc（非合成）→ 正常退出沉浸
cfg.state.isImmersive = true;
exitCount = 0;
const r7 = handleKeyDown('Escape', false);
check('场景7 自定义escape键+真实Escape退出沉浸', r7 === 'EXIT_TOGGLE' && exitCount === 1 && cfg.state.isImmersive === false,
    'result=' + r7);

// 场景 8：默认键 ctrl+f12，合成 Escape（无 ctrl）不匹配沉浸键 → 走 Escape 分支守卫
cfg.keys = { immersive: 'ctrl+f12' };
cfg.state.isImmersive = true;
exitCount = 0;
const r8 = dismissMenusFull();
check('场景8 默认键+合成Escape不退出', r8 === 'IGNORED-ESC' && exitCount === 0, 'result=' + r8);

if (fails.length) {
    console.log('\n❌ FAIL: ' + fails.join('；'));
    process.exit(1);
}
console.log('\n✅ PASS: 合成 Escape 守卫成立（菜单关闭不退出沉浸，真实 Esc 正常退出）');
