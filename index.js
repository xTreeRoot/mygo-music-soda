import { loginHTML } from './login-page.js';

const API = 'https://beta-luna.douyin.com';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const pendingDetails = new Map();
const lyricsCache = new Map();
const ACCOUNT_API = 'https://api.qishui.com';
const QR_ORIGIN = 'https://bff-pc.qishui.com';
const APP_ID = '386088';
const CLIENT_VERSION = '3.7.0';
const DEVICE_PATH = '/service/2/desktop/device_register/';
const DEVICE_KEY = 'qishuiDevice';
const LOGIN_NEXT = ACCOUNT_API;
const LOGIN_PAGE = 'my-library';
const SESSION_KEY = 'qishuiAccount';
const SESSION_COOKIES = new Set(['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt']);
const LIBRARY_PATH = '/luna/pc/me/playlist';
const PRIVATE_DETAIL_PATH = '/luna/pc/playlist/detail';
const ACCOUNT_PATH = '/luna/pc/me';
const ALLOWED_HOSTS = new Set(['api.qishui.com', 'bff-pc.qishui.com']);
const NO_SESSION = 1000016;
const SECURITY_CHECK = 2046;
const POLL_MS = 2000;
const LOGIN_MS = 210000;
const PAGE_SIZE = 50;
let loginAttempt;
let accountRevision = 0;

function fail(message) {
  const error = new Error(message);
  error.code = 'unavailable';
  return error;
}

function accountError(code, message) {
  return Object.assign(new Error(message), { code });
}

function loginRequired() {
  return accountError('signIn', '请先登录汽水音乐');
}

function accountID(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return '';
  return /^\d{1,32}$/.test(String(value)) ? String(value) : '';
}

function parseAccountJSON(text) {
  if (text.length > 2 * 1024 * 1024) throw fail('汽水音乐返回的数据过大');
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => /^\d{16,}$/.test(token) ? `"${token}"` : token));
}

function authTarget(address) {
  if (typeof address !== 'string' || address.length > 16384 || !/^https:\/\/(?:api|bff-pc)\.qishui\.com(?:\/|\?|$)/.test(address) || /[\\\s\u0000-\u001f\u007f]/.test(address)) {
    throw fail('汽水音乐登录地址无效');
  }
  return new URL(address);
}

function cookiePathMatches(path, scope) {
  return path === scope || path.startsWith(scope.endsWith('/') ? scope : scope + '/');
}

function cookieValue(value) {
  return typeof value === 'string' && /^[\x21-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(value);
}

function cookieApplies(cookie, path) {
  return cookie && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) && cookieValue(cookie.value) &&
    (cookie.domain === 'api.qishui.com' || cookie.domain === 'qishui.com') &&
    (cookie.expires == null || cookie.expires > Date.now()) && typeof cookie.path === 'string' && cookiePathMatches(path, cookie.path);
}

function sessionPresent(jar) {
  return jar.some(cookie => cookieApplies(cookie, ACCOUNT_PATH) && SESSION_COOKIES.has(cookie.name));
}

