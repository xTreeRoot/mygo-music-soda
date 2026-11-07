const API = 'https://beta-luna.douyin.com';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const details = new Map();

function fail(message) {
  const error = new Error(message);
  error.code = 'unavailable';
  return error;
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
  const playlists = await recommendations();
  const sections = [{ title: '推荐歌单', playlists }, { title: '音乐分类', links: [{ title: '浏览音乐分类', subtitle: '按风格和场景发现音乐', page: 'categories' }] }];
  // Put real tracks on the home page as well, for one-click listening.
  const first = await playlist({ id: playlists[0].id });
  if (first.tracks.length) sections.push({ title: first.name, tracks: first.tracks.slice(0, 12) });
  return {
    title: 'Soda',
    subtitle: '公开歌单 · 原生 AAC 播放',
    sections,
  };
}

export async function playlist({ id }) {
  id = String(id);
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
  const cached = details.get(id);
  if (cached && cached.until > Date.now()) return cached.promise;
  const entry = {
    until: Date.now() + 60000,
    promise: request('/luna/h5/seo_track?track_id=' + encodeURIComponent(id) + '&device_platform=web'),
  };
  if (details.size >= 32) details.delete(details.keys().next().value);
  details.set(id, entry);
  try { return await entry.promise; }
  catch (error) { if (details.get(id) === entry) details.delete(id); throw error; }
}

export async function stream({ id, quality }) {
  const data = await detail(id);
  let model;
  try { model = JSON.parse(data.track_player?.video_model || '{}'); }
  catch (_) { throw fail('汽水音乐返回了无效的播放信息'); }
  const fullDuration = Number(data.seo_track?.track?.duration || 0);
  const availableDuration = Number(model.video_duration || 0) * 1000;
  if (fullDuration > 0 && availableDuration + 2000 < fullDuration) {
    throw fail('这首歌当前只提供试听片段，请在汽水音乐客户端中播放');
  }
  const variants = Object.values(model.video_list || {}).filter(v => {
    const meta = v.video_meta || {};
    return meta.codec_type === 'aac' && /^https:\/\/[^/]+\.douyinvod\.com\//.test(v.main_url || '');
  });
  variants.sort((a, b) => Number(a.video_meta.bitrate || 0) - Number(b.video_meta.bitrate || 0));
  if (!variants.length) throw fail('这首歌暂时没有可用的 AAC 音频');
  const selected = quality === 'standard' ? variants[0] : variants[variants.length - 1];
  return {
    url: selected.main_url,
    type: selected.video_meta.vtype === 'aac' ? 'aac' : 'm4a',
    size: Number(selected.video_meta.size || 0),
    headers: { 'User-Agent': WEB_UA },
  };
}

