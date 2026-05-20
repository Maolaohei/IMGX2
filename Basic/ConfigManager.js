// Basic/ConfigManager.js
window.Mix01ConfigManager = class ConfigManager {
    constructor() {
        this.state = {
            hasAgreed: false, loadHD: 'true', breakoutView: false,
            showStatus: true, smallImageOptimization: true,
            disableVideoDefaultView: true, zoom: 2.0, rotate: 0,
            mirror: 1, mode: 'partial', isImmersive: false, preloadCount: 5, wheelZoomEnabled: false,
            // ✨ 新增：放大镜智能过滤
            minZoomSize: 0,         // px：元素宽高均小于此值时跳过（0 = 不过滤）
            excludeSelectors: '',   // 逗号分隔的 CSS 选择器，匹配则跳过
            triggerDelay: 0,        // ms：鼠标悬停后延迟显示放大镜（0 = 即时）
        };
        this.globalMode = 'partial';
        this.keys = {
            mode: 'v', rotate: 'r', mirror: 'm', zoomIn: '=', zoomOut: '-',
            immersive: 'ctrl+f12', like: 'l', follow: 'f',
            playVideo: 'space', downloadVideo: 'd',
            double: 's', triple: 'q',
            openInTab: 'o',   // ✨ 新增：在新标签页打开原图
        };
        this.siteModes = {};
        this.disabledSites = {};    // ✨ 新增：{hostname: true} 表示该站点已关闭引擎
        this.isContextValid = () => !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
        this.initSync();
    }

    initSync() {
        if (this.isContextValid()) {
            chrome.storage.local.get(null, (res) => this.sync(res));
            chrome.storage.onChanged.addListener((changes) => {
                let newVals = {};
                for (let key in changes) newVals[key] = changes[key].newValue;
                this.sync(newVals);
            });
        }
    }

    sync(res) {
        if (!res) return;

        Object.keys(this.state).forEach(k => {
        if (res[k] !== undefined) {
            // 兼容映射：如果后台传过来的是 zoomLevel 同样接受
            const isNum = ['zoom', 'preloadCount', 'minZoomSize', 'triggerDelay'].includes(k);
            this.state[k] = isNum ? Number(res[k]) : res[k];
        }
    });
        // 垫片：如果 options 写入的是 zoomLevel，转换为内部 state.zoom
        if (res.zoomLevel !== undefined) this.state.zoom = Number(res.zoomLevel);
        // 【核心修复】：彻底分离全局视图与站点独立视图
        if (res.mode !== undefined) this.globalMode = res.mode;
        if (res.siteModes !== undefined) this.siteModes = res.siteModes;
        if (res.disabledSites !== undefined) this.disabledSites = res.disabledSites || {};

        const host = window.location.hostname;
        if (host) {
            this.state.mode = this.siteModes[host] || this.globalMode || 'partial';
        } else {
            this.state.mode = this.globalMode || 'partial';
        }
        // 兼容已移除的 full-center 模式
        if (this.state.mode === 'full-center') this.state.mode = 'full-follow';

        Object.keys(this.keys).forEach(k => {
            let storageKey = 'key' + k.charAt(0).toUpperCase() + k.slice(1);
            if (res[storageKey]) this.keys[k] = res[storageKey];
        });
    }

    /**
     * 判断当前（或指定）站点是否启用引擎
     * @param {string} [hostname] 可选，默认取当前页面 hostname
     * @returns {boolean} true = 已启用
     */
    isSiteEnabled(hostname) {
        const host = hostname || window.location.hostname;
        return !this.disabledSites[host];
    }

    save(data) {
        if (this.isContextValid()) chrome.storage.local.set(data);
    }
};
