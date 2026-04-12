// options.js
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
    keyTriple: 'q'           
};

const ids = Object.keys(defaultConfigs);
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const agreeBtn = document.getElementById('agreeBtn');
const overlay = document.getElementById('disclaimerOverlay');
const agreedStatus = document.getElementById('agreedStatus');
const msg = document.getElementById('saveMsg');
const isImmersiveEl = document.getElementById('isImmersive');
const viewModeRow = document.getElementById('viewModeRow');
const preloadRow = document.getElementById('preloadRow');

const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

function updateViewModeUI() {
    if (isImmersiveEl.checked) {
        viewModeRow.style.opacity = '0.4';
        viewModeRow.style.pointerEvents = 'none';
        preloadRow.style.opacity = '1';
        preloadRow.style.pointerEvents = 'auto';
    } else {
        viewModeRow.style.opacity = '1';
        viewModeRow.style.pointerEvents = 'auto';
        preloadRow.style.opacity = '0.4';
        preloadRow.style.pointerEvents = 'none';
    }
}
isImmersiveEl.addEventListener('change', updateViewModeUI);

function renderHistory() {
    chrome.storage.local.get(['mix01_download_history'], (res) => {
        const history = res.mix01_download_history || [];
        if (history.length === 0) {
            historyList.innerHTML = '<div style="color: #888; text-align: center; padding: 15px;">暂无记录</div>';
            return;
        }
        historyList.innerHTML = history.map(item => `
            <div class="history-item">
                <strong style="color: ${item.status.includes('成功') ? '#4CAF50' : '#F44336'}">${item.status}</strong> 
                <span style="color: #999; margin-left: 5px;">${item.time}</span><br>
                <div style="color: #333; margin-top: 3px;">${item.filename}</div>
            </div>
        `).join('');
    });
}

chrome.storage.local.get(ids, (res) => {
    if (!res.hasAgreed) overlay.style.display = 'flex';
    else agreedStatus.style.display = 'block';
    ids.forEach(id => {
        const val = (res[id] !== undefined) ? res[id] : defaultConfigs[id];
        const el = document.getElementById(id); if (!el) return;
        if (el.type === 'checkbox') el.checked = val; else el.value = val;
    });
    updateViewModeUI(); 
});

renderHistory(); 

agreeBtn.addEventListener('click', () => { chrome.storage.local.set({ hasAgreed: true }, () => { overlay.style.display = 'none'; agreedStatus.style.display = 'block'; }); });

saveBtn.addEventListener('click', () => {
    const data = {};
    ids.forEach(id => {
        const el = document.getElementById(id); if (!el) return;
        let val; if (el.type === 'checkbox') val = el.checked;
        else { val = el.value.trim(); if (val === '') val = defaultConfigs[id]; if (el.type === 'text') val = val.toLowerCase(); if (el.type === 'number') val = parseFloat(val); }
        data[id] = val;
    });
    chrome.storage.local.set(data, () => { msg.style.display = 'block'; setTimeout(() => { msg.style.display = 'none'; }, 1500); });
});

resetBtn.addEventListener('click', () => { chrome.storage.local.set({ ...defaultConfigs, hasAgreed: true }, () => { window.location.reload(); }); });

clearHistoryBtn.addEventListener('click', () => {
    chrome.storage.local.set({ mix01_download_history: [] }, () => {
        renderHistory();
        msg.innerText = "✓ 历史记录已清空！";
        msg.style.display = 'block'; setTimeout(() => { msg.style.display = 'none'; msg.innerText = "✓ 操作成功！"; }, 1500);
    });
});