function updateCookies(jar, lines, target) {
  if (!Array.isArray(lines) || lines.length > 64 || !ALLOWED_HOSTS.has(target.hostname)) return;
  for (const line of lines) {
    if (typeof line !== 'string' || line.length > 8192) continue;
    const [pair, ...parts] = line.split(';');
    const split = pair.indexOf('=');
    const name = pair.slice(0, split).trim();
    const value = pair.slice(split + 1).trim();
    if (split < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    const attributes = Object.fromEntries(parts.map(part => {
      const equals = part.indexOf('=');
      return equals < 0 ? [part.trim().toLowerCase(), ''] : [part.slice(0, equals).trim().toLowerCase(), part.slice(equals + 1).trim()];
    }));
    const domain = attributes.domain?.toLowerCase().replace(/^\./, '') || target.hostname;
    if ((domain !== 'api.qishui.com' && domain !== 'qishui.com') || (target.hostname !== domain && !target.hostname.endsWith('.' + domain))) continue;
    const path = attributes.path?.startsWith('/') ? attributes.path : (target.pathname.replace(/\/[^/]*$/, '') || '/');
    const age = attributes['max-age'];
    const expires = /^-?\d+$/.test(age || '') ? Date.now() + Number(age) * 1000 : Date.parse(attributes.expires);
    const previous = jar.findIndex(cookie => cookie.name === name && cookie.path === path && cookie.domain === domain);
    if (!cookieValue(value) || expires <= Date.now()) {
      if (previous >= 0) jar.splice(previous, 1);
      continue;
    }
    const cookie = { name, value, path, domain, ...(Number.isFinite(expires) ? { expires } : {}) };
    if (previous >= 0) jar[previous] = cookie;
    else if (jar.length < 128) jar.push(cookie);
  }
}

async function accountFetch(address, jar, { signal, body, headers } = {}) {
  const target = authTarget(address);
  const cookies = target.origin === ACCOUNT_API ? jar.filter(cookie => cookieApplies(cookie, target.pathname)) : [];
  const cookie = cookies.sort((left, right) => right.path.length - left.path.length).map(value => `${value.name}=${value.value}`).join('; ');
  if (cookie.length > 65536) throw loginRequired();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 12000);
  let response;
  let text;
  try {
    response = await fetch(address, {
      method: body == null ? 'GET' : 'POST', body, redirect: 'manual', signal: controller.signal,
      headers: { 'User-Agent': target.pathname.startsWith('/passport/') ? WEB_UA : 'LunaPC/3.0.0(290101097)', Accept: 'application/json', ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    text = await response.text();
  } catch {
    if (signal?.aborted) throw accountError('cancelled', '汽水登录已取消');
    throw accountError('network', '无法连接汽水音乐，请检查网络后重试');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  if (signal?.aborted) throw accountError('cancelled', '汽水登录已取消');
  if (response.status === 401) throw loginRequired();
  if (response.status === 429) throw accountError('rateLimit', '汽水请求过于频繁，请稍后重试');
  updateCookies(jar, response.headers.getSetCookie?.() || [], response.url ? authTarget(response.url) : target);
  return { status: response.status, location: response.headers.get('location'), body: text };
}

async function accountRequest(path, query, jar, options) {
  const response = await accountFetch(ACCOUNT_API + path + '?' + new URLSearchParams(query), jar, options);
  if (response.status !== 200) throw fail(`汽水音乐账号请求失败：HTTP ${response.status}`);
  let data;
  try { data = parseAccountJSON(response.body); } catch { throw fail('汽水音乐账号响应格式无效'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('汽水音乐账号响应格式无效');
  const codes = [data.status_code, data.status_info?.status_code, data.status_info?.code, data.error_code, data.data?.error_code].map(Number);
  if (codes.includes(NO_SESSION)) throw loginRequired();
  if (codes.includes(SECURITY_CHECK)) throw accountError('verify', '汽水音乐要求额外安全验证，请先在官方 App 完成验证后重试');
  if (codes.includes(7)) throw accountError('rateLimit', '汽水请求过于频繁，请稍后重试');
  if (path.startsWith('/passport/') && codes.includes(2)) throw accountError('expired', '汽水二维码已过期，请重新扫码');
  if (codes.some(code => Number.isFinite(code) && code !== 0) || (path.startsWith('/passport/') && data.message !== 'success')) {
    const stage = path === DEVICE_PATH ? '设备初始化' : path === ACCOUNT_PATH ? '账号验证' : path.endsWith('check_qrconnect/') ? '扫码确认' : path.endsWith('get_qrcode/') ? '二维码' : '个人库';
    const safeCodes = [...new Set(codes.filter(code => Number.isSafeInteger(code) && Math.abs(code) <= 2147483647))];
    throw fail(`汽水音乐拒绝了本次请求（${stage}，错误码：${safeCodes.join('/') || '未提供'}）`);
  }
  return data;
}

function storedAccount() {
  const stored = globalThis.host?.storage?.get(SESSION_KEY);
  return stored?.version === 1 && accountID(stored.id) && Array.isArray(stored.cookies) && stored.cookies.length <= 128 ? stored : null;
}

function saveAccount(profile, cookies, active) {
  const forLibrary = cookies.filter(cookie => !cookie.name.startsWith('passport_csrf_') &&
    [ACCOUNT_PATH, LIBRARY_PATH, PRIVATE_DETAIL_PATH].some(path => cookieApplies(cookie, path)));
  host.storage.set(SESSION_KEY, { version: 1, id: profile.id, cookies: forLibrary, active });
}

async function verifiedProfile(jar, signal) {
  if (!sessionPresent(jar)) throw loginRequired();
  const payload = await accountRequest(ACCOUNT_PATH, { aid: APP_ID }, jar, { signal });
  const raw = payload.my_info || payload.user;
  const id = accountID(raw?.id);
  if (!sessionPresent(jar)) throw loginRequired();
  if (!id) throw fail('汽水音乐未返回有效账号');
  const name = [raw.nickname, raw.public_name].find(value => typeof value === 'string' && value.trim()) || '汽水音乐用户';
  const imageUrl = [raw.avatar_url, raw.larger_avatar_url, raw.medium_avatar_url, raw.thumb_avatar_url, raw.url_avatar].map(image).find(Boolean);
  return { id, name, imageUrl, page: LOGIN_PAGE };
}

function checkLogin(attempt) {
  if (attempt !== loginAttempt || attempt.controller.signal.aborted) throw accountError('cancelled', '汽水登录已取消');
}

function pollDelay(signal, milliseconds = POLL_MS) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

// 只恢复扫码状态和资料读取，保留同一个二维码及临时 Cookie；不重放登录跳转或账号写入。
async function readLogin(attempt, read, recover = () => {}) {
  const delays = [500, 1500];
  for (let retry = 0; ; retry++) {
    checkLogin(attempt);
    try {
      const value = await read();
      checkLogin(attempt);
      return value;
    } catch (error) {
      checkLogin(attempt);
      if (error.code !== 'network' || retry >= delays.length) throw error;
      recover();
      await pollDelay(attempt.controller.signal, delays[retry]);
    }
  }
}

// 设备注册合同来自公开汽水插件，已用全新匿名实例核对；不读取真实硬件序列号。
async function loginDevice(attempt, jar) {
  const saved = host.storage.get(DEVICE_KEY);
  if (saved?.version === 1 && saved.clientVersion === CLIENT_VERSION && accountID(saved.id) && accountID(saved.install)) return saved;
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, part => {
    const digit = Math.floor(Math.random() * 16);
    return (part === 'x' ? digit : (digit & 3) | 8).toString(16);
  });
  const common = { aid: APP_ID, channel: 'official', os: 'Windows', os_version: 'Windows 10: 10.0', device_platform: 'PC', app_version: CLIENT_VERSION };
  const header = {
    ...common, aid: Number(APP_ID), device_id: '', install_id: '', sdk_version: '1.0', sdk_version_code: 1,
    mc: '00:00:00:00:00:00', package: 'com.soda.music', language: 'zh-CN', device_model: 'no detected',
    time_zone: 'Asia/Shanghai', tz_name: 'Asia/Shanghai', tz_offset: 0, resolution: 'no detected',
    app_region: 'cn', app_language: 'zh-CN', display_name: '汽水音乐', pc_uuid: uuid, pc_serial: '',
  };
  const data = await accountRequest(DEVICE_PATH, common, jar, {
    signal: attempt.controller.signal, body: JSON.stringify({ header, gen_time: Date.now(), magic_tag: 'ss_app_log' }),
    headers: { 'User-Agent': `LunaPC/${CLIENT_VERSION}(official)`, 'Content-Type': 'application/json' },
  });
  checkLogin(attempt);
  const id = accountID(data.device_id_str), install = accountID(data.install_id_str);
  if (!id || !install) throw fail('汽水音乐未返回有效的登录设备信息');
  const device = { version: 1, clientVersion: CLIENT_VERSION, id, install };
  host.storage.set(DEVICE_KEY, device);
  return device;
}

// 官方 3.7.0 登录组件使用同一次注册得到的四个设备字段；整个扫码流程保持一致。
function passportQuery(device) {
  return {
    aid: APP_ID, passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1', account_sdk_source: 'web',
    language: 'zh', device_platform: 'PC', version_code: CLIENT_VERSION, is_new_login: '1', is_from_iesaccountsaas: '1',
    device_id: device.id, did: device.id, install_id: device.install, iid: device.install,
  };
}

async function completeRedirect(address, jar, signal) {
  for (let hop = 0; address && hop < 5; hop++) {
    const result = await accountFetch(address, jar, { signal });
    if (sessionPresent(jar)) return;
    if (![301, 302, 303, 307, 308].includes(result.status) || !result.location) break;
    address = new URL(result.location, address).href;
  }
}

async function scanQR(attempt, jar) {
  const { signal } = attempt.controller;
  host.signInPrompt({ text: '正在初始化汽水音乐登录…' });
  const device = await loginDevice(attempt, jar);
  if (globalThis.host?.capabilities?.webSignInHTML === true) {
    const result = await host.webSignIn({ url: ACCOUNT_API + '/passport/', cookiesOf: ACCOUNT_API + '/', until: ['sessionid'], userAgent: WEB_UA, html: loginHTML(device) });
    checkLogin(attempt);
    if (typeof result?.cookie !== 'string' || result.cookie.length > 65536 || /[\r\n]/.test(result.cookie)) throw loginRequired();
    updateCookies(jar, result.cookie.split(';').map(pair => pair.trim() + '; Path=/; Secure'), new URL(ACCOUNT_API));
    if (!sessionPresent(jar)) throw loginRequired();
    return;
  }
  const requestQR = (path, extra = {}, confirm = false) => {
    const csrf = ['passport_csrf_token', 'passport_csrf_token_default'].map(name =>
      jar.find(cookie => cookie.name === name && cookieApplies(cookie, path))).find(Boolean);
    const fields = { next: LOGIN_NEXT, need_logo: 'false', need_short_url: 'false', is_new_login: '1', ...extra };
    return accountRequest(path, { ...passportQuery(device), ...(confirm ? {} : fields) }, jar, {
      signal, ...(confirm ? { body: String(new URLSearchParams(fields)) } : {}),
      headers: { 'x-tt-passport-csrf-token': csrf?.value || '', ...(confirm ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    });
  };
  host.signInPrompt({ text: '正在生成汽水音乐登录二维码…' });
  const { data: qr } = await requestQR('/passport/web/get_qrcode/');
  checkLogin(attempt);
  if (typeof qr?.token !== 'string' || !qr.token || qr.token.length > 8192 || authTarget(qr.qrcode_index_url).origin !== QR_ORIGIN) {
    throw fail('汽水音乐未返回可用的二维码');
  }
  // 官方汽水客户端使用扫码专用入口；展示通用 SDK 地址会进入另一条授权流程。
  const scanToken = new URL(qr.qrcode_index_url).searchParams.get('token');
  if (!scanToken || scanToken.length > 8192) throw fail('汽水音乐未返回可用的扫码凭据');
  const scanURL = QR_ORIGIN + '/light/invoke/scan_login?' + String(new URLSearchParams({
    token: scanToken, os: 'Windows', computer_name: globalThis.host?.platform === 'ios' ? 'MB iOS' : 'MB',
  })).replace(/\+/g, '%20');
  const prompt = text => host.signInPrompt({ qr: scanURL, text });
  prompt('请用汽水音乐 App 扫码，再在手机上确认');
  const until = Date.now() + LOGIN_MS;
  while (Date.now() < until) {
    await pollDelay(signal);
    checkLogin(attempt);
    const { data } = await readLogin(attempt, () => requestQR('/passport/web/check_qrconnect/', { token: qr.token, is_frontier: 'true' }, true),
      () => prompt('网络连接已中断，正在恢复登录…'));
    checkLogin(attempt);
    const status = String(data?.status).trim().toLowerCase();
    if (status === 'new' || status === '1') continue;
    if (status === 'scanned' || status === '2') { prompt('已扫码，请在手机上确认'); continue; }
    if (['expired', 'expire', 'timeout'].includes(status)) break;
    if (!['confirmed', 'success', '3'].includes(status)) throw fail('汽水登录未完成，请重新扫码');
    if (!sessionPresent(jar) && data.redirect_url) await completeRedirect(data.redirect_url, jar, signal);
    return;
  }
  throw accountError('expired', '汽水二维码已过期，请重新扫码');
}

export function cancelSignIn() {
  loginAttempt?.controller.abort();
  loginAttempt = undefined;
}

export async function signIn() {
  cancelSignIn();
  const attempt = { controller: new AbortController() };
  loginAttempt = attempt;
  try {
    const saved = storedAccount();
    let jar = saved ? [...saved.cookies] : [];
    let profile;
    if (saved && sessionPresent(jar)) {
      try {
        const checked = await readLogin(attempt, () => verifiedProfile(jar, attempt.controller.signal));
        if (checked.id === saved.id) profile = checked;
      } catch (error) { if (error.code !== 'signIn') throw error; }
    }
    if (!profile) {
      jar = [];
      await scanQR(attempt, jar);
      profile = await readLogin(attempt, () => verifiedProfile(jar, attempt.controller.signal),
        () => host.signInPrompt({ text: '网络连接已中断，正在读取已授权账号…' }));
    }
    checkLogin(attempt);
    saveAccount(profile, jar, true);
    accountRevision++;
    return profile;
  } finally {
    if (loginAttempt === attempt) loginAttempt = undefined;
  }
}

export async function account() {
  const saved = storedAccount();
  if (!saved?.active) return null;
  const revision = accountRevision;
  const jar = [...saved.cookies];
  try {
    const profile = await verifiedProfile(jar);
    if (revision !== accountRevision) return null;
    if (profile.id !== saved.id) throw loginRequired();
    saveAccount(profile, jar, true);
    return profile;
  } catch (error) {
    if (revision !== accountRevision) return null;
    if (error.code !== 'signIn') throw error;
    accountRevision++;
    host.storage.set(SESSION_KEY, { ...saved, active: false });
    return null;
  }
}

export function signOut() {
  cancelSignIn();
  accountRevision++;
  const saved = storedAccount();
  if (saved) host.storage.set(SESSION_KEY, { ...saved, active: false });
}

/** 用户主动重新扫码时清除本插件会话和设备注册，不触碰其他设置或资料。 */
export function signOutAndClearCache() {
  signOut();
  host.storage.remove(SESSION_KEY);
  host.storage.remove(DEVICE_KEY);
  pendingDetails.clear();
  lyricsCache.clear();
  artistCursors.clear();
}

async function withLibrary(load) {
  const saved = storedAccount();
  if (!saved?.active || !sessionPresent(saved.cookies)) throw loginRequired();
  const revision = accountRevision;
  const result = await load(saved.id, [...saved.cookies]);
  if (revision !== accountRevision) throw loginRequired();
  return result;
}

function libraryCollection(raw, owner) {
  const id = accountID(raw?.id);
  const title = raw?.title || raw?.public_title;
  if (!id || typeof title !== 'string' || !title.trim()) throw fail('汽水音乐歌单信息无效');
  const mine = accountID(raw.owner?.id) === owner;
  return {
    ...collection({ ...raw, title, url_cover: raw.cover_url || raw.url_cover, count_tracks: raw.count_tracks ?? raw.resource_cnt?.track_cnt }),
    id: `account:${id}`,
    mine,
    fixed: mine && ![2, 3, 11].includes(Number(raw.type)),
    saved: !mine && raw.state?.is_collected === true,
  };
}

async function readPages(load, visit, allowInferredMore = false) {
  let cursor = '';
  const visited = new Set();
  for (let page = 0; page < 500; page++) {
    const data = await load(cursor);
    const next = data.next_cursor == null ? '' : String(data.next_cursor);
    if (next.length > 8192 || /[\u0000-\u001f\u007f]/.test(next) ||
        (data.next_cursor != null && typeof data.next_cursor !== 'string' && !Number.isSafeInteger(data.next_cursor)) ||
        (data.has_more != null && typeof data.has_more !== 'boolean')) throw fail('汽水音乐分页信息无效');
    const more = data.has_more ?? (allowInferredMore && !!next && next !== '0' && next !== cursor);
    visit(data, more);
    if (!more) return;
    if (!next || next === '0' || visited.has(next)) throw fail('汽水音乐分页未前进');
    visited.add(next);
    cursor = next;
  }
  throw fail('汽水音乐歌单超过可加载范围');
}

async function libraryRows(jar) {
  const rows = new Map();
  await readPages(cursor => accountRequest(LIBRARY_PATH, { aid: APP_ID, version_code: '30020100', count: String(PAGE_SIZE), cursor }, jar), data => {
    if (!Array.isArray(data.playlists)) throw fail('汽水音乐个人歌单响应无效');
    for (const row of data.playlists) {
      const id = accountID(row?.id);
      if (!id) throw fail('汽水音乐返回了无效歌单');
      if (!rows.has(id)) rows.set(id, row);
    }
    if (rows.size > 25000) throw fail('汽水音乐个人歌单超过可加载范围');
  });
  return rows;
}

async function libraryDetail(id, owner, jar, known) {
  const tracks = new Map();
  let metadata = known;
  await readPages(cursor => accountRequest(PRIVATE_DETAIL_PATH, { aid: APP_ID, playlist_id: id, count: '100', cursor }, jar), (data, more) => {
    if (data.playlist?.id != null && accountID(data.playlist.id) !== id) throw fail('汽水音乐返回的不是所选歌单');
    if (data.playlist?.id != null) metadata = { ...metadata, ...data.playlist };
    if (!Array.isArray(data.media_resources)) {
      const count = metadata?.count_tracks ?? metadata?.resource_cnt?.track_cnt;
      const terminal = data.has_more === false || data.next_cursor === 0 || data.next_cursor === '0';
      if (data.media_resources != null || more || (!tracks.size && (Number(count) > 0 || (count == null && !terminal)))) {
        throw fail('汽水音乐未返回完整歌单');
      }
      return;
    }
    for (const resource of data.media_resources) {
      if (resource?.type === 'video' || resource?.entity?.video) continue;
      const track = resource?.entity?.track_wrapper?.track || resource?.entity?.track || resource?.track;
      if (track == null && resource?.type !== 'track') continue;
      if (!accountID(track?.id)) throw fail('汽水音乐返回了无效曲目');
      const detail = song({ ...track, album: track.album && { ...track.album, url_cover: track.album.cover_url || track.album.url_cover } });
      if (!track.vid || track.status || track.display_hint?.view_only_msg) detail.unavailable = true;
      if (!tracks.has(detail.id)) tracks.set(detail.id, detail);
    }
    if (tracks.size > 25000) throw fail('汽水音乐歌单曲目超过可加载范围');
  }, true);
  if (!metadata) throw fail('没有找到这个汽水音乐歌单');
  const count = metadata.count_tracks ?? metadata.resource_cnt?.track_cnt;
  if (tracks.size === 0 && Number(count) > 0) throw fail('汽水音乐未返回完整歌单');
  return { ...libraryCollection(metadata, owner), tracks: [...tracks.values()], trackCount: tracks.size };
}

export async function playlists() {
  return withLibrary(async (owner, jar) => [...(await libraryRows(jar)).values()].map(row => libraryCollection(row, owner)));
}

export async function liked({ offset = 0 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 25000) throw fail('喜欢列表的分页位置无效');
  return withLibrary(async (owner, jar) => {
    const rows = [...(await libraryRows(jar)).values()].filter(row => Number(row.type) === 1 && accountID(row.owner?.id) === owner);
    if (rows.length !== 1) throw fail('汽水音乐未向当前设备提供喜欢列表');
    const row = rows[0];
    const { tracks } = await libraryDetail(accountID(row.id), owner, jar, row);
    return { tracks: tracks.slice(offset, offset + PAGE_SIZE), more: offset + PAGE_SIZE < tracks.length };
  });
}

async function request(path, body) {
  const response = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'User-Agent': body === undefined ? WEB_UA : 'Luna/19.1.0 Android',
      'Content-Type': 'application/json; charset=utf-8',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error('汽水音乐请求失败：HTTP ' + response.status);
  const data = await response.json();
  const status = data.status_info?.status_code ?? data.status_code ?? 0;
  if (status !== 0) throw new Error(data.status_info?.status_msg || '汽水音乐暂时无法提供此内容');
  return data;
}

function image(value) {
  if (typeof value === 'string') return /^https:\/\//.test(value) ? value : '';
  if (!value) return '';
  const base = value.urls?.[0] || value.url || '';
  if (!/^https:\/\//.test(base)) return '';
  const url = value.need_complete_url || !value.uri || base.includes(value.uri) ? base : base + value.uri;
  return value.template_prefix && !url.includes('~tplv-') ? url + '~' + value.template_prefix + '-image.image' : url;
}

function song(track) {
  const album = track.album || {};
  return {
    id: String(track.id),
    name: track.name || '未命名歌曲',
    duration: Number(track.duration || track.duration_ms || 0),
    artists: (track.artists || []).map(a => ({ id: String(a.id || ''), name: a.name || a.simple_display_name || '', imageUrl: image(a.url_avatar) })),
    album: { id: String(album.id || ''), name: album.name || '', imageUrl: image(album.url_cover) },
  };
}

function collection(p) {
  return {
    id: String(p.id),
    name: p.title || p.name || '歌单',
    imageUrl: image(p.url_cover || p.cover),
    description: p.description || p.desc || '',
    owner: p.owner?.nickname || '',
    trackCount: Number(p.count_tracks || 0),
  };
}

async function recommendations() {
  const data = await request('/luna/discover/mix', { count: 8 });
  const playlists = [];
  const ids = new Set();
  for (const block of data.inner_block || []) {
    for (const resource of block.resources || []) {
      const p = resource.entity?.playlist || resource.playlist;
      if (p?.id && !ids.has(String(p.id))) {
        playlists.push(collection(p));
        ids.add(String(p.id));
      }
    }
  }
  if (!playlists.length) throw new Error('汽水音乐暂时没有返回推荐歌单，请稍后刷新');
  return playlists;
}

export async function home() {
  const [recommended, moods] = await Promise.allSettled([recommendations(), categories()]);
  if (recommended.status === 'rejected' && moods.status === 'rejected') throw recommended.reason;
  const limit = 5;
  const sections = [];
  if (recommended.status === 'fulfilled') {
    sections.push({ title: '精选歌单', playlists: recommended.value.slice(0, limit),
      morePage: recommended.value.length > limit ? 'recommended' : undefined });
  }
  if (moods.status === 'fulfilled') {
    sections.push({ title: '风格与场景', links: moods.value.slice(0, limit),
      morePage: moods.value.length > limit ? 'categories' : undefined });
  }
  if (recommended.status === 'rejected') sections.push({ title: '精选歌单', links: [{ title: '查看推荐歌单', page: 'recommended' }] });
  if (moods.status === 'rejected') sections.push({ title: '风格与场景', links: [{ title: '查看音乐分类', page: 'categories' }] });
  return { title: '汽水音乐', sections };
}

export async function playlist({ id }) {
  id = String(id);
  if (id.startsWith('account:')) {
    const privateID = accountID(id.slice('account:'.length));
    if (!privateID) throw fail('汽水音乐歌单 ID 无效');
    return withLibrary(async (owner, jar) => {
      const known = (await libraryRows(jar)).get(privateID);
      if (!known) throw fail('该歌单不在当前汽水账号的个人库');
      return libraryDetail(privateID, owner, jar, known);
    });
  }
  if (!/^\d+$/.test(id)) throw fail('歌单 ID 无效');
  const tracks = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor = '';
  let result;
  for (let page = 0; page < 10; page++) {
    const data = await request('/luna/playlist/detail', { playlist_id: id, count: 50, ...(cursor ? { cursor } : {}) });
    if (!result && data.playlist?.id) result = collection(data.playlist);
    const previous = tracks.length;
    for (const resource of data.media_resources || []) {
      const track = resource.entity?.track_wrapper?.track || resource.entity?.track || resource.track;
      if (track?.id && !ids.has(String(track.id))) {
        tracks.push(song(track));
        ids.add(String(track.id));
      }
    }
    cursor = String(data.next_cursor || '');
    if (!cursor || cursor === '0' || cursors.has(cursor) || tracks.length === previous || data.has_more === false) break;
    cursors.add(cursor);
  }
  if (!result) throw fail('没有找到这个公开歌单');
  return { ...result, tracks, trackCount: tracks.length };
}

async function detail(id) {
  id = String(id);
  if (!/^\d+$/.test(id)) throw fail('歌曲 ID 无效');
  const pending = pendingDetails.get(id);
  if (pending) return pending;
  const loading = request('/luna/h5/seo_track?track_id=' + encodeURIComponent(id) + '&device_platform=web');
  pendingDetails.set(id, loading);
  try {
    const data = await loading;
    if (lyricsCache.size >= 32 && !lyricsCache.has(id)) lyricsCache.delete(lyricsCache.keys().next().value);
    lyricsCache.set(id, { content: data.lyric?.content || '', until: Date.now() + 60000 });
    return data;
  } finally {
    pendingDetails.delete(id);
  }
}

export async function stream({ id, quality }) {
  const data = await detail(id);
  let model;
  try { model = JSON.parse(data.track_player?.video_model || '{}') || {}; }
  catch (_) { throw fail('汽水音乐返回了无效的播放信息'); }
  const fullDuration = Number(data.seo_track?.track?.duration || 0);
  const availableDuration = Number(model.video_duration || 0) * 1000;
  if (fullDuration > 0 && availableDuration + 2000 < fullDuration) {
    throw fail('这首歌当前只提供试听片段，请在汽水音乐客户端中播放');
  }
  const variants = Object.values(model.video_list || {}).filter(v => {
    const meta = v?.video_meta || {};
    const url = v?.main_url;
    return meta.codec_type === 'aac' && ['aac', 'm4a'].includes(meta.vtype) &&
      typeof url === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)+douyinvod\.com\//i.test(url) && !/[\x00-\x20\x7f\\]/.test(url);
  });
  variants.sort((a, b) => Number(a.video_meta.bitrate || 0) - Number(b.video_meta.bitrate || 0));
  if (!variants.length) throw fail('这首歌暂时没有可用的 AAC 音频');
  const selected = quality === 'standard' ? variants[0] : variants[variants.length - 1];
  return {
    url: selected.main_url,
    type: selected.video_meta.vtype === 'aac' ? 'aac' : 'm4a',
    size: Number(selected.video_meta.size || 0),
    bitRate: Number(selected.video_meta.bitrate || 0),
    quality: quality === 'standard' ? 'standard' : 'high',
    headers: { 'User-Agent': WEB_UA },
  };
}

export async function lyrics({ id }) {
  const cached = lyricsCache.get(String(id));
  const content = cached?.until > Date.now() ? cached.content : (await detail(id)).lyric?.content || '';
  const lines = [];
  for (const raw of content.split('\n')) {
    const header = /^\[(\d+),(\d+)\](.*)$/.exec(raw);
    if (!header) continue;
    const start = Number(header[1]);
    const words = [];
    const pattern = /<(\d+),(\d+),\d+>([^<]*)/g;
    let part;
    while ((part = pattern.exec(header[3])) !== null) {
      const wordStart = start + Number(part[1]);
      words.push({ start: wordStart, end: wordStart + Number(part[2]), text: part[3] });
    }
    const text = words.length ? words.map(w => w.text).join('') : header[3];
    lines.push({ start, end: start + Number(header[2]), text, words });
  }
  return lines.length ? { lines } : { lrc: content };
}

let categoryCache = null;

async function categories() {
  if (categoryCache && categoryCache.until > Date.now()) return categoryCache.items;
  const data = await request('/luna/discover', {});
  const found = new Map();
  for (const block of data.blocks || []) {
    for (const inner of block.inner_block || []) {
      for (const resource of inner.resources || []) {
        if (resource.type !== 'radio') continue;
        const radio = resource.entity?.radio;
        const style = resource.style || {};
        const id = String(radio?.radio_id || resource.resource_id || '');
        if (!/^\d+$/.test(id)) continue;
        found.set(id, {
          id,
          title: radio?.radio_name || style.title || inner.title || '音乐分类',
          subtitle: style.desc || '',
          imageUrl: image(style.cover_url_list?.[0] || radio?.url_cover),
          page: 'radio:' + id,
        });
      }
    }
  }
  const items = [...found.values()];
  if (!items.length) throw fail('汽水音乐暂时没有返回分类，请稍后刷新');
  categoryCache = { until: Date.now() + 60000, items };
  return items;
}

export async function browse({ page }) {
  if (page === LOGIN_PAGE) {
    const all = await playlists();
    return { title: '我的汽水音乐', sections: [
      { title: '我的歌单', playlists: all.filter(list => list.mine && !list.fixed) },
      { title: '收藏的歌单', playlists: all.filter(list => list.saved) },
      { title: '系统歌单', playlists: all.filter(list => list.mine && list.fixed) },
    ] };
  }
  if (page === 'recommended') {
    return { title: '精选歌单', sections: [{ playlists: await recommendations() }] };
  }
  if (page === 'categories') {
    return { title: '风格与场景', sections: [{ links: await categories() }] };
  }
  if (page.startsWith('radio:')) {
    const id = page.slice(6);
    if (!/^\d+$/.test(id)) throw fail('分类 ID 无效');
    const all = await categories();
    const category = all.find(item => item.id === id);
    const data = await request('/luna/feed/radio/tracks', { radio_id: id, count: 30, cursor: '' });
    const tracks = [];
    const ids = new Set();
    for (const item of data.items || []) {
      const track = item.entity?.track_wrapper?.track || item.entity?.track || item.track;
      if (track?.id && !ids.has(String(track.id))) { tracks.push(song(track)); ids.add(String(track.id)); }
    }
    if (!tracks.length) throw fail('这个分类暂时没有可用歌曲');
    return { title: category?.title || '分类音乐', subtitle: category?.subtitle || '', sections: [{ tracks }] };
  }
  throw fail('没有这个页面');
}

// 歌手目录沿用 PC 客户端公开合同；游标按账号代次隔离，避免切换账号后续页串用。
const artistCursors = new Map();
async function artistRequest(path, query) {
  const device = host.storage.get(DEVICE_KEY);
  if (!accountID(device?.id) || !accountID(device?.install)) throw loginRequired();
  // 作者元数据是公开请求，不携带账号 Cookie；客户端参数复用已验证的 PC 合同。
  return accountRequest(path, {
    aid: APP_ID, app_name: 'luna_pc', region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
    device_id: device.id, iid: device.install, cdid: '', fp: device.id, version_name: CLIENT_VERSION, version_code: '30070000',
    channel: 'official', build_mode: 'master', network_carrier: '', ac: 'wifi', tz_name: 'Asia/Shanghai', resolution: '',
    device_platform: 'windows', device_type: 'Windows', os_version: 'Windows 10', ...query,
  }, [], { headers: { 'User-Agent': 'LunaPC/3.7.0(452316191)', 'Accept-Encoding': 'identity',
    'X-Luna-Background-Type': 'foreground', 'X-Luna-Is-Background-Req': '0', 'X-Luna-Is-Local-User': '0' } });
}
export async function artist({ id, offset = 0 }) {
  id = accountID(id);
  if (!id || !Number.isSafeInteger(offset) || offset < 0) throw fail('无效的歌手或分页位置');
  return withLibrary(async () => {
    const key = `${accountRevision}:${id}`;
    const cursor = offset ? artistCursors.get(`${key}:${offset}`) : '';
    if (cursor == null) throw fail('歌手分页已过期，请重新打开主页');
    const path = `/luna/pc/artists/${id}`;
    const detail = await artistRequest(path, { locate_item_id: '' });
    if (accountID(detail.artist_info?.id) !== id || !detail.artist_info.name) throw fail('汽水音乐歌手资料无效');
    const listed = await artistRequest(path + '/tracks', { cursor, count: '50', sort_type: '0' });
    if (!Array.isArray(listed.tracks)) throw fail('汽水音乐歌手作品响应无效');
    const tracks = listed.tracks.map(song);
    const next = String(listed.next_cursor ?? '');
    const more = listed.has_more === true;
    if (more && (!tracks.length || !next || next === '0' || next === cursor)) throw fail('汽水音乐歌手分页未前进');
    if (artistCursors.size > 256) artistCursors.clear();
    if (more) artistCursors.set(`${key}:${offset + tracks.length}`, next);
    let albums = [];
    if (offset === 0) {
      try {
        const list = await artistRequest(path + '/albums', { cursor: '', count: '50' });
        if (Array.isArray(list.albums)) albums = list.albums.map(a => ({ id: String(a.id), name: a.name || '', imageUrl: image(a.url_cover) }));
      } catch (error) { if (['signIn', 'verify', 'cancelled'].includes(error.code)) throw error; }
    }
    const info = detail.artist_info;
    return { artist: { id, name: info.name, imageUrl: image(info.url_avatar), description: info.description || info.intro || '' }, tracks, albums, more };
  });
}
