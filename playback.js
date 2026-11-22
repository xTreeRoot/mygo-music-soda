/** 将官方授权音源转换成通用播放器资源；账号、内容密钥不写日志或文件。 */
const unavailable = message => Object.assign(new Error(message), { code: 'unavailable' });

/** spade_a 是本次授权附带的内容密钥封装，平台格式只在插件内解释。 */
export function contentKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw unavailable('汽水音乐返回的音频授权无效');
  let bytes;
  try { bytes = Array.from(atob(value), char => char.charCodeAt(0)); }
  catch { throw unavailable('汽水音乐返回的音频授权无效'); }
  if (bytes.length < 4) throw unavailable('汽水音乐返回的音频授权无效');
  const padding = (bytes[0] ^ bytes[1] ^ bytes[2]) - 48;
  if (padding < 0 || padding + 2 >= bytes.length) throw unavailable('汽水音乐返回的音频授权无效');
  const payload = bytes.slice(1, bytes.length - padding);
  const plain = payload.map((byte, index) => {
    let bits = index, count = 0;
    while (bits) { count++; bits &= bits - 1; }
    let decoded = (byte ^ (index < 2 ? [250, 85][index] : payload[index - 2])) - count - 21;
    while (decoded < 0) decoded += 255;
    return String.fromCharCode(decoded);
  }).join('');
  const skip = parseInt(plain[0], 36), key = plain.slice(1, plain.length - skip);
  if (!/^[0-9a-z]$/.test(plain[0]) || !/^[a-f\d]{32}$/i.test(key)) throw unavailable('汽水音乐返回的音频授权无效');
  return key.toLowerCase();
}

export function playbackResource(data, quality, userAgent) {
  let model;
  try { model = JSON.parse(data.track_player?.video_model || '{}') || {}; }
  catch { throw unavailable('汽水音乐返回了无效的播放信息'); }
  const full = Number(data.track?.duration || data.seo_track?.track?.duration || 0);
  if (full > 0 && Number(model.video_duration || 0) * 1000 + 2000 < full) throw unavailable('这首歌当前只提供试听片段，请确认已登录有播放权限的汽水音乐账号');
  const variants = Object.values(model.video_list || {}).filter(row => {
    const meta = row?.video_meta || {};
    return meta.codec_type === 'aac' && ['aac', 'm4a'].includes(meta.vtype) &&
      (!meta.quality || ['medium', 'higher', 'highest'].includes(meta.quality)) &&
      typeof row.main_url === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)+douyinvod\.com\//i.test(row.main_url) && !/[\x00-\x20\x7f\\]/.test(row.main_url);
  }).sort((a, b) => Number(a.video_meta.bitrate || 0) - Number(b.video_meta.bitrate || 0));
  if (!variants.length) throw unavailable('这首歌暂时没有可用的 AAC 音频');
  const selected = quality === 'standard' ? variants[0] : variants[variants.length - 1];
  let encryption;
  if (selected.encrypt_info?.encrypt) {
    if (globalThis.host?.capabilities?.cencAudio !== true) throw unavailable('当前宿主暂不支持会员加密音频，请使用支持该能力的山海版本');
    if (selected.encrypt_info.encryption_method !== 'cenc-aes-ctr') throw unavailable('汽水音乐返回了暂不支持的音频加密格式');
    encryption = { scheme: 'cenc', key: contentKey(selected.encrypt_info.spade_a) };
  }
  return {
    url: selected.main_url, type: encryption || selected.video_meta.vtype !== 'aac' ? 'm4a' : 'aac',
    size: Number(selected.video_meta.size || 0), bitRate: Number(selected.video_meta.bitrate || 0),
    quality: quality === 'standard' ? 'standard' : 'high', headers: { 'User-Agent': userAgent },
    ...(encryption ? { encryption } : {}),
  };
}
