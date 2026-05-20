// Basic/InputController.js
class Mix01ImagePool {
    constructor() { this.pool = []; }
    acquire() { return this.pool.pop() || new Image(); }
    release(img) {
        img.onload = null; img.onerror = null; img.src = '';
        if (this.pool.length < 30) this.pool.push(img);
    }
}

window.Mix01InputController = class InputController {
    constructor(configManager, renderer) {
        this.cfg = configManager;
        this.render = renderer;
        
        this.imgPool = new Mix01ImagePool();
        this.activePreloads = new Set();
        
        this.state = {
            _currentMediaRef: null,
            get currentMedia() { return this._currentMediaRef?.deref() || null; },
            set currentMedia(el) { this._currentMediaRef = el ? new WeakRef(el) : null; },
            
            _lastFoundMediaRef: null,
            get lastFoundMedia() { return this._lastFoundMediaRef?.deref() || null; },
            set lastFoundMedia(el) { this._lastFoundMediaRef = el ? new WeakRef(el) : null; },
            
            _lastTargetRef: null,
            get lastTarget() { return this._lastTargetRef?.deref() || null; },
            set lastTarget(el) { this._lastTargetRef = el ? new WeakRef(el) : null; },

            currentSrc: null, currentHdUrl: null, cachedRect: null,
            isSmallOptimized: false, customLensWidth: null, customLensHeight: null,
            isZoomManuallyChanged: false, keyboardSwitchTime: 0, isTicking: false,
            bgClickCount: 0, bgClickTimer: null,
            isRenderingLock: false,
            lastRenderSignature: null,
            _galleryCache: null, _galleryCacheDirty: true,
            currentMode: 'partial', currentRotate: 0, currentMirror: 1,
            
            // 🚀 优化 1：防异步慢速图片覆盖的会话 Token 锁
            renderRequestId: 0
        };

        this.physics = {
            targetZoom: 2.0, currentZoom: 2.0,
            targetPanX: 0, currentPanX: 0,
            targetPanY: 0, currentPanY: 0,
            active: false
        };
        
        this.preloadedUrls = new Set();
        this.preloadedUrlsQueue = [];
        this.compiledKeys = {}; 
        this._preloadTimer = null;   
        this._resizeTimer = null;    
        this._hoverDelayTimer = null; 
        this._cursorHideTimer = null; 
        this._lastDetectTime = 0;
        this._lastRectTime = 0;
        this._physicsFrameId = null; // 精确切断弹性大循环
        this._drag = { active: false, startX: 0, startY: 0, origLeft: 0, origTop: 0 };
        this._pan = { active: false, moved: false, startX: 0, startY: 0, origPanX: 0, origPanY: 0 };

        // 🚀 优化 2：高精度鼠标物理矢量运动状态机（速度、坐标分量差分）
        this._mouseVector = { lastX: 0, lastY: 0, dx: 0, dy: 0, speed: 0, timestamp: 0 };

        // 🚀 优化 3：IntersectionObserver 空间树 + 全局 MutationObserver 被动扫描，彻底斩断 1.5 秒的轮询开销
        this.visibleMediaElements = new Set();
        this.mediaIO = new IntersectionObserver((entries) => {
            for (let e of entries) {
                if (e.isIntersecting) this.visibleMediaElements.add(e.target);
                else this.visibleMediaElements.delete(e.target);
            }
        }, { rootMargin: '300px' });
        
        this.initPassiveDOMScanner();

        this.mediaObserver = new MutationObserver((mutations) => {
            let newSrc = null;
            for (let m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'src' && m.target === this.state.currentMedia) {
                    if (this.state.currentMedia && this.state.currentMedia.src !== this.state.currentSrc) {
                        newSrc = this.state.currentMedia.src; break; 
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

    initPassiveDOMScanner() {
        const scanAndObserve = (root) => {
            const els = root.querySelectorAll ? root.querySelectorAll('img, video') : [];
            els.forEach(el => {
                if (!el._mix01Observed) { el._mix01Observed = true; this.mediaIO.observe(el); }
            });
        };
        scanAndObserve(document);
        this._globalDomObserver = new MutationObserver((mutations) => {
            if (!this.cfg.isSiteEnabled()) return;
            for (let m of mutations) {
                if (m.addedNodes && m.addedNodes.length > 0) {
                    for (let node of m.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.tagName === 'IMG' || node.tagName === 'VIDEO') {
                                if (!node._mix01Observed) { node._mix01Observed = true; this.mediaIO.observe(node); }
                            }
                            scanAndObserve(node);
                        }
                    }
                }
            }
        });
        this._globalDomObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    _toggleVideoPlay() {
        if (!this.state.currentMedia || this.state.currentMedia.tagName !== 'VIDEO') return;
        const v = this.state.currentMedia;
        if (window.__mix01UserPaused || v.ended) {
            window.__mix01UserPaused = false;
            if (v.ended) v.currentTime = 0; 
            v.play().catch(() => {});
        } else {
            window.__mix01UserPaused = true;
            v.pause();
        }
        this.render.handleImmersiveActivity(v, this.state.currentSrc, this.cfg.keys);
    }

    _startPhysicsLoop() {
        if (this.physics.active) return;
        this.physics.active = true;

        const loop = () => {
            if (!this.state.currentMedia || this.render.elements.viewer.style.display !== 'block' || this._drag.active) {
                this.physics.active = false;
                this._physicsFrameId = null;
                return;
            }

            const lerp = (s, e, f) => s + (e - s) * f;
            let zDiff = this.physics.targetZoom - this.physics.currentZoom;
            let xDiff = this.physics.targetPanX - this.physics.currentPanX;
            let yDiff = this.physics.targetPanY - this.physics.currentPanY;

            if (Math.abs(zDiff) < 0.001 && Math.abs(xDiff) < 0.5 && Math.abs(yDiff) < 0.5) {
                this.physics.currentZoom = this.physics.targetZoom;
                this.physics.currentPanX = this.physics.targetPanX;
                this.physics.currentPanY = this.physics.targetPanY;
                this.physics.active = false;
                this._physicsFrameId = null;
                this.updateRender(); 
                return;
            }

            this.physics.currentZoom = lerp(this.physics.currentZoom, this.physics.targetZoom, 0.25);
            this.physics.currentPanX = lerp(this.physics.currentPanX, this.physics.targetPanX, 0.25);
            this.physics.currentPanY = lerp(this.physics.currentPanY, this.physics.targetPanY, 0.25);

            this.updateRender();
            this._physicsFrameId = requestAnimationFrame(loop);
        };
        this._physicsFrameId = requestAnimationFrame(loop);
    }

    _killPhysicsLoop() {
        if (this._physicsFrameId) {
            cancelAnimationFrame(this._physicsFrameId);
            this._physicsFrameId = null;
        }
        this.physics.active = false;
    }

    _clampTargetPan() {
        if (!this.state.currentMedia) return;
        const nw = this.state.currentMedia.naturalWidth || 0;
        const nh = this.state.currentMedia.naturalHeight || 0;
        const isRotated = this.state.currentRotate % 180 !== 0;
        const vW = (isRotated ? nh : nw) * this.physics.targetZoom;
        const vH = (isRotated ? nw : nh) * this.physics.targetZoom;
        const sw = window.innerWidth, sh = window.innerHeight;

        if (vW <= sw) this.physics.targetPanX = 0;
        else this.physics.targetPanX = Math.max(-(vW - sw), Math.min(0, this.physics.targetPanX));

        if (vH <= sh) this.physics.targetPanY = 0;
        else this.physics.targetPanY = Math.max(-(vH - sh), Math.min(0, this.physics.targetPanY));
    }

    bindEvents() {
        document.addEventListener('mousemove', (e) => {
            window.lastMouseX = e.clientX; window.lastMouseY = e.clientY;
            
            const now = performance.now();
            const dt = now - this._mouseVector.timestamp;
            if (dt > 10) {
                this._mouseVector.dx = e.clientX - this._mouseVector.lastX;
                this._mouseVector.dy = e.clientY - this._mouseVector.lastY;
                this._mouseVector.speed = Math.sqrt(this._mouseVector.dx ** 2 + this._mouseVector.dy ** 2) / dt;
                this._mouseVector.lastX = e.clientX;
                this._mouseVector.lastY = e.clientY;
                this._mouseVector.timestamp = now;
            }

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
        
        document.addEventListener('wheel', (e) => {
            if (this.cfg.state.wheelZoomEnabled && this.render.elements.viewer.style.display === 'block') {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.25 : 0.25;
                this.physics.targetZoom = Math.max(0.2, this.physics.targetZoom + delta);
                this.state.isZoomManuallyChanged = true;
                
                this._clampTargetPan();
                this._startPhysicsLoop();

                clearTimeout(this._wheelToastTimer);
                this._wheelToastTimer = setTimeout(() => {
                    this.render.showToast(`🔍 ${this.physics.targetZoom.toFixed(1)}x`);
                }, 200);
            }
        }, { passive: false });

        document.addEventListener('scroll', () => {
            this.state._galleryCacheDirty = true;
        }, { passive: true, capture: true });

        const scheduleResizeUpdate = () => {
            if (!this.state.currentMedia) return;
            if (this._resizeTimer) clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => {
                if (this.state.currentMedia) {
                    this.state.cachedRect = this.state.currentMedia.getBoundingClientRect();
                    this.updateRender();
                }
            }, 66);
        };
        window.addEventListener('resize', scheduleResizeUpdate, { passive: true });
        window.addEventListener('orientationchange', scheduleResizeUpdate, { passive: true });
        
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

        if (this.render.elements.videoClone) {
            this.render.elements.videoClone.addEventListener('click', (e) => { e.stopPropagation(); this._toggleVideoPlay(); });
        }

        this.render.elements.img.addEventListener('dblclick', (e) => {
            if (!this.cfg.state.isImmersive) return;
            e.stopPropagation();
            this.state.currentRotate = 0;
            this.state.currentMirror = 1;
            this.state.isZoomManuallyChanged = false;
            this.physics.targetZoom = this.cfg.state.zoom;
            this.physics.targetPanX = 0;
            this.physics.targetPanY = 0;
            this._startPhysicsLoop();
            this.render.showToast('🔄 视图已重置');
        });

        this.render.elements.img.addEventListener('error', () => {
            if (this.state.currentHdUrl && this.render.elements.img.src !== this.state.currentSrc) {
                this.render.hdState.badUrls.add(this.state.currentHdUrl);
                this.state.currentHdUrl = null;
                if (this.state.currentSrc) this.render.elements.img.src = this.state.currentSrc;
                this.render.showToast('⚠️ 高清资源已失效，自动回退至原图');
                this.updateRender();
            }
        });

        this.render.elements.viewer.addEventListener('contextmenu', (e) => {
            if (!this.cfg.state.hasAgreed) return;
            e.preventDefault(); e.stopPropagation();
            this.render.showContextMenu(e.clientX, e.clientY, {
                'copy-img':     () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) window.Mix01Utils.copyImageToClipboard(u, this.render); },
                'copy-url':      () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) { navigator.clipboard.writeText(u).catch(() => {}); this.render.showToast('🔗 链接已复制'); } },
                'copy-markdown': () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) { navigator.clipboard.writeText(`![](${u})`).catch(() => {}); this.render.showToast('📋 Markdown 已复制'); } },
                'open-tab':      () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) { window.open(u, '_blank', 'noopener,noreferrer'); this.render.showToast('↗️ 已在新标签页打开'); } },
                'save':         () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) window.Mix01Utils.downloadImage(u, this.render); },
                'disable-site': () => { this._quickToggleSite(); },
                'close':        () => { this.cfg.state.isImmersive ? this.exitImmersive() : this.hideViewer(); },
            });
        });

        this.render.elements.viewer.addEventListener('mousedown', (e) => {
            if (this.cfg.state.isImmersive) return;
            if (!e.altKey) return;  
            e.preventDefault(); e.stopPropagation();
            const v = this.render.elements.viewer;
            const rect = v.getBoundingClientRect();
            this._drag.active  = true; this._drag.startX  = e.clientX; this._drag.startY  = e.clientY;
            this._drag.origLeft = rect.left; this._drag.origTop  = rect.top;
            v.style.setProperty('cursor', 'grabbing', 'important');
            this.state.keyboardSwitchTime = Date.now() + 99999;
        });

        this.render.elements.viewer.addEventListener('mousedown', (e) => {
            if (!this.cfg.state.isImmersive) return;
            if (e.target === this.render.elements.progressContainer) return;
            const nw = this.state.currentMedia?.naturalWidth || 0;
            const nh = this.state.currentMedia?.naturalHeight || 0;
            const isRotated = this.state.currentRotate % 180 !== 0;
            const vW = (isRotated ? nh : nw) * this.physics.targetZoom;
            const vH = (isRotated ? nw : nh) * this.physics.targetZoom;
            const sw = window.innerWidth, sh = window.innerHeight;
            if (vW <= sw && vH <= sh) return;
            e.preventDefault();
            this._pan.active  = true; this._pan.moved   = false;
            this._pan.startX  = e.clientX; this._pan.startY  = e.clientY;
            this._pan.origPanX = this.physics.targetPanX;
            this._pan.origPanY = this.physics.targetPanY;
        });

        document.addEventListener('mousemove', (e) => {
            if (this._pan.active) {
                const dx = e.clientX - this._pan.startX;
                const dy = e.clientY - this._pan.startY;
                if (!this._pan.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) this._pan.moved = true;
                if (this._pan.moved) {
                    this.physics.targetPanX = this._pan.origPanX + dx;
                    this.physics.targetPanY = this._pan.origPanY + dy;
                    this.physics.currentPanX = this.physics.targetPanX;
                    this.physics.currentPanY = this.physics.targetPanY;
                    this.updateRender(e);
                }
                return;
            }
            if (!this._drag.active) return;
            const dx = e.clientX - this._drag.startX;
            const dy = e.clientY - this._drag.startY;
            const v = this.render.elements.viewer;
            const newLeft = this._drag.origLeft + dx;
            const newTop  = this._drag.origTop  + dy;
            v.style.setProperty('transform', `translate3d(${newLeft}px,${newTop}px,0)`, 'important');
            v.style.setProperty('left', '0px', 'important');
            v.style.setProperty('top',  '0px', 'important');
        }, { capture: true, passive: true });

        document.addEventListener('mouseup', () => {
            if (this._pan.active) {
                this._pan.active = false;
                if (this.state.currentMedia && this.cfg.state.isImmersive) {
                    this._clampTargetPan();
                    this._startPhysicsLoop();
                }
            }
            if (!this._drag.active) return;
            this._drag.active = false;
            this.render.elements.viewer.style.setProperty('cursor', 'default', 'important');
            this.state.keyboardSwitchTime = 0;
        }, { capture: true });
    }

    getMediaUnderCursor(clientX, clientY, target) {
        if (target && (target.tagName === 'IMG' || target.tagName === 'VIDEO') && (target.src || target.tagName === 'VIDEO')) {
            this.state.lastTarget = target; this.state.lastFoundMedia = target; return target;
        }
        if (target && target === this.state.lastTarget && this.state.lastFoundMedia) return this.state.lastFoundMedia;

        let found = null;
        let minArea = Infinity;

        for (let el of this.visibleMediaElements) {
            if (el.id.includes('xyz') || el.id.includes('mix01')) continue;
            if (!el.src && el.tagName !== 'VIDEO') continue;

            const rect = el.getBoundingClientRect(); 
            if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
                const area = rect.width * rect.height;
                if (area < minArea) {
                    minArea = area;
                    found = el;
                }
            }
        }
        
        this.state.lastTarget = target; this.state.lastFoundMedia = found;
        return found;
    }

    handleMouseMove(e) {
        if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') {
            this.render.elements.viewer.style.setProperty('cursor', 'default', 'important');
            clearTimeout(this._cursorHideTimer);
            this._cursorHideTimer = setTimeout(() => {
                this.render.elements.viewer.style.setProperty('cursor', 'none', 'important');
            }, 2000);

            this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
            this.updateRender(e);
            return;
        }

        if (!this.cfg.isSiteEnabled()) {
            if (this.render.elements.viewer.style.display === 'block') this.hideViewer();
            return;
        }

        const now = performance.now();
        let media = this.state.lastFoundMedia;
        if (now - this._lastDetectTime > 100) {
            this._lastDetectTime = now;
            media = this.getMediaUnderCursor(e.clientX, e.clientY, e.target);
            
            if (media && (media !== this.state.currentMedia || (media.src||'video') !== this.state.currentSrc)) {
                if (Date.now() - this.state.keyboardSwitchTime < 500) return;
                if (!this.isMediaFiltered(media)) { this.triggerZoom(media); }
                return;
            }
        }

        if (this.state.currentMedia && this.render.elements.viewer.style.display === 'block' && this.state.cachedRect) {
            if (media === this.state.currentMedia && now - this._lastRectTime > 250) {
                this.state.cachedRect = this.state.currentMedia.getBoundingClientRect();
                this._lastRectTime = now;
            } else if (Date.now() - this.state.keyboardSwitchTime > 500) {
                if (e.clientX < this.state.cachedRect.left || e.clientX > this.state.cachedRect.right || 
                    e.clientY < this.state.cachedRect.top || e.clientY > this.state.cachedRect.bottom) {
                    this.hideViewer(); return;
                }
            }
            this.updateRender(e);
            
            // 🚀 触发智能化预加载判断
            if (this._mouseVector.speed > 0.1) this.triggerPreload();
        }
    }

    handleMouseOver(e) {
        if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') return;
        if (!this.cfg.isSiteEnabled()) return;

        const t = e.target;
        if ((t.tagName === 'IMG' || t.tagName === 'VIDEO') && (t.src || t.tagName === 'VIDEO')) {
            if (this.isMediaFiltered(t)) return;

            const delay = this.cfg.state.triggerDelay || 0;
            if (delay > 0) {
                clearTimeout(this._hoverDelayTimer);
                this._hoverDelayTimer = setTimeout(() => this.triggerZoom(t), delay);
            } else {
                this.triggerZoom(t);
            }
        }
    }

    handleMouseOut(e) {
        clearTimeout(this._hoverDelayTimer);
        if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') return;
        if (e.target === this.state.currentMedia) {
            if (e.relatedTarget && this.state.currentMedia.contains(e.relatedTarget)) return;
            if (Date.now() - this.state.keyboardSwitchTime > 500) this.hideViewer();
        }
    }

    handleMouseLeave() {
        clearTimeout(this._hoverDelayTimer);
        if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') return;
        if (Date.now() - this.state.keyboardSwitchTime > 500) this.hideViewer();
    }

    async upgradeToHDQuietly(target, src) {
        if (this.cfg.state.loadHD !== 'true') return;
        
        const savedSessionId = this.state.renderRequestId;

        try {
            if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                const hdUrl = await window.Mix01RuleEngine.getHighResUrl(target, src);
                if (hdUrl && hdUrl !== src && !this.render.hdState.badUrls.has(hdUrl)) {
                    
                    window.__mix01HdUrlMap = window.__mix01HdUrlMap || {};
                    window.__mix01HdUrlMap[src] = hdUrl;

                    if (this.state.renderRequestId !== savedSessionId || this.state.currentSrc !== src) return; 
                    if (this.render.elements.img.src === hdUrl) return;

                    this.state.currentHdUrl = hdUrl;
                    this.render.hdState.isLoading = true;
                    
                    this.render.hdState.progress = 0;
                    if (this.render.hdState.progressTimer) clearInterval(this.render.hdState.progressTimer);
                    this.render.hdState.progressTimer = setInterval(() => {
                        if (this.state.renderRequestId !== savedSessionId) {
                            clearInterval(this.render.hdState.progressTimer); return;
                        }
                        if (this.render.hdState.progress < 95) {
                            this.render.hdState.progress += Math.floor(Math.random() * 8) + 2;
                            if (this.render.hdState.progress > 95) this.render.hdState.progress = 95;
                            this.updateRender(); 
                        }
                    }, 150);
                    this.updateRender(); 

                    // 🚀 优化 4：多线程异步解算位图，避免主线程解码超大图产生微卡顿（Jank）
                    try {
                        const response = await fetch(hdUrl, { mode: 'cors' });
                        const blob = await response.blob();
                        
                        if (this.state.renderRequestId !== savedSessionId) return;

                        // 调用 V8 核心多线程解码并行管道
                        const bitmap = await createImageBitmap(blob);
                        
                        if (this.state.renderRequestId !== savedSessionId) {
                            bitmap.close(); return;
                        }

                        if (bitmap.width <= 10 && bitmap.height <= 10) {
                            bitmap.close(); throw new Error("Bad bitmap size");
                        }

                        if (this.render.hdState.progressTimer) {
                            clearInterval(this.render.hdState.progressTimer);
                            this.render.hdState.progressTimer = null;
                        }
                        this.render.hdState.progress = 100;
                        this.render.hdState.isLoading = false;

                        // 注入渲染器高速直接绘制
                        this.render.drawDecodedBitmap(bitmap, hdUrl);

                        if (!this.cfg.state.isImmersive && this.state.currentMode === 'partial' && this.state.isSmallOptimized && !this.state.isZoomManuallyChanged) {
                            const nw = bitmap.width, nh = bitmap.height;
                            if (nw > 350 || nh > 350) {
                                this.state.customLensWidth = Math.min(nw, window.innerWidth * 0.9);
                                this.state.customLensHeight = Math.min(nh, window.innerHeight * 0.9);
                                this.physics.targetZoom = nw / (this.state.cachedRect.width || 1);
                                this._killPhysicsLoop();
                                this._startPhysicsLoop();
                            }
                        }
                        this.updateRender();
                    } catch (bitmapErr) {
                        // CORS 降级回退池化处理
                        if (this.state.renderRequestId !== savedSessionId) return;
                        
                        const tempImg = this.imgPool.acquire();
                        tempImg.onload = () => {
                            if (this.state.renderRequestId !== savedSessionId) { this.imgPool.release(tempImg); return; }
                            if (tempImg.naturalWidth <= 10 && tempImg.naturalHeight <= 10) { tempImg.onerror(); return; }

                            if (this.render.hdState.progressTimer) {
                                clearInterval(this.render.hdState.progressTimer);
                                this.render.hdState.progressTimer = null;
                            }
                            this.render.hdState.progress = 100;
                            this.render.hdState.isLoading = false; 
                            this.render.elements.img.src = hdUrl; 
                            this.updateRender();
                            this.imgPool.release(tempImg);
                        };
                        tempImg.onerror = () => {
                            if (this.state.renderRequestId !== savedSessionId) { this.imgPool.release(tempImg); return; }
                            if (this.render.hdState.progressTimer) {
                                clearInterval(this.render.hdState.progressTimer);
                                this.render.hdState.progressTimer = null;
                            }
                            this.render.hdState.isLoading = false;
                            this.render.hdState.badUrls.add(hdUrl);
                            this.updateRender();
                            this.imgPool.release(tempImg);
                        };
                        tempImg.src = hdUrl;
                    }
                }
            }
        } catch (error) { console.warn('Mix01 Engine 解析失败:', error); }
    }

    async triggerZoom(target) {
        if (target === this.state.currentMedia && (target.src || 'video') === this.state.currentSrc) return;
        if (target.tagName === 'VIDEO' && this.cfg.state.disableVideoDefaultView && !this.cfg.state.isImmersive) return;

        this.hideViewer();
        
        this.state.renderRequestId++;
        
        window.lastHoveredMedia = target ? new WeakRef(target) : null;
        window.lastHoveredSrc = target.src || 'video';
        
        this.state.currentMedia = target; 
        this.state.currentSrc = target.src || 'video';
        this.state.cachedRect = target.getBoundingClientRect();
        this._lastRectTime = performance.now(); 
        
        this.state._galleryCacheDirty = true;
        
        this.mediaObserver.disconnect();
        if (target.tagName === 'IMG') {
            this.mediaObserver.observe(target, { attributes: true, attributeFilter: ['src'] });
        }
        
        this.state.isSmallOptimized = false;
        this.state.customLensWidth = null; this.state.customLensHeight = null;
        this.state.isZoomManuallyChanged = false;
        window.__mix01UserPaused = false;
        
        this.state.currentMode = this.cfg.state.mode;
        this.state.currentRotate = 0;
        this.state.currentMirror = 1;
        
        if (this.render.hdState.progressTimer) {
            clearInterval(this.render.hdState.progressTimer);
            this.render.hdState.progressTimer = null;
        }

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

        this.render.setStyle(this.render.elements.progressContainer, 'display', 'none');
        this.render.setStyle(this.render.elements.img, 'display', 'block');
        this.render.setStyle(this.render.elements.img, 'max-width', 'none'); 
        this.render.setStyle(this.render.elements.img, 'max-height', 'none');
        this.render.setStyle(this.render.elements.img, 'opacity', '0');

        let initialSrc = target.src;
        if (window.__mix01HdUrlMap && window.__mix01HdUrlMap[initialSrc]) {
            const mappedUrl = window.__mix01HdUrlMap[initialSrc];
            if (!this.render.hdState.badUrls.has(mappedUrl)) {
                initialSrc = mappedUrl;
                this.state.currentHdUrl = initialSrc;
            } else {
                this.state.currentHdUrl = null;
            }
        } else {
            this.state.currentHdUrl = null;
        }

        this.render.elements.img.src = initialSrc;
        
        this.render.elements.img.decode().then(() => {
            if (this.state.currentSrc === target.src) this.render.setStyle(this.render.elements.img, 'opacity', '1');
        }).catch(() => {
            if (this.state.currentSrc === target.src) this.render.setStyle(this.render.elements.img, 'opacity', '1');
        });

        if (this.cfg.state.smallImageOptimization) {
            if (this.state.cachedRect.width <= 50 && this.state.cachedRect.height <= 50) { this.physics.targetZoom = 9.0; this.state.isSmallOptimized = true; }
            else if (this.state.cachedRect.width <= 100 && this.state.cachedRect.height <= 100) { this.physics.targetZoom = 6.0; this.state.isSmallOptimized = true; }
            else { this.physics.targetZoom = this.cfg.state.zoom; }
        } else {
            this.physics.targetZoom = this.cfg.state.zoom;
        }
        
        this.physics.currentZoom = this.physics.targetZoom;
        this.physics.targetPanX = 0; this.physics.currentPanX = 0;
        this.physics.targetPanY = 0; this.physics.currentPanY = 0;

        this.updateRender();
        this.upgradeToHDQuietly(target, target.src);

        this.render.setStyle(this.render.elements.viewer, 'display', 'block');
        if (this.cfg.state.isImmersive) {
            this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
            setTimeout(() => this._updateGalleryCounter(), 60);
        }
        
        this.triggerPreload();
    }

    updateRender(e = null) {
        if (!this.state.currentMedia || !this.state.cachedRect) return;
        if (this.state.isRenderingLock) return;
        this.state.isRenderingLock = true;

        const sW = window.innerWidth;
        const sH = window.innerHeight;
        const rect = this.state.cachedRect;
        const x = e ? e.clientX : (window.lastMouseX !== undefined ? window.lastMouseX : sW / 2);
        const y = e ? e.clientY : (window.lastMouseY !== undefined ? window.lastMouseY : sH / 2);
        
        let xP, yP;
        if (this.cfg.state.isImmersive) {
            xP = x / sW;
            yP = y / sH;
        } else {
            xP = (x - rect.left) / (rect.width || 1);
            yP = (y - rect.top) / (rect.height || 1);
        }

        xP = Math.max(0, Math.min(1, xP));
        yP = Math.max(0, Math.min(1, yP));

        const roundedX = Math.round(xP * 1000);
        const roundedY = Math.round(yP * 1000);
        const roundedZoom = Math.round(this.physics.currentZoom * 1000);
        const mediaSrc = this.state.currentSrc || '';
        
        const renderSignature = `${mediaSrc}|${roundedX}|${roundedY}|${roundedZoom}|${this.state.currentMode}|${this.state.currentRotate}|${this.state.currentMirror}|${this.physics.currentPanX.toFixed(2)}|${this.physics.currentPanY.toFixed(2)}|${this.cfg.state.isImmersive}`;

        if (this.state.lastRenderSignature === renderSignature) {
            this.state.isRenderingLock = false;
            return;
        }
        this.state.lastRenderSignature = renderSignature;

        requestAnimationFrame(() => {
            if (!this.state.currentMedia || !this.state.cachedRect) {
                this.state.isRenderingLock = false;
                return;
            }
            try {
                const isVideo = this.state.currentMedia.tagName === 'VIDEO';
                const activeMedia = isVideo ? this.render.elements.videoClone : this.render.elements.img;
                
                const returnedZoom = this.render.updateLayout(
                    activeMedia, rect, this.physics.currentZoom, xP, yP,
                    this.state.isSmallOptimized, this.state.customLensWidth, this.state.customLensHeight,
                    this.state.isZoomManuallyChanged, this.state.currentSrc, sW, sH,
                    this.physics.currentPanX, this.physics.currentPanY,
                    this.state.currentMode, this.state.currentRotate, this.state.currentMirror
                );
                
                if (!this.state.isZoomManuallyChanged) {
                    this.physics.currentZoom = returnedZoom;
                    this.physics.targetZoom = returnedZoom;
                }
            } catch (err) {
                console.warn("Mix01 Render Engine:", err);
            } finally {
                this.state.isRenderingLock = false;
            }
        });
    }

    hideViewer() {
        this._killPhysicsLoop(); 
        this.render.hide();
        clearTimeout(this._cursorHideTimer);
        this.mediaObserver.disconnect();
        if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = null; }
        if (this.render.hdState.progressTimer) { clearInterval(this.render.hdState.progressTimer); this.render.hdState.progressTimer = null; }
        
        this.state.currentMedia = null;
        this.state.currentSrc = null;
        this.state.currentHdUrl = null; 
        this.state.cachedRect = null;
        this.state.isSmallOptimized = false;
        this.state.customLensWidth = null;
        this.state.customLensHeight = null;
        this.state.isZoomManuallyChanged = false;
        this.state.lastRenderSignature = null;
        window.isFetchingMore = false;
        this.state.isRenderingLock = false;
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
        let config = this.compiledKeys[comboStr];
        if (!config) {
            const parts = comboStr.toLowerCase().split('+').map(s => s.trim());
            config = { 
                key: parts.pop(), 
                ctrl: parts.includes('ctrl'), 
                shift: parts.includes('shift'), 
                alt: parts.includes('alt') 
            };
            this.compiledKeys[comboStr] = config; 
        }
        
        if (e.ctrlKey !== config.ctrl) return false;
        if (e.shiftKey !== config.shift) return false;
        if (e.altKey !== config.alt) return false;
        return e.key.toLowerCase() === config.key || e.code.toLowerCase() === config.key;
    }

    isMediaFiltered(el) {
        const minSize = this.cfg.state.minZoomSize || 0;
        if (minSize > 0) {
            const rect = el.getBoundingClientRect();
            if (rect.width < minSize && rect.height < minSize) return true;
        }

        const selectorStr = this.cfg.state.excludeSelectors || '';
        if (selectorStr.trim()) {
            if (selectorStr !== this._lastExcludeSelectorStr) {
                this._lastExcludeSelectorStr = selectorStr;
                this._compiledExcludeSelectors = selectorStr.split(',')
                    .map(s => s.trim()).filter(Boolean);
            }
            for (const sel of (this._compiledExcludeSelectors || [])) {
                try { if (el.matches(sel)) return true; } catch (e) { }
            }
        }
        return false;
    }

    _updateGalleryCounter() {
        if (!this.cfg.state.isImmersive) {
            this.render.updateCounter(0, 0);
            return;
        }
        const gallery = this.getGalleryImages();
        let idx = gallery.indexOf(this.state.currentMedia);
        if (idx === -1 && this.state.currentSrc) {
            idx = gallery.findIndex(m => (m.src || 'video') === this.state.currentSrc);
        }
        this.render.updateCounter(idx >= 0 ? idx : 0, gallery.length);
    }

    getGalleryImages() {
        if (!this.state._galleryCacheDirty && this.state._galleryCache) {
            const arr = this.state._galleryCache.map(ref => ref.deref()).filter(Boolean);
            if (arr.length > 0) return arr;
        }

        const adapter = window.Mix01Utils.getImmersiveAdapter();
        let result = [];
        if (adapter && adapter.getGalleryImages) {
            result = adapter.getGalleryImages();
        } else {
            result = Array.from(document.querySelectorAll('img, video')).filter(media => {
                if (media.id === 'zoom-img-xyz' || media.id === 'zoom-video-xyz') return false;
                const rect = media.getBoundingClientRect();
                return rect.width > 50 && rect.height > 50; 
            });
        }
        
        this.state._galleryCache = result.map(el => new WeakRef(el));
        this.state._galleryCacheDirty = false;
        return result;
    }

    _quickToggleSite() {
        const host = window.location.hostname;
        if (!host) return;
        if (this.cfg.disabledSites[host]) {
            delete this.cfg.disabledSites[host];
        } else {
            this.cfg.disabledSites[host] = true;
            if (this.cfg.state.isImmersive) this.exitImmersive();
            else this.hideViewer();
        }
        this.cfg.save({ disabledSites: this.cfg.disabledSites });
        const isEnabled = this.cfg.isSiteEnabled();
        this.render.showToast(isEnabled ? '✅ 已在此站点启用引擎' : '🚫 已在此站点禁用引擎');
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
                this._updateGalleryCounter();
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
                        chrome.runtime.sendMessage({ action: "downloadImmersiveImg", url: videoUrl });
                    } else this.render.showToast("❌ 无法解析该媒体的直链");
                });
            } else {
                this.render.showToast("⚠️ 当前站点暂未适配一键视频提取");
            }
        } else {
            const downloadUrl = this.state.currentHdUrl || this.render.elements.img.src;
            if (downloadUrl) {
                window.Mix01Utils.downloadImage(downloadUrl, this.render);
            }
        }
    }

    // 🚀 优化 5：结合物理向量滑动的预测型预加载控制
    triggerPreload() {
        if (this.cfg.state.preloadCount <= 0 || !this.state.currentMedia) return;

        if (this._preloadTimer) clearTimeout(this._preloadTimer);

        this._preloadTimer = setTimeout(() => {
            const galleryImages = this.getGalleryImages();
            let currentIndex = galleryImages.indexOf(this.state.currentMedia);
            
            if (currentIndex === -1 && this.state.currentSrc) {
                currentIndex = galleryImages.findIndex(media => (media.src||'video') === this.state.currentSrc);
            }
            if (currentIndex === -1) return;

            for (let img of this.activePreloads) this.imgPool.release(img);
            this.activePreloads.clear();

            // 依据鼠标最新移动的方向，决定向前还是向后加载
            let direction = 1; 
            if (!this.cfg.state.isImmersive) {
                if (this._mouseVector.dy < -2) direction = -1; // 向上划，判定翻阅前文
            }

            let loadedCount = 0;
            const scanTarget = this.cfg.state.preloadCount;

            for (let i = 1; i <= scanTarget * 2; i++) {
                if (loadedCount >= scanTarget) break;

                const offset = i * direction;
                const targetIndex = currentIndex + offset;
                
                if (targetIndex < 0 || targetIndex >= galleryImages.length) continue;

                const media = galleryImages[targetIndex];
                if (media.tagName === 'IMG') {
                    const src = media.src;
                    loadedCount++;
                    
                    (async () => {
                        let targetUrl = src;
                        if (this.cfg.state.loadHD === 'true' && window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                            try { targetUrl = await window.Mix01RuleEngine.getHighResUrl(media, src); } catch (e) {}
                        }

                        if (targetUrl && !this.preloadedUrls.has(targetUrl) && !this.render.badUrls?.has(targetUrl)) {
                            this.preloadedUrls.add(targetUrl);
                            this.preloadedUrlsQueue.push(targetUrl);

                            if (this.preloadedUrlsQueue.length > 200) {
                                const oldest = this.preloadedUrlsQueue.shift();
                                this.preloadedUrls.delete(oldest);
                            }
                            
                            try {
                                const preloaderImg = this.imgPool.acquire();
                                this.activePreloads.add(preloaderImg);

                                preloaderImg.onload = preloaderImg.onerror = () => {
                                    this.activePreloads.delete(preloaderImg);
                                    this.imgPool.release(preloaderImg);
                                };
                                preloaderImg.src = targetUrl;
                            } catch (e) {}
                        }
                    })();
                }
            }
        }, 120); 
    }

    handleKeyDown(e) {
        if (!this.cfg.state.hasAgreed) return;
        if (!this.cfg.isSiteEnabled()) return;
        const k = e.key.toLowerCase(); let up = false;
        const modeList = ['partial', 'full-follow'];
        const modeNames = { 'partial': '🔍 局部放大', 'full-follow': '🖼️ 整体跟随' };
        
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x') {
            this._quickToggleSite();
            e.preventDefault(); return;
        }

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
                    this._updateGalleryCounter();
                }
            }
            return;
        }

        if (this.render.elements.viewer.style.display !== 'block') return;

        if (this.cfg.state.isImmersive) {
            this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
        }

        if (this.matchCombo(e, this.cfg.keys.playVideo || 'space') || e.code === 'Space') {
            if (this.cfg.state.isImmersive && this.state.currentMedia && this.state.currentMedia.tagName === 'VIDEO') {
                this._toggleVideoPlay();
                e.preventDefault(); return;
            }
        }

        if (this.matchCombo(e, this.cfg.keys.downloadVideo || 'd')) {
            if (this.cfg.state.isImmersive && this.state.currentMedia) {
                this.triggerGlobalDownload();
                e.preventDefault(); return;
            }
        }

        if (this.matchCombo(e, this.cfg.keys.openInTab || 'o')) {
            const urlToOpen = this.state.currentHdUrl || this.render.elements.img.src;
            if (urlToOpen && urlToOpen !== window.location.href) {
                window.open(urlToOpen, '_blank', 'noopener,noreferrer');
                this.render.showToast('🔗 已在新标签页打开原图');
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

        if (k === this.cfg.keys.rotate) { 
            this.state.currentRotate = (this.state.currentRotate + 90) % 360; 
            up = true; this._clampTargetPan(); this._killPhysicsLoop(); this._startPhysicsLoop();
        } 
        else if (k === this.cfg.keys.mirror) { 
            this.state.currentMirror *= -1; 
            up = true; this._killPhysicsLoop(); this._startPhysicsLoop();
        } 
        else if (k === this.cfg.keys.mode) { 
            if (this.cfg.state.isImmersive) {
                this.render.showToast(`⚠️ 请双击背景或按 ${(this.cfg.keys.immersive || 'Esc').toUpperCase()} 退出沉浸模式`);
            } else {
                this.state.currentMode = modeList[(modeList.indexOf(this.state.currentMode) + 1) % modeList.length]; 
                up = true; this._killPhysicsLoop(); this._startPhysicsLoop();
                this.render.showToast(modeNames[this.state.currentMode]); 
            }
        }
        else if (k === this.cfg.keys.zoomIn || k === '+') { 
            this.physics.targetZoom += 0.5; this.state.isZoomManuallyChanged = true; 
            this.render.showToast(`${this.physics.targetZoom.toFixed(1)}x`); up = true; 
            this._clampTargetPan(); this._killPhysicsLoop(); this._startPhysicsLoop();
        } 
        else if (k === this.cfg.keys.zoomOut || k === '-') { 
            this.physics.targetZoom = Math.max(0.5, this.physics.targetZoom - 0.5); this.state.isZoomManuallyChanged = true; 
            this.render.showToast(`${this.physics.targetZoom.toFixed(1)}x`); up = true; 
            this._clampTargetPan(); this._killPhysicsLoop(); this._startPhysicsLoop();
        }
        
        else if (e.key === 'Escape') {
            if (this.cfg.state.isImmersive) {
                this.exitImmersive();
                e.preventDefault(); return;
            }
        }
        else if (k === 'arrowleft' || k === 'a' || k === 'arrowright' || k === 'd') {
            if (this.cfg.state.isImmersive && this.state.currentMedia && this.state.currentMedia.tagName === 'VIDEO') {
                const isForward = (k === 'arrowright' || k === 'd');
                const v = this.state.currentMedia;
                if (v.duration) {
                    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + (isForward ? 5 : -5)));
                    this.render.showToast(isForward ? "⏩ 快进 5 秒" : "⏪ 快退 5 秒");
                }
                e.preventDefault(); 
                return;
            }
        }
        else if (k === 'arrowup' || k === 'w' || k === 'arrowdown' || k === 's') {
            if (!this.cfg.state.isImmersive || window.isFetchingMore) return;

            const galleryImages = this.getGalleryImages();
            if (galleryImages.length === 0) return;

            let currentIndex = galleryImages.indexOf(this.state.currentMedia);
            if (currentIndex === -1 && this.state.currentSrc) {
                currentIndex = galleryImages.findIndex(media => (media.src||'video') === this.state.currentSrc);
            }
            if (currentIndex === -1) currentIndex = 0;

            const isNext = (k === 'arrowdown' || k === 's');

            if (isNext) {
                if (currentIndex < galleryImages.length - 1) {
                    this.performSwitch(galleryImages[currentIndex + 1], "下一项 ⬇️");
                } else {
                    window.isFetchingMore = true;
                    this.render.showToast("⏳ 正在加载更多动态...");
                    
                    let previousLastSrc = galleryImages[galleryImages.length - 1] ? (galleryImages[galleryImages.length - 1].src || 'video') : null;
                    window.scrollBy({ top: window.innerHeight * 1.5, behavior: 'smooth' });
                    
                    setTimeout(() => {
                        this.state._galleryCacheDirty = true;
                        const newGallery = this.getGalleryImages();
                        
                        let newIdx = newGallery.indexOf(this.state.currentMedia);
                        if (newIdx === -1) newIdx = newGallery.findIndex(media => (media.src||'video') === this.state.currentSrc);
                        
                        if (newIdx !== -1 && newIdx < newGallery.length - 1) {
                            this.performSwitch(newGallery[newIdx + 1], "下一项 ⬇️");
                        } else {
                            let currentLastSrc = newGallery[newGallery.length - 1]?.src || 'video';
                            if (currentLastSrc !== previousLastSrc && currentLastSrc !== this.state.currentSrc) {
                                this.performSwitch(newGallery[0], "下一项 ⬇️");
                            } else {
                                this.render.showToast("🚧 到底啦！没有更多内容了");
                            }
                        }
                        window.isFetchingMore = false;
                    }, 1200); 
                }
            } else {
                if (currentIndex > 0) {
                    this.performSwitch(galleryImages[currentIndex - 1], "⬆️ 上一项");
                } else {
                    window.isFetchingMore = true;
                    this.render.showToast("⏳ 正在向上翻阅...");
                    
                    let previousFirstSrc = galleryImages[0] ? (galleryImages[0].src || 'video') : null;
                    window.scrollBy({ top: -window.innerHeight * 1.5, behavior: 'smooth' });
                    
                    setTimeout(() => {
                        this.state._galleryCacheDirty = true;
                        const newGallery = this.getGalleryImages();
                        if (newGallery.length === 0) {
                            this.render.showToast("🚧 到顶啦！");
                            window.isFetchingMore = false;
                            return;
                        }

                        let newIdx = newGallery.indexOf(this.state.currentMedia);
                        if (newIdx === -1) newIdx = newGallery.findIndex(media => (media.src||'video') === this.state.currentSrc);
                        
                        if (newIdx !== -1 && newIdx > 0) {
                            this.performSwitch(newGallery[newIdx - 1], "⬆️ 上一项");
                        } else {
                            let currentFirstSrc = newGallery[0].src || 'video';
                            if (currentFirstSrc !== previousFirstSrc && currentFirstSrc !== this.state.currentSrc) {
                                this.performSwitch(newGallery[newGallery.length - 1], "⬆️ 上一项");
                            } else {
                                this.render.showToast("🚧 真的到顶啦！");
                            }
                        }
                        window.isFetchingMore = false;
                    }, 1200);
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