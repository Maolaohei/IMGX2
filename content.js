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
