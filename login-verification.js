/** 在本次登录网页中显示汽水官方安全挑战；不向宿主传递挑战内容或验证凭据。 */
export function verificationChallenge(value) {
  if (!value || typeof value !== 'object') return null;
  const containers = [value.data, value].filter(item => item && typeof item === 'object');
  for (const item of containers) {
    if (Number(item.error_code) === 2046 && typeof item.url === 'string') {
      return { kind: 'modern', decision: item, body: item.biz_params };
    }
  }
  for (const item of containers) {
    const raw = item.verify_center_decision_conf || item.verify_center_secondary_decision_conf;
    if (typeof raw !== 'string' || raw.length > 131072) continue;
    let decision;
    try { decision = JSON.parse(raw); } catch { continue; }
    if (Number(decision?.code) !== 10000 && Number(decision?.code) !== 20000) continue;
    const ticket = containers.find(entry => typeof entry.sms_code_key === 'string');
    const body = ticket && containers.some(entry => Number(entry.error_code) === 2046) ? { sms_code_key: ticket.sms_code_key } : undefined;
    return { kind: 'legacy', decision, body };
  }
  return null;
}

export async function verifyInBrowser(config) {
  if (location.origin !== 'https://api.qishui.com') throw new Error('汽水验证来源不正确');
  const hosts = new Set(['lf-rc1.yhgfb-cn-static.com', 'lf-headquarters-speed.yhgfb-cn-static.com',
    'lf-cdn-tos.bytescm.com', 'lf3-cdn-tos.bytescm.com', 'lf6-cdn-tos.bytescm.com', 'lf-luna.qishui.com', 'auth.zijieapi.com']);
  const scriptURL = value => {
    let url;
    try { url = typeof value === 'string' && value.length <= 8192 ? new URL(value) : null; } catch { /* 仅返回固定错误，不泄露挑战地址。 */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) {
      throw new Error('汽水返回的官方安全验证入口暂不受支持（2046）');
    }
    return url;
  };
  const { device, portrait, decision, kind } = config;
  const url = scriptURL(kind === 'modern' ? decision.url : 'https://lf-rc1.yhgfb-cn-static.com/obj/rc-client-security/secsdk-captcha/2.28.11/captcha.js');
  if (kind === 'modern') {
    url.searchParams.set('aid', '386088');
    url.searchParams.set('verify_reason', decision.event_params?.verify_reason || '');
    url.searchParams.set('verify_scene', decision.event_params?.verify_scene || '');
  }
  return new Promise((resolve, reject) => {
    let settled = false, downloadTimer;
    const script = document.createElement('script');
    const finish = (message, fp) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(downloadTimer);
      window.removeEventListener('pagehide', cancelled);
      script.onload = script.onerror = null;
      script.remove();
      if (message) reject(new Error(message));
      else resolve(typeof fp === 'string' && fp.length <= 512 ? fp : '');
    };
    const cancelled = () => finish('汽水安全验证已取消，登录未完成');
    const deadline = setTimeout(() => finish('汽水安全验证已超时，请重新登录'), 180000);
    window.addEventListener('pagehide', cancelled, { once: true });
    downloadTimer = setTimeout(() => finish('汽水官方安全验证组件下载超时（2046）'), 20000);
    script.charset = 'utf-8'; script.crossOrigin = 'anonymous'; script.src = url.href;
    script.onerror = () => finish('汽水官方安全验证组件下载失败（2046）');
    script.onload = () => {
      clearTimeout(downloadTimer);
      if (settled) return;
      try {
        const generalParams = { device_id: device.id, install_id: device.install, did: device.id, iid: device.install,
          device_platform: 'PC', version_code: '3.7.0' };
        if (kind === 'modern') {
          if (typeof window.React?.createElement !== 'function' || typeof window.ReactDOM?.render !== 'function' ||
              typeof window.ReactDOM?.unmountComponentAtNode !== 'function' || typeof window.ucWebSecondVerify !== 'function') {
            finish('汽水官方安全验证组件初始化失败（2046）'); return;
          }
          window.ucSecondVerifyReact = window.React;
          window.ucSecondVerifyReactDom = window.ReactDOM;
          window.$$account_verify_portrait_id = portrait;
          window.ucWebSecondVerify({ ...decision, aid: 386088, did: device.id, iid: device.install, generalParams,
            newSecondVerifyWebOptions: { host: location.origin, verifyAppName: '汽水音乐' }, verify_portrait_id: portrait,
            monitorTime: { startTime: Date.now(), scriptLoadStartTime: 0, scriptLoadEndTime: Date.now(), renderStartTime: Date.now() },
            fun: 'verify', uc_account_verify_version: '1.0.29',
            verifyFinishCallback: result => result?.status === true ? finish() : cancelled() });
        } else {
          const sdk = window.verifySDK;
          if (typeof sdk?.initVerifyOptions !== 'function' || typeof sdk.autoRender !== 'function') {
            finish('汽水官方安全验证组件初始化失败（2046）'); return;
          }
          sdk.initVerifyOptions({ commonOptions: { aid: 386088, did: device.id, iid: device.install },
            captchaOptions: { sideSlide: 'disabled', lang: 'zh', showMode: 'mask', region: 'cn', app_name: '' },
            secondVerifyWebOptions: { host: location.origin, verifyAppName: '汽水音乐' } });
          sdk.autoRender({ verify_data: decision,
            captchaOptions: { successCb: () => finish(null, typeof sdk.getCaptchaWebId === 'function' ? sdk.getCaptchaWebId() : ''), closeCb: cancelled },
            secondVerifyWebOptions: { scene: '4', callBack: () => finish(), closeCallBack: cancelled } });
        }
      } catch { finish('汽水官方安全验证组件运行失败（2046）'); }
    };
    // 官方 UMD 在执行时就会访问这两个外部依赖，必须先于加载脚本绑定。
    window.ucSecondVerifyReact = window.React;
    window.ucSecondVerifyReactDom = window.ReactDOM;
    window.$$account_verify_portrait_id = portrait;
    document.head.appendChild(script);
  });
}
