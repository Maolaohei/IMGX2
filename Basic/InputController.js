// Basic/InputController.js
class Mix01ImagePool {
    constructor() { this.pool = []; }
    acquire() { return this.pool.pop() || new Image(); }
    release(img) {
        img.onload = null; img.onerror = null; img.src = '';
        if (this.pool.length < 30) this.pool.push(img);
    }
}

// 🚀 新增：获取或初始化全局已就绪原图 URL 集合，确保在页面生命周期中跨会话持久存在
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
        renderer.controller = this; // 🚀 建立对等双向绑定，与渲染引擎共用单一主 Session ID 会话锁
        this._hdFetchController = null; // 🚀 保存当前高清原图 Fetch 的 AbortController，防止垃圾带宽积压
        this._eventSignalController = new AbortController(); // 🚀 方案五新增：创建事件解绑专用控制器
        
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
            isViewerVisible: false // 🚀 零开销核心：彻底解耦 DOM 样式读取，用内存变量代替对 elements.viewer.style.display 的读取
        };

        this.physics = {
            targetZoom: 2.0, currentZoom: 2.0,
            targetPanX: 0, currentPanX: 0,
            targetPanY: 0, currentPanY: 0,
            active: false
        };
        
        this.preloadedUrls = new Set();
        this.preloadedUrlsQueue = [];
        this._preloadImgInstancesMap = new Map(); // 🚀 新增：保存预加载 Image 实例的强引用保护池，防止 V8 垃圾回收提前释放内存缓存 (Memory Cache)
        this.compiledKeys = {}; 
        this._preloadTimer = null;   
        this._resizeTimer = null;    
        this._hoverDelayTimer = null; 
        this._cursorHideTimer = null; 
        this._hudIdleTimer = null; 
        this._cancelScrollWait = null; 
        this._clickStart = null; // 🚀 全局点击起点，支持在小图模式下也能完美退出查看器
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

        // 🌟 性能核心：建立扫描缓存延迟队列
        this._scanQueue = [];
        this._scanTimer = null;

        const processScanQueue = () => {
            if (this._scanQueue.length === 0) return;
            const batch = [...this._scanQueue];
            this._scanQueue = [];

            batch.forEach(node => {
                if (!node.isConnected) return; // 过滤已经被卸载的历史残余节点
                
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
                // 🚀 空闲帧调度机制：优先利用 requestIdleCallback 进行防抖批处理，将 DOM 扫描延迟到空闲帧运行
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
                            // 将扫描压力托管给延迟防抖队列
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
            if (!this.state.currentMedia || !this.state.isViewerVisible || this._drag.active) {
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

    _isEditableTarget(tgt) {
        if (!tgt) return false;
        const tag = tgt.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tgt.isContentEditable) return true;
        const role = tgt.getAttribute && tgt.getAttribute('role');
        return role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'spinbutton';
    }

    bindEvents() {
        // 🚀 方案五新增：定义带有 Abort 信号的统一配置，允许后期单行代码直接取消以下全部事件绑定
        const optPassive = { signal: this._eventSignalController.signal, capture: true, passive: true };
        const optActive  = { signal: this._eventSignalController.signal, capture: true, passive: false };
        const optKey     = { signal: this._eventSignalController.signal, capture: true };

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
        
        document.addEventListener('wheel', (e) => {
            if (this.cfg.state.wheelZoomEnabled && this.state.isViewerVisible) {
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
        }, { signal: this._eventSignalController.signal, passive: false });

        this.render.elements.viewer.addEventListener('touchstart', (e) => {
            if (this.cfg.state.isImmersive) { convertTouchToMouse(e, 'mousedown'); }
        }, { signal: this._eventSignalController.signal, passive: true });

        document.addEventListener('touchmove', (e) => {
            if (this._pan.active || this._drag.active) {
                convertTouchToMouse(e, 'mousemove');
                e.preventDefault(); 
            }
        }, { signal: this._eventSignalController.signal, passive: false });

        document.addEventListener('touchend', (e) => {
            if (this._pan.active || this._drag.active) { convertTouchToMouse(e, 'mouseup'); }
        }, { signal: this._eventSignalController.signal, passive: true });

        // 🚀 方案六：监听视口切换和浏览器失焦。一旦用户离开当前页面/切出窗口，立刻自动清理隐藏，消除幽灵残留卡死现象
        window.addEventListener('blur', () => this.hideViewer(), { signal: this._eventSignalController.signal });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.hideViewer();
        }, { signal: this._eventSignalController.signal });
    }

    // 🚀 方案五新增：自毁回收函数。当发现插件更新或重载时运行，彻底解除自身的所有资源和系统关联
    destroy() {
        // 1. 利用 AbortSignal 瞬间注销全局 document/window 上的所有事件
        this._eventSignalController.abort();

        // 2. 彻底断开所有的 DOM 变动与媒体观察器
        if (this._globalDomObserver) this._globalDomObserver.disconnect();
        if (this.mediaObserver) this.mediaObserver.disconnect();
        if (this.mediaIO) this.mediaIO.disconnect();

        // 3. 关闭正在运行的高清大图、计时器、流
        this.hideViewer();

        // 4. 清除强引用预加载缓存，允许浏览器 GC 顺利回收内存
        this.activePreloads.clear();
        this._preloadImgInstancesMap.clear();
        this.preloadedUrls.clear();
    }


    getMediaUnderCursor(clientX, clientY, target) {
        // 🚀 核心改进 1：安全内存自愈。
        for (let el of Array.from(this.visibleMediaElements)) {
            if (!el.isConnected) {
                // 🚀 核心优化 2：彻底回收。必须手动调用 unobserve，否则 Chrome 内部观察队列将继续留存强引用，导致离地 DOM 内存泄漏
                this.mediaIO.unobserve(el);
                this.visibleMediaElements.delete(el);
            }
        
        }

        if (target && (target.tagName === 'IMG' || target.tagName === 'VIDEO') && (target.src || target.tagName === 'VIDEO')) {
            this.state.lastTarget = target; this.state.lastFoundMedia = target; return target;
        }
        if (target && target === this.state.lastTarget && this.state.lastFoundMedia) return this.state.lastFoundMedia;

        // 🚀 核心改进 2：高速无 Reflow 检索。使用 elementsFromPoint 代替对所有可见元素的全量遍历与坐标碰撞检测
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
                        // 🚀 核心重构：直接调用 MediaRenderer 的 renderHDImageDirect，不走 JS Heap Blob 管道
                        // 0 JS 堆开销，完全消除大图 Blob 产生的 GC 阻塞与内存压力
                        await this.render.renderHDImageDirect(hdUrl, savedSessionId);
                        
                        if (this.state.renderRequestId !== savedSessionId) return;

                        if (this.render.hdState.progressTimer) { 
                            clearInterval(this.render.hdState.progressTimer); 
                            this.render.hdState.progressTimer = null; 
                        }
                        this.render.hdState.progress = 100;
                        this.render.hdState.isLoading = false;
                        this._hdFetchController = null;

                        // 记录该高清原图已完全下载并解码就绪
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

        // 先执行 hideViewer 彻底终止并递增注销上一个 Session 会话锁
        this.hideViewer();

        const savedSessionId = ++this.state.renderRequestId;

        // 🌟 提前计算目标地址，防止在过滤预加载时误杀当前目标的网络流
        let initialSrc = target.src;
        let hdUrl = null;
        if (window.__mix01State.hdUrlMap && window.__mix01State.hdUrlMap[initialSrc]) {
            hdUrl = window.__mix01State.hdUrlMap[initialSrc];
        }

        // 🚀 核心自愈逻辑：检测该高清大图是否【已经完全下载成功过】（可能在之前完全看完，或后台预加载已完成）
        const loadedUrls = getLoadedHdUrls();
        let isAlreadyDownloaded = false;
        
        if (hdUrl && loadedUrls.has(hdUrl)) {
            // 只有当大图完全下载就绪时，才允许跳过低清占位，直接秒开大图！
            initialSrc = hdUrl;
            isAlreadyDownloaded = true;
        }

        if (this._preloadTimer) clearTimeout(this._preloadTimer);
        for (let img of this.activePreloads) this.imgPool.release(img);
        this.activePreloads.clear();
        this.render.clearBlobCache(); 
        
        // 🚀 性能自愈修复：清理旧预载时，排除当前目标地址 (target.src) 以及可能的高清地址 (initialSrc)
        // 这样如果目标图片正在后台被预载下载，我们不会将其掐断，而是让它继续完成，杜绝二次加载时的卡顿！
        if (this._preloadImgInstancesMap) {
            for (let [url, img] of this._preloadImgInstancesMap) {
                if (url !== target.src && url !== initialSrc) {
                    if (img && !img.complete) {
                        img.src = ''; // 仅掐断无关的高清下载
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
            this.state.isViewerVisible = true; // 🚀 更新显示状态
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
            this.state.isViewerVisible = true; // 🚀 更新显示状态
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

        // 🚀 基于大图实际就绪情况决定行内源
        this.state.currentHdUrl = isAlreadyDownloaded ? hdUrl : null;
        this.render.elements.img.src = initialSrc;
        this.state.isViewerVisible = true; // 🚀 更新显示状态
        
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
        if (!this.state.currentMedia) return; // 🌟 优化：不再依赖 cachedRect 缓存，只要 currentMedia 存在即可运行
        if (this.state.isRenderingLock) return;
        this.state.isRenderingLock = true;

        const sW = window.innerWidth;
        const sH = window.innerHeight;

        // 🚀 核心纠偏：实时读取图片当前在视口中的物理坐标。
        // 因为我们在该方法中只读不写，而是在稍后的 updateLayout 里才写样式，这遵循了完美的 Read-then-Write 渲染流，CPU 占用为 0ms，且完美免受网页微小滚动、动态加载排版变化的位置偏移污染
        const rect = this.state.currentMedia.getBoundingClientRect();
        this.state.cachedRect = rect; // 顺便刷新缓存

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

        // 🚀 核心优化 3：剔除双重 rAF。因为外部事件已经在 requestAnimationFrame 线程中执行，此处改为同步任务派发，物理延迟缩减 50% 以上，手感彻底消除粘滞感
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
        // 🚀 核心修复 1：关闭时强行递增 Session ID，作废当前会话所有未决的异步操作（如解码、未完成的 HD 加载等）
        this.state.renderRequestId++;
        this.state.isViewerVisible = false; // 🚀 重置状态

        // 🚀 核心修复 2：立即掐断当前正在传输的高清原图网络数据流，释放通道并杜绝带宽浪费
        if (this._hdFetchController) {
            this._hdFetchController.abort();
            this._hdFetchController = null;
        }

        this._killPhysicsLoop(); 
        this.render.hide();
        clearTimeout(this._cursorHideTimer);
        clearTimeout(this._hudIdleTimer); // 🚀 清理不活动隐藏计时器，防止产生悬空引用
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
        this.state.isViewerVisible = false; // 🚀 重置状态
        
        // 🚀 核心修复：沉浸模式改为站点隔离隔离保存
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
            // ✅ Bug修复：使用在 mousedown 时统一捕捉的 _clickStart，小图状态下也能完美检测位移并关闭
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
                
                // 排除视频封面/海报图的二次堆叠
                if (media.tagName === 'IMG') {
                    const src = media.src || '';
                    
                    // 🚀 优化点 1：基于 URL 静态元特征判定。即使页面上的 <video> 标签尚未被 React 挂载，也直接通过 URL 进行封杀（涵盖 Twitter/X 等核心源）
                    if (
                        src.includes('tweet_video_thumb') || 
                        src.includes('ext_tw_video_thumb') || 
                        src.includes('amplify_video_thumb') ||
                        src.includes('video-thumbnail') ||
                        src.includes('video_poster')
                    ) {
                        return false; 
                    }

                    // 🚀 优化点 2：基于 DOM 组件特有标签判定（如 Twitter 显式声明的视频容器组件）
                    if (
                        media.closest('[data-testid="videoPlayer"]') || 
                        media.closest('[class*="video-player"]')
                    ) {
                        return false; 
                    }

                    // 🚀 优化点 3：常规已初始化 DOM 的父子关系与兄弟关系判定（兜底）
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

    // 🚀 核心改进：结合 scrollend 弹性等待滚动结束
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

        // 800ms 硬件安全兜底锁，防止页面无法滚动时触发死锁
        const fallbackTimer = setTimeout(onScrollEnd, 800);

        window.addEventListener('scrollend', onScrollEnd, { once: true, passive: true });
        window.addEventListener('scroll', onScrollDebounce, { passive: true });

        this._cancelScrollWait = cleanUp;
    }

    performSwitch(nextImg, direction, msgText) {
        if (msgText) this.render.showToast(msgText);
        this.state.keyboardSwitchTime = Date.now();
        
        // 记录用户最后一次的流动方向，深度赋能双向预加载
        this.state.lastSwitchDirection = direction;

        // 🚀 核心优化：滚动发生前，即刻在最上层完成高清图的加载与排版
        this.triggerZoom(nextImg);

        // 底层页面静默对齐
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
                    // 🚀 核心修复：补齐此处遗漏的 lockedMedia 参数，使 getStates 能顺利定位 DOM 节点并回传 authorName
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

            // 🚀 核心优化：智能双向预测预加载。优先向主流动方向预加载 N_main 张，同时向反方向预加载 N_opp 张。
            const N = this.cfg.state.preloadCount;
            let mainDir = this.state.lastSwitchDirection || 1;
            if (!this.cfg.state.isImmersive && this._mouseVector.dy < -2) mainDir = -1; 

            const oppCount = Math.floor(N * 0.3); // 反向配额占总数的 30%（向下取整）
            const mainCount = N - oppCount;       // 主方向占其余全部，确保两者之和恒等于 N

            const preloadPlan = [];
            // 压入主路径配额
            for (let i = 1; i <= mainCount; i++) {
                preloadPlan.push(currentIndex + i * mainDir);
            }
            // 压入反路径配额
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

                            // 🚀 扩展优化 1：改用原生 Image 实例进行静默预载，避开部分 CDN 站点的 CORS 跨域审查限制
                            const preloadImg = new Image();
                            // 🚀 核心修复：预加载一旦在后台完全下载完毕（onload 触发），立刻标记为“已就绪”状态
                            preloadImg.onload = () => {
                                getLoadedHdUrls().add(targetUrl);
                            };
                            preloadImg.src = targetUrl;

                            this._preloadImgInstancesMap.set(targetUrl, preloadImg);

                            // 强引用实例数量上限设定为 50，防止长时间运行导致堆内存积压
                            if (this.preloadedUrlsQueue.length > 50) {
                                const oldest = this.preloadedUrlsQueue.shift();
                                this.preloadedUrls.delete(oldest);
                                this._preloadImgInstancesMap.delete(oldest); // 释放旧 Image 强引用，允许被正常 GC 垃圾回收
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
                
                // 🚀 核心修复：开启时也仅记录当前网站的沉浸状态偏好
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
                        this.exitImmersive(); // 🚀 统一退出的调用，防止偏好状态残留
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
                
                // 🚀 核心修复：将按 V 键切换的视图模式，作为站点独立偏好永久保存在 siteModes 中
                const host = window.location.hostname;
                if (host) {
                    this.cfg.siteModes[host] = nextMode;
                    this.cfg.save({ siteModes: this.cfg.siteModes });
                } else {
                    this.cfg.save({ mode: nextMode });
                }
                this.cfg.state.mode = nextMode; // 立即同步到配置管理器的内存状态中，使后续 hover 的图片直接生效

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

            // 🚀 核心优化 1：连连看高频按节流。防止物理按键触发频率过快，导致平滑滚动动画堆积、索引错位
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
            
            // 🚀 核心优化 2：解决虚拟滚动（Virtual Scroll）索引丢失 Bug。
            // 如果由于页面过长，React 自动移除了上方已读图片的 DOM 节点导致索引变为 -1，
            // 算法将自动通过页面几何数据，寻找当前最贴近网页屏幕物理中心的图片索引进行原地自愈，绝不回滚至页面最顶部（index 0）。
            if (currentIndex === -1) {
                let closestIdx = 0;
                let minDiff = Infinity;
                const centerY = window.innerHeight / 2; // 获取屏幕垂直中心线位置
                
                galleryImages.forEach((media, idx) => {
                    const rect = media.getBoundingClientRect();
                    const mediaCenterY = rect.top + rect.height / 2;
                    const diff = Math.abs(mediaCenterY - centerY);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = idx; // 锁定物理距离最近的在屏 DOM
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