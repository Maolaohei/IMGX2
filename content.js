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

    window.addEventListener('beforeunload', () => {
        window.__mix01State = {
            userPaused: false,
            isFetchingMore: false,
            followCache: {},
            likeMediaCache: {},
            followAuthorCache: {},
            blobToUrlMap: {},
            hdUrlMap: {}
        };
        window.__mix01PixivApiCache = undefined;
        window.__mix01TwVideoCache = undefined;
        window.__mix01DetectCache = undefined;
        window.lastHoveredSrc = null;
        window.lastHoveredMedia = null;
        window.lastMouseX = null;
        window.lastMouseY = null;
    });
})();