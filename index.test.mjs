import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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

test('video_model is not a video capability and only native AAC reaches the player', async () => {
  const preferred = variant(128000);
  const { plugin } = await setup({ video_duration: 180, video_list: {
    muxed: { ...variant(1000000), video_meta: { codec_type: 'aac', vtype: 'mp4', bitrate: 1000000 } },
    credentialed: { ...variant(256000), main_url: 'https://name@v1.douyinvod.com/wrong' },
    unsafe: { ...variant(256000), main_url: 'https://outside.test\\@v1.douyinvod.com/wrong' },
    preferred,
  } });
  const audio = await plugin.stream({ id: '123' });
  assert.equal(audio.url, preferred.main_url);
  assert.equal(plugin.video, undefined);
});

test('discover shows real playlist artwork and category shortcuts without loading a random playlist', async () => {
  const requests = [];
  const playlists = Array.from({ length: 8 }, (_, index) => ({ id: 100 + index, name: `List ${index}`, url_cover: `https://cover.test/playlist-${index}` }));
  const categories = Array.from({ length: 7 }, (_, index) => ({ type: 'radio', entity: { radio: { radio_id: 200 + index, radio_name: `Mood ${index}` } },
    style: { desc: `Description ${index}`, cover_url_list: [`https://cover.test/category-${index}`] } }));
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push(path);
    const answers = {
      '/luna/discover/mix': { inner_block: [{ resources: playlists.map(playlist => ({ entity: { playlist } })) }] },
      '/luna/discover': { blocks: [{ inner_block: [{ resources: categories }] }] },
      '/luna/feed/radio/tracks': { items: [{ track: { id: '301', name: 'Category track' } }] },
    };
    assert.ok(answers[path], path);
    if (path === '/luna/feed/radio/tracks') assert.equal(JSON.parse(options.body).radio_id, '200');
    return { ok: true, json: async () => answers[path] };
  };
  const plugin = await import(`./index.js?test=${++sequence}`);
  const home = await plugin.home();
  assert.deepEqual(requests, ['/luna/discover/mix', '/luna/discover']);
  const [featured, moods] = home.sections;
  assert.equal(featured.playlists.length, 5);
  assert.equal(featured.playlists[0].imageUrl, playlists[0].url_cover);
  assert.equal(moods.links.length, 5);
  assert.equal(moods.links[0].imageUrl, categories[0].style.cover_url_list[0]);
  assert.equal((await plugin.browse({ page: featured.morePage })).sections[0].playlists.length, 8);
  assert.equal((await plugin.browse({ page: moods.morePage })).sections[0].links.length, 7);
  assert.equal((await plugin.browse({ page: moods.links[0].page })).sections[0].tracks[0].name, 'Category track');
});

test('a recommendation outage keeps categories accessible', async () => {
  globalThis.fetch = async url => new URL(url).pathname.endsWith('/mix') ? { ok: false, status: 503 } : {
    ok: true, json: async () => ({ blocks: [{ inner_block: [{ resources: [{ type: 'radio', entity: { radio: { radio_id: 200, radio_name: 'Mood' } } }] }] }] }),
  };
  const plugin = await import(`./index.js?test=${++sequence}`);
  const home = await plugin.home();
  assert.ok(home.sections.flatMap(section => section.links || []).some(link => link.page === 'radio:200'));
  assert.ok(home.sections.flatMap(section => section.links || []).some(link => link.page === 'recommended'));
});

const accountOrigin = 'https://api.qishui.com';
const fixtureAccount = '9012345678901234561';
const fixtureList = '9012345678901234562';
const fixtureTrack = '9012345678901234563';
const fixtureQR = 'https://bff-pc.qishui.com/fixture';
const qrPath = '/passport/web/get_qrcode/';
const pollPath = '/passport/web/check_qrconnect/';
const mePath = '/luna/pc/me';
const libraryPath = '/luna/pc/me/playlist';
const detailPath = '/luna/pc/playlist/detail';

function response(payload, { cookies = [], status = 200, location } = {}) {
  return { status, headers: { getSetCookie: () => cookies, get: key => key === 'location' ? location : null },
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload) };
}

function accountFixture() {
  const storage = new Map();
  const prompts = [];
  const requests = [];
  const reply = new Map([
    [qrPath, () => response({ message: 'success', data: { token: 'fixture-ticket', qrcode_index_url: fixtureQR } }, {
      cookies: ['passport_csrf_token=fixture-csrf; Path=/passport; Secure', 'unrelated=discard; Domain=outside.test; Path=/'],
    })],
    [pollPath, () => response({ message: 'success', data: { status: 'confirmed' } }, {
      cookies: ['sessionid=fixture-session; Path=/; Secure; HttpOnly', 'unrelated=discard; Path=/passport', 'expired=discard; Path=/; Max-Age=0'],
    })],
    [mePath, () => response(`{"my_info":{"id":${fixtureAccount},"nickname":"汽水测试 9012345678901234561"}}`)],
  ]);
  globalThis.host = {
    platform: 'ios',
    crypto: { md5: value => createHash('md5').update(value).digest('hex') },
    signInPrompt: value => prompts.push(value),
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, structuredClone(value)) },
  };
  globalThis.fetch = async (address, options) => {
    const url = new URL(address);
    requests.push({ url, options });
    assert.ok(reply.has(url.pathname), url.pathname);
    return reply.get(url.pathname)(url, options);
  };
  return { storage, prompts, requests, reply };
}

function fastPolling(context) {
  const setTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, ms) => setTimeout(callback, ms === 2000 ? 0 : ms));
}

test('QR waits for confirmation, validates an exact account ID and scopes the stored login', async context => {
  fastPolling(context);
  const { storage, prompts, requests, reply } = accountFixture();
  const confirm = reply.get(pollPath);
  let polls = 0;
  reply.set(pollPath, (url, options) => {
    assert.equal(url.origin, accountOrigin);
    assert.equal(new URLSearchParams(options.body).get('token'), 'fixture-ticket');
    assert.equal(options.headers.Cookie, 'passport_csrf_token=fixture-csrf');
    assert.equal(options.headers['x-ss-stub'], createHash('md5').update(options.body).digest('hex').toUpperCase());
    return ++polls === 1 ? response({ message: 'success', data: { status: 'scanned' } }) : confirm();
  });
  const plugin = await import(`./index.js?test=${++sequence}`);
  const profile = await plugin.signIn();
  assert.equal(profile.id, fixtureAccount);
  assert.equal(profile.name, `汽水测试 ${fixtureAccount}`);
  assert.equal(profile.page, 'my-library');
  assert.equal(prompts.filter(prompt => prompt.qr === fixtureQR).length, 2);
  assert.deepEqual(requests.map(item => item.url.pathname), [qrPath, pollPath, pollPath, mePath]);
  assert.equal(requests.at(-1).options.headers.Cookie, 'sessionid=fixture-session');
  assert.deepEqual(storage.get('qishuiAccount').cookies.map(item => item.name), ['sessionid']);
});

test('logout stays disabled across reload, and login checks saved credentials online before reuse', async context => {
  fastPolling(context);
  const { requests, storage, reply } = accountFixture();
  const before = await import(`./index.js?test=${++sequence}`);
  await before.signIn();
  before.signOut();
  const after = await import(`./index.js?test=${++sequence}`);
  requests.length = 0;
  assert.equal(await after.account(), null);
  await assert.rejects(after.playlists(), { code: 'signIn' });
  assert.equal(requests.length, 0);
  assert.equal((await after.signIn()).id, fixtureAccount);
  assert.deepEqual(requests.map(item => item.url.pathname), [mePath]);
  reply.set(mePath, () => response({ status_code: 1000016 }));
  assert.equal(await after.account(), null);
  assert.equal(storage.get('qishuiAccount').active, false);
});

test('cancelled and challenge-required logins never save or fall back to another client', async context => {
  fastPolling(context);
  const { storage, requests, reply } = accountFixture();
  const plugin = await import(`./index.js?test=${++sequence}`);
  let cancelAtPoll;
  const polling = new Promise(resolve => { cancelAtPoll = resolve; });
  let lateReply;
  reply.set(pollPath, () => { cancelAtPoll(); return new Promise(resolve => { lateReply = resolve; }); });
  const signingIn = plugin.signIn();
  await polling;
  plugin.cancelSignIn();
  lateReply(response({ message: 'success', data: { status: 'confirmed' } }, { cookies: ['sessionid=fixture-late; Path=/'] }));
  await assert.rejects(signingIn, { code: 'cancelled' });
  assert.equal(storage.size, 0);
  requests.length = 0;
  reply.set(pollPath, () => response({ message: 'error', data: { error_code: 2046, redirect_url: 'https://outside.test/verify' } }));
  await assert.rejects(plugin.signIn(), { code: 'verify' });
  assert.deepEqual(requests.map(item => item.url.pathname), [qrPath, pollPath]);
  assert.equal(storage.size, 0);
});

test('only the platform can mint a new session and an outside QR or redirect is rejected', async context => {
  fastPolling(context);
  const { storage, requests, reply } = accountFixture();
  const original = reply.get(qrPath);
  const plugin = await import(`./index.js?test=${++sequence}`);
  reply.set(qrPath, () => response({ message: 'success', data: { token: 'fake', qrcode_index_url: 'https://outside.test/qr' } }));
  await assert.rejects(plugin.signIn(), { code: 'unavailable' });
  assert.equal(requests.length, 1);
  reply.set(qrPath, original);
  reply.set(pollPath, () => response({ message: 'success', data: { status: 'confirmed', redirect_url: 'https://outside.test/finish' } }));
  await assert.rejects(plugin.signIn(), { code: 'unavailable' });
  assert.ok(requests.every(item => item.url.origin === accountOrigin));
  assert.equal(storage.size, 0);
});

test('account library paginates private, saved and system lists and uses only the owned favorites list for likes', async context => {
  fastPolling(context);
  const { requests, reply } = accountFixture();
  reply.set(libraryPath, (url, options) => {
    assert.equal(options.headers.Cookie, 'sessionid=fixture-session');
    const own = `{"id":${fixtureList},"title":"私密歌单","type":2,"owner":{"id":${fixtureAccount}}}`;
    return url.searchParams.get('cursor') === 'next' ? response(`{"playlists":[${own},{"id":"31","title":"喜欢的歌曲","type":1,"owner":{"id":${fixtureAccount}}},{"id":"32","title":"别人收藏夹","type":1,"owner":{"id":"100"}}]}`) :
      response(`{"playlists":[${own},{"id":"33","title":"收藏的歌单","owner":{"id":"100"},"state":{"is_collected":true}}],"has_more":true,"next_cursor":"next"}`);
  });
  reply.set(detailPath, (url, options) => {
    assert.equal(options.headers.Cookie, 'sessionid=fixture-session');
    const isNext = url.searchParams.get('cursor') === 'more';
    return isNext ? response({ has_more: false, media_resources: [{ entity: { track_wrapper: { track: { id: '35', name: 'Unavailable' } } } }] }) :
      response(`{"has_more":true,"next_cursor":"more","media_resources":[{"entity":{"track":{"id":${fixtureTrack},"name":"Private track","vid":"fixture-vid","duration":123456}}}]}`);
  });
  const plugin = await import(`./index.js?test=${++sequence}`);
  await plugin.signIn();
  const library = await plugin.browse({ page: 'my-library' });
  assert.deepEqual(library.sections.map(item => item.playlists.map(list => list.id)), [[`account:${fixtureList}`], ['account:33'], ['account:31']]);
  const detail = await plugin.playlist({ id: `account:${fixtureList}` });
  assert.deepEqual(detail.tracks.map(track => track.id), [fixtureTrack, '35']);
  assert.equal(detail.tracks[1].unavailable, true);
  assert.deepEqual((await plugin.liked()).tracks.map(track => track.id), [fixtureTrack, '35']);
  assert.equal(requests.at(-1).url.searchParams.get('playlist_id'), '31');
  await assert.rejects(plugin.playlist({ id: 'account:99999' }), { code: 'unavailable' });
  assert.equal(requests.filter(item => item.url.pathname === detailPath).length, 4);
});

test('rejects broken pagination and does not turn a missing favorites endpoint into an empty list', async context => {
  fastPolling(context);
  const { reply } = accountFixture();
  const plugin = await import(`./index.js?test=${++sequence}`);
  await plugin.signIn();
  reply.set(libraryPath, () => response({ playlists: [], has_more: true, next_cursor: 'repeat' }));
  await assert.rejects(plugin.playlists(), /分页未前进/);
  reply.set(libraryPath, () => response({ playlists: [], has_more: false }));
  await assert.rejects(plugin.liked(), /未向当前设备提供/);
});
