import test from 'node:test';
import assert from 'node:assert/strict';

let sequence = 0;
const variant = bitrate => ({ main_url: `https://v1.douyinvod.com/audio/${bitrate}`, video_meta: { codec_type: 'aac', vtype: 'm4a', bitrate, size: 1000 } });
async function setup(model = { video_duration: 180, video_list: { low: variant(64000), high: variant(128000) } }, duration = 180000) {
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ track_player: { video_model: typeof model === 'string' ? model : JSON.stringify(model) }, seo_track: { track: { duration } } }) };
  };
  return { plugin: await import(`./index.js?test=${++sequence}`), requests };
}

test('lossless requests degrade to available native AAC; standard chooses a lower bitrate', async () => {
  const { plugin, requests } = await setup();
  const high = await plugin.stream({ id: '123', quality: 'lossless' });
  assert.equal(high.type, 'm4a');
  assert.equal(high.bitRate, 128000);
  assert.equal(high.quality, 'high');
  assert.equal((await plugin.stream({ id: '123', quality: 'standard' })).bitRate, 64000);
  assert.equal(requests.length, 1);
});

test('preview-only media is rejected rather than presented as a complete song', async () => {
  const { plugin } = await setup({ video_duration: 30, video_list: { high: variant(128000) } });
  await assert.rejects(plugin.stream({ id: '123' }), { code: 'unavailable', message: /试听/ });
});

test('invalid player data and unavailable codecs fail with a normal plugin error', async () => {
  for (const model of ['invalid JSON', { video_duration: 180, video_list: {} }, { video_duration: 180, video_list: { mp3: { ...variant(128000), video_meta: { codec_type: 'mp3' } } } }]) {
    const { plugin } = await setup(model);
    await assert.rejects(plugin.stream({ id: '123' }), { code: 'unavailable' });
  }
});

test('failed requests are not cached and numeric identifiers are validated before fetching', async () => {
  const { plugin, requests } = await setup();
  await assert.rejects(plugin.stream({ id: 'invalid' }), { code: 'unavailable' });
  assert.equal(requests.length, 0);
  const fetchWorking = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('temporary network failure'); };
  await assert.rejects(plugin.stream({ id: '123' }), /temporary network failure/);
  globalThis.fetch = fetchWorking;
  assert.ok((await plugin.stream({ id: '123' })).url);
});
