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

        this.elements.viewer = create('div', 'img-zoom-pro-viewer-xyz');
        this.elements.img = create('img', 'zoom-img-xyz');
        this.elements.canvas = create('canvas', 'zoom-canvas-xyz');
        this.elements.spinner = create('div', 'zoom-loading-xyz');
        this.elements.progressContainer = create('div', 'mix01-video-progress-container');
        this.elements.progressBar = create('div', 'mix01-video-progress-bar');
        this.elements.progressContainer.appendChild(this.elements.progressBar);
        this.elements.status = create('div', 'img-zoom-pro-status-label');
        this.elements.toast = create('div', '', 'img-zoom-toast-xyz');
        this.elements.notice = create('div', '', 'notice-container-xyz');
        this.elements.notice.innerHTML = '⚠️ 未同意协议<br>请点击右上角图标同意并开启功能';
        this.elements.hint = create('div', 'img-zoom-pro-immersive-hint');

        const styleBlock = document.createElement('style');
        styleBlock.innerHTML = `
            .kbd-btn { background:rgba(255,255,255,0.2); padding:2px 6px; border-radius:4px; font-family: monospace; font-weight: bold; margin: 0 2px;}
            .author-tag { color: #1da1f2; font-weight: bold; margin: 0 4px; }
            .hud-status-item { font-weight: bold; transition: color 0.3s ease; display: inline-block; }
        `;
        document.head.appendChild(styleBlock);

        // 强绑过渡动画，配合 inputController 里的 decode().then 使得渐现平滑如丝
        this.elements.img.style.setProperty('transition', 'opacity 0.2s ease, transform 0.1s cubic-bezier(0.2, 0, 0.2, 1)', 'important');

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
        };
        appendAll();

        this.domGuard = new MutationObserver(() => {
            if (!document.getElementById('img-zoom-pro-viewer-xyz') && document.body) {
                document.body.appendChild(this.elements.viewer);
                document.body.appendChild(this.elements.toast);
            }
        });
        if (document.body) {
            this.domGuard.observe(document.body, { childList: true });
        } else {
            document.addEventListener('DOMContentLoaded', () => this.domGuard.observe(document.body, { childList: true }));
        }

        // 修复：偶尔未授权弹窗问题，监听hasAgreed变化
        this.agreedObserver = new MutationObserver(() => {
            if (this.cfg.state.hasAgreed && this.elements.notice.style.display !== 'none') {
                this.elements.notice.style.display = 'none';
            }
        });
        // 监听config变化，但由于cfg是对象，改为定时检查
        this.agreedCheckInterval = setInterval(() => {
            if (this.cfg.state.hasAgreed && this.elements.notice.style.display !== 'none') {
                this.elements.notice.style.display = 'none';
            }
        }, 1000); // 每秒检查一次
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            const getUrlAndProcess = async (actionFn) => {
                const src = request.clickedUrl || this.elements.img.src;

                window.__mix01HdUrlMap = window.__mix01HdUrlMap || {};
                // 优化：限制缓存大小，避免内存泄漏
                if (Object.keys(window.__mix01HdUrlMap).length > 100) {
                    // 清理最旧的50%条目
                    const keys = Object.keys(window.__mix01HdUrlMap);
                    keys.slice(0, Math.floor(keys.length / 2)).forEach(k => delete window.__mix01HdUrlMap[k]);
                }
                if (window.__mix01HdUrlMap[src]) {
                    actionFn(window.__mix01HdUrlMap[src]);
                    return;
                }

                const targetEl = request.clickedUrl
                    ? (window.lastHoveredSrc === request.clickedUrl ? window.lastHoveredMedia : document.createElement('img'))
                    : this.elements.img;
                let targetUrl = src;
                if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                    targetUrl = await window.Mix01RuleEngine.getHighResUrl(targetEl, src);
                }
                if (targetUrl && targetUrl !== src) {
                    window.__mix01HdUrlMap[src] = targetUrl;
                }
                actionFn(targetUrl);
            };

            if (request.action === "getHDUrl") {
                getUrlAndProcess(url => sendResponse({ url: url }));
                return true;
            } else if (request.action === "copyHDUrl") {
                getUrlAndProcess(url => { window.Mix01Utils.copyImageToClipboard(url, this); sendResponse({ status: "ok" }); });
                return true;
            } else if (request.action === "saveHDUrl") {
                getUrlAndProcess(url => { window.Mix01Utils.downloadImage(url, this); sendResponse({ status: "ok" }); });
                return true;
            }
        });
    }

    setStyle(el, prop, val) {
        if (!this.styleCache.has(el)) this.styleCache.set(el, {});
        const cache = this.styleCache.get(el);
        if (cache[prop] !== val) {
            el.style.setProperty(prop, val, 'important');
            cache[prop] = val;
        }
    }

    setStyles(el, styles) {
        for (const prop in styles) {
            if (Object.prototype.hasOwnProperty.call(styles, prop)) {
                this.setStyle(el, prop, styles[prop]);
            }
        }
    }

    setClass(el, className) {
        if (el.className !== className) {
            el.className = className;
        }
    }

    showToast(text) {
        clearTimeout(this.toastTimer);
        this.elements.toast.innerText = text; 
        this.elements.toast.classList.add('show');
        this.toastTimer = setTimeout(() => this.elements.toast.classList.remove('show'), 1200);
    }

    updateStatus(type, currentW, currentH, isVideo) {
        if (!this.cfg.state.showStatus || (currentW < 300 || currentH < 200)) { this.setStyle(this.elements.status, 'display', 'none'); return; }
        this.setStyle(this.elements.status, 'display', 'block');
        
        if (isVideo) {
            this.elements.status.innerText = '🎥 视频流媒体';
            this.setClass(this.elements.status, 'status-hd');
            this.setStyle(this.elements.status, 'background-color', '#1da1f2');
        } else {
            if (type === 'hd') {
                this.setClass(this.elements.status, this.hdState.isLoading ? 'status-hd is-loading' : 'status-hd');
                this.elements.status.innerText = this.hdState.isLoading ? '⏳ 高清解析中...' : '高清解析';
                this.setStyle(this.elements.status, 'background-color', ''); 
            } else {
                this.setClass(this.elements.status, 'status-original');
                this.elements.status.innerText = '原图放大';
                this.setStyle(this.elements.status, 'background-color', '');
            }
        }
    }

    hide() {
        this.setStyles(this.elements.viewer, {
            display: 'none', cursor: 'default', 'pointer-events': 'none'
        });
        this.setStyles(this.elements.img, {
            display: 'none', cursor: 'default'
        });
        this.setStyles(this.elements.canvas, { display: 'none' });
        this.setStyles(this.elements.spinner, { display: 'none' });
        this.setStyles(this.elements.progressContainer, { display: 'none' });
        this.setStyle(this.elements.hint, 'opacity', '0');

        clearTimeout(this.hudState.cursorTimer);
        clearTimeout(this.hudState.hintTimer);
        clearInterval(this.agreedCheckInterval); // 清理定时器
        this.hdState.isLoading = false;
        this.stopVideoRender();
    }

    startVideoRender(videoEl) {
        this.videoState.isRunning = true;
        this.videoState.original = { paused: videoEl.paused, muted: videoEl.muted };
        this.currentVideoEl = videoEl;
        
        this.setStyles(this.elements.img, { display: 'none' });
        this.setStyles(this.elements.canvas, { display: 'block' });
        this.setStyles(this.elements.progressContainer, { display: 'block' });
        
        this.elements.canvas.width = videoEl.videoWidth || videoEl.clientWidth || 800;
        this.elements.canvas.height = videoEl.videoHeight || videoEl.clientHeight || 600;

        videoEl.muted = false;
        if (videoEl.readyState === 0) {
            this.setStyle(this.elements.spinner, 'display', 'block');
            videoEl.addEventListener('canplay', () => {
                this.setStyle(this.elements.spinner, 'display', 'none');
                if (!window.__mix01UserPaused) videoEl.play().catch(()=>{});
            }, { once: true });
        } else {
            videoEl.play().catch(()=>{});
        }

        const drawFrame = () => {
            if (!this.videoState.isRunning || !this.canvasCtx) return;
            
            if (videoEl.paused && videoEl.readyState >= 3 && !window.__mix01UserPaused) {
                videoEl.play().catch(()=>{}); 
            }

            if (videoEl.videoWidth && this.elements.canvas.width !== videoEl.videoWidth) {
                this.elements.canvas.width = videoEl.videoWidth;
                this.elements.canvas.height = videoEl.videoHeight;
            }
            
            if (videoEl.duration) {
                const percent = (videoEl.currentTime / videoEl.duration) * 100;
                this.elements.progressBar.style.setProperty('width', `${percent}%`, 'important');
            }

            this.canvasCtx.drawImage(videoEl, 0, 0, this.elements.canvas.width, this.elements.canvas.height);
            
            if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
                this.videoState.callbackId = videoEl.requestVideoFrameCallback(drawFrame);
            } else {
                this.videoState.rAFId = requestAnimationFrame(drawFrame);
            }
        };
        drawFrame();
    }

    stopVideoRender() {
        this.videoState.isRunning = false;
        if (this.videoState.callbackId && this.currentVideoEl && 'cancelVideoFrameCallback' in HTMLVideoElement.prototype) {
             this.currentVideoEl.cancelVideoFrameCallback(this.videoState.callbackId);
        }
        if (this.videoState.rAFId) cancelAnimationFrame(this.videoState.rAFId);
        
        if (this.currentVideoEl && this.videoState.original) {
            this.currentVideoEl.muted = this.videoState.original.muted;
            if (this.videoState.original.paused) this.currentVideoEl.pause();
            else this.currentVideoEl.play().catch(()=>{});
            this.videoState.original = null;
        }
        this.currentVideoEl = null;
    }

    updateLayout(activeMedia, rect, activeZoom, xP, yP, isSmallOptimized, customLensWidth, customLensHeight, isZoomManuallyChanged, currentHoveredSrc) {
        const sW = window.innerWidth, sH = window.innerHeight;
        const isVideo = activeMedia === this.elements.canvas;
        const nw = isVideo ? (activeMedia.width || rect.width || 1) : (activeMedia.naturalWidth || rect.width || 1);
        const nh = isVideo ? (activeMedia.height || rect.height || 1) : (activeMedia.naturalHeight || rect.height || 1);
        const naturalRatio = nw / nh;
        let cDW = 0, cDH = 0;
        const mode = this.cfg.state.mode;

        this.setClass(this.elements.viewer, this.cfg.state.isImmersive ? 'mode-immersive' : `mode-${mode}`);

        if (this.cfg.state.isImmersive) {
            this.setStyles(this.elements.viewer, {
                display: 'block', position: 'fixed', width: '100vw', height: '100vh',
                left: '0px', top: '0px', 'background-color': 'rgba(0, 0, 0, 0.95)',
                'background-image': 'none', border: 'none', 'border-radius': '0',
                transform: 'none', 'pointer-events': 'auto'
            });
            
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
            
            // 此处的 transform 矩阵将被 rAF 完美接管，形成纯粹的高性能渲染管道
            this.setStyle(activeMedia, 'transform', `translate3d(${offsetX}px, ${offsetY}px, 0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`);
            this.setStyle(activeMedia, 'left', '0px'); this.setStyle(activeMedia, 'top', '0px');
        } 
        else if (mode === 'partial') {
            this.setStyle(this.elements.viewer, 'display', 'block'); this.setStyle(this.elements.viewer, 'position', 'fixed'); this.setStyle(this.elements.viewer, 'overflow', 'hidden'); 
            
            if (this.cfg.state.hasAgreed) {
                cDW = rect.width * activeZoom; cDH = rect.height * activeZoom;
                this.setStyle(activeMedia, 'width', cDW + 'px'); this.setStyle(activeMedia, 'height', cDH + 'px');
                this.setStyle(activeMedia, 'position', 'absolute'); 

                let lensW, lensH;
                if (isSmallOptimized && customLensWidth && customLensHeight) {
                    lensW = customLensWidth; lensH = customLensHeight;
                } else {
                    lensW = Math.min(350, Math.max(100, cDW + 20)); lensH = Math.min(350, Math.max(100, cDH + 20));
                }

                this.setStyle(this.elements.viewer, 'width', lensW + 'px'); this.setStyle(this.elements.viewer, 'height', lensH + 'px');
                
                const clientX = window.lastMouseX || rect.left + rect.width/2;
                const clientY = window.lastMouseY || rect.top + rect.height/2;

                let vX = clientX + 20, vY = clientY + 20;
                if (vX + lensW > sW) vX = clientX - lensW - 20;
                if (vY + lensH > sH) vY = clientY - lensH - 20;
                this.setStyle(this.elements.viewer, 'transform', `translate3d(${vX}px, ${vY}px, 0)`);
                this.setStyle(this.elements.viewer, 'left', '0px'); this.setStyle(this.elements.viewer, 'top', '0px');

                if (cDW < 350 && cDH < 350 && !customLensWidth) {
                    this.setStyle(this.elements.viewer, 'border', '1px solid rgba(255, 255, 255, 0.2)'); 
                    this.setStyle(this.elements.viewer, 'background-image', 'radial-gradient(circle, rgba(20,20,20,1) 0%, rgba(0,0,0,1) 100%)'); 
                    this.setStyle(this.elements.viewer, 'background-color', '#000'); 
                } else {
                    this.setStyle(this.elements.viewer, 'background-image', 'none'); this.setStyle(this.elements.viewer, 'background-color', 'transparent'); 
                    this.setStyle(this.elements.viewer, 'border', '1px solid rgba(255, 255, 255, 0.4)'); 
                }

                this.setStyles(activeMedia, { right: 'auto', bottom: 'auto', margin: '0px' });
                let offsetX = 0, offsetY = 0;
                if (cDW > lensW) offsetX = -(cDW * xP - lensW / 2); else offsetX = (lensW - cDW) / 2;
                if (cDH > lensH) offsetY = -(cDH * yP - lensH / 2); else offsetY = (lensH - cDH) / 2;
                this.setStyles(activeMedia, {
                    transform: `translate3d(${offsetX}px, ${offsetY}px, 0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`,
                    left: '0px', top: '0px'
                });
            }
        } else {
            this.setStyles(this.elements.viewer, {
                display: 'block', position: 'fixed', 'background-color': 'rgba(20, 20, 20, 0.9)', 'background-image': 'none'
            });
            this.setStyles(activeMedia, { position: 'absolute', right: 'auto', bottom: 'auto', margin: '0px' });

            let tW = rect.width * activeZoom, tH = rect.height * activeZoom;
            const maxVW = sW * (mode === 'full-follow' ? 0.7 : 0.95);
            const maxVH = sH * (mode === 'full-follow' ? 0.7 : 0.95);
            
            const clientX = window.lastMouseX || rect.left + rect.width/2;
            const clientY = window.lastMouseY || rect.top + rect.height/2;

            if (!this.cfg.state.breakoutView || !this.cfg.state.hasAgreed) {
                const safeMaxVW = maxVW - 10; const safeMaxVH = maxVH - 10;
                const ratio = (rect.width / rect.height) || 1;
                if (tW > safeMaxVW) { tW = safeMaxVW; tH = tW / ratio; }
                if (tH > safeMaxVH) { tH = safeMaxVH; tW = tH * ratio; }
                cDW = tW; cDH = tH;
                this.setStyle(this.elements.viewer, 'width', `${tW}px`); this.setStyle(this.elements.viewer, 'height', `${tH}px`);
                if (this.cfg.state.hasAgreed) {
                    this.setStyle(activeMedia, 'width', '100%'); this.setStyle(activeMedia, 'height', '100%');
                    this.setStyle(activeMedia, 'transform', `translate3d(0, 0, 0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`);
                    this.setStyle(activeMedia, 'left', '0px'); this.setStyle(activeMedia, 'top', '0px');
                }
            } else {
                const vW = Math.min(tW, maxVW), vH = Math.min(tH, maxVH);
                cDW = vW; cDH = vH;
                this.setStyle(this.elements.viewer, 'width', `${vW}px`); this.setStyle(this.elements.viewer, 'height', `${vH}px`);
                this.setStyle(activeMedia, 'width', `${tW}px`); this.setStyle(activeMedia, 'height', `${tH}px`);
                let mX = (tW > vW) ? -(tW - vW) * xP : 0;
                let mY = (tH > vH) ? -(tH - vH) * yP : 0;
                this.setStyles(activeMedia, {
                    transform: `translate3d(${mX}px, ${mY}px, 0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`,
                    left: '0px', top: '0px'
                });
            }

            if (mode === 'full-follow') {
                let vX = clientX + 25, vY = clientY + 25;
                if (vX + cDW > sW) vX = clientX - cDW - 20;
                if (vY + cDH > sH) vY = clientY - cDH - 20;
                this.setStyle(this.elements.viewer, 'transform', `translate3d(${vX}px, ${vY}px, 0)`);
                this.setStyle(this.elements.viewer, 'left', '0px'); this.setStyle(this.elements.viewer, 'top', '0px');
            } else {
                const margin = 30; let vX, vY;
                if (clientX < sW / 2) vX = sW - cDW - margin; else vX = margin; 
                vY = clientY - (cDH / 2);
                if (vY < margin) vY = margin;
                if (vY + cDH > sH - margin) vY = sH - cDH - margin;
                this.setStyle(this.elements.viewer, 'transform', `translate3d(${vX}px, ${vY}px, 0)`);
                this.setStyle(this.elements.viewer, 'left', '0px'); this.setStyle(this.elements.viewer, 'top', '0px');
            }
        }

        this.updateStatus(activeMedia.src !== currentHoveredSrc ? 'hd' : 'original', cDW, cDH, isVideo);
        return activeZoom;
    }

    async handleImmersiveActivity(currentMedia, currentSrc, keys) {
        if (!this.cfg.state.isImmersive || this.elements.viewer.style.display !== 'block') return;

        const adapter = window.Mix01Utils.getImmersiveAdapter();
        let likeText = "喜欢"; let likeIcon = "🤍"; let likeColor = "#dddddd";
        let followText = "关注"; let followIcon = "👤"; let followColor = "#dddddd";
        let authorDisplay = "";
        let isFallback = false;

        if (currentMedia && adapter) {
            isFallback = adapter.isFallback === true;
            
            if (!isFallback && adapter.getStates) {
                const container = adapter.getContainer ? adapter.getContainer(currentMedia) : document.body;
                const states = await adapter.getStates(container, currentMedia);
                
                if (states) {
                    if (states.isLiked) { likeText = "已喜欢"; likeIcon = "❤️"; likeColor = "#FF4060"; }
                    if (states.isFollowed) { followText = "已关注"; followIcon = "✓"; followColor = "#1da1f2"; }
                    if (states.authorName) { authorDisplay = `<span class="author-tag">${states.authorName}</span> 的作品`; }
                }
            }
        }

        const keyMode = (keys.keyMode || 'V').toUpperCase();
        const keyDownload = (keys.keyDownloadVideo || 'D').toUpperCase();
        const keyLike = (keys.keyLike || 'L').toUpperCase();
        const keyFollow = (keys.keyFollow || 'F').toUpperCase();
        const hudSignature = `${currentSrc}|${keyMode}|${keyDownload}|${keyLike}|${keyFollow}|${likeText}|${followText}|${followColor}|${authorDisplay}`;
        if (this.immersiveState.lastMedia === currentMedia && this.immersiveState.lastSrc === currentSrc && this.immersiveState.lastHudSignature === hudSignature && this.elements.hint.style.display === 'block') {
            return;
        }
        this.immersiveState.lastMedia = currentMedia;
        this.immersiveState.lastSrc = currentSrc;
        this.immersiveState.lastHudSignature = hudSignature;

        let hudHTML = `<div style="display:flex; align-items:center; gap: 15px;">`;
        hudHTML += `<span class="hud-status-item">切换 <span class="kbd-btn">${(keys.keyMode || 'V').toUpperCase()}</span></span>`;
        hudHTML += `<span class="hud-status-item">暂停 <span class="kbd-btn">SPACE</span></span>`;
        hudHTML += `<span class="hud-status-item" style="color: #4A90E2; font-weight: bold;">原图下载 <span class="kbd-btn">${(keys.keyDownloadVideo || 'D').toUpperCase()}</span></span>`;
        
        if (!isFallback) {
            hudHTML += `<span class="hud-status-item" style="color: ${likeColor}">${likeIcon} ${likeText} <span class="kbd-btn">${(keys.keyLike || 'L').toUpperCase()}</span></span>`;
            hudHTML += `<span class="hud-status-item" style="color: ${followColor}">${followIcon} ${followText} <span class="kbd-btn">${(keys.keyFollow || 'F').toUpperCase()}</span></span>`;
            if (authorDisplay) hudHTML += `<span style="margin-left: 10px; border-left: 1px solid rgba(255,255,255,0.3); padding-left: 10px;">${authorDisplay}</span>`;
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