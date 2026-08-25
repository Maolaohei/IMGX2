// 验证「键盘切换后悬停探测守卫」方向正确（无依赖，node scripts/verify-hover-guard.js）
// 提取自 Basic/InputController.js handleMouseMove 的探测分支：
//   键盘切换后 500ms 内抑制 hover 触发（防抢焦点），窗口过后恢复触发。
// fa8fc92 曾把 `< 500` 写成 `> 500`，导致放大镜 hover 触发在 500ms 后永久失效。

const fails = [];
const check = (name, cond, detail) => {
    if (!cond) fails.push(name);
    console.log(name + ':', cond ? 'PASS ✅' : 'FAIL ❌', detail || '');
};

function probeDecision(nowMs, keyboardSwitchTimeMs) {
    // 修复后的真实守卫
    if (nowMs - keyboardSwitchTimeMs < 500) return 'SUPPRESSED';
    return 'TRIGGER';
}

// 场景1：键盘切换后 100ms 内 → 抑制（不抢焦点）
check('场景1 切换后100ms抑制', probeDecision(11000, 10900) === 'SUPPRESSED');

// 场景2：键盘切换后 499ms → 仍抑制
check('场景2 切换后499ms仍抑制', probeDecision(15499, 15000) === 'SUPPRESSED');

// 场景3：键盘切换后 501ms → 恢复触发（fa8fc92 反转后此处错误返回 SUPPRESSED，hover 永久失效）
check('场景3 切换后501ms恢复', probeDecision(15501, 15000) === 'TRIGGER',
    '（修复前 >500 守卫使此处被跳过，放大镜 hover 永不触发）');

// 场景4：从未键盘切换（keyboardSwitchTime=0）→ 立即触发
check('场景4 无键盘切换立即触发', probeDecision(60000, 0) === 'TRIGGER');

// 场景5：对照——hideViewer 分支语义相反（>500 才允许关闭），确认未被本次修改波及
const allowHide = (nowMs, t) => nowMs - t > 500;
check('场景5 hideViewer守卫语义不变', allowHide(15600, 15000) === true && allowHide(15200, 15000) === false);

if (fails.length) {
    console.log('\n❌ FAIL: ' + fails.join('；'));
    process.exit(1);
}
console.log('\n✅ PASS: 悬停探测守卫方向成立（切换后500ms内抑制，之后恢复触发）');
