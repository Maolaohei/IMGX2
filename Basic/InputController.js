// Basic/InputController.js
window.Mix01InputController = class InputController {
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
        const adapter = window.Mix01Utils.getImmersiveAdapter();
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
        const adapter = window.Mix01Utils.getImmersiveAdapter();
        
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
        const adapter = window.Mix01Utils.getImmersiveAdapter();
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
            if (this.render.elements.img.src) window.Mix01Utils.downloadImage(this.render.elements.img.src, this.render);
        }
    }

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
                        preloaderImg.src = targetUrl;
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
};