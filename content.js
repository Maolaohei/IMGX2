// content.js - Mix01 高性能引擎组装入口
(function () {
    if (window.__imgZoomProInitialized) return;
    window.__imgZoomProInitialized = true;

    // 全局状态管理（暴露给所有基础模块）
    window.__mix01UserPaused = false;
    window.isFetchingMore = false;
    window.__mix01FollowCache = window.__mix01FollowCache || {};
    window.__mix01LikeMediaCache = window.__mix01LikeMediaCache || {};
    window.__mix01FollowAuthorCache = window.__mix01FollowAuthorCache || {};

    // 【新特性】：底层 API 劫持，拦截所有下载请求并强制转为超高清
    const originalSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async function(message, responseCallback) {
        if (message && message.action === "downloadImmersiveImg" && message.url) {
            try {
                if (window.Mix01RuleEngine) {
                    // 尝试在页面中查找触发该 url 的原始 img DOM，为规则引擎提供上下文
                    const imgEl = Array.from(document.querySelectorAll('img')).find(el => el.src === message.url || el.currentSrc === message.url);
                    
                    // 强制执行高分率图片提取
                    const hdUrl = await window.Mix01RuleEngine.getHighResUrl(imgEl, message.url);
                    if (hdUrl) message.url = hdUrl; 
                }
            } catch (e) {
                console.warn("Mix01 强制高清拦截失败，降级使用原链接", e);
            }
        }
        
        // 解析完成后，放行给原生的 sendMessage 传给后台
        if (responseCallback) {
            return originalSendMessage.call(chrome.runtime, message, responseCallback);
        } else {
            return originalSendMessage.call(chrome.runtime, message);
        }
    };

    // 实例化拆分模块
    const configManager = new window.Mix01ConfigManager();
    const mediaRenderer = new window.Mix01MediaRenderer(configManager);
    const inputController = new window.Mix01InputController(configManager, mediaRenderer);

    // 暴露核心 API 供通信调试
    window.__mix01Engine = { 
        config: configManager, 
        render: mediaRenderer, 
        controller: inputController 
    };
})();