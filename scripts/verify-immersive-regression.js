// 复现脚本：X.com 沉浸模式两个回归问题（无依赖，node scripts/verify-immersive-regression.js）
// 问题1：关注/订阅丢失 —— 时间线推文无直接关注按钮，沉浸守卫跳过 caret 菜单 → follow 返回 null
// 问题2：计数 1/2 → 1/3 → 1/4 —— 收集窗口增长 + 当前媒体匹配失败 → idx 回退为 0
(async function () {
    'use strict';
    let failed = 0;
    const check = (name, cond, extra = '') => {
        console.log((cond ? 'PASS ✅ ' : 'REPRO ❌ ') + name + (cond ? '' : ' ' + extra));
        if (!cond) failed++;
    };

    // ============ 问题 1：follow 决策链 ============
    // 模拟 X 时间线推文容器：作者区只有 caret（更多）按钮，没有 data-testid$="-follow" 直接按钮
    const timelineArticle = {
        querySelectorAll: (sel) => {
            if (sel.includes('follow') || sel.includes('subscribe') || sel.includes('SuperFollow')) return [];
            if (sel === 'button, [role="button"]') return [{ textContent: '···', getAttribute: () => 'More' }];
            return [];
        },
        querySelector: () => null,
        closest: () => null
    };
    const container = { querySelectorAll: () => [], querySelector: () => null, closest: () => null };

    // collectRelationControls：优先选择器为空 → fallback tightScope 也找不到关注按钮
    const collectRelationControls = (scope) => {
        const preferred = scope.querySelectorAll('button[data-testid$="-follow"], button[data-testid="follow"], button[data-testid="unfollow"], button[data-testid*="subscribe"], button[data-testid*="SuperFollow"]');
        if (preferred.length) return preferred;
        const tightScope = scope.querySelector?.('[data-testid="User-Name"]')?.closest?.('div') || scope;
        const nodes = (tightScope || scope).querySelectorAll('button, [role="button"]');
        return nodes.filter(el => /follow|following|unfollow|subscribe|订阅|关注/i.test(el.textContent + ' ' + el.getAttribute('aria-label')));
    };

    // resolveAuthorRelation 的 live 判定（时间线场景：无按钮 → live = null）
    const liveControls = collectRelationControls(timelineArticle);
    const live = liveControls.length ? 'following' : null;
    const cached = null; // 首次遇到该作者，缓存为空
    const isFollowed = live === 'following' ? true : (live === 'follow' ? false : (cached ? null : null));
    check('问题1: 时间线推文无直接关注按钮 → live=null（无法得知状态）', live === null && isFollowed === null);

    // follow 决策链（修复前）：toggleViaDirectButton 找不到按钮返回 null；沉浸守卫跳过 caret 菜单 → 最终 null
    const toggleViaDirectButton = () => null; // 无直接按钮
    const immersive = true;
    let caretMenuUsed = false;
    const toggleViaCaretMenu = async () => { caretMenuUsed = true; return true; };
    let result = toggleViaDirectButton();
    if (result === null && !immersive) { result = await toggleViaCaretMenu(); }
    check('问题1(修复前): 沉浸模式下 follow 跳过 caret 菜单 → 返回 null（无法关注/取消关注）',
        result === null && !caretMenuUsed, `result=${result}, caretMenuUsed=${caretMenuUsed}`);

    // 对照：非沉浸模式（修复前行为）会走 caret 菜单并成功
    let result2 = toggleViaDirectButton();
    if (result2 === null && !false) { result2 = await toggleViaCaretMenu(); }
    check('对照: 非沉浸模式 follow 走 caret 菜单 → 可关注', result2 === true && caretMenuUsed);

    // 修复后决策链：无论沉浸与否，用户主动 F 键的 follow 都允许 caret 菜单兜底
    caretMenuUsed = false;
    let resultFixed = toggleViaDirectButton();
    if (resultFixed === null) { resultFixed = await toggleViaCaretMenu(); }
    check('问题1(修复后): 沉浸模式 F 键恢复 caret 菜单兜底 → 可关注/取消关注',
        resultFixed === true && caretMenuUsed, `result=${resultFixed}, caretMenuUsed=${caretMenuUsed}`);

    // ============ 问题 2：计数索引回退 ============
    // 模拟 X 适配器 getGalleryImages 的收集窗口：滚动加载后窗口内媒体数 2 → 3 → 4
    // 且当前媒体因虚拟列表回收不在新收集列表中（匹配失败）
    const _normalizeAssetSrc = (src) => {
        if (!src || src.startsWith('blob:') || src.startsWith('mediasource:')) return '';
        try { const u = new URL(src); return u.origin + u.pathname; } catch (e) { return src.split('?')[0]; }
    };
    const _findGalleryIndex = (gallery, media, srcHint) => {
        if (!gallery || !gallery.length) return -1;
        if (media) {
            let idx = gallery.indexOf(media);
            if (idx !== -1) return idx;
            const src = media.currentSrc || media.src || '';
            const asset = _normalizeAssetSrc(src);
            if (asset) {
                idx = gallery.findIndex(m => _normalizeAssetSrc(m.currentSrc || m.src || '') === asset);
                if (idx !== -1) return idx;
            }
        }
        const asset = _normalizeAssetSrc(srcHint);
        if (asset) {
            const idx = gallery.findIndex(m => _normalizeAssetSrc(m.currentSrc || m.src || '') === asset);
            if (idx !== -1) return idx;
        }
        return -1;
    };

    // 场景：视频媒体（blob src 无法归一化，且节点被 X 回收重建 → 无 _mixStatusId）
    const mkVideo = (id) => ({ tagName: 'VIDEO', currentSrc: 'blob:https://x.com/video-' + id, src: 'blob:https://x.com/video-' + id });
    const currentMedia = mkVideo('current'); // 已被回收的旧节点（不在新窗口内）
    const gallery2 = [mkVideo('a'), mkVideo('b')];
    const gallery3 = [mkVideo('a'), mkVideo('b'), mkVideo('c')];
    const gallery4 = [mkVideo('a'), mkVideo('b'), mkVideo('c'), mkVideo('d')];

    // _updateGalleryCounter 的真实逻辑：idx >= 0 ? idx : 0 → 匹配失败显示 1/N
    const updateCounter = (gallery) => {
        const idx = _findGalleryIndex(gallery, currentMedia, currentMedia.currentSrc);
        return { display: `${(idx >= 0 ? idx : 0) + 1} / ${gallery.length}`, idx };
    };

    const c2 = updateCounter(gallery2);
    const c3 = updateCounter(gallery3);
    const c4 = updateCounter(gallery4);
    console.log(`问题2 复现输出(修复前): 窗口增长 ${c2.display} → ${c3.display} → ${c4.display}`);
    check('问题2(修复前): 匹配失败 idx=-1 但显示 1/N', c2.idx === -1 && c2.display === '1 / 2');
    check('问题2(修复前): 翻页后计数变为 1/3、1/4（分母增长、索引回退）',
        c3.display === '1 / 3' && c4.display === '1 / 4',
        `got ${c2.display} → ${c3.display} → ${c4.display}`);

    // 修复后：updateCounter 收到 idx=-1 时显示 "? / N"，不再误导
    const updateCounterFixed = (gallery) => {
        const idx = _findGalleryIndex(gallery, currentMedia, currentMedia.currentSrc);
        const current = idx >= 0 ? idx : -1;
        return { display: current < 0 ? `? / ${gallery.length}` : `${current + 1} / ${gallery.length}`, idx };
    };
    const f2 = updateCounterFixed(gallery2);
    const f3 = updateCounterFixed(gallery3);
    const f4 = updateCounterFixed(gallery4);
    console.log(`问题2 输出(修复后): 窗口增长 ${f2.display} → ${f3.display} → ${f4.display}`);
    check('问题2(修复后): 匹配失败显示 ? / N', f2.display === '? / 2' && f3.display === '? / 3' && f4.display === '? / 4',
        `got ${f2.display} → ${f3.display} → ${f4.display}`);
    // 匹配成功时仍显示真实索引（1 / 3 而非 ? / 3）：同一对象引用命中 indexOf
    const okGallery = [currentMedia, mkVideo('b'), mkVideo('c')];
    const ok = updateCounterFixed(okGallery);
    check('问题2(修复后): 匹配成功仍显示真实索引', ok.display === '1 / 3', `got ${ok.display}`);

    // ============ 问题 3：动作后回读被旧缓存覆盖，提示/状态与真实相反 ============
    // 场景：X 时间线（无直接关注按钮），用户按 F 执行"关注"
    // 旧缓存：follow（未关注）；动作：点击菜单 "Follow @x"（willBeIn=true）
    // 动作后 resolveAuthorRelation：live=null（无按钮）→ 回显旧缓存 follow → isFollowed=false
    const staleCacheEcho = { liveRelation: null, relation: 'follow', isFollowed: false, fromCache: true };
    const simulateAfterRead = () => staleCacheEcho; // 模拟时间线场景：永远无 live 信号

    // 旧逻辑（toggleViaCaretMenu 676-684 行）：after.relation 存在即信任 → 返回 false
    const oldToggleResult = (willBeIn, relationHint) => {
        const after = simulateAfterRead();
        if (after && after.relation) {
            const inNow = after.isFollowed === true;
            return inNow; // ← 返回 false：toast "已取消关注"，但实际执行的是关注！
        }
        return willBeIn;
    };
    const oldExecuted = oldToggleResult(true, 'following');
    check('问题3(修复前): 执行"关注"但回读旧缓存 → 返回 false（toast 已取消关注，实际已关注）',
        oldExecuted === false, `got ${oldExecuted}`);

    // 新逻辑：仅当 after.liveRelation（真实 DOM 信号）存在时才信任 after
    const newToggleResult = (willBeIn, relationHint) => {
        const after = simulateAfterRead();
        if (after && after.liveRelation) {
            const inNow = after.isFollowed === true;
            return inNow;
        }
        // 无 live 信号：信任刚执行的动作意图
        return willBeIn;
    };
    const newExecuted = newToggleResult(true, 'following');
    check('问题3(修复后): 无 live 信号时信任动作意图 → 返回 true（toast 已关注）',
        newExecuted === true, `got ${newExecuted}`);

    // 有 live 信号时仍以真实 DOM 为准（例如资料页按钮翻转）
    const liveFlip = { liveRelation: 'follow', relation: 'follow', isFollowed: false };
    const newWithLive = (() => {
        const after = liveFlip;
        if (after && after.liveRelation) {
            return after.isFollowed === true; // false：按钮仍显示"关注"→ 动作未生效
        }
        return true;
    })();
    check('问题3(修复后): 有 live 信号时以真实 DOM 为准', newWithLive === false);

    if (failed) {
        console.error(failed + ' check(s) failed');
        process.exit(1);
    }
    console.log('Both regressions reproduced as expected.');
})();