// content.js - Mix01 高性能引擎组装入口
(function () {
    if (window.__imgZoomProInitialized) return;
    window.__imgZoomProInitialized = true;

    // 全局状态管理
    window.__mix01UserPaused = false;
    window.isFetchingMore = false;
    window.__mix01FollowCache = window.__mix01FollowCache || {};
    window.__mix01LikeMediaCache = window.__mix01LikeMediaCache || {};
    window.__mix01FollowAuthorCache = window.__mix01FollowAuthorCache || {};

    // 底层 API 劫持，拦截所有下载请求并强制转为超高清
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async function(message, responseCallback) {
        if (message && message.action === "downloadImmersiveImg" && message.url) {
            // 防止已经处理过的原图被再次套娃
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
            // 添加页面URL作为Referer
            message.pageUrl = window.location.href;
        }

        // 【Bug修复】原版在 responseCallback 存在时仍走 else 分支返回 Promise，
        // 导致 sendMessage 的回调形式失效。现在统一用原始函数处理。
        if (typeof responseCallback === 'function') {
            return originalSendMessage(message, responseCallback);
        }
        return originalSendMessage(message);
    };

    // 实例化拆分模块
    const configManager = new window.Mix01ConfigManager();
    const mediaRenderer = new window.Mix01MediaRenderer(configManager);
    const inputController = new window.Mix01InputController(configManager, mediaRenderer);

    window.__mix01Engine = { 
        config: configManager, 
        render: mediaRenderer, 
        controller: inputController 
    };

    // 优化：页面卸载时清理全局缓存，避免内存泄漏
    window.addEventListener('beforeunload', () => {
        window.__mix01UserPaused = false;
        window.isFetchingMore = false;
        window.__mix01FollowCache = {};
        window.__mix01LikeMediaCache = {};
        window.__mix01FollowAuthorCache = {};
        window.__mix01HdUrlMap = {};
        // 【Bug修复】原版遗漏了以下LRU缓存的清理
        window.__mix01PixivApiCache = undefined;
        window.__mix01TwVideoCache = undefined;
        window.__mix01DetectCache = undefined;
        window.lastHoveredSrc = null;
        window.lastHoveredMedia = null;
        window.lastMouseX = null;
        window.lastMouseY = null;
    });
})();