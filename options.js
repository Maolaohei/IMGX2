// options.js - Mix01 引擎配置控制器 (物理防风控终极版: 绝对1:1跟手拖拽)

document.addEventListener('DOMContentLoaded', () => {
    const defaultConfigs = { 
        loadHD: 'true', breakoutView: false, showStatus: true, smallImageOptimization: true, 
        disableVideoDefaultView: true, zoomLevel: 2.0, isImmersive: false, mode: 'partial', preloadCount: 5, 
        keyMode: 'v', wheelZoomEnabled: false, keyRotate: 'r', keyMirror: 'm', keyZoomIn: '=', keyZoomOut: '-',
        keyImmersive: 'ctrl+f12', keyLike: 'l', keyFollow: 'f', keyPlayVideo: 'space', keyDownloadVideo: 'd',
        keyDouble: 's', keyTriple: 'q', base64Domains: '',
        
        bgType: 'dark', 
        customBgValue: '',
        fontTheme: 'dark',
        bgOffsetX: 0, 
        bgOffsetY: 0,
        bgZoom: 1.0, 
        panelBlur: 20 
    };

    const ids = Object.keys(defaultConfigs).filter(key => !['bgType', 'customBgValue', 'fontTheme', 'bgOffsetX', 'bgOffsetY', 'bgZoom', 'panelBlur'].includes(key));
    
    const elements = {
        saveBtn: document.getElementById('saveBtn'), resetBtn: document.getElementById('resetBtn'), msg: document.getElementById('saveMsg'),
        isImmersiveEl: document.getElementById('isImmersive'), preloadRow: document.getElementById('preloadRow'),
        historyList: document.getElementById('historyList'), clearHistoryBtn: document.getElementById('clearHistoryBtn'),
        agreeBtn: document.getElementById('agreeBtn'), overlay: document.getElementById('disclaimerOverlay'),
        agreedStatus: document.getElementById('agreedStatus'),
        
        btnWhite: document.getElementById('setBgWhite'), btnDark: document.getElementById('setBgDark'),
        btnCustom: document.getElementById('setBgCustom'),
        customContainer: document.getElementById('customBgContainer'), customInput: document.getElementById('customBgUrl'),
        localBgBtn: document.getElementById('localBgBtn'), localBgUpload: document.getElementById('localBgUpload'),
        fontThemeSelect: document.getElementById('fontTheme'),
        editBgBtn: document.getElementById('editBgBtn'), saveBgPosBtn: document.getElementById('saveBgPosBtn'),
        
        bgImg: document.getElementById('mix01-bg-img'), 
        panelBlurInput: document.getElementById('panelBlur'),
        panelBlurVal: document.getElementById('panelBlurVal')
    };

    let currentBgOffsetX = 0, currentBgOffsetY = 0, currentBgZoom = 1.0;

    // --- Canvas 像素嗅探与色彩钳制算法 ---
    const rgbToHsl = (r, g, b) => {
        r /= 255; g /= 255; b /= 255;
        let max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max === min) { h = s = 0; }
        else {
            let d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch(max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return [h, s, l];
    };

    const hslToRgb = (h, s, l) => {
        let r, g, b;
        if (s === 0) { r = g = b = l; }
        else {
            const hue2rgb = (p, q, t) => {
                if(t < 0) t += 1; if(t > 1) t -= 1;
                if(t < 1/6) return p + (q - p) * 6 * t;
                if(t < 1/2) return q;
                if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };
            let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            let p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3);
        }
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    };

    const extractAndInjectDominantColor = (imgSrc, fontTheme) => {
        const fallbackColor = fontTheme === 'light' ? '#0056b3' : '#1da1f2';
        const applyColor = (hex) => {
            document.documentElement.style.setProperty('--primary', hex);
            document.documentElement.style.setProperty('--primary-hover', fontTheme === 'light' ? '#004494' : '#40a9ff');
        };

        if (!imgSrc || imgSrc === 'none') return applyColor(fallbackColor);

        const img = new Image();
        img.crossOrigin = "Anonymous"; 
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 50; canvas.height = 50; 
            ctx.drawImage(img, 0, 0, 50, 50);
            try {
                const data = ctx.getImageData(0, 0, 50, 50).data;
                let r = 0, g = 0, b = 0, count = 0;
                for (let i = 0; i < data.length; i += 4) {
                    r += data[i]; g += data[i+1]; b += data[i+2]; count++;
                }
                r = Math.floor(r / count); g = Math.floor(g / count); b = Math.floor(b / count);
                
                let [h, s, l] = rgbToHsl(r, g, b);
                s = Math.max(0.4, s); 
                
                if (fontTheme === 'light') { l = Math.min(0.45, l); } 
                else { l = Math.max(0.6, Math.min(0.8, l)); }
                
                const [nr, ng, nb] = hslToRgb(h, s, l);
                applyColor(`rgb(${nr}, ${ng}, ${nb})`);
            } catch(e) { applyColor(fallbackColor); }
        };
        img.onerror = () => applyColor(fallbackColor);
        img.src = imgSrc;
    };

    // --- 核心独立物理层渲染器 ---
    const applyTheme = (bgType, customVal, fontTheme, bgX, bgY, bgZ) => {
        if (!elements.bgImg) return;
        
        currentBgOffsetX = bgX; currentBgOffsetY = bgY; currentBgZoom = bgZ;
        
        if (elements.btnWhite) elements.btnWhite.classList.remove('active-bg');
        if (elements.btnDark) elements.btnDark.classList.remove('active-bg');
        if (elements.btnCustom) elements.btnCustom.classList.remove('active-bg');
        if (elements.editBgBtn) elements.editBgBtn.style.display = 'none';
        
        let targetImgSrc = 'none';

        if (bgType === 'white') {
            document.body.style.backgroundColor = '#ffffff';
            elements.bgImg.style.display = 'none';
            if (elements.btnWhite) elements.btnWhite.classList.add('active-bg');
            if (elements.customContainer) elements.customContainer.style.display = 'none';
        } else if (bgType === 'dark') {
            document.body.style.backgroundColor = '#1e1e1e';
            elements.bgImg.style.display = 'none';
            if (elements.btnDark) elements.btnDark.classList.add('active-bg');
            if (elements.customContainer) elements.customContainer.style.display = 'none';
        } else if (bgType === 'custom') {
            document.body.style.backgroundColor = '#000000';
            if (elements.btnCustom) elements.btnCustom.classList.add('active-bg');
            if (elements.customContainer) elements.customContainer.style.display = 'block';
            
            if (customVal) {
                targetImgSrc = customVal;
                elements.bgImg.src = customVal;
                elements.bgImg.style.display = 'block';
                elements.bgImg.style.transform = `translate(${bgX}px, ${bgY}px) scale(${bgZ})`;
                
                if (elements.customInput) elements.customInput.value = customVal;
                if (elements.editBgBtn) elements.editBgBtn.style.display = 'block';
            }
        }

        document.body.className = fontTheme === 'light' ? 'theme-light' : 'theme-dark';
        if (elements.fontThemeSelect) elements.fontThemeSelect.value = fontTheme;
        
        extractAndInjectDominantColor(targetImgSrc, fontTheme);
    };

    const saveAndApplyTheme = (bgType, customVal, fontTheme) => {
        chrome.storage.local.set({ bgType, customBgValue: customVal, fontTheme }, () => {
            applyTheme(bgType, customVal, fontTheme, currentBgOffsetX, currentBgOffsetY, currentBgZoom);
        });
    };

    if (elements.panelBlurInput) {
        elements.panelBlurInput.addEventListener('input', (e) => {
            const val = e.target.value;
            document.documentElement.style.setProperty('--panel-blur', `${val}px`);
            if (elements.panelBlurVal) elements.panelBlurVal.innerText = `${val}px`;
        });
        elements.panelBlurInput.addEventListener('change', (e) => {
            chrome.storage.local.set({ panelBlur: parseInt(e.target.value) });
        });
    }

    if (elements.btnWhite) elements.btnWhite.onclick = () => saveAndApplyTheme('white', '', 'light');
    if (elements.btnDark) elements.btnDark.onclick = () => saveAndApplyTheme('dark', '', 'dark');
    if (elements.btnCustom) elements.btnCustom.onclick = () => saveAndApplyTheme('custom', elements.customInput.value, elements.fontThemeSelect.value);

    if (elements.customInput) {
        elements.customInput.onchange = (e) => saveAndApplyTheme('custom', e.target.value.trim(), elements.fontThemeSelect.value);
    }
    
    if (elements.fontThemeSelect) {
        elements.fontThemeSelect.onchange = (e) => {
            const currentBgType = elements.btnWhite.classList.contains('active-bg') ? 'white' : 
                                 (elements.btnDark.classList.contains('active-bg') ? 'dark' : 'custom');
            saveAndApplyTheme(currentBgType, elements.customInput.value, e.target.value);
        };
    }

    if (elements.localBgBtn && elements.localBgUpload) {
        elements.localBgBtn.onclick = () => elements.localBgUpload.click();
        elements.localBgUpload.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    let w = img.width, h = img.height;
                    const maxDim = 1920;
                    if (w > maxDim || h > maxDim) {
                        if (w > h) { h = (h / w) * maxDim; w = maxDim; }
                        else { w = (w / h) * maxDim; h = maxDim; }
                    }
                    canvas.width = w; canvas.height = h;
                    ctx.drawImage(img, 0, 0, w, h);
                    const compressedBase64 = canvas.toDataURL('image/jpeg', 0.85);
                    saveAndApplyTheme('custom', compressedBase64, elements.fontThemeSelect.value);
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        };
    }

    // --- 🚀【黑科技 2】无限物理画布拖拽引擎 (Edit Mode) ---
    let isEditingBg = false, isDragging = false;
    let startMouseX, startMouseY, startBgX, startBgY;

    if (elements.editBgBtn) {
        elements.editBgBtn.onclick = () => {
            document.body.classList.add('bg-edit-mode');
            if (elements.bgImg) elements.bgImg.style.transition = 'none'; 
            isEditingBg = true;
        };
    }

    if (elements.saveBgPosBtn) {
        elements.saveBgPosBtn.onclick = () => {
            document.body.classList.remove('bg-edit-mode');
            if (elements.bgImg) elements.bgImg.style.transition = 'transform 0.1s ease-out';
            isEditingBg = false;
            chrome.storage.local.set({ bgOffsetX: currentBgOffsetX, bgOffsetY: currentBgOffsetY, bgZoom: currentBgZoom });
        };
    }

    document.addEventListener('wheel', (e) => {
        if (!isEditingBg || !elements.bgImg) return;
        e.preventDefault(); 
        const zoomSpeed = 0.05; 
        const delta = e.deltaY > 0 ? -zoomSpeed : zoomSpeed;
        
        currentBgZoom = Math.max(0.5, Math.min(8.0, currentBgZoom + delta));
        elements.bgImg.style.transform = `translate(${currentBgOffsetX}px, ${currentBgOffsetY}px) scale(${currentBgZoom})`;
    }, { passive: false });

    document.addEventListener('mousedown', (e) => {
        if (!isEditingBg || e.target === elements.saveBgPosBtn) return;
        isDragging = true;
        startMouseX = e.clientX; startMouseY = e.clientY;
        startBgX = currentBgOffsetX; startBgY = currentBgOffsetY;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || !elements.bgImg) return;
        
        // 🚀 核心修复：引入缩放阻尼除以 currentBgZoom，保证就算放大到 8 倍，鼠标拖动时画面依然 1:1 绝对跟手，不会“滑飞”！
        const deltaX = (e.clientX - startMouseX) / currentBgZoom;
        const deltaY = (e.clientY - startMouseY) / currentBgZoom;
        
        currentBgOffsetX = startBgX + deltaX;
        currentBgOffsetY = startBgY + deltaY;

        elements.bgImg.style.transform = `translate(${currentBgOffsetX}px, ${currentBgOffsetY}px) scale(${currentBgZoom})`;
    });

    document.addEventListener('mouseup', () => { isDragging = false; });
    document.addEventListener('mouseleave', () => { isDragging = false; });

    // --- 界面流体与历史记录逻辑 ---
    document.querySelector('.tabs').addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-btn')) {
            document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
            e.target.classList.add('active');
            const targetContent = document.getElementById(e.target.dataset.target);
            if (targetContent) targetContent.classList.add('active');
        }
    });

    const updateViewModeUI = () => {
        if (!elements.preloadRow) return;
        if (elements.isImmersiveEl && elements.isImmersiveEl.checked) { 
            elements.preloadRow.style.opacity = '1'; elements.preloadRow.style.pointerEvents = 'auto'; 
        } else { 
            elements.preloadRow.style.opacity = '0.4'; elements.preloadRow.style.pointerEvents = 'none'; 
        }
    };
    if (elements.isImmersiveEl) elements.isImmersiveEl.addEventListener('change', updateViewModeUI);

    const escapeHTML = (str) => { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; };

    const renderHistory = () => {
        if (!elements.historyList) return;
        chrome.storage.local.get(['mix01_download_history'], ({ mix01_download_history }) => {
            const history = mix01_download_history || [];
            if (history.length === 0) {
                elements.historyList.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px 0;">暂无提取记录</div>';
                return;
            }
            elements.historyList.innerHTML = history.map(item => {
                const isSuccess = item.status.includes('成功');
                const color = isSuccess ? 'var(--success-color)' : 'var(--danger-color)';
                return `
                    <div class="history-item">
                        <div class="history-item-header">
                            <strong style="color: ${color}; margin-right: 8px;">${escapeHTML(item.status)}</strong> 
                            <span style="color: var(--text-muted);">${escapeHTML(item.time)}</span>
                        </div>
                        <div style="font-family: ui-monospace, monospace; word-break: break-all;">${escapeHTML(item.filename)}</div>
                    </div>
                `;
            }).join('');
        });
    };

    // --- 初始化读取 ---
    chrome.storage.local.get([...ids, 'bgType', 'customBgValue', 'fontTheme', 'bgOffsetX', 'bgOffsetY', 'bgZoom', 'panelBlur', 'hasAgreed'], (res) => {
        if (elements.overlay && elements.agreedStatus) {
            if (!res.hasAgreed) elements.overlay.style.display = 'flex';
            else elements.agreedStatus.style.display = 'block';
        }

        const blurVal = res.panelBlur !== undefined ? res.panelBlur : defaultConfigs.panelBlur;
        document.documentElement.style.setProperty('--panel-blur', `${blurVal}px`);
        if (elements.panelBlurInput) elements.panelBlurInput.value = blurVal;
        if (elements.panelBlurVal) elements.panelBlurVal.innerText = `${blurVal}px`;

        applyTheme(
            res.bgType || defaultConfigs.bgType, 
            res.customBgValue !== undefined ? res.customBgValue : defaultConfigs.customBgValue, 
            res.fontTheme || defaultConfigs.fontTheme,
            res.bgOffsetX !== undefined ? res.bgOffsetX : defaultConfigs.bgOffsetX,
            res.bgOffsetY !== undefined ? res.bgOffsetY : defaultConfigs.bgOffsetY,
            res.bgZoom !== undefined ? res.bgZoom : defaultConfigs.bgZoom
        );

        ids.forEach(id => {
            const val = res[id] !== undefined ? res[id] : defaultConfigs[id];
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = val;
            else el.value = val;
        });
        updateViewModeUI(); 
    });

    renderHistory(); 

    if (elements.agreeBtn) {
        elements.agreeBtn.addEventListener('click', () => { 
            chrome.storage.local.set({ hasAgreed: true }, () => { 
                if (elements.overlay) elements.overlay.style.display = 'none'; 
                if (elements.agreedStatus) elements.agreedStatus.style.display = 'block'; 
            }); 
        });
    }

    if (elements.saveBtn) {
        elements.saveBtn.addEventListener('click', () => {
            const data = {};
            ids.forEach(id => {
                const el = document.getElementById(id); 
                if (!el) return;
                if (el.type === 'checkbox') data[id] = el.checked;
                else { 
                    let val = el.value.trim(); 
                    if (val === '') val = defaultConfigs[id]; 
                    if (el.type === 'text' && id !== 'base64Domains') val = val.toLowerCase(); 
                    if (el.type === 'number') val = parseFloat(val); 
                    data[id] = val;
                }
            });

            const origText = elements.saveBtn.innerText;
            elements.saveBtn.innerText = '正在写入...';
            chrome.storage.local.set(data, () => { 
                elements.saveBtn.innerText = origText;
                if (elements.msg) {
                    elements.msg.style.display = 'block'; 
                    setTimeout(() => elements.msg.style.display = 'none', 2000); 
                }
            });
        });
    }

    if (elements.resetBtn) {
        elements.resetBtn.addEventListener('click', () => { 
            if(confirm("确定要恢复引擎到初始状态吗？")) {
                chrome.storage.local.set(defaultConfigs, () => window.location.reload()); 
            }
        });
    }

    if (elements.clearHistoryBtn) {
        elements.clearHistoryBtn.addEventListener('click', () => {
            if(confirm("将清除所有媒体提取记录，确认执行？")) {
                chrome.storage.local.set({ mix01_download_history: [] }, () => {
                    renderHistory();
                    const origText = elements.clearHistoryBtn.innerText;
                    elements.clearHistoryBtn.innerText = "已清空";
                    setTimeout(() => elements.clearHistoryBtn.innerText = origText, 1500);
                });
            }
        });
    }
});