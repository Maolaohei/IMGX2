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

    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async function(message, responseCallback) {
        if (message && message.action === "downloadImmersiveImg" && message.url) {
            if (message.url.startsWith('blob:') && window.__mix01State.blobToUrlMap && window.__mix01State.blobToUrlMap[message.url]) {
                message.url = window.__mix01State.blobToUrlMap[message.url];
            }
            if (!message.url.includes('img-original/')) {
                try {
                    if (window.Mix01RuleEngine) {
                        const imgEl = Array.from(document.querySelectorAll('img')).find(
                            el => el.src === message.url || el.currentSrc === message.url
                        );
                        const hdUrl = await window.Mix01RuleEngine.getHighResUrl(imgEl, message.url);
                        if (hdUrl) message.url = hdUrl;
                    }
                } catch (e) {
                    console.warn("Mix01 强制高清拦截失败，降级使用原链接", e);
                }
            }
            message.pageUrl = window.location.href;
        }

        if (typeof responseCallback === 'function') {
            return originalSendMessage(message, responseCallback);
        }
        return originalSendMessage(message);
    };

    const configManager = new window.Mix01ConfigManager();
    const mediaRenderer = new window.Mix01MediaRenderer(configManager);
    const inputController = new window.Mix01InputController(configManager, mediaRenderer);

    window.__mix01Engine = { 
        config: configManager, 
        render: mediaRenderer, 
        controller: inputController 
    };

    // 🚀 方案五新增：利用 MV3 端口生命周期机制，实现网页静默自毁与防崩溃自愈
  try {
        const port = chrome.runtime.connect();
        port.onDisconnect.addListener(() => {
            let isContextValid = false;
            try {
                // 尝试调用轻量级 API。若插件已被重载/更新，Chromium 会同步抛出 "Extension context invalidated" 异常
                if (chrome.runtime && chrome.runtime.getURL) {
                    chrome.runtime.getURL("");
                    isContextValid = true;
                }
            } catch (err) {
                isContextValid = false;
            }

            if (isContextValid) {
                // 🌟 仅仅是后台 Service Worker 正常休眠，网页上下文依然 100% 有效，直接返回忽略！
                return;
            }

            // 只有上下文确实失效（即插件真正发生重载、升级或卸载）时，才触发自我毁灭自愈程序
            console.warn("Mix01: 后台已重载或更新，正在执行孤立内容脚本自毁保护程序...");
            
            if (window.__mix01Engine) {
                if (window.__mix01Engine.controller && window.__mix01Engine.controller.destroy) {
                    window.__mix01Engine.controller.destroy();
                }
                if (window.__mix01Engine.render && window.__mix01Engine.render.destroy) {
                    window.__mix01Engine.render.destroy();
                }
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
