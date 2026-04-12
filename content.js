// content.js - Mix01 高性能解耦渲染引擎 (并发预加载终极版)
(function () {
    if (window.__imgZoomProInitialized) return;
    window.__imgZoomProInitialized = true;

    window.__mix01UserPaused = false;
    window.isFetchingMore = false;
    window.__mix01FollowCache = window.__mix01FollowCache || {};
    window.__mix01LikeMediaCache = window.__mix01LikeMediaCache || {};
    window.__mix01FollowAuthorCache = window.__mix01FollowAuthorCache || {};

    function getImmersiveAdapter() {
        if (window.Mix01ImmersiveEngine && window.Mix01ImmersiveEngine.getAdapter) {
            return window.Mix01ImmersiveEngine.getAdapter(window.location.hostname);
        }
        return null;
    }

    async function copyImageToClipboard(url, renderer) {
        renderer.showToast("⏳ 正在获取并处理原图...");
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const img = new Image();
            const blobUrl = URL.createObjectURL(blob);
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width; canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(async (pngBlob) => {
                    try {
                        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
                        renderer.showToast("✅ 已成功复制原图到剪切板！");
                    } catch (err) { renderer.showToast("❌ 写入失败，请确保页面保持聚焦"); }
                    URL.revokeObjectURL(blobUrl);
                }, 'image/png');
            };
            img.onerror = () => { renderer.showToast("❌ 渲染失败"); URL.revokeObjectURL(blobUrl); };
            img.src = blobUrl;
        } catch (err) { renderer.showToast("❌ 获取图片失败，存在跨域限制"); }
    }

    function downloadImage(url, renderer) {
        renderer.showToast("⏳ 正在打通后台进行安全下载...");
        try {
            chrome.runtime.sendMessage({ action: "downloadImmersiveImg", url: url }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn(chrome.runtime.lastError);
                    renderer.showToast("❌ 后台离线！请去扩展管理页【刷新本插件】");
                } else {
                    renderer.showToast("✅ 下载指令已送达后台！");
                }
            });
        } catch (e) {
            renderer.showToast("❌ 扩展环境已失效，请刷新当前网页重试！");
        }
    }

    // ==========================================
    // 1. ConfigManager: 状态与配置中心
    // ==========================================
    class ConfigManager {
        constructor() {
            this.state = {
                hasAgreed: false, loadHD: 'true', breakoutView: false,
                showStatus: true, smallImageOptimization: true,
                disableVideoDefaultView: true, zoom: 2.0, rotate: 0,
                mirror: 1, mode: 'partial', isImmersive: false, preloadCount: 5
            };
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
                if (res[k] !== undefined) this.state[k] = (k === 'zoom' || k === 'preloadCount') ? Number(res[k]) : res[k];
            });
            if (res.siteModes) this.siteModes = res.siteModes;
            if (res.mode) this.state.mode = this.siteModes[window.location.hostname] || res.mode || 'partial';
            
            Object.keys(this.keys).forEach(k => {
                let storageKey = 'key' + k.charAt(0).toUpperCase() + k.slice(1);
                if (res[storageKey]) this.keys[k] = res[storageKey];
            });
        }

        save(data) {
            if (this.isContextValid()) chrome.storage.local.set(data);
        }
    }

    // ==========================================
    // 2. MediaRenderer: 纯粹的视觉层与硬件加速渲染
    // ==========================================
    class MediaRenderer {
        constructor(configManager) {
            this.cfg = configManager;
            this.styleCache = new WeakMap();
            this.elements = {};
            this.videoState = { isRunning: false, callbackId: null, rAFId: null, original: null };
            this.hudState = { cursorTimer: null, hintTimer: null };
            this.hdState = { isLoading: false, badUrls: new Set() };
            
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
        }

        setupMessageListener() {
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                const getUrlAndProcess = async (actionFn) => {
                    const src = request.clickedUrl || this.elements.img.src;
                    const targetEl = request.clickedUrl ? (window.lastHoveredSrc === request.clickedUrl ? window.lastHoveredMedia : document.createElement('img')) : this.elements.img;
                    let targetUrl = src;
                    if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                        targetUrl = await window.Mix01RuleEngine.getHighResUrl(targetEl, src);
                    }
                    actionFn(targetUrl);
                };

                if (request.action === "getHDUrl") {
                    getUrlAndProcess(url => sendResponse({ url: url }));
                    return true;
                } else if (request.action === "copyHDUrl") {
                    getUrlAndProcess(url => { copyImageToClipboard(url, this); sendResponse({ status: "ok" }); });
                    return true;
                } else if (request.action === "saveHDUrl") {
                    getUrlAndProcess(url => { downloadImage(url, this); sendResponse({ status: "ok" }); });
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
                this.elements.status.className = 'status-hd';
                this.elements.status.style.backgroundColor = '#1da1f2';
            } else {
                if (type === 'hd') {
                    this.elements.status.className = this.hdState.isLoading ? 'status-hd is-loading' : 'status-hd';
                    this.elements.status.innerText = this.hdState.isLoading ? '⏳ 高清解析中...' : '高清解析';
                    this.elements.status.style.backgroundColor = ''; 
                } else {
                    this.elements.status.className = 'status-original';
                    this.elements.status.innerText = '原图放大';
                    this.elements.status.style.backgroundColor = '';
                }
            }
        }

        hide() {
            this.setStyle(this.elements.viewer, 'display', 'none');
            this.setStyle(this.elements.img, 'display', 'none');
            this.setStyle(this.elements.canvas, 'display', 'none');
            this.setStyle(this.elements.spinner, 'display', 'none');
            this.setStyle(this.elements.progressContainer, 'display', 'none');
            this.setStyle(this.elements.hint, 'opacity', '0');
            this.setStyle(this.elements.viewer, 'cursor', 'default');
            this.setStyle(this.elements.img, 'cursor', 'default');
            this.setStyle(this.elements.viewer, 'pointer-events', 'none');

            clearTimeout(this.hudState.cursorTimer);
            clearTimeout(this.hudState.hintTimer);
            this.hdState.isLoading = false;
            this.stopVideoRender();
        }

        startVideoRender(videoEl) {
            this.videoState.isRunning = true;
            this.videoState.original = { paused: videoEl.paused, muted: videoEl.muted };
            this.currentVideoEl = videoEl;
            
            this.setStyle(this.elements.img, 'display', 'none');
            this.setStyle(this.elements.canvas, 'display', 'block');
            this.setStyle(this.elements.progressContainer, 'display', 'block');
            
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

            this.elements.viewer.className = this.cfg.state.isImmersive ? 'mode-immersive' : `mode-${mode}`;

            if (this.cfg.state.isImmersive) {
                this.setStyle(this.elements.viewer, 'display', 'block');
                this.setStyle(this.elements.viewer, 'position', 'fixed');
                this.setStyle(this.elements.viewer, 'width', '100vw');
                this.setStyle(this.elements.viewer, 'height', '100vh');
                this.setStyle(this.elements.viewer, 'left', '0px');
                this.setStyle(this.elements.viewer, 'top', '0px');
                this.setStyle(this.elements.viewer, 'background-color', 'rgba(0, 0, 0, 0.95)');
                this.setStyle(this.elements.viewer, 'background-image', 'none');
                this.setStyle(this.elements.viewer, 'border', 'none');
                this.setStyle(this.elements.viewer, 'border-radius', '0');
                this.setStyle(this.elements.viewer, 'transform', 'none');
                this.setStyle(this.elements.viewer, 'pointer-events', 'auto');
                
                if (!isZoomManuallyChanged) {
                    const maxW = sW * 0.95, maxH = sH * 0.95;
                    let fitW = nw, fitH = nh;
                    if (fitW > maxW) { fitW = maxW; fitH = fitW / naturalRatio; }
                    if (fitH > maxH) { fitH = maxH; fitW = fitH * naturalRatio; }
                    activeZoom = fitW / nw; 
                }
                
                let tW = nw * activeZoom, tH = nh * activeZoom;
                cDW = tW; cDH = tH;
                
                this.setStyle(activeMedia, 'position', 'absolute');
                this.setStyle(activeMedia, 'width', `${tW}px`); this.setStyle(activeMedia, 'height', `${tH}px`);
                this.setStyle(activeMedia, 'margin', '0px');

                let offsetX = (sW - tW) / 2;
                let offsetY = (sH - tH) / 2;

                if (isZoomManuallyChanged && (tW > sW || tH > sH)) {
                    offsetX = (tW > sW) ? -(tW - sW) * xP : offsetX;
                    offsetY = (tH > sH) ? -(tH - sH) * yP : offsetY;
                }
                
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

                    this.setStyle(activeMedia, 'right', 'auto'); this.setStyle(activeMedia, 'bottom', 'auto'); this.setStyle(activeMedia, 'margin', '0px');
                    let offsetX = 0, offsetY = 0;
                    if (cDW > lensW) offsetX = -(cDW * xP - lensW / 2); else offsetX = (lensW - cDW) / 2;
                    if (cDH > lensH) offsetY = -(cDH * yP - lensH / 2); else offsetY = (lensH - cDH) / 2;
                    this.setStyle(activeMedia, 'transform', `translate3d(${offsetX}px, ${offsetY}px, 0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`);
                    this.setStyle(activeMedia, 'left', '0px'); this.setStyle(activeMedia, 'top', '0px');
                }
            } else {
                this.setStyle(this.elements.viewer, 'display', 'block'); this.setStyle(this.elements.viewer, 'position', 'fixed');
                this.setStyle(this.elements.viewer, 'background-color', 'rgba(20, 20, 20, 0.9)'); this.setStyle(this.elements.viewer, 'background-image', 'none');
                this.setStyle(activeMedia, 'position', 'absolute'); this.setStyle(activeMedia, 'right', 'auto'); this.setStyle(activeMedia, 'bottom', 'auto'); this.setStyle(activeMedia, 'margin', '0px');

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
                    this.setStyle(activeMedia, 'transform', `translate3d(${mX}px, ${mY}px, 0) scaleX(${this.cfg.state.mirror}) rotate(${this.cfg.state.rotate}deg)`);
                    this.setStyle(activeMedia, 'left', '0px'); this.setStyle(activeMedia, 'top', '0px');
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

        handleImmersiveActivity(currentMedia, currentSrc, keys) {
            if (!this.cfg.state.isImmersive || this.elements.viewer.style.display !== 'block') return;
            
            const adapter = getImmersiveAdapter();
            let likeText = "喜欢"; let likeIcon = "🤍"; let likeColor = "#dddddd";
            let followText = "关注"; let followIcon = "👤"; let followColor = "#dddddd";
            let authorDisplay = "";

            if (currentMedia && adapter && adapter.getStates) {
                const container = adapter.getContainer ? adapter.getContainer(currentMedia) : document.body;
                const states = adapter.getStates(container);
                
                if (window.__mix01LikeMediaCache[currentSrc] !== undefined) states.isLiked = window.__mix01LikeMediaCache[currentSrc];
                if (states.authorName && window.__mix01FollowAuthorCache[states.authorName] !== undefined) states.isFollowed = window.__mix01FollowAuthorCache[states.authorName];
                
                if (states.isLiked !== null) {
                    likeText = states.isLiked ? "已喜欢" : "未喜欢"; likeIcon = states.isLiked ? "❤️" : "🤍"; likeColor = states.isLiked ? "#f91880" : "#aaaaaa";
                }
                if (states.isFollowed !== null) {
                    followText = states.isFollowed ? "已关注" : "未关注"; followIcon = states.isFollowed ? "🫂" : "👤"; followColor = states.isFollowed ? "#00ba7c" : "#ff4b4b"; 
                }
                if (states.authorName) authorDisplay = `<span class="author-tag">${states.authorName}</span>`;
            }

            const hintKbdLike = (keys.like || 'l').toUpperCase();
            const hintKbdFollow = (keys.follow || 'f').toUpperCase();
            const hasActions = !!adapter;
            const actionsHtml = hasActions 
                ? `&nbsp;|&nbsp; <span class="hud-status-item" style="color: ${likeColor}">${likeIcon}${likeText}</span>(<kbd class="kbd-btn">${hintKbdLike}</kbd>) &nbsp; <span class="hud-status-item" style="color: ${followColor}">${followIcon}${authorDisplay}${followText}</span>(<kbd class="kbd-btn">${hintKbdFollow}</kbd>) &nbsp;|&nbsp; 🌟双连(<kbd class="kbd-btn">${(keys.double || 's').toUpperCase()}</kbd>) &nbsp; 🚀三连(<kbd class="kbd-btn">${(keys.triple || 'q').toUpperCase()}</kbd>) ` 
                : '';

            const playLabel = window.__mix01UserPaused ? "▶️播放" : "⏸️暂停";
            const playHtml = `&nbsp;|&nbsp; ${playLabel}(<kbd class="kbd-btn">Space</kbd>) &nbsp; 💾提取(<kbd class="kbd-btn">${(keys.downloadVideo || 'd').toUpperCase()}</kbd>)`;

            this.elements.hint.innerHTML = `⌨️左右切换 ${actionsHtml} ${playHtml} &nbsp;|&nbsp; ❌双击退出`;
            
            this.setStyle(this.elements.viewer, 'cursor', 'default');
            this.setStyle(this.elements.img, 'cursor', 'default');
            this.setStyle(this.elements.hint, 'display', 'block');
            void this.elements.hint.offsetWidth; 
            this.setStyle(this.elements.hint, 'opacity', '1');

            clearTimeout(this.hudState.cursorTimer);
            clearTimeout(this.hudState.hintTimer);

            this.hudState.cursorTimer = setTimeout(() => {
                this.setStyle(this.elements.viewer, 'cursor', 'none');
                this.setStyle(this.elements.img, 'cursor', 'none');
                this.setStyle(this.elements.canvas, 'cursor', 'none');
            }, 1500);

            this.hudState.hintTimer = setTimeout(() => {
                this.setStyle(this.elements.hint, 'opacity', '0');
            }, 3500); 
        }
    }

    // ==========================================
    // 3. InputController: 事件代理与业务逻辑中枢
    // ==========================================
    class InputController {
        constructor(configManager, renderer) {
            this.cfg = configManager;
            this.render = renderer;
            this.state = {
                currentMedia: null, currentSrc: null, currentHdUrl: null, cachedRect: null,
                activeZoom: 2.0, isSmallOptimized: false, customLensWidth: null, customLensHeight: null,
                isZoomManuallyChanged: false, keyboardSwitchTime: 0, isTicking: false,
                bgClickCount: 0, bgClickTimer: null, lastTarget: null, lastFoundMedia: null
            };
            this.preloadedUrls = new Set();
            this.preloadedUrlsQueue = [];

            this.mediaObserver = new MutationObserver((mutations) => {
                let newSrc = null;
                for (let m of mutations) {
                    if (m.type === 'attributes' && m.attributeName === 'src') {
                        if (this.state.currentMedia && this.state.currentMedia.src !== this.state.currentSrc) {
                            newSrc = this.state.currentMedia.src;
                        }
                    }
                }
                if (newSrc) {
                    this.state.currentSrc = newSrc;
                    if (this.render.elements.img.src !== this.state.currentHdUrl) {
                        this.render.elements.img.src = newSrc;
                        this.updateRender();
                    }
                    this.upgradeToHDQuietly(this.state.currentMedia, newSrc);
                }
            });

            this.bindEvents();
        }

        bindEvents() {
            document.addEventListener('mousemove', (e) => {
                window.lastMouseX = e.clientX; window.lastMouseY = e.clientY;
                if (!this.state.isTicking) {
                    window.requestAnimationFrame(() => {
                        this.handleMouseMove(e);
                        this.state.isTicking = false;
                    });
                    this.state.isTicking = true;
                }
            }, { capture: true, passive: true });

            document.addEventListener('mouseover', (e) => this.handleMouseOver(e), { capture: true, passive: true });
            document.addEventListener('mouseout', (e) => this.handleMouseOut(e), { capture: true, passive: true });
            document.addEventListener('mouseleave', () => this.handleMouseLeave(), { capture: true, passive: true });
            document.addEventListener('keydown', (e) => this.handleKeyDown(e), true);
            
            this.render.elements.viewer.addEventListener('click', (e) => this.handleBackgroundClick(e));
            this.render.elements.viewer.addEventListener('dblclick', (e) => {
                if (this.cfg.state.isImmersive && e.target === this.render.elements.viewer) {
                    clearTimeout(this.state.bgClickTimer);
                    this.state.bgClickCount = 0;
                    this.exitImmersive();
                }
            });
            
            this.render.elements.progressContainer.addEventListener('click', (e) => {
                if (this.cfg.state.isImmersive && this.state.currentMedia && this.state.currentMedia.tagName === 'VIDEO') {
                    const rect = this.render.elements.progressContainer.getBoundingClientRect();
                    const pos = (e.clientX - rect.left) / rect.width;
                    if (this.state.currentMedia.duration) {
                        this.state.currentMedia.currentTime = pos * this.state.currentMedia.duration;
                        this.render.elements.progressBar.style.setProperty('width', `${pos * 100}%`, 'important');
                    }
                    e.stopPropagation(); 
                }
            });
        }

        getMediaUnderCursor(clientX, clientY, target) {
            if (target && (target.tagName === 'IMG' || target.tagName === 'VIDEO') && (target.src || target.tagName === 'VIDEO')) {
                this.state.lastTarget = target; this.state.lastFoundMedia = target; return target;
            }
            if (target && target === this.state.lastTarget && this.state.lastFoundMedia) return this.state.lastFoundMedia;

            const elements = document.elementsFromPoint(clientX, clientY);
            if (!elements) return null;
            
            let found = null;
            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                if (el.id.includes('xyz') || el.id.includes('mix01')) continue;
                if ((el.tagName === 'IMG' || el.tagName === 'VIDEO') && (el.src || el.tagName === 'VIDEO')) {
                    found = el; break;
                }
            }
            this.state.lastTarget = target; this.state.lastFoundMedia = found;
            return found;
        }

        handleMouseMove(e) {
            if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') {
                this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                this.updateRender(e);
                return;
            }

            const media = this.getMediaUnderCursor(e.clientX, e.clientY, e.target);
            if (media && (media !== this.state.currentMedia || (media.src||'video') !== this.state.currentSrc)) {
                if (Date.now() - this.state.keyboardSwitchTime < 500) return;
                this.triggerZoom(media); return;
            }

            if (this.state.currentMedia && this.render.elements.viewer.style.display === 'block' && this.state.cachedRect) {
                if (media === this.state.currentMedia) this.state.cachedRect = this.state.currentMedia.getBoundingClientRect();
                else if (Date.now() - this.state.keyboardSwitchTime > 500) {
                    if (e.clientX < this.state.cachedRect.left || e.clientX > this.state.cachedRect.right || 
                        e.clientY < this.state.cachedRect.top || e.clientY > this.state.cachedRect.bottom) {
                        this.hideViewer(); return;
                    }
                }
                this.updateRender(e);
            }
        }

        handleMouseOver(e) {
            if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') return;
            const media = this.getMediaUnderCursor(e.clientX, e.clientY, e.target);
            if (media) this.triggerZoom(media);
        }

        handleMouseOut(e) {
            if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') return; 
            if (e.target === this.state.currentMedia) {
                if (e.relatedTarget && this.state.currentMedia.contains(e.relatedTarget)) return;
                if (Date.now() - this.state.keyboardSwitchTime > 500) this.hideViewer(); 
            }
        }

        handleMouseLeave() {
            if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') return;
            if (Date.now() - this.state.keyboardSwitchTime > 500) this.hideViewer();
        }

        async upgradeToHDQuietly(target, src) {
            if (this.cfg.state.loadHD !== 'true') return;
            const myTask = src;
            try {
                if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                    const hdUrl = await window.Mix01RuleEngine.getHighResUrl(target, src);
                    if (hdUrl && hdUrl !== src && !this.render.hdState.badUrls.has(hdUrl)) {
                        
                        if (this.state.currentHdUrl === hdUrl) return; 
                        this.state.currentHdUrl = hdUrl;

                        if (!this.render.elements.img.src || this.render.elements.img.src === '') {
                            this.render.setStyle(this.render.elements.spinner, 'display', 'block');
                        } else {
                            this.render.hdState.isLoading = true;
                            this.updateRender(); 
                        }

                        const tempImg = new Image();
                        tempImg.onload = () => { 
                            if (this.state.currentHdUrl === hdUrl && this.state.currentMedia === target) {
                                this.render.setStyle(this.render.elements.spinner, 'display', 'none');
                                this.render.hdState.isLoading = false; 

                                if (!this.cfg.state.isImmersive && this.cfg.state.mode === 'partial' && this.state.isSmallOptimized && !this.state.isZoomManuallyChanged) {
                                    const nw = tempImg.naturalWidth, nh = tempImg.naturalHeight;
                                    if (nw > 350 || nh > 350) {
                                        this.state.customLensWidth = Math.min(nw, window.innerWidth * 0.9);
                                        this.state.customLensHeight = Math.min(nh, window.innerHeight * 0.9);
                                        this.state.activeZoom = nw / (this.state.cachedRect.width || 1);
                                    }
                                }
                                this.render.elements.img.src = hdUrl; 
                                this.updateRender(); 
                            }
                        };
                        tempImg.onerror = () => {
                            if (this.state.currentHdUrl === hdUrl) {
                                this.render.setStyle(this.render.elements.spinner, 'display', 'none');
                                this.render.hdState.isLoading = false;
                                this.updateRender(); 
                            }
                            this.render.hdState.badUrls.add(hdUrl); 
                        };
                        tempImg.src = hdUrl;
                    }
                }
            } catch (error) { console.warn('Mix01 Engine 解析失败:', error); }
        }

        async triggerZoom(target) {
            if (target === this.state.currentMedia && (target.src || 'video') === this.state.currentSrc) return;
            if (target.tagName === 'VIDEO' && this.cfg.state.disableVideoDefaultView && !this.cfg.state.isImmersive) return;

            this.hideViewer();
            window.lastHoveredMedia = target;
            window.lastHoveredSrc = target.src || 'video';
            this.state.currentMedia = target;
            this.state.currentSrc = target.src || 'video';
            this.state.cachedRect = target.getBoundingClientRect();
            
            this.mediaObserver.disconnect();
            if (target.tagName === 'IMG') {
                this.mediaObserver.observe(target, { attributes: true, attributeFilter: ['src'] });
            }
            
            this.state.isSmallOptimized = false;
            this.state.customLensWidth = null; this.state.customLensHeight = null;
            this.state.isZoomManuallyChanged = false;
            window.__mix01UserPaused = false;

            if (!this.cfg.state.hasAgreed) {
                this.render.setStyle(this.render.elements.img, 'display', 'none');
                this.render.setStyle(this.render.elements.status, 'display', 'none');
                this.render.setStyle(this.render.elements.notice, 'display', 'block');
                this.render.setStyle(this.render.elements.viewer, 'display', 'block');
                if (this.cfg.state.isImmersive) {
                    this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                }
                this.triggerPreload();
                return;
            }

            this.render.setStyle(this.render.elements.notice, 'display', 'none');

            if (target.tagName === 'VIDEO') {
                this.render.setStyle(this.render.elements.img, 'display', 'none');
                this.render.startVideoRender(target);
                this.updateRender();
                this.render.setStyle(this.render.elements.viewer, 'display', 'block');
                if (this.cfg.state.isImmersive) {
                    this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                }
                this.triggerPreload();
                return;
            }

            this.render.setStyle(this.render.elements.canvas, 'display', 'none');
            this.render.setStyle(this.render.elements.progressContainer, 'display', 'none');
            this.render.setStyle(this.render.elements.img, 'display', 'block');
            this.render.elements.img.src = target.src;
            this.render.setStyle(this.render.elements.img, 'max-width', 'none'); 
            this.render.setStyle(this.render.elements.img, 'max-height', 'none');

            if (this.cfg.state.smallImageOptimization) {
                if (this.state.cachedRect.width <= 50 && this.state.cachedRect.height <= 50) { this.state.activeZoom = 9.0; this.state.isSmallOptimized = true; }
                else if (this.state.cachedRect.width <= 100 && this.state.cachedRect.height <= 100) { this.state.activeZoom = 6.0; this.state.isSmallOptimized = true; }
                else { this.state.activeZoom = this.cfg.state.zoom; }
            } else {
                this.state.activeZoom = this.cfg.state.zoom;
            }

            this.updateRender();

            this.upgradeToHDQuietly(target, target.src);

            this.render.setStyle(this.render.elements.viewer, 'display', 'block');
            if (this.cfg.state.isImmersive) {
                this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
            }
            
            this.triggerPreload();
        }

        updateRender(e = null) {
            if (!this.state.currentMedia || !this.state.cachedRect) return;
            const rect = this.state.cachedRect;
            const x = e ? e.clientX : window.lastMouseX;
            const y = e ? e.clientY : window.lastMouseY;
            const xP = (x - rect.left) / (rect.width || 1);
            const yP = (y - rect.top) / (rect.height || 1);
            
            const isVideo = this.state.currentMedia.tagName === 'VIDEO';
            const activeMedia = isVideo ? this.render.elements.canvas : this.render.elements.img;
            
            this.state.activeZoom = this.render.updateLayout(
                activeMedia, rect, this.state.activeZoom, xP, yP, 
                this.state.isSmallOptimized, this.state.customLensWidth, this.state.customLensHeight, 
                this.state.isZoomManuallyChanged, this.state.currentSrc
            );
        }

        hideViewer() {
            this.render.hide();
            this.mediaObserver.disconnect();
            this.state.currentMedia = null;
            this.state.currentSrc = null;
            this.state.currentHdUrl = null; 
            this.state.cachedRect = null;
            this.state.isSmallOptimized = false;
            this.state.customLensWidth = null;
            this.state.customLensHeight = null;
            this.state.isZoomManuallyChanged = false;
            window.isFetchingMore = false;
        }

        exitImmersive() {
            this.cfg.state.isImmersive = false;
            this.cfg.save({ isImmersive: false });
            this.render.showToast('❎ 已退出沉浸图库模式');
            this.hideViewer();
        }

        handleBackgroundClick(e) {
            if (e.target !== this.render.elements.viewer) return;
            if (this.cfg.state.isImmersive) {
                this.state.bgClickCount++;
                if (this.state.bgClickCount === 1) {
                    this.render.showToast("⚠️ 请再点一次或双击退出");
                    this.state.bgClickTimer = setTimeout(() => { this.state.bgClickCount = 0; }, 1000); 
                } else {
                    clearTimeout(this.state.bgClickTimer);
                    this.state.bgClickCount = 0;
                    this.exitImmersive();
                }
            } else {
                this.hideViewer();
            }
        }

        matchCombo(e, comboStr) {
            if (!comboStr) return false;
            const parts = comboStr.toLowerCase().split('+').map(s => s.trim());
            const key = parts.pop();
            const ctrl = parts.includes('ctrl');
            const shift = parts.includes('shift');
            const alt = parts.includes('alt');
            if (e.ctrlKey !== ctrl) return false;
            if (e.shiftKey !== shift) return false;
            if (e.altKey !== alt) return false;
            return e.key.toLowerCase() === key || e.code.toLowerCase() === key;
        }

        getGalleryImages() {
            const adapter = getImmersiveAdapter();
            if (adapter && adapter.getGalleryImages) return adapter.getGalleryImages();
            return Array.from(document.querySelectorAll('img, video')).filter(media => {
                if (media.id === 'zoom-img-xyz' || media.id === 'zoom-canvas-xyz') return false;
                const rect = media.getBoundingClientRect();
                return rect.width > 50 && rect.height > 50 && window.getComputedStyle(media).display !== 'none';
            });
        }

        performSwitch(nextImg, msgText) {
            if (msgText) this.render.showToast(msgText);
            this.state.keyboardSwitchTime = Date.now();
            nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
            this.triggerZoom(nextImg);

            setTimeout(() => {
                if (this.state.currentMedia === nextImg) {
                    const newRect = nextImg.getBoundingClientRect();
                    window.lastMouseX = newRect.left + newRect.width / 2;
                    window.lastMouseY = newRect.top + newRect.height / 2;
                    this.updateRender();
                    this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                }
            }, 50); 
        }

        async executePhantomAction(actionType) {
            if (!this.state.currentMedia) return;
            const adapter = getImmersiveAdapter();
            
            if (!adapter || (!adapter.like && !adapter.follow)) {
                this.render.showToast("⚠️ 该网站暂不支持快捷交互"); return;
            }

            const container = adapter.getContainer ? adapter.getContainer(this.state.currentMedia) : document.body;

            let currentState = { isLiked: false, isFollowed: false, authorName: null };
            if (adapter.getStates) {
                currentState = adapter.getStates(container);
                if (window.__mix01LikeMediaCache[this.state.currentSrc] !== undefined) {
                    currentState.isLiked = window.__mix01LikeMediaCache[this.state.currentSrc];
                }
                if (currentState.authorName && window.__mix01FollowAuthorCache[currentState.authorName] !== undefined) {
                    currentState.isFollowed = window.__mix01FollowAuthorCache[currentState.authorName];
                }
            }

            const isCombo = (actionType === 'double' || actionType === 'triple');
            const doLike = (actionType === 'like' || isCombo);
            const doFollow = (actionType === 'follow' || isCombo);
            const doDownload = (actionType === 'triple');

            if (doLike && adapter.like) {
                if (!(isCombo && currentState.isLiked)) {
                    const newState = await adapter.like(container, this.state.currentMedia);
                    if (newState !== null) window.__mix01LikeMediaCache[this.state.currentSrc] = newState;
                }
            }
            if (doFollow && adapter.follow) {
                if (!(isCombo && currentState.isFollowed)) {
                    const newState = await adapter.follow(container, this.state.currentMedia);
                    if (newState !== null) {
                        const tempStates = adapter.getStates ? adapter.getStates(container) : null;
                        if (tempStates && tempStates.authorName) window.__mix01FollowAuthorCache[tempStates.authorName] = newState;
                    }
                }
            }

            if (actionType === 'double') this.render.showToast("💖 一键双连生效！(喜欢+关注)");
            else if (actionType === 'triple') this.render.showToast("🚀 一键三连生效！(喜欢+关注+提取)");
            else if (actionType === 'like') this.render.showToast(window.__mix01LikeMediaCache[this.state.currentSrc] ? "❤️ 已喜欢" : "🤍 已取消喜欢");
            else if (actionType === 'follow') this.render.showToast("👤 关注状态已更新");

            this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);

            if (doDownload) this.triggerGlobalDownload();
        }

        triggerGlobalDownload() {
            const adapter = getImmersiveAdapter();
            if (this.state.currentMedia.tagName === 'VIDEO') {
                if (adapter && adapter.downloadVideo) {
                    this.render.showToast("⏳ 正在打通后台提取原版最高清文件...");
                    adapter.downloadVideo(adapter.getContainer(this.state.currentMedia), this.state.currentMedia).then(videoUrl => {
                        if (videoUrl === 'NATIVE_CLICKED') this.render.showToast("✅ 已调用浏览器插件原生下载机制！");
                        else if (videoUrl) {
                            this.render.showToast("✅ 提取成功，开始强制下载！");
                            chrome.runtime.sendMessage({ action: "downloadImmersiveImg", url: videoUrl, dataUrl: videoUrl });
                        } else this.render.showToast("❌ 无法解析该媒体的直链");
                    });
                } else {
                    this.render.showToast("⚠️ 当前站点暂未适配一键视频提取");
                }
            } else {
                if (this.render.elements.img.src) downloadImage(this.render.elements.img.src, this.render);
            }
        }

        // 【终极并发预加载引擎】：恢复带宽保护，仅沉浸模式下利用并发火力狂拉缓存
        triggerPreload() {
            if (!this.cfg.state.isImmersive || this.cfg.state.preloadCount <= 0 || !this.state.currentMedia) return;

            const galleryImages = this.getGalleryImages();
            let currentIndex = galleryImages.indexOf(this.state.currentMedia);
            
            if (currentIndex === -1 && this.state.currentSrc) {
                currentIndex = galleryImages.findIndex(media => (media.src||'video') === this.state.currentSrc);
            }
            if (currentIndex === -1) return;

            for (let i = 1; i <= this.cfg.state.preloadCount; i++) {
                const targetIndex = currentIndex + i;
                if (targetIndex >= galleryImages.length) break;

                const media = galleryImages[targetIndex];
                if (media.tagName === 'IMG') {
                    const src = media.src;
                    
                    // 利用闭包打破 await 阻塞，瞬间同时发出数张图的规则解析与后台拉取
                    (async () => {
                        let targetUrl = src;
                        if (this.cfg.state.loadHD === 'true' && window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                            try { targetUrl = await window.Mix01RuleEngine.getHighResUrl(media, src); } catch (e) {}
                        }

                        if (targetUrl && !this.preloadedUrls.has(targetUrl) && !this.render.hdState.badUrls.has(targetUrl)) {
                            this.preloadedUrls.add(targetUrl);
                            this.preloadedUrlsQueue.push(targetUrl);

                            if (this.preloadedUrlsQueue.length > 200) {
                                const oldest = this.preloadedUrlsQueue.shift();
                                this.preloadedUrls.delete(oldest);
                            }
                            
                            const preloaderImg = new Image();
                            preloaderImg.src = targetUrl; // 强迫浏览器发起网络请求塞进 Memory Cache
                        }
                    })();
                }
            }
        }

        handleKeyDown(e) {
            if (!this.cfg.state.hasAgreed) return;
            const k = e.key.toLowerCase(); let up = false;
            const modeList = ['partial', 'full-follow', 'full-center'];
            const modeNames = { 'partial': '🔍 局部放大', 'full-follow': '🖼️ 整体跟随', 'full-center': '📐 智能避让' };
            
            if (this.matchCombo(e, this.cfg.keys.immersive)) {
                e.preventDefault();
                if (this.cfg.state.isImmersive) {
                    this.exitImmersive();
                } else {
                    this.cfg.state.isImmersive = true;
                    this.cfg.save({ isImmersive: true });
                    this.render.showToast('🌌 开启沉浸音视频图库');

                    if (!this.state.currentMedia || this.render.elements.viewer.style.display !== 'block') {
                        const galleryImages = this.getGalleryImages();
                        if (galleryImages.length > 0) {
                            const nextImg = galleryImages[0];
                            nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            this.triggerZoom(nextImg);
                        } else {
                            this.render.showToast("⚠️ 当前页面未发现可用媒体");
                            this.cfg.state.isImmersive = false;
                            this.cfg.save({ isImmersive: false });
                        }
                    } else {
                        this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                    }
                }
                return;
            }

            if (this.render.elements.viewer.style.display !== 'block') return;

            if (this.matchCombo(e, this.cfg.keys.playVideo || 'space') || e.code.toLowerCase() === 'space') {
                if (this.cfg.state.isImmersive && this.state.currentMedia && this.state.currentMedia.tagName === 'VIDEO') {
                    if (window.__mix01UserPaused) {
                        window.__mix01UserPaused = false;
                        let playPromise = this.state.currentMedia.play();
                        if (playPromise !== undefined) playPromise.then(() => { this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys); }).catch(()=>{});
                    } else {
                        window.__mix01UserPaused = true;
                        this.state.currentMedia.pause();
                        this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                    }
                    e.preventDefault(); return;
                }
            }

            if (this.matchCombo(e, this.cfg.keys.downloadVideo || 'd')) {
                if (this.cfg.state.isImmersive && this.state.currentMedia) {
                    this.triggerGlobalDownload();
                    e.preventDefault(); return;
                }
            }

            if (this.matchCombo(e, this.cfg.keys.double || 's')) {
                if (this.cfg.state.isImmersive) { this.executePhantomAction('double'); e.preventDefault(); return; }
            }
            if (this.matchCombo(e, this.cfg.keys.triple || 'q')) {
                if (this.cfg.state.isImmersive) { this.executePhantomAction('triple'); e.preventDefault(); return; }
            }
            if (this.matchCombo(e, this.cfg.keys.like)) {
                if (this.cfg.state.isImmersive) { this.executePhantomAction('like'); e.preventDefault(); return; }
            }
            if (this.matchCombo(e, this.cfg.keys.follow)) {
                if (this.cfg.state.isImmersive) { this.executePhantomAction('follow'); e.preventDefault(); return; }
            }

            if (k === this.cfg.keys.rotate) { this.cfg.state.rotate = (this.cfg.state.rotate + 90) % 360; up = true; } 
            else if (k === this.cfg.keys.mirror) { this.cfg.state.mirror *= -1; up = true; } 
            else if (k === this.cfg.keys.mode) { 
                if (this.cfg.state.isImmersive) {
                    this.render.showToast(`⚠️ 请双击背景或按 ${this.cfg.keys.immersive.toUpperCase()} 退出沉浸模式`);
                } else {
                    this.cfg.state.mode = modeList[(modeList.indexOf(this.cfg.state.mode) + 1) % modeList.length]; 
                    this.cfg.siteModes[window.location.hostname] = this.cfg.state.mode;
                    this.cfg.save({ siteModes: this.cfg.siteModes }); 
                    up = true; 
                    this.render.showToast(modeNames[this.cfg.state.mode]); 
                }
            }
            else if (k === this.cfg.keys.zoomIn || k === '+') { this.state.activeZoom += 0.5; this.state.isZoomManuallyChanged = true; this.render.showToast(`${this.state.activeZoom.toFixed(1)}x`); up = true; } 
            else if (k === this.cfg.keys.zoomOut || k === '-') { this.state.activeZoom = Math.max(0.5, this.state.activeZoom - 0.5); this.state.isZoomManuallyChanged = true; this.render.showToast(`${this.state.activeZoom.toFixed(1)}x`); up = true; }
            
            else if (this.matchCombo(e, 'escape')) {
                if (this.cfg.state.isImmersive) {
                    this.exitImmersive();
                    e.preventDefault(); return;
                }
            }
            else if (k === 'arrowleft' || k === 'a' || k === 'arrowright' || k === 'd') {
                if (!this.cfg.state.isImmersive || window.isFetchingMore) return;

                const galleryImages = this.getGalleryImages();
                if (galleryImages.length === 0) return;

                let currentIndex = galleryImages.indexOf(this.state.currentMedia);
                if (currentIndex === -1 && this.state.currentSrc) {
                    currentIndex = galleryImages.findIndex(media => (media.src||'video') === this.state.currentSrc);
                }
                if (currentIndex === -1) currentIndex = 0;

                const isNext = (k === 'arrowright' || k === 'd');

                if (isNext) {
                    if (currentIndex < galleryImages.length - 1) {
                        this.performSwitch(galleryImages[currentIndex + 1], "下一项 ➡️");
                    } else {
                        window.isFetchingMore = true;
                        this.render.showToast("⏳ 正在加载更多动态...");
                        window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
                        
                        setTimeout(() => {
                            const newGallery = this.getGalleryImages();
                            let newIdx = newGallery.indexOf(this.state.currentMedia);
                            if (newIdx === -1) newIdx = newGallery.findIndex(media => (media.src||'video') === this.state.currentSrc);
                            
                            if (newIdx !== -1 && newIdx < newGallery.length - 1) {
                                this.performSwitch(newGallery[newIdx + 1], "下一项 ➡️");
                            } else {
                                this.render.showToast("🚧 到底啦！没有更多内容了");
                            }
                            window.isFetchingMore = false;
                        }, 800);
                    }
                } else {
                    if (currentIndex > 0) {
                        this.performSwitch(galleryImages[currentIndex - 1], "⬅️ 上一项");
                    } else {
                        window.isFetchingMore = true;
                        this.render.showToast("⏳ 正在向上翻阅...");
                        window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
                        
                        setTimeout(() => {
                            const newGallery = this.getGalleryImages();
                            let newIdx = newGallery.indexOf(this.state.currentMedia);
                            if (newIdx === -1) newIdx = newGallery.findIndex(media => (media.src||'video') === this.state.currentSrc);
                            
                            if (newIdx !== -1 && newIdx > 0) {
                                this.performSwitch(newGallery[newIdx - 1], "⬅️ 上一项");
                            } else {
                                this.render.showToast("🚧 到顶啦！");
                            }
                            window.isFetchingMore = false;
                        }, 800);
                    }
                }
                e.preventDefault(); 
                return; 
            }
            
            if (up) { 
                e.preventDefault(); 
                this.updateRender(); 
            }
        }
    }

    // 初始化解耦引擎
    const configManager = new ConfigManager();
    const mediaRenderer = new MediaRenderer(configManager);
    const inputController = new InputController(configManager, mediaRenderer);

    // 暴露核心 API 供通信
    window.__mix01Engine = { config: configManager, render: mediaRenderer, controller: inputController };
})();