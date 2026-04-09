(function () {
    if (window.__imgZoomProInitialized) return;
    window.__imgZoomProInitialized = true;

    let config = { 
        hasAgreed: false, loadHD: 'true', breakoutView: false, 
        showStatus: true, smallImageOptimization: true, 
        zoom: 2.0, rotate: 0, mirror: 1, mode: 'partial',
        isImmersive: false
    };
    
    let activeZoom = 2.0; 
    let keys = { mode: 'v', rotate: 'r', mirror: 'm', zoomIn: '=', zoomOut: '-', immersive: 'ctrl+f12', like: 'l', follow: 'f' };
    let currentHoveredImg = null;
    let currentHoveredSrc = null; 
    let cachedRect = null; 
    let loadingTask = null;
    let rAF_ID = null; 

    let isSmallImageOptimized = false;
    let customLensWidth = null;
    let customLensHeight = null;
    let isZoomManuallyChanged = false;
    let keyboardSwitchTime = 0; 
    let hideCursorTimer = null;
    let hintFadeTimer = null;
    let bgClickCount = 0;
    let bgClickTimer = null;

    const modeList = ['partial', 'full-follow', 'full-center'];
    const modeNames = { 'partial': '🔍 局部放大', 'full-follow': '🖼️ 整体跟随', 'full-center': '📐 智能避让' };
    const badHdUrls = new Set();

    const isContextValid = () => !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

    // ==========================================
    // 🔥 幽灵点击引擎 2.0：支持状态嗅探与自动处理弹窗
    // ==========================================
    const actionAdapters = {
        'twitter_x': {
            match: /(twitter\.com|x\.com)/,
            getContainer: (img) => img.closest('article') || document.body,
            getStates: (container) => {
                const isLiked = !!container.querySelector('[data-testid="unlike"]');
                const isFollowed = !!document.querySelector('[data-testid$="-unfollow"]');
                return { isLiked, isFollowed };
            },
            like: async (container) => {
                const btn = container.querySelector('[data-testid="like"], [data-testid="unlike"]');
                if (btn) { btn.click(); return true; }
                return false;
            },
            follow: async (container) => {
                const unfollowBtn = document.querySelector('[data-testid$="-unfollow"]');
                const followBtn = document.querySelector('[data-testid$="-follow"]');
                
                if (unfollowBtn) {
                    unfollowBtn.click(); // 触发取消关注
                    
                    // 【核心魔法】：等待 Twitter 的二次确认弹窗出现，并自动将其击杀
                    await new Promise(resolve => setTimeout(resolve, 150));
                    
                    const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
                    if (confirmBtn) {
                        confirmBtn.click();
                    } else {
                        // 兜底方案：寻找对话框中的取消按钮
                        const dialog = document.querySelector('[role="dialog"], [data-testid="mask"]');
                        if (dialog) {
                            const btns = Array.from(dialog.querySelectorAll('[role="button"]'));
                            const target = btns.find(b => /Unfollow|取消关注/i.test(b.textContent));
                            if (target) target.click();
                        }
                    }
                    return true;
                } else if (followBtn) {
                    followBtn.click(); // 触发关注
                    return true;
                }
                return false;
            }
        },
        'pixiv': {
            match: /pixiv\.net/,
            getContainer: (img) => document.body,
            getStates: (container) => {
                // Pixiv 状态嗅探 (尽量读取 aria 属性或高亮颜色)
                const likeBtn = container.querySelector('.gtm-main-bookmark, [data-click-action="like"], [data-click-label="like"] button, button svg path[d*="M12"]')?.closest('button');
                let isLiked = false;
                if (likeBtn) {
                    isLiked = likeBtn.innerHTML.includes('rgb(255, 64, 96)') || 
                              likeBtn.innerHTML.includes('#FF4060') || 
                              likeBtn.getAttribute('aria-pressed') === 'true';
                }
                const followBtn = container.querySelector('.gtm-main-follow, [data-click-action="follow"], [data-click-label="follow"]');
                let isFollowed = false;
                if (followBtn) {
                    isFollowed = /已关注|Following/i.test(followBtn.textContent) || followBtn.dataset.clickAction === 'unfollow' || followBtn.getAttribute('aria-pressed') === 'true';
                }
                return { isLiked, isFollowed };
            },
            like: async (container) => {
                const btn = container.querySelector('.gtm-main-bookmark, [data-click-action="like"], [data-click-label="like"] button, button svg path[d*="M12"]')?.closest('button');
                if (btn) { btn.click(); return true; }
                return false;
            },
            follow: async (container) => {
                const btn = container.querySelector('.gtm-main-follow, [data-click-action="follow"], [data-click-label="follow"]');
                if (btn) { btn.click(); return true; }
                return false;
            }
        }
    };

    async function executePhantomAction(actionType) {
        if (!currentHoveredImg) return;
        const host = window.location.hostname;
        let adapter = null;
        for (let key in actionAdapters) {
            if (actionAdapters[key].match.test(host)) { adapter = actionAdapters[key]; break; }
        }
        
        if (!adapter) {
            showToast("⚠️ 该网站暂不支持快捷交互");
            return;
        }

        const container = adapter.getContainer(currentHoveredImg) || document.body;
        const initialStates = adapter.getStates(container);
        let success = false;

        if (actionType === 'like') {
            success = await adapter.like(container);
            if (success) showToast(initialStates.isLiked ? "🤍 已取消喜欢" : "❤️ 已喜欢");
        } else {
            success = await adapter.follow(container);
            if (success) showToast(initialStates.isFollowed ? "👋 已取消关注" : "🫂 已成功关注");
        }

        if (!success) {
            showToast("❌ 未找到对应的操作按钮");
        } else {
            // 动作执行完毕后，延迟 300 毫秒重新读取 DOM，刷新底部 HUD 状态
            setTimeout(updateImmersiveHUD, 300);
        }
    }
    // ==========================================

    const syncConfig = (res) => {
        if (!res) return;
        if (res.hasAgreed !== undefined) config.hasAgreed = res.hasAgreed;
        if (res.loadHD !== undefined) config.loadHD = res.loadHD;
        if (res.breakoutView !== undefined) config.breakoutView = res.breakoutView;
        if (res.showStatus !== undefined) config.showStatus = res.showStatus;
        if (res.smallImageOptimization !== undefined) config.smallImageOptimization = res.smallImageOptimization;
        if (res.isImmersive !== undefined) config.isImmersive = res.isImmersive;
        if (res.mode !== undefined) config.mode = res.mode;
        if (res.zoomLevel !== undefined) config.zoom = parseFloat(res.zoomLevel);
        
        Object.keys(keys).forEach(k => {
            let storageKey = 'key' + k.charAt(0).toUpperCase() + k.slice(1);
            if (res[storageKey]) keys[k] = res[storageKey];
        });
        
        updateImmersiveHUD();
    };

    if (isContextValid()) {
        chrome.storage.local.get(null, syncConfig);
        chrome.storage.onChanged.addListener((changes) => {
            if (!isContextValid()) return;
            let newVals = {};
            for (let key in changes) { newVals[key] = changes[key].newValue; }
            syncConfig(newVals);
        });
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        const getUrlAndProcess = async (actionFn) => {
            const src = request.clickedUrl || zoomImg.src;
            const targetEl = request.clickedUrl ? (currentHoveredSrc === request.clickedUrl ? currentHoveredImg : document.createElement('img')) : zoomImg;
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
            getUrlAndProcess(url => { copyImageToClipboard(url); sendResponse({ status: "ok" }); });
            return true;
        } else if (request.action === "saveHDUrl") {
            getUrlAndProcess(url => { downloadImage(url); sendResponse({ status: "ok" }); });
            return true;
        }
    });

    async function copyImageToClipboard(url) {
        showToast("⏳ 正在获取并处理原图...");
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
                        showToast("✅ 已成功复制原图到剪切板！");
                    } catch (err) { showToast("❌ 写入失败，请确保页面保持聚焦"); }
                    URL.revokeObjectURL(blobUrl);
                }, 'image/png');
            };
            img.onerror = () => { showToast("❌ 图片渲染解析失败"); URL.revokeObjectURL(blobUrl); };
            img.src = blobUrl;
        } catch (err) { showToast("❌ 获取图片失败，可能存在跨域限制"); }
    }

    async function fetchAsBase64(url) {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    async function downloadImage(url) {
        showToast("⏳ 正在解析并打包原图...");
        try {
            const b64 = await fetchAsBase64(url);
            chrome.runtime.sendMessage({ action: "downloadImmersiveImg", url: url, dataUrl: b64 }, (response) => {
                if (chrome.runtime.lastError) {
                    window.open(url, '_blank');
                    showToast("⚠️ 扩展通信失败，已在新标签页打开");
                } else {
                    showToast("✅ 已成功保存至 IMG_Download 文件夹！");
                }
            });
        } catch (e) {
            window.open(url, '_blank');
            showToast("⚠️ 跨域安全拦截，已在新标签页打开原图");
        }
    }

    const viewer = document.createElement('div'); viewer.id = 'img-zoom-pro-viewer-xyz';
    const zoomImg = document.createElement('img'); zoomImg.id = 'zoom-img-xyz';
    const statusLabel = document.createElement('div'); statusLabel.id = 'img-zoom-pro-status-label';
    const toast = document.createElement('div'); toast.className = 'img-zoom-toast-xyz';
    const noticeBox = document.createElement('div'); noticeBox.className = 'notice-container-xyz';
    noticeBox.innerHTML = '⚠️ 未同意协议<br>请点击右上角图标同意并开启功能';
    
    const styleBlock = document.createElement('style');
    styleBlock.innerHTML = `
        .kbd-btn { background:rgba(255,255,255,0.2); padding:2px 6px; border-radius:4px; font-family: monospace; font-weight: bold; margin: 0 2px;}
    `;
    document.head.appendChild(styleBlock);

    const immersiveHint = document.createElement('div'); 
    immersiveHint.id = 'img-zoom-pro-immersive-hint';

    const initViewer = () => {
        if (!document.body) { setTimeout(initViewer, 100); return; }
        
        Object.assign(immersiveHint.style, {
            position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)',
            color: 'rgba(255,255,255,0.9)', background: 'rgba(20,20,20,0.8)', padding: '12px 28px',
            borderRadius: '30px', fontSize: '14px', fontFamily: 'system-ui, sans-serif',
            pointerEvents: 'none', transition: 'opacity 0.6s ease', zIndex: '2147483647',
            display: 'none', opacity: '0', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', whiteSpace: 'nowrap'
        });

        viewer.appendChild(zoomImg); viewer.appendChild(statusLabel); viewer.appendChild(noticeBox); viewer.appendChild(immersiveHint);
        document.body.appendChild(viewer); document.body.appendChild(toast);
    };
    initViewer();

    // 【新增】统一更新 HUD 状态的引擎
    function updateImmersiveHUD() {
        if (!config.isImmersive) return;
        
        let likeText = "喜欢"; let likeIcon = "🤍";
        let followText = "关注"; let followIcon = "👤";

        if (currentHoveredImg) {
            const host = window.location.hostname;
            let adapter = null;
            for (let key in actionAdapters) {
                if (actionAdapters[key].match.test(host)) { adapter = actionAdapters[key]; break; }
            }
            if (adapter) {
                const container = adapter.getContainer(currentHoveredImg) || document.body;
                const states = adapter.getStates(container);
                if (states.isLiked !== null) {
                    likeText = states.isLiked ? "已喜欢" : "未喜欢";
                    likeIcon = states.isLiked ? "❤️" : "🤍";
                }
                if (states.isFollowed !== null) {
                    followText = states.isFollowed ? "已关注" : "未关注";
                    followIcon = states.isFollowed ? "🫂" : "👤";
                }
            }
        }

        const hintKbdLike = (keys.like || 'l').toUpperCase();
        const hintKbdFollow = (keys.follow || 'f').toUpperCase();
        
        immersiveHint.innerHTML = `⌨️ 左右切换 &nbsp;|&nbsp; 💾 下载(<kbd class="kbd-btn">S</kbd>) &nbsp;|&nbsp; ${likeIcon} ${likeText}(<kbd class="kbd-btn">${hintKbdLike}</kbd>) &nbsp;&nbsp; ${followIcon} ${followText}(<kbd class="kbd-btn">${hintKbdFollow}</kbd>) &nbsp;|&nbsp; ❌ 双击退出`;
    }

    function setStyle(el, prop, val) { el.style.setProperty(prop, val, 'important'); }
    
    function handleImmersiveActivity() {
        if (!config.isImmersive || viewer.style.display !== 'block') return;
        
        updateImmersiveHUD(); // 唤醒时实时更新状态
        
        setStyle(viewer, 'cursor', 'default');
        setStyle(zoomImg, 'cursor', 'default');
        setStyle(immersiveHint, 'display', 'block');
        void immersiveHint.offsetWidth; 
        setStyle(immersiveHint, 'opacity', '1');

        clearTimeout(hideCursorTimer);
        clearTimeout(hintFadeTimer);

        hideCursorTimer = setTimeout(() => {
            setStyle(viewer, 'cursor', 'none');
            setStyle(zoomImg, 'cursor', 'none');
        }, 1500);

        hintFadeTimer = setTimeout(() => {
            setStyle(immersiveHint, 'opacity', '0');
        }, 3000); 
    }

    function exitImmersiveMode() {
        config.isImmersive = false;
        if (isContextValid()) chrome.storage.local.set({ isImmersive: false }); 
        showToast('❎ 已退出沉浸图库模式');
        hideViewer();
    }

    function hideViewer() {
        setStyle(viewer, 'display', 'none');
        currentHoveredImg = null;
        currentHoveredSrc = null;
        cachedRect = null; 
        loadingTask = null;
        isSmallImageOptimized = false;
        customLensWidth = null;
        customLensHeight = null;
        isZoomManuallyChanged = false;
        window.isFetchingMore = false; 
        
        clearTimeout(hideCursorTimer);
        clearTimeout(hintFadeTimer);
        setStyle(immersiveHint, 'opacity', '0');
        setStyle(viewer, 'cursor', 'default');
        setStyle(zoomImg, 'cursor', 'default');
        setStyle(viewer, 'pointer-events', 'none'); 

        if (rAF_ID) cancelAnimationFrame(rAF_ID);
    }

    viewer.addEventListener('click', (e) => {
        if (e.target === viewer) {
            if (config.isImmersive) {
                bgClickCount++;
                if (bgClickCount === 1) {
                    showToast("⚠️ 请再点一次或双击退出");
                    bgClickTimer = setTimeout(() => { bgClickCount = 0; }, 1000); 
                } else if (bgClickCount >= 2) {
                    clearTimeout(bgClickTimer);
                    bgClickCount = 0;
                    exitImmersiveMode();
                }
            } else {
                hideViewer();
            }
        }
    });

    viewer.addEventListener('dblclick', (e) => {
        if (config.isImmersive && e.target === viewer) {
            clearTimeout(bgClickTimer);
            bgClickCount = 0;
            exitImmersiveMode();
        }
    });

    function showToast(text) {
        clearTimeout(window.zoomToastTimer);
        toast.innerText = text; toast.classList.add('show');
        window.zoomToastTimer = setTimeout(() => { toast.classList.remove('show'); }, 1200);
    }

    function updateStatus(type, currentW, currentH) {
        if (!config.showStatus || (currentW < 300 || currentH < 200)) { setStyle(statusLabel, 'display', 'none'); return; }
        setStyle(statusLabel, 'display', 'block');
        statusLabel.innerText = type === 'hd' ? '高清图放大' : '原图放大';
        statusLabel.className = type === 'hd' ? 'status-hd' : 'status-original';
    }

    function getImgUnderCursor(clientX, clientY, target) {
        if (target && target.tagName === 'IMG' && target.src) return target;
        const elements = document.elementsFromPoint(clientX, clientY);
        if (!elements) return null;
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (el.id === 'img-zoom-pro-viewer-xyz' || el.id === 'zoom-img-xyz') continue;
            if (el.tagName === 'IMG' && el.src) return el;
        }
        return null;
    }

    async function triggerZoom(target) {
        if (target === currentHoveredImg && target.src === currentHoveredSrc) return;
        hideViewer(); 

        currentHoveredImg = target;
        currentHoveredSrc = target.src;
        cachedRect = target.getBoundingClientRect(); 
        
        isSmallImageOptimized = false;
        customLensWidth = null;
        customLensHeight = null;
        isZoomManuallyChanged = false;

        if (config.hasAgreed) {
            setStyle(noticeBox, 'display', 'none');
            setStyle(zoomImg, 'display', 'block');
            zoomImg.src = target.src;
            setStyle(zoomImg, 'max-width', 'none'); 
            setStyle(zoomImg, 'max-height', 'none');

            if (config.smallImageOptimization) {
                if (cachedRect.width <= 50 && cachedRect.height <= 50) { activeZoom = 9.0; isSmallImageOptimized = true; }
                else if (cachedRect.width <= 100 && cachedRect.height <= 100) { activeZoom = 6.0; isSmallImageOptimized = true; }
                else { activeZoom = config.zoom; }
            } else {
                activeZoom = config.zoom;
            }

            renderViewer(null, cachedRect); 

            if (config.loadHD === 'true') {
                const myTask = target.src; 
                loadingTask = myTask;

                try {
                    if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                        const hdUrl = await window.Mix01RuleEngine.getHighResUrl(target, target.src);
                        if (hdUrl && hdUrl !== target.src && !badHdUrls.has(hdUrl)) {
                            const tempImg = new Image();
                            tempImg.onload = () => { 
                                if (loadingTask === myTask && currentHoveredImg === target) {
                                    if (!config.isImmersive && config.mode === 'partial' && isSmallImageOptimized && !isZoomManuallyChanged) {
                                        const nw = tempImg.naturalWidth, nh = tempImg.naturalHeight;
                                        if (nw > 350 || nh > 350) {
                                            customLensWidth = Math.min(nw, window.innerWidth * 0.9);
                                            customLensHeight = Math.min(nh, window.innerHeight * 0.9);
                                            activeZoom = nw / (cachedRect.width || 1);
                                        }
                                    }
                                    zoomImg.src = hdUrl; 
                                    renderViewer(null, cachedRect); 
                                }
                            };
                            tempImg.onerror = () => badHdUrls.add(hdUrl);
                            tempImg.src = hdUrl;
                        }
                    }
                } catch (error) { console.warn('Mix01 Engine 解析失败:', error); }
            }
        } else { 
            setStyle(zoomImg, 'display', 'none'); setStyle(statusLabel, 'display', 'none'); setStyle(noticeBox, 'display', 'block'); 
        }
        setStyle(viewer, 'display', 'block');
        
        if (config.isImmersive) handleImmersiveActivity();
    }

    document.addEventListener('mouseover', (e) => {
        if (config.isImmersive && viewer.style.display === 'block') return; 
        const img = getImgUnderCursor(e.clientX, e.clientY, e.target);
        if (img) triggerZoom(img);
    }, true); 

    document.addEventListener('mousemove', (e) => {
        window.lastMouseX = e.clientX; window.lastMouseY = e.clientY;

        if (config.isImmersive && viewer.style.display === 'block') {
            handleImmersiveActivity();
            if (rAF_ID) cancelAnimationFrame(rAF_ID);
            if (cachedRect) rAF_ID = requestAnimationFrame(() => renderViewer(e, cachedRect));
            return; 
        }

        const img = getImgUnderCursor(e.clientX, e.clientY, e.target);
        if (img && (img !== currentHoveredImg || img.src !== currentHoveredSrc)) {
            if (Date.now() - keyboardSwitchTime < 500) return;
            triggerZoom(img); return;
        }

        if (currentHoveredImg && viewer.style.display === 'block' && cachedRect) {
            if (img === currentHoveredImg) cachedRect = currentHoveredImg.getBoundingClientRect();
            else {
                if (Date.now() - keyboardSwitchTime > 500) {
                    if (e.clientX < cachedRect.left || e.clientX > cachedRect.right || 
                        e.clientY < cachedRect.top || e.clientY > cachedRect.bottom) {
                        hideViewer(); return;
                    }
                }
            }
            if (rAF_ID) cancelAnimationFrame(rAF_ID);
            rAF_ID = requestAnimationFrame(() => renderViewer(e, cachedRect));
        }
    }, true);

    document.addEventListener('mouseout', (e) => { 
        if (config.isImmersive && viewer.style.display === 'block') return; 
        if (e.target === currentHoveredImg) {
            if (e.relatedTarget && currentHoveredImg.contains(e.relatedTarget)) return;
            if (Date.now() - keyboardSwitchTime > 500) hideViewer(); 
        }
    }, true);

    document.addEventListener('mouseleave', () => {
        if (config.isImmersive && viewer.style.display === 'block') return;
        if (Date.now() - keyboardSwitchTime > 500) hideViewer();
    }, true);

    function renderViewer(e = null, rect = null) {
        if (!currentHoveredImg) return;
        rect = rect || currentHoveredImg.getBoundingClientRect();
        
        const clientX = e ? e.clientX : window.lastMouseX;
        const clientY = e ? e.clientY : window.lastMouseY;
        const xP = (clientX - rect.left) / (rect.width || 1);
        const yP = (clientY - rect.top) / (rect.height || 1);
        
        viewer.className = `mode-${config.mode}`;
        const sW = window.innerWidth, sH = window.innerHeight;
        let cDW = 0, cDH = 0;

        const nw = zoomImg.naturalWidth || rect.width || 1;
        const nh = zoomImg.naturalHeight || rect.height || 1;
        const naturalRatio = nw / nh;

        if (config.isImmersive) {
            setStyle(viewer, 'display', 'block');
            setStyle(viewer, 'position', 'fixed');
            setStyle(viewer, 'width', '100vw');
            setStyle(viewer, 'height', '100vh');
            setStyle(viewer, 'left', '0');
            setStyle(viewer, 'top', '0');
            setStyle(viewer, 'background-color', 'rgba(0, 0, 0, 0.95)'); 
            setStyle(viewer, 'background-image', 'none');
            setStyle(viewer, 'border', 'none'); 
            setStyle(viewer, 'border-radius', '0');
            setStyle(viewer, 'transform', 'none');
            setStyle(viewer, 'pointer-events', 'auto'); 
            
            if (!isZoomManuallyChanged) {
                const maxW = sW * 0.95, maxH = sH * 0.95;
                let fitW = nw, fitH = nh;
                
                if (fitW > maxW) { fitW = maxW; fitH = fitW / naturalRatio; }
                if (fitH > maxH) { fitH = maxH; fitW = fitH * naturalRatio; }
                
                activeZoom = fitW / nw; 
            }
            
            let tW = nw * activeZoom, tH = nh * activeZoom;
            cDW = tW; cDH = tH;
            
            setStyle(zoomImg, 'position', 'absolute');
            setStyle(zoomImg, 'width', `${tW}px`); setStyle(zoomImg, 'height', `${tH}px`);
            
            if (isZoomManuallyChanged && (tW > sW || tH > sH)) {
                setStyle(zoomImg, 'left', `${(tW > sW) ? -(tW - sW) * (clientX / sW) : (sW - tW) / 2}px`); 
                setStyle(zoomImg, 'top', `${(tH > sH) ? -(tH - sH) * (clientY / sH) : (sH - tH) / 2}px`);
            } else {
                setStyle(zoomImg, 'left', `${(sW - tW) / 2}px`);
                setStyle(zoomImg, 'top', `${(sH - tH) / 2}px`);
            }
            setStyle(zoomImg, 'margin', '0');
        } 
        else if (config.mode === 'partial') {
            setStyle(viewer, 'display', 'block'); setStyle(viewer, 'position', 'fixed'); setStyle(viewer, 'overflow', 'hidden'); 
            
            if (config.hasAgreed) {
                cDW = rect.width * activeZoom; cDH = rect.height * activeZoom;
                setStyle(zoomImg, 'width', cDW + 'px'); setStyle(zoomImg, 'height', cDH + 'px');
                setStyle(zoomImg, 'position', 'absolute'); 

                let lensW, lensH;
                if (isSmallImageOptimized && customLensWidth && customLensHeight) {
                    lensW = customLensWidth; lensH = customLensHeight;
                } else {
                    lensW = Math.min(350, Math.max(100, cDW + 20)); lensH = Math.min(350, Math.max(100, cDH + 20));
                }

                setStyle(viewer, 'width', lensW + 'px'); setStyle(viewer, 'height', lensH + 'px');
                let vX = clientX + 20, vY = clientY + 20;
                if (vX + lensW > sW) vX = clientX - lensW - 20;
                if (vY + lensH > sH) vY = clientY - lensH - 20;
                setStyle(viewer, 'left', `${vX}px`); setStyle(viewer, 'top', `${vY}px`);
                setStyle(viewer, 'transform', 'none');

                if (cDW < 350 && cDH < 350 && !customLensWidth) {
                    setStyle(viewer, 'border', '1px solid rgba(255, 255, 255, 0.2)'); 
                    setStyle(viewer, 'background-image', 'radial-gradient(circle, rgba(20,20,20,1) 0%, rgba(0,0,0,1) 100%)'); 
                    setStyle(viewer, 'background-color', '#000'); 
                } else {
                    setStyle(viewer, 'background-image', 'none'); setStyle(viewer, 'background-color', 'transparent'); 
                    setStyle(viewer, 'border', '1px solid rgba(255, 255, 255, 0.4)'); 
                }

                setStyle(zoomImg, 'right', 'auto'); setStyle(zoomImg, 'bottom', 'auto'); setStyle(zoomImg, 'margin', '0');
                let offsetX = 0, offsetY = 0;
                if (cDW > lensW) offsetX = -(cDW * xP - lensW / 2); else offsetX = (lensW - cDW) / 2;
                if (cDH > lensH) offsetY = -(cDH * yP - lensH / 2); else offsetY = (lensH - cDH) / 2;
                setStyle(zoomImg, 'left', offsetX + 'px'); setStyle(zoomImg, 'top', offsetY + 'px');
            }
        } else {
            setStyle(viewer, 'display', 'block'); setStyle(viewer, 'position', 'fixed');
            setStyle(viewer, 'background-color', 'rgba(20, 20, 20, 0.9)'); setStyle(viewer, 'background-image', 'none');
            setStyle(zoomImg, 'position', 'absolute'); setStyle(zoomImg, 'right', 'auto'); setStyle(zoomImg, 'bottom', 'auto'); setStyle(zoomImg, 'margin', '0');

            let tW = rect.width * activeZoom, tH = rect.height * activeZoom;
            const maxVW = sW * (config.mode === 'full-follow' ? 0.7 : 0.95);
            const maxVH = sH * (config.mode === 'full-follow' ? 0.7 : 0.95);
            
            if (!config.breakoutView || !config.hasAgreed) {
                const safeMaxVW = maxVW - 10; const safeMaxVH = maxVH - 10;
                const ratio = (rect.width / rect.height) || 1;
                if (tW > safeMaxVW) { tW = safeMaxVW; tH = tW / ratio; }
                if (tH > safeMaxVH) { tH = safeMaxVH; tW = tH * ratio; }
                cDW = tW; cDH = tH;
                setStyle(viewer, 'width', `${tW}px`); setStyle(viewer, 'height', `${tH}px`);
                if (config.hasAgreed) {
                    setStyle(zoomImg, 'width', '100%'); setStyle(zoomImg, 'height', '100%');
                    setStyle(zoomImg, 'left', '0'); setStyle(zoomImg, 'top', '0');
                }
            } else {
                const vW = Math.min(tW, maxVW), vH = Math.min(tH, maxVH);
                cDW = vW; cDH = vH;
                setStyle(viewer, 'width', `${vW}px`); setStyle(viewer, 'height', `${vH}px`);
                setStyle(zoomImg, 'width', `${tW}px`); setStyle(zoomImg, 'height', `${tH}px`);
                setStyle(zoomImg, 'left', `${(tW > vW) ? -(tW - vW) * xP : 0}px`); setStyle(zoomImg, 'top', `${(tH > vH) ? -(tH - vH) * yP : 0}px`);
            }

            if (config.mode === 'full-follow') {
                setStyle(viewer, 'transform', 'none');
                let vX = clientX + 25, vY = clientY + 25;
                if (vX + cDW > sW) vX = clientX - cDW - 20;
                if (vY + cDH > sH) vY = clientY - cDH - 20;
                setStyle(viewer, 'left', `${vX}px`); setStyle(viewer, 'top', `${vY}px`);
            } else {
                setStyle(viewer, 'transform', 'none'); 
                const margin = 30; let vX, vY;
                if (clientX < sW / 2) vX = sW - cDW - margin; else vX = margin; 
                vY = clientY - (cDH / 2);
                if (vY < margin) vY = margin;
                if (vY + cDH > sH - margin) vY = sH - cDH - margin;
                setStyle(viewer, 'left', `${vX}px`); setStyle(viewer, 'top', `${vY}px`);
            }
        }
        updateStatus(zoomImg.src !== currentHoveredImg.src ? 'hd' : 'original', cDW, cDH);
        if (config.hasAgreed) setStyle(zoomImg, 'transform', `scaleX(${config.mirror}) rotate(${config.rotate}deg)`);
    }

    function matchCombo(e, comboStr) {
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

    function getGalleryImages() {
        return Array.from(document.querySelectorAll('img')).filter(img => {
            if (img.id === 'zoom-img-xyz') return false;
            const rect = img.getBoundingClientRect();
            return rect.width > 50 && rect.height > 50 && window.getComputedStyle(img).display !== 'none';
        });
    }

    function performSwitch(nextImg, msgText) {
        if (msgText) showToast(msgText);
        keyboardSwitchTime = Date.now();
        nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        triggerZoom(nextImg);

        setTimeout(() => {
            if (currentHoveredImg === nextImg) {
                const newRect = nextImg.getBoundingClientRect();
                window.lastMouseX = newRect.left + newRect.width / 2;
                window.lastMouseY = newRect.top + newRect.height / 2;
                renderViewer(null, newRect);
                handleImmersiveActivity(); 
            }
        }, 50); 
    }

    document.addEventListener('keydown', (e) => {
        if (!config.hasAgreed) return;
        const k = e.key.toLowerCase(); let up = false;
        const save = (d) => { if (isContextValid()) chrome.storage.local.set(d); };
        
        if (matchCombo(e, keys.immersive)) {
            e.preventDefault();
            if (config.isImmersive) {
                exitImmersiveMode();
            } else {
                config.isImmersive = true;
                save({ isImmersive: true });
                showToast('🌌 开启沉浸图库模式');

                if (!currentHoveredImg || viewer.style.display !== 'block') {
                    const galleryImages = getGalleryImages();
                    if (galleryImages.length > 0) {
                        const nextImg = galleryImages[0];
                        nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        triggerZoom(nextImg);
                    } else {
                        showToast("⚠️ 当前页面未发现可用图片");
                        config.isImmersive = false;
                        save({ isImmersive: false });
                    }
                } else {
                    handleImmersiveActivity();
                }
            }
            return;
        }

        if (viewer.style.display !== 'block') return;

        if (matchCombo(e, keys.like)) {
            if (config.isImmersive) { executePhantomAction('like'); e.preventDefault(); return; }
        }
        else if (matchCombo(e, keys.follow)) {
            if (config.isImmersive) { executePhantomAction('follow'); e.preventDefault(); return; }
        }

        if (k === keys.rotate) { config.rotate = (config.rotate + 90) % 360; up = true; } 
        else if (k === keys.mirror) { config.mirror *= -1; up = true; } 
        else if (k === keys.mode) { 
            if (config.isImmersive) {
                showToast(`⚠️ 请双击背景或按 ${keys.immersive.toUpperCase()} 退出沉浸模式`);
            } else {
                config.mode = modeList[(modeList.indexOf(config.mode) + 1) % modeList.length]; 
                save({ mode: config.mode }); 
                up = true; 
                showToast(modeNames[config.mode]); 
            }
        }
        else if (k === keys.zoomIn || k === '+') { activeZoom += 0.5; isZoomManuallyChanged = true; showToast(`${activeZoom.toFixed(1)}x`); up = true; } 
        else if (k === keys.zoomOut || k === '-') { activeZoom = Math.max(0.5, activeZoom - 0.5); isZoomManuallyChanged = true; showToast(`${activeZoom.toFixed(1)}x`); up = true; }
        
        else if (matchCombo(e, 's')) {
            if (config.isImmersive && zoomImg.src) {
                downloadImage(zoomImg.src);
                e.preventDefault(); return; 
            }
        }
        else if (matchCombo(e, 'escape')) {
            if (config.isImmersive) {
                exitImmersiveMode();
                e.preventDefault(); return;
            }
        }
        else if (k === 'arrowleft' || k === 'a' || k === 'arrowright' || k === 'd') {
            if (!config.isImmersive || window.isFetchingMore) return;

            const galleryImages = getGalleryImages();
            if (galleryImages.length === 0) return;

            let currentIndex = galleryImages.indexOf(currentHoveredImg);
            if (currentIndex === -1 && currentHoveredSrc) {
                currentIndex = galleryImages.findIndex(img => img.src === currentHoveredSrc);
            }
            if (currentIndex === -1) currentIndex = 0;

            const isNext = (k === 'arrowright' || k === 'd');

            if (isNext) {
                if (currentIndex < galleryImages.length - 1) {
                    performSwitch(galleryImages[currentIndex + 1], "下一张 ➡️");
                } else {
                    window.isFetchingMore = true;
                    showToast("⏳ 正在加载更多动态...");
                    window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
                    
                    setTimeout(() => {
                        const newGallery = getGalleryImages();
                        let newIdx = newGallery.indexOf(currentHoveredImg);
                        if (newIdx === -1) newIdx = newGallery.findIndex(img => img.src === currentHoveredSrc);
                        
                        if (newIdx !== -1 && newIdx < newGallery.length - 1) {
                            performSwitch(newGallery[newIdx + 1], "下一张 ➡️");
                        } else {
                            showToast("🚧 到底啦！没有更多图片了");
                        }
                        window.isFetchingMore = false;
                    }, 800);
                }
            } else {
                if (currentIndex > 0) {
                    performSwitch(galleryImages[currentIndex - 1], "⬅️ 上一张");
                } else {
                    window.isFetchingMore = true;
                    showToast("⏳ 正在向上翻阅...");
                    window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
                    
                    setTimeout(() => {
                        const newGallery = getGalleryImages();
                        let newIdx = newGallery.indexOf(currentHoveredImg);
                        if (newIdx === -1) newIdx = newGallery.findIndex(img => img.src === currentHoveredSrc);
                        
                        if (newIdx !== -1 && newIdx > 0) {
                            performSwitch(newGallery[newIdx - 1], "⬅️ 上一张");
                        } else {
                            showToast("🚧 到顶啦！");
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
            renderViewer(null, cachedRect); 
        }
    }, true);
})();