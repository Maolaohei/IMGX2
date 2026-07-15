class Mix01ImagePool {
    constructor() { this.pool = []; }
    acquire() { return this.pool.pop() || new Image(); }
    release(img) {
        if (!img) return;
        img.onload = null; img.onerror = null; img.onabort = null; img.src = '';
        if (this.pool.length < 30) this.pool.push(img);
    }
    releaseAll(iterable) {
        for (const img of iterable) this.release(img);
    }
}

// Bounded global caches for long browsing sessions
const CACHE_LIMITS = {
    loadedHdUrls: 120,
    hdUrlMap: 200,
    likeMediaCache: 150,
    followAuthorCache: 100,
    badUrls: 80,
    preloadedUrls: 40
};

const ensureMix01State = () => {
    window.__mix01State = window.__mix01State || {};
    return window.__mix01State;
};

const trimSet = (set, maxSize) => {
    if (!set || set.size <= maxSize) return set;
    const overflow = set.size - maxSize;
    let i = 0;
    for (const value of set) {
        set.delete(value);
        if (++i >= overflow) break;
    }
    return set;
};

const rememberHdUrl = (src, hdUrl) => {
    if (!src || !hdUrl) return;
    const state = ensureMix01State();
    state.hdUrlMap = state.hdUrlMap || {};
    if (state.hdUrlMap[src] !== undefined) delete state.hdUrlMap[src];
    state.hdUrlMap[src] = hdUrl;
    const keys = Object.keys(state.hdUrlMap);
    if (keys.length > CACHE_LIMITS.hdUrlMap) {
        const overflow = keys.length - CACHE_LIMITS.hdUrlMap;
        for (let i = 0; i < overflow; i++) delete state.hdUrlMap[keys[i]];
    }
};

const rememberLoadedHdUrl = (hdUrl) => {
    if (!hdUrl) return;
    const set = getLoadedHdUrls();
    if (set.has(hdUrl)) set.delete(hdUrl);
    set.add(hdUrl);
    trimSet(set, CACHE_LIMITS.loadedHdUrls);
};

const rememberBoundedObject = (bucket, key, value, maxSize) => {
    if (!bucket || key == null) return;
    if (bucket[key] !== undefined) delete bucket[key];
    bucket[key] = value;
    const keys = Object.keys(bucket);
    if (keys.length > maxSize) {
        const overflow = keys.length - maxSize;
        for (let i = 0; i < overflow; i++) delete bucket[keys[i]];
    }
};

