class Mix01ImagePool {
    constructor() { this.pool = []; }
    acquire() { return this.pool.pop() || new Image(); }
    release(img) {
        img.onload = null; img.onerror = null; img.src = '';
        if (this.pool.length < 30) this.pool.push(img);
    }
}

// 获取或初始化全局已就绪原图 URL 集合，确保在页面生命周期中跨会话持久存在
const getLoadedHdUrls = () => {
    window.__mix01State = window.__mix01State || {};
    if (!window.__mix01State.loadedHdUrls) {
        window.__mix01State.loadedHdUrls = new Set();
    }
    return window.__mix01State.loadedHdUrls;
};

window.Mix01InputController = class InputController {
    constructor(configManager, renderer) {
        this.cfg = configManager;
        this.render = renderer;
        renderer.controller = this; // 建立对等双向绑定，与渲染引擎共用单一主 Session ID 会话锁
        this._hdFetchController = null; // 保存当前高清原图 Fetch 的 AbortController，防止垃圾带宽积记
        this._eventSignalController = new AbortController(); // 创建事件解绑专用控制器
        
        this.imgPool = new Mix01ImagePool();
        this.activePreloads = new Set();
        this.preloadAborters = []; 
        
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
            lastSwitchDirection: 1, 
            renderRequestId: 0,
            isViewerVisible: false // 彻底解耦 DOM 样式读取，用内存变量代替对 elements.viewer.style.display 的读取
        };

        this.physics = {
            targetZoom: 2.0, currentZoom: 2.0,
            targetPanX: 0, currentPanX: 0,
            targetPanY: 0, currentPanY: 0,
            active: false
        };

        // 高精多指与指针平移惯性追踪器
        this._pointerTracker = {
            isDragging: false,
            startX: 0, startY: 0,
            startPanX: 0, startPanY: 0,
            lastX: 0, lastY: 0,
            velocityX: 0, velocityY: 0,
            lastTime: 0,
            activePointers: new Map(),
            startPinchDist: 0,
            startPinchZoom: 1,
            startPinchCenter: { x: 0, y: 0 }
        };
        
        this.preloadedUrls = new Set();
        this.preloadedUrlsQueue = [];
        this._preloadImgInstancesMap = new Map(); // 保存预加载 Image 实例的强引用保护池，防止 V8 垃圾回收提前释放内存缓存 (Memory Cache)
        this.compiledKeys = {}; 
        this._preloadTimer = null;   
        this._resizeTimer = null;    
        this._hoverDelayTimer = null; 
        this._cursorHideTimer = null; 
        this._hudIdleTimer = null; 
        this._cancelScrollWait = null; 
        this._clickStart = null; // 全局点击起点，支持在小图模式下也能完美退出查看器
        this._lastDetectTime = 0;
        this._lastRectTime = 0;
        this._physicsFrameId = null; 
        this._drag = { active: false, startX: 0, startY: 0, origLeft: 0, origTop: 0 };
        this._pan = { active: false, moved: false, startX: 0, startY: 0, origPanX: 0, origPanY: 0 };

        this._mouseVector = { lastX: 0, lastY: 0, dx: 0, dy: 0, speed: 0, timestamp: 0 };

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
                
                if (!el._mixStatusId) {
                    const article = el.closest('article');
                    if (article) {
                        const statusLink = article.querySelector('a[href*="/status/"]');
                        if (statusLink) {
                            const id = statusLink.href.split('/status/').pop().split(/[\/?#]/).shift();
                            if (id) el._mixStatusId = id;
                        }
                    }
                }
            });
        };
        scanAndObserve(document);

        this._scanQueue = [];
        this._scanTimer = null;

        const processScanQueue = () => {
            if (this._scanQueue.length === 0) return;
            const batch = [...this._scanQueue];
            this._scanQueue = [];

            batch.forEach(node => {
                if (!node.isConnected) return; 
                
                scanAndObserve(node);

                if (node.tagName === 'VIDEO' && this.state.currentMedia) {
                    const currentArt = this.state.currentMedia.closest('article');
                    const newArt = node.closest('article');
                    if (currentArt && currentArt === newArt) {
                        if (this.state.currentMedia._mixStatusId) {
                            node._mixStatusId = this.state.currentMedia._mixStatusId;
                        }
                        this.triggerZoom(node);
                    }
                }
            });
        };

        const queueNodeForScan = (node) => {
            this._scanQueue.push(node);
            if (!this._scanTimer) {
                const scheduler = window.requestIdleCallback || window.requestAnimationFrame || ((cb) => setTimeout(cb, 50));
                scheduler(() => {
                    processScanQueue();
                    this._scanTimer = null;
                });
                this._scanTimer = true;
            }
        };

        this._globalDomObserver = new MutationObserver((mutations) => {
            if (!this.cfg.isSiteEnabled()) return;
            for (let m of mutations) {
                if (m.addedNodes && m.addedNodes.length > 0) {
                    for (let node of m.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const isImgOrVideo = node.tagName === 'IMG' || node.tagName === 'VIDEO';
                            if (isImgOrVideo) {
                                if (!node._mix01Observed) { 
                                    node._mix01Observed = true; 
                                    this.mediaIO.observe(node); 
                                }
                            }
                            queueNodeForScan(node);
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
        if (window.__mix01State.userPaused || v.ended) {
            window.__mix01State.userPaused = false;
            if (v.ended) v.currentTime = 0; 
            v.play().catch(() => {});
        } else {
            window.__mix01State.userPaused = true;
            v.pause();
        }
        this.render.handleImmersiveActivity(v, this.state.currentSrc, this.cfg.keys);
    }

    _startPhysicsLoop() {
        if (this.physics.active) return;
        this.physics.active = true;

        const loop = () => {
            if (!this.state.currentMedia || !this.state.isViewerVisible || this._pointerTracker.isDragging) {
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

    _clampTargetPan(elastic = false) {
        if (!this.state.currentMedia) return;
        const nw = this.state.currentMedia.naturalWidth || 0;
        const nh = this.state.currentMedia.naturalHeight || 0;
        const isRotated = this.state.currentRotate % 180 !== 0;
        const vW = (isRotated ? nh : nw) * this.physics.targetZoom;
        const vH = (isRotated ? nw : nh) * this.physics.targetZoom;
        const sw = window.innerWidth, sh = window.innerHeight;

        const minPanX = vW <= sw ? 0 : -(vW - sw);
        const maxPanX = 0;
        const minPanY = vH <= sh ? 0 : -(vH - sh);
        const maxPanY = 0;

        if (elastic) {
            // 超出视口边缘时提供弹性拉力阻尼感 (Rubber-Banding)
            const applyDamp = (val, min, max) => {
                if (val < min) return min + (val - min) * 0.3;
                if (val > max) return max + (val - max) * 0.3;
                return val;
            };
            this.physics.targetPanX = applyDamp(this.physics.targetPanX, minPanX, maxPanX);
            this.physics.targetPanY = applyDamp(this.physics.targetPanY, minPanY, maxPanY);
        } else {
            // 物理硬边界吸附
            this.physics.targetPanX = Math.max(minPanX, Math.min(maxPanX, this.physics.targetPanX));
            this.physics.targetPanY = Math.max(minPanY, Math.min(maxPanY, this.physics.targetPanY));
        }
    }

    _applyKineticInertia(vx, vy) {
        let currentVx = vx * 16; // 缩放因子对齐至 60FPS 每帧渲染跨度
        let currentVy = vy * 16;
        const friction = 0.92;   // 阻尼系数

        const step = () => {
            // 重新按住指针或退出时无缝切断惯性平移
            if (this._pointerTracker.isDragging || !this.state.isViewerVisible) return;

            this.physics.targetPanX += currentVx;
            this.physics.targetPanY += currentVy;

            currentVx *= friction;
            currentVy *= friction;

            this._clampTargetPan(false); // 阻尼衰减边缘吸附
            this._startPhysicsLoop();

            if (Math.abs(currentVx) > 0.05 || Math.abs(currentVy) > 0.05) {
                requestAnimationFrame(step);
            }
        };
        requestAnimationFrame(step);
    }

    _isEditableTarget(tgt) {
        if (!tgt) return false;
        const tag = tgt.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tgt.isContentEditable) return true;
        const role = tgt.getAttribute && tgt.getAttribute('role');
        return role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'spinbutton';
    }

    bindEvents() {
        const optPassive = { signal: this._eventSignalController.signal, capture: true, passive: true };
        const optActive  = { signal: this._eventSignalController.signal, capture: true, passive: false };
        const optKey     = { signal: this._eventSignalController.signal, capture: true };

        const viewer = this.render.elements.viewer;

        // 🚀 指针按下：支持多指缩放与单手拖拽惯性平移，彻底避免 convertTouchToMouse 报错
        viewer.addEventListener('pointerdown', (e) => {
            if (!this.state.isViewerVisible) return;

            this._pointerTracker.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            // 双指手势识别准备
            if (this._pointerTracker.activePointers.size === 2) {
                const pts = Array.from(this._pointerTracker.activePointers.values());
                this._pointerTracker.startPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                this._pointerTracker.startPinchZoom = this.physics.targetZoom;
                this._pointerTracker.startPinchCenter = {
                    x: (pts[0].x + pts[1].x) / 2,
                    y: (pts[0].y + pts[1].y) / 2
                };
                this._pointerTracker.isDragging = false;
                return;
            }

            // 单指或鼠标左键拖拽准备
            if (e.button === 0) {
                e.preventDefault();
                this._pointerTracker.isDragging = true;
                this._pointerTracker.startX = e.clientX;
                this._pointerTracker.startY = e.clientY;
                this._pointerTracker.startPanX = this.physics.targetPanX;
                this._pointerTracker.startPanY = this.physics.targetPanY;
                this._pointerTracker.lastX = e.clientX;
                this._pointerTracker.lastY = e.clientY;
                this._pointerTracker.velocityX = 0;
                this._pointerTracker.velocityY = 0;
                this._pointerTracker.lastTime = performance.now();

                viewer.setPointerCapture(e.pointerId);
            }
        }, { signal: this._eventSignalController.signal });

        // 🚀 指针平移：计算拖拽滑行速度并兼容多指缩放 (Pinch-to-Zoom)
        document.addEventListener('pointermove', (e) => {
            if (!this.state.isViewerVisible) return;

            if (this._pointerTracker.activePointers.has(e.pointerId)) {
                this._pointerTracker.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }

            // 1. 处理双指 Pinch-to-Zoom 手势
            if (this._pointerTracker.activePointers.size === 2) {
                const pts = Array.from(this._pointerTracker.activePointers.values());
                const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                const scaleFactor = currentDist / (this._pointerTracker.startPinchDist || 1);
                
                const oldZoom = this.physics.targetZoom;
                const newZoom = Math.max(0.5, Math.min(25.0, this._pointerTracker.startPinchZoom * scaleFactor));
                
                if (oldZoom !== newZoom) {
                    const centerX = this._pointerTracker.startPinchCenter.x;
                    const centerY = this._pointerTracker.startPinchCenter.y;
                    
                    this.physics.targetPanX = centerX - (centerX - this.physics.targetPanX) * (newZoom / oldZoom);
                    this.physics.targetPanY = centerY - (centerY - this.physics.targetPanY) * (newZoom / oldZoom);
                    this.physics.targetZoom = newZoom;
                    this.state.isZoomManuallyChanged = true;
                    this._clampTargetPan();
                    this._startPhysicsLoop();
                }
                return;
            }

            // 2. 单指或鼠标正常拖动
            if (this._pointerTracker.isDragging) {
                const now = performance.now();
                const dt = now - this._pointerTracker.lastTime;
                
                const dx = e.clientX - this._pointerTracker.startX;
                const dy = e.clientY - this._pointerTracker.startY;
                
                if (dt > 0) {
                    this._pointerTracker.velocityX = (e.clientX - this._pointerTracker.lastX) / dt;
                    this._pointerTracker.velocityY = (e.clientY - this._pointerTracker.lastY) / dt;
                }
                
                this._pointerTracker.lastX = e.clientX;
                this._pointerTracker.lastY = e.clientY;
                this._pointerTracker.lastTime = now;
                
                this.physics.targetPanX = this._pointerTracker.startPanX + dx;
                this.physics.targetPanY = this._pointerTracker.startPanY + dy;
                this.state.isZoomManuallyChanged = true;
                
                this._clampTargetPan(true); // 物理回弹阻尼
                this._startPhysicsLoop();
            }
        }, { signal: this._eventSignalController.signal });

        // 🚀 指针抬起：触发动量平滑阻尼滑行动画 (Kinetic Panning)
        const onPointerUpOrCancel = (e) => {
            this._pointerTracker.activePointers.delete(e.pointerId);
            
            if (this._pointerTracker.isDragging) {
                this._pointerTracker.isDragging = false;
                viewer.releasePointerCapture(e.pointerId);
                
                const speed = Math.sqrt(this._pointerTracker.velocityX ** 2 + this._pointerTracker.velocityY ** 2);
                if (speed > 0.15) {
                    this._applyKineticInertia(this._pointerTracker.velocityX, this._pointerTracker.velocityY);
                } else {
                    this._clampTargetPan(false);
                    this._startPhysicsLoop();
                }
            }
            
            if (this._pointerTracker.activePointers.size < 2) {
                this._pointerTracker.startPinchDist = 0;
            }
        };
        document.addEventListener('pointerup', onPointerUpOrCancel, { signal: this._eventSignalController.signal });
        document.addEventListener('pointercancel', onPointerUpOrCancel, { signal: this._eventSignalController.signal });

        // 🚀 滚轮缩放：重构为指针锚定中心缩放 (Cursor-Centric Zoom)
        document.addEventListener('wheel', (e) => {
            if (this.cfg.state.wheelZoomEnabled && this.state.isViewerVisible) {
                e.preventDefault();
                
                const oldZoom = this.physics.targetZoom;
                const zoomFactor = 1.25;
                const delta = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor;
                const newZoom = Math.max(0.5, Math.min(25.0, oldZoom * delta));
                
                if (oldZoom !== newZoom) {
                    const mouseX = e.clientX;
                    const mouseY = e.clientY;
                    
                    // 以指针当前的物理悬停原点作为坐标缩放锚点，防止平移跑偏
                    this.physics.targetPanX = mouseX - (mouseX - this.physics.targetPanX) * (newZoom / oldZoom);
                    this.physics.targetPanY = mouseY - (mouseY - this.physics.targetPanY) * (newZoom / oldZoom);
                    this.physics.targetZoom = newZoom;
                    
                    this.state.isZoomManuallyChanged = true;
                    this._clampTargetPan();
                    this._startPhysicsLoop();
                    
                    clearTimeout(this._wheelToastTimer);
                    this._wheelToastTimer = setTimeout(() => {
                        this.render.showToast(`🔍 ${this.physics.targetZoom.toFixed(1)}x`);
                    }, 200);
                }
            }
        }, { signal: this._eventSignalController.signal, passive: false });

        // 页面底层的鼠标追踪（用于悬停发现和速度向量计算，保持不变）
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
        }, optPassive);

        document.addEventListener('mouseover', (e) => this.handleMouseOver(e), optPassive);
        document.addEventListener('mouseout', (e) => this.handleMouseOut(e), optPassive);
        document.addEventListener('mouseleave', () => this.handleMouseLeave(), optPassive);
        
        document.addEventListener('keydown', (e) => {
            if (this._isEditableTarget(e.target)) return;
            const k = e.key.toLowerCase();
            if (k === 'space' || e.code === 'Space' || k === this.cfg.keys.downloadVideo) {
                if (this.cfg.state.isImmersive) {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }
            }
            this.handleKeyDown(e);
        }, optKey);

        window.addEventListener('blur', () => this.hideViewer(), { signal: this._eventSignalController.signal });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.hideViewer();
        }, { signal: this._eventSignalController.signal });
    }

    destroy() {
        this._eventSignalController.abort();

        if (this._globalDomObserver) this._globalDomObserver.disconnect();
        if (this.mediaObserver) this.mediaObserver.disconnect();
        if (this.mediaIO) this.mediaIO.disconnect();

        this.hideViewer();

        this.activePreloads.clear();
        this._preloadImgInstancesMap.clear();
        this.preloadedUrls.clear();
    }

    getMediaUnderCursor(clientX, clientY, target) {
        for (let el of Array.from(this.visibleMediaElements)) {
            if (!el.isConnected) {
                this.mediaIO.unobserve(el);
                this.visibleMediaElements.delete(el);
            }
        }

        if (target && (target.tagName === 'IMG' || target.tagName === 'VIDEO') && (target.src || target.tagName === 'VIDEO')) {
            this.state.lastTarget = target; this.state.lastFoundMedia = target; return target;
        }
        if (target && target === this.state.lastTarget && this.state.lastFoundMedia) return this.state.lastFoundMedia;

        const elementsUnderCursor = document.elementsFromPoint(clientX, clientY);
        let found = null;
        let minArea = Infinity;

        for (const el of elementsUnderCursor) {
            if (el.id.includes('xyz') || el.id.includes('mix01')) continue;

            if ((el.tagName === 'IMG' || el.tagName === 'VIDEO') && this.visibleMediaElements.has(el)) {
                if (!el.src && el.tagName !== 'VIDEO') continue;

                const rect = el.getBoundingClientRect(); 
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
        this.resetImmersiveHUDTimeout();

        if (this.cfg.state.isImmersive && this.state.isViewerVisible) {
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
            if (this.state.isViewerVisible) this.hideViewer();
            return;
        }

        const now = performance.now();
        let media = this.state.lastFoundMedia;
        if (now - this._lastDetectTime > 100) {
            this._lastDetectTime = now;
            media = this.getMediaUnderCursor(e.clientX, e.clientY, e.target);
            
            if (media && (media !== this.state.currentMedia || (media.src||'video') !== this.state.currentSrc)) {
                if (Date.now() - this.state.keyboardSwitchTime > 500) return;
                if (!this.isMediaFiltered(media)) { this.triggerZoom(media); }
                return;
            }
        }

        if (this.state.currentMedia && this.state.isViewerVisible && this.state.cachedRect) {
            if (!this.state.currentMedia.isConnected) {
                this.hideViewer();
                return;
            }

            const currentElement = document.elementFromPoint(e.clientX, e.clientY);
            const isMouseOverTarget = this.state.currentMedia.contains(currentElement) || 
                                      (currentElement && currentElement.id === 'zoom-img-xyz') || 
                                      (currentElement && currentElement.id === 'img-zoom-pro-viewer-xyz');

            if (Date.now() - this.state.keyboardSwitchTime > 500 && !isMouseOverTarget) {
                const margin = 12; 
                if (e.clientX < this.state.cachedRect.left - margin || e.clientX > this.state.cachedRect.right + margin || 
                    e.clientY < this.state.cachedRect.top - margin || e.clientY > this.state.cachedRect.bottom + margin) {
                    this.hideViewer(); 
                    return;
                }
            }
            this.updateRender(e);
            
            if (this._mouseVector.speed > 0.1) this.triggerPreload();
        }
    }

    handleMouseOver(e) {
        if (this.cfg.state.isImmersive && this.state.isViewerVisible) return;
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
        if (this.cfg.state.isImmersive && this.state.isViewerVisible) return;
        if (e.target === this.state.currentMedia) {
            if (e.relatedTarget && this.state.currentMedia.contains(e.relatedTarget)) return;
            if (Date.now() - this.state.keyboardSwitchTime > 500) this.hideViewer();
        }
    }

    handleMouseLeave() {
        clearTimeout(this._hoverDelayTimer);
        if (this.cfg.state.isImmersive && this.state.isViewerVisible) return;
        if (Date.now() - this.state.keyboardSwitchTime > 500) this.hideViewer();
    }

    async upgradeToHDQuietly(target, src) {
        if (this.cfg.state.loadHD !== 'true') return;
        const savedSessionId = this.state.renderRequestId;

        try {
            if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                const hdUrl = await window.Mix01RuleEngine.getHighResUrl(target, src);
                if (hdUrl && hdUrl !== src && !this.render.hdState.badUrls.has(hdUrl)) {
                    
                    window.__mix01State = window.__mix01State || {};
                    window.__mix01State.hdUrlMap = window.__mix01State.hdUrlMap || {};
                    window.__mix01State.hdUrlMap[src] = hdUrl;

                    if (this.state.renderRequestId !== savedSessionId || this.state.currentSrc !== src) return; 
                    if (this.render.elements.img.src === hdUrl) return;

                    this.state.currentHdUrl = hdUrl;
                    this.render.hdState.isLoading = true;
                    this.render.hdState.progress = 0;
                    
                    if (this.render.hdState.progressTimer) clearInterval(this.render.hdState.progressTimer);
                    this.render.hdState.progressTimer = setInterval(() => {
                        if (this.state.renderRequestId !== savedSessionId) { clearInterval(this.render.hdState.progressTimer); return; }
                        if (this.render.hdState.progress < 95) {
                            this.render.hdState.progress += Math.floor(Math.random() * 8) + 2;
                            if (this.render.hdState.progress > 95) this.render.hdState.progress = 95;
                            this.updateRender(); 
                        }
                    }, 150);
                    this.updateRender(); 

                    try {
                        await this.render.renderHDImageDirect(hdUrl, savedSessionId);
                        
                        if (this.state.renderRequestId !== savedSessionId) return;

                        if (this.render.hdState.progressTimer) { 
                            clearInterval(this.render.hdState.progressTimer); 
                            this.render.hdState.progressTimer = null; 
                        }
                        this.render.hdState.progress = 100;
                        this.render.hdState.isLoading = false;
                        this._hdFetchController = null;

                        getLoadedHdUrls().add(hdUrl);
                        this.updateRender();
                    } catch (err) {
                        if (this.state.renderRequestId !== savedSessionId) return;
                        if (this.render.hdState.progressTimer) { 
                            clearInterval(this.render.hdState.progressTimer); 
                            this.render.hdState.progressTimer = null; 
                        }
                        this.render.hdState.isLoading = false;
                        this.render.hdState.badUrls.add(hdUrl);
                        this.updateRender();
                    }
                }
            }
        } catch (error) { console.warn('Mix01 Engine HD Exception:', error); }
    }

    async triggerZoom(target) {
        if (target === this.state.currentMedia && (target.src || 'video') === this.state.currentSrc) return;
        if (target.tagName === 'VIDEO' && this.cfg.state.disableVideoDefaultView && !this.cfg.state.isImmersive) return;

        this.hideViewer();

        const savedSessionId = ++this.state.renderRequestId;

        let initialSrc = target.src;
        let hdUrl = null;
        if (window.__mix01State.hdUrlMap && window.__mix01State.hdUrlMap[initialSrc]) {
            hdUrl = window.__mix01State.hdUrlMap[initialSrc];
        }

        const loadedUrls = getLoadedHdUrls();
        let isAlreadyDownloaded = false;
        
        if (hdUrl && loadedUrls.has(hdUrl)) {
            initialSrc = hdUrl;
            isAlreadyDownloaded = true;
        }

        if (this._preloadTimer) clearTimeout(this._preloadTimer);
        for (let img of this.activePreloads) this.imgPool.release(img);
        this.activePreloads.clear();
        this.render.clearBlobCache(); 
        
        if (this._preloadImgInstancesMap) {
            for (let [url, img] of this._preloadImgInstancesMap) {
                if (url !== target.src && url !== initialSrc) {
                    if (img && !img.complete) {
                        img.src = ''; 
                    }
                }
            }
            this._preloadImgInstancesMap.clear();
        }
        
        this.state.isRenderingLock = false;
        this.state.lastRenderSignature = null;
        
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
        this.state.customLensWidth = null; 
        this.state.customLensHeight = null;
        this.state.isZoomManuallyChanged = false;
        window.__mix01State.userPaused = false;
        
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
            this.state.isViewerVisible = true; 
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
            this.state.isViewerVisible = true; 
            if (this.cfg.state.isImmersive) {
                this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                this._updateGalleryCounter();
            }
            this.triggerPreload();
            return;
        }

        this.render.setStyle(this.render.elements.progressContainer, 'display', 'none');
        this.render.setStyle(this.render.elements.img, 'display', 'block');
        this.render.setStyle(this.render.elements.img, 'max-width', 'none'); 
        this.render.setStyle(this.render.elements.img, 'max-height', 'none');
        this.render.setStyle(this.render.elements.img, 'opacity', '0');

        this.state.currentHdUrl = isAlreadyDownloaded ? hdUrl : null;
        this.render.elements.img.src = initialSrc;
        this.state.isViewerVisible = true; 
        
        this.render.elements.img.decode().then(() => {
            if (this.state.renderRequestId === savedSessionId && this.state.currentSrc === target.src) {
                this.render.setStyle(this.render.elements.img, 'opacity', '1');
                this.updateRender(); 
            }
        }).catch(() => {
            if (this.state.renderRequestId === savedSessionId && this.state.currentSrc === target.src) {
                this.render.setStyle(this.render.elements.img, 'opacity', '1');
                this.updateRender();
            }
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

        this.upgradeToHDQuietly(target, target.src).then(() => {
            if (this.state.renderRequestId === savedSessionId) {
                if (this.cfg.state.isImmersive) {
                    this._updateGalleryCounter();
                    this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                }
            }
        });

        if (this.cfg.state.isImmersive) {
            this._updateGalleryCounter();
        }
        
        this.triggerPreload();
    }

    updateRender(e = null) {
        if (!this.state.currentMedia) return; 
        if (this.state.isRenderingLock) return;
        this.state.isRenderingLock = true;

        const sW = window.innerWidth;
        const sH = window.innerHeight;

        const rect = this.state.currentMedia.getBoundingClientRect();
        this.state.cachedRect = rect; 

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

        const currentSessionId = this.state.renderRequestId;

        try {
            const isVideo = this.state.currentMedia.tagName === 'VIDEO';
            const activeMedia = isVideo ? this.render.elements.videoClone : this.render.elements.img;
            
            const returnedZoom = this.render.updateLayout(
                activeMedia, rect, this.physics.currentZoom, xP, yP,
                this.state.isSmallOptimized, this.state.customLensWidth, this.state.customLensHeight,
                this.state.isZoomManuallyChanged, this.state.currentSrc, sW, sH,
                this.physics.currentPanX, this.physics.currentPanY,
                this.state.currentMode, this.state.currentRotate, this.state.currentMirror,
                currentSessionId 
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
    }

    hideViewer() {
        this.state.renderRequestId++;
        this.state.isViewerVisible = false; 

        if (this._hdFetchController) {
            this._hdFetchController.abort();
            this._hdFetchController = null;
        }

        this._killPhysicsLoop(); 
        this.render.hide();
        clearTimeout(this._cursorHideTimer);
        clearTimeout(this._hudIdleTimer); 
        if (this._cancelScrollWait) {
            this._cancelScrollWait();
            this._cancelScrollWait = null;
        }
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
        window.__mix01State.isFetchingMore = false;
        this.state.isRenderingLock = false;
    }

    exitImmersive() {
        this.cfg.state.isImmersive = false;
        this.state.isViewerVisible = false; 
        
        const host = window.location.hostname;
        if (host) {
            this.cfg.siteImmersive[host] = false;
            this.cfg.save({ siteImmersive: this.cfg.siteImmersive });
        } else {
            this.cfg.save({ isImmersive: false });
        }
        
        this.render.showToast('❎ 已退出沉浸图库模式');
        this.hideViewer();
    }

    handleBackgroundClick(e) {
        if (e.target !== this.render.elements.viewer) return;

        if (this.cfg.state.isImmersive) {
            const startX = this._clickStart ? this._clickStart.x : e.clientX;
            const startY = this._clickStart ? this._clickStart.y : e.clientY;
            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);
            if (this._pan.active || dx > 5 || dy > 5) {
                return;
            }
            this.exitImmersive();
        } else {
            this.hideViewer();
        }
    }

    resetImmersiveHUDTimeout() {
        if (!this.cfg.state.isImmersive || !this.state.isViewerVisible) return;

        this.render.setHUDOpacity('1');

        clearTimeout(this._hudIdleTimer);
        this._hudIdleTimer = setTimeout(() => {
            this.render.setHUDOpacity('0');
        }, 2500);
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
            idx = gallery.findIndex(m => (m.src||'video') === this.state.currentSrc);
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
                if (media.id === 'zoom-img-xyz' || media.id === 'zoom-img-buffer-xyz' || media.id === 'zoom-video-xyz') return false;
                
                if (media.tagName === 'IMG') {
                    const src = media.src || '';
                    
                    if (
                        src.includes('tweet_video_thumb') || 
                        src.includes('ext_tw_video_thumb') || 
                        src.includes('amplify_video_thumb') ||
                        src.includes('video-thumbnail') ||
                        src.includes('video_poster')
                    ) {
                        return false; 
                    }

                    if (
                        media.closest('[data-testid="videoPlayer"]') || 
                        media.closest('[class*="video-player"]')
                    ) {
                        return false; 
                    }

                    const container = media.closest('article, [class*="video"], [class*="player"], [class*="media"], [class*="post"], [class*="card"]');
                    if (container && container.querySelector('video')) {
                        return false; 
                    }
                    if (media.parentElement) {
                        const siblingVideo = media.parentElement.querySelector('video');
                        if (siblingVideo && siblingVideo !== media) {
                            return false; 
                        }
                    }
                }

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

    waitForScrollEnd(callback) {
        if (this._cancelScrollWait) {
            this._cancelScrollWait();
        }

        let isEnded = false;
        const cleanUp = () => {
            window.removeEventListener('scrollend', onScrollEnd);
            window.removeEventListener('scroll', onScrollDebounce);
            clearTimeout(fallbackTimer);
            clearTimeout(debounceTimer);
            this._cancelScrollWait = null;
        };

        const onScrollEnd = () => {
            if (isEnded) return;
            isEnded = true;
            cleanUp();
            callback();
        };

        let debounceTimer;
        const onScrollDebounce = () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(onScrollEnd, 100); 
        };

        const fallbackTimer = setTimeout(onScrollEnd, 800);

        window.addEventListener('scrollend', onScrollEnd, { once: true, passive: true });
        window.addEventListener('scroll', onScrollDebounce, { passive: true });

        this._cancelScrollWait = cleanUp;
    }

    performSwitch(nextImg, direction, msgText) {
        if (msgText) this.render.showToast(msgText);
        this.state.keyboardSwitchTime = Date.now();
        
        this.state.lastSwitchDirection = direction;

        this.triggerZoom(nextImg);

        nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });

        this.waitForScrollEnd(() => {
            if (this.state.currentMedia === nextImg) {
                const newRect = nextImg.getBoundingClientRect();
                window.lastMouseX = newRect.left + newRect.width / 2;
                window.lastMouseY = newRect.top + newRect.height / 2;
                this.state.cachedRect = newRect; 
                this.updateRender();
                this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                this._updateGalleryCounter();
            }
        });
    }

    async executePhantomAction(actionType) {
        const lockedMedia = this.state.currentMedia;
        const lockedSrc = this.state.currentSrc;
        const lockedHdUrl = this.state.currentHdUrl;

        if (!lockedMedia) return;
        const adapter = window.Mix01Utils.getImmersiveAdapter();
        if (!adapter || (!adapter.like && !adapter.follow)) {
            this.render.showToast("⚠️ 该网站暂不支持快捷交互"); return;
        }

        const container = adapter.getContainer ? adapter.getContainer(lockedMedia) : document.body;
        let currentState = { isLiked: false, isFollowed: false, authorName: null };
        
        window.__mix01State = window.__mix01State || {};
        window.__mix01State.likeMediaCache = window.__mix01State.likeMediaCache || {};
        window.__mix01State.followAuthorCache = window.__mix01State.followAuthorCache || {};

        if (adapter.getStates) {
            currentState = adapter.getStates(container, lockedMedia);
            if (window.__mix01State.likeMediaCache[lockedSrc] !== undefined) {
                currentState.isLiked = window.__mix01State.likeMediaCache[lockedSrc];
            }
            if (currentState.authorName && window.__mix01State.followAuthorCache[currentState.authorName] !== undefined) {
                currentState.isFollowed = window.__mix01State.followAuthorCache[currentState.authorName];
            }
        }

        const isCombo = (actionType === 'double' || actionType === 'triple');
        const doLike = (actionType === 'like' || isCombo);
        const doFollow = (actionType === 'follow' || isCombo);
        const doDownload = (actionType === 'triple');

        if (doLike && adapter.like) {
            if (!(isCombo && currentState.isLiked)) {
                const newState = await adapter.like(container, lockedMedia);
                if (newState !== null) window.__mix01State.likeMediaCache[lockedSrc] = newState;
            }
        }
        if (doFollow && adapter.follow) {
            if (!(isCombo && currentState.isFollowed)) {
                const newState = await adapter.follow(container, lockedMedia);
                if (newState !== null) {
                    const tempStates = adapter.getStates ? adapter.getStates(container, lockedMedia) : null;
                    if (tempStates && tempStates.authorName) {
                        window.__mix01State.followAuthorCache[tempStates.authorName] = newState;
                    }
                }
            }
        }

        if (actionType === 'double') this.render.showToast("💖 一键双连生效！(喜欢+关注)");
        else if (actionType === 'triple') this.render.showToast("🚀 一键三连生效！(喜欢+关注+提取)");
        else if (actionType === 'like') this.render.showToast(window.__mix01State.likeMediaCache[lockedSrc] ? "❤️ 已喜欢" : "🤍 已取消喜欢");
        else if (actionType === 'follow') this.render.showToast("👤 关注状态已更新");

        this.render.handleImmersiveActivity(lockedMedia, lockedSrc, this.cfg.keys);

        if (doDownload) {
            this.triggerGlobalDownloadWithParams(lockedMedia, lockedHdUrl, lockedSrc);
        }
    }

    triggerGlobalDownload() {
        if (this.state.currentMedia) {
            this.triggerGlobalDownloadWithParams(
                this.state.currentMedia,
                this.state.currentHdUrl,
                this.state.currentSrc
            );
        }
    }

    triggerGlobalDownloadWithParams(media, hdUrl, fallbackSrc) {
        if (!media) return;
        const adapter = window.Mix01Utils.getImmersiveAdapter();
        const isVideo = media.tagName === 'VIDEO';

        if (isVideo) {
            if (adapter && adapter.downloadVideo) {
                this.render.showToast("⏳ 正在打通后台提取视频流...");
                const container = adapter.getContainer ? adapter.getContainer(media) : document.body;
                adapter.downloadVideo(container, media).then(videoUrl => {
                    if (videoUrl === 'NATIVE_CLICKED') {
                        this.render.showToast("✅ 已调用浏览器插件原生下载机制！");
                    } else if (videoUrl) {
                        window.Mix01Utils.downloadMedia(videoUrl, this.render, true);
                    } else {
                        this.render.showToast("❌ 无法解析该视频的直链");
                    }
                });
            } else {
                this.render.showToast("⚠️ 当前站点暂未适配一键视频提取");
            }
        } else {
            const downloadUrl = hdUrl || fallbackSrc;
            if (downloadUrl) {
                window.Mix01Utils.downloadMedia(downloadUrl, this.render, false);
            }
        }
    }

    triggerPreload() {
        if (this.cfg.state.preloadCount <= 0 || !this.state.currentMedia) return;

        if (this._preloadTimer) clearTimeout(this._preloadTimer);
        
        if (this.preloadAborters && this.preloadAborters.length > 0) {
            this.preloadAborters.forEach(aborter => {
                try { aborter.abort(); } catch (e) {}
            });
            this.preloadAborters = [];
        }

        this._preloadTimer = setTimeout(() => {
            const galleryImages = this.getGalleryImages();
            let currentIndex = galleryImages.indexOf(this.state.currentMedia);
            
            if (currentIndex === -1 && this.state.currentSrc) {
                currentIndex = galleryImages.findIndex(media => (media.src||'video') === this.state.currentSrc);
            }
            if (currentIndex === -1) return;

            const N = this.cfg.state.preloadCount;
            let mainDir = this.state.lastSwitchDirection || 1;
            if (!this.cfg.state.isImmersive && this._mouseVector.dy < -2) mainDir = -1; 

            const oppCount = Math.floor(N * 0.3); 
            const mainCount = N - oppCount;       

            const preloadPlan = [];
            for (let i = 1; i <= mainCount; i++) {
                preloadPlan.push(currentIndex + i * mainDir);
            }
            for (let i = 1; i <= oppCount; i++) {
                preloadPlan.push(currentIndex + i * (-mainDir));
            }

            let loadedCount = 0;
            for (const targetIndex of preloadPlan) {
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

                            const preloadImg = new Image();
                            preloadImg.onload = () => {
                                getLoadedHdUrls().add(targetUrl);
                            };
                            preloadImg.src = targetUrl;

                            this._preloadImgInstancesMap.set(targetUrl, preloadImg);

                            if (this.preloadedUrlsQueue.length > 50) {
                                const oldest = this.preloadedUrlsQueue.shift();
                                this.preloadedUrls.delete(oldest);
                                this._preloadImgInstancesMap.delete(oldest); 
                            }
                        }
                    })();
                }
            }
        }, 120); 
    }

    handleKeyDown(e) {
        if (!this.cfg.state.hasAgreed) return;
        if (!this.cfg.isSiteEnabled()) return;

        this.resetImmersiveHUDTimeout();

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
                
                const host = window.location.hostname;
                if (host) {
                    this.cfg.siteImmersive[host] = true;
                    this.cfg.save({ siteImmersive: this.cfg.siteImmersive });
                } else {
                    this.cfg.save({ isImmersive: true });
                }
                
                this.render.showToast('🌌 开启沉浸音视频图库');

                if (!this.state.currentMedia || !this.state.isViewerVisible) {
                    const galleryImages = this.getGalleryImages();
                    if (galleryImages.length > 0) {
                        const nextImg = galleryImages[0];
                        nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        this.triggerZoom(nextImg);
                    } else {
                        this.render.showToast("⚠️ 当前页面未发现可用媒体");
                        this.exitImmersive(); 
                    }
                } else {
                    this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
                    this._updateGalleryCounter();
                }
            }
            return;
        }

        if (!this.state.isViewerVisible) return;

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
                const nextMode = modeList[(modeList.indexOf(this.state.currentMode) + 1) % modeList.length]; 
                this.state.currentMode = nextMode;
                
                const host = window.location.hostname;
                if (host) {
                    this.cfg.siteModes[host] = nextMode;
                    this.cfg.save({ siteModes: this.cfg.siteModes });
                } else {
                    this.cfg.save({ mode: nextMode });
                }
                this.cfg.state.mode = nextMode; 

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
            if (!this.cfg.state.isImmersive || window.__mix01State.isFetchingMore) return;

            const now = Date.now();
            if (now - (this._lastKeySwitchTime || 0) < 150) {
                e.preventDefault();
                return;
            }
            this._lastKeySwitchTime = now;

            const galleryImages = this.getGalleryImages();
            if (galleryImages.length === 0) return;

            let currentIndex = galleryImages.indexOf(this.state.currentMedia);
            if (currentIndex === -1 && this.state.currentSrc) {
                currentIndex = galleryImages.findIndex(media => (media.src||'video') === this.state.currentSrc);
            }
            
            if (currentIndex === -1) {
                let closestIdx = 0;
                let minDiff = Infinity;
                const centerY = window.innerHeight / 2; 
                
                galleryImages.forEach((media, idx) => {
                    const rect = media.getBoundingClientRect();
                    const mediaCenterY = rect.top + rect.height / 2;
                    const diff = Math.abs(mediaCenterY - centerY);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = idx; 
                    }
                });
                currentIndex = closestIdx;
            }

            const isNext = (k === 'arrowdown' || k === 's');

            if (isNext) {
                if (currentIndex < galleryImages.length - 1) {
                    this.performSwitch(galleryImages[currentIndex + 1], 1, "下一项 ⬇️");
                } else {
                    window.__mix01State.isFetchingMore = true;
                    this.render.showToast("⏳ 正在加载更多动态...");
                    
                    let previousLastSrc = galleryImages[galleryImages.length - 1] ? (galleryImages[galleryImages.length - 1].src || 'video') : null;
                    
                    this.state._galleryCacheDirty = true;
                    
                    window.scrollBy({ top: window.innerHeight * 1.5, behavior: 'smooth' });
                    
                    this.waitForScrollEnd(() => {
                        const newGallery = this.getGalleryImages();
                        
                        let newIdx = newGallery.indexOf(this.state.currentMedia);
                        if (newIdx === -1) newIdx = newGallery.findIndex(media => (media.src||'video') === this.state.currentSrc);
                        
                        if (newIdx !== -1 && newIdx < newGallery.length - 1) {
                            this.performSwitch(newGallery[newIdx + 1], 1, "下一项 ⬇️");
                        } else {
                            let currentLastSrc = newGallery[newGallery.length - 1]?.src || 'video';
                            if (currentLastSrc !== previousLastSrc && currentLastSrc !== this.state.currentSrc) {
                                this.performSwitch(newGallery[0], 1, "下一项 ⬇️");
                            } else {
                                this.render.showToast("🚧 到底啦！没有更多内容了");
                            }
                        }
                        window.__mix01State.isFetchingMore = false;
                    }); 
                }
            } else {
                if (currentIndex > 0) {
                    this.performSwitch(galleryImages[currentIndex - 1], -1, "⬆️ 上一项");
                } else {
                    window.__mix01State.isFetchingMore = true;
                    this.render.showToast("⏳ 正在向上翻阅...");
                    
                    let previousFirstSrc = galleryImages[0] ? (galleryImages[0].src || 'video') : null;
                    
                    this.state._galleryCacheDirty = true;
                    
                    window.scrollBy({ top: -window.innerHeight * 1.5, behavior: 'smooth' });
                    
                    this.waitForScrollEnd(() => {
                        const newGallery = this.getGalleryImages();
                        if (newGallery.length === 0) {
                            this.render.showToast("🚧 到顶啦！");
                            window.__mix01State.isFetchingMore = false;
                            return;
                        }

                        let newIdx = newGallery.indexOf(this.state.currentMedia);
                        if (newIdx === -1) newIdx = newGallery.findIndex(media => (media.src||'video') === this.state.currentSrc);
                        
                        if (newIdx !== -1 && newIdx > 0) {
                            this.performSwitch(newGallery[newIdx - 1], -1, "⬆️ 上一项");
                        } else {
                            let currentFirstSrc = newGallery[0].src || 'video';
                            if (currentFirstSrc !== previousFirstSrc && currentFirstSrc !== this.state.currentSrc) {
                                this.performSwitch(newGallery[newGallery.length - 1], -1, "⬆️ 上一项");
                            } else {
                                this.render.showToast("🚧 真的到顶啦！");
                            }
                        }
                        window.__mix01State.isFetchingMore = false;
                    });
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