export async function lyrics({ id }) {
  const data = await detail(id);
  const content = data.lyric?.content || '';
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
  if (page === 'categories') {
    return { title: '音乐分类', sections: [{ title: '风格与场景', links: await categories() }] };
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

const PASSPORT = 'https://api.qishui.com';
const AUTH_QUERY = 'passport_jssdk_version=2.4.13&passport_jssdk_type=normal&is_from_ttaccountsdk=1&aid=386088';
let loginEpoch = 0;
let accountCheckedAt = 0;

function loginError(message, expired = false) {
  const error = new Error(message);
  if (expired) error.code = 'signIn';
  return error;
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([name, value]) => name + '=' + value).join('; ');
}

async function passport(path, cookies, form) {
  const stage = path.startsWith('/passport/web/get_qrcode/') ? '生成二维码'
    : path.startsWith('/passport/web/check_qrconnect/') ? '查询扫码状态' : '验证登录账号';
  const csrf = cookies.passport_csrf_token || cookies.passport_csrf_token_default;
  let response;
  try {
    response = await fetch(PASSPORT + path, {
      method: form ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': WEB_UA,
        Accept: 'application/json, text/javascript',
        ...(csrf ? { 'x-tt-passport-csrf-token': csrf } : {}),
        Origin: 'https://www.qishui.com',
        Referer: 'https://www.qishui.com/',
        ...(Object.keys(cookies).length ? { Cookie: cookieHeader(cookies) } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
  } catch (_) {
    throw loginError(stage + '失败：无法连接汽水账号服务，请检查网络后重试');
  }
  if (!response.ok) throw loginError(stage + '失败（HTTP ' + response.status + '），请稍后重试', response.status === 401);
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0];
    const equal = pair.indexOf('=');
    if (equal <= 0) continue;
    const name = pair.slice(0, equal).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    if (/;\s*max-age=0(?:;|$)/i.test(line)) delete cookies[name];
    else cookies[name] = pair.slice(equal + 1);
  }
  let result;
  try {
    const text = await response.text();
    // Account identifiers may be larger than JavaScript's exact integer range.
    result = JSON.parse(text.replace(/("user_id"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"'));
  } catch (_) {
    throw loginError(stage + '失败：汽水账号服务没有返回有效数据，请稍后重试');
  }
  if (!result || typeof result !== 'object') throw loginError(stage + '失败：账号服务响应格式无效');
  const data = result.data || result;
  const code = Number(data.error_code || result.error_code || 0);
  if (code === 13) throw loginError('汽水登录已过期，请重新扫码', true);
  if (code === 2046) throw loginError('汽水要求额外验证，请先在官方客户端完成验证，再重新扫码');
  if (code || result.message === 'error') {
    const detail = Number.isSafeInteger(code) && code !== 0 ? '服务码 ' + code : '服务未提供错误码';
    throw loginError(stage + '失败（' + detail + '）。请保留此提示，勿反复扫码');
  }
  return data;
}

async function profile(cookies) {
  const data = await passport('/passport/account/info/v2/?' + AUTH_QUERY, cookies);
  const id = String(data.user_id || '');
  if (!/^\d+$/.test(id) || /^0+$/.test(id)) throw loginError('汽水账号服务未确认登录，请重新扫码', true);
  return {
    id,
    name: data.screen_name || data.nickname || data.name || 'Soda 用户',
    imageUrl: image(data.avatar_url || data.avatar),
  };
}

export async function account() {
  const epoch = loginEpoch;
  const session = host.storage.get('session');
  if (!session?.cookies || !session.profile) return null;
  if (Date.now() - accountCheckedAt < 60000) return session.profile;
  try {
    const user = await profile(session.cookies);
    if (epoch !== loginEpoch) return null;
    host.storage.set('session', { cookies: session.cookies, profile: user });
    accountCheckedAt = Date.now();
    return user;
  } catch (error) {
    if (epoch === loginEpoch && error.code === 'signIn') {
      host.storage.remove('session');
      accountCheckedAt = 0;
      return null;
    }
    throw error;
  }
}

export async function signIn() {
  if (!['darwin', 'windows'].includes(host.platform)) throw loginError('Soda 扫码登录目前仅支持 macOS 和 Windows，公开内容仍可使用');
  const epoch = ++loginEpoch;
  const cookies = Object.create(null);
  host.signInPrompt({ text: '正在生成汽水音乐登录二维码…' });
  const data = await passport('/passport/web/get_qrcode/?' + AUTH_QUERY + '&next=https%3A%2F%2Fapi.qishui.com&need_logo=false&need_short_url=false&is_new_login=1', cookies);
  if (epoch !== loginEpoch) throw loginError('登录已取消');
  let source;
  try { source = new URL(data.qrcode_index_url); }
  catch (_) { throw loginError('汽水音乐没有返回有效登录二维码'); }
  const qrToken = source.searchParams.get('token');
  if (source.protocol !== 'https:' || source.hostname !== 'bff-pc.qishui.com' || !qrToken || !data.token) {
    throw loginError('汽水音乐没有返回有效登录二维码');
  }
  // The official desktop client wraps the SDK token in Soda's mobile scan page.
  const qr = new URL('https://bff-pc.qishui.com/light/invoke/scan_login');
  qr.searchParams.set('token', qrToken);
  qr.searchParams.set('os', host.platform === 'darwin' ? 'Mac' : 'Windows');
  qr.searchParams.set('computer_name', 'Soda');
  host.signInPrompt({ qr: qr.toString(), text: '请打开汽水音乐 App 扫一扫，并在手机上确认登录' });
  const expiry = Number(data.expire_time || 0);
  const expiresAt = expiry > 1e12 ? expiry : expiry > 1e9 ? expiry * 1000 : Date.now() + (expiry || 180) * 1000;
  const deadline = Math.min(Date.now() + 180000, expiresAt);
  while (Date.now() < deadline && epoch === loginEpoch) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (epoch !== loginEpoch) break;
    const state = await passport('/passport/web/check_qrconnect/?' + AUTH_QUERY, cookies, {
      need_logo: 'false', need_short_url: 'false', is_frontier: 'true', token: data.token, is_new_login: '1', next: PASSPORT,
    });
    if (epoch !== loginEpoch) break;
    const status = String(state.status || '');
    if (['4', '5', 'refused', 'expired', 'cancelled'].includes(status)) {
      throw loginError('二维码已失效或登录已取消，请重新扫码');
    }
    if (['2', 'scanned'].includes(status)) host.signInPrompt({ qr: qr.toString(), text: '已扫码，请在汽水音乐 App 中确认登录' });
    if (['3', 'confirmed'].includes(status)) {
      if (!cookies.sessionid && !cookies.sessionid_ss) throw loginError('扫码已确认，但汽水未返回可用会话，请重新登录');
      host.signInPrompt({ text: '扫码已确认，正在核验账号…' });
      const user = await profile(cookies);
      if (epoch !== loginEpoch) break;
      host.storage.set('session', { cookies, profile: user });
      accountCheckedAt = Date.now();
      host.signInPrompt({ text: '登录成功' });
      return user;
    }
  }
  throw loginError(epoch !== loginEpoch ? '登录已取消' : '二维码已过期，请重新扫码');
}

export function signOut() {
  loginEpoch++;
  accountCheckedAt = 0;
  host.storage.remove('session');
}