const getLoadedHdUrls = () => {
    const state = ensureMix01State();
    if (!state.loadedHdUrls) state.loadedHdUrls = new Set();
    return state.loadedHdUrls;
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
            isRenderingLock: false,
            lastRenderSignature: null,
            _galleryCache: null, _galleryCacheDirty: true,
            currentMode: 'partial', currentRotate: 0, currentMirror: 1,
            lastSwitchDirection: 1, 
            renderRequestId: 0,
            isViewerVisible: false // 彻底解耦 DOM 样式读取，用内存变量代替对 elements.viewer.style.display 的读取
        };

        this.compiledKeys = {};
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
        this._preloadImgInstancesMap = new Map();
        this._preloadTimer = null;   
        this._resizeTimer = null;    
        this._hoverDelayTimer = null; 
        this._cursorHideTimer = null; 
        this._hudIdleTimer = null; 
        this._cancelScrollWait = null; 
        this._clickStart = null; // click origin for immersive background exit
        this._pan = { active: false }; // drag state used by background click exit
        this._preloadInFlight = 0;
        this._preloadMaxConcurrent = 3;
        this._lastHudRefresh = 0;
        this._lastImmersiveLayoutRect = 0;
        this._lastDetectTime = 0;
        this._lastRectTime = 0;
        this._physicsFrameId = null; 

        this._mouseVector = { lastX: 0, lastY: 0, dx: 0, dy: 0, speed: 0, timestamp: 0 };

        this.visibleMediaElements = new Set();
        this.mediaIO = new IntersectionObserver((entries) => {
            let dirty = false;
            for (let e of entries) {
                if (e.isIntersecting) {
                    if (!this.visibleMediaElements.has(e.target)) dirty = true;
                    this.visibleMediaElements.add(e.target);
                } else if (this.visibleMediaElements.delete(e.target)) {
                    dirty = true;
                }
            }
            if (dirty) this.state._galleryCacheDirty = true;
        }, { rootMargin: '300px' });
        
        this.initPassiveDOMScanner();

        this.mediaObserver = new MutationObserver((mutations) => {
            if (this.state.isViewerVisible) return;

            let newSrc = null;
            for (let m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'src' && m.target === this.state.currentMedia) {
                    if (this.state.currentMedia && this.state.currentMedia.src !== this.state.currentSrc) {
                        newSrc = this.state.currentMedia.src; break; 
                    }
                }
            }
            if (!newSrc) return;

            this.state.currentSrc = newSrc;
            if (this.render.elements.img.src !== this.state.currentHdUrl) {
                this.render.elements.img.src = newSrc;
                this.updateRender();
            }
            this.upgradeToHDQuietly(this.state.currentMedia, newSrc);
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
                            // Sync path stays light: only direct media dirties gallery.
                            // Containers are scanned on idle; scan itself will observe nested media.
                            if (isImgOrVideo) {
                                this.state._galleryCacheDirty = true;
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
        if (this._kineticFrameId) {
            cancelAnimationFrame(this._kineticFrameId);
            this._kineticFrameId = null;
        }
        this.physics.active = false;
    }

    _kickPhysics() {
        this._killPhysicsLoop();
        this._startPhysicsLoop();
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
        let currentVx = vx * 16;
        let currentVy = vy * 16;
        const friction = 0.92;

        const step = () => {
            if (this._pointerTracker.isDragging || !this.state.isViewerVisible) { this._kineticFrameId = null; return; }

            this.physics.targetPanX += currentVx;
            this.physics.targetPanY += currentVy;

            currentVx *= friction;
            currentVy *= friction;

            this._clampTargetPan(false);
            this._startPhysicsLoop();

            if (Math.abs(currentVx) > 0.05 || Math.abs(currentVy) > 0.05) {
                this._kineticFrameId = requestAnimationFrame(step);
            } else {
                this._kineticFrameId = null;
            }
        };
        this._kineticFrameId = requestAnimationFrame(step);
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

            // Track click origin for background-exit gesture (merged into primary handler)
            if (e.button === 0) {
                this._clickStart = { x: e.clientX, y: e.clientY, t: performance.now() };
            }

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
                this._pan.active = true;
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
                this._pan.active = false;
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

        // Background click / double-click to exit immersive or close lens
        this.render.elements.viewer.addEventListener('click', (e) => this.handleBackgroundClick(e), { signal: this._eventSignalController.signal });
        this.render.elements.viewer.addEventListener('dblclick', (e) => {
            if (!this.state.isViewerVisible) return;
            e.preventDefault();
            e.stopPropagation();
            if (this.cfg.state.isImmersive) this.exitImmersive();
            else this.hideViewer();
        }, { signal: this._eventSignalController.signal });

        // Right-click context menu inside viewer
        this.render.elements.viewer.addEventListener('contextmenu', (e) => {
            if (!this.state.isViewerVisible || !this.cfg.state.hasAgreed) return;
            e.preventDefault();
            e.stopPropagation();
            const lockedMedia = this.state.currentMedia;
            const lockedHd = this.state.currentHdUrl;
            const lockedSrc = this.state.currentSrc;
            this.render.showContextMenu(e.clientX, e.clientY, {
                'copy-img': () => {
                    const url = lockedHd || this.render.elements.img.src || lockedSrc;
                    if (url) window.Mix01Utils.copyImageToClipboard(url, this.render);
                },
                'copy-url': () => {
                    const url = lockedHd || this.render.elements.img.src || lockedSrc;
                    if (!url) return;
                    navigator.clipboard.writeText(url).then(() => this.render.showToast('原图链接已复制')).catch(() => {});
                },
                'copy-markdown': () => {
                    const url = lockedHd || this.render.elements.img.src || lockedSrc;
                    if (!url) return;
                    navigator.clipboard.writeText('![](' + url + ')').then(() => this.render.showToast('Markdown 已复制')).catch(() => {});
                },
                'open-tab': () => {
                    const url = lockedHd || this.render.elements.img.src || lockedSrc;
                    if (url) window.open(url, '_blank', 'noopener,noreferrer');
                },
                'save': () => this.triggerGlobalDownloadWithParams(lockedMedia, lockedHd, lockedSrc),
                'disable-site': () => this._quickToggleSite(),
                'close': () => {
                    if (this.cfg.state.isImmersive) this.exitImmersive();
                    else this.hideViewer();
                }
            });
        }, { signal: this._eventSignalController.signal });

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

        this.imgPool.releaseAll(this.activePreloads);
        this.activePreloads.clear();
        this.imgPool.releaseAll(this._preloadImgInstancesMap.values());
        this._preloadImgInstancesMap.clear();
        this.preloadedUrls.clear();
        this.preloadedUrlsQueue.length = 0;
        this.visibleMediaElements.clear();
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

            // HUD DOM reads are expensive; refresh at most ~3Hz while moving
            const nowHud = performance.now();
            if (nowHud - this._lastHudRefresh > 320) {
                this._lastHudRefresh = nowHud;
                this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
            }
            // Immersive layout only needs frequent updates while dragging/zooming
            if (this._pointerTracker.isDragging || this.physics.active || this.state.isZoomManuallyChanged) {
                this.updateRender(e);
            } else if (nowHud - this._lastImmersiveLayoutRect > 120) {
                this._lastImmersiveLayoutRect = nowHud;
                this.updateRender(e);
            }
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
                    rememberHdUrl(src, hdUrl);

                    if (this.state.renderRequestId !== savedSessionId || this.state.currentSrc !== src) return;
                    if (this.render.elements.img.src === hdUrl) return;

                    this.state.currentHdUrl = hdUrl;
                    this.render.hdState.isLoading = true;
                    this.render.hdState.progress = 0;

                    // Fake progress only updates status label, not full layout
                    if (this.render.hdState.progressTimer) clearInterval(this.render.hdState.progressTimer);
                    this.render.hdState.progressTimer = setInterval(() => {
                        if (this.state.renderRequestId !== savedSessionId) {
                            clearInterval(this.render.hdState.progressTimer);
                            this.render.hdState.progressTimer = null;
                            return;
                        }
                        if (this.render.hdState.progress < 95) {
                            this.render.hdState.progress += Math.floor(Math.random() * 8) + 2;
                            if (this.render.hdState.progress > 95) this.render.hdState.progress = 95;
                            this.render.refreshHDStatusOnly();
                        }
                    }, 180);
                    this.render.refreshHDStatusOnly();

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

                        rememberLoadedHdUrl(hdUrl);
                        this.updateRender();
                    } catch (err) {
                        if (this.state.renderRequestId !== savedSessionId) return;
                        if (this.render.hdState.progressTimer) {
                            clearInterval(this.render.hdState.progressTimer);
                            this.render.hdState.progressTimer = null;
                        }
                        this.render.hdState.isLoading = false;
                        this.render.markBadHdUrl(hdUrl);
                        this.updateRender();
                    }
                }
            }
        } catch (error) { console.warn('Mix01 Engine HD Exception:', error); }
    }

    async triggerZoom(target, options = {}) {
        if (target === this.state.currentMedia && (target.src || 'video') === this.state.currentSrc) return;
        if (target.tagName === 'VIDEO' && this.cfg.state.disableVideoDefaultView && !this.cfg.state.isImmersive) return;

        // softSwitch is opt-in (keyboard gallery). Hover open still uses full hide/open.
        const softSwitch = !!options.softSwitch && this.state.isViewerVisible;
        if (softSwitch) {
            // Same-session switch: keep viewer shell, only swap media pipeline
            if (this._hdFetchController) {
                this._hdFetchController.abort();
                this._hdFetchController = null;
            }
            if (this.render.hdState.progressTimer) {
                clearInterval(this.render.hdState.progressTimer);
                this.render.hdState.progressTimer = null;
            }
            this.render.hdState.isLoading = false;
            this.render.hdState.progress = 0;
            this.render.stopVideoRender();
            this.render.prepareMediaSurface(target.tagName === 'VIDEO');
            this.mediaObserver.disconnect();
        } else {
            this.hideViewer();
        }

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
        this.imgPool.releaseAll(this.activePreloads);
        this.activePreloads.clear();
        this.render.clearBlobCache(); 
        
        if (this._preloadImgInstancesMap) {
            for (let [url, img] of this._preloadImgInstancesMap) {
                if (url !== target.src && url !== initialSrc) {
                    this.imgPool.release(img);
                }
            }
            this._preloadImgInstancesMap.clear();
        }
        this._preloadInFlight = 0;
        
        this.state.isRenderingLock = false;
        this.state.lastRenderSignature = null;
        
        window.lastHoveredMedia = target ? new WeakRef(target) : null;
        window.lastHoveredSrc = target.src || 'video';
        
        this.state.currentMedia = target; 
        this.state.currentSrc = target.src || 'video';
        // Trail ownership:
        // - empty trail: seed
        // - at tip: append/update via _pushNavTrail
        // - mid-trail (history replay): only refresh matching ref, never truncate future
        if (this.cfg.state.isImmersive) {
            this._ensureNavTrail();
            const key = this._mediaKey(target);
            const trail = this._navTrail;
            const cur = this._navTrailIndex >= 0 ? trail[this._navTrailIndex] : null;
            if (this._navTrailIndex < 0) {
                this._pushNavTrail(target, true);
            } else if (cur && cur.key === key) {
                cur.ref = new WeakRef(target);
                cur.src = target.currentSrc || target.src || cur.src;
            } else if (this._navTrailIndex === trail.length - 1) {
                this._pushNavTrail(target);
            }
        }
        this.state.cachedRect = target.getBoundingClientRect();
        this._lastRectTime = performance.now(); 
        
        // Soft switch keeps gallery cache; only hard open marks dirty when needed
        if (!softSwitch) this.state._galleryCacheDirty = true;
        
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
            // startVideoRender owns stop + surface + playback arming
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

        this.render.stopVideoRender();
        this.render.prepareMediaSurface(false);
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

        // Non-immersive modes need a real magnify factor; 0/NaN configs collapse to "no effect"
        if (!this.cfg.state.isImmersive) {
            const minZoom = (this.state.currentMode === 'partial') ? 1.8 : 1.25;
            if (!Number.isFinite(this.physics.targetZoom) || this.physics.targetZoom < minZoom) {
                this.physics.targetZoom = Math.max(minZoom, Number(this.cfg.state.zoom) || minZoom);
            }
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

        // Immersive fixed layout rarely needs fresh rect; throttle DOM reads
        const nowRect = performance.now();
        let rect = this.state.cachedRect;
        const needFreshRect = !rect || !this.cfg.state.isImmersive || (nowRect - this._lastRectTime > 160) || this._pointerTracker.isDragging;
        if (needFreshRect) {
            rect = this.state.currentMedia.getBoundingClientRect();
            this.state.cachedRect = rect;
            this._lastRectTime = nowRect;
        } 

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
            
            // Immersive auto-fit may rewrite zoom. Partial/full-follow must keep configured zoom
            // or the magnifier/follow preview looks like "no zoom".
            if (!this.state.isZoomManuallyChanged && this.cfg.state.isImmersive) {
                this.physics.currentZoom = returnedZoom;
                this.physics.targetZoom = returnedZoom;
            } else if (!this.state.isZoomManuallyChanged) {
                // Keep physics in sync with the effective zoom used by layout (min clamp etc.)
                if (Number.isFinite(returnedZoom) && returnedZoom > 0) {
                    this.physics.currentZoom = returnedZoom;
                    // do not stomp targetZoom permanently below user config on every mousemove
                    if (Math.abs(this.physics.targetZoom - returnedZoom) > 0.01) {
                        this.physics.targetZoom = returnedZoom;
                    }
                }
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

        this.imgPool.releaseAll(this.activePreloads);
        this.activePreloads.clear();
        this.imgPool.releaseAll(this._preloadImgInstancesMap.values());
        this.preloadedUrls.clear();
        this.preloadedUrlsQueue.length = 0;
        this._preloadImgInstancesMap.clear();
        this._preloadInFlight = 0;
        if (this._hdProbeScheduled) this._hdProbeScheduled.clear();
        this._pan.active = false;
        this._clickStart = null;
        // Full close ends the immersive browsing session trail
        if (!this.cfg.state.isImmersive) this._resetNavTrail();
        
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
        this._resetNavTrail();
        
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
            if ((this._pan && this._pan.active) || this._pointerTracker.isDragging || dx > 5 || dy > 5) {
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


    // ===================== Immersive gallery navigation =====================
    // Design goals:
    // 1) Document order is the only truth (not IntersectionObserver Set order)
    // 2) Directional moves prefer geometric neighbors, not raw index±1
    // 3) Mixed up/down uses a visit trail so "down after up" restores history
    // 4) Boundary fetch never jumps to window head/tail (that caused déjà-vu)

    _mediaKey(media) {
        if (!media) return '';
        if (media._mixStatusId) return `sid:${media._mixStatusId}`;
        const src = media.currentSrc || media.src || '';
        if (src) {
            // Strip cache-busters / size params that X rotates
            try {
                const u = new URL(src, location.href);
                return `src:${u.origin}${u.pathname}`;
            } catch (e) {
                return `src:${src.split('?')[0]}`;
            }
        }
        return `el:${media.tagName}:${Math.round(media.clientWidth)}x${Math.round(media.clientHeight)}`;
    }

    _sortMediaDocumentOrder(list) {
        if (!list || list.length < 2) return list || [];
        // documentPosition is stable for connected nodes and matches reading order
        return list
            .filter(el => el && el.isConnected)
            .map((el, idx) => ({ el, idx }))
            .sort((a, b) => {
                if (a.el === b.el) return 0;
                const rel = a.el.compareDocumentPosition(b.el);
                if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                // disconnected / uncommon: keep original relative order
                return a.idx - b.idx;
            })
            .map(x => x.el);
    }

    _dedupeMedia(list) {
        const seen = new Set();
        const out = [];
        for (const el of list) {
            if (!el || !el.isConnected) continue;
            const key = this._mediaKey(el);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(el);
        }
        return out;
    }

    _ensureNavTrail() {
        if (!this._navTrail) {
            this._navTrail = [];
            this._navTrailIndex = -1;
            this._navTrailKeys = new Set();
        }
        return this._navTrail;
    }

    _resetNavTrail(seedMedia = null) {
        this._navTrail = [];
        this._navTrailIndex = -1;
        this._navTrailKeys = new Set();
        if (seedMedia) this._pushNavTrail(seedMedia, true);
    }

    _pushNavTrail(media, force = false) {
        if (!media) return;
        const trail = this._ensureNavTrail();
        const key = this._mediaKey(media);
        if (!key) return;

        // If user went back in trail then branches forward, drop the discarded future
        if (this._navTrailIndex >= 0 && this._navTrailIndex < trail.length - 1) {
            const dropped = trail.splice(this._navTrailIndex + 1);
            for (const d of dropped) this._navTrailKeys.delete(d.key);
        }

        const last = trail[this._navTrailIndex];
        if (!force && last && last.key === key) {
            last.ref = new WeakRef(media);
            return;
        }

        trail.push({ key, ref: new WeakRef(media), src: media.currentSrc || media.src || 'video' });
        this._navTrailKeys.add(key);
        this._navTrailIndex = trail.length - 1;

        // Bound memory
        while (trail.length > 200) {
            const old = trail.shift();
            this._navTrailKeys.delete(old.key);
            this._navTrailIndex = Math.max(0, this._navTrailIndex - 1);
        }
    }

    _resolveTrailMedia(entry, gallery) {
        if (!entry) return null;
        const live = entry.ref?.deref?.();
        if (live && live.isConnected) return live;
        if (gallery && gallery.length) {
            const hit = gallery.find(m => this._mediaKey(m) === entry.key);
            if (hit) return hit;
            if (entry.src) {
                const bySrc = gallery.find(m => (m.currentSrc || m.src || 'video') === entry.src);
                if (bySrc) return bySrc;
            }
        }
        return null;
    }

    _findGalleryIndex(gallery, media, srcHint = null) {
        if (!gallery || !gallery.length) return -1;
        if (media) {
            let idx = gallery.indexOf(media);
            if (idx !== -1) return idx;
            const key = this._mediaKey(media);
            idx = gallery.findIndex(m => this._mediaKey(m) === key);
            if (idx !== -1) return idx;
        }
        const src = srcHint || this.state.currentSrc;
        if (src) {
            const idx = gallery.findIndex(m => (m.currentSrc || m.src || 'video') === src);
            if (idx !== -1) return idx;
        }
        return -1;
    }

    _pickDirectionalNeighbor(gallery, fromMedia, direction) {
        // direction: +1 down/next (document later), -1 up/prev (document earlier)
        if (!gallery || !gallery.length) return null;
        const sorted = this._sortMediaDocumentOrder(gallery);
        let idx = this._findGalleryIndex(sorted, fromMedia, this.state.currentSrc);

        if (idx === -1 && fromMedia) {
            // Geometric fallback relative to current media rect
            const base = fromMedia.getBoundingClientRect?.() || { top: window.innerHeight / 2, height: 0 };
            const baseY = base.top + base.height / 2;
            let best = null;
            let bestScore = Infinity;
            for (const m of sorted) {
                if (m === fromMedia) continue;
                const r = m.getBoundingClientRect();
                const y = r.top + r.height / 2;
                const dy = y - baseY;
                if (direction > 0 && dy <= 4) continue;
                if (direction < 0 && dy >= -4) continue;
                const score = Math.abs(dy) + Math.abs((r.left + r.width / 2) - (base.left + base.width / 2)) * 0.05;
                if (score < bestScore) {
                    bestScore = score;
                    best = m;
                }
            }
            return best;
        }

        if (idx === -1) {
            // No current: pick closest to viewport center, then step once in direction
            const centerY = window.innerHeight / 2;
            let closest = 0;
            let minDiff = Infinity;
            sorted.forEach((m, i) => {
                const r = m.getBoundingClientRect();
                const diff = Math.abs(r.top + r.height / 2 - centerY);
                if (diff < minDiff) { minDiff = diff; closest = i; }
            });
            idx = closest;
        }

        const targetIdx = idx + (direction > 0 ? 1 : -1);
        if (targetIdx < 0 || targetIdx >= sorted.length) return null;
        return sorted[targetIdx];
    }

    _findFreshNeighborAfterFetch(prevGalleryKeys, newGallery, direction, currentMedia) {
        const sorted = this._sortMediaDocumentOrder(newGallery);
        const curIdx = this._findGalleryIndex(sorted, currentMedia, this.state.currentSrc);

        // Prefer first item in the requested direction that is not in previous window
        if (curIdx !== -1) {
            if (direction > 0) {
                for (let i = curIdx + 1; i < sorted.length; i++) {
                    const key = this._mediaKey(sorted[i]);
                    if (!prevGalleryKeys.has(key)) return sorted[i];
                }
                // If all later items already known, still take immediate next if any
                if (curIdx + 1 < sorted.length) return sorted[curIdx + 1];
            } else {
                for (let i = curIdx - 1; i >= 0; i--) {
                    const key = this._mediaKey(sorted[i]);
                    if (!prevGalleryKeys.has(key)) return sorted[i];
                }
                if (curIdx - 1 >= 0) return sorted[curIdx - 1];
            }
            return null;
        }

        // Current node recycled: choose nearest media in direction from viewport center
        return this._pickDirectionalNeighbor(sorted, currentMedia, direction);
    }

    async _navigateImmersive(direction) {
        // direction: 1 = next/down, -1 = prev/up
        if (!this.cfg.state.isImmersive || window.__mix01State.isFetchingMore) return false;
        this._ensureNavTrail();

        // Seed trail with current item if empty
        if (this._navTrailIndex < 0 && this.state.currentMedia) {
            this._pushNavTrail(this.state.currentMedia, true);
        }

        const gallery = this.getGalleryImages();
        const toastNext = direction > 0 ? '下一项 ⬇️' : '⬆️ 上一项';

        // Mixed-direction UX: if we are not at trail end and user goes forward again,
        // prefer replaying the already-viewed forward trail first (no déjà-vu reshuffle).
        if (direction > 0 && this._navTrailIndex >= 0 && this._navTrailIndex < this._navTrail.length - 1) {
            const entry = this._navTrail[this._navTrailIndex + 1];
            const media = this._resolveTrailMedia(entry, gallery);
            if (media) {
                this._navTrailIndex += 1;
                this.performSwitch(media, 1, toastNext, { fromTrail: true });
                return true;
            }
        }
        if (direction < 0 && this._navTrailIndex > 0) {
            // Prefer trail history when going up after a chain of downs
            const entry = this._navTrail[this._navTrailIndex - 1];
            const media = this._resolveTrailMedia(entry, gallery);
            if (media) {
                this._navTrailIndex -= 1;
                this.performSwitch(media, -1, toastNext, { fromTrail: true });
                return true;
            }
        }

        // Live directional neighbor in current stable gallery
        const neighbor = this._pickDirectionalNeighbor(gallery, this.state.currentMedia, direction);
        if (neighbor) {
            this.performSwitch(neighbor, direction, toastNext);
            return true;
        }

        // Boundary: scroll to fetch more, then pick a true directional fresh neighbor
        window.__mix01State.isFetchingMore = true;
        this.render.showToast(direction > 0 ? '⏳ 正在加载更多动态...' : '⏳ 正在向上翻阅...');

        const prevKeys = new Set(gallery.map(m => this._mediaKey(m)));
        const lockedMedia = this.state.currentMedia;
        const lockedSrc = this.state.currentSrc;
        this.state._galleryCacheDirty = true;

        window.scrollBy({ top: direction > 0 ? window.innerHeight * 1.5 : -window.innerHeight * 1.5, behavior: 'smooth' });

        await new Promise(resolve => this.waitForScrollEnd(resolve));

        try {
            this.state._galleryCacheDirty = true;
            const newGallery = this.getGalleryImages();
            if (!newGallery.length) {
                this.render.showToast(direction > 0 ? '🚧 到底啦！没有更多内容了' : '🚧 到顶啦！');
                return false;
            }

            // Keep current media identity even if node recycled
            let current = lockedMedia;
            if (!current || !current.isConnected) {
                const idx = this._findGalleryIndex(newGallery, null, lockedSrc);
                current = idx >= 0 ? newGallery[idx] : this.state.currentMedia;
            }

            const fresh = this._findFreshNeighborAfterFetch(prevKeys, newGallery, direction, current);
            if (fresh && fresh !== this.state.currentMedia) {
                this.performSwitch(fresh, direction, toastNext);
                return true;
            }

            // Absolute last resort: geometric neighbor once more after layout settles
            const retry = this._pickDirectionalNeighbor(newGallery, current || this.state.currentMedia, direction);
            if (retry && retry !== this.state.currentMedia) {
                this.performSwitch(retry, direction, toastNext);
                return true;
            }

            this.render.showToast(direction > 0 ? '🚧 到底啦！没有更多内容了' : '🚧 到顶啦！');
            return false;
        } finally {
            window.__mix01State.isFetchingMore = false;
        }
    }

    getGalleryImages() {
        if (!this.state._galleryCacheDirty && this.state._galleryCache) {
            const arr = [];
            let incomplete = false;
            for (const ref of this.state._galleryCache) {
                const el = ref?.deref?.();
                if (el && el.isConnected) arr.push(el);
                else incomplete = true;
            }
            // Never reuse a half-dead virtual-list snapshot
            if (!incomplete && arr.length > 0) return arr;
            this.state._galleryCacheDirty = true;
        }

        const adapter = window.Mix01Utils.getImmersiveAdapter();
        let result = [];
        if (adapter && adapter.getGalleryImages) {
            result = adapter.getGalleryImages() || [];
        } else {
            const candidates = this.visibleMediaElements.size > 0
                ? Array.from(this.visibleMediaElements)
                : Array.from(document.querySelectorAll('img, video'));

            result = candidates.filter(media => {
                if (!media || !media.isConnected) return false;
                if (media.id === 'zoom-img-xyz' || media.id === 'zoom-img-buffer-xyz' || media.id === 'zoom-video-xyz') return false;

                if (media.tagName === 'IMG') {
                    const src = media.src || '';
                    if (
                        src.includes('tweet_video_thumb') ||
                        src.includes('ext_tw_video_thumb') ||
                        src.includes('amplify_video_thumb') ||
                        src.includes('video-thumbnail') ||
                        src.includes('video_poster')
                    ) return false;

                    if (
                        media.closest('[data-testid="videoPlayer"]') ||
                        media.closest('[class*="video-player"]')
                    ) return false;

                    const container = media.closest('article, [class*="video"], [class*="player"], [class*="media"], [class*="post"], [class*="card"]');
                    if (container && container.querySelector('video')) return false;
                    if (media.parentElement) {
                        const siblingVideo = media.parentElement.querySelector('video');
                        if (siblingVideo && siblingVideo !== media) return false;
                    }
                }

                if (this.visibleMediaElements.has(media)) {
                    return (media.clientWidth || 0) > 50 && (media.clientHeight || 0) > 50;
                }
                const rect = media.getBoundingClientRect();
                return rect.width > 50 && rect.height > 50;
            });
        }

        // Stable reading order + identity dedupe (X virtual list can clone nodes)
        result = this._dedupeMedia(this._sortMediaDocumentOrder(result));

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

    performSwitch(nextImg, direction, msgText, options = {}) {
        if (!nextImg) return;
        if (msgText) this.render.showToast(msgText);
        this.state.keyboardSwitchTime = Date.now();
        this.state.lastSwitchDirection = direction;

        // Trail bookkeeping: normal moves append; pure trail replay only moves cursor
        if (!options.fromTrail) {
            // Ensure current item is on trail before appending the destination
            if (this.state.currentMedia) this._pushNavTrail(this.state.currentMedia);
            this._pushNavTrail(nextImg);
        } else if (this.state.currentMedia) {
            // Keep weak refs fresh when replaying history
            const trail = this._ensureNavTrail();
            const cur = trail[this._navTrailIndex];
            if (cur) cur.ref = new WeakRef(nextImg);
        }

        this.triggerZoom(nextImg, { softSwitch: true });

        try {
            nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (e) {}

        this.waitForScrollEnd(() => {
            if (this.state.currentMedia === nextImg || this._mediaKey(this.state.currentMedia) === this._mediaKey(nextImg)) {
                const newRect = nextImg.getBoundingClientRect();
                window.lastMouseX = newRect.left + newRect.width / 2;
                window.lastMouseY = newRect.top + newRect.height / 2;
                this.state.cachedRect = newRect;
                this._lastRectTime = performance.now();
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
            currentState = await adapter.getStates(container, lockedMedia);
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
                if (newState !== null) {
                    window.__mix01State.likeMediaCache = window.__mix01State.likeMediaCache || {};
                    rememberBoundedObject(window.__mix01State.likeMediaCache, lockedSrc, newState, CACHE_LIMITS.likeMediaCache);
                }
            }
        }
        if (doFollow && adapter.follow) {
            if (!(isCombo && currentState.isFollowed)) {
                const newState = await adapter.follow(container, lockedMedia);
                if (newState !== null) {
                    const tempStates = adapter.getStates ? await adapter.getStates(container, lockedMedia) : null;
                    if (tempStates && tempStates.authorName) {
                        window.__mix01State.followAuthorCache = window.__mix01State.followAuthorCache || {};
                        rememberBoundedObject(window.__mix01State.followAuthorCache, tempStates.authorName, newState, CACHE_LIMITS.followAuthorCache);
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

            const oppCount = Math.max(0, Math.floor(N * 0.2));
            const mainCount = N - oppCount;       

            const preloadPlan = [];
            for (let i = 1; i <= mainCount; i++) {
                preloadPlan.push(currentIndex + i * mainDir);
            }
            for (let i = 1; i <= oppCount; i++) {
                preloadPlan.push(currentIndex + i * (-mainDir));
            }

            const queue = [];
            for (const targetIndex of preloadPlan) {
                if (targetIndex < 0 || targetIndex >= galleryImages.length) continue;
                const media = galleryImages[targetIndex];
                if (media && media.tagName === 'IMG' && media.src) queue.push(media);
            }

            const pump = () => {
                while (this._preloadInFlight < this._preloadMaxConcurrent && queue.length > 0) {
                    const media = queue.shift();
                    const src = media.src;
                    this._preloadInFlight++;

                    (async () => {
                        try {
                            const warmUrl = (url) => {
                                if (!url || this.preloadedUrls.has(url) || this.render.hdState.badUrls.has(url)) return;
                                this.preloadedUrls.add(url);
                                this.preloadedUrlsQueue.push(url);

                                const img = this.imgPool.acquire();
                                this.activePreloads.add(img);
                                img.decoding = 'async';
                                img.onload = () => {
                                    rememberLoadedHdUrl(url);
                                    this.activePreloads.delete(img);
                                };
                                img.onerror = () => {
                                    this.render.markBadHdUrl(url);
                                    this.activePreloads.delete(img);
                                    this.imgPool.release(img);
                                    this._preloadImgInstancesMap.delete(url);
                                };
                                img.src = url;
                                this._preloadImgInstancesMap.set(url, img);

                                while (this.preloadedUrlsQueue.length > CACHE_LIMITS.preloadedUrls) {
                                    const oldest = this.preloadedUrlsQueue.shift();
                                    this.preloadedUrls.delete(oldest);
                                    const oldImg = this._preloadImgInstancesMap.get(oldest);
                                    if (oldImg) {
                                        this._preloadImgInstancesMap.delete(oldest);
                                        this.activePreloads.delete(oldImg);
                                        this.imgPool.release(oldImg);
                                    }
                                }
                            };

                            // 1) Always warm the best known URL immediately
                            const mapped = ensureMix01State().hdUrlMap?.[src];
                            warmUrl(mapped || src);

                            // 2) If HD unknown, resolve on idle and warm HD without being blocked by original src membership
                            if (!mapped && this.cfg.state.loadHD === 'true' && window.Mix01RuleEngine?.getHighResUrl) {
                                this._hdProbeScheduled = this._hdProbeScheduled || new Set();
                                if (!this._hdProbeScheduled.has(src) && !this.render.hdState.badUrls.has(src)) {
                                    this._hdProbeScheduled.add(src);
                                    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 120));
                                    idle(() => {
                                        window.Mix01RuleEngine.getHighResUrl(media, src).then((hd) => {
                                            this._hdProbeScheduled.delete(src);
                                            if (!hd || hd === src) return;
                                            rememberHdUrl(src, hd);
                                            warmUrl(hd);
                                        }).catch(() => {
                                            this._hdProbeScheduled.delete(src);
                                        });
                                    });
                                }
                            }
                        } finally {
                            this._preloadInFlight = Math.max(0, this._preloadInFlight - 1);
                            pump();
                        }
                    })();
                }
            };
            pump();
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
                this._resetNavTrail(this.state.currentMedia);
                
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
            up = true; this._clampTargetPan(); this._kickPhysics();
        } 
        else if (k === this.cfg.keys.mirror) { 
            this.state.currentMirror *= -1; 
            up = true; this._kickPhysics();
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

                this.state.lastRenderSignature = null;
                this.state.isZoomManuallyChanged = false;
                this.physics.targetZoom = this.cfg.state.zoom || 2;
                this.physics.currentZoom = this.physics.targetZoom;
                this.physics.targetPanX = 0; this.physics.currentPanX = 0;
                this.physics.targetPanY = 0; this.physics.currentPanY = 0;
                up = true; this._kickPhysics();
                this.render.showToast(modeNames[this.state.currentMode]); 
            }
        }
        else if (k === this.cfg.keys.zoomIn || k === '+') { 
            this.physics.targetZoom += 0.5; this.state.isZoomManuallyChanged = true; 
            this.render.showToast(`${this.physics.targetZoom.toFixed(1)}x`); up = true; 
            this._clampTargetPan(); this._kickPhysics();
        } 
        else if (k === this.cfg.keys.zoomOut || k === '-') { 
            this.physics.targetZoom = Math.max(0.5, this.physics.targetZoom - 0.5); this.state.isZoomManuallyChanged = true; 
            this.render.showToast(`${this.physics.targetZoom.toFixed(1)}x`); up = true; 
            this._clampTargetPan(); this._kickPhysics();
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
        else if (k === 'arrowup' || k === 'w' || k === 'arrowdown') {
            // Note: bare 's' is reserved for double-action shortcut; use ArrowDown for next
            if (!this.cfg.state.isImmersive || window.__mix01State.isFetchingMore) return;

            const now = Date.now();
            if (now - (this._lastKeySwitchTime || 0) < 140) {
                e.preventDefault();
                return;
            }
            this._lastKeySwitchTime = now;

            const direction = (k === 'arrowdown') ? 1 : -1;
            e.preventDefault();
            this._navigateImmersive(direction);
            return;
        }
        
        if (up) { 
            e.preventDefault(); 
            this.updateRender(); 
        }
    }
};