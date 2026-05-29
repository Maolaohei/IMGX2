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
        this._currentBlob = null; 
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

            this.elements.imgBuffer.classList.add('mix01-hd-buffering');

            if (this.elements.img.src && this.elements.img.style.opacity !== '0.01') {
                this.elements.imgBuffer.src = this.elements.img.src;
                this.setStyles(this.elements.imgBuffer, { display: 'block', opacity: '1' });
            } else if (this.controller && this.controller.state.currentMedia) {
                this.elements.imgBuffer.src = this.controller.state.currentMedia.src || '';
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
                
                this.elements.img.classList.remove('mix01-hd-buffering');
                this.setStyle(this.elements.img, 'opacity', '1');
                this.setStyle(this.elements.imgBuffer, 'opacity', '0');
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
        this._currentBlob = null;
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
        if (!this._activeToastQueue) {
            this._activeToastQueue = [];
        }

        // 1. 创建动态的层叠式子级 Toast 卡片
        const singleToast = document.createElement('div');
        singleToast.className = 'img-zoom-toast-xyz';
        singleToast.textContent = text;

        // 2. 依据当前活跃队列长度计算堆叠的绝对垂直偏移值，支持动态推开
        const offsetIndex = this._activeToastQueue.length;
        singleToast.style.setProperty('bottom', `${30 + offsetIndex * 55}px`, 'important');
        singleToast.style.setProperty('transition', 'all 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)', 'important');
        
        document.body.appendChild(singleToast);
        this._activeToastQueue.push(singleToast);

        requestAnimationFrame(() => {
            singleToast.classList.add('show');
        });

        // 3. 异步移除渐隐，重构后续 Toast 的 bottom 位置，避免排版截断
        setTimeout(() => {
            singleToast.classList.remove('show');
            setTimeout(() => {
                if (singleToast.parentNode) {
                    singleToast.parentNode.removeChild(singleToast);
                }
                this._activeToastQueue = this._activeToastQueue.filter(t => t !== singleToast);
                
                // 实时向下递推
                this._activeToastQueue.forEach((t, i) => {
                    t.style.setProperty('bottom', `${30 + i * 55}px`, 'important');
                });
            }, 350); 
        }, 1500);
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
        
        const els = [this.elements.viewer, this.elements.toast, this.elements.ctxMenu, this.elements.counter];
        els.forEach(el => {
            if (el && el.parentNode) {
                el.parentNode.removeChild(el);
            }
        });
    }

    startVideoRender(videoEl) {
        this.videoState.isRunning = true;
        this.videoState.original = { paused: videoEl.paused, muted: videoEl.muted };
        this.videoState.lastNw = 0;
        this.videoState.lastNh = 0;
        this.currentVideoEl = videoEl;
        this._lastProgressPct = null;

        this.setStyles(this.elements.img,              { display: 'none' });
        this.setStyles(this.elements.videoClone,       { display: 'block' });
        this.setStyles(this.elements.progressContainer,{ display: 'block' });

        videoEl.muted = true;

        const vc = this.elements.videoClone;
        
        vc.muted = false;
        vc.volume = 1.0;
        
        try {
            if (videoEl.captureStream) {
                const stream = videoEl.captureStream();
                if (stream.active) vc.srcObject = stream;
                else throw new Error("Stream inactive");
            } else if (videoEl.mozCaptureStream) {
                vc.srcObject = videoEl.mozCaptureStream();
            } else {
                throw new Error("No captureStream");
            }
        } catch (e) {
            vc.srcObject = null;
            if (vc.src !== videoEl.src) {
                vc.src = videoEl.src;
                vc.currentTime = videoEl.currentTime;
            }
        }

        const launchPlayback = () => {
            if (window.__mix01State.userPaused || !this.videoState.isRunning) return;
            
            videoEl.play().catch(() => {});

            vc.play().catch((err) => {
                if (err.name === 'NotAllowedError') {
                    console.warn("Mix01: 有声自动播放受阻，降级为静音自动播放机制以确保画面不静止");
                    vc.muted = true;
                    vc.play().catch(() => {});
                }
            });
        };

        if (videoEl.readyState < 2) {
            this.setStyle(this.elements.spinner, 'display', 'block');
            
            const onCanPlay = () => {
                this.setStyle(this.elements.spinner, 'display', 'none');
                launchPlayback();
            };
            videoEl.addEventListener('canplay', onCanPlay, { once: true });
            videoEl.addEventListener('loadeddata', onCanPlay, { once: true });
        } else {
            this.setStyle(this.elements.spinner, 'display', 'none');
            launchPlayback();
        }

        const updateFrame = () => {
            if (!this.videoState.isRunning) return;

            if (vc.srcObject && !vc.srcObject.active && !videoEl.ended) {
                try { vc.srcObject = videoEl.captureStream(); } catch(e){}
            }

            if (!window.__mix01State.userPaused && !videoEl.ended) {
                if (videoEl.paused && videoEl.readyState >= 1) {
                    videoEl.play().catch(() => {});
                }
                if (vc.paused && vc.readyState >= 1) {
                    vc.play().catch(() => {});
                }
            }

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

            if (videoEl.requestVideoFrameCallback) videoEl.requestVideoFrameCallback(updateFrame);
            else requestAnimationFrame(updateFrame);
        };

        if (videoEl.requestVideoFrameCallback) videoEl.requestVideoFrameCallback(updateFrame);
        else requestAnimationFrame(updateFrame);
    }

    stopVideoRender() {
        this.videoState.isRunning = false;
        this._lastProgressPct = null;

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
        } else {
            if (activeMedia.naturalWidth > 0) {
                nw = activeMedia.naturalWidth;
                nh = activeMedia.naturalHeight;
            } else {
                nw = rect.width || 1;
                nh = rect.height || 1;
            }
        }
        
        this._syncNoticeVisibility();

        if (isSmallOptimized) {
            activeMedia.classList.add('is-small-pixelated');
            if (!isVideo) this.elements.imgBuffer.classList.add('is-small-pixelated');
        } else {
            activeMedia.classList.remove('is-small-pixelated');
            if (!isVideo) this.elements.imgBuffer.classList.remove('is-small-pixelated');
        }

        const modeClass = this.cfg.state.isImmersive ? 'mode-immersive' : `mode-${mode}`;
        this.setClass(this.elements.viewer, `${modeClass} is-active`);

        const isRotated = rotate % 180 !== 0;
        let cDW = 0, cDH = 0; 
        let vW = 0, vH = 0;   

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

        if (this.cfg.state.isImmersive) {
            this.setStyles(this.elements.viewer, {
                display: 'block', position: 'fixed', width: '100vw', height: '100vh',
                left: '0px', top: '0px', 'background-color': 'rgba(0,0,0,0.95)',
                'background-image': 'none', border: 'none', 'border-radius': '0',
                'pointer-events': 'auto', transform: 'none'
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

            this.setStyles(activeMedia, { position: 'absolute', width: `${cDW}px`, height: `${cDH}px`, margin: '0px', left: '0px', top: '0px' });
            if (!isVideo) {
                this.setStyles(this.elements.imgBuffer, { position: 'absolute', width: `${cDW}px`, height: `${cDH}px`, margin: '0px', left: '0px', top: '0px' });
            }

            let visualOffsetX = (sW - vW) / 2;
            let visualOffsetY = (sH - vH) / 2;

            if (isZoomManuallyChanged && (vW > sW || vH > sH)) {
                visualOffsetX = (vW > sW) ? -(vW - sW) * vxP : visualOffsetX;
                visualOffsetY = (vH > sH) ? -(vH - sH) * vyP : visualOffsetY;
            }
            
            if (panOffsetX) visualOffsetX += panOffsetX;
            if (panOffsetY) visualOffsetY += panOffsetY;

            let offsetX = visualOffsetX + vW / 2 - cDW / 2;
            let offsetY = visualOffsetY + vH / 2 - cDH / 2;

            const matrixTransform = `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`;
            this.setStyle(activeMedia, 'transform', matrixTransform);
            if (!isVideo) this.setStyle(this.elements.imgBuffer, 'transform', matrixTransform);
        }
        else if (mode === 'partial') {
            this.setStyles(this.elements.viewer, { display: 'block', position: 'fixed', overflow: 'hidden', left: '0px', top: '0px' });
            this._enforceTopLayer();

            if (this.cfg.state.hasAgreed) {
                const thumbScale = Math.max(rect.width / nw, rect.height / nh);
                cDW = nw * thumbScale * activeZoom;
                cDH = nh * thumbScale * activeZoom;
                
                vW = isRotated ? cDH : cDW;
                vH = isRotated ? cDW : cDH;

                this.setStyles(activeMedia, { width: cDW + 'px', height: cDH + 'px', position: 'absolute', right: 'auto', bottom: 'auto', margin: '0px', left: '0px', top: '0px' });
                if (!isVideo) {
                    this.setStyles(this.elements.imgBuffer, { width: cDW + 'px', height: cDH + 'px', position: 'absolute', right: 'auto', bottom: 'auto', margin: '0px', left: '0px', top: '0px' });
                }

                let lensW, lensH;
                if (isSmallOptimized && customLensWidth && customLensHeight) {
                    lensW = isRotated ? customLensHeight : customLensWidth;
                    lensH = isRotated ? customLensWidth : customLensHeight;
                } else {
                    const ratio = vW / (vH || 1);
                    
                    let targetW = vW + 20;
                    let targetH = vH + 20;
                    
                    const maxLensSize = 350;
                    if (targetW > maxLensSize || targetH > maxLensSize) {
                        if (ratio >= 1) {
                            targetW = maxLensSize;
                            targetH = targetW / ratio;
                        } else {
                            targetH = maxLensSize;
                            targetW = targetH * ratio;
                        }
                    }
                    
                    const minLensSize = 100;
                    if (targetW < minLensSize) {
                        targetW = minLensSize;
                        targetH = Math.min(maxLensSize, targetW / ratio);
                    }
                    if (targetH < minLensSize) {
                        targetH = minLensSize;
                        targetW = Math.min(maxLensSize, targetH * ratio);
                    }
                    
                    lensW = targetW;
                    lensH = targetH;
                }
                this.setStyles(this.elements.viewer, { width: lensW + 'px', height: lensH + 'px' });

                const clientX = window.lastMouseX || rect.left + rect.width  / 2;
                const clientY = window.lastMouseY || rect.top  + rect.height / 2;

                let vX = clientX + 20, vY = clientY + 20;
                if (vX + lensW > sW) vX = clientX - lensW - 20;
                if (vY + lensH > sH) vY = clientY - lensH - 20;
                
                this.setStyle(this.elements.viewer, 'transform', `translate3d(${vX}px,${vY}px,0)`);

                if (cDW < 350 && cDH < 350 && !customLensWidth) {
                    this.setStyles(this.elements.viewer, {
                        border: '1px solid rgba(255,255,255,0.2)',
                        'background-image': 'radial-gradient(circle, rgba(20,20,20,1) 0%, rgba(0,0,0,1) 100%)',
                        'background-color': '#000'
                    });
                } else {
                    this.setStyles(this.elements.viewer, {
                        'background-image': 'none', 'background-color': 'transparent', border: '1px solid rgba(255,255,255,0.4)'
                    });
                }

                let visualOffsetX = 0, visualOffsetY = 0;
                if (vW > lensW) visualOffsetX = -(vW * vxP - lensW / 2);
                else             visualOffsetX = (lensW - vW) / 2;
                if (vH > lensH) visualOffsetY = -(vH * vyP - lensH / 2);
                else             visualOffsetY = (lensH - vH) / 2;
                
                // 实时叠加 pan 偏移量物理计算
                if (panOffsetX) visualOffsetX += panOffsetX;
                if (panOffsetY) visualOffsetY += panOffsetY;

                let offsetX = visualOffsetX + vW / 2 - cDW / 2;
                let offsetY = visualOffsetY + vH / 2 - cDH / 2;

                const matrixTransform = `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`;
                this.setStyle(activeMedia, 'transform', matrixTransform);
                if (!isVideo) this.setStyle(this.elements.imgBuffer, 'transform', matrixTransform);
            }
        } else {
            this.setStyles(this.elements.viewer, {
                display: 'block', position: 'fixed', left: '0px', top: '0px',
                'background-color': 'rgba(20,20,20,0.9)', 'background-image': 'none'
            });
            this._enforceTopLayer();
            this.setStyles(activeMedia, { position: 'absolute', right: 'auto', bottom: 'auto', margin: '0px', left: '0px', top: '0px' });
            if (!isVideo) {
                this.setStyles(this.elements.imgBuffer, { position: 'absolute', right: 'auto', bottom: 'auto', margin: '0px', left: '0px', top: '0px' });
            }

            const thumbScale = Math.max(rect.width / nw, rect.height / nh);
            cDW = nw * thumbScale * activeZoom;
            cDH = nh * thumbScale * activeZoom;
            
            vW = isRotated ? cDH : cDW;
            vH = isRotated ? cDW : cDH;

            const maxVW = sW * (mode === 'full-follow' ? 0.7 : 0.95);
            const maxVH = sH * (mode === 'full-follow' ? 0.7 : 0.95);

            const clientX = window.lastMouseX || rect.left + rect.width  / 2;
            const clientY = window.lastMouseY || rect.top  + rect.height / 2;

            if (!this.cfg.state.breakoutView || !this.cfg.state.hasAgreed) {
                const safeMaxVW = maxVW - 10, safeMaxVH = maxVH - 10;
                const ratio = vW / vH;
                if (vW > safeMaxVW) { vW = safeMaxVW; vH = vW / ratio; }
                if (vH > safeMaxVH) { vH = safeMaxVH; vW = vH * ratio; }
                
                cDW = isRotated ? vH : vW;
                cDH = isRotated ? vW : vH;

                this.setStyles(this.elements.viewer, { width: `${vW}px`, height: `${vH}px` });
                
                if (this.cfg.state.hasAgreed) {
                    this.setStyles(activeMedia, { width: `${cDW}px`, height: `${cDH}px` });
                    if (!isVideo) this.setStyles(this.elements.imgBuffer, { width: `${cDW}px`, height: `${cDH}px` });

                    let offsetX = vW / 2 - cDW / 2;
                    let offsetY = vH / 2 - cDH / 2;
                    
                    if (panOffsetX) offsetX += panOffsetX;
                    if (panOffsetY) offsetY += panOffsetY;

                    const matrixTransform = `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`;
                    this.setStyle(activeMedia, 'transform', matrixTransform);
                    if (!isVideo) this.setStyle(this.elements.imgBuffer, 'transform', matrixTransform);
                }
            } else {
                const lensW = Math.min(vW, maxVW), lensH = Math.min(vH, maxVH);
                this.setStyles(this.elements.viewer, { width: `${lensW}px`, height: `${lensH}px` });
                this.setStyles(activeMedia, { width: `${cDW}px`, height: `${cDH}px` });
                if (!isVideo) this.setStyles(this.elements.imgBuffer, { width: `${cDW}px`, height: `${cDH}px` });

                let visualOffsetX = (vW > lensW) ? -(vW - lensW) * vxP : 0;
                let visualOffsetY = (vH > lensH) ? -(vH - lensH) * vyP : 0;

                if (panOffsetX) visualOffsetX += panOffsetX;
                if (panOffsetY) visualOffsetY += panOffsetY;

                let offsetX = visualOffsetX + vW / 2 - cDW / 2;
                let offsetY = visualOffsetY + vH / 2 - cDH / 2;
                
                const matrixTransform = `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`;
                this.setStyle(activeMedia, 'transform', matrixTransform);
                if (!isVideo) this.setStyle(this.elements.imgBuffer, 'transform', matrixTransform);
            }

            let vX, vY;
            if (mode === 'full-follow') {
                vX = clientX + 25; vY = clientY + 25;
                if (vX + vW > sW) vX = clientX - vW - 20;
                if (vY + vH > sH) vY = clientY - vH - 20;
            } else {
                const margin = 30;
                vX = (clientX < sW / 2) ? sW - vW - margin : margin;
                vY = clientY - (vH / 2);
                if (vY < margin) vY = margin;
                if (vY + vH > sH - margin) vY = sH - vH - margin;
            }
            this.setStyle(this.elements.viewer, 'transform', `translate3d(${vX}px,${vY}px,0)`);
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
        if (!this.cfg.state.isImmersive || this.elements.viewer.style.display !== 'block') return;

        this._pendingHudSrc = currentSrc;

        const adapter = window.Mix01Utils.getImmersiveAdapter();
        let likeText = '喜欢', likeIcon = '🤍', likeColor = '#dddddd';
        let followText = '关注', followIcon = '👤', followColor = '#dddddd';
        let authorDisplay = '';
        let isFallback = false;

        if (currentMedia && adapter) {
            isFallback = adapter.isFallback === true;

            if (!isFallback && adapter.getStates) {
                const container = adapter.getContainer ? adapter.getContainer(currentMedia) : document.body;
                const states = await adapter.getStates(container, currentMedia);

                if (this._pendingHudSrc !== currentSrc) return;

                if (states) {
                    if (window.__mix01State && window.__mix01State.likeMediaCache && window.__mix01State.likeMediaCache[currentSrc] !== undefined) {
                        states.isLiked = window.__mix01State.likeMediaCache[currentSrc];
                    }
                    if (states.authorName && window.__mix01State && window.__mix01State.followAuthorCache && window.__mix01State.followAuthorCache[states.authorName] !== undefined) {
                        states.isFollowed = window.__mix01State.followAuthorCache[states.authorName];
                    }

                    if (states.isLiked)    { likeText = '已喜欢'; likeIcon = '❤️'; likeColor = '#FF4060'; }
                    if (states.isFollowed) { followText = '已关注'; followIcon = '✓'; followColor = '#1da1f2'; }
                    if (states.authorName) { authorDisplay = `<span class="author-tag">${states.authorName}</span> 的作品`; }
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

        this.elements.hint.innerHTML = hudHTML;
        this.setStyle(this.elements.hint, 'display', 'block');

        void this.elements.hint.offsetWidth; 
        this.setStyle(this.elements.hint, 'opacity', '1');

        clearTimeout(this.hudState.hintTimer);
        this.hudState.hintTimer = setTimeout(() => {
            this.setStyle(this.elements.hint, 'opacity', '0');
            setTimeout(() => {
                if (this.elements.hint.style.opacity === '0') {
                    this.setStyle(this.elements.hint, 'display', 'none');
                }
            }, 600);
        }, 3000);
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