// Basic/ConfigManager.js
window.Mix01ConfigManager = class ConfigManager {
    constructor() {
        this.state = {
            hasAgreed: false, loadHD: 'true', breakoutView: false,
            showStatus: true, smallImageOptimization: true,
            disableVideoDefaultView: true, zoom: 2.0, rotate: 0,
            mirror: 1, mode: 'partial', isImmersive: false, preloadCount: 5, wheelZoomEnabled: false
        };
        this.globalMode = 'partial'; // 新增：专门存放全局默认配置
        this.keys = {
            mode: 'v', rotate: 'r', mirror: 'm', zoomIn: '=', zoomOut: '-',
            immersive: 'ctrl+f12', like: 'l', follow: 'f', 
            playVideo: 'space', downloadVideo: 'd', 
            double: 's', triple: 'q'
        };
        this.siteModes = {};
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
                this.state[k] = (k === 'zoom' || k === 'preloadCount') ? Number(res[k]) : res[k];
            }
        });
        
        // 【核心修复】：彻底分离全局视图与站点独立视图
        if (res.mode !== undefined) this.globalMode = res.mode;
        if (res.siteModes !== undefined) this.siteModes = res.siteModes;
        
        const host = window.location.hostname;
        if (host) {
            // 优先使用当前站点的独立配置，如果没有则使用全局默认配置
            this.state.mode = this.siteModes[host] || this.globalMode || 'partial';
        } else {
            this.state.mode = this.globalMode || 'partial';
        }

        Object.keys(this.keys).forEach(k => {
            let storageKey = 'key' + k.charAt(0).toUpperCase() + k.slice(1);
            if (res[storageKey]) this.keys[k] = res[storageKey];
        });
    }

    save(data) {
        if (this.isContextValid()) chrome.storage.local.set(data);
    }
};