// 验证「窗口内页码 + 滚动保持当前媒体身份不跳变」（无依赖，node scripts/verify-gallery-anchor.js）
// 提取自 immersive-rules.js getGalleryImages 的窗口判定逻辑：
//   旧方案：窗口以视口为锚（topBound=-2.5vh, bottomBound=+3.5vh，视口坐标）
//   新方案：窗口以当前媒体为锚（anchor.top-2.5vh ~ anchor.bottom+3.5vh）
// seed 保留条件：media.top >= topBound && media.bottom <= bottomBound（视口坐标）
// 数学等价：媒体锚窗口在文档坐标系中固定（scrollY 在上下界中抵消），
// 滚动后当前媒体索引/总数不变 → 页码不跳变；视口锚窗口随滚动滑动 → 页码重置。

const VH = 1000;          // 视口高度
const SPACING = 600;      // 媒体间距（文档坐标）
const MH = 400;           // 媒体高度
const DOC_MEDIA = 12;     // 文档中媒体总数（含下方未加载的部分）

const docTop = (i) => i * SPACING;

// seed 窗口判定：返回 { idx, total }——当前媒体在窗口中的位置
function windowIndex(windowTopBound, windowBottomBound, scrollY, curIdx) {
    const kept = [];
    for (let i = 0; i < DOC_MEDIA; i++) {
        const top = docTop(i) - scrollY;      // 视口坐标
        const bottom = top + MH;
        if (top >= windowTopBound && bottom <= windowBottomBound) kept.push(i);
    }
    const idx = kept.indexOf(curIdx);
    return { idx, total: kept.length };
}

// 场景：当前媒体 = 第 5 个（curIdx=4），初始 scrollY 使其位于视口中心
const curIdx = 4;
const scrollY0 = docTop(curIdx) + MH / 2 - VH / 2; // 2400 + 200 - 500 = 2100 → top=300（近中心）
// 边界翻页：scrollBy 1.5vh = 1500
const scrollY1 = scrollY0 + 1500;

// 旧方案（视口锚，修复前）
const old0 = windowIndex(-VH * 2.5, VH * 3.5, scrollY0, curIdx);
const old1 = windowIndex(-VH * 2.5, VH * 3.5, scrollY1, curIdx);

// 新方案（媒体锚，修复后）：窗口 = [cur.top - 2.5vh, cur.bottom + 3.5vh]
const anchorWindow = (scrollY) => {
    const curTop = docTop(curIdx) - scrollY;
    return [curTop - VH * 2.5, curTop + MH + VH * 3.5];
};
// 锚点 clamp（immersive-rules.js getGalleryImages 修复）：当前媒体滚出视口较远时
// 把锚点中心夹回视口附近（±1.5vh ≥ 边界翻页位移 1.5vh，正常翻页不触发），
// 避免锚定窗口整体偏离用户可见区域。
const clampAnchor = (curTop) => {
    const center = Math.max(Math.min(curTop + MH / 2, VH * 1.5), -VH * 1.5);
    return { top: center - MH / 2, bottom: center + MH / 2 };
};

const new0 = windowIndex(...anchorWindow(scrollY0), scrollY0, curIdx);
const new1 = windowIndex(...anchorWindow(scrollY1), scrollY1, curIdx);
// 正常边界翻页（scrollBy 1.5vh → curTop≈-1.2vh）：锚点经 clamp 后必须不变
// （中心钳制阈值 ±1.5vh ≥ 1.5vh 位移），页码保持稳定不回归。
const clampedAnchor1 = clampAnchor(docTop(curIdx) - scrollY1);
const new1Clamped = windowIndex(
    clampedAnchor1.top - VH * 2.5, clampedAnchor1.bottom + VH * 3.5,
    scrollY1, curIdx
);

console.log('边界翻页（scrollBy 1.5vh）后页码变化：');
console.log('  旧方案(视口锚):', `${old0.idx + 1}/${old0.total} → ${old1.idx + 1}/${old1.total}`,
    old0.idx !== old1.idx ? '→ ❌ 页码跳变（窗口起点随视口滑动重置）' : '');
