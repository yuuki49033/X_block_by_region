// ==UserScript==
// @name         X (Twitter) _Block_by_region
// @namespace    https://github.com/yuuki49033/X_block_by_region
// @version      1.0.2
// @description  FIFO队列管理，滚动侦听，自动QueryID，双维度过滤
// @author       Gemini
// @match        https://x.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-end
// @downloadURL https://update.greasyfork.org/scripts/565965/X%20%28Twitter%29%20_Block_by_region.user.js
// @updateURL https://update.greasyfork.org/scripts/565965/X%20%28Twitter%29%20_Block_by_region.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. 配置与状态变量 ---
    let config = GM_getValue('filterConfig', {
        rules: [],
        whitelist: [],
        autoBlock: false,
        ballPos: {right: 20, bottom: 20}
    });

    let userQueue = []; // FIFO 队列
    let cache = new Map(); // 存储用户数据 {loc, src}
    let currentQueryId = ''; // 默认初始 ID
    const BEARER_TOKEN = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // --- 2. 优化后的 QueryID 嗅探 (精准匹配 UserAbout JS) ---
    async function sniffQueryId() {
        try {
            // 1. 查找包含 "UserAbout" 关键字的脚本
            const scripts = Array.from(document.querySelectorAll('script[src*="UserAbout"]'));
            let found = false;

            for (let s of scripts) {
                const res = await fetch(s.src);
                const text = await res.text();

                // 这里的正则精准匹配你发现的结构：id: "...", name: "AboutAccountQuery"
                // 使用了查找后面必须跟着 AboutAccountQuery 的断言匹配
                const match = text.match(/id\s*:\s*"([^"]+)"\s*,\s*metadata\s*:\s*\{[^\}]*\}\s*,\s*name\s*:\s*"AboutAccountQuery"/);

                if (match && match[1]) {
                    currentQueryId = match[1];
                    GM_setValue('currentQueryId', currentQueryId);

                    // 使用 input 的 value 而不是 innerText
                    const qInput = document.getElementById('qIdInput');
                    if (qInput) qInput.value = currentQueryId;

                    found = true;
                    break;
                }
            }

            // 2. 兜底逻辑：如果当前页面没加载 UserAbout.js，尝试主脚本匹配
            if (!found) {
                const mainScripts = Array.from(document.querySelectorAll('script[src*="/main."]'));
                for (let s of mainScripts) {
                    const res = await fetch(s.src);
                    const text = await res.text();
                    const mainMatch = text.match(/"AboutAccountQuery",queryId:"([^"]+)"/);
                    if (mainMatch) {
                        currentQueryId = mainMatch[1];
                        GM_setValue('currentQueryId', currentQueryId);
                        found = true;
                        break;
                    }
                }
            }

//             // 3. 强制修复逻辑：如果依然没找到，且不在 ElonMusk 的 about 页
//             // 因为 UserAbout.js 通常只有在访问 /about 页面时才会被 X 加载
//             if (!found && !window.location.href.includes('/about')) {
//                 console.warn("[系统] 当前页面未检测到 UserAbout 脚本，跳转至 About 页强制获取...");
//                 GM_setValue('returnUrl', window.location.href);
//                 window.location.href = 'https://x.com/elonmusk/about';
//             }

//             // 4. 成功获取后的回跳
//             if (found && window.location.href.includes('/about')) {
//                 const returnUrl = GM_getValue('returnUrl');
//                 if (returnUrl && returnUrl !== window.location.href) {
//                     GM_setValue('returnUrl', null);
//                     console.log("[系统] 获取成功，1秒后返回原页面...");
//                     setTimeout(() => { window.location.href = returnUrl; }, 1000);
//                 }
//             }

        } catch (e) {
            console.error("[系统] 嗅探过程出错:", e);
        }
    }

    // --- 3. 消费者：API 请求处理 (FIFO) ---
    async function consumerLoop() {
        while (true) {
            if (userQueue.length > 0) {
                const handle = userQueue.shift();
                if (!cache.has(handle)) {
                    const csrf = (document.cookie.match(/ct0=([^;]+)/) || [])[1];
                    if (!csrf) { await sleep(1000); continue; }

                    const variables = encodeURIComponent(JSON.stringify({ "screenName": handle.replace('@', '') }));
                    const url = `https://x.com/i/api/graphql/${currentQueryId}/AboutAccountQuery?variables=${variables}`;

                    GM_xmlhttpRequest({
                        method: "GET",
                        url: url,
                        headers: { "Authorization": BEARER_TOKEN, "x-csrf-token": csrf },
                        onload: (res) => {
                            if (res.responseText.includes("Rate limit exceeded")) {
                                console.warn(`[限流] 暂停处理 @${handle}`);
                                userQueue.unshift(handle); // 放回队首
                                return;
                            }
                            try {
                                const json = JSON.parse(res.responseText);
                                const profile = json.data?.user_result_by_screen_name?.result?.about_profile;
                                if (profile) {
                                    const data = { loc: profile.account_based_in || "", src: profile.source || "" };
                                    cache.set(handle, data);
                                    // 拿到数据后立即扫描页面上现有的该用户推文
                                    document.querySelectorAll('article[data-observed]').forEach(t => {
                                        if (t.innerText.includes(handle)) applyFilter(t, handle);
                                    });
                                }
                            } catch (e) {}
                        }
                    });
                    await sleep(2500); // 严格控制频率，每 2.5 秒一次请求
                }
            } else {
                await sleep(1000);
            }
        }
    }

    // --- 4. 拦截器：温和隐藏与自动拉黑 ---
    function applyFilter(tweet, handle) {
        const userData = cache.get(handle);
        if (!userData) return;

        const isHit = config.rules.some(r =>
                                        (r.loc && userData.loc.toLowerCase().includes(r.loc.toLowerCase())) ||
                                        (r.src && userData.src.toLowerCase().includes(r.src.toLowerCase()))
                                       );

        if (isHit) {
            const container = tweet.closest('div[data-testid="cellInnerDiv"]');
            if (container && !container.hasAttribute('data-hidden')) {
                container.setAttribute('data-hidden', 'true');
                container.style.opacity = '0.01';
                container.style.maxHeight = '30px';
                container.style.overflow = 'hidden';
                container.style.pointerEvents = 'none';
                console.log(`[屏蔽] @${handle} | 地区: ${userData.loc} | 来源: ${userData.src}`);
            }
            if (config.autoBlock) blockUser(handle);
        }
    }

    function blockUser(handle) {
        const csrf = (document.cookie.match(/ct0=([^;]+)/) || [])[1];
        GM_xmlhttpRequest({
            method: "POST",
            url: "https://x.com/i/api/1.1/blocks/create.json",
            headers: { "Authorization": BEARER_TOKEN, "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded" },
            data: `screen_name=${handle.replace('@', '')}`
        });
    }

    // --- 5. 生产者：滚动监听器 ---
    const intersectionObs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const tweet = entry.target;
                if (!tweet.hasAttribute('data-queued')) {
                    tweet.setAttribute('data-queued', 'true');
                    const handleSpan = Array.from(tweet.querySelectorAll('span')).find(s => s.innerText.startsWith('@'));
                    if (handleSpan) {
                        const handle = handleSpan.innerText;
                        if (config.whitelist.includes(handle)) return;
                        if (cache.has(handle)) {
                            applyFilter(tweet, handle);
                        } else if (!userQueue.includes(handle)) {
                            userQueue.push(handle);
                        }
                    }
                }
            }
        });
    }, { threshold: 0.1 });

    function initObserver() {
        const callback = () => {
            document.querySelectorAll('article[data-testid="tweet"]:not([data-observed])').forEach(t => {
                t.setAttribute('data-observed', 'true');
                intersectionObs.observe(t);
            });
        };
        const mutationObs = new MutationObserver(callback);
        const target = document.querySelector('main') || document.body;
        mutationObs.observe(target, { childList: true, subtree: true });
    }

    // --- 6. UI 相关 ---
    GM_addStyle(`
        #xBall { position: fixed; width: 44px; height: 44px; background: #1d9bf0; border: 2px solid #fff; border-radius: 50%; cursor: pointer; z-index: 99999; display: flex; align-items: center; justify-content: center; font-size: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        #xMenu { position: fixed; width: 280px; background: #fff; border-radius: 12px; z-index: 100000; padding: 15px; display: none; box-shadow: 0 8px 24px rgba(0,0,0,0.2); border: 1px solid #ddd; font-family: sans-serif; }
        .ruleItem { display: flex; justify-content: space-between; background: #f7f9f9; padding: 6px; border-radius: 6px; margin-bottom: 4px; font-size: 12px; border: 1px solid #eee; }
        .infoRow { font-size: 11px; color: #666; background: #eff3f4; padding: 6px; border-radius: 6px; margin-bottom: 10px; word-break: break-all; }
    `);

    let ball, menu;
    function createUI() {
        ball = document.createElement('div'); ball.id = 'xBall'; ball.innerHTML = '⚙️';
        menu = document.createElement('div'); menu.id = 'xMenu';
        const targetBody = document.body || document.documentElement;
        targetBody.appendChild(ball);
        targetBody.appendChild(menu);

        ball.style.right = (config.ballPos?.right || 20) + 'px';
        ball.style.bottom = (config.ballPos?.bottom || 20) + 'px';
        menu.innerHTML = `
            <div style="font-weight:bold;margin-bottom:8px;">设置</div>
<div class="infoRow">
    QueryID (点击可修改): <br>
    <input id="qIdInput" value="${currentQueryId}"
           style="width: 100%; border: none; background: transparent; color: #1d9bf0; font-weight: bold; font-family: monospace; outline: none; padding: 2px 0;">
</div>
            <div style="font-size:12px; margin-bottom:8px;">
                <input type="checkbox" id="autoBlockChk" ${config.autoBlock ? 'checked' : ''}>
                <label for="autoBlockChk">匹配后自动拉黑用户</label>
            </div>
            <div id="ruleList" style="max-height:100px; overflow-y:auto; margin-bottom:10px; border-top:1px solid #eee; padding-top:5px;"></div>
            <div style="display:flex; gap:4px;">
                <input id="inLoc" placeholder="地区" style="width:38%; padding:4px; font-size:11px;">
                <input id="inSrc" placeholder="来源" style="width:38%; padding:4px; font-size:11px;">
                <button id="addBtn" style="flex:1; background:#1d9bf0; color:#fff; border:none; border-radius:4px; font-size:11px; cursor:pointer;">添加</button>
            </div>
            <div style="font-size:10px; color:#999; margin-top:8px;">待处理队列: <span id="qCount">0</span></div>
        `;

        ball.addEventListener('click', () => {
            const isShow = menu.style.display === 'block';
            menu.style.display = isShow ? 'none' : 'block';
            if (!isShow) {
                menu.style.right = ball.style.right;
                menu.style.bottom = (parseInt(ball.style.bottom) + 55) + 'px';
            }
        });

        document.getElementById('autoBlockChk').addEventListener('change', (e) => {
            config.autoBlock = e.target.checked;
            GM_setValue('filterConfig', config);
        });

        document.getElementById('addBtn').addEventListener('click', () => {
            const loc = document.getElementById('inLoc').value.trim();
            const src = document.getElementById('inSrc').value.trim();
            if (loc || src) {
                config.rules.push({ loc, src });
                GM_setValue('filterConfig', config);
                document.getElementById('inLoc').value = '';
                document.getElementById('inSrc').value = '';
                renderRules();
            }
        });
        const qInput = document.getElementById('qIdInput');
        if (qInput) {
            // 监听回车键保存
            qInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    saveManualId(e.target.value);
                    qInput.blur(); // 失去焦点表示完成
                }
            });

            // 监听失去焦点保存
            qInput.addEventListener('blur', (e) => {
                saveManualId(e.target.value);
            });
        }

        // 辅助保存函数
        function saveManualId(newId) {
            newId = newId.trim();
            if (newId && newId !== currentQueryId) {
                currentQueryId = newId;
                GM_setValue('currentQueryId', newId); // 持久化到缓存
                console.log(`%c[系统] 手动更新 QueryID 为: ${newId}`, "color: #00ba7c; font-weight: bold;");

                // 顺便更新一下显示效果（防止多次输入不统一）
                const qVal = document.getElementById('qIdInput');
                if (qVal) qVal.value = newId;
            }
        }
        setInterval(() => { document.getElementById('qCount').innerText = userQueue.length; }, 1000);
        renderRules();
    }

    function renderRules() {
        const list = document.getElementById('ruleList');
        if (!list) return;
        list.innerHTML = config.rules.map((r, i) => `
            <div class="ruleItem">
                <span>${r.loc || '*'}|${r.src || '*'}</span>
                <span class="btnDel" data-idx="${i}" style="color:red;cursor:pointer;">✕</span>
            </div>
        `).join('');
        list.querySelectorAll('.btnDel').forEach(btn => {
            btn.onclick = (e) => {
                config.rules.splice(e.target.dataset.idx, 1);
                GM_setValue('filterConfig', config);
                renderRules();
            };
        });
    }

    // --- 启动 ---
    window.addEventListener('load', () => {
        setTimeout(() => {
            sniffQueryId();
            createUI();
            initObserver();
            consumerLoop();
        }, 1500);
    });

})();
