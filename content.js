(function () {
    if (window.__imgZoomProInitialized) return;
    window.__imgZoomProInitialized = true;

    let config = { 
        hasAgreed: false, loadHD: 'true', breakoutView: false, 
        showStatus: true, smallImageOptimization: true, 
        zoom: 2.0, rotate: 0, mirror: 1, mode: 'partial' 
    };
    
    let activeZoom = 2.0; 
    let keys = { mode: 'v', rotate: 'r', mirror: 'm', zoomIn: '=', zoomOut: '-' };
    let HD_RULES = [];
    let currentHoveredImg = null;
    let currentHoveredSrc = null; 
    let cachedRect = null; 
    let loadingTask = null;
    let rAF_ID = null; 

    const modeList = ['partial', 'full-follow', 'full-center'];
    const modeNames = { 'partial': '🔍 局部放大', 'full-follow': '🖼️ 整体跟随', 'full-center': '📐 智能避让' };
    const badHdUrls = new Set();

    const isContextValid = () => !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

    async function loadRules() {
        if (!isContextValid()) return;
        try {
            const resp = await fetch(chrome.runtime.getURL('rules.json'));
            const data = await resp.json();
            HD_RULES = data.map(r => ({ ...r, hosts: new RegExp(r.hosts), match: new RegExp(r.match, 'i') }));
        } catch (e) {}
    }
    loadRules();

    const syncConfig = (res) => {
        if (!res) return;
        if (res.hasAgreed !== undefined) config.hasAgreed = res.hasAgreed;
        if (res.loadHD !== undefined) config.loadHD = res.loadHD;
        if (res.breakoutView !== undefined) config.breakoutView = res.breakoutView;
        if (res.showStatus !== undefined) config.showStatus = res.showStatus;
        if (res.smallImageOptimization !== undefined) config.smallImageOptimization = res.smallImageOptimization;
        if (res.mode !== undefined) config.mode = res.mode;
        if (res.zoomLevel !== undefined) config.zoom = parseFloat(res.zoomLevel);
        
        Object.keys(keys).forEach(k => {
            let storageKey = 'key' + k.charAt(0).toUpperCase() + k.slice(1);
            if (res[storageKey]) keys[k] = res[storageKey];
        });
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
        if (request.action === "getHDUrl") {
            const targetUrl = request.clickedUrl ? getHighResUrl(request.clickedUrl) : zoomImg.src;
            sendResponse({ url: targetUrl });
        } else if (request.action === "copyHDUrl") {
            // [新增] 拦截复制指令并执行
            const targetUrl = request.clickedUrl ? getHighResUrl(request.clickedUrl) : zoomImg.src;
            copyImageToClipboard(targetUrl);
            sendResponse({ status: "ok" });
        }
    });
    // --- 新增：复制图片到剪贴板引擎 (自动转换为 PNG) ---
    async function copyImageToClipboard(url) {
        showToast("⏳ 正在获取并处理原图...");
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            
            // 浏览器剪贴板 API 严格要求 image/png 格式，其他格式必须用 Canvas 转换
            const img = new Image();
            const blobUrl = URL.createObjectURL(blob);
            
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                
                canvas.toBlob(async (pngBlob) => {
                    try {
                        await navigator.clipboard.write([
                            new ClipboardItem({ 'image/png': pngBlob })
                        ]);
                        showToast("✅ 已成功复制原图到剪切板！");
                    } catch (err) {
                        console.error("Clipboard write failed:", err);
                        showToast("❌ 写入失败，请确保页面保持聚焦");
                    }
                    URL.revokeObjectURL(blobUrl);
                }, 'image/png');
            };
            
            img.onerror = () => {
                showToast("❌ 图片渲染解析失败");
                URL.revokeObjectURL(blobUrl);
            };
            
            img.src = blobUrl;

        } catch (err) {
            console.error("Fetch failed:", err);
            showToast("❌ 获取图片失败，可能存在跨域限制");
        }
    }

    const viewer = document.createElement('div');
    viewer.id = 'img-zoom-pro-viewer-xyz';
    const zoomImg = document.createElement('img');
    zoomImg.id = 'zoom-img-xyz';
    const statusLabel = document.createElement('div');
    statusLabel.id = 'img-zoom-pro-status-label';
    const toast = document.createElement('div');
    toast.className = 'img-zoom-toast-xyz';
    const noticeBox = document.createElement('div');
    noticeBox.className = 'notice-container-xyz';
    noticeBox.innerHTML = '⚠️ 未同意协议<br>请点击右上角图标同意并开启功能';

    const initViewer = () => {
        if (!document.body) { setTimeout(initViewer, 100); return; }
        viewer.appendChild(zoomImg);
        viewer.appendChild(statusLabel);
        viewer.appendChild(noticeBox);
        document.body.appendChild(viewer);
        document.body.appendChild(toast);
    };
    initViewer();

    function setStyle(el, prop, val) { el.style.setProperty(prop, val, 'important'); }
    
    function hideViewer() {
        setStyle(viewer, 'display', 'none');
        currentHoveredImg = null;
        currentHoveredSrc = null;
        cachedRect = null; 
        loadingTask = null;
        if (rAF_ID) cancelAnimationFrame(rAF_ID);
    }

    function showToast(text) {
        clearTimeout(window.zoomToastTimer);
        toast.innerText = text; 
        toast.classList.add('show');
        window.zoomToastTimer = setTimeout(() => { toast.classList.remove('show'); }, 1200);
    }

    function updateStatus(type, currentW, currentH) {
        if (!config.showStatus || (currentW < 300 || currentH < 200)) {
            setStyle(statusLabel, 'display', 'none'); return;
        }
        setStyle(statusLabel, 'display', 'block');
        statusLabel.innerText = type === 'hd' ? '高清图放大' : '原图放大';
        statusLabel.className = type === 'hd' ? 'status-hd' : 'status-original';
    }

    function getHighResUrl(url) {
        if (!url || url.startsWith('data:')) return url;
        let hostname = '';
        try { hostname = new URL(url).hostname; } catch (e) { return url; }
        for (const rule of HD_RULES) {
            if (rule.hosts.test(hostname) && rule.match.test(url)) return url.replace(rule.match, rule.replace);
        }
        return url;
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

    function triggerZoom(target) {
        if (target === currentHoveredImg && target.src === currentHoveredSrc) return;
        hideViewer(); 

        currentHoveredImg = target;
        currentHoveredSrc = target.src;
        cachedRect = target.getBoundingClientRect(); 

        if (config.hasAgreed) {
            setStyle(noticeBox, 'display', 'none');
            setStyle(zoomImg, 'display', 'block');
            
            zoomImg.src = target.src;
            setStyle(zoomImg, 'max-width', 'none'); 
            setStyle(zoomImg, 'max-height', 'none');

            if (config.smallImageOptimization) {
                if (cachedRect.width <= 50 && cachedRect.height <= 50) activeZoom = 9.0;
                else if (cachedRect.width <= 100 && cachedRect.height <= 100) activeZoom = 6.0;
                else activeZoom = config.zoom;
            } else {
                activeZoom = config.zoom;
            }

            renderViewer(null, cachedRect); 

            if (config.loadHD === 'true') {
                const hdUrl = getHighResUrl(target.src);
                if (hdUrl !== target.src && !badHdUrls.has(hdUrl)) {
                    const myTask = hdUrl; 
                    loadingTask = myTask;
                    const tempImg = new Image();
                    tempImg.onload = () => { 
                        if (loadingTask === myTask && currentHoveredImg === target) {
                            zoomImg.src = hdUrl; renderViewer(null, cachedRect); 
                        }
                    };
                    tempImg.onerror = () => badHdUrls.add(hdUrl);
                    tempImg.src = hdUrl;
                }
            }
        } else { 
            setStyle(zoomImg, 'display', 'none');
            setStyle(statusLabel, 'display', 'none');
            setStyle(noticeBox, 'display', 'block'); 
        }
        setStyle(viewer, 'display', 'block');
    }

    document.addEventListener('mouseover', (e) => {
        const img = getImgUnderCursor(e.clientX, e.clientY, e.target);
        if (img) triggerZoom(img);
    }, true); 

    document.addEventListener('mousemove', (e) => {
        window.lastMouseX = e.clientX; window.lastMouseY = e.clientY;

        const img = getImgUnderCursor(e.clientX, e.clientY, e.target);

        if (img && (img !== currentHoveredImg || img.src !== currentHoveredSrc)) {
            triggerZoom(img);
            return;
        }

        if (currentHoveredImg && viewer.style.display === 'block' && cachedRect) {
            if (img === currentHoveredImg) {
                cachedRect = currentHoveredImg.getBoundingClientRect();
            } else {
                const pad = 5;
                if (e.clientX < cachedRect.left - pad || e.clientX > cachedRect.right + pad || 
                    e.clientY < cachedRect.top - pad || e.clientY > cachedRect.bottom + pad) {
                    hideViewer(); return;
                }
            }
            if (rAF_ID) cancelAnimationFrame(rAF_ID);
            rAF_ID = requestAnimationFrame(() => renderViewer(e, cachedRect));
        }
    }, true);

    document.addEventListener('mouseout', (e) => { 
        if (e.target === currentHoveredImg) {
            if (e.relatedTarget && currentHoveredImg.contains(e.relatedTarget)) {
                return;
            }
            hideViewer(); 
        }
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

        if (config.mode === 'partial') {
            setStyle(viewer, 'display', 'block'); 
            setStyle(viewer, 'position', 'fixed'); 
            setStyle(viewer, 'overflow', 'hidden'); 
            
            if (config.hasAgreed) {
                cDW = rect.width * activeZoom; 
                cDH = rect.height * activeZoom;
                setStyle(zoomImg, 'width', cDW + 'px'); 
                setStyle(zoomImg, 'height', cDH + 'px');
                setStyle(zoomImg, 'position', 'absolute'); 

                // 【全新逻辑：动态自适应透镜 (Smart Adaptive Lens)】
                // 1. 动态计算透镜尺寸：最大 350，最小 100，否则紧凑贴合图片尺寸 + 20px 留白
                let lensW = Math.min(350, Math.max(100, cDW + 20));
                let lensH = Math.min(350, Math.max(100, cDH + 20));

                setStyle(viewer, 'width', lensW + 'px'); 
                setStyle(viewer, 'height', lensH + 'px');

                // 2. 透镜本身的游标跟随边界逻辑
                let vX = clientX + 20, vY = clientY + 20;
                if (vX + lensW > sW) vX = clientX - lensW - 20;
                if (vY + lensH > sH) vY = clientY - lensH - 20;
                setStyle(viewer, 'left', `${vX}px`); setStyle(viewer, 'top', `${vY}px`);
                setStyle(viewer, 'transform', 'none');

                // 3. UI 样式判定：如果是纯小图（双端均小于350），应用精致对焦框背景
                if (cDW < 350 && cDH < 350) {
                    setStyle(viewer, 'border', '1px solid rgba(255, 255, 255, 0.2)'); 
                    setStyle(viewer, 'background-image', 'radial-gradient(circle, rgba(20,20,20,1) 0%, rgba(0,0,0,1) 100%)'); 
                    setStyle(viewer, 'background-color', '#000'); 
                } else {
                    setStyle(viewer, 'background-image', 'none'); 
                    setStyle(viewer, 'background-color', 'transparent'); 
                    setStyle(viewer, 'border', '1px solid rgba(255, 255, 255, 0.4)'); 
                }

                // 4. 重置图片定位状态
                setStyle(zoomImg, 'right', 'auto'); 
                setStyle(zoomImg, 'bottom', 'auto');
                setStyle(zoomImg, 'margin', '0');

                // 5. 核心：分离 X 轴和 Y 轴的滑动逻辑
                let offsetX = 0, offsetY = 0;
                
                // 宽度判定：图宽于透镜则开启滑动，否则绝对居中
                if (cDW > lensW) {
                    offsetX = -(cDW * xP - lensW / 2);
                } else {
                    offsetX = (lensW - cDW) / 2;
                }
                
                // 高度判定：图高于透镜则开启滑动，否则绝对居中
                if (cDH > lensH) {
                    offsetY = -(cDH * yP - lensH / 2);
                } else {
                    offsetY = (lensH - cDH) / 2;
                }

                setStyle(zoomImg, 'left', offsetX + 'px');
                setStyle(zoomImg, 'top', offsetY + 'px');
            }
        } else {
            setStyle(viewer, 'display', 'block');
            setStyle(viewer, 'position', 'fixed');
            setStyle(viewer, 'background-color', 'rgba(20, 20, 20, 0.9)');
            setStyle(viewer, 'background-image', 'none');
            setStyle(zoomImg, 'position', 'absolute'); 
            
            // 防止小图居中属性泄漏到全局模式
            setStyle(zoomImg, 'right', 'auto'); 
            setStyle(zoomImg, 'bottom', 'auto');
            setStyle(zoomImg, 'margin', '0');

            let tW = rect.width * activeZoom, tH = rect.height * activeZoom;
            const maxVW = sW * (config.mode === 'full-follow' ? 0.7 : 0.95);
            const maxVH = sH * (config.mode === 'full-follow' ? 0.7 : 0.95);
            
            if (!config.breakoutView || !config.hasAgreed) {
                const safeMaxVW = maxVW - 10;
                const safeMaxVH = maxVH - 10;
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
                // 智能避让逻辑 (Smart Dock)
                setStyle(viewer, 'transform', 'none'); 
                const margin = 30; 
                let vX, vY;

                if (clientX < sW / 2) {
                    vX = sW - cDW - margin; 
                } else {
                    vX = margin; 
                }

                vY = clientY - (cDH / 2);
                if (vY < margin) vY = margin;
                if (vY + cDH > sH - margin) vY = sH - cDH - margin;

                setStyle(viewer, 'left', `${vX}px`); 
                setStyle(viewer, 'top', `${vY}px`);
            }
        }
        updateStatus(zoomImg.src !== currentHoveredImg.src ? 'hd' : 'original', cDW, cDH);
        if (config.hasAgreed) setStyle(zoomImg, 'transform', `scaleX(${config.mirror}) rotate(${config.rotate}deg)`);
    }

    document.addEventListener('keydown', (e) => {
        if (viewer.style.display !== 'block' || !config.hasAgreed) return;
        const k = e.key.toLowerCase(); let up = false;
        const save = (d) => { if (isContextValid()) chrome.storage.local.set(d); };
        
        if (k === keys.rotate) { config.rotate = (config.rotate + 90) % 360; up = true; } 
        else if (k === keys.mirror) { config.mirror *= -1; up = true; } 
        else if (k === keys.mode) { config.mode = modeList[(modeList.indexOf(config.mode) + 1) % modeList.length]; save({ mode: config.mode }); up = true; showToast(modeNames[config.mode]); }
        else if (k === keys.zoomIn || k === '+') { activeZoom += 0.5; showToast(`${activeZoom.toFixed(1)}x`); up = true; } 
        else if (k === keys.zoomOut || k === '-') { activeZoom = Math.max(1.5, activeZoom - 0.5); showToast(`${activeZoom.toFixed(1)}x`); up = true; }
        
        if (up) { 
            e.preventDefault(); 
            renderViewer(null, cachedRect); 
        }
    }, true);
})();