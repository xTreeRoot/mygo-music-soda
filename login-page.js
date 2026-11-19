/** 在独立网页登录会话中加载汽水官方安全 SDK、显示专用二维码并等待平台签发 Cookie。 */
import { qrSource } from './vendor/qr-source.js';

function browserLogin(device) {
  const api = 'https://api.qishui.com';
  const label = document.getElementById('status');
  const image = document.getElementById('qr');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const problem = message => new Error(message);
  const cookie = name => document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1) || '';
  const visible = () => document.hidden ? new Promise(resolve => {
    const changed = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', changed); resolve(); } };
    document.addEventListener('visibilitychange', changed);
  }) : Promise.resolve();
  const uuid = () => crypto.randomUUID();
  const trace = Array.from(crypto.getRandomValues(new Uint8Array(4)), value => value.toString(16).padStart(2, '0')).join('');
  const portrait = uuid() + '.login';
  document.cookie = 'biz_trace_id=' + trace + ';path=/;Secure;SameSite=Lax';
  let sourceInfo = '';
  async function request(path, fields, body, json = false) {
    const url = new URL(path, api);
    if (fields) for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    const headers = { Accept: 'application/json, text/javascript' };
    if (path.startsWith('/passport/')) {
      for (const [key, value] of Object.entries({ p_zt: window.$SECURE_VERSION || '0', p_bd: window._sdkGlueVersionMap?.bdmsVersion || '0', request_host: encodeURIComponent(location.origin), account_sdk_source_info: sourceInfo })) url.searchParams.set(key, value);
      headers['x-tt-passport-csrf-token'] = cookie('passport_csrf_token') || cookie('passport_csrf_token_default');
      headers['x-tt-passport-verify-portrait'] = portrait;
      headers['x-tt-passport-trace-id'] = trace;
    }
    if (body != null) headers['Content-Type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.href, { method: body == null ? 'GET' : 'POST', credentials: 'include', redirect: 'error', headers, body, signal: controller.signal });
      if (!response.ok) throw problem('汽水登录接口暂时不可用（HTTP ' + response.status + '）');
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw problem('汽水登录响应过大');
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  }
  function checked(value, stage) {
    const code = [value?.data?.error_code, value?.error_code, value?.status_code].map(Number).find(value => Number.isFinite(value) && value !== 0);
    if (code || value?.message !== 'success') {
      throw problem('汽水' + stage + '失败（错误码：' + (Number.isSafeInteger(code) ? code : '未提供') + '）');
    }
    return value.data;
  }
  async function loadSDK() {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.charset = 'utf-8';
      script.src = 'https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/glue/1.0.0.36/sdk-glue.js';
      const timer = setTimeout(() => reject(problem('汽水官方登录组件加载超时')), 20000);
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); reject(problem('汽水官方登录组件无法加载')); };
      document.head.appendChild(script);
    });
    window._SdkGlueInit({ self: { aid: 386088, pageId: 24554 }, bdms: { aid: 386088, paths: ['/passport'] } });
    const deadline = Date.now() + 20000;
    while (typeof window.bdms?.init !== 'function' || window._SdkGlueLoadingMap?.bdms) {
      if (Date.now() > deadline) throw problem('汽水官方登录组件初始化超时');
      await delay(100);
    }
    const info = { hardwareConcurrency: navigator.hardwareConcurrency, webdriver: navigator.webdriver === true,
      plugins: navigator.plugins?.length, innerHeight, innerWidth, outerHeight, outerWidth,
      notificationPermission: window.Notification?.permission || 'none', request_host: location.host, request_pathname: location.pathname,
      browser: { t: String(Date.now()).split('').reverse().join('') } };
    sourceInfo = Array.from(new TextEncoder().encode(JSON.stringify(info)), value => (value ^ 5).toString(16)).join('');
    const options = { aid: 386088, service: 'api.qishui.com', host: api, unionHost: '', union: false, needFid: false, fid: '', migrate_priority: 0 };
    const state = await request('/ttwid/check/', null, JSON.stringify(options), true);
    if (!Number.isFinite(Number(state.status_code))) throw problem('汽水浏览器会话初始化失败');
    if (Number(state.status_code) > 1001) {
      const registered = await request('/ttwid/register/', null, JSON.stringify({ ...options, migrate_info: state.migrate_info }), true);
      if (Number(registered.status_code) !== 0) throw problem('汽水浏览器会话注册失败');
    }
  }
  async function login() {
    await loadSDK();
    const common = { aid: '386088', passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1',
      account_sdk_source: 'web', language: 'zh', is_new_login: '1', is_from_iesaccountsaas: '1', device_platform: 'PC', version_code: '3.7.0',
      device_id: device.id, did: device.id, install_id: device.install, iid: device.install, biz_trace_id: trace, p_js_v: '2.4.13', p_js_t: 'pro', p_ver: '1.0.29' };
    const extra = { next: api, need_logo: 'false', need_short_url: 'false', is_new_login: '1' };
    const data = checked(await request('/passport/web/get_qrcode/', { ...common, ...extra }), '取码');
    const original = new URL(data.qrcode_index_url);
    const token = original.searchParams.get('token');
    if (original.origin !== 'https://bff-pc.qishui.com' || !token || typeof data.token !== 'string') throw problem('汽水返回的二维码无效');
    const scan = new URL('https://bff-pc.qishui.com/light/invoke/scan_login');
    scan.search = String(new URLSearchParams({ token, os: 'Windows', computer_name: 'MB iOS' })).replace(/\+/g, '%20');
    const qr = qrcode(0, 'M'); qr.addData(scan.href); qr.make(); image.src = qr.createDataURL(6, 12); image.hidden = false;
    label.textContent = '请用汽水音乐 App 扫码并确认';
    const body = String(new URLSearchParams({ ...extra, is_frontier: 'true', token: data.token }));
    const deadline = Date.now() + 210000;
    let disconnects = 0;
    while (Date.now() < deadline) {
      await delay(2000); await visible();
      if (Date.now() >= deadline) break;
      let result;
      try { result = await request('/passport/web/check_qrconnect/', common, body); disconnects = 0; }
      catch (error) {
        if (!(error instanceof TypeError || error.name === 'AbortError') || ++disconnects > 2) throw error;
        await visible(); continue;
      }
      const state = String(checked(result, '扫码确认')?.status);
      if (state === 'confirmed' || state === '3') { label.textContent = '登录已确认，正在读取账号…'; image.hidden = true; return; }
      if (state === 'scanned' || state === '2') label.textContent = '已扫码，请在汽水音乐确认';
      else if (state !== 'new' && state !== '1') throw problem('汽水二维码已失效，请重新登录');
    }
    throw problem('汽水二维码已过期，请重新登录');
  }
  login().catch(error => {
    image.hidden = true;
    const message = /^汽水/.test(error.message) ? error.message : '汽水登录连接中断，请检查网络后重试';
    label.textContent = message;
    window.webkit?.messageHandlers?.mbSignIn?.postMessage({ error: message });
  });
}

export function loginHTML(device) {
  const input = JSON.stringify({ id: device.id, install: device.install }).replace(/</g, '\\u003c');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>登录汽水音乐</title><style>:root{color-scheme:light dark;font-family:system-ui}body{margin:0;padding:24px;text-align:center}#qr{width:min(100%,320px);image-rendering:pixelated;background:white}p{line-height:1.6}</style></head>' +
    '<body><p id="status">正在连接汽水官方登录组件…</p><img id="qr" hidden alt="汽水音乐登录二维码">' +
    '<script>' + qrSource.replace(/<\/script/gi, '<\\/script') + '</script><script>(' + browserLogin.toString() + ')(' + input + ');</script></body></html>';
}
