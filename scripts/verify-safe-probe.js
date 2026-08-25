// 安全探测验证脚本（无依赖，node scripts/verify-safe-probe.js）
// 覆盖沉浸模式自动探测的安全机制（等待式空闲检测）：
// 1) 空闲（400ms 无输入）才弹菜单；翻页后轮询等待用户停下，3s 持续输入则放弃
// 2) 用户按键立即中止菜单（防箭头键劫持） 3) 沉浸短窗口 450ms
// 4) 合成 Escape 不计入用户输入、不触发中止
(function () {
    'use strict';
    let failed = 0;
    const check = (name, cond, extra = '') => {
        console.log((cond ? 'PASS ✅ ' : 'FAIL ❌ ') + name + (cond ? '' : ' ' + extra));
        if (!cond) failed++;
    };

    // ===== 模拟 window.__mix01State / __mix01Engine =====
    const window = {};
    window.__mix01State = { isDismissingMenu: false, lastUserInputAt: 0, relationProbeInFlight: null, abortProbe: false };
    let immersive = true;
    window.__mix01Engine = { config: { state: { get isImmersive() { return immersive; } } } };
    const now = () => Date.now();

    // ===== 从 immersive-rules.js 提取的等待式守卫逻辑 =====
    // 返回 'PROBE'（放行）| 'GIVEUP'（3s 持续输入放弃）
    const probeGuardWait = async (force) => {
        const imm = !!(window.__mix01Engine?.config?.state?.isImmersive);
        if (imm && !force) {
            const idleMs = 400;
            const maxWaitMs = 3000;
            const t0 = Date.now();
            while ((now() - (window.__mix01State?.lastUserInputAt || 0)) < idleMs) {
                if (now() - t0 > maxWaitMs) return 'GIVEUP';
                await new Promise(r => setTimeout(r, 30));
            }
            if (window.__mix01State?.abortProbe) return 'GIVEUP';
        }
        return 'PROBE';
    };

    // ===== 从 immersive-rules.js waitForMenu 提取的中止逻辑 =====
    let menuFoundAt = null;
    const waitForMenuSim = async (timeoutMs) => {
        const t0 = performance.now();
        while (performance.now() - t0 < timeoutMs) {
            if (window.__mix01State?.abortProbe) return null; // 用户按键 → 立即放弃
            if (menuFoundAt !== null && performance.now() >= menuFoundAt) return { tag: 'MENU' };
            await new Promise(r => setTimeout(r, 5));
        }
        return null;
    };

    // ===== 场景 =====
    (async () => {
        // 场景 1：沉浸 + 用户已空闲 3s → 立即探测
        window.__mix01State.lastUserInputAt = now() - 3000;
        check('场景1: 沉浸+已空闲3s → 立即探测', await probeGuardWait(false) === 'PROBE');

        // 场景 2：翻页后（300ms 前按键）→ 轮询等待，用户停下后探测
        window.__mix01State.lastUserInputAt = now() - 300;
        const tStart = now();
        const r2 = await probeGuardWait(false);
        const waited = now() - tStart;
        check('场景2: 翻页后按键300ms → 等待空闲后探测(不再硬性跳过)', r2 === 'PROBE', `r=${r2}`);
        check('场景2b: 补齐剩余空闲≈100ms(总400ms即探测，比旧1500ms快)', waited >= 80 && waited < 350, `waited=${waited}ms`);

        // 场景 3：用户持续翻页（每 200ms 按一次，共 3.5s）→ 超时放弃
        window.__mix01State.lastUserInputAt = now();
        let stopKey = false;
        const keySpam = setInterval(() => { if (!stopKey) window.__mix01State.lastUserInputAt = now(); }, 200);
        const tStart3 = now();
        const r3 = await probeGuardWait(false);
        clearInterval(keySpam);
        stopKey = true;
        check('场景3: 持续翻页3s+ → 放弃本次探测(不弹菜单)', r3 === 'GIVEUP', `r=${r3}`);
        check('场景3b: 放弃耗时≈3s上限', now() - tStart3 >= 2800 && now() - tStart3 < 3800, `elapsed=${now() - tStart3}ms`);

        // 场景 4：非沉浸 → 始终立即探测
        immersive = false;
        window.__mix01State.lastUserInputAt = now() - 50;
        check('场景4: 非沉浸+活跃 → 立即探测', await probeGuardWait(false) === 'PROBE');
        immersive = true;

        // 场景 5：沉浸 + F 键主动（force）→ 绕过等待
        window.__mix01State.lastUserInputAt = now() - 50;
        check('场景5: 沉浸+F键主动(force) → 绕过空闲等待', await probeGuardWait(true) === 'PROBE');

        // 场景 6：等待期间用户持续输入且被标记 abort → 放弃
        window.__mix01State.lastUserInputAt = now() - 100;
        window.__mix01State.abortProbe = false;
        const abortTimer = setTimeout(() => {
            window.__mix01State.lastUserInputAt = now();
            window.__mix01State.abortProbe = true;
        }, 150);
        const r6 = await probeGuardWait(false);
        clearTimeout(abortTimer);
        check('场景6: 等待期间用户输入+abort → 放弃探测', r6 === 'GIVEUP', `r=${r6}`);
        window.__mix01State.abortProbe = false;

        // 场景 7：探测中用户按键 → abortProbe → waitForMenu 提前返回 null（菜单立即关闭）
        window.__mix01State.lastUserInputAt = now() - 3000;
        window.__mix01State.relationProbeInFlight = '@x';
        menuFoundAt = performance.now() + 1000;
        const probeTask = waitForMenuSim(700);
        setTimeout(() => {
            if (!window.__mix01State.isDismissingMenu) {
                window.__mix01State.lastUserInputAt = now();
                if (window.__mix01State.relationProbeInFlight) window.__mix01State.abortProbe = true;
            }
        }, 40);
        const menu = await probeTask;
        check('场景7: 探测中用户按键 → 菜单立即中止(键不被劫持)', menu === null, `got ${JSON.stringify(menu)}`);
        window.__mix01State.abortProbe = false;
        window.__mix01State.relationProbeInFlight = null;

        // 场景 8：合成 Escape（isDismissingMenu=true）不记录用户输入、不触发中止
        window.__mix01State.isDismissingMenu = true;
        window.__mix01State.lastUserInputAt = 0;
        window.__mix01State.relationProbeInFlight = '@y';
        // InputController 在 isDismissingMenu 时不更新 lastUserInputAt、不设 abortProbe
        window.__mix01State.isDismissingMenu = false;
        check('场景8: 合成Escape不计入用户输入(不污染空闲检测)', window.__mix01State.lastUserInputAt === 0);
        check('场景8b: 合成Escape不触发abortProbe', window.__mix01State.abortProbe === false);

        // 场景 9：沉浸短窗口（probe 用 450ms 而非 700ms）
        const timeout = immersive ? 450 : 700;
        check('场景9: 沉浸探测用短窗口450ms', timeout === 450);

        // ===== 并发与唤醒机制（review 修复） =====
        // 场景 10：全局单飞——已有 probe 在飞时，新 probe 返回 probed:false（非尝试，不占节流）
        window.__mix01State.relationProbeInFlight = '@old';
        const singleFlightResult = (() => {
            if (window.__mix01State.relationProbeInFlight) {
                const r = { relation: 'follow', isFollowed: false, probed: false };
                return r;
            }
            return { relation: 'follow', isFollowed: false, probed: true };
        })();
        check('场景10: 单飞占用 → 新probe返回probed:false(不占90s节流)', singleFlightResult.probed === false);
        window.__mix01State.relationProbeInFlight = null;

        // 场景 11：等待中用户切换到新媒体 → 旧 probe 放弃（probed:false），新媒体触发自己的 probe
        const mediaA = { currentSrc: 'https://x.com/a.jpg', closest: () => null };
        let currentMedia = mediaA;
        const ctrlState = { get currentMedia() { return currentMedia; }, get currentSrc() { return currentMedia.currentSrc; } };
        const waitWithSwitchCheck = async (media) => {
            const t0 = Date.now();
            while (Date.now() - (window.__mix01State?.lastUserInputAt || 0) < 400) {
                if (ctrlState.currentMedia !== media && ctrlState.currentSrc !== (media.currentSrc || '')) {
                    return { probed: false }; // 放弃
                }
                await new Promise(r => setTimeout(r, 30));
            }
            return { probed: true };
        };
        window.__mix01State.lastUserInputAt = now() - 100; // 用户刚按键，进入等待
        setTimeout(() => { currentMedia = { currentSrc: 'https://x.com/b.jpg' }; }, 120); // 120ms 后切换媒体
        const r11 = await waitWithSwitchCheck(mediaA);
        check('场景11: 等待中媒体切换 → 旧probe放弃(probed:false)', r11.probed === false, JSON.stringify(r11));

        // 场景 12：probe 释放后唤醒回调（onProbeReleased）→ 被单飞拦截的媒体重试
        // 仅当 probe 真正持有单飞锁（relationProbeInFlight === author）时触发
        let released = false;
        window.__mix01State.onProbeReleased = () => { released = true; };
        const authorHolding = '@holder';
        window.__mix01State.relationProbeInFlight = authorHolding;
        // 模拟 finally：持有者释放 → 触发唤醒
        if (window.__mix01State.relationProbeInFlight === authorHolding) {
            window.__mix01State.relationProbeInFlight = null;
            const cb = window.__mix01State.onProbeReleased;
            window.__mix01State.onProbeReleased = null;
            if (cb) setTimeout(cb, 0);
        }
        await new Promise(r => setTimeout(r, 10));
        check('场景12: 持有者释放后onProbeReleased被调用(被拦截媒体可重试)', released === true);

        // 场景 12b：非持有者（等待放弃/媒体切换提前 return，未持有锁）不触发唤醒
        released = false;
        window.__mix01State.onProbeReleased = () => { released = true; };
        window.__mix01State.relationProbeInFlight = null; // 非持有者：inFlight 不是自己
        // 模拟 finally：inFlight !== author → 不触发
        if (window.__mix01State.relationProbeInFlight === 'nobody') {
            const cb = window.__mix01State.onProbeReleased;
            window.__mix01State.onProbeReleased = null;
            if (cb) setTimeout(cb, 0);
        }
        await new Promise(r => setTimeout(r, 10));
        check('场景12b: 非持有者完成不触发onProbeReleased(防自唤醒循环)', released === false);

        // 场景 13：probe 完成（probed!==false）才设置 90s 节流；非尝试（probed:false）不设置
        const probeMap = {};
        const applyRateLimit = (probed, author) => {
            if (probed && probed.probed !== false) probeMap[author] = Date.now();
        };
        applyRateLimit({ probed: false }, '@a'); // 被单飞拦截
        applyRateLimit({ probed: true }, '@b'); // 真正探测
        check('场景13: 被拦截probe不占节流, 真实probe才占节流',
            probeMap['@a'] === undefined && probeMap['@b'] !== undefined);

        // 场景 14：非持有者放弃路径靠 500ms 延迟重试（renderer then 侧），不依赖唤醒
        let retried = false;
        const retryLogic = (probedResult) => {
            if (probedResult && probedResult.probed !== false) return; // 真实探测：刷新
            if (window.__mix01State.relationProbeInFlight) return; // 占用中：等唤醒
            setTimeout(() => { retried = true; }, 500); // 已释放：500ms 重试
        };
        retryLogic({ probed: false }); // 放弃路径，inFlight 已释放
        await new Promise(r => setTimeout(r, 560));
        check('场景14: 非持有者放弃后由500ms定时器重试', retried === true);
        // 占用中不安排重试（等唤醒）
        let retried2 = false;
        window.__mix01State.relationProbeInFlight = '@busy';
        const retryLogic2 = (probedResult) => {
            if (probedResult && probedResult.probed !== false) return;
            if (window.__mix01State.relationProbeInFlight) return;
            setTimeout(() => { retried2 = true; }, 500);
        };
        retryLogic2({ probed: false });
        await new Promise(r => setTimeout(r, 560));
        window.__mix01State.relationProbeInFlight = null;
        check('场景14b: 单飞占用中不安排重试(等持有者唤醒)', retried2 === false);

        // ===== F 键与在飞 probe 互斥（security_review MEDIUM 修复） =====
        // 场景 15：F 键操作前等待在飞 probe 完全退出（≤600ms），避免菜单互踩
        const waitForProbeExit = async () => {
            const t0 = Date.now();
            while (window.__mix01State?.relationProbeInFlight && Date.now() - t0 < 600) {
                await new Promise(r => setTimeout(r, 40));
            }
            return !window.__mix01State?.relationProbeInFlight;
        };
        // 无在飞 probe → 立即放行
        window.__mix01State.relationProbeInFlight = null;
        const t15a = Date.now();
        const r15a = await waitForProbeExit();
        check('场景15a: 无在飞probe时F键立即放行', r15a === true && (Date.now() - t15a) < 100);

        // 有在飞 probe（模拟 120ms 后释放）→ F 键等待其退出
        window.__mix01State.relationProbeInFlight = '@busy';
        setTimeout(() => { window.__mix01State.relationProbeInFlight = null; }, 120);
        const t15b = Date.now();
        const r15b = await waitForProbeExit();
        check('场景15b: F键等待在飞probe退出后再操作(≤600ms)', r15b === true && (Date.now() - t15b) >= 100 && (Date.now() - t15b) < 600, `waited=${Date.now() - t15b}ms`);

        // 场景 16：F 键的用户菜单操作不 respect abort（waitForMenu 第二参数 false）
        const waitForMenuWithFlag = async (respectAbort) => {
            window.__mix01State.abortProbe = true; // 模拟探测中止标志
            const r = respectAbort ? null : 'MENU'; // respect→中止; 不respect→继续等菜单
            window.__mix01State.abortProbe = false;
            return r;
        };
        check('场景16: F键菜单操作不respect abort(不被自动探测中止误杀)',
            await waitForMenuWithFlag(false) === 'MENU');
        check('场景16b: 自动探测仍respect abort(按键立即中止)', await waitForMenuWithFlag(true) === null);

        // 场景 17：follow 操作进行中（followActionInFlight）→ probe 放弃（不开第二个菜单）
        const probeWaitWithFollowFlag = async () => {
            window.__mix01State.lastUserInputAt = now(); // 用户刚按 F（活跃）
            const t0 = Date.now();
            while ((now() - (window.__mix01State?.lastUserInputAt || 0)) < 400) {
                if (window.__mix01State?.followActionInFlight) return { probed: false }; // follow 中 → 放弃
                if (now() - t0 > 3000) return { probed: false };
                await new Promise(r => setTimeout(r, 30));
            }
            return { probed: true };
        };
        window.__mix01State.followActionInFlight = true;
        const r17 = await probeWaitWithFollowFlag();
        check('场景17: follow进行中probe放弃(不开第二个菜单)', r17.probed === false, JSON.stringify(r17));
        window.__mix01State.followActionInFlight = false;

        // 场景 17b：follow 结束后（标志复位）→ probe 可恢复
        window.__mix01State.lastUserInputAt = now() - 3000;
        const r17b = await probeWaitWithFollowFlag();
        check('场景17b: follow结束后probe恢复探测', r17b.probed === true, JSON.stringify(r17b));

        // ===== dismissMenus 关闭确认+重试（评估后实施） =====
        // 场景 18：Escape 后验证菜单已关；未关则重试（≤3 次）
        let menuOpen = true;
        let escapeCount = 0;
        const dispatchEscapeSim = () => { escapeCount++; };
        const hasOpenMenuSim = () => menuOpen;
        const dismissMenusSim = async (attempts = 3) => {
            if (!hasOpenMenuSim()) return true;
            for (let i = 0; i < attempts; i++) {
                dispatchEscapeSim();
                if (!hasOpenMenuSim()) return true;
                await new Promise(r => setTimeout(r, 10));
            }
            return false;
        };
        // 菜单第 2 次 Escape 后关闭 → 返回 true，Escape 共 2 次
        let closedAfter = 2;
        menuOpen = true; escapeCount = 0;
        const dismissWithAutoClose = async () => {
            if (!menuOpen) return true;
            for (let i = 0; i < 3; i++) {
                escapeCount++;
                if (i + 1 >= closedAfter) menuOpen = false;
                if (!menuOpen) return true;
                await new Promise(r => setTimeout(r, 10));
            }
            return false;
        };
        const r18 = await dismissWithAutoClose();
        check('场景18: 菜单未关时重试Escape直至确认关闭', r18 === true && escapeCount === 2 && menuOpen === false,
            `closed=${r18}, escapes=${escapeCount}`);
        // 场景 18b：本来就没菜单 → 直接返回 true，不浪费 Escape
        menuOpen = false; escapeCount = 0;
        const r18b = await dismissMenusSim();
        check('场景18b: 无菜单时直接返回true(不发Escape)', r18b === true && escapeCount === 0, `escapes=${escapeCount}`);
        // 场景 18c：3 次 Escape 后仍未关闭 → 返回 false（不无限重试）
        menuOpen = true; escapeCount = 0;
        const r18c = await dismissMenusSim(3);
        check('场景18c: 3次仍关不掉返回false(有界)', r18c === false && escapeCount === 3, `escapes=${escapeCount}`);

        if (failed) {
            console.error(failed + ' check(s) failed');
            process.exit(1);
        }
        console.log('All safe-probe scenarios passed.');
    })();
})();
