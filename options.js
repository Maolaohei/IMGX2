const defaultConfigs = { 
    hasAgreed: false, 
    loadHD: 'true', 
    breakoutView: false, 
    showStatus: true, 
    smallImageOptimization: true, 
    zoomLevel: 2.0, 
    isImmersive: false, // 沉浸模式默认参数
    mode: 'partial', 
    keyMode: 'v', 
    keyRotate: 'r', 
    keyMirror: 'm', 
    keyZoomIn: '=', 
    keyZoomOut: '-',
    keyImmersive: 'ctrl+f12' // 沉浸模式快捷键默认参数
};
const ids = Object.keys(defaultConfigs);
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const agreeBtn = document.getElementById('agreeBtn');
const overlay = document.getElementById('disclaimerOverlay');
const agreedStatus = document.getElementById('agreedStatus');
const msg = document.getElementById('saveMsg');

// 模式屏蔽交互
const isImmersiveEl = document.getElementById('isImmersive');
const viewModeRow = document.getElementById('viewModeRow');
function updateViewModeUI() {
    if (isImmersiveEl.checked) {
        viewModeRow.style.opacity = '0.4';
        viewModeRow.style.pointerEvents = 'none';
    } else {
        viewModeRow.style.opacity = '1';
        viewModeRow.style.pointerEvents = 'auto';
    }
}
isImmersiveEl.addEventListener('change', updateViewModeUI);

chrome.storage.local.get(ids, (res) => {
    if (!res.hasAgreed) overlay.style.display = 'flex';
    else agreedStatus.style.display = 'block';
    ids.forEach(id => {
        const val = (res[id] !== undefined) ? res[id] : defaultConfigs[id];
        const el = document.getElementById(id); if (!el) return;
        if (el.type === 'checkbox') el.checked = val; else el.value = val;
    });
    updateViewModeUI(); // 初始化 UI 状态
});

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