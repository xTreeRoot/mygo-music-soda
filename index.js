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
    title: '汽水音乐',
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
    bitRate: Number(selected.video_meta.bitrate || 0),
    quality: quality === 'standard' ? 'standard' : 'high',
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
