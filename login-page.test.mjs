/** 回归真实生成的登录脚本：官方挑战、同会话续传、取消与来源校验。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { loginHTML } from './login-page.js';

const device = { id: '1234567890123456', install: '123456789012345' };
const modern = { message: 'error', data: { error_code: 2046, url: 'https://auth.zijieapi.com/official.js',
  biz_params: { sms_code_key: 'synthetic-challenge' }, event_params: { verify_reason: 'login' } } };
const legacy = { message: 'error', data: { error_code: 2046, sms_code_key: 'synthetic-challenge',
  verify_center_decision_conf: JSON.stringify({ code: 10000, detail: 'synthetic-decision' }) } };
const success = data => ({ message: 'success', data });

async function browser(context, options = {}) {
  globalThis.host = { platform: 'android' };
  const html = loginHTML(device);
  assert.ok(Buffer.byteLength(html) < 262144, 'fits the native HTML contract');
  const start = html.lastIndexOf('<script>') + '<script>'.length;
  const source = html.slice(start, html.indexOf('</script>', start));
  const requests = [], scripts = [], timers = new Set(), listeners = new Map();
  const label = {}, image = { hidden: true };
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const window = {
    React: { createElement() {} }, ReactDOM: { render() {}, unmountComponentAtNode() {} },
    bdms: { init() {} }, _SdkGlueInit() {},
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    webkit: { messageHandlers: { mbSignIn: { postMessage(value) { done({ error: value.error }); } } } },
  };
  context.after(() => { for (const timer of timers) clearTimeout(timer); });
  const callback = fn => queueMicrotask(() => options.cancelPage ? listeners.get('pagehide')?.() : fn());
  const sandbox = vm.createContext({
    window, location: { origin: 'https://api.qishui.com', host: 'api.qishui.com', pathname: '/passport/' },
    URL, URLSearchParams, TextEncoder, AbortController, crypto: webcrypto,
    navigator: { hardwareConcurrency: 4 }, innerHeight: 800, innerWidth: 400, outerHeight: 800, outerWidth: 400,
    document: { cookie: '', hidden: false, getElementById: id => id === 'qr' ? image : label,
      createElement: () => ({ remove() {} }), head: { appendChild(script) {
        scripts.push(script.src);
        if (script.src.includes('/web/glue/')) { queueMicrotask(() => script.onload?.()); return; }
        assert.equal(script.charset, 'utf-8');
        assert.equal(window.ucSecondVerifyReact, window.React);
        assert.ok(window.$$account_verify_portrait_id.endsWith('.login'));
        if (options.downloadFailure) { queueMicrotask(() => script.onerror?.()); return; }
        if (!options.missingAPI) {
          window.ucWebSecondVerify = config => {
            if (options.sdkFailure) throw Error('private challenge content');
            assert.equal(config.did, device.id);
            assert.equal(config.iid, device.install);
            assert.equal(config.generalParams.device_platform, 'PC');
            callback(() => { config.verifyFinishCallback({ status: options.accept !== false }); config.verifyFinishCallback({ status: false }); });
          };
          window.verifySDK = {
            initVerifyOptions(config) { assert.equal(config.commonOptions.did, device.id); },
            autoRender(config) { callback(() => options.accept === false ? config.captchaOptions.closeCb() : config.captchaOptions.successCb()); },
            getCaptchaWebId: () => 'synthetic-fp',
          };
        }
        queueMicrotask(() => script.onload?.());
      } } },
    qrcode: () => ({ addData(url) { assert.equal(new URL(url).searchParams.get('computer_name'), 'MB Android'); },
      make() {}, createDataURL: () => 'data:image/gif;base64,synthetic' }),
    setTimeout(fn, ms) {
      if (ms === 100 || ms === 2000) { queueMicrotask(fn); return 0; }
      if (options.timeout && ms === 180000) { queueMicrotask(fn); return 0; }
      const timer = setTimeout(fn, ms); timers.add(timer); return timer;
    }, clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    fetch: async (url, init) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, ...init });
      let value;
      if (parsed.pathname === '/ttwid/check/') value = { status_code: 0 };
      else if (parsed.pathname === '/passport/web/get_qrcode/') {
        value = options.createChallenge && !parsed.searchParams.has('isResend') ? options.challenge || modern :
          success({ token: 'synthetic-poll-token', qrcode_index_url: 'https://bff-pc.qishui.com/qr?token=synthetic-scan-token' });
      } else {
        value = options.createChallenge ? success({ status: 'confirmed' }) :
          parsed.searchParams.has('isResend') && !options.repeat ? success({ status: 'confirmed' }) : options.challenge || modern;
        if (value?.data?.status === 'confirmed') queueMicrotask(() => done({ success: true }));
      }
      return { ok: true, text: async () => JSON.stringify(value) };
    },
  });
  vm.runInContext(source, sandbox);
  const outcome = await finished;
  // Fetch signals success before the final browser microtasks finish.
  await new Promise(resolve => setImmediate(resolve));
  return { outcome, requests, scripts, listeners, timers, image, label };
}

test('modern verification resumes the same QR, cookie jar, trace and portrait exactly once', async context => {
  const h = await browser(context);
  assert.deepEqual(h.outcome, { success: true });
  const polls = h.requests.filter(item => item.url.pathname.includes('check_qrconnect'));
  assert.equal(polls.length, 2);
  assert.equal(polls[1].url.searchParams.get('isResend'), 'true');
  assert.equal(new URLSearchParams(polls[1].body).get('token'), 'synthetic-poll-token');
  assert.equal(new URLSearchParams(polls[1].body).get('sms_code_key'), 'synthetic-challenge');
  for (const request of polls) {
    assert.equal(request.credentials, 'include');
    assert.equal(request.headers['x-tt-passport-trace-id'], polls[0].headers['x-tt-passport-trace-id']);
    assert.equal(request.headers['x-tt-passport-verify-portrait'], polls[0].headers['x-tt-passport-verify-portrait']);
  }
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timers.size, 0);
});

test('legacy challenge forwards the official fingerprint after successful user verification', async context => {
  const h = await browser(context, { challenge: legacy });
  assert.equal(h.outcome.success, true);
  const request = h.requests.at(-1);
  assert.equal(request.url.searchParams.get('fp'), 'synthetic-fp');
  assert.equal(request.url.searchParams.get('verifyFp'), 'synthetic-fp');
  assert.equal(new URLSearchParams(request.body).get('sms_code_key'), 'synthetic-challenge');
});

test('verification before QR creation resumes GET with returned challenge fields', async context => {
  const h = await browser(context, { createChallenge: true });
  assert.equal(h.outcome.success, true);
  const resumed = h.requests.find(item => item.url.searchParams.has('isResend'));
  assert.equal(resumed.method, 'GET');
  assert.equal(resumed.url.searchParams.get('sms_code_key'), 'synthetic-challenge');
});

test('cancel, unload, unavailable SDK and repeated verification stop without accepting a session', async context => {
  for (const options of [{ accept: false }, { cancelPage: true }, { downloadFailure: true }, { missingAPI: true }, { sdkFailure: true }, { repeat: true }, { timeout: true }]) {
    const h = await browser(context, options);
    assert.ok(h.outcome.error.startsWith('汽水'));
    assert.equal(h.outcome.error.includes('private challenge'), false);
    assert.equal(h.requests.filter(item => item.url.searchParams.has('isResend')).length, options.repeat ? 1 : 0);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('foreign, insecure and credential bearing challenge URLs never execute', async context => {
  for (const url of ['https://evil.invalid/verify.js', 'http://auth.zijieapi.com/verify.js',
    'https://auth.zijieapi.com:8443/verify.js', 'https://auth.zijieapi.com.evil.invalid/verify.js', 'https://private:secret@auth.zijieapi.com/verify.js']) {
    const challenge = { ...modern, data: { ...modern.data, url } };
    const h = await browser(context, { challenge });
    assert.match(h.outcome.error, /入口暂不受支持/);
    assert.equal(h.scripts.length, 1);
    assert.equal(h.outcome.error.includes('secret'), false);
    assert.equal(h.outcome.error.includes(url), false);
  }
});
