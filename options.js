// options.js - Mix01 引擎配置控制器 (Gemini 终极版)

document.addEventListener('DOMContentLoaded', () => {
    const defaultConfigs = { 
        hasAgreed: false, 
        loadHD: 'true', 
        breakoutView: false, 
        showStatus: true, 
        smallImageOptimization: true, 
        disableVideoDefaultView: true,
        zoomLevel: 2.0, 
        isImmersive: false, 
        mode: 'partial', 
        preloadCount: 5, 
        keyMode: 'v', 
        wheelZoomEnabled: false, 
        keyRotate: 'r', 
        keyMirror: 'm', 
        keyZoomIn: '=', 
        keyZoomOut: '-',
        keyImmersive: 'ctrl+f12',
        keyLike: 'l',
        keyFollow: 'f',
        keyPlayVideo: 'space',   
        keyDownloadVideo: 'd',
        keyDouble: 's',          
        keyTriple: 'q',
        base64Domains: '' 
    };

    const ids = Object.keys(defaultConfigs);
    
    // DOM 元素引用
    const elements = {
        saveBtn: document.getElementById('saveBtn'),
        resetBtn: document.getElementById('resetBtn'),
        agreeBtn: document.getElementById('agreeBtn'),
        overlay: document.getElementById('disclaimerOverlay'),
        agreedStatus: document.getElementById('agreedStatus'),
        msg: document.getElementById('saveMsg'),
        isImmersiveEl: document.getElementById('isImmersive'),
        viewModeRow: document.getElementById('viewModeRow'), // 注意：新版 HTML 中如果去掉了 ID，请用选择器获取，此处兼容老逻辑处理
        preloadRow: document.getElementById('preloadRow'),
        historyList: document.getElementById('historyList'),
        clearHistoryBtn: document.getElementById('clearHistoryBtn')
    };

    // --- 标签页流体切换 ---
    document.querySelector('.tabs').addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-btn')) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            e.target.classList.add('active');
            document.getElementById(e.target.dataset.target).classList.add('active');
        }
    });

    // --- UI 联动逻辑 ---
    const updateViewModeUI = () => {
        if (!elements.preloadRow) return; // 防御性判断
        if (elements.isImmersiveEl.checked) {
            elements.preloadRow.style.opacity = '1';
            elements.preloadRow.style.pointerEvents = 'auto';
        } else {
            elements.preloadRow.style.opacity = '0.4';
            elements.preloadRow.style.pointerEvents = 'none';
        }
    };
    elements.isImmersiveEl.addEventListener('change', updateViewModeUI);

    // --- 安全的 DOM 渲染器 (防 XSS) ---
    const escapeHTML = (str) => {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };

    const renderHistory = () => {
        chrome.storage.local.get(['mix01_download_history'], ({ mix01_download_history }) => {
            const history = mix01_download_history || [];
            if (history.length === 0) {
                elements.historyList.innerHTML = '<div style="color: #8E8E93; text-align: center; padding: 20px 0;">暂无提取记录</div>';
                return;
            }
            
            elements.historyList.innerHTML = history.map(item => {
                const isSuccess = item.status.includes('成功');
                const color = isSuccess ? '#34C759' : '#FF3B30';
                return `
                    <div class="history-item">
                        <div class="history-item-header">
                            <strong style="color: ${color}">${escapeHTML(item.status)}</strong> 
                            <span style="color: #8E8E93;">${escapeHTML(item.time)}</span>
                        </div>
                        <div style="color: #1C1C1E; font-family: ui-monospace, monospace;">${escapeHTML(item.filename)}</div>
                    </div>
                `;
            }).join('');
        });
    };

    // --- 初始化数据加载 ---
    chrome.storage.local.get(ids, (res) => {
        if (!res.hasAgreed) {
            elements.overlay.style.display = 'flex';
        } else {
            elements.agreedStatus.style.display = 'block';
        }

        ids.forEach(id => {
            const val = res[id] !== undefined ? res[id] : defaultConfigs[id];
            const el = document.getElementById(id);
            if (!el) return;
            
            if (el.type === 'checkbox') {
                el.checked = val;
            } else {
                el.value = val;
            }
        });
        
        updateViewModeUI(); 
    });

    renderHistory(); 

    // --- 事件绑定 ---
    elements.agreeBtn.addEventListener('click', () => { 
        chrome.storage.local.set({ hasAgreed: true }, () => { 
            elements.overlay.style.display = 'none'; 
            elements.agreedStatus.style.display = 'block'; 
        }); 
    });

    elements.saveBtn.addEventListener('click', () => {
        const data = {};
        ids.forEach(id => {
            const el = document.getElementById(id); 
            if (!el) return;
            
            if (el.type === 'checkbox') {
                data[id] = el.checked;
            } else { 
                let val = el.value.trim(); 
                if (val === '') val = defaultConfigs[id]; 
                if (el.type === 'text' && id !== 'base64Domains') val = val.toLowerCase(); 
                if (el.type === 'number') val = parseFloat(val); 
                data[id] = val;
            }
        });

        // 按钮状态反馈
        const originalText = elements.saveBtn.innerText;
        elements.saveBtn.innerText = '正在写入...';
        
        chrome.storage.local.set(data, () => { 
            elements.saveBtn.innerText = originalText;
            elements.msg.style.display = 'block'; 
            setTimeout(() => { elements.msg.style.display = 'none'; }, 2000); 
        });
    });

    elements.resetBtn.addEventListener('click', () => { 
        if(confirm("确定要恢复引擎到初始状态吗？（历史记录不会被清除）")) {
            chrome.storage.local.set({ ...defaultConfigs, hasAgreed: true }, () => { 
                window.location.reload(); 
            }); 
        }
    });

    elements.clearHistoryBtn.addEventListener('click', () => {
        if(confirm("将清除所有媒体提取记录，确认执行？")) {
            chrome.storage.local.set({ mix01_download_history: [] }, () => {
                renderHistory();
                const originalText = elements.clearHistoryBtn.innerText;
                elements.clearHistoryBtn.innerText = "已清空";
                setTimeout(() => { elements.clearHistoryBtn.innerText = originalText; }, 1500);
            });
        }
    });
});