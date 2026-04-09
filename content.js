(function () {
    if (window.__imgZoomProInitialized) return;
    window.__imgZoomProInitialized = true;

    // 1. 核心配置与状态管理
    let config = { 
        hasAgreed: false, loadHD: 'true', breakoutView: false, 
        showStatus: true, smallImageOptimization: true, 
        zoom: 2.0, rotate: 0, mirror: 1, mode: 'partial',
        isImmersive: false
    };
    
    let activeZoom = 2.0; 
    let keys = { 
        mode: 'v', rotate: 'r', mirror: 'm', zoomIn: '=', zoomOut: '-', 
        immersive: 'ctrl+f12', like: 'l', follow: 'f', playVideo: 'q' 
    };
    
    let currentHoveredMedia = null;
    let currentHoveredSrc = null; 
    let cachedRect = null; 
    let loadingTask = null;
    let rAF_ID = null; 

    // --- Canvas 克隆引擎核心状态 ---
    let isCanvasEngineRunning = false;
    let canvasRafId = null;

    let isSmallImageOptimized = false;
    let customLensWidth = null;
    let customLensHeight = null;
    let isZoomManuallyChanged = false;
    let keyboardSwitchTime = 0; 
    let hideCursorTimer = null;
    let hintFadeTimer = null;
    let bgClickCount = 0;
    let bgClickTimer = null;

    let lastTarget = null;
    let lastFoundMedia = null;
    const styleCache = new Map();

    window.__mix01FollowCache = window.__mix01FollowCache || {};

    const modeList = ['partial', 'full-follow', 'full-center'];
    const modeNames = { 'partial': '🔍 局部放大', 'full-follow': '🖼️ 整体跟随', 'full-center': '📐 智能避让' };
    const badHdUrls = new Set();

    const isContextValid = () => !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

    // 2. 外部驱动器桥接 (解耦核心)
    function getImmersiveAdapter() {
        if (window.Mix01ImmersiveEngine && window.Mix01ImmersiveEngine.getAdapter) {
            return window.Mix01ImmersiveEngine.getAdapter(window.location.hostname);
        }
        return null;
    }

    async function executePhantomAction(actionType) {
        if (!currentHoveredMedia) return;
        const adapter = getImmersiveAdapter();
        
        if (!adapter || (actionType === 'like' && !adapter.like) || (actionType === 'follow' && !adapter.follow)) {
            showToast("⚠️ 该网站暂不支持快捷交互");
            return;
        }

        const container = adapter.getContainer ? adapter.getContainer(currentHoveredMedia) : document.body;

        if (actionType === 'like') {
            const newState = await adapter.like(container);
            if (newState !== null) showToast(newState ? "❤️ 已喜欢" : "🤍 已取消喜欢");
            else showToast("❌ 未找到喜欢的操作按钮");
        } else {
            const newState = await adapter.follow(container);
            if (newState !== null) showToast(newState ? "🫂 已成功关注" : "👋 已取消关注");
            else showToast("❌ 未找到当前作者的关注按钮");
        }
        setTimeout(updateImmersiveHUD, 300);
    }

    // 3. 配置同步
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

    // 4. 跨域高清解析与下载通信
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        const getUrlAndProcess = async (actionFn) => {
            const src = request.clickedUrl || zoomImg.src;
            const targetEl = request.clickedUrl ? (currentHoveredSrc === request.clickedUrl ? currentHoveredMedia : document.createElement('img')) : zoomImg;
            let targetUrl = src;
            if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                targetUrl = await window.Mix01RuleEngine.getHighResUrl(targetEl, src);
            }
            actionFn(targetUrl);
        };
        if (request.action === "getHDUrl") { getUrlAndProcess(url => sendResponse({ url: url })); return true; } 
        else if (request.action === "copyHDUrl") { getUrlAndProcess(url => { copyImageToClipboard(url); sendResponse({ status: "ok" }); }); return true; } 
        else if (request.action === "saveHDUrl") { getUrlAndProcess(url => { downloadImage(url); sendResponse({ status: "ok" }); }); return true; }
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
            img.onerror = () => { showToast("❌ 渲染失败"); URL.revokeObjectURL(blobUrl); };
            img.src = blobUrl;
        } catch (err) { showToast("❌ 获取图片失败，存在跨域限制"); }
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
                if (chrome.runtime.lastError) { window.open(url, '_blank'); showToast("⚠️ 扩展通信失败，已在新标签页打开"); } 
                else { showToast("✅ 已成功保存至 IMG_Download 文件夹！"); }
            });
        } catch (e) {
            window.open(url, '_blank'); showToast("⚠️ 跨域安全拦截，已在新标签页打开");
        }
    }

    // 5. DOM 组件初始化
    const viewer = document.createElement('div'); viewer.id = 'img-zoom-pro-viewer-xyz';
    const zoomImg = document.createElement('img'); zoomImg.id = 'zoom-img-xyz';
    
    const zoomCanvas = document.createElement('canvas'); 
    zoomCanvas.id = 'zoom-canvas-xyz';
    const canvasCtx = zoomCanvas.getContext('2d', { alpha: false });

    const statusLabel = document.createElement('div'); statusLabel.id = 'img-zoom-pro-status-label';
    const toast = document.createElement('div'); toast.className = 'img-zoom-toast-xyz';
    const noticeBox = document.createElement('div'); noticeBox.className = 'notice-container-xyz';
    noticeBox.innerHTML = '⚠️ 未同意协议<br>请点击右上角图标同意并开启功能';
    
    const styleBlock = document.createElement('style');
    styleBlock.innerHTML = `
        .kbd-btn { background:rgba(255,255,255,0.2); padding:2px 6px; border-radius:4px; font-family: monospace; font-weight: bold; margin: 0 2px;}
        .author-tag { color: #1da1f2; font-weight: bold; margin: 0 4px; }
        .hud-status-item { font-weight: bold; transition: color 0.3s ease; display: inline-block; }
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

        viewer.appendChild(zoomImg); 
        viewer.appendChild(zoomCanvas); 
        viewer.appendChild(statusLabel); 
        viewer.appendChild(noticeBox); 
        viewer.appendChild(immersiveHint);
        document.body.appendChild(viewer); 
        document.body.appendChild(toast);
    };
    initViewer();

    // 6. 交互 HUD 更新
    function updateImmersiveHUD() {
        if (!config.isImmersive) return;
        
        const adapter = getImmersiveAdapter();
        let likeText = "喜欢"; let likeIcon = "🤍"; let likeColor = "#dddddd";
        let followText = "关注"; let followIcon = "👤"; let followColor = "#dddddd";
        let authorDisplay = "";

        if (currentHoveredMedia && adapter && adapter.getStates) {
            const container = adapter.getContainer ? adapter.getContainer(currentHoveredMedia) : document.body;
            const states = adapter.getStates(container);
            if (states.isLiked !== null) { likeText = states.isLiked ? "已喜欢" : "未喜欢"; likeIcon = states.isLiked ? "❤️" : "🤍"; likeColor = states.isLiked ? "#f91880" : "#aaaaaa"; }
            if (states.isFollowed !== null) { followText = states.isFollowed ? "已关注" : "未关注"; followIcon = states.isFollowed ? "🫂" : "👤"; followColor = states.isFollowed ? "#00ba7c" : "#ff4b4b"; }
            if (states.authorName) { authorDisplay = `<span class="author-tag">${states.authorName}</span>`; }
        }

        const hintKbdLike = (keys.like || 'l').toUpperCase();
        const hintKbdFollow = (keys.follow || 'f').toUpperCase();
        
        let actionsHtml = adapter ? `&nbsp;|&nbsp; <span class="hud-status-item" style="color: ${likeColor}">${likeIcon} ${likeText}</span>(<kbd class="kbd-btn">${hintKbdLike}</kbd>) &nbsp;&nbsp; <span class="hud-status-item" style="color: ${followColor}">${followIcon} ${authorDisplay}${followText}</span>(<kbd class="kbd-btn">${hintKbdFollow}</kbd>) ` : '';

        let playHtml = "";
        if (currentHoveredMedia && currentHoveredMedia.tagName === 'VIDEO') {
            const playText = isCanvasEngineRunning ? "⏸️ 暂停" : "🎥 无视限制播放";
            playHtml = `&nbsp;|&nbsp; ${playText}(<kbd class="kbd-btn">${(keys.playVideo || 'q').toUpperCase()}</kbd>)`;
        }

        immersiveHint.innerHTML = `⌨️ 左右切换 &nbsp;|&nbsp; 💾 下载(<kbd class="kbd-btn">S</kbd>) ${actionsHtml} ${playHtml} &nbsp;|&nbsp; ❌ 双击退出`;
    }

    function setStyle(el, prop, val) { 
        const key = (el.id || el.className) + '_' + prop;
        if (styleCache.get(key) !== val) { el.style.setProperty(prop, val, 'important'); styleCache.set(key, val); }
    }
    
    function handleImmersiveActivity() {
        if (!config.isImmersive || viewer.style.display !== 'block') return;
        updateImmersiveHUD(); 
        setStyle(viewer, 'cursor', 'default'); setStyle(zoomImg, 'cursor', 'default');
        setStyle(immersiveHint, 'display', 'block'); void immersiveHint.offsetWidth; setStyle(immersiveHint, 'opacity', '1');
        clearTimeout(hideCursorTimer); clearTimeout(hintFadeTimer);

        hideCursorTimer = setTimeout(() => {
            setStyle(viewer, 'cursor', 'none'); setStyle(zoomImg, 'cursor', 'none'); setStyle(zoomCanvas, 'cursor', 'none');
        }, 1500);
        hintFadeTimer = setTimeout(() => { setStyle(immersiveHint, 'opacity', '0'); }, 3500); 
    }

    function hideViewer() {
        setStyle(viewer, 'display', 'none');
        setStyle(zoomImg, 'display', 'none');
        setStyle(zoomCanvas, 'display', 'none'); 

        if (isCanvasEngineRunning && currentHoveredMedia && currentHoveredMedia.tagName === 'VIDEO') {
            currentHoveredMedia.pause();
            currentHoveredMedia.muted = true;
        }
        isCanvasEngineRunning = false;
        cancelAnimationFrame(canvasRafId);

        currentHoveredMedia = null; currentHoveredSrc = null; cachedRect = null; loadingTask = null;
        isSmallImageOptimized = false; customLensWidth = null; customLensHeight = null;
        isZoomManuallyChanged = false; window.isFetchingMore = false; 
        lastTarget = null; lastFoundMedia = null;

        clearTimeout(hideCursorTimer); clearTimeout(hintFadeTimer);
        setStyle(immersiveHint, 'opacity', '0');
        setStyle(viewer, 'cursor', 'default'); setStyle(zoomImg, 'cursor', 'default'); setStyle(viewer, 'pointer-events', 'none'); 
        if (rAF_ID) cancelAnimationFrame(rAF_ID);
    }

    // 7. Canvas 视频帧克隆引擎
    function toggleCanvasEngine() {
        if (!currentHoveredMedia || currentHoveredMedia.tagName !== 'VIDEO') return;
        
        isCanvasEngineRunning = !isCanvasEngineRunning;
        
        if (isCanvasEngineRunning) {
            showToast("🚀 帧克隆引擎已启动");
            setStyle(zoomImg, 'display', 'none');
            setStyle(zoomCanvas, 'display', 'block');
            
            zoomCanvas.width = currentHoveredMedia.videoWidth || currentHoveredMedia.clientWidth || 800;
            zoomCanvas.height = currentHoveredMedia.videoHeight || currentHoveredMedia.clientHeight || 600;
            
            currentHoveredMedia.muted = false; 
            currentHoveredMedia.play().catch(e => console.warn('自动播放受限', e));
            
            renderViewer(null, cachedRect);

            function drawLoop() {
                if (!isCanvasEngineRunning || !currentHoveredMedia) return;
                
                // 强力反制：如果视频被外部强制暂停，立刻重新播放
                if (currentHoveredMedia.paused) {
                    currentHoveredMedia.play().catch(()=>{});
                }

                if (currentHoveredMedia.videoWidth && zoomCanvas.width !== currentHoveredMedia.videoWidth) {
                    zoomCanvas.width = currentHoveredMedia.videoWidth;
                    zoomCanvas.height = currentHoveredMedia.videoHeight;
                    renderViewer(null, cachedRect);
                }
                
                canvasCtx.drawImage(currentHoveredMedia, 0, 0, zoomCanvas.width, zoomCanvas.height);
                canvasRafId = requestAnimationFrame(drawLoop);
            }
            drawLoop();
        } else {
            showToast("⏸️ 视频已暂停");
            currentHoveredMedia.pause();
            currentHoveredMedia.muted = true;
            cancelAnimationFrame(canvasRafId);
        }
        updateImmersiveHUD();
    }

    viewer.addEventListener('click', (e) => {
        if (e.target === viewer) {
            if (config.isImmersive) {
                bgClickCount++;
                if (bgClickCount === 1) {
                    showToast("⚠️ 请再点一次或双击退出");
                    bgClickTimer = setTimeout(() => { bgClickCount = 0; }, 1000); 
                } else if (bgClickCount >= 2) { clearTimeout(bgClickTimer); bgClickCount = 0; exitImmersiveMode(); }
            } else { hideViewer(); }
        }
    });

    viewer.addEventListener('dblclick', (e) => {
        if (config.isImmersive && e.target === viewer) { clearTimeout(bgClickTimer); bgClickCount = 0; exitImmersiveMode(); }
    });

    function exitImmersiveMode() {
        config.isImmersive = false;
        if (isContextValid()) chrome.storage.local.set({ isImmersive: false }); 
        showToast('❎ 已退出沉浸图库模式'); hideViewer();
    }

    function showToast(text) {
        clearTimeout(window.zoomToastTimer);
        toast.innerText = text; toast.classList.add('show');
        window.zoomToastTimer = setTimeout(() => { toast.classList.remove('show'); }, 1200);
    }

    function updateStatus(type, currentW, currentH) {
        if (!config.showStatus || (currentW < 300 || currentH < 200)) { setStyle(statusLabel, 'display', 'none'); return; }
        setStyle(statusLabel, 'display', 'block');
        statusLabel.innerText = type === 'hd' ? '高清解析' : '原图放大';
        if (currentHoveredMedia && currentHoveredMedia.tagName === 'VIDEO') {
            statusLabel.innerText = isCanvasEngineRunning ? '🚀 帧克隆引擎渲染中' : '🎥 视频就绪';
            statusLabel.style.backgroundColor = '#1da1f2';
        } else {
            statusLabel.className = type === 'hd' ? 'status-hd' : 'status-original';
            statusLabel.style.backgroundColor = '';
        }
    }

    // 8. 媒体捕获与路由
    function getMediaUnderCursor(clientX, clientY, target) {
        if (target && (target.tagName === 'IMG' || target.tagName === 'VIDEO') && (target.src || target.tagName === 'VIDEO')) { lastTarget = target; lastFoundMedia = target; return target; }
        if (target && target === lastTarget && lastFoundMedia) { return lastFoundMedia; }
        const elements = document.elementsFromPoint(clientX, clientY);
        if (!elements) return null;
        let found = null;
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (el.id === 'img-zoom-pro-viewer-xyz' || el.id === 'zoom-img-xyz' || el.id === 'zoom-canvas-xyz') continue;
            if ((el.tagName === 'IMG' || el.tagName === 'VIDEO') && (el.src || el.tagName === 'VIDEO')) { found = el; break; }
        }
        lastTarget = target; lastFoundMedia = found; return found;
    }

    async function triggerZoom(target) {
        if (target === currentHoveredMedia && (target.src || 'video') === currentHoveredSrc) return;
        hideViewer(); 

        currentHoveredMedia = target; currentHoveredSrc = target.src || 'video';
        cachedRect = target.getBoundingClientRect(); 
        
        isSmallImageOptimized = false; customLensWidth = null; customLensHeight = null; isZoomManuallyChanged = false;

        if (config.hasAgreed) {
            setStyle(noticeBox, 'display', 'none');
            const isVideo = target.tagName === 'VIDEO';

            if (isVideo) {
                setStyle(zoomImg, 'display', 'none');
                setStyle(zoomCanvas, 'display', 'block');
                
                zoomCanvas.width = target.videoWidth || target.clientWidth || 800;
                zoomCanvas.height = target.videoHeight || target.clientHeight || 600;
                try { canvasCtx.drawImage(target, 0, 0, zoomCanvas.width, zoomCanvas.height); } catch(e){}

                renderViewer(null, cachedRect);
                setStyle(viewer, 'display', 'block');
                if (config.isImmersive) handleImmersiveActivity();
                return;
            } 
            else {
                setStyle(zoomCanvas, 'display', 'none');
                setStyle(zoomImg, 'display', 'block');
                zoomImg.src = target.src;
                setStyle(zoomImg, 'max-width', 'none'); setStyle(zoomImg, 'max-height', 'none');

                if (config.smallImageOptimization) {
                    if (cachedRect.width <= 50 && cachedRect.height <= 50) { activeZoom = 9.0; isSmallImageOptimized = true; }
                    else if (cachedRect.width <= 100 && cachedRect.height <= 100) { activeZoom = 6.0; isSmallImageOptimized = true; }
                    else { activeZoom = config.zoom; }
                } else { activeZoom = config.zoom; }

                renderViewer(null, cachedRect); 

                if (config.loadHD === 'true') {
                    const myTask = target.src; loadingTask = myTask;
                    try {
                        if (window.Mix01RuleEngine && window.Mix01RuleEngine.getHighResUrl) {
                            const hdUrl = await window.Mix01RuleEngine.getHighResUrl(target, target.src);
                            if (hdUrl && hdUrl !== target.src && !badHdUrls.has(hdUrl)) {
                                const tempImg = new Image();
                                tempImg.onload = () => { 
                                    if (loadingTask === myTask && currentHoveredMedia === target) {
                                        if (!config.isImmersive && config.mode === 'partial' && isSmallImageOptimized && !isZoomManuallyChanged) {
                                            const nw = tempImg.naturalWidth, nh = tempImg.naturalHeight;
                                            if (nw > 350 || nh > 350) { customLensWidth = Math.min(nw, window.innerWidth * 0.9); customLensHeight = Math.min(nh, window.innerHeight * 0.9); activeZoom = nw / (cachedRect.width || 1); }
                                        }
                                        zoomImg.src = hdUrl; renderViewer(null, cachedRect); 
                                    }
                                };
                                tempImg.onerror = () => badHdUrls.add(hdUrl); tempImg.src = hdUrl;
                            }
                        }
                    } catch (error) { console.warn('Mix01 Engine 解析失败:', error); }
                }
            }
        } else { setStyle(zoomImg, 'display', 'none'); setStyle(zoomCanvas, 'display', 'none'); setStyle(statusLabel, 'display', 'none'); setStyle(noticeBox, 'display', 'block'); }
        setStyle(viewer, 'display', 'block');
        if (config.isImmersive) handleImmersiveActivity();
    }

    // 9. 鼠标与渲染事件
    document.addEventListener('mouseover', (e) => {
        if (config.isImmersive && viewer.style.display === 'block') return; 
        const media = getMediaUnderCursor(e.clientX, e.clientY, e.target);
        if (media) triggerZoom(media);
    }, { capture: true, passive: true }); 

    document.addEventListener('mousemove', (e) => {
        window.lastMouseX = e.clientX; window.lastMouseY = e.clientY;
        if (config.isImmersive && viewer.style.display === 'block') {
            handleImmersiveActivity();
            if (rAF_ID) cancelAnimationFrame(rAF_ID);
            if (cachedRect) rAF_ID = requestAnimationFrame(() => renderViewer(e, cachedRect));
            return; 
        }
        const media = getMediaUnderCursor(e.clientX, e.clientY, e.target);
        if (media && (media !== currentHoveredMedia || (media.src||'video') !== currentHoveredSrc)) {
            if (Date.now() - keyboardSwitchTime < 500) return;
            triggerZoom(media); return;
        }
        if (currentHoveredMedia && viewer.style.display === 'block' && cachedRect) {
            if (media === currentHoveredMedia) cachedRect = currentHoveredMedia.getBoundingClientRect();
            else {
                if (Date.now() - keyboardSwitchTime > 500) {
                    if (e.clientX < cachedRect.left || e.clientX > cachedRect.right || e.clientY < cachedRect.top || e.clientY > cachedRect.bottom) { hideViewer(); return; }
                }
            }
            if (rAF_ID) cancelAnimationFrame(rAF_ID);
            rAF_ID = requestAnimationFrame(() => renderViewer(e, cachedRect));
        }
    }, { capture: true, passive: true });

    document.addEventListener('mouseout', (e) => { 
        if (config.isImmersive && viewer.style.display === 'block') return; 
        if (e.target === currentHoveredMedia) {
            if (e.relatedTarget && currentHoveredMedia.contains(e.relatedTarget)) return;
            if (Date.now() - keyboardSwitchTime > 500) hideViewer(); 
        }
    }, { capture: true, passive: true });

    document.addEventListener('mouseleave', () => {
        if (config.isImmersive && viewer.style.display === 'block') return;
        if (Date.now() - keyboardSwitchTime > 500) hideViewer();
    }, { capture: true, passive: true });

    function renderViewer(e = null, rect = null) {
        if (!currentHoveredMedia) return;
        rect = rect || currentHoveredMedia.getBoundingClientRect();
        
        const clientX = e ? e.clientX : window.lastMouseX;
        const clientY = e ? e.clientY : window.lastMouseY;
        const xP = (clientX - rect.left) / (rect.width || 1);
        const yP = (clientY - rect.top) / (rect.height || 1);
        
        viewer.className = `mode-${config.mode}`;
        const sW = window.innerWidth, sH = window.innerHeight;
        let cDW = 0, cDH = 0;

        const isVideo = currentHoveredMedia.tagName === 'VIDEO';
        const activeMedia = isVideo ? zoomCanvas : zoomImg;

        const nw = isVideo ? (activeMedia.width || rect.width || 1) : (activeMedia.naturalWidth || rect.width || 1);
        const nh = isVideo ? (activeMedia.height || rect.height || 1) : (activeMedia.naturalHeight || rect.height || 1);
        const naturalRatio = nw / nh;

        if (config.isImmersive) {
            setStyle(viewer, 'display', 'block'); setStyle(viewer, 'position', 'fixed');
            setStyle(viewer, 'width', '100vw'); setStyle(viewer, 'height', '100vh');
            setStyle(viewer, 'left', '0px'); setStyle(viewer, 'top', '0px');
            setStyle(viewer, 'background-color', 'rgba(0, 0, 0, 0.95)'); setStyle(viewer, 'background-image', 'none');
            setStyle(viewer, 'border', 'none'); setStyle(viewer, 'border-radius', '0');
            setStyle(viewer, 'transform', 'none'); setStyle(viewer, 'pointer-events', 'auto'); 
            
            if (!isZoomManuallyChanged) {
                const maxW = sW * 0.95, maxH = sH * 0.95;
                let fitW = nw, fitH = nh;
                if (fitW > maxW) { fitW = maxW; fitH = fitW / naturalRatio; }
                if (fitH > maxH) { fitH = maxH; fitW = fitH * naturalRatio; }
                activeZoom = fitW / nw; 
            }
            
            let tW = nw * activeZoom, tH = nh * activeZoom;
            cDW = tW; cDH = tH;
            
            setStyle(activeMedia, 'position', 'absolute');
            setStyle(activeMedia, 'width', `${tW}px`); setStyle(activeMedia, 'height', `${tH}px`);
            
            if (isZoomManuallyChanged && (tW > sW || tH > sH)) {
                setStyle(activeMedia, 'left', `${(tW > sW) ? -(tW - sW) * (clientX / sW) : (sW - tW) / 2}px`); 
                setStyle(activeMedia, 'top', `${(tH > sH) ? -(tH - sH) * (clientY / sH) : (sH - tH) / 2}px`);
            } else {
                setStyle(activeMedia, 'left', `${(sW - tW) / 2}px`);
                setStyle(activeMedia, 'top', `${(sH - tH) / 2}px`);
            }
            setStyle(activeMedia, 'margin', '0px');
        } 
        else if (config.mode === 'partial') {
            setStyle(viewer, 'display', 'block'); setStyle(viewer, 'position', 'fixed'); setStyle(viewer, 'overflow', 'hidden'); 
            
            if (config.hasAgreed) {
                cDW = rect.width * activeZoom; cDH = rect.height * activeZoom;
                setStyle(activeMedia, 'width', cDW + 'px'); setStyle(activeMedia, 'height', cDH + 'px');
                setStyle(activeMedia, 'position', 'absolute'); 

                let lensW, lensH;
                if (isSmallImageOptimized && customLensWidth && customLensHeight) { lensW = customLensWidth; lensH = customLensHeight; } 
                else { lensW = Math.min(350, Math.max(100, cDW + 20)); lensH = Math.min(350, Math.max(100, cDH + 20)); }

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

                setStyle(activeMedia, 'right', 'auto'); setStyle(activeMedia, 'bottom', 'auto'); setStyle(activeMedia, 'margin', '0px');
                let offsetX = 0, offsetY = 0;
                if (cDW > lensW) offsetX = -(cDW * xP - lensW / 2); else offsetX = (lensW - cDW) / 2;
                if (cDH > lensH) offsetY = -(cDH * yP - lensH / 2); else offsetY = (lensH - cDH) / 2;
                setStyle(activeMedia, 'left', offsetX + 'px'); setStyle(activeMedia, 'top', offsetY + 'px');
            }
        } else {
            setStyle(viewer, 'display', 'block'); setStyle(viewer, 'position', 'fixed');
            setStyle(viewer, 'background-color', 'rgba(20, 20, 20, 0.9)'); setStyle(viewer, 'background-image', 'none');
            setStyle(activeMedia, 'position', 'absolute'); setStyle(activeMedia, 'right', 'auto'); setStyle(activeMedia, 'bottom', 'auto'); setStyle(activeMedia, 'margin', '0px');

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
                if (config.hasAgreed) { setStyle(activeMedia, 'width', '100%'); setStyle(activeMedia, 'height', '100%'); setStyle(activeMedia, 'left', '0px'); setStyle(activeMedia, 'top', '0px'); }
            } else {
                const vW = Math.min(tW, maxVW), vH = Math.min(tH, maxVH);
                cDW = vW; cDH = vH;
                setStyle(viewer, 'width', `${vW}px`); setStyle(viewer, 'height', `${vH}px`);
                setStyle(activeMedia, 'width', `${tW}px`); setStyle(activeMedia, 'height', `${tH}px`);
                setStyle(activeMedia, 'left', `${(tW > vW) ? -(tW - vW) * xP : 0}px`); setStyle(activeMedia, 'top', `${(tH > vH) ? -(tH - vH) * yP : 0}px`);
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
        updateStatus(activeMedia.src !== (currentHoveredMedia.src||'video') ? 'hd' : 'original', cDW, cDH);
        if (config.hasAgreed) setStyle(activeMedia, 'transform', `scaleX(${config.mirror}) rotate(${config.rotate}deg)`);
    }

    // 10. 键盘绑定与画廊导航
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
        // 解耦：如果有适配器，优先让适配器提取页面媒体
        const adapter = getImmersiveAdapter();
        if (adapter && adapter.getGalleryImages) return adapter.getGalleryImages();
        
        // 兜底方案：抓取所有大于 50px 的图片和视频
        return Array.from(document.querySelectorAll('img, video')).filter(media => {
            if (media.id === 'zoom-img-xyz' || media.id === 'zoom-canvas-xyz') return false;
            const rect = media.getBoundingClientRect();
            return rect.width > 50 && rect.height > 50 && window.getComputedStyle(media).display !== 'none';
        });
    }

    function performSwitch(nextImg, msgText) {
        if (msgText) showToast(msgText);
        keyboardSwitchTime = Date.now();
        nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        triggerZoom(nextImg);

        setTimeout(() => {
            if (currentHoveredMedia === nextImg) {
                const newRect = nextImg.getBoundingClientRect();
                window.lastMouseX = newRect.left + newRect.width / 2; window.lastMouseY = newRect.top + newRect.height / 2;
                renderViewer(null, newRect); handleImmersiveActivity(); 
            }
        }, 50); 
    }

    document.addEventListener('keydown', (e) => {
        if (!config.hasAgreed) return;
        const k = e.key.toLowerCase(); let up = false;
        const save = (d) => { if (isContextValid()) chrome.storage.local.set(d); };
        
        if (matchCombo(e, keys.immersive)) {
            e.preventDefault();
            if (config.isImmersive) { exitImmersiveMode(); } 
            else {
                config.isImmersive = true; save({ isImmersive: true }); showToast('🌌 开启沉浸音视频图库');
                if (!currentHoveredMedia || viewer.style.display !== 'block') {
                    const galleryImages = getGalleryImages();
                    if (galleryImages.length > 0) { const nextImg = galleryImages[0]; nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' }); triggerZoom(nextImg); } 
                    else { showToast("⚠️ 当前页面未发现可用媒体"); config.isImmersive = false; save({ isImmersive: false }); }
                } else { handleImmersiveActivity(); }
            }
            return;
        }

        if (viewer.style.display !== 'block') return;

        // 视频播放引擎触发
        if (matchCombo(e, keys.playVideo)) {
            if (config.isImmersive && currentHoveredMedia && currentHoveredMedia.tagName === 'VIDEO') {
                toggleCanvasEngine();
                e.preventDefault(); return;
            }
        }

        // 解耦交互动作：向 adapter 发送请求
        if (matchCombo(e, keys.like)) { if (config.isImmersive) { executePhantomAction('like'); e.preventDefault(); return; } }
        else if (matchCombo(e, keys.follow)) { if (config.isImmersive) { executePhantomAction('follow'); e.preventDefault(); return; } }

        if (k === keys.rotate) { config.rotate = (config.rotate + 90) % 360; up = true; } 
        else if (k === keys.mirror) { config.mirror *= -1; up = true; } 
        else if (k === keys.mode) { 
            if (config.isImmersive) { showToast(`⚠️ 请双击背景或按 ${keys.immersive.toUpperCase()} 退出沉浸模式`); } 
            else { config.mode = modeList[(modeList.indexOf(config.mode) + 1) % modeList.length]; save({ mode: config.mode }); up = true; showToast(modeNames[config.mode]); }
        }
        else if (k === keys.zoomIn || k === '+') { activeZoom += 0.5; isZoomManuallyChanged = true; showToast(`${activeZoom.toFixed(1)}x`); up = true; } 
        else if (k === keys.zoomOut || k === '-') { activeZoom = Math.max(0.5, activeZoom - 0.5); isZoomManuallyChanged = true; showToast(`${activeZoom.toFixed(1)}x`); up = true; }
        else if (matchCombo(e, 's')) {
            if (config.isImmersive && currentHoveredMedia) {
                if (currentHoveredMedia.tagName === 'VIDEO') { showToast("⚠️ 视频流媒体暂不支持快捷下载，敬请谅解"); } 
                else if (zoomImg.src) { downloadImage(zoomImg.src); }
                e.preventDefault(); return; 
            }
        }
        else if (matchCombo(e, 'escape')) { if (config.isImmersive) { exitImmersiveMode(); e.preventDefault(); return; } }
        else if (k === 'arrowleft' || k === 'a' || k === 'arrowright' || k === 'd') {
            if (!config.isImmersive || window.isFetchingMore) return;
            const galleryImages = getGalleryImages(); if (galleryImages.length === 0) return;
            let currentIndex = galleryImages.indexOf(currentHoveredMedia);
            if (currentIndex === -1 && currentHoveredSrc) { currentIndex = galleryImages.findIndex(media => (media.src||'video') === currentHoveredSrc); }
            if (currentIndex === -1) currentIndex = 0;
            const isNext = (k === 'arrowright' || k === 'd');

            if (isNext) {
                if (currentIndex < galleryImages.length - 1) { performSwitch(galleryImages[currentIndex + 1], "下一项 ➡️"); } 
                else {
                    window.isFetchingMore = true; showToast("⏳ 正在加载更多动态..."); window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
                    setTimeout(() => {
                        const newGallery = getGalleryImages(); let newIdx = newGallery.indexOf(currentHoveredMedia);
                        if (newIdx === -1) newIdx = newGallery.findIndex(media => (media.src||'video') === currentHoveredSrc);
                        if (newIdx !== -1 && newIdx < newGallery.length - 1) { performSwitch(newGallery[newIdx + 1], "下一项 ➡️"); } 
                        else { showToast("🚧 到底啦！没有更多内容了"); }
                        window.isFetchingMore = false;
                    }, 800);
                }
            } else {
                if (currentIndex > 0) { performSwitch(galleryImages[currentIndex - 1], "⬅️ 上一项"); } 
                else {
                    window.isFetchingMore = true; showToast("⏳ 正在向上翻阅..."); window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
                    setTimeout(() => {
                        const newGallery = getGalleryImages(); let newIdx = newGallery.indexOf(currentHoveredMedia);
                        if (newIdx === -1) newIdx = newGallery.findIndex(media => (media.src||'video') === currentHoveredSrc);
                        if (newIdx !== -1 && newIdx > 0) { performSwitch(newGallery[newIdx - 1], "⬅️ 上一项"); } 
                        else { showToast("🚧 到顶啦！"); }
                        window.isFetchingMore = false;
                    }, 800);
                }
            }
            e.preventDefault(); return; 
        }
        if (up) { e.preventDefault(); renderViewer(null, cachedRect); }
    }, true);
})();