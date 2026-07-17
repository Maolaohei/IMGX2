(function () {
    if (window.__imgZoomProInitialized) return;
    window.__imgZoomProInitialized = true;

    window.__mix01State = {
        userPaused: false,
        isFetchingMore: false,
        followCache: {},
        likeMediaCache: {},
        followAuthorCache: {},
        blobToUrlMap: {},
        hdUrlMap: {}
    };

    // ✅ 移除了对 chrome.runtime.sendMessage 的猴子补丁。
    // 原有的 Blob URL 还原、高清 URL 升级、pageUrl 注入逻辑
    // 已迁移至 Utils.js 的 _resolveDownloadUrl() 和 sendMessage() 方法，
    // 在调用侧完成处理，不再污染全局 API。

    const configManager = new window.Mix01ConfigManager();
    const mediaRenderer = new window.Mix01MediaRenderer(configManager);
    const inputController = new window.Mix01InputController(configManager, mediaRenderer);

    window.__mix01Engine = {
        config: configManager,
        render: mediaRenderer,
        controller: inputController
    };

    // 🚀 利用 MV3 端口生命周期机制，实现网页静默自毁与防崩溃自愈
    try {
        const port = chrome.runtime.connect();
        port.onDisconnect.addListener(() => {
            let isContextValid = false;
            try {
                // 尝试调用轻量级 API。若插件已被重载/更新，Chromium 会同步抛出
                // "Extension context invalidated" 异常
                if (chrome.runtime?.getURL) {
                    chrome.runtime.getURL("");
                    isContextValid = true;
                }
            } catch (err) {
                isContextValid = false;
            }

            if (isContextValid) {
                // 仅仅是后台 Service Worker 正常休眠，网页上下文依然有效，直接忽略
                return;
            }

            // 只有上下文确实失效（插件真正发生重载、升级或卸载）时，才触发自毁自愈
            console.warn("Mix01: 后台已重载或更新，正在执行孤立内容脚本自毁保护程序...");

            if (window.__mix01Engine) {
                window.__mix01Engine.controller?.destroy?.();
                window.__mix01Engine.render?.destroy?.();
                window.__mix01Engine = null;
            }
            window.__imgZoomProInitialized = false; // 允许新版 content.js 重新介入并自愈
        });
    } catch (e) {
        // 捕获已失效的初始化上下文
    }

    const pruneMix01Caches = (hard = false) => {
        const state = window.__mix01State || {};
        // Soft prune: keep small working sets for session continuity
        const trimObj = (obj, max) => {
            if (!obj) return {};
            const keys = Object.keys(obj);
            if (keys.length <= max) return obj;
            const keep = keys.slice(-max);
            const next = {};
            for (const k of keep) next[k] = obj[k];
            return next;
        };
        if (hard) {
            window.__mix01State = {
                userPaused: false,
                isFetchingMore: false,
                followCache: {},
                likeMediaCache: {},
                followAuthorCache: {},
                blobToUrlMap: {},
                hdUrlMap: {},
                loadedHdUrls: undefined
            };
            window.__mix01PixivApiCache = undefined;
            window.__mix01TwVideoCache = undefined;
            window.__mix01DetectCache = undefined;
            window.__mix01DetectInflight = undefined;
        } else {
            // Soft prune only cache maps; keep hover/mouse session context intact
            state.likeMediaCache = trimObj(state.likeMediaCache, 80);
            state.followAuthorCache = trimObj(state.followAuthorCache, 60);
            state.hdUrlMap = trimObj(state.hdUrlMap, 120);
            state.blobToUrlMap = trimObj(state.blobToUrlMap, 40);
            state.relationHudProbed = trimObj(state.relationHudProbed, 60);
            window.__mix01State = state;

            // Bound detect/video caches that live outside __mix01State
            const trimMap = (map, max) => {
                if (!map || typeof map.size !== 'number' || map.size <= max) return;
                const overflow = map.size - max;
                let i = 0;
                for (const key of map.keys()) {
                    map.delete(key);
                    if (++i >= overflow) break;
                }
            };
            trimMap(window.__mix01DetectCache, 60);
            trimMap(window.__mix01DetectInflight, 20);
            trimMap(window.__mix01TwVideoCache, 40);
            trimMap(window.__mix01PixivApiCache, 40);
            return;
        }
        // Hard prune clears ephemeral hover pointers
        window.lastHoveredSrc = null;
        window.lastHoveredMedia = null;
        window.lastMouseX = null;
        window.lastMouseY = null;
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') pruneMix01Caches(false);
    }, { passive: true });

    window.addEventListener('beforeunload', () => {
        pruneMix01Caches(true);
    });
})();