console.log('  新方案(媒体锚):', `${new0.idx + 1}/${new0.total} → ${new1.idx + 1}/${new1.total}`,
    new0.idx === new1.idx && new0.total === new1.total ? '→ ✅ 页码稳定（窗口在文档坐标系固定）' : '');
console.log('  新方案+clamp(正常翻页):', `${new0.idx + 1}/${new0.total} → ${new1Clamped.idx + 1}/${new1Clamped.total}`,
    new1Clamped.idx === new1.idx && new1Clamped.total === new1.total ? '→ ✅ clamp 不干扰正常翻页' : '');

const fails = [];
if (old0.idx === old1.idx) fails.push('旧方案未复现跳变（模拟场景失效，需检查公式）');
if (new0.idx !== new1.idx || new0.total !== new1.total) fails.push('新方案页码在滚动后仍变化（锚定修复未生效）');
if (new0.idx !== curIdx) fails.push('新方案当前媒体索引计算异常（idx=' + new0.idx + ', 期望 ' + curIdx + '）');
if (new1Clamped.idx !== new1.idx || new1Clamped.total !== new1.total) fails.push('clamp 干扰了正常边界翻页页码（阈值过窄）');

// 进入沉浸起点：选视口中心最近媒体（InputController.js 修复后逻辑）
function pickViewportCenterMedia(mediaTops, centerY) {
    let best = 0, minDiff = Infinity;
    for (let i = 0; i < mediaTops.length; i++) {
        const diff = Math.abs(mediaTops[i] + MH / 2 - centerY);
        if (diff < minDiff) { minDiff = diff; best = i; }
    }
    return best;
}
// 窗口内 8 个媒体，视口中心落在第 4 个上；修复前选 gallery[0]（恒 1），修复后应选第 4 个
const tops = [100, 700, 1300, 1900, 2500, 3100, 3700, 4300];
const centerPick = pickViewportCenterMedia(tops, 2100); // 1900+200=2100 → idx 3
console.log('\n进入沉浸起点（视口中心最近媒体）: pick=' + (centerPick + 1) + '/8, 修复前恒为 1/8',
    centerPick === 3 ? '→ ✅ 从实际看到的媒体开始计数' : '');
if (centerPick !== 3) fails.push('视口中心媒体选择异常（pick=' + centerPick + '）');

// 锚点 clamp 场景：当前媒体滚出视口下方 3.5vh（curTop=3500），未 clamp 窗口
// 顶界 1000 > 视口中心 500（偏离），clamp 后窗口 [-1200, 5200] 覆盖视口
{
    const curTop = VH * 3.5; // 视口坐标：视口下方 3.5vh
    const clamped = clampAnchor(curTop);
    const [tb, bb] = [clamped.top - VH * 2.5, clamped.bottom + VH * 3.5];
    // 视口中心（500）必须在窗口内
    const coversViewport = tb <= VH / 2 && bb >= VH / 2;
    const unclamped = [curTop - VH * 2.5, curTop + MH + VH * 3.5];
    const offscreen = unclamped[0] > VH / 2 || unclamped[1] < VH / 2;
    console.log('\n锚点 clamp（媒体滚出视口下方 3.5vh）: clamp后窗口 [' + tb + ', ' + bb + '] 覆盖视口中心=' + coversViewport +
        ', 未clamp窗口 [' + unclamped[0] + ', ' + unclamped[1] + '] 偏离=' + offscreen,
        coversViewport && offscreen ? '→ ✅ clamp 生效（窗口被拉回可见区域）' : '');
    if (!coversViewport || !offscreen) fails.push('锚点 clamp 场景异常');
}

if (fails.length) {
    console.log('\n❌ FAIL: ' + fails.join('；'));
    process.exit(1);
}
console.log('\n✅ PASS: 锚定窗口页码 + 视口中心起点均成立（滚动页码不跳变）');
