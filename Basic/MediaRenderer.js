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
        
        // 🔧 FIX: 清除 alt，配合下面 CSS 的 color: transparent 屏蔽图裂 icon
        this.elements.img.alt          = ''; 

        this.elements.canvas           = create('canvas', 'zoom-canvas-xyz'); 
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

        this.elements.counter = create('div', 'mix01-gallery-counter');

        const styleBlock = document.createElement('style');
        styleBlock.textContent = `
            #img-zoom-pro-viewer-xyz { z-index: 2147483647 !important; will-change: transform; }
            #img-zoom-pro-viewer-xyz.mode-immersive {
                transform: none !important;
                left: 0 !important;
                top: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
            }
            #zoom-img-xyz, #zoom-canvas-xyz, #zoom-video-xyz {
                will-change: transform, opacity !important;
                color: transparent !important; /* 🔧 FIX: 隐藏浏览器的裂图alt占位符 */
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

        this.elements.img.style.setProperty('transition', 'opacity 0.2s ease', 'important');

        try { this.canvasCtx = this.elements.canvas.getContext('2d', { alpha: false }); } catch(e) {}

        Object.assign(this.elements.hint.style, {
            position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)',
            color: 'rgba(255,255,255,0.9)', background: 'rgba(20,20,20,0.8)', padding: '12px 28px',
            borderRadius: '30px', fontSize: '14px', fontFamily: 'system-ui, sans-serif',
            pointerEvents: 'none', transition: 'opacity 0.6s ease', zIndex: '2147483647',
            display: 'none', opacity: '0', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', whiteSpace: 'nowrap'
        });

        const appendAll = () => {
            if (!document.body) { setTimeout(appendAll, 100); return; }
            ['img', 'canvas', 'videoClone', 'spinner', 'progressContainer', 'status', 'notice', 'hint'].forEach(k => {
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
                if (hoveredMedia instanceof WeakRef) {
                    hoveredMedia = hoveredMedia.deref();
                }

                const targetEl = request.clickedUrl
                    ? (window.lastHoveredSrc === request.clickedUrl ? (hoveredMedia || document.createElement('img')) : document.createElement('img'))
                    : this.elements.img;
                
                let targetUrl = src;
                if (window.Mix01RuleEngine?.getHighResUrl) {
                    targetUrl = await window.Mix01RuleEngine.getHighResUrl(targetEl, src);
                }
                if (targetUrl && targetUrl !== src) {
                    this._hdUrlCache.set(src, targetUrl);
                    (window.__mix01HdUrlMap || (window.__mix01HdUrlMap = {}))[src] = targetUrl;
                }
                actionFn(targetUrl);
            };

            if (request.action === 'getHDUrl') {
                getUrlAndProcess(url => sendResponse({ url }));
                return true;
            } else if (request.action === 'copyHDUrl') {
                getUrlAndProcess(url => { window.Mix01Utils.copyImageToClipboard(url, this); sendResponse({ status: 'ok' }); });
                return true;
            } else if (request.action === 'saveHDUrl') {
                getUrlAndProcess(url => { window.Mix01Utils.downloadImage(url, this); sendResponse({ status: 'ok' }); });
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
        clearTimeout(this._toastTimer);
        this.elements.toast.textContent = text; 
        this.elements.toast.classList.add('show');
        this._toastTimer = setTimeout(() => this.elements.toast.classList.remove('show'), 1200);
    }

    updateStatus(type, vW, vH, isVideo) {
        if (!this.cfg.state.showStatus || vW < 300 || vH < 200) {
            this.setStyle(this.elements.status, 'display', 'none');
            return;
        }
        this.setStyle(this.elements.status, 'display', 'block');

        const nw = isVideo ? 0 : (this.elements.img.naturalWidth || 0);
        const nh = isVideo ? 0 : (this.elements.img.naturalHeight || 0);
        const dimStr = (nw > 0 && nh > 0) ? ` · ${nw}×${nh}` : '';

        if (isVideo) {
            const w = this.videoState.lastNw || 0;
            const h = this.videoState.lastNh || 0;
            const vDim = (w > 0 && h > 0) ? ` · ${w}×${h}` : '';
            this.elements.status.textContent = `🎥 视频${vDim}`;
            this.setClass(this.elements.status, 'status-hd');
            this.setStyle(this.elements.status, 'background-color', '#1da1f2');
        } else if (type === 'hd') {
            const loading = this.hdState.isLoading;
            this.setClass(this.elements.status, loading ? 'status-hd is-loading' : 'status-hd');
            this.elements.status.textContent = loading ? `⏳ 高清缓冲中 ${this.hdState.progress || 0}%` : `高清${dimStr}`;
            this.setStyle(this.elements.status, 'background-color', '');
        } else {
            this.setClass(this.elements.status, 'status-original');
            this.elements.status.textContent = `原图${dimStr}`;
            this.setStyle(this.elements.status, 'background-color', '');
        }
    }

    _syncNoticeVisibility() {
        if (this.cfg.state.hasAgreed && this.elements.notice.style.display !== 'none') {
            this.elements.notice.style.display = 'none';
        }
    }

    hide() {
        this.setStyles(this.elements.viewer, { display: 'none', cursor: 'default', 'pointer-events': 'none' });
        this.setStyles(this.elements.img,    { display: 'none', cursor: 'default' });
        this.setStyles(this.elements.canvas, { display: 'none' });
        this.setStyles(this.elements.videoClone, { display: 'none' }); 
        this.setStyles(this.elements.spinner, { display: 'none' });
        this.setStyles(this.elements.progressContainer, { display: 'none' });
        this.setStyle(this.elements.hint, 'opacity', '0');
        this.hideContextMenu();
        if (this.elements.counter) this.elements.counter.style.setProperty('display', 'none', 'important');

        clearTimeout(this.hudState.cursorTimer);
        clearTimeout(this.hudState.hintTimer);
        this.hdState.isLoading = false;
        this.stopVideoRender();
    }

    startVideoRender(videoEl) {
        this.videoState.isRunning = true;
        this.videoState.original = { paused: videoEl.paused, muted: videoEl.muted };
        this.videoState.lastNw = 0;
        this.videoState.lastNh = 0;
        this.currentVideoEl = videoEl;
        this._lastProgressPct = null;

        this.setStyles(this.elements.img,              { display: 'none' });
        this.setStyles(this.elements.canvas,           { display: 'none' });
        this.setStyles(this.elements.videoClone,       { display: 'block' });
        this.setStyles(this.elements.progressContainer,{ display: 'block' });

        const vc = this.elements.videoClone;
        vc.muted = true;
        
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
            vc.src = videoEl.src;
            vc.currentTime = videoEl.currentTime;
        }

        if (videoEl.readyState === 0) {
            this.setStyle(this.elements.spinner, 'display', 'block');
            videoEl.addEventListener('canplay', () => {
                this.setStyle(this.elements.spinner, 'display', 'none');
                if (!window.__mix01UserPaused) vc.play().catch(() => {});
            }, { once: true });
        } else {
            if (!window.__mix01UserPaused) vc.play().catch(() => {});
        }

        this._videoSyncInterval = setInterval(() => {
            if (!this.videoState.isRunning) return;

            if (vc.srcObject && !vc.srcObject.active && !videoEl.ended) {
                try { vc.srcObject = videoEl.captureStream(); } catch(e){}
            }

            if (videoEl.paused && videoEl.readyState >= 3 && !window.__mix01UserPaused) {
                if (!videoEl.ended) videoEl.play().catch(() => {});
            }
            if (vc.paused && !window.__mix01UserPaused && vc.readyState >= 3) {
                if (!videoEl.ended) vc.play().catch(() => {});
            }

            if (videoEl.duration > 0) {
                const pct = ((videoEl.currentTime / videoEl.duration) * 100).toFixed(2) + '%';
                if (pct !== this._lastProgressPct) {
                    this.elements.progressBar.style.setProperty('width', pct, 'important');
                    this._lastProgressPct = pct;
                }
            }
        }, 250);
    }

    stopVideoRender() {
        this.videoState.isRunning = false;
        clearInterval(this._videoSyncInterval);
        this._lastProgressPct = null;

        if (this.elements.videoClone) {
            this.elements.videoClone.pause();
            this.elements.videoClone.srcObject = null;
            this.elements.videoClone.src = '';
        }

        if (this.currentVideoEl && this.videoState.original) {
            this.currentVideoEl.muted = this.videoState.original.muted;
            if (this.videoState.original.paused) this.currentVideoEl.pause();
            else this.currentVideoEl.play().catch(() => {});
            this.videoState.original = null;
        }
        this.currentVideoEl = null;
    }

    updateLayout(activeMedia, rect, activeZoom, xP, yP, isSmallOptimized, customLensWidth, customLensHeight, isZoomManuallyChanged, currentHoveredSrc, _sw, _sh, panOffsetX, panOffsetY, mode, rotate, mirror) {
        const sW = window.innerWidth, sH = window.innerHeight;
        const isVideo = activeMedia === this.elements.canvas || activeMedia === this.elements.videoClone;
        
        if (isVideo) {
            const vW = this.currentVideoEl?.videoWidth || activeMedia.videoWidth || 0;
            const vH = this.currentVideoEl?.videoHeight || activeMedia.videoHeight || 0;
            if (vW > 0 && vH > 0) {
                this.videoState.lastNw = vW;
                this.videoState.lastNh = vH;
            }
        }

        const nw = isVideo ? (this.videoState.lastNw || activeMedia.width || rect.width || 1) : (activeMedia.naturalWidth || rect.width || 1);
        const nh = isVideo ? (this.videoState.lastNh || activeMedia.height || rect.height || 1) : (activeMedia.naturalHeight || rect.height || 1);
        
        this._syncNoticeVisibility();
        this.setClass(this.elements.viewer, this.cfg.state.isImmersive ? 'mode-immersive' : `mode-${mode}`);

        const isRotated = rotate % 180 !== 0;
        let cDW = 0, cDH = 0; 
        let vW = 0, vH = 0;   

        let vxP = xP, vyP = yP;
        if (rotate === 90) { vxP = 1 - yP; vyP = xP; }
        else if (rotate === 180) { vxP = 1 - xP; vyP = 1 - yP; }
        else if (rotate === 270) { vxP = yP; vyP = 1 - xP; }
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

            this.setStyle(activeMedia, 'transform', `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`);
        }
        else if (mode === 'partial') {
            this.setStyles(this.elements.viewer, { display: 'block', position: 'fixed', overflow: 'hidden', left: '0px', top: '0px' });
            this._enforceTopLayer();

            if (this.cfg.state.hasAgreed) {
                cDW = rect.width * activeZoom;
                cDH = rect.height * activeZoom;
                vW = isRotated ? cDH : cDW;
                vH = isRotated ? cDW : cDH;

                this.setStyles(activeMedia, { width: cDW + 'px', height: cDH + 'px', position: 'absolute', right: 'auto', bottom: 'auto', margin: '0px', left: '0px', top: '0px' });

                let lensW, lensH;
                if (isSmallOptimized && customLensWidth && customLensHeight) {
                    lensW = isRotated ? customLensHeight : customLensWidth;
                    lensH = isRotated ? customLensWidth : customLensHeight;
                } else {
                    lensW = Math.min(350, Math.max(100, vW + 20));
                    lensH = Math.min(350, Math.max(100, vH + 20));
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
                
                let offsetX = visualOffsetX + vW / 2 - cDW / 2;
                let offsetY = visualOffsetY + vH / 2 - cDH / 2;

                this.setStyle(activeMedia, 'transform', `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`);
            }
        } else {
            this.setStyles(this.elements.viewer, {
                display: 'block', position: 'fixed', left: '0px', top: '0px',
                'background-color': 'rgba(20,20,20,0.9)', 'background-image': 'none'
            });
            this._enforceTopLayer();
            this.setStyles(activeMedia, { position: 'absolute', right: 'auto', bottom: 'auto', margin: '0px', left: '0px', top: '0px' });

            let tW = rect.width * activeZoom, tH = rect.height * activeZoom;
            cDW = tW; cDH = tH;
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
                    let offsetX = vW / 2 - cDW / 2;
                    let offsetY = vH / 2 - cDH / 2;
                    this.setStyle(activeMedia, 'transform', `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`);
                }
            } else {
                const lensW = Math.min(vW, maxVW), lensH = Math.min(vH, maxVH);
                this.setStyles(this.elements.viewer, { width: `${lensW}px`, height: `${lensH}px` });
                this.setStyles(activeMedia, { width: `${cDW}px`, height: `${cDH}px` });

                let visualOffsetX = (vW > lensW) ? -(vW - lensW) * vxP : 0;
                let visualOffsetY = (vH > lensH) ? -(vH - lensH) * vyP : 0;

                let offsetX = visualOffsetX + vW / 2 - cDW / 2;
                let offsetY = visualOffsetY + vH / 2 - cDH / 2;
                
                this.setStyle(activeMedia, 'transform', `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${mirror}) rotate(${rotate}deg)`);
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

        const newMenu = menu.cloneNode(true);
        menu.parentNode.replaceChild(newMenu, menu);
        this.elements.ctxMenu = newMenu;

        newMenu.querySelectorAll('.ctx-item[data-action]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                if (callbacks[action]) callbacks[action]();
                this.hideContextMenu();
            });
        });

        newMenu.style.setProperty('display', 'block', 'important');
        const mW = newMenu.offsetWidth, mH = newMenu.offsetHeight;
        const vW = window.innerWidth, vH = window.innerHeight;
        const finalX = (x + mW > vW) ? Math.max(0, x - mW) : x;
        const finalY = (y + mH > vH) ? Math.max(0, y - mH) : y;
        newMenu.style.setProperty('left', `${finalX}px`, 'important');
        newMenu.style.setProperty('top',  `${finalY}px`, 'important');
        newMenu.style.setProperty('opacity', '0', 'important');
        requestAnimationFrame(() => newMenu.style.setProperty('opacity', '1', 'important'));

        this._ctxOutsideHandler = (e) => {
            if (!newMenu.contains(e.target)) this.hideContextMenu();
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

                if (states) {
                    if (states.isLiked)    { likeText = '已喜欢'; likeIcon = '❤️'; likeColor = '#FF4060'; }
                    if (states.isFollowed) { followText = '已关注'; followIcon = '✓'; followColor = '#1da1f2'; }
                    if (states.authorName) { authorDisplay = `<span class="author-tag">${states.authorName}</span> 的作品`; }
                }
            }
        }

        const keyMode     = (keys.keyMode          || 'V').toUpperCase();
        const keyDownload = (keys.keyDownloadVideo  || 'D').toUpperCase();
        const keyLike     = (keys.keyLike           || 'L').toUpperCase();
        const keyFollow   = (keys.keyFollow         || 'F').toUpperCase();
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
};