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