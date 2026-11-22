import test from 'node:test';
import assert from 'node:assert/strict';
import { contentKey, playbackResource } from './playback.js';

const key = '00112233445566778899aabbccddeeff';
function authEnvelope(plain = '0' + key) {
  const encoded = [];
  for (const [index, char] of [...plain].entries()) {
    let bits = index, count = 0;
    while (bits) { count++; bits &= bits - 1; }
    encoded.push((char.charCodeAt(0) + count + 21) ^ (index < 2 ? [250, 85][index] : encoded[index - 2]));
  }
  return Buffer.from([encoded[0] ^ encoded[1] ^ 48, ...encoded]).toString('base64');
}
function grant(duration = 231.864) {
  return { track: { id: '123', duration: 231864 }, track_player: { video_model: JSON.stringify({
    video_duration: duration, video_list: { high: {
      main_url: 'https://v1.douyinvod.com/audio',
      video_meta: { vtype: 'm4a', codec_type: 'aac', quality: 'highest', bitrate: 256000 },
      encrypt_info: { encrypt: true, encryption_method: 'cenc-aes-ctr', spade_a: authEnvelope() },
    } },
  }) } };
}

test('interprets only the content key supplied with this media grant', () => {
  assert.equal(contentKey(authEnvelope()), key);
  for (const invalid of ['', 'A', 'https://example.test/key', authEnvelope('0not-a-key')]) assert.throws(() => contentKey(invalid), { code: 'unavailable' });
});

test('requires complete grants, supported protection and a capable host', () => {
  globalThis.host = { capabilities: { cencAudio: true } };
  const resource = playbackResource(grant(), 'high', 'fixture');
  assert.deepEqual(resource.encryption, { scheme: 'cenc', key });
  assert.throws(() => playbackResource(grant(60), 'high', 'fixture'), /试听/);
  const unsupported = grant(), model = JSON.parse(unsupported.track_player.video_model);
  model.video_list.high.encrypt_info.encryption_method = 'unsupported';
  unsupported.track_player.video_model = JSON.stringify(model);
  assert.throws(() => playbackResource(unsupported, 'high', 'fixture'), /加密格式/);
  globalThis.host = {};
  assert.throws(() => playbackResource(grant(), 'high', 'fixture'), /宿主/);
});

test('active account participates in native mobile playback authorization; logout invalidates late grants', async () => {
  const session = { version: 1, id: '456', active: true, cookies: [{ name: 'sessionid', value: 'fixture-session', domain: 'qishui.com', path: '/' }] };
  const storage = new Map([['qishuiAccount', session]]);
  globalThis.host = { capabilities: { cencAudio: true }, storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) } };
  let release;
  globalThis.fetch = async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.qishui.com');
    assert.equal(url.pathname, '/luna/track');
    assert.equal(url.searchParams.get('device_platform'), 'web');
    assert.equal(url.searchParams.get('track_id'), '123');
    assert.equal(options.headers.Cookie, 'sessionid=fixture-session');
    if (release) await new Promise(resolve => { release = resolve; });
    return { status: 200, url: address, headers: { get: () => null, getSetCookie: () => [] }, text: async () => JSON.stringify(grant()) };
  };
  const plugin = await import('./index.js?member-playback');
  const audio = await plugin.stream({ id: '123', quality: 'high' });
  assert.equal(audio.encryption.key, key);
  release = true;
  const pending = plugin.stream({ id: '123' });
  await Promise.resolve();
  plugin.signOut(); release();
  await assert.rejects(pending, { code: 'signIn' });
  assert.equal(storage.get('qishuiAccount').active, false);
});
