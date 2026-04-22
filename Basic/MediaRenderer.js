// Basic/MediaRenderer.js
window.Mix01MediaRenderer = class MediaRenderer {
    constructor(configManager) {
        this.cfg = configManager;
        this.styleCache = new WeakMap();
        this.elements = {};
        this.videoState = { isRunning: false, callbackId: null, rAFId: null, original: null };
        this.hudState = { cursorTimer: null, hintTimer: null };
        this.hdState = { isLoading: false, badUrls: new Set() };
        this.immersiveState = { lastMedia: null, lastSrc: null, lastHudSignature: null };
        // Map 替代全局对象：size 是 O(1)，无原型污染，迭代有序
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
        this.elements.canvas           = create('canvas', 'zoom-canvas-xyz');
        this.elements.spinner          = create('div',    'zoom-loading-xyz');
        this.elements.progressContainer= create('div',    'mix01-video-progress-container');
        this.elements.progressBar      = create('div',    'mix01-video-progress-bar');
        this.elements.progressContainer.appendChild(this.elements.progressBar);
        this.elements.status  = create('div', 'img-zoom-pro-status-label');
        this.elements.toast   = create('div', '', 'img-zoom-toast-xyz');
        this.elements.notice  = create('div', '', 'notice-container-xyz');
        this.elements.notice.innerHTML = '⚠️ 未同意协议<br>请点击右上角图标同意并开启功能';
        this.elements.hint    = create('div', 'img-zoom-pro-immersive-hint');

        // ✨ 右键上下文菜单
        this.elements.ctxMenu = create('div', 'mix01-ctx-menu');
        this.elements.ctxMenu.innerHTML = `
            <div class="ctx-item" data-action="copy-img">📋 复制图片</div>
            <div class="ctx-item" data-action="copy-url">🔗 复制链接</div>
            <div class="ctx-item" data-action="open-tab">↗️ 在新标签页打开</div>
            <div class="ctx-sep"></div>
            <div class="ctx-item" data-action="save">💾 保存图片</div>
            <div class="ctx-sep"></div>
            <div class="ctx-item ctx-item-danger" data-action="disable-site">🚫 在此网站禁用引擎</div>
            <div class="ctx-item" data-action="close">✕ 关闭预览</div>
        `;

        // ✨ 沉浸模式计数器
        this.elements.counter = create('div', 'mix01-gallery-counter');

        // 关键：在样式表层面锁定最高 z-index，确保放大镜/沉浸层不被任何页面元素遮挡
        const styleBlock = document.createElement('style');
        styleBlock.textContent = `
            #img-zoom-pro-viewer-xyz { z-index: 2147483647 !important; will-change: transform; }
            .img-zoom-toast-xyz      { z-index: 2147483647 !important; }
            #img-zoom-pro-immersive-hint { z-index: 2147483647 !important; }
            #mix01-ctx-menu { z-index: 2147483647 !important; }
            #mix01-gallery-counter { z-index: 2147483647 !important; }
            .kbd-btn { background:rgba(255,255,255,0.2); padding:2px 6px; border-radius:4px; font-family:monospace; font-weight:bold; margin:0 2px; }
            .author-tag { color:#1da1f2; font-weight:bold; margin:0 4px; }
            .hud-status-item { font-weight:bold; transition:color 0.3s ease; display:inline-block; }
        `;
        document.head.appendChild(styleBlock);

        // 配合 inputController decode().then 渐现动画；will-change 提前提升到合成层
        this.elements.img.style.setProperty('transition', 'opacity 0.2s ease, transform 0.1s cubic-bezier(0.2,0,0.2,1)', 'important');
        this.elements.img.style.setProperty('will-change', 'transform, opacity', 'important');

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
            ['img', 'canvas', 'spinner', 'progressContainer', 'status', 'notice', 'hint'].forEach(k => {
                this.elements.viewer.appendChild(this.elements[k]);
            });
            document.body.appendChild(this.elements.viewer);
            document.body.appendChild(this.elements.toast);
            document.body.appendChild(this.elements.ctxMenu);
            document.body.appendChild(this.elements.counter);
            // 附加到 DOM 后立刻强制 z-index，防止页面已有高层级元素
            this._enforceTopLayer();
        };
        appendAll();

        // DOM 守卫：被页面意外移除后自动重新插入，并恢复 z-index
        this.domGuard = new MutationObserver(() => {
            if (!document.getElementById('img-zoom-pro-viewer-xyz') && document.body) {
                document.body.appendChild(this.elements.viewer);
                document.body.appendChild(this.elements.toast);
                // ✨ 同步保护新增元素
                if (!document.getElementById('mix01-ctx-menu'))      document.body.appendChild(this.elements.ctxMenu);
                if (!document.getElementById('mix01-gallery-counter')) document.body.appendChild(this.elements.counter);
                this._enforceTopLayer();
            }
        });
        const startGuard = () => this.domGuard.observe(document.body, { childList: true });
        if (document.body) startGuard();
        else document.addEventListener('DOMContentLoaded', startGuard, { once: true });
    }

    /** 强制放大镜和沉浸层始终位于最顶层，任何时候都可安全调用 */
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

                // Map.has() 是 O(1)，直接命中缓存
                if (this._hdUrlCache.has(src)) {
                    actionFn(this._hdUrlCache.get(src));
                    return;
                }
                // 超出 100 条时删除最旧的一半（Map 迭代有序，最先插入的在前）
                if (this._hdUrlCache.size > 100) {
                    const iter = this._hdUrlCache.keys();
                    for (let i = 0; i < 50; i++) this._hdUrlCache.delete(iter.next().value);
                }

                const targetEl = request.clickedUrl
                    ? (window.lastHoveredSrc === request.clickedUrl ? window.lastHoveredMedia : document.createElement('img'))
                    : this.elements.img;
                let targetUrl = src;
                if (window.Mix01RuleEngine?.getHighResUrl) {
                    targetUrl = await window.Mix01RuleEngine.getHighResUrl(targetEl, src);
                }
                if (targetUrl && targetUrl !== src) {
                    this._hdUrlCache.set(src, targetUrl);
                    // 兼容其他模块可能读取的全局 map
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

    // 内联缓存查找，避免每个属性都调用 setStyle 造成双重 WeakMap 查找
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
        this.elements.toast.textContent = text; // textContent 不触发布局，比 innerText 快
        this.elements.toast.classList.add('show');
        this._toastTimer = setTimeout(() => this.elements.toast.classList.remove('show'), 1200);
    }

    updateStatus(type, currentW, currentH, isVideo) {
        if (!this.cfg.state.showStatus || currentW < 300 || currentH < 200) {
            this.setStyle(this.elements.status, 'display', 'none');
            return;
        }
        this.setStyle(this.elements.status, 'display', 'block');

        // ✨ 优化：展示真实图片原始分辨率（而非放大后的视口尺寸）
        const nw = isVideo ? 0 : (this.elements.img.naturalWidth || 0);
        const nh = isVideo ? 0 : (this.elements.img.naturalHeight || 0);
        const dimStr = (nw > 0 && nh > 0) ? ` · ${nw}×${nh}` : '';

        if (isVideo) {
            const vw = this.elements.canvas.width || 0;
            const vh = this.elements.canvas.height || 0;
            const vDim = (vw > 0 && vh > 0) ? ` · ${vw}×${vh}` : '';
            this.elements.status.textContent = `🎥 视频${vDim}`;
            this.setClass(this.elements.status, 'status-hd');
            this.setStyle(this.elements.status, 'background-color', '#1da1f2');
        } else if (type === 'hd') {
            const loading = this.hdState.isLoading;
            this.setClass(this.elements.status, loading ? 'status-hd is-loading' : 'status-hd');
            this.elements.status.textContent = loading ? '⏳ 高清解析中...' : `高清${dimStr}`;
            this.setStyle(this.elements.status, 'background-color', '');
        } else {
            this.setClass(this.elements.status, 'status-original');
            this.elements.status.textContent = `原图${dimStr}`;
            this.setStyle(this.elements.status, 'background-color', '');
        }
    }

    // 按需检查协议状态，取代原来的 setInterval 轮询
    // 在 updateLayout 中自动调用，完全事件驱动，零额外开销
    _syncNoticeVisibility() {
        if (this.cfg.state.hasAgreed && this.elements.notice.style.display !== 'none') {
            this.elements.notice.style.display = 'none';
        }
    }

    hide() {
        this.setStyles(this.elements.viewer, {
            display: 'none', cursor: 'default', 'pointer-events': 'none'
        });
        this.setStyles(this.elements.img,    { display: 'none', cursor: 'default' });
        this.setStyles(this.elements.canvas, { display: 'none' });
        this.setStyles(this.elements.spinner, { display: 'none' });
        this.setStyles(this.elements.progressContainer, { display: 'none' });
        this.setStyle(this.elements.hint, 'opacity', '0');
        // ✨ 关闭时同步隐藏右键菜单和计数器
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
        this.currentVideoEl = videoEl;
        this._lastProgressPct = null;

        this.setStyles(this.elements.img,              { display: 'none' });
        this.setStyles(this.elements.canvas,           { display: 'block' });
        this.setStyles(this.elements.progressContainer,{ display: 'block' });

        this.elements.canvas.width  = videoEl.videoWidth  || videoEl.clientWidth  || 800;
        this.elements.canvas.height = videoEl.videoHeight || videoEl.clientHeight || 600;

        videoEl.muted = false;
        if (videoEl.readyState === 0) {
            this.setStyle(this.elements.spinner, 'display', 'block');
            videoEl.addEventListener('canplay', () => {
                this.setStyle(this.elements.spinner, 'display', 'none');
                if (!window.__mix01UserPaused) videoEl.play().catch(() => {});
            }, { once: true });
        } else {
            videoEl.play().catch(() => {});
        }

        // 纯绘制循环，不再混入 play() 逻辑，保持每帧职责单一
        const drawFrame = () => {
            if (!this.videoState.isRunning || !this.canvasCtx) return;

            if (videoEl.videoWidth) {
                // 仅在分辨率真正变化时才 resize canvas，避免无谓的内存重分配
                if (this.elements.canvas.width !== videoEl.videoWidth) {
                    this.elements.canvas.width  = videoEl.videoWidth;
                    this.elements.canvas.height = videoEl.videoHeight;
                }
                if (!videoEl.paused || videoEl.readyState >= 2) {
                    this.canvasCtx.drawImage(videoEl, 0, 0, this.elements.canvas.width, this.elements.canvas.height);
                }
            }

            // 进度条：缓存上次百分比，避免每帧都 setProperty
            if (videoEl.duration > 0) {
                const pct = ((videoEl.currentTime / videoEl.duration) * 100).toFixed(2) + '%';
                if (pct !== this._lastProgressPct) {
                    this.elements.progressBar.style.setProperty('width', pct, 'important');
                    this._lastProgressPct = pct;
                }
            }

            if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
                this.videoState.callbackId = videoEl.requestVideoFrameCallback(drawFrame);
            } else {
                this.videoState.rAFId = requestAnimationFrame(drawFrame);
            }
        };

        // 播放恢复检测独立到 1s 间隔，不污染高频绘制循环
        this._videoStallInterval = setInterval(() => {
            if (!this.videoState.isRunning) return;
            if (videoEl.paused && videoEl.readyState >= 3 && !window.__mix01UserPaused) {
                videoEl.play().catch(() => {});
            }
        }, 1000);

        drawFrame();
    }

    stopVideoRender() {
        this.videoState.isRunning = false;
        clearInterval(this._videoStallInterval);
        this._lastProgressPct = null;

        if (this.videoState.callbackId != null && this.currentVideoEl &&
            'cancelVideoFrameCallback' in HTMLVideoElement.prototype) {
            this.currentVideoEl.cancelVideoFrameCallback(this.videoState.callbackId);
        }
        if (this.videoState.rAFId) {
            cancelAnimationFrame(this.videoState.rAFId);
        }
        this.videoState.callbackId = null;
        this.videoState.rAFId = null;

        if (this.currentVideoEl && this.videoState.original) {
            this.currentVideoEl.muted = this.videoState.original.muted;
            if (this.videoState.original.paused) this.currentVideoEl.pause();
            else this.currentVideoEl.play().catch(() => {});
            this.videoState.original = null;
        }
        this.currentVideoEl = null;
    }

    updateLayout(activeMedia, rect, activeZoom, xP, yP, isSmallOptimized, customLensWidth, customLensHeight, isZoomManuallyChanged, currentHoveredSrc) {
        const sW = window.innerWidth, sH = window.innerHeight;
        const isVideo = activeMedia === this.elements.canvas;
        const nw = isVideo ? (activeMedia.width  || rect.width  || 1) : (activeMedia.naturalWidth  || rect.width  || 1);
        const nh = isVideo ? (activeMedia.height || rect.height || 1) : (activeMedia.naturalHeight || rect.height || 1);
        const naturalRatio = nw / nh;
        let cDW = 0, cDH = 0;
        const mode = this.cfg.state.mode;

        // 协议状态按需同步，无需 setInterval 轮询
        this._syncNoticeVisibility();

        this.setClass(this.elements.viewer, this.cfg.state.isImmersive ? 'mode-immersive' : `mode-${mode}`);

        if (this.cfg.state.isImmersive) {
            // 沉浸模式：全屏覆盖，pointer-events 开启以响应交互
            this.setStyles(this.elements.viewer, {
                display: 'block', position: 'fixed', width: '100vw', height: '100vh',
                left: '0px', top: '0px', 'background-color': 'rgba(0,0,0,0.95)',
                'background-image': 'none', border: 'none', 'border-radius': '0',
                transform: 'none', 'pointer-events': 'auto'
            });
            // 沉浸模式也需要保证最高层级（页面可能在 show 之后动态插入高 z-index 元素）
            this._enforceTopLayer();

            if (!isZoomManuallyChanged) {
                const maxW = sW * 0.95, maxH = sH * 0.95;
                let fitW = nw, fitH = nh;
                if (fitW > maxW) { fitW = maxW; fitH = fitW / naturalRatio; }
                if (fitH > maxH) { fitH = maxH; fitW = fitH * naturalRatio; }
                activeZoom = fitW / nw;
            }

            let tW = nw * activeZoom, tH = nh * activeZoom;
            cDW = tW; cDH = tH;

            this.setStyles(activeMedia, {
                position: 'absolute', width: `${tW}px`, height: `${tH}px`, margin: '0px'
            });

            let offsetX = (sW - tW) / 2;
            let offsetY = (sH - tH) / 2;

            if (isZoomManuallyChanged && (tW > sW || tH > sH)) {
                offsetX = (tW > sW) ? -(tW - sW) * xP : offsetX;
                offsetY = (tH > sH) ? -(tH - sH) * yP : offsetY;
            }

            this.setStyle(activeMedia, 'transform',
                `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`);
            this.setStyle(activeMedia, 'left', '0px');
            this.setStyle(activeMedia, 'top',  '0px');
        }
        else if (mode === 'partial') {
            this.setStyle(this.elements.viewer, 'display',   'block');
            this.setStyle(this.elements.viewer, 'position',  'fixed');
            this.setStyle(this.elements.viewer, 'overflow',  'hidden');
            // 放大镜模式同样强制最高层级
            this._enforceTopLayer();

            if (this.cfg.state.hasAgreed) {
                cDW = rect.width  * activeZoom;
                cDH = rect.height * activeZoom;
                this.setStyle(activeMedia, 'width',    cDW + 'px');
                this.setStyle(activeMedia, 'height',   cDH + 'px');
                this.setStyle(activeMedia, 'position', 'absolute');

                let lensW, lensH;
                if (isSmallOptimized && customLensWidth && customLensHeight) {
                    lensW = customLensWidth; lensH = customLensHeight;
                } else {
                    lensW = Math.min(350, Math.max(100, cDW + 20));
                    lensH = Math.min(350, Math.max(100, cDH + 20));
                }
                this.setStyle(this.elements.viewer, 'width',  lensW + 'px');
                this.setStyle(this.elements.viewer, 'height', lensH + 'px');

                const clientX = window.lastMouseX || rect.left + rect.width  / 2;
                const clientY = window.lastMouseY || rect.top  + rect.height / 2;

                let vX = clientX + 20, vY = clientY + 20;
                if (vX + lensW > sW) vX = clientX - lensW - 20;
                if (vY + lensH > sH) vY = clientY - lensH - 20;
                this.setStyle(this.elements.viewer, 'transform', `translate3d(${vX}px,${vY}px,0)`);
                this.setStyle(this.elements.viewer, 'left', '0px');
                this.setStyle(this.elements.viewer, 'top',  '0px');

                if (cDW < 350 && cDH < 350 && !customLensWidth) {
                    this.setStyle(this.elements.viewer, 'border', '1px solid rgba(255,255,255,0.2)');
                    this.setStyle(this.elements.viewer, 'background-image', 'radial-gradient(circle, rgba(20,20,20,1) 0%, rgba(0,0,0,1) 100%)');
                    this.setStyle(this.elements.viewer, 'background-color', '#000');
                } else {
                    this.setStyle(this.elements.viewer, 'background-image', 'none');
                    this.setStyle(this.elements.viewer, 'background-color', 'transparent');
                    this.setStyle(this.elements.viewer, 'border', '1px solid rgba(255,255,255,0.4)');
                }

                this.setStyles(activeMedia, { right: 'auto', bottom: 'auto', margin: '0px' });
                let offsetX = 0, offsetY = 0;
                if (cDW > lensW) offsetX = -(cDW * xP - lensW / 2);
                else              offsetX = (lensW - cDW) / 2;
                if (cDH > lensH) offsetY = -(cDH * yP - lensH / 2);
                else              offsetY = (lensH - cDH) / 2;
                this.setStyles(activeMedia, {
                    transform: `translate3d(${offsetX}px,${offsetY}px,0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`,
                    left: '0px', top: '0px'
                });
            }
        } else {
            this.setStyles(this.elements.viewer, {
                display: 'block', position: 'fixed',
                'background-color': 'rgba(20,20,20,0.9)', 'background-image': 'none'
            });
            this._enforceTopLayer();
            this.setStyles(activeMedia, { position: 'absolute', right: 'auto', bottom: 'auto', margin: '0px' });

            let tW = rect.width * activeZoom, tH = rect.height * activeZoom;
            const maxVW = sW * (mode === 'full-follow' ? 0.7 : 0.95);
            const maxVH = sH * (mode === 'full-follow' ? 0.7 : 0.95);

            const clientX = window.lastMouseX || rect.left + rect.width  / 2;
            const clientY = window.lastMouseY || rect.top  + rect.height / 2;

            if (!this.cfg.state.breakoutView || !this.cfg.state.hasAgreed) {
                const safeMaxVW = maxVW - 10, safeMaxVH = maxVH - 10;
                const ratio = (rect.width / rect.height) || 1;
                if (tW > safeMaxVW) { tW = safeMaxVW; tH = tW / ratio; }
                if (tH > safeMaxVH) { tH = safeMaxVH; tW = tH * ratio; }
                cDW = tW; cDH = tH;
                this.setStyle(this.elements.viewer, 'width',  `${tW}px`);
                this.setStyle(this.elements.viewer, 'height', `${tH}px`);
                if (this.cfg.state.hasAgreed) {
                    this.setStyle(activeMedia, 'width',  '100%');
                    this.setStyle(activeMedia, 'height', '100%');
                    this.setStyle(activeMedia, 'transform',
                        `translate3d(0,0,0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`);
                    this.setStyle(activeMedia, 'left', '0px');
                    this.setStyle(activeMedia, 'top',  '0px');
                }
            } else {
                const vW = Math.min(tW, maxVW), vH = Math.min(tH, maxVH);
                cDW = vW; cDH = vH;
                this.setStyle(this.elements.viewer, 'width',  `${vW}px`);
                this.setStyle(this.elements.viewer, 'height', `${vH}px`);
                this.setStyle(activeMedia, 'width',  `${tW}px`);
                this.setStyle(activeMedia, 'height', `${tH}px`);
                let mX = (tW > vW) ? -(tW - vW) * xP : 0;
                let mY = (tH > vH) ? -(tH - vH) * yP : 0;
                this.setStyles(activeMedia, {
                    transform: `translate3d(${mX}px,${mY}px,0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`,
                    left: '0px', top: '0px'
                });
            }

            if (mode === 'full-follow') {
                let vX = clientX + 25, vY = clientY + 25;
                if (vX + cDW > sW) vX = clientX - cDW - 20;
                if (vY + cDH > sH) vY = clientY - cDH - 20;
                this.setStyle(this.elements.viewer, 'transform', `translate3d(${vX}px,${vY}px,0)`);
                this.setStyle(this.elements.viewer, 'left', '0px');
                this.setStyle(this.elements.viewer, 'top',  '0px');
            } else {
                const margin = 30;
                let vX = (clientX < sW / 2) ? sW - cDW - margin : margin;
                let vY = clientY - (cDH / 2);
                if (vY < margin)          vY = margin;
                if (vY + cDH > sH - margin) vY = sH - cDH - margin;
                this.setStyle(this.elements.viewer, 'transform', `translate3d(${vX}px,${vY}px,0)`);
                this.setStyle(this.elements.viewer, 'left', '0px');
                this.setStyle(this.elements.viewer, 'top',  '0px');
            }
        }

        this.updateStatus(activeMedia.src !== currentHoveredSrc ? 'hd' : 'original', cDW, cDH, isVideo);
        return activeZoom;
    }

    /**
     * ✨ 右键菜单：在指定坐标弹出，绑定回调
     * @param {number} x  clientX
     * @param {number} y  clientY
     * @param {Object} callbacks  { 'copy-img', 'copy-url', 'open-tab', 'save', 'disable-site', 'close' }
     */
    showContextMenu(x, y, callbacks) {
        const menu = this.elements.ctxMenu;
        if (!menu) return;

        // 更新"禁用站点"项的文本，反映当前状态
        const disableItem = menu.querySelector('[data-action="disable-site"]');
        if (disableItem) {
            const isEnabled = this.cfg.isSiteEnabled();
            disableItem.textContent = isEnabled ? '🚫 在此网站禁用引擎' : '✅ 在此网站启用引擎';
        }

        // 移除旧监听，防止重复绑定
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

        // 定位：自动避免超出视口
        newMenu.style.setProperty('display', 'block', 'important');
        const mW = newMenu.offsetWidth, mH = newMenu.offsetHeight;
        const vW = window.innerWidth, vH = window.innerHeight;
        const finalX = (x + mW > vW) ? Math.max(0, x - mW) : x;
        const finalY = (y + mH > vH) ? Math.max(0, y - mH) : y;
        newMenu.style.setProperty('left', `${finalX}px`, 'important');
        newMenu.style.setProperty('top',  `${finalY}px`, 'important');
        newMenu.style.setProperty('opacity', '0', 'important');
        requestAnimationFrame(() => newMenu.style.setProperty('opacity', '1', 'important'));

        // 点击其他区域关闭
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

    /**
     * ✨ 沉浸模式图片计数器
     * @param {number} current  当前索引（0-based）
     * @param {number} total    总数
     */
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

        void this.elements.hint.offsetWidth; // 强制 reflow，触发 transition
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