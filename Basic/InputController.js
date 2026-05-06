// Basic/InputController.js
// 终极性能优化版：包含 SPA 缓存失效、DOM读写分离、预加载网络防抖、逃逸边界修复
window.Mix01InputController = class InputController {
    constructor(configManager, renderer) {
        this.cfg = configManager;
        this.render = renderer;
        this.state = {
            currentMedia: null, currentSrc: null, currentHdUrl: null, cachedRect: null,
            activeZoom: 2.0, isSmallOptimized: false, customLensWidth: null, customLensHeight: null,
            isZoomManuallyChanged: false, keyboardSwitchTime: 0, isTicking: false,
            bgClickCount: 0, bgClickTimer: null, lastTarget: null, lastFoundMedia: null,
            isRenderingLock: false,
            lastRenderX: null, lastRenderY: null, lastRenderZoom: null, lastRenderMediaSrc: null,
            _galleryCache: null,
            _galleryCacheDirty: true
        };
        this.preloadedUrls = new Set();
        this.preloadedUrlsQueue = [];
        this.compiledKeys = {}; 
        this._preloadTimer = null;   // 用于网络防抖
        this._resizeTimer = null;    // 沉浸模式 resize 防抖
        this._hoverDelayTimer = null; // ✨ 悬停延迟触发定时器
        this._cursorHideTimer = null; // ✨ 沉浸模式光标自动隐藏定时器
        // ✨ 放大镜拖拽状态
        this._drag = { active: false, startX: 0, startY: 0, origLeft: 0, origTop: 0 };

        this.mediaObserver = new MutationObserver((mutations) => {
            let newSrc = null;
            for (let m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'src' && m.target === this.state.currentMedia) {
                    if (this.state.currentMedia && this.state.currentMedia.src !== this.state.currentSrc) {
                        newSrc = this.state.currentMedia.src;
                        break; // 找到一个就够了
                    }
                }
            }
            if (newSrc) {
                this.state.currentSrc = newSrc;
                if (this.render.elements.img.src !== this.state.currentHdUrl) {
                    this.render.elements.img.src = newSrc;
                    this.render.elements.img.decode().catch(()=>{});
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
        
        document.addEventListener('wheel', (e) => {
            if (this.cfg.state.wheelZoomEnabled && this.render.elements.viewer.style.display === 'block') {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.15 : 0.15;
                this.state.activeZoom = Math.max(0.2, this.state.activeZoom + delta);
                this.state.isZoomManuallyChanged = true;
                this.updateRender(e);
                clearTimeout(this._wheelToastTimer);
                this._wheelToastTimer = setTimeout(() => {
                    this.render.showToast(`🔍 ${this.state.activeZoom.toFixed(1)}x`);
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

        // ✨ 沉浸模式点击视频画面切换播放/暂停
        this.render.elements.canvas.addEventListener('click', (e) => {
            if (this.cfg.state.isImmersive && this.state.currentMedia && this.state.currentMedia.tagName === 'VIDEO') {
                e.stopPropagation();
                if (window.__mix01UserPaused) {
                    window.__mix01UserPaused = false;
                    this.state.currentMedia.play().catch(() => {});
                } else {
                    window.__mix01UserPaused = true;
                    this.state.currentMedia.pause();
                }
                this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
            }
        });

        // ✨ 右键上下文菜单
        this.render.elements.viewer.addEventListener('contextmenu', (e) => {
            if (!this.cfg.state.hasAgreed) return;
            e.preventDefault();
            e.stopPropagation();
            this.render.showContextMenu(e.clientX, e.clientY, {
                'copy-img':     () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) window.Mix01Utils.copyImageToClipboard(u, this.render); },
                'copy-url':     () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) { navigator.clipboard.writeText(u).catch(() => {}); this.render.showToast('🔗 链接已复制'); } },
                'open-tab':     () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) { window.open(u, '_blank', 'noopener,noreferrer'); this.render.showToast('↗️ 已在新标签页打开'); } },
                'save':         () => { const u = this.state.currentHdUrl || this.render.elements.img.src; if (u) window.Mix01Utils.downloadImage(u, this.render); },
                'disable-site': () => { this._quickToggleSite(); },
                'close':        () => { this.cfg.state.isImmersive ? this.exitImmersive() : this.hideViewer(); },
            });
        });

        // ✨ 放大镜窗口拖拽（非沉浸模式下，按住 Alt 键可拖动查看器窗口固定位置）
        this.render.elements.viewer.addEventListener('mousedown', (e) => {
            if (this.cfg.state.isImmersive) return;
            if (!e.altKey) return;  // 必须按住 Alt 才触发拖拽，避免与正常鼠标交互冲突
            e.preventDefault();
            e.stopPropagation();
            const v = this.render.elements.viewer;
            const rect = v.getBoundingClientRect();
            this._drag.active  = true;
            this._drag.startX  = e.clientX;
            this._drag.startY  = e.clientY;
            this._drag.origLeft = rect.left;
            this._drag.origTop  = rect.top;
            v.style.setProperty('cursor', 'grabbing', 'important');
            // 拖拽时暂停自动跟随
            this.state.keyboardSwitchTime = Date.now() + 99999;
        });

        document.addEventListener('mousemove', (e) => {
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
            if (!this._drag.active) return;
            this._drag.active = false;
            this.render.elements.viewer.style.setProperty('cursor', 'default', 'important');
            // 松开后恢复正常跟随（重置 keyboardSwitchTime）
            this.state.keyboardSwitchTime = 0;
        }, { capture: true });
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
            // ✨ 光标自动隐藏：移动时显示，2 秒不动则隐藏
            this.render.elements.viewer.style.setProperty('cursor', 'default', 'important');
            clearTimeout(this._cursorHideTimer);
            this._cursorHideTimer = setTimeout(() => {
                this.render.elements.viewer.style.setProperty('cursor', 'none', 'important');
            }, 2000);

            this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
            this.updateRender(e);
            return;
        }

        // ✨ 非沉浸模式下：站点已禁用则确保 viewer 隐藏后返回
        if (!this.cfg.isSiteEnabled()) {
            if (this.render.elements.viewer.style.display === 'block') this.hideViewer();
            return;
        }

        const media = this.getMediaUnderCursor(e.clientX, e.clientY, e.target);
        if (media && (media !== this.state.currentMedia || (media.src||'video') !== this.state.currentSrc)) {
            if (Date.now() - this.state.keyboardSwitchTime < 500) return;
            // ✨ 放大镜过滤：鼠标快速划过时也检测
            if (!this.isMediaFiltered(media)) { this.triggerZoom(media); }
            return;
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
        // ✨ 站点级开关：该域名已被用户禁用则直接返回
        if (!this.cfg.isSiteEnabled()) return;

        const t = e.target;
        if ((t.tagName === 'IMG' || t.tagName === 'VIDEO') && (t.src || t.tagName === 'VIDEO')) {
            // ✨ 放大镜过滤：尺寸或选择器命中则跳过
            if (this.isMediaFiltered(t)) return;

            const delay = this.cfg.state.triggerDelay || 0;
            if (delay > 0) {
                // ✨ 悬停延迟：等待用户真正"停住"后再触发
                clearTimeout(this._hoverDelayTimer);
                this._hoverDelayTimer = setTimeout(() => this.triggerZoom(t), delay);
            } else {
                this.triggerZoom(t);
            }
        }
    }

    handleMouseOut(e) {
        // ✨ 取消尚未触发的悬停延迟
        clearTimeout(this._hoverDelayTimer);
        if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') return;
        if (e.target === this.state.currentMedia) {
            if (e.relatedTarget && this.state.currentMedia.contains(e.relatedTarget)) return;
            if (Date.now() - this.state.keyboardSwitchTime > 500) this.hideViewer();
        }
    }

    handleMouseLeave() {
        // ✨ 取消尚未触发的悬停延迟
        clearTimeout(this._hoverDelayTimer);
        if (this.cfg.state.isImmersive && this.render.elements.viewer.style.display === 'block') return;
        if (Date.now() - this.state.keyboardSwitchTime > 500) this.hideViewer();
    }

    async upgradeToHDQuietly(target, src) {
        if (this.cfg.state.loadHD !== 'true') return;
        try {
            if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                const hdUrl = await window.Mix01RuleEngine.getHighResUrl(target, src);
                if (hdUrl && hdUrl !== src && !this.render.hdState.badUrls.has(hdUrl)) {
                    
                    if (this.state.currentHdUrl === hdUrl) return; 
                    this.state.currentHdUrl = hdUrl;
                    window.__mix01HdUrlMap = window.__mix01HdUrlMap || {};
                    window.__mix01HdUrlMap[src] = hdUrl;

                    if (!this.render.elements.img.src || this.render.elements.img.src === '') {
                        this.render.setStyle(this.render.elements.spinner, 'display', 'block');
                    } else {
                        this.render.hdState.isLoading = true;
                        this.updateRender(); 
                    }

                    const tempImg = new Image();
                    tempImg.src = hdUrl;
                    
                    try {
                        await tempImg.decode(); 
                        
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
                    } catch (err) {
                        if (this.state.currentHdUrl === hdUrl) {
                            this.render.setStyle(this.render.elements.spinner, 'display', 'none');
                            this.render.hdState.isLoading = false;
                            this.updateRender(); 
                        }
                        this.render.hdState.badUrls.add(hdUrl); 
                    }
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
        
        // 【核心修复】：防止 Pixiv 等单页应用在不滚动页面的情况下切换 Tab，强制清除失效图库缓存
        this.state._galleryCacheDirty = true;
        
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
        this.render.setStyle(this.render.elements.img, 'max-width', 'none'); 
        this.render.setStyle(this.render.elements.img, 'max-height', 'none');

        this.render.setStyle(this.render.elements.img, 'opacity', '0');
        this.render.elements.img.src = target.src;
        this.render.elements.img.decode().then(() => {
            this.render.setStyle(this.render.elements.img, 'opacity', '1');
        }).catch(() => {
            this.render.setStyle(this.render.elements.img, 'opacity', '1');
        });

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
            // ✨ 更新沉浸模式计数器（延迟以等待 galleryCacheDirty 刷新）
            setTimeout(() => this._updateGalleryCounter(), 60);
        }
        
        this.triggerPreload();
    }

    updateRender(e = null) {
        if (!this.state.currentMedia || !this.state.cachedRect) return;
        if (this.state.isRenderingLock) return;
        this.state.isRenderingLock = true;

        // 【阶段一：纯读取 Phase (Read)】
        // 将引起重绘的所有读取操作分离在 rAF 之外，消除 Layout Thrashing
        const sW = window.innerWidth;
        const sH = window.innerHeight;
        const rect = this.state.cachedRect;
        const x = e ? e.clientX : (window.lastMouseX !== undefined ? window.lastMouseX : sW / 2);
        const y = e ? e.clientY : (window.lastMouseY !== undefined ? window.lastMouseY : sH / 2);
        
        let xP, yP;
        // 【核心修复】：沉浸模式下使用窗口坐标系；非沉浸模式使用元素坐标系
        if (this.cfg.state.isImmersive) {
            xP = x / sW;
            yP = y / sH;
        } else {
            xP = (x - rect.left) / (rect.width || 1);
            yP = (y - rect.top) / (rect.height || 1);
        }

        // 绝对边界锁（Clamp），防止意外溢出导致图片飞走
        xP = Math.max(0, Math.min(1, xP));
        yP = Math.max(0, Math.min(1, yP));

        const roundedX = Math.round(xP * 1000);
        const roundedY = Math.round(yP * 1000);
        const roundedZoom = Math.round(this.state.activeZoom * 1000);
        const mediaSrc = this.state.currentSrc || '';
        if (this.state.lastRenderMediaSrc === mediaSrc && this.state.lastRenderX === roundedX && this.state.lastRenderY === roundedY && this.state.lastRenderZoom === roundedZoom) {
            this.state.isRenderingLock = false;
            return;
        }
        this.state.lastRenderMediaSrc = mediaSrc;
        this.state.lastRenderX = roundedX;
        this.state.lastRenderY = roundedY;
        this.state.lastRenderZoom = roundedZoom;

        // 【阶段二：纯写入 Phase (Write)】
        requestAnimationFrame(() => {
            if (!this.state.currentMedia || !this.state.cachedRect) {
                this.state.isRenderingLock = false;
                return;
            }
            try {
                const isVideo = this.state.currentMedia.tagName === 'VIDEO';
                const activeMedia = isVideo ? this.render.elements.canvas : this.render.elements.img;
                
                // 将计算好的全量数据直接压入渲染管线
                this.state.activeZoom = this.render.updateLayout(
                    activeMedia, rect, this.state.activeZoom, xP, yP, 
                    this.state.isSmallOptimized, this.state.customLensWidth, this.state.customLensHeight, 
                    this.state.isZoomManuallyChanged, this.state.currentSrc, sW, sH
                );
            } catch (err) {
                console.warn("Mix01 Render Engine:", err);
            } finally {
                this.state.isRenderingLock = false;
            }
        });
    }

    hideViewer() {
        this.render.hide();
        clearTimeout(this._cursorHideTimer);
        this.mediaObserver.disconnect();
        if (this._resizeTimer) {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = null;
        }
        this.state.currentMedia = null;
        this.state.currentSrc = null;
        this.state.currentHdUrl = null; 
        this.state.cachedRect = null;
        this.state.isSmallOptimized = false;
        this.state.customLensWidth = null;
        this.state.customLensHeight = null;
        this.state.isZoomManuallyChanged = false;
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

    /**
     * ✨ 新增：判断媒体元素是否应被放大镜跳过
     * 过滤条件：(1) 元素尺寸小于 minZoomSize  (2) 匹配 excludeSelectors 中任意选择器
     * @param {HTMLElement} el
     * @returns {boolean} true = 应跳过
     */
    isMediaFiltered(el) {
        const minSize = this.cfg.state.minZoomSize || 0;
        if (minSize > 0) {
            const rect = el.getBoundingClientRect();
            // 宽或高任意一个 >= minZoomSize 即认为是有意义的内容图，不过滤
            if (rect.width < minSize && rect.height < minSize) return true;
        }

        const selectorStr = this.cfg.state.excludeSelectors || '';
        if (selectorStr.trim()) {
            // 编译并缓存选择器列表，避免每次 mouseover 都 split
            if (selectorStr !== this._lastExcludeSelectorStr) {
                this._lastExcludeSelectorStr = selectorStr;
                this._compiledExcludeSelectors = selectorStr.split(',')
                    .map(s => s.trim()).filter(Boolean);
            }
            for (const sel of (this._compiledExcludeSelectors || [])) {
                try { if (el.matches(sel)) return true; } catch (e) { /* 忽略非法选择器 */ }
            }
        }
        return false;
    }

    /**
     * ✨ 更新沉浸模式图库计数器（当前 / 总数）
     */
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
            return this.state._galleryCache;
        }

        const adapter = window.Mix01Utils.getImmersiveAdapter();
        let result = [];
        if (adapter && adapter.getGalleryImages) {
            result = adapter.getGalleryImages();
        } else {
            result = Array.from(document.querySelectorAll('img, video')).filter(media => {
                if (media.id === 'zoom-img-xyz' || media.id === 'zoom-canvas-xyz') return false;
                const rect = media.getBoundingClientRect();
                return rect.width > 50 && rect.height > 50; 
            });
        }
        
        this.state._galleryCache = result;
        this.state._galleryCacheDirty = false;
        return result;
    }

    /**
     * ✨ 快速切换当前站点引擎开关（右键菜单 & 快捷键均调用此方法）
     */
    _quickToggleSite() {
        const host = window.location.hostname;
        if (!host) return;
        if (this.cfg.disabledSites[host]) {
            delete this.cfg.disabledSites[host];
        } else {
            this.cfg.disabledSites[host] = true;
            // 禁用时立即关闭当前预览
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
                // ✨ 更新计数器
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

    triggerPreload() {
        if (!this.cfg.state.isImmersive || this.cfg.state.preloadCount <= 0 || !this.state.currentMedia) return;

        // 【核心优化】：如果正在预加载倒计时，取消它（斩断快速切换时的请求风暴）
        if (this._preloadTimer) clearTimeout(this._preloadTimer);

        // 延迟 300ms，确认用户真实驻留再启动预加载
        this._preloadTimer = setTimeout(() => {
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
        }, 300);
    }

    handleKeyDown(e) {
        if (!this.cfg.state.hasAgreed) return;
        // ✨ 站点级开关：该站点已禁用则所有快捷键均不响应
        if (!this.cfg.isSiteEnabled()) return;
        const k = e.key.toLowerCase(); let up = false;
        const modeList = ['partial', 'full-follow', 'full-center'];
        const modeNames = { 'partial': '🔍 局部放大', 'full-follow': '🖼️ 整体跟随', 'full-center': '📐 智能避让' };
        
        // ✨ Ctrl+Shift+X：快速禁用/启用当前站点（无需打开设置页）
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

        // ✨ 沉浸模式下按任意键唤醒 HUD 提示栏
        if (this.cfg.state.isImmersive) {
            this.render.handleImmersiveActivity(this.state.currentMedia, this.state.currentSrc, this.cfg.keys);
        }

        if (this.matchCombo(e, this.cfg.keys.playVideo || 'space') || e.code === 'Space') {
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

        // ✨ 新增：在新标签页打开原图 / 高清图
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

        if (k === this.cfg.keys.rotate) { this.cfg.state.rotate = (this.cfg.state.rotate + 90) % 360; up = true; } 
        else if (k === this.cfg.keys.mirror) { this.cfg.state.mirror *= -1; up = true; } 
        else if (k === this.cfg.keys.mode) { 
            if (this.cfg.state.isImmersive) {
                this.render.showToast(`⚠️ 请双击背景或按 ${(this.cfg.keys.immersive || 'Esc').toUpperCase()} 退出沉浸模式`);
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
        
        else if (e.key === 'Escape') {
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
                        this.state._galleryCacheDirty = true;
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
                        this.state._galleryCacheDirty = true;
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