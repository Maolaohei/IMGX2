// options.js - Mix01 引擎配置控制器 v3.3 Complete
document.addEventListener('DOMContentLoaded', () => {

    const defaultConfigs = {
        loadHD: 'true', breakoutView: false, showStatus: true, smallImageOptimization: true,
        disableVideoDefaultView: true, zoom: 2.0, isImmersive: false, mode: 'partial',
        preloadCount: 5, wheelZoomEnabled: false,
        minZoomSize: 0, triggerDelay: 0, excludeSelectors: '',
        keyMode: 'v', keyRotate: 'r', keyMirror: 'm', keyZoomIn: '=', keyZoomOut: '-',
        keyImmersive: 'ctrl+f12', keyLike: 'l', keyFollow: 'f',
        keyPlayVideo: 'space', keyDownloadVideo: 'd',
        keyDouble: 's', keyTriple: 'q',
        keyOpenInTab: 'o',  
        base64Domains: '',
        bgType: 'dark', customBgValue: '', fontTheme: 'dark',
        bgOffsetX: 0, bgOffsetY: 0, bgZoom: 1.0, panelBlur: 20
    };

    const advancedKeys = ['bgType', 'customBgValue', 'fontTheme', 'bgOffsetX', 'bgOffsetY', 'bgZoom', 'panelBlur'];
    const textareaKeys = ['excludeSelectors'];
    const ids = Object.keys(defaultConfigs).filter(key => !advancedKeys.includes(key) && !textareaKeys.includes(key));
    const el = (id) => document.getElementById(id);

    const elements = {
        saveBtn: el('saveBtn'), resetBtn: el('resetBtn'), msg: el('saveMsg'),
        isImmersiveEl: el('isImmersive'), preloadRow: el('preloadRow'),
        historyList: el('historyList'), clearHistoryBtn: el('clearHistoryBtn'),
        agreeBtn: el('agreeBtn'), overlay: el('disclaimerOverlay'),
        agreedStatus: el('agreedStatus'),
        btnWhite: el('setBgWhite'), btnDark: el('setBgDark'), btnCustom: el('setBgCustom'),
        customContainer: el('customBgContainer'), customInput: el('customBgUrl'),
        localBgBtn: el('localBgBtn'), localBgUpload: el('localBgUpload'),
        fontThemeSelect: el('fontTheme'), editBgBtn: el('editBgBtn'), saveBgPosBtn: el('saveBgPosBtn'),
        bgImg: el('mix01-bg-img'), panelBlurInput: el('panelBlur'), panelBlurVal: el('panelBlurVal'),
        currentSiteHostname: el('currentSiteHostname'), currentSiteBadge: el('currentSiteBadge'),
        siteToggleBtn: el('siteToggleBtn'), disabledSitesList: el('disabledSitesList'),
        manualSiteInput: el('manualSiteInput'), manualSiteAddBtn: el('manualSiteAddBtn'),
        siteModesList: el('siteModesList'),
    };

    let currentBgOffsetX = 0, currentBgOffsetY = 0, currentBgZoom = 1.0;
    let disabledSites = {};  
    let cachedCurrentTabHostname = ''; // 🚀 静态数据缓存

    const initCurrentTabHost = () => {
        return new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                try { 
                    const url = new URL(tabs[0]?.url || '');
                    // 🚀 过滤掉扩展程序自身的控制台页面协议，防止误判
                    if (url.protocol === 'chrome-extension:') {
                        cachedCurrentTabHostname = '';
                    } else {
                        cachedCurrentTabHostname = url.hostname; 
                    }
                } catch (e) { 
                    cachedCurrentTabHostname = ''; 
                }
                if (elements.currentSiteHostname) {
                    elements.currentSiteHostname.textContent = cachedCurrentTabHostname || '（控制台配置页，不支持配置禁用）';
                }
                resolve(cachedCurrentTabHostname);
            });
        });
    };

    const refreshCurrentSiteUI = () => {
        const host = cachedCurrentTabHostname;
        if (!host) {
            if (elements.currentSiteBadge) {
                elements.currentSiteBadge.textContent = '● 系统页面';
                elements.currentSiteBadge.className = 'site-status-badge disabled';
            }
            if (elements.siteToggleBtn) {
                elements.siteToggleBtn.textContent = '🚫 系统内页不可禁用';
                elements.siteToggleBtn.className = 'site-toggle-btn disabled';
                elements.siteToggleBtn.onclick = null;
            }
            return;
        }
        const isEnabled = !disabledSites[host];
        if (elements.currentSiteBadge) {
            elements.currentSiteBadge.textContent = isEnabled ? '● 已启用' : '● 已禁用';
            elements.currentSiteBadge.className = `site-status-badge ${isEnabled ? 'enabled' : 'disabled'}`;
        }
        if (elements.siteToggleBtn) {
            elements.siteToggleBtn.textContent = isEnabled ? '🚫 在此站点禁用引擎' : '✅ 在此站点启用引擎';
            elements.siteToggleBtn.className = isEnabled ? 'site-toggle-btn to-disable' : 'site-toggle-btn to-enable';
            elements.siteToggleBtn.onclick = () => {
                if (disabledSites[host]) delete disabledSites[host];
                else disabledSites[host] = true;
                chrome.storage.local.set({ disabledSites }, () => {
                    renderDisabledSites();
                    refreshCurrentSiteUI();
                });
            };
        }
    };

    const renderDisabledSites = () => {
        if (!elements.disabledSitesList) return;
        const hosts = Object.keys(disabledSites).filter(h => disabledSites[h]);
        if (hosts.length === 0) {
            elements.disabledSitesList.innerHTML = '<div class="sites-empty">暂无禁用站点 —— 引擎在所有站点均处于激活状态</div>';
            return;
        }
        elements.disabledSitesList.innerHTML = hosts.map(host => `
            <div class="disabled-site-item">
                <span class="site-name">${escapeHTML(host)}</span>
                <button class="remove-btn" data-host="${escapeHTML(host)}" title="重新启用">✕</button>
            </div>
        `).join('');
        elements.disabledSitesList.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.dataset.host;
                delete disabledSites[host];
                chrome.storage.local.set({ disabledSites }, () => {
                    renderDisabledSites();
                    refreshCurrentSiteUI();
                });
            });
        });
    };

    const rgbToHsl = (r, g, b) => {
        r /= 255; g /= 255; b /= 255;
        let max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max === min) { h = s = 0; }
        else {
            let d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
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
                if (t < 0) t += 1; if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
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
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 50; canvas.height = 50;
            ctx.drawImage(img, 0, 0, 50, 50);
            try {
                const data = ctx.getImageData(0, 0, 50, 50).data;
                let r = 0, g = 0, b = 0, count = 0;
                for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; count++; }
                r = Math.floor(r / count); g = Math.floor(g / count); b = Math.floor(b / count);
                let [h, s, l] = rgbToHsl(r, g, b);
                s = Math.max(0.4, s);
                if (fontTheme === 'light') { l = Math.min(0.45, l); }
                else { l = Math.max(0.6, Math.min(0.8, l)); }
                const [nr, ng, nb] = hslToRgb(h, s, l);
                applyColor(`rgb(${nr}, ${ng}, ${nb})`);
            } catch (e) { applyColor(fallbackColor); }
        };
        img.onerror = () => applyColor(fallbackColor);
        img.src = imgSrc;
    };

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
    if (elements.customInput) elements.customInput.onchange = (e) => saveAndApplyTheme('custom', e.target.value.trim(), elements.fontThemeSelect.value);
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
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    let w = img.width, h = img.height;
                    const maxDim = 1920;
                    if (w > maxDim || h > maxDim) { if (w > h) { h = (h / w) * maxDim; w = maxDim; } else { w = (w / h) * maxDim; h = maxDim; } }
                    canvas.width = w; canvas.height = h;
                    ctx.drawImage(img, 0, 0, w, h);
                    saveAndApplyTheme('custom', canvas.toDataURL('image/jpeg', 0.85), elements.fontThemeSelect.value);
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        };
    }

    let isEditingBg = false, isDragging = false;
    let startMouseX, startMouseY, startBgX, startBgY;
    if (elements.editBgBtn) elements.editBgBtn.onclick = () => { document.body.classList.add('bg-edit-mode'); if (elements.bgImg) elements.bgImg.style.transition = 'none'; isEditingBg = true; };
    if (elements.saveBgPosBtn) elements.saveBgPosBtn.onclick = () => { document.body.classList.remove('bg-edit-mode'); if (elements.bgImg) elements.bgImg.style.transition = 'transform 0.1s ease-out'; isEditingBg = false; chrome.storage.local.set({ bgOffsetX: currentBgOffsetX, bgOffsetY: currentBgOffsetY, bgZoom: currentBgZoom }); };
    document.addEventListener('wheel', (e) => { if (!isEditingBg || !elements.bgImg) return; e.preventDefault(); const delta = e.deltaY > 0 ? -0.05 : 0.05; currentBgZoom = Math.max(0.5, Math.min(8.0, currentBgZoom + delta)); elements.bgImg.style.transform = `translate(${currentBgOffsetX}px, ${currentBgOffsetY}px) scale(${currentBgZoom})`; }, { passive: false });
    document.addEventListener('mousedown', (e) => { if (!isEditingBg || e.target === elements.saveBgPosBtn) return; isDragging = true; startMouseX = e.clientX; startMouseY = e.clientY; startBgX = currentBgOffsetX; startBgY = currentBgOffsetY; });
    document.addEventListener('mousemove', (e) => { if (!isDragging || !elements.bgImg) return; const deltaX = (e.clientX - startMouseX) / currentBgZoom; const deltaY = (e.clientY - startMouseY) / currentBgZoom; currentBgOffsetX = startBgX + deltaX; currentBgOffsetY = startBgY + deltaY; elements.bgImg.style.transform = `translate(${currentBgOffsetX}px, ${currentBgOffsetY}px) scale(${currentBgZoom})`; });
    document.addEventListener('mouseup', () => { isDragging = false; });
    document.addEventListener('mouseleave', () => { isDragging = false; });

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
                return `<div class="history-item">
                    <div class="history-item-header">
                        <strong style="color: ${color}; margin-right: 8px;">${escapeHTML(item.status)}</strong>
                        <span style="color: var(--text-muted);">${escapeHTML(item.time)}</span>
                    </div>
                    <div style="font-family: ui-monospace, monospace; word-break: break-all;">${escapeHTML(item.filename)}</div>
                </div>`;
            }).join('');
        });
    };

    const renderSiteModes = (siteModes) => {
        if (!elements.siteModesList) return;
        const entries = Object.entries(siteModes || {});
        if (entries.length === 0) {
            elements.siteModesList.innerHTML = '<span style="color:var(--text-muted);font-size:12px;">暂无站点独立视图记忆 —— 所有站点使用全局默认模式</span>';
            return;
        }
        const modeLabels = { 'partial': '🔍 局部放大', 'full-follow': '🖼️ 整体跟随' };
        elements.siteModesList.innerHTML = entries.map(([host, mode]) => `
            <div class="disabled-site-item">
                <span class="site-name">${escapeHTML(host)}</span>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size:11px; color:var(--primary);">${modeLabels[mode] || mode}</span>
                    <button class="remove-btn clear-site-mode-btn" data-host="${escapeHTML(host)}" title="恢复全局默认" style="background:none; border:none; color:var(--danger-color); cursor:pointer; font-size:14px; line-height:1;">✕</button>
                </div>
            </div>
        `).join('');

        // 🚀 核心修复：允许用户手动点击 ✕ 清除该站点的偏好记忆，使其退回到“默认视图模式”
        elements.siteModesList.querySelectorAll('.clear-site-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.dataset.host;
                chrome.storage.local.get(['siteModes'], (res) => {
                    const currentModes = res.siteModes || {};
                    delete currentModes[host];
                    chrome.storage.local.set({ siteModes: currentModes }, () => {
                        renderSiteModes(currentModes);
                        if (host === cachedCurrentTabHostname) {
                            refreshCurrentSiteUI();
                        }
                    });
                });
            });
        });
    };

    if (elements.manualSiteAddBtn && elements.manualSiteInput) {
        elements.manualSiteAddBtn.onclick = () => {
            const val = elements.manualSiteInput.value.trim().toLowerCase();
            if (!val) return;
            if (val.includes('.') && !disabledSites[val]) {
                disabledSites[val] = true;
                chrome.storage.local.set({ disabledSites }, () => {
                    elements.manualSiteInput.value = '';
                    renderDisabledSites();
                    refreshCurrentSiteUI();
                });
            }
        };
    }

    async function initAll() {
        await initCurrentTabHost(); 

        chrome.storage.local.get(
            [...ids, ...textareaKeys, 'bgType', 'customBgValue', 'fontTheme', 'bgOffsetX', 'bgOffsetY', 'bgZoom', 'panelBlur', 'hasAgreed', 'disabledSites', 'siteModes'],
            (res) => {
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
                    const targetId = id === 'zoom' ? 'zoomLevel' : id;
                    const inputEl = document.getElementById(targetId);
                    if (!inputEl) return;
                    if (inputEl.type === 'checkbox') inputEl.checked = val;
                    else inputEl.value = val;
                });

                textareaKeys.forEach(id => {
                    const val = res[id] !== undefined ? res[id] : (defaultConfigs[id] || '');
                    const inputEl = document.getElementById(id);
                    if (inputEl) inputEl.value = val;
                });

                updateViewModeUI();

                disabledSites = res.disabledSites || {};
                renderDisabledSites();
                refreshCurrentSiteUI(); 
                renderSiteModes(res.siteModes || {});
            }
        );
    }

    initAll();
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
                const targetId = id === 'zoom' ? 'zoomLevel' : id;
                const inputEl = document.getElementById(targetId);
                if (!inputEl) return;
                if (inputEl.type === 'checkbox') {
                    data[id] = inputEl.checked;
                } else {
                    let val = inputEl.value.trim();
                    if (val === '') val = defaultConfigs[id];
                    if (inputEl.type === 'text' && id !== 'base64Domains') val = val.toLowerCase();
                    if (inputEl.type === 'number' || id === 'zoom') val = parseFloat(val);
                    data[id] = val;
                }
            });
            textareaKeys.forEach(id => {
                const inputEl = document.getElementById(id);
                if (inputEl) data[id] = inputEl.value.trim();
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
            if (confirm('确定要恢复引擎到初始状态吗？（站点管理数据将保留）')) {
                chrome.storage.local.set(defaultConfigs, () => window.location.reload());
            }
        });
    }

    if (elements.clearHistoryBtn) {
        elements.clearHistoryBtn.addEventListener('click', () => {
            if (confirm('将清除所有媒体提取记录，确认执行？')) {
                chrome.storage.local.set({ mix01_download_history: [] }, () => {
                    renderHistory();
                    const origText = elements.clearHistoryBtn.innerText;
                    elements.clearHistoryBtn.innerText = '已清空';
                    setTimeout(() => elements.clearHistoryBtn.innerText = origText, 1500);
                });
            }
        });
    }
});