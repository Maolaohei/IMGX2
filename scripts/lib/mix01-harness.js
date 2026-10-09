// scripts/lib/mix01-harness.js
// Mix01 测试基座（e2e / perf 共用）：
//   * 用 playwright 启动本机真实 Chrome（MIX01_CHROME_PATH 可覆盖，其次 Edge）
//   * 用 route 把 https://x.com/... 伪装为本地同源页面（location.hostname === 'x.com'，无需网络）
//   * 注入内存版 chrome.* Mock，真实 mesasge 总线语义连接 content 侧与 background 侧
//   * 按 manifest 顺序注入真实源码，并按 content.js 的方式装配引擎
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');

// 与 manifest.json content_scripts.js 顺序保持一致（不含 content.js，避免 MV3 端口依赖）
const MIX01_SCRIPTS = [
    'rules-engine.js',
    'immersive-rules.js',
    'Basic/Utils.js',
    'Basic/ConfigManager.js',
    'Basic/mediaIdentity.js',
    'Basic/MediaRenderer.js',
    'Basic/InputController.js'
];

function findBrowserExecutable() {
    const candidates = [
        process.env.MIX01_CHROME_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe') : null,
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    ].filter(Boolean);
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
    }
    return null;
}

function describeBrowser(exe) {
    return exe || 'channel:chrome';
}

async function launchHarnessBrowser() {
    const exe = findBrowserExecutable();
    const browser = await chromium.launch(
        exe ? { executablePath: exe, headless: true } : { channel: 'chrome', headless: true }
    );
    return { browser, exe };
}

// 页内 chrome.* Mock（作为独立函数传入 page.evaluate，不能引用 Node 侧变量）
function installChromeMockInPage() {
    const harness = window.__harness = {
        createdMenus: [],
        onMessageListeners: [],
        installedListeners: [],
        startupListeners: [],
        menuClickListeners: [],
        downloaded: [],
        createdTabs: [],
        tabMessageLog: [],
        errors: [],
        failNextTabMessage: false,
        storageLocal: {},
        storageSession: {}
    };

    const makeArea = (store) => ({
        get(keys, cb) {
            let res = {};
            if (keys == null) res = Object.assign({}, store);
            else if (typeof keys === 'string') { if (keys in store) res[keys] = store[keys]; }
            else if (Array.isArray(keys)) { for (const k of keys) if (k in store) res[k] = store[k]; }
            else if (typeof keys === 'object') { for (const k in keys) res[k] = (k in store) ? store[k] : keys[k]; }
            if (cb) { cb(res); return undefined; }
            return Promise.resolve(res);
        },
        set(obj, cb) {
            Object.assign(store, obj);
            if (cb) { cb(); return undefined; }
            return Promise.resolve();
        }
    });

    const deliverToRuntimeListeners = (msg, sender, respond) => {
        let done = false;
        const sendResponse = (value) => { if (!done) { done = true; if (respond) respond(value); } };
        for (const fn of harness.onMessageListeners) {
            try { fn(msg, sender || { id: 'mix01-harness' }, sendResponse); }
            catch (e) { harness.errors.push('onMessage: ' + (e && e.message || e)); }
        }
    };
    window.__deliverRuntimeMessage = deliverToRuntimeListeners;

    window.chrome = {
        runtime: {
            id: 'mix01-harness',
            lastError: undefined,
            getURL: (p) => 'chrome-extension://mix01-harness/' + (p || ''),
            getManifest: () => ({ version: 'harness' }),
            onMessage: {
                addListener: (fn) => harness.onMessageListeners.push(fn),
                removeListener: (fn) => {
                    const i = harness.onMessageListeners.indexOf(fn);
                    if (i >= 0) harness.onMessageListeners.splice(i, 1);
                }
            },
            onInstalled: { addListener: (fn) => harness.installedListeners.push(fn) },
            onStartup: { addListener: (fn) => harness.startupListeners.push(fn) },
            connect: () => ({ onDisconnect: { addListener: () => {} }, disconnect() {}, postMessage() {} }),
            // background 从不主动 sendMessage，因此直接复用同一总线即可
            sendMessage: (msg, cb) => deliverToRuntimeListeners(msg, { id: 'content-harness' }, cb)
        },
        storage: {
            local: makeArea(harness.storageLocal),
            session: makeArea(harness.storageSession),
            onChanged: { addListener: () => {} }
        },
        contextMenus: {
            removeAll: (cb) => { harness.createdMenus.length = 0; if (cb) cb(); },
            create: (opts) => { harness.createdMenus.push(opts); return harness.createdMenus.length; },
            onClicked: { addListener: (fn) => harness.menuClickListeners.push(fn) }
        },
        tabs: {
            create: (opts) => { harness.createdTabs.push(opts); },
            sendMessage: (tabId, msg, opts) => new Promise((resolve, reject) => {
                harness.tabMessageLog.push({ tabId, msg, opts: opts || null });
                if (harness.failNextTabMessage) {
                    harness.failNextTabMessage = false;
                    reject(new Error('Could not establish connection. Receiving end does not exist.'));
                    return;
                }
                deliverToRuntimeListeners(msg, { tab: { id: tabId }, frameId: (opts && opts.frameId) || 0 }, resolve);
            })
        },
        downloads: {
            download: (opts, cb) => {
                harness.downloaded.push(opts);
                if (cb) cb(harness.downloaded.length);
                return harness.downloaded.length;
            }
        },
        cookies: { getAll: async () => [] },
        declarativeNetRequest: { updateDynamicRules: async () => {} }
    };
}

async function createHarnessPage(browser, { html, url = 'https://x.com/harness/status/999111222' }) {
    const page = await browser.newPage();
    await page.route('**/*', route => {
        const req = route.request();
        if (req.resourceType() === 'document' && req.url().startsWith('https://x.com/')) {
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
        }
        return route.abort();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(installChromeMockInPage);
    return page;
}

async function injectMix01Source(page, { withBackground = false } = {}) {
    for (const rel of MIX01_SCRIPTS) {
        await page.addScriptTag({ path: path.join(ROOT, rel) });
    }
    if (withBackground) {
        await page.addScriptTag({ path: path.join(ROOT, 'background.js') });
    }
}

// 与 content.js 相同的方式装配引擎
async function bootMix01Engine(page) {
    await page.evaluate(() => {
        window.__mix01State = {
            userPaused: false, isFetchingMore: false, followCache: {},
            likeMediaCache: {}, followAuthorCache: {}, blobToUrlMap: {}, hdUrlMap: {}
        };
        const cfg = new window.Mix01ConfigManager();
        const render = new window.Mix01MediaRenderer(cfg);
        const controller = new window.Mix01InputController(cfg, render);
        window.__mix01Engine = { config: cfg, render, controller };
    });
}

// 用 CDP `Extensions.loadUnpacked` 做真实浏览器加载验证
// （与 chrome://extensions 的「加载已解压的扩展程序」同一代码路径）
function cdpGetJSON(port, p) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: p }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
}

async function loadUnpackedViaCDP(exe, dir) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mix01-loadable-'));
    const port = 9850 + Math.floor(Math.random() * 120);
    const child = spawn(exe, [
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--headless=new',
        '--enable-unsafe-extension-debugging', '--window-position=-32000,-32000', 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());

    const cleanup = async () => {
        child.kill('SIGKILL');
        await new Promise(r => setTimeout(r, 200));
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    };

    let wsUrl = null;
    for (let i = 0; i < 30 && !wsUrl; i++) {
        await new Promise(r => setTimeout(r, 250));
        const v = await cdpGetJSON(port, '/json/version');
        if (v && v.webSocketDebuggerUrl) wsUrl = v.webSocketDebuggerUrl;
    }
    if (!wsUrl) {
        await cleanup();
        return { ok: false, error: 'devtools endpoint unavailable', stderr: stderr.slice(0, 300) };
    }

    let WSImpl;
    try { WSImpl = require('playwright-core/lib/utilsBundle').ws; } catch (e) { WSImpl = null; }
    if (!WSImpl) {
        await cleanup();
        return { ok: false, error: 'ws implementation unavailable' };
    }

    const result = await new Promise((resolve) => {
        const ws = new WSImpl(wsUrl);
        const done = (v) => { try { ws.close(); } catch (e) {} resolve(v); };
        ws.on('error', (e) => done({ ok: false, error: String(e && e.message || e) }));
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: dir } }));
        });
        ws.on('message', (m) => {
            const msg = JSON.parse(m.toString());
            if (msg.id !== 1) return;
            if (msg.error) done({ ok: false, error: msg.error.message || JSON.stringify(msg.error) });
            else done({ ok: true, id: (msg.result && msg.result.id) || null });
        });
        setTimeout(() => done({ ok: false, error: 'loadUnpacked timeout' }), 20000);
    });

    await cleanup();
    return result;
}

module.exports = {
    ROOT,
    MIX01_SCRIPTS,
    findBrowserExecutable,
    describeBrowser,
    launchHarnessBrowser,
    createHarnessPage,
    installChromeMockInPage,
    injectMix01Source,
    bootMix01Engine,
    loadUnpackedViaCDP
};
