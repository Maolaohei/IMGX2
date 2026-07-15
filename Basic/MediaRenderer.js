// Basic/MediaRenderer.js
window.Mix01MediaRenderer = class MediaRenderer {
    constructor(configManager) {
        this.cfg = configManager;
        this.styleCache = new WeakMap();
        this.elements = {};
        this.videoState = { isRunning: false, original: null, lastNw: 0, lastNh: 0 };
        this.hudState = { cursorTimer: null, hintTimer: null };
        this.hdState = { isLoading: false, badUrls: new Set(), progress: 0, progressTimer: null };
        this.immersiveState = { lastMedia: null, lastSrc: null, lastHudSignature: null };
        this._hdUrlCache = new Map();
        this._activeBlobUrls = new Set();
        this.controller = null; // 建立对等双向绑定，彻底淘汰自身的会话 ID 跟踪，杜绝漂移风险
        this._ctxCallbacks = null; // 用于右键上下文菜单事件委托的回调登记

        this.initDOM();
        this.setupMessageListener();
    }

    initDOM() {
        if (document.getElementById('img-zoom-pro-viewer-xyz')) return;

        const create = (tag, id, className = '') => {
            const el = document.createElement(tag);
            if (id) el.id = id;
            if (className) el.className = className;
            return el;
        };

        this.elements.viewer           = create('div',    'img-zoom-pro-viewer-xyz');
        this.elements.img              = create('img',    'zoom-img-xyz');
        this.elements.img.alt          = ''; 

        this.elements.imgBuffer        = create('img',    'zoom-img-buffer-xyz');
        this.elements.imgBuffer.alt    = '';

        this.elements.videoClone       = create('video',  'zoom-video-xyz');  
        this.elements.videoClone.muted = true;
        this.elements.videoClone.playsInline = true;
        this.elements.spinner          = create('div',    'zoom-loading-xyz');
        this.elements.progressContainer= create('div',    'mix01-video-progress-container');
        this.elements.progressBar      = create('div',    'mix01-video-progress-bar');
        this.elements.progressContainer.appendChild(this.elements.progressBar);
        this.elements.status  = create('div', 'img-zoom-pro-status-label');
        this.elements.toast   = create('div', '', 'img-zoom-toast-xyz');
        this.elements.notice  = create('div', '', 'notice-container-xyz');
        this.elements.notice.innerHTML = '⚠️ 未同意协议<br>请点击右上角图标同意并开启功能';
        this.elements.hint    = create('div', 'img-zoom-pro-immersive-hint');

        this.elements.ctxMenu = create('div', 'mix01-ctx-menu');
        this.elements.ctxMenu.innerHTML = `
            <div class="ctx-item" data-action="copy-img">📋 复制图片</div>
            <div class="ctx-item" data-action="copy-url">🔗 复制链接</div>
            <div class="ctx-item" data-action="copy-markdown">📋 复制 Markdown</div>
            <div class="ctx-item" data-action="open-tab">↗️ 在新标签页打开</div>
            <div class="ctx-sep"></div>
            <div class="ctx-item" data-action="save">💾 保存图片</div>
            <div class="ctx-sep"></div>
            <div class="ctx-item ctx-item-danger" data-action="disable-site">🚫 在此网站禁用引擎</div>
            <div class="ctx-item" data-action="close">✕ 关闭预览</div>
        `;
        
        // 全周期仅在此绑定一次 click 事件委托，防止反复 bind 引起总线摩擦和 MutationObserver 震荡
        this.elements.ctxMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.ctx-item[data-action]');
            if (!item) return;
            e.stopPropagation();
            const action = item.dataset.action;
            if (this._ctxCallbacks && this._ctxCallbacks[action]) {
                this._ctxCallbacks[action]();
            }
            this.hideContextMenu();
        });

        this.elements.counter = create('div', 'mix01-gallery-counter');

        const styleBlock = document.createElement('style');
        styleBlock.textContent = `
            #img-zoom-pro-viewer-xyz { 
                z-index: 2147483647 !important; 
                contain: layout paint !important; 
            }
            #img-zoom-pro-viewer-xyz.mode-immersive {
                transform: none !important;
                left: 0 !important;
                top: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
            }
                
            #zoom-img-xyz, #zoom-img-buffer-xyz, #zoom-video-xyz {
                color: transparent !important; 
                position: absolute !important;
                left: 0;
                top: 0;
            }
            #img-zoom-pro-viewer-xyz.is-active #zoom-img-xyz,
            #img-zoom-pro-viewer-xyz.is-active #zoom-img-buffer-xyz,
            #img-zoom-pro-viewer-xyz.is-active #zoom-video-xyz {
                will-change: transform, opacity !important;
            }
            #zoom-img-xyz {
                z-index: 2 !important;
                transition: filter 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.12s ease-in-out !important;
            }
            .is-small-pixelated {
                image-rendering: -webkit-optimize-contrast !important;
                image-rendering: -moz-crisp-edges !important;
                image-rendering: pixelated !important;
            }
            #zoom-img-buffer-xyz {
                z-index: 1 !important;
                transition: filter 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.12s ease-in-out !important;
            }
            .mix01-hd-buffering {
                filter: blur(10px) saturate(140%) !important;
            }
            .img-zoom-toast-xyz      { z-index: 2147483647 !important; }
            #img-zoom-pro-immersive-hint { z-index: 2147483647 !important; }
            #mix01-ctx-menu { z-index: 2147483647 !important; }
            #mix01-gallery-counter { z-index: 2147483647 !important; }
            .kbd-btn { background:rgba(255,255,255,0.2); padding:2px 6px; border-radius:4px; font-family:monospace; font-weight:bold; margin:0 2px; }
            .author-tag { color:#1da1f2; font-weight:bold; margin:0 4px; }
            .hud-status-item { font-weight:bold; transition:color 0.3s ease; display:inline-block; }
        `;
        document.head.appendChild(styleBlock);

        Object.assign(this.elements.hint.style, {
            position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)',
            color: 'rgba(255,255,255,0.9)', background: 'rgba(20,20,20,0.8)', padding: '12px 28px',
            borderRadius: '30px', fontSize: '14px', fontFamily: 'system-ui, sans-serif',
            pointerEvents: 'none', transition: 'opacity 0.6s ease', zIndex: '2147483647',
            display: 'none', opacity: '0', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', whiteSpace: 'nowrap'
        });

        const appendAll = () => {
            if (!document.body) { setTimeout(appendAll, 100); return; }
            ['img', 'imgBuffer', 'videoClone', 'spinner', 'progressContainer', 'status', 'notice', 'hint'].forEach(k => {
                this.elements.viewer.appendChild(this.elements[k]);
            });
            document.body.appendChild(this.elements.viewer);
            document.body.appendChild(this.elements.toast);
            document.body.appendChild(this.elements.ctxMenu);
            document.body.appendChild(this.elements.counter);
            this._enforceTopLayer();
        };
        appendAll();

        this.domGuard = new MutationObserver(() => {
            if (!document.getElementById('img-zoom-pro-viewer-xyz') && document.body) {
                document.body.appendChild(this.elements.viewer);
                document.body.appendChild(this.elements.toast);
                if (!document.getElementById('mix01-ctx-menu'))      document.body.appendChild(this.elements.ctxMenu);
                if (!document.getElementById('mix01-gallery-counter')) document.body.appendChild(this.elements.counter);
                this._enforceTopLayer();
            }
        });
        const startGuard = () => this.domGuard.observe(document.body, { childList: true });
        if (document.body) startGuard();
        else document.addEventListener('DOMContentLoaded', startGuard, { once: true });
    }

    _enforceTopLayer() {
        this.elements.viewer.style.setProperty('z-index', '2147483647', 'important');
        this.elements.toast.style.setProperty('z-index',  '2147483647', 'important');
        if (this.elements.ctxMenu)  this.elements.ctxMenu.style.setProperty('z-index',  '2147483647', 'important');
        if (this.elements.counter)  this.elements.counter.style.setProperty('z-index',  '2147483647', 'important');
    }

    renderHDImageDirect(hdUrl, targetSessionId) {
        return new Promise((resolve, reject) => {
            const currentSessionId = this.controller ? this.controller.state.renderRequestId : 0;
            if (targetSessionId && targetSessionId !== currentSessionId) {
                reject(new Error("Session expired"));
                return;
            }

            // [新增] 提取备份回退 URL (原低清图 URL)
            const fallbackUrl = (this.controller && this.controller.state.currentMedia)
                ? (this.controller.state.currentMedia.src || '')
                : (this.elements.img.src || '');

            // [新增] 如果没有高清图链接，或者高清图链接被判定在坏链黑名单中，亦或者与低清图链接完全一致，则直接采用原低清图
            if (!hdUrl || this.hdState.badUrls.has(hdUrl) || hdUrl === fallbackUrl) {
                this.elements.img.classList.remove('mix01-hd-buffering');
                this.setStyle(this.elements.img, 'opacity', '1');
                this.setStyle(this.elements.imgBuffer, 'opacity', '0');
                resolve();
                return;
            }

            this.elements.imgBuffer.classList.add('mix01-hd-buffering');

            if (this.elements.img.src && this.elements.img.style.opacity !== '0.01') {
                this.elements.imgBuffer.src = this.elements.img.src;
                this.setStyles(this.elements.imgBuffer, { display: 'block', opacity: '1' });
            } else if (fallbackUrl) {
                this.elements.imgBuffer.src = fallbackUrl;
                this.setStyles(this.elements.imgBuffer, { display: 'block', opacity: '1' });
            }

            this.setStyle(this.elements.img, 'opacity', '0.01');
            this.elements.img.classList.add('mix01-hd-buffering');
            this.elements.img.src = hdUrl;

            this.elements.img.decode().then(() => {
                const activeId = this.controller ? this.controller.state.renderRequestId : 0;
                if (targetSessionId && targetSessionId !== activeId) {
                    reject(new Error("Session expired"));
                    return;
                }

                this.elements.img.classList.remove('mix01-hd-buffering');
                this.setStyle(this.elements.img, 'opacity', '1');
                this.setStyle(this.elements.imgBuffer, 'opacity', '0');
                
                setTimeout(() => {
                    if (this.elements.img.style.opacity === '1') {
                        this.setStyle(this.elements.imgBuffer, 'display', 'none');
                        this.elements.imgBuffer.classList.remove('mix01-hd-buffering');
                    }
                }, 200);
                
                resolve();
            }).catch((err) => {
                const activeId = this.controller ? this.controller.state.renderRequestId : 0;
                if (targetSessionId && targetSessionId !== activeId) {
                    reject(new Error("Session expired"));
                    return;
                }

                // 将失效的高清 URL 加入黑名单以防重复加载
                this.markBadHdUrl(hdUrl);
                this.elements.img.classList.remove('mix01-hd-buffering');

                if (fallbackUrl && fallbackUrl !== hdUrl) {
                    // 执行安全的降级，将 src 切回低清原图
                    this.elements.img.src = fallbackUrl;
                    
                    // 对原图重新调用 decode 确保完美平滑过渡，规避闪烁
                    this.elements.img.decode().then(() => {
                        this.setStyle(this.elements.img, 'opacity', '1');
                        this.setStyle(this.elements.imgBuffer, 'opacity', '0');
                        setTimeout(() => {
                            this.setStyle(this.elements.imgBuffer, 'display', 'none');
                            this.elements.imgBuffer.classList.remove('mix01-hd-buffering');
                        }, 200);
                    }).catch(() => {
                        // 兜底：如果原图解码也异常，则硬性呈现
                        this.setStyle(this.elements.img, 'opacity', '1');
                        this.setStyle(this.elements.imgBuffer, 'opacity', '0');
                    });
                } else {
                    this.setStyle(this.elements.img, 'opacity', '1');
                    this.setStyle(this.elements.imgBuffer, 'opacity', '0');
                }

                // 弱气泡提示用户，增强交互容错性
                this.showToast('⚠️ 高清原图获取失败，已自动降级展示普通图');
                
                reject(err);
            });
        });
    }

    clearBlobCache() {
        if (this._activeBlobUrls && this._activeBlobUrls.size > 0) {
            for (let url of this._activeBlobUrls) { 
                URL.revokeObjectURL(url); 
            }
            this._activeBlobUrls.clear();
        }
    }

    markBadHdUrl(hdUrl) {
        if (!hdUrl) return;
        this.hdState.badUrls.add(hdUrl);
        // Bound bad URL set to avoid unbounded growth on long sessions
        if (this.hdState.badUrls.size > 80) {
            const overflow = this.hdState.badUrls.size - 80;
            let i = 0;
            for (const value of this.hdState.badUrls) {
                this.hdState.badUrls.delete(value);
                if (++i >= overflow) break;
            }
        }
    }

    refreshHDStatusOnly() {
        // Lightweight status refresh for fake HD progress; avoids full layout pass
        try {
            const isVideo = this.videoState.isRunning;
            const vW = this.elements.viewer?.offsetWidth || 0;
            const vH = this.elements.viewer?.offsetHeight || 0;
            this.updateStatus(isVideo ? 'hd' : 'hd', vW, vH, isVideo);
        } catch (e) {}
    }

    // Single place to toggle image/video layers so softSwitch never leaves stacked surfaces
    prepareMediaSurface(isVideo) {
        // Style-only switch. Never stop the active pipeline here — callers own lifecycle.
        if (isVideo) {
            this.setStyles(this.elements.img, { display: 'none', opacity: '0' });
            this.setStyles(this.elements.imgBuffer, { display: 'none', opacity: '0' });
            this.setStyles(this.elements.videoClone, { display: 'block', opacity: '1' });
            this.setStyles(this.elements.progressContainer, { display: 'block' });
            this.elements.img.classList.remove('mix01-hd-buffering');
            this.elements.imgBuffer.classList.remove('mix01-hd-buffering');
        } else {
            this.setStyles(this.elements.videoClone, { display: 'none' });
            this.setStyles(this.elements.progressContainer, { display: 'none' });
            this.setStyles(this.elements.img, { display: 'block' });
            // Do not force opacity here — triggerZoom owns the decode fade-in.
            this.setStyles(this.elements.imgBuffer, { display: 'none', opacity: '0' });
            this.setStyle(this.elements.spinner, 'display', 'none');
        }
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            const getUrlAndProcess = async (actionFn) => {
                const src = request.clickedUrl || this.elements.img.src;
                if (this._hdUrlCache.has(src)) {
                    actionFn(this._hdUrlCache.get(src));
                    return;
                }
                if (this._hdUrlCache.size > 100) {
                    const iter = this._hdUrlCache.keys();
                    for (let i = 0; i < 50; i++) this._hdUrlCache.delete(iter.next().value);
                }

                let hoveredMedia = window.lastHoveredMedia;
                if (hoveredMedia instanceof WeakRef) hoveredMedia = hoveredMedia.deref();

                const targetEl = request.clickedUrl
                    ? (window.lastHoveredSrc === request.clickedUrl ? (hoveredMedia || document.createElement('img')) : document.createElement('img'))
                    : this.elements.img;
                
                let targetUrl = src;
                if (window.Mix01RuleEngine?.getHighResUrl) {
                    targetUrl = await window.Mix01RuleEngine.getHighResUrl(targetEl, src);
                }
                if (targetUrl && targetUrl !== src) {
                    this._hdUrlCache.set(src, targetUrl);
                    (window.__mix01State.hdUrlMap || (window.__mix01State.hdUrlMap = {}))[src] = targetUrl;
                }
                actionFn(targetUrl);
            };

            if (request.action === 'getHDUrl') {
                getUrlAndProcess(url => sendResponse({ url })); return true;
            } else if (request.action === 'copyHDUrl') {
                getUrlAndProcess(url => { window.Mix01Utils.copyImageToClipboard(url, this); sendResponse({ status: 'ok' }); }); return true;
            } else if (request.action === 'saveHDUrl') {
                getUrlAndProcess(url => { window.Mix01Utils.downloadMedia(url, this, false); sendResponse({ status: 'ok' }); }); return true;
            } else if (request.action === 'copyHDUrlText') {
                getUrlAndProcess(url => { 
                    navigator.clipboard.writeText(url).catch(() => {}); 
                    this.showToast('🔗 原图链接已复制'); 
                    sendResponse({ status: 'ok' }); 
                }); 
                return true;
            }
        });
    }

    setStyle(el, prop, val) {
        let cache = this.styleCache.get(el);
        if (!cache) { cache = {}; this.styleCache.set(el, cache); }
        if (cache[prop] !== val) {
            el.style.setProperty(prop, val, 'important');
            cache[prop] = val;
        }
    }

    setStyles(el, styles) {
        let cache = this.styleCache.get(el);
        if (!cache) { cache = {}; this.styleCache.set(el, cache); }
        for (const prop in styles) {
            if (Object.prototype.hasOwnProperty.call(styles, prop)) {
                const val = styles[prop];
                if (cache[prop] !== val) {
                    el.style.setProperty(prop, val, 'important');
                    cache[prop] = val;
                }
            }
        }
    }

    setClass(el, className) {
        if (el.className !== className) el.className = className;
    }

    showToast(text) {
        if (!this._activeToastQueue) this._activeToastQueue = [];
        if (!this._toastPool) this._toastPool = [];
        if (this._toastSeq == null) this._toastSeq = 0;

        let singleToast = this._toastPool.pop();
        if (!singleToast) {
            singleToast = document.createElement('div');
            singleToast.className = 'img-zoom-toast-xyz';
        }

        // Invalidate any pending timers from a previous life of this node
        const token = ++this._toastSeq;
        singleToast._mix01Token = token;
        if (singleToast._mix01HideTimer) {
            clearTimeout(singleToast._mix01HideTimer);
            singleToast._mix01HideTimer = null;
        }
        if (singleToast._mix01RemoveTimer) {
            clearTimeout(singleToast._mix01RemoveTimer);
            singleToast._mix01RemoveTimer = null;
        }

        singleToast.textContent = text;
        singleToast.classList.remove('show');

        // Drop overflow immediately and cancel their timers cleanly
        while (this._activeToastQueue.length >= 3) {
            const oldest = this._activeToastQueue.shift();
            this._retireToast(oldest, true);
        }

        const offsetIndex = this._activeToastQueue.length;
        singleToast.style.setProperty('bottom', `${30 + offsetIndex * 55}px`, 'important');
        singleToast.style.setProperty('transition', 'all 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)', 'important');
        singleToast.style.setProperty('display', 'block', 'important');
        if (!singleToast.parentNode) document.body.appendChild(singleToast);
        this._activeToastQueue.push(singleToast);

        requestAnimationFrame(() => {
            if (singleToast._mix01Token === token) singleToast.classList.add('show');
        });

        // Keep toasts brief so immersive browsing stays unobstructed.
        singleToast._mix01HideTimer = setTimeout(() => {
            if (singleToast._mix01Token !== token) return;
            singleToast.classList.remove('show');
            singleToast._mix01RemoveTimer = setTimeout(() => {
                if (singleToast._mix01Token !== token) return;
                this._retireToast(singleToast, false);
            }, 180);
        }, 280);
    }

    _retireToast(toast, immediate) {
        if (!toast) return;
        // Bump token so any pending callbacks no-op
        toast._mix01Token = (toast._mix01Token || 0) + 1000000;
        if (toast._mix01HideTimer) {
            clearTimeout(toast._mix01HideTimer);
            toast._mix01HideTimer = null;
        }
        if (toast._mix01RemoveTimer) {
            clearTimeout(toast._mix01RemoveTimer);
            toast._mix01RemoveTimer = null;
        }
        toast.classList.remove('show');
        const idx = this._activeToastQueue ? this._activeToastQueue.indexOf(toast) : -1;
        if (idx >= 0) this._activeToastQueue.splice(idx, 1);
        toast.style.setProperty('display', 'none', 'important');
        if (!this._toastPool) this._toastPool = [];
        if (this._toastPool.length < 6) this._toastPool.push(toast);
        else if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (!immediate && this._activeToastQueue) {
            this._activeToastQueue.forEach((t, i) => {
                t.style.setProperty('bottom', `${30 + i * 55}px`, 'important');
            });
        }
    }

    updateStatus(type, vW, vH, isVideo) {
        if (!this.cfg.state.showStatus || vW < 300 || vH < 200) {
            this.setStyle(this.elements.status, 'display', 'none');
            return;
        }
        
        const nw = isVideo ? 0 : (this.elements.img.naturalWidth || 0);
        const nh = isVideo ? 0 : (this.elements.img.naturalHeight || 0);
        const dimStr = (nw > 0 && nh > 0) ? ` · ${nw}×${nh}` : '';
        
        let targetText = '';
        let targetBgColor = '';
        let targetClass = '';

        if (isVideo) {
            const w = this.videoState.lastNw || 0;
            const h = this.videoState.lastNh || 0;
            targetText = `🎥 视频${(w > 0 && h > 0) ? ` · ${w}×${h}` : ''}`;
            targetClass = 'status-hd';
            targetBgColor = '#1da1f2';
        } else if (type === 'hd') {
            const loading = this.hdState.isLoading;
            targetText = loading ? `⏳ 高清缓冲中 ${this.hdState.progress || 0}%` : `高清${dimStr}`;
            targetClass = loading ? 'status-hd is-loading' : 'status-hd';
        } else {
            targetText = `原图${dimStr}`;
            targetClass = 'status-original';
        }

        const currentSignature = `${targetText}|${targetClass}|${targetBgColor}`;
        if (this._lastStatusSignature === currentSignature) return;
        this._lastStatusSignature = currentSignature;

        this.setStyle(this.elements.status, 'display', 'block');
        this.elements.status.textContent = targetText;
        this.setClass(this.elements.status, targetClass);
        this.setStyle(this.elements.status, 'background-color', targetBgColor);
    }

    _syncNoticeVisibility() {
        if (this.cfg.state.hasAgreed && this.elements.notice.style.display !== 'none') {
            this.elements.notice.style.display = 'none';
        }
    }

    hide() {
        this.elements.viewer.style.setProperty('display', 'none', 'important');

        this.setStyles(this.elements.viewer, { cursor: 'default', 'pointer-events': 'none' });
        this.setStyles(this.elements.img,    { display: 'none', cursor: 'default' });
        
        this.elements.img.src = '';

        this.setStyles(this.elements.imgBuffer, { display: 'none', opacity: '0' });
        this.elements.imgBuffer.src = '';

        this.setStyles(this.elements.videoClone, { display: 'none' }); 
        this.setStyles(this.elements.spinner, { display: 'none' });
        this.setStyles(this.elements.progressContainer, { display: 'none' });
        
        this.setStyles(this.elements.hint, { display: 'none', opacity: '0' });
        
        this.hideContextMenu();
        this.clearBlobCache();
        if (this.elements.counter) this.elements.counter.style.setProperty('display', 'none', 'important');

        const staleProperties = ['left', 'top', 'width', 'height', 'border-radius', 'border', 'background-color', 'background-image', 'pointer-events', 'transform'];
        staleProperties.forEach(prop => this.elements.viewer.style.removeProperty(prop));

        this.setClass(this.elements.viewer, '');

        clearTimeout(this.hudState.cursorTimer);
        clearTimeout(this.hudState.hintTimer);
        this.hdState.isLoading = false;
        this.stopVideoRender();

        this.styleCache.delete(this.elements.viewer);
    }

    destroy() {
        this.hide();
        if (this.domGuard) this.domGuard.disconnect();
        
        if (this._activeToastQueue) {
            [...this._activeToastQueue].forEach(t => this._retireToast(t, true));
            this._activeToastQueue = [];
        }
        if (this._toastPool) {
            this._toastPool.forEach(t => { if (t.parentNode) t.parentNode.removeChild(t); });
            this._toastPool = [];
        }

        const els = [this.elements.viewer, this.elements.toast, this.elements.ctxMenu, this.elements.counter];
        els.forEach(el => {
            if (el && el.parentNode) {
                el.parentNode.removeChild(el);
            }
        });
    }

    startVideoRender(videoEl) {
        // Tear down any previous session first, then arm state.
        this.stopVideoRender();
        this.prepareMediaSurface(true);

        this.videoState.isRunning = true;
        this.videoState.original = { paused: videoEl.paused, muted: videoEl.muted };
        this.videoState.lastNw = videoEl.videoWidth || 0;
        this.videoState.lastNh = videoEl.videoHeight || 0;
        this.currentVideoEl = videoEl;
        this._lastProgressPct = null;
        this._videoUsedStream = false;

        // Immersive clone owns audio; mute page video to avoid double audio.
        videoEl.muted = true;

        const vc = this.elements.videoClone;
        vc.muted = false;
        vc.volume = 1.0;

        const clearCloneSrc = () => {
            if (vc.srcObject) {
                const stream = vc.srcObject;
                if (stream.getTracks) stream.getTracks().forEach(t => t.stop());
                vc.srcObject = null;
            }
            if (vc.getAttribute('src')) {
                vc.removeAttribute('src');
                try { vc.load(); } catch (e) {}
            }
        };

        const attachStream = () => {
            clearCloneSrc();
            let stream = null;
            if (videoEl.captureStream) stream = videoEl.captureStream();
            else if (videoEl.mozCaptureStream) stream = videoEl.mozCaptureStream();
            if (!stream) throw new Error('No captureStream');
            // Some players need a play() tick before stream becomes active
            if (!stream.active) {
                videoEl.play().catch(() => {});
            }
            vc.srcObject = stream;
            this._videoUsedStream = true;
        };

        const attachSrc = () => {
            clearCloneSrc();
            const src = videoEl.currentSrc || videoEl.src;
            if (!src) throw new Error('No video src');
            if (vc.src !== src) vc.src = src;
            if (Number.isFinite(videoEl.currentTime)) {
                try { vc.currentTime = videoEl.currentTime; } catch (e) {}
            }
            this._videoUsedStream = false;
        };

        // X/Twitter often uses blob:/MSE — reusing src on another <video> is unreliable.
        // Prefer captureStream there; plain CDN mp4 can use src.
        const rawSrc = videoEl.currentSrc || videoEl.src || '';
        const host = (typeof location !== 'undefined' && location.hostname) || '';
        const preferStream =
            rawSrc.startsWith('blob:') ||
            rawSrc.startsWith('mediasource:') ||
            !rawSrc ||
            /(?:^|\.)(?:x|twitter)\.com$/i.test(host);

        try {
            if (preferStream) attachStream();
            else attachSrc();
        } catch (e) {
            try {
                if (preferStream) attachSrc();
                else attachStream();
            } catch (e2) {
                // last resort: leave clone empty; spinner path still tries play later
            }
        }

        const launchPlayback = () => {
            if (window.__mix01State.userPaused || !this.videoState.isRunning) return;
            videoEl.play().catch(() => {});
            vc.play().catch((err) => {
                if (err && err.name === 'NotAllowedError') {
                    vc.muted = true;
                    vc.play().catch(() => {});
                } else if (!this._videoUsedStream) {
                    // src path failed at play-time — promote to stream
                    try {
                        attachStream();
                        vc.play().catch(() => {});
                    } catch (_) {}
                }
            });
        };

        const onCloneError = () => {
            if (!this.videoState.isRunning || this._videoUsedStream) return;
            try {
                attachStream();
                launchPlayback();
            } catch (e) {}
        };
        vc.addEventListener('error', onCloneError, { once: true });
        this._videoCloneErrorHandler = onCloneError;

        if (videoEl.readyState < 2) {
            this.setStyle(this.elements.spinner, 'display', 'block');
            const onCanPlay = () => {
                this.setStyle(this.elements.spinner, 'display', 'none');
                launchPlayback();
            };
            videoEl.addEventListener('canplay', onCanPlay, { once: true });
            videoEl.addEventListener('loadeddata', onCanPlay, { once: true });
            // Still attempt play; some X videos never fire canplay while already decoding frames
            launchPlayback();
        } else {
            this.setStyle(this.elements.spinner, 'display', 'none');
            launchPlayback();
        }

        if (this._videoProgressHandler) {
            try { videoEl.removeEventListener('timeupdate', this._videoProgressHandler); } catch (e) {}
        }
        this._videoProgressHandler = () => {
            if (!this.videoState.isRunning) return;
            if (videoEl.duration > 0) {
                const pct = ((videoEl.currentTime / videoEl.duration) * 100).toFixed(2) + '%';
                if (pct !== this._lastProgressPct) {
                    this.elements.progressBar.style.setProperty('width', pct, 'important');
                    this._lastProgressPct = pct;
                }
            }
            if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
                this.videoState.lastNw = videoEl.videoWidth;
                this.videoState.lastNh = videoEl.videoHeight;
            }
            if (!this._videoUsedStream && !window.__mix01State.userPaused) {
                const drift = Math.abs((vc.currentTime || 0) - videoEl.currentTime);
                if (drift > 0.35) {
                    try { vc.currentTime = videoEl.currentTime; } catch (e) {}
                }
            }
        };
        videoEl.addEventListener('timeupdate', this._videoProgressHandler);

        const updateFrame = () => {
            if (!this.videoState.isRunning) return;
            if (this._videoUsedStream && vc.srcObject && !vc.srcObject.active && !videoEl.ended) {
                try { vc.srcObject = videoEl.captureStream(); } catch (e) {}
            }
            if (!window.__mix01State.userPaused && !videoEl.ended) {
                if (videoEl.paused && videoEl.readyState >= 1) videoEl.play().catch(() => {});
                if (vc.paused && vc.readyState >= 1) vc.play().catch(() => {});
            }
            this._videoKeepAliveId = setTimeout(() => {
                if (!this.videoState.isRunning) return;
                if (this._videoUsedStream && videoEl.requestVideoFrameCallback) {
                    videoEl.requestVideoFrameCallback(updateFrame);
                } else {
                    updateFrame();
                }
            }, this._videoUsedStream ? 100 : 250);
        };

        if (this._videoUsedStream && videoEl.requestVideoFrameCallback) {
            videoEl.requestVideoFrameCallback(updateFrame);
        } else {
            this._videoKeepAliveId = setTimeout(updateFrame, 250);
        }
    }

    stopVideoRender() {
        this.videoState.isRunning = false;
        this._lastProgressPct = null;
        if (this._videoKeepAliveId) {
            clearTimeout(this._videoKeepAliveId);
            this._videoKeepAliveId = null;
        }
        if (this.currentVideoEl && this._videoProgressHandler) {
            this.currentVideoEl.removeEventListener('timeupdate', this._videoProgressHandler);
            this._videoProgressHandler = null;
        }
        if (this.elements.videoClone && this._videoCloneErrorHandler) {
            this.elements.videoClone.removeEventListener('error', this._videoCloneErrorHandler);
            this._videoCloneErrorHandler = null;
        }
        this._videoUsedStream = false;

        if (this.elements.videoClone) {
            this.elements.videoClone.pause();
            
            if (this.elements.videoClone.srcObject) {
                const stream = this.elements.videoClone.srcObject;
                if (stream.getTracks) {
                    stream.getTracks().forEach(track => track.stop());
                }
            }
            this.elements.videoClone.srcObject = null;
            this.elements.videoClone.removeAttribute('src'); 
            this.elements.videoClone.load();
        }

        if (this.currentVideoEl && this.videoState.original) {
            this.currentVideoEl.muted = this.videoState.original.muted;
            if (this.videoState.original.paused) this.currentVideoEl.pause();
            else this.currentVideoEl.play().catch(() => {});
            this.videoState.original = null;
        }
        this.currentVideoEl = null;
    }

    updateLayout(activeMedia, rect, activeZoom, xP, yP, isSmallOptimized, customLensWidth, customLensHeight, isZoomManuallyChanged, currentHoveredSrc, _sw, _sh, panOffsetX, panOffsetY, mode, rotate, mirror, incomingSessionId) {
        const activeRequestId = this.controller ? this.controller.state.renderRequestId : 0;
        if (incomingSessionId && incomingSessionId !== activeRequestId) {
            return activeZoom;
        }

        const sW = window.innerWidth, sH = window.innerHeight;
        const isVideo = activeMedia === this.elements.videoClone;

        let nw = 1, nh = 1;
        if (isVideo) {
            nw = this.videoState.lastNw || activeMedia.videoWidth || rect.width || 1;
            nh = this.videoState.lastNh || activeMedia.videoHeight || rect.height || 1;
        } else if (activeMedia.naturalWidth > 0) {
            nw = activeMedia.naturalWidth;
            nh = activeMedia.naturalHeight;
        } else {
            nw = Math.max(1, rect.width || 1);
            nh = Math.max(1, rect.height || 1);
        }

        this._syncNoticeVisibility();

        if (isSmallOptimized) {
            activeMedia.classList.add('is-small-pixelated');
            if (!isVideo) this.elements.imgBuffer.classList.add('is-small-pixelated');
        } else {
            activeMedia.classList.remove('is-small-pixelated');
            if (!isVideo) this.elements.imgBuffer.classList.remove('is-small-pixelated');
        }

        const safeMode = (mode === 'full-follow') ? 'full-follow' : 'partial';
        const modeClass = this.cfg.state.isImmersive ? 'mode-immersive' : `mode-${safeMode}`;
        this.setClass(this.elements.viewer, `${modeClass} is-active`);

        const isRotated = rotate % 180 !== 0;
        let cDW = 0, cDH = 0;
        let vW = 0, vH = 0;

        // Map pointer ratio onto the actual bitmap (thumbnail may be object-fit: cover)
        let correctedXP = xP;
        let correctedYP = yP;
        if (nw > 1 && nh > 1 && rect.width > 0 && rect.height > 0) {
            const rOrig = nw / nh;
            const rThumb = rect.width / rect.height;
            if (rOrig > rThumb) {
                const factor = rThumb / rOrig;
                correctedXP = xP * factor + 0.5 * (1 - factor);
            } else if (rOrig < rThumb) {
                const factor = rOrig / rThumb;
                correctedYP = yP * factor + 0.5 * (1 - factor);
            }
        }

        let vxP = correctedXP, vyP = correctedYP;
        if (rotate === 90) { vxP = 1 - correctedYP; vyP = correctedXP; }
        else if (rotate === 180) { vxP = 1 - correctedXP; vyP = 1 - correctedYP; }
        else if (rotate === 270) { vxP = correctedYP; vyP = 1 - correctedXP; }
        if (mirror === -1) { vxP = 1 - vxP; }

        const applyMediaBox = (width, height, transform) => {
            this.setStyles(activeMedia, {
                position: 'absolute',
                width: `${width}px`,
                height: `${height}px`,
                margin: '0px',
                left: '0px',
                top: '0px',
                right: 'auto',
                bottom: 'auto'
            });
            this.setStyle(activeMedia, 'transform', transform);
            if (!isVideo) {
                this.setStyles(this.elements.imgBuffer, {
                    position: 'absolute',
                    width: `${width}px`,
                    height: `${height}px`,
                    margin: '0px',
                    left: '0px',
                    top: '0px',
                    right: 'auto',
                    bottom: 'auto'
                });
                this.setStyle(this.elements.imgBuffer, 'transform', transform);
            }
        };

        const placeViewer = (x, y, w, h, extra = {}) => {
            this.setStyles(this.elements.viewer, {
                display: 'block',
                position: 'fixed',
                left: '0px',
                top: '0px',
                width: `${w}px`,
                height: `${h}px`,
                overflow: 'hidden',
                'pointer-events': extra.pointerEvents || 'none',
                'background-color': extra.bg || 'rgba(15,15,15,0.92)',
                'background-image': extra.bgImage || 'none',
                border: extra.border || '1px solid rgba(255,255,255,0.2)',
                'border-radius': extra.radius || '8px',
                transform: `translate3d(${x}px,${y}px,0)`
            });
            this._enforceTopLayer();
        };

        if (this.cfg.state.isImmersive) {
            this.setStyles(this.elements.viewer, {
                display: 'block', position: 'fixed', width: '100vw', height: '100vh',
                left: '0px', top: '0px', 'background-color': 'rgba(0,0,0,0.95)',
                'background-image': 'none', border: 'none', 'border-radius': '0',
                'pointer-events': 'auto', transform: 'none', overflow: 'hidden'
            });
            this._enforceTopLayer();

            let vNw = isRotated ? nh : nw;
            let vNh = isRotated ? nw : nh;

            if (!isZoomManuallyChanged) {
                const maxW = sW * 0.95, maxH = sH * 0.95;
                const scaleW = maxW / (vNw || 1);
                const scaleH = maxH / (vNh || 1);
                activeZoom = Math.min(scaleW, scaleH);
                if (activeZoom > 50) activeZoom = 50;
            }

            cDW = nw * activeZoom; cDH = nh * activeZoom;
            vW = isRotated ? cDH : cDW;
            vH = isRotated ? cDW : cDH;

            let visualOffsetX = (sW - vW) / 2;
            let visualOffsetY = (sH - vH) / 2;
            if (isZoomManuallyChanged && (vW > sW || vH > sH)) {
                visualOffsetX = (vW > sW) ? -(vW - sW) * vxP : visualOffsetX;
                visualOffsetY = (vH > sH) ? -(vH - sH) * vyP : visualOffsetY;
            }
            if (panOffsetX) visualOffsetX += panOffsetX;
            if (panOffsetY) visualOffsetY += panOffsetY;

            const offsetX = visualOffsetX + vW / 2 - cDW / 2;
            const offsetY = visualOffsetY + vH / 2 - cDH / 2;
            const matrixTransform = `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`;
            applyMediaBox(cDW, cDH, matrixTransform);
        }
        else if (safeMode === 'partial') {
            // -------- Local magnifier --------
            // Image is scaled from the on-page thumbnail footprint * zoom.
            // Viewer is a fixed lens that pans over the magnified bitmap.
            const zoom = Math.max(1.25, Number(activeZoom) || 2);

            // cover-scale: fill the thumbnail box, then magnify
            const thumbScale = Math.max((rect.width || 1) / nw, (rect.height || 1) / nh);
            cDW = nw * thumbScale * zoom;
            cDH = nh * thumbScale * zoom;
            vW = isRotated ? cDH : cDW;
            vH = isRotated ? cDW : cDH;

            let lensW, lensH;
            if (isSmallOptimized && customLensWidth && customLensHeight) {
                lensW = isRotated ? customLensHeight : customLensWidth;
                lensH = isRotated ? customLensWidth : customLensHeight;
            } else {
                // Lens grows with zoom a bit, but stays readable
                const base = Math.min(420, Math.max(140, Math.max(rect.width, rect.height) * 1.8));
                const ratio = vW / (vH || 1);
                if (ratio >= 1) {
                    lensW = Math.min(base, vW);
                    lensH = Math.min(base / ratio, vH);
                } else {
                    lensH = Math.min(base, vH);
                    lensW = Math.min(base * ratio, vW);
                }
                lensW = Math.max(120, lensW);
                lensH = Math.max(120, lensH);
            }

            // Content pan so the pointed pixel sits near lens center
            let visualOffsetX = (vW > lensW) ? -(vW * vxP - lensW / 2) : (lensW - vW) / 2;
            let visualOffsetY = (vH > lensH) ? -(vH * vyP - lensH / 2) : (lensH - vH) / 2;
            // Clamp pan so edges don't leave the lens empty
            if (vW > lensW) visualOffsetX = Math.min(0, Math.max(lensW - vW, visualOffsetX));
            else visualOffsetX = (lensW - vW) / 2;
            if (vH > lensH) visualOffsetY = Math.min(0, Math.max(lensH - vH, visualOffsetY));
            else visualOffsetY = (lensH - vH) / 2;

            if (panOffsetX) visualOffsetX += panOffsetX;
            if (panOffsetY) visualOffsetY += panOffsetY;

            const offsetX = visualOffsetX + vW / 2 - cDW / 2;
            const offsetY = visualOffsetY + vH / 2 - cDH / 2;
            const matrixTransform = `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`;

            // Keep magnifier content visible even if a prior HD transition left opacity low
            if (!isVideo && this.elements.img && this.elements.img.style.opacity === '0') {
                // still loading first frame — leave opacity management to triggerZoom/decode
            } else if (!isVideo) {
                this.setStyle(this.elements.img, 'opacity', '1');
            }

            applyMediaBox(cDW, cDH, matrixTransform);

            const clientX = window.lastMouseX ?? (rect.left + rect.width / 2);
            const clientY = window.lastMouseY ?? (rect.top + rect.height / 2);
            let vX = clientX + 18;
            let vY = clientY + 18;
            if (vX + lensW > sW - 8) vX = clientX - lensW - 18;
            if (vY + lensH > sH - 8) vY = clientY - lensH - 18;
            vX = Math.max(8, Math.min(sW - lensW - 8, vX));
            vY = Math.max(8, Math.min(sH - lensH - 8, vY));

            placeViewer(vX, vY, lensW, lensH, {
                bg: 'rgba(12,12,12,0.88)',
                border: '1px solid rgba(255,255,255,0.18)',
                radius: '12px'
            });

            // report visual footprint
            vW = lensW; vH = lensH;
            activeZoom = zoom;
        }
        else {
            // -------- Full-follow (整体跟随) --------
            // Floating preview that tracks the cursor and KEEPS zoom.
            // Previous code reassigned cDW=vW after viewport clamping, which cancelled zoom.
            const zoom = Math.max(1, Number(activeZoom) || 2);
            const thumbScale = Math.max((rect.width || 1) / nw, (rect.height || 1) / nh);
            cDW = nw * thumbScale * zoom;
            cDH = nh * thumbScale * zoom;
            let contentW = isRotated ? cDH : cDW;
            let contentH = isRotated ? cDW : cDH;

            // Viewer chrome size: show a comfortable window, not the whole zoomed bitmap
            const maxVW = sW * 0.72;
            const maxVH = sH * 0.72;
            const minVW = Math.min(220, sW * 0.4);
            const minVH = Math.min(180, sH * 0.35);

            // Prefer showing ~min(content, max) so zoom still crops inside the frame
            vW = Math.min(Math.max(contentW, minVW), maxVW);
            vH = Math.min(Math.max(contentH, minVH), maxVH);

            // If content is smaller than the min chrome, shrink chrome to content
            vW = Math.min(vW, Math.max(contentW, 120));
            vH = Math.min(vH, Math.max(contentH, 120));

            // Pan magnified content under the pointer focus
            let visualOffsetX = (contentW > vW) ? -(contentW - vW) * vxP : (vW - contentW) / 2;
            let visualOffsetY = (contentH > vH) ? -(contentH - vH) * vyP : (vH - contentH) / 2;
            if (contentW > vW) visualOffsetX = Math.min(0, Math.max(vW - contentW, visualOffsetX));
            if (contentH > vH) visualOffsetY = Math.min(0, Math.max(vH - contentH, visualOffsetY));
            if (panOffsetX) visualOffsetX += panOffsetX;
            if (panOffsetY) visualOffsetY += panOffsetY;

            const offsetX = visualOffsetX + contentW / 2 - cDW / 2;
            const offsetY = visualOffsetY + contentH / 2 - cDH / 2;
            const matrixTransform = `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`;

            if (!isVideo) this.setStyle(this.elements.img, 'opacity', '1');
            applyMediaBox(cDW, cDH, matrixTransform);

            const clientX = window.lastMouseX ?? (rect.left + rect.width / 2);
            const clientY = window.lastMouseY ?? (rect.top + rect.height / 2);

            // Follow cursor with smart flip; keep fully on-screen
            let vX = clientX + 22;
            let vY = clientY + 22;
            if (vX + vW > sW - 10) vX = clientX - vW - 22;
            if (vY + vH > sH - 10) vY = clientY - vH - 22;
            vX = Math.max(10, Math.min(sW - vW - 10, vX));
            vY = Math.max(10, Math.min(sH - vH - 10, vY));

            placeViewer(vX, vY, vW, vH, {
                bg: 'rgba(15,15,15,0.94)',
                border: '1px solid rgba(255,255,255,0.2)',
                radius: '8px'
            });

            activeZoom = zoom;
        }

        this.updateStatus(activeMedia.src !== currentHoveredSrc ? 'hd' : 'original', vW, vH, isVideo);
        return activeZoom;
    }

    showContextMenu(x, y, callbacks) {
        const menu = this.elements.ctxMenu;
        if (!menu) return;

        const disableItem = menu.querySelector('[data-action="disable-site"]');
        if (disableItem) {
            const isEnabled = this.cfg.isSiteEnabled();
            disableItem.textContent = isEnabled ? '🚫 在此网站禁用引擎' : '✅ 在此网站启用引擎';
        }

        this._ctxCallbacks = callbacks;

        menu.style.setProperty('display', 'block', 'important');
        const mW = menu.offsetWidth, mH = menu.offsetHeight;
        const vW = window.innerWidth, vH = window.innerHeight;
        const finalX = (x + mW > vW) ? Math.max(0, x - mW) : x;
        const finalY = (y + mH > vH) ? Math.max(0, y - mH) : y;
        menu.style.setProperty('left', `${finalX}px`, 'important');
        menu.style.setProperty('top',  `${finalY}px`, 'important');
        menu.style.setProperty('opacity', '0', 'important');
        requestAnimationFrame(() => menu.style.setProperty('opacity', '1', 'important'));

        this._ctxOutsideHandler = (e) => {
            if (!menu.contains(e.target)) this.hideContextMenu();
        };
        setTimeout(() => document.addEventListener('mousedown', this._ctxOutsideHandler, { once: true }), 10);
    }

    hideContextMenu() {
        if (!this.elements.ctxMenu) return;
        this.elements.ctxMenu.style.setProperty('display', 'none', 'important');
        if (this._ctxOutsideHandler) {
            document.removeEventListener('mousedown', this._ctxOutsideHandler);
            this._ctxOutsideHandler = null;
        }
    }

    updateCounter(current, total) {
        const counter = this.elements.counter;
        if (!counter) return;
        if (!this.cfg.state.isImmersive || total <= 1) {
            counter.style.setProperty('display', 'none', 'important');
            return;
        }
        counter.textContent = `${current + 1} / ${total}`;
        counter.style.setProperty('display', 'block', 'important');
    }

    async handleImmersiveActivity(currentMedia, currentSrc, keys) {
        if (!this.cfg.state.isImmersive) return;
        if (this.controller && this.controller.state && !this.controller.state.isViewerVisible) return;
        if (!this.controller && this.elements.viewer.style.display !== 'block') return;

        this._pendingHudSrc = currentSrc;

        const adapter = window.Mix01Utils.getImmersiveAdapter();
                let likeText = '\u559c\u6b22', likeIcon = '\ud83d\udc94', likeColor = '#dddddd';
        let followText = '\u5173\u6ce8', followIcon = '\ud83d\udc64', followColor = '#dddddd';
        let authorDisplay = '';
        let isFallback = false;

        if (currentMedia && adapter) {
            isFallback = adapter.isFallback === true;

            if (!isFallback && adapter.getStates) {
                const container = adapter.getContainer ? adapter.getContainer(currentMedia) : document.body;
                const states = await adapter.getStates(container, currentMedia);

                if (this._pendingHudSrc !== currentSrc) return;

                if (states) {
                    // Like: cache is an optimistic layer, but only when present
                    if (window.__mix01State && window.__mix01State.likeMediaCache && window.__mix01State.likeMediaCache[currentSrc] !== undefined) {
                        states.isLiked = window.__mix01State.likeMediaCache[currentSrc];
                    }

                    // Follow/Subscribe:
                    // 1) Live CTA wins for follow/unfollow.
                    // 2) "subscribed" is only shown when confirmed (live label or menu-confirmed cache).
                    // 3) Ambiguous "Following" may probe the caret menu once/session to distinguish Super Follow.
                    const readCacheEntry = (author) => {
                        if (!author || !window.__mix01State?.followAuthorCache) return null;
                        const raw = window.__mix01State.followAuthorCache[author];
                        if (raw == null) return null;
                        if (typeof raw === 'string' || typeof raw === 'boolean') {
                            const relation = raw === true ? 'following' : raw === false ? 'follow' : raw;
                            return {
                                relation,
                                confidence: relation === 'subscribed' ? 'confirmed' : 'inferred'
                            };
                        }
                        return {
                            relation: raw.relation || null,
                            confidence: raw.confidence || 'inferred'
                        };
                    };

                    let relation = states.relation || null;
                    let confidence = states.confidence || 'unknown';
                    const cacheEntry = readCacheEntry(states.authorName);

                    if ((states.isFollowed === null || states.isFollowed === undefined) && cacheEntry) {
                        // Fill only when live is unknown.
                        if (cacheEntry.relation === 'following' || cacheEntry.relation === 'subscribed') states.isFollowed = true;
                        else if (cacheEntry.relation === 'follow' || cacheEntry.relation === 'subscribe') states.isFollowed = false;
                        if (!relation) relation = cacheEntry.relation;
                        if (confidence === 'unknown') confidence = cacheEntry.confidence || 'inferred';
                    } else if (states.isFollowed != null && states.authorName) {
                        // Align cache with live. Sticky subscribed only if previously confirmed.
                        window.__mix01State = window.__mix01State || {};
                        window.__mix01State.followAuthorCache = window.__mix01State.followAuthorCache || {};
                        let next = relation || (states.isFollowed ? 'following' : 'follow');
                        if (next === 'following' && cacheEntry?.relation === 'subscribed' && cacheEntry.confidence === 'confirmed') {
                            next = 'subscribed';
                            confidence = 'confirmed';
                        }
                        const conf = (next === 'subscribed' && confidence === 'confirmed') ? 'confirmed'
                            : (states.liveRelation ? 'live' : 'inferred');
                        window.__mix01State.followAuthorCache[states.authorName] = {
                            relation: next,
                            confidence: conf,
                            source: states.relationSource || 'hud',
                            ts: Date.now()
                        };
                        window.__mix01FollowCache = window.__mix01State.followAuthorCache;
                        relation = next;
                    }

                    // Ambiguous: live only says Following, cache has no confirmed subscription.
                    // Probe caret menu once to recover true Super Follow / Subscribe state.
                    const needsProbe = adapter.probeRelation && states.authorName &&
                        (relation === 'following' || relation === 'follow' || !relation) &&
                        !(cacheEntry && cacheEntry.confidence === 'confirmed' && cacheEntry.relation === 'subscribed') &&
                        states.liveRelation !== 'subscribed' && states.liveRelation !== 'subscribe';

                    if (needsProbe) {
                        window.__mix01State = window.__mix01State || {};
                        window.__mix01State.relationHudProbed = window.__mix01State.relationHudProbed || {};
                        const probedAt = window.__mix01State.relationHudProbed[states.authorName] || 0;
                        if (Date.now() - probedAt > 60_000) {
                            window.__mix01State.relationHudProbed[states.authorName] = Date.now();
                            try {
                                const probed = await adapter.probeRelation(container, currentMedia, false);
                                if (this._pendingHudSrc !== currentSrc) return;
                                if (probed) {
                                    states.isFollowed = probed.isFollowed;
                                    relation = probed.relation || relation;
                                    confidence = probed.confidence || confidence;
                                    if (probed.authorName) states.authorName = probed.authorName;
                                }
                            } catch (e) { /* non-fatal */ }
                        }
                    }

                    if (states.isLiked) { likeText = '\u5df2\u559c\u6b22'; likeIcon = '\u2764\ufe0f'; likeColor = '#FF4060'; }

                    relation = relation ||
                        (states.isFollowed === true ? 'following' : (states.isFollowed === false ? 'follow' : null));

                    // Only paint "\u5df2\u8ba2\u9605" when confirmed. Otherwise show live Following/Follow truth.
                    if (relation === 'subscribed' && (confidence === 'confirmed' || states.liveRelation === 'subscribed')) {
                        followText = '\u5df2\u8ba2\u9605'; followIcon = '\u2b50'; followColor = '#f4c430';
                    } else if (relation === 'following' || (relation === 'subscribed' && confidence !== 'confirmed')) {
                        // Unconfirmed sticky sub -> show as Following rather than fake Subscribed.
                        followText = '\u5df2\u5173\u6ce8'; followIcon = '\u2713'; followColor = '#1da1f2';
                    } else if (relation === 'subscribe') {
                        followText = '\u8ba2\u9605'; followIcon = '\ud83d\udc64'; followColor = '#dddddd';
                    } else if (relation === 'follow' || states.isFollowed === false) {
                        followText = '\u5173\u6ce8'; followIcon = '\ud83d\udc64'; followColor = '#dddddd';
                    } else if (states.isFollowed === true) {
                        followText = '\u5df2\u5173\u6ce8'; followIcon = '\u2713'; followColor = '#1da1f2';
                    } else {
                        followText = '\u672a\u786e\u8ba4'; followIcon = '\u2753'; followColor = '#aaaaaa';
                    }

                    if (states.authorName) {
                        authorDisplay = `<span class="author-tag">${states.authorName}</span> \u7684\u4f5c\u54c1`;
                    }
                }
            }
        }

        const keyMode     = (keys.mode          || keys.keyMode          || 'v').toUpperCase();
        const keyDownload = (keys.downloadVideo  || keys.keyDownloadVideo  || 'd').toUpperCase();
        const keyLike     = (keys.like           || keys.keyLike           || 'l').toUpperCase();
        const keyFollow   = (keys.follow         || keys.keyFollow         || 'f').toUpperCase();
        const hudSignature = `${currentSrc}|${keyMode}|${keyDownload}|${keyLike}|${keyFollow}|${likeText}|${followText}|${followColor}|${authorDisplay}`;

        if (this.immersiveState.lastMedia === currentMedia &&
            this.immersiveState.lastSrc   === currentSrc &&
            this.immersiveState.lastHudSignature === hudSignature &&
            this.elements.hint.style.display === 'block') {
            return;
        }
        this.immersiveState.lastMedia       = currentMedia;
        this.immersiveState.lastSrc         = currentSrc;
        this.immersiveState.lastHudSignature= hudSignature;

        // Incremental HUD update: rebuild only when signature changed (already gated above)
        let hudHTML = `<div style="display:flex;align-items:center;gap:15px;">`;
        hudHTML += `<span class="hud-status-item">切换 <span class="kbd-btn">${keyMode}</span></span>`;
        hudHTML += `<span class="hud-status-item">暂停 <span class="kbd-btn">SPACE</span></span>`;
        hudHTML += `<span class="hud-status-item" style="color:#4A90E2;font-weight:bold;">原图下载 <span class="kbd-btn">${keyDownload}</span></span>`;

        if (!isFallback) {
            hudHTML += `<span class="hud-status-item" style="color:${likeColor}">${likeIcon} ${likeText} <span class="kbd-btn">${keyLike}</span></span>`;
            hudHTML += `<span class="hud-status-item" style="color:${followColor}">${followIcon} ${followText} <span class="kbd-btn">${keyFollow}</span></span>`;
            if (authorDisplay) hudHTML += `<span style="margin-left:10px;border-left:1px solid rgba(255,255,255,0.3);padding-left:10px;">${authorDisplay}</span>`;
        }

        hudHTML += `<span class="hud-status-item">退出 <span class="kbd-btn">双击</span></span>`;
        hudHTML += `</div>`;

        if (this.elements.hint.dataset.hudHtml !== hudHTML) {
            this.elements.hint.innerHTML = hudHTML;
            this.elements.hint.dataset.hudHtml = hudHTML;
        }
        this.setStyle(this.elements.hint, 'display', 'block');
        this.setStyle(this.elements.hint, 'opacity', '1');

        clearTimeout(this.hudState.hintTimer);
        this.hudState.hintTimer = setTimeout(() => {
            this.setStyle(this.elements.hint, 'opacity', '0');
            setTimeout(() => {
                if (this.elements.hint.style.opacity === '0') {
                    this.setStyle(this.elements.hint, 'display', 'none');
                }
            }, 300);
        }, 750);
    }

    setHUDOpacity(opacity) {
        const hudElements = [
            this.elements.status,
            this.elements.counter,
            this.elements.hint
        ];
        hudElements.forEach(el => {
            if (el) {
                el.style.setProperty('transition', 'opacity 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)', 'important');
                el.style.setProperty('opacity', opacity, 'important');
                
                if (opacity === '0') {
                    setTimeout(() => {
                        if (el.style.opacity === '0') {
                            el.style.setProperty('display', 'none', 'important');
                        }
                    }, 400);
                } else {
                    el.style.setProperty('display', 'block', 'important');
                }
            }
        });
    }
};