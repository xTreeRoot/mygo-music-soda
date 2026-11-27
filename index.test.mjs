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
  const raw = variant(64000);
  const { plugin, requests } = await setup({ video_duration: 180, video_list: {
    low: { ...raw, video_meta: { ...raw.video_meta, vtype: 'aac' } }, high: variant(128000),
  } });
  const [high, standard] = await Promise.all([
    plugin.stream({ id: '123', quality: 'lossless' }),
    plugin.stream({ id: '123', quality: 'standard' }),
  ]);
  assert.equal(high.type, 'm4a');
  assert.equal(high.bitRate, 128000);
  assert.equal(high.quality, 'high');
  assert.equal(standard.type, 'aac');
  assert.equal(standard.bitRate, 64000);
  assert.equal(requests.length, 1);
});

test('each new media resolution can replace an expired URL without invalidating lyrics', async () => {
  const model = { video_duration: 180, video_list: { high: variant(128000) } };
  const { plugin, requests } = await setup(model);
  const input = { id: '123' };
  const first = await plugin.stream(input);
  await plugin.lyrics(input);
  assert.equal(requests.length, 1);
  model.video_list.high.main_url += '?renewed=1';
  assert.equal((await plugin.stream(input)).url, `${first.url}?renewed=1`);
  await plugin.lyrics(input);
  assert.equal(requests.length, 2);
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
const fixtureQR = 'https://bff-pc.qishui.com/ucenter_web/app/sdk-next?token=fixture-scan-ticket';
const fixtureScan = 'https://bff-pc.qishui.com/light/invoke/scan_login?token=fixture-scan-ticket&os=Windows&computer_name=MB%20iOS';
const devicePath = '/service/2/desktop/device_register/';
const fixtureDevice = { version: 1, clientVersion: '3.7.0', id: '9012345678901234564', install: '9012345678901234565' };
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
    [devicePath, (url, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      const { header, magic_tag } = JSON.parse(options.body);
      assert.equal(magic_tag, 'ss_app_log');
      assert.equal(header.aid, 386088);
      assert.equal(header.app_version, '3.7.0');
      assert.match(header.pc_uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.equal(header.pc_serial, '');
      return response({ device_id_str: fixtureDevice.id, install_id_str: fixtureDevice.install });
    }],
    [qrPath, () => response({ message: 'success', data: { token: 'fixture-ticket', qrcode_index_url: fixtureQR, copywriting: JSON.stringify({ desc: '为保障账号安全，请使用[color=red]「抖音 APP」[/]扫码验证' }) } }, {
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
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, structuredClone(value)), remove: key => storage.delete(key) },
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
    assert.equal(options.headers.Cookie, 'passport_csrf_token=fixture-csrf');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.match(options.headers['User-Agent'], /^Mozilla\/5\.0 /);
    assert.equal(options.headers['x-tt-passport-csrf-token'], 'fixture-csrf');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
      next: accountOrigin, need_logo: 'false', need_short_url: 'false', is_new_login: '1', token: 'fixture-ticket', is_frontier: 'true',
    });
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      aid: '386088', passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1', account_sdk_source: 'web',
      language: 'zh', device_platform: 'PC', version_code: '3.7.0', is_new_login: '1', is_from_iesaccountsaas: '1',
      device_id: fixtureDevice.id, did: fixtureDevice.id, install_id: fixtureDevice.install, iid: fixtureDevice.install,
    });
    return ++polls === 1 ? response({ message: 'success', data: { status: 'scanned' } }) : confirm();
  });
  const plugin = await import(`./index.js?test=${++sequence}`);
  const profile = await plugin.signIn();
  const create = requests.find(item => item.url.pathname === qrPath);
  assert.deepEqual(storage.get('qishuiDevice'), fixtureDevice);
  assert.equal(create.options.method, 'GET');
  assert.match(create.options.headers['User-Agent'], /^Mozilla\/5\.0 /);
  assert.deepEqual(Object.fromEntries(create.url.searchParams), {
    aid: '386088', passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1', account_sdk_source: 'web',
    language: 'zh', device_platform: 'PC', version_code: '3.7.0', is_new_login: '1', is_from_iesaccountsaas: '1',
    device_id: fixtureDevice.id, did: fixtureDevice.id, install_id: fixtureDevice.install, iid: fixtureDevice.install,
    next: accountOrigin, need_logo: 'false', need_short_url: 'false',
  });
  assert.equal(profile.id, fixtureAccount);
  assert.equal(profile.name, `汽水测试 ${fixtureAccount}`);
  assert.equal(profile.page, 'my-library');
  assert.equal(prompts.filter(prompt => prompt.qr === fixtureScan).length, 2);
  assert.equal(prompts.find(prompt => prompt.qr === fixtureScan).text, '请用汽水音乐 App 扫码，再在手机上确认');
  assert.deepEqual(requests.map(item => item.url.pathname), [devicePath, qrPath, pollPath, pollPath, mePath]);
  assert.equal(requests.at(-1).options.headers.Cookie, 'sessionid=fixture-session');
  assert.equal(requests.at(-1).options.headers['User-Agent'], 'LunaPC/3.0.0(290101097)');
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

test('a second installation restores the verified account and reads its private library without scanning', async context => {
  fastPolling(context);
  accountFixture();
  const desktop = await import(`./index.js?test=${++sequence}`);
  await desktop.signIn();
  const input = JSON.parse(JSON.stringify(await desktop.exportSession()));
  assert.deepEqual(Object.keys(input.session), ['cookies']);

  const phone = accountFixture();
  const mobile = await import(`./index.js?test=${++sequence}`);
  phone.reply.set(mePath, (_, options) => {
    assert.equal(options.headers.Cookie, 'sessionid=fixture-session');
    return response({ my_info: { id: fixtureAccount, nickname: 'Verified' } }, {
      cookies: ['sessionid=fixture-renewed; Path=/; Secure; HttpOnly'],
    });
  });
  phone.reply.set(libraryPath, (_, options) => {
    assert.equal(options.headers.Cookie, 'sessionid=fixture-renewed');
    return response({ playlists: [{ id: fixtureList, title: 'Private', owner: { id: fixtureAccount } }], has_more: false });
  });
  assert.equal(await mobile.account(), null);
  const verified = await mobile.validateSession(input);
  assert.equal(verified.id, fixtureAccount);
  assert.equal(phone.storage.size, 0);
  assert.equal(mobile.commitSession({ ...input, account: verified }).id, fixtureAccount);
  assert.equal(phone.storage.has('qishuiDevice'), false);
  assert.equal((await mobile.playlists())[0].id, `account:${fixtureList}`);
  assert.deepEqual(phone.requests.map(request => request.url.pathname), [mePath, libraryPath]);
  assert.deepEqual(phone.prompts, []);
});

test('an expired, foreign, or cancelled session cannot change installed account state', async context => {
  fastPolling(context);
  const { storage, requests, reply } = accountFixture();
  const plugin = await import(`./index.js?test=${++sequence}`);
  await plugin.signIn();
  const input = await plugin.exportSession();
  const before = structuredClone(storage.get('qishuiAccount'));
  assert.equal(await plugin.validateSession(input), null);
  assert.deepEqual(storage.get('qishuiAccount'), before);

  reply.set(mePath, () => response({ status_code: 1000016 }));
  await assert.rejects(plugin.exportSession(), { code: 'signIn' });
  assert.deepEqual(storage.get('qishuiAccount'), before);
  plugin.signOut();
  await assert.rejects(plugin.exportSession(), { code: 'signIn' });
  const inactive = structuredClone(storage.get('qishuiAccount'));
  requests.length = 0;
  const malformed = structuredClone(input);
  malformed.session.cookies[0].domain = 'outside.test';
  assert.equal(await plugin.validateSession(malformed), null);
  assert.equal(requests.length, 0);

  reply.set(mePath, () => response({ my_info: { id: '2', nickname: 'Other' } }));
  assert.equal(await plugin.validateSession(input), null);
  assert.equal(plugin.commitSession({ ...input, account: { id: fixtureAccount } }), null);
  reply.set(mePath, () => response({ status_code: 1000016 }));
  assert.equal(await plugin.validateSession(input), null);
  reply.set(mePath, () => response({ my_info: { id: fixtureAccount, nickname: 'Verified' } }));
  const verified = await plugin.validateSession(input);
  plugin.signOut();
  assert.equal(plugin.commitSession({ ...input, account: verified }), null);
  assert.deepEqual(storage.get('qishuiAccount'), inactive);
});

test('app-switch disconnects recover the same QR, pending cookies and verified profile', async context => {
  const timer = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, ms) => timer(callback, ms <= 2000 ? 0 : ms));
  const { storage, requests, prompts, reply } = accountFixture();
  const confirmed = reply.get(pollPath), profile = reply.get(mePath);
  let polls = 0, profiles = 0;
  reply.set(pollPath, (url, options) => {
    assert.equal(new URLSearchParams(options.body).get('token'), 'fixture-ticket');
    assert.equal(options.headers.Cookie, 'passport_csrf_token=fixture-csrf');
    polls++;
    if (polls === 1) return response({ message: 'success', data: { status: 'scanned' } });
    if (polls === 2) throw new TypeError('synthetic connection lost -1005');
    return confirmed();
  });
  reply.set(mePath, (url, options) => {
    assert.equal(options.headers.Cookie, 'sessionid=fixture-session');
    if (++profiles === 1) throw new TypeError('synthetic profile disconnect -1005');
    return profile();
  });
  const plugin = await import(`./index.js?test=${++sequence}`);
  assert.equal((await plugin.signIn()).id, fixtureAccount);
  assert.equal(requests.filter(item => item.url.pathname === qrPath).length, 1);
  assert.deepEqual([polls, profiles], [3, 2]);
  assert.equal(new Set(prompts.filter(item => item.qr).map(item => item.qr)).size, 1);
  assert.equal(storage.get('qishuiAccount').active, true);
});

test('transport recovery is bounded and does not replace an older stored account', async context => {
  const timer = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, ms) => timer(callback, ms <= 2000 ? 0 : ms));
  const { storage, requests, reply } = accountFixture();
  const old = { version: 1, id: '7', cookies: [], active: false };
  storage.set('qishuiAccount', old);
  reply.set(pollPath, () => { throw new TypeError('synthetic private data'); });
  const plugin = await import(`./index.js?test=${++sequence}`);
  await assert.rejects(plugin.signIn(), error => error.code === 'network' && !error.message.includes('synthetic'));
  assert.equal(requests.filter(item => item.url.pathname === pollPath).length, 3);
  assert.deepEqual(storage.get('qishuiAccount'), old);
});

test('cancelling recovery prevents another request or saving late account data', async context => {
  fastPolling(context);
  const { storage, requests, reply } = accountFixture();
  const plugin = await import(`./index.js?test=${++sequence}`);
  host.signInPrompt = prompt => { if (prompt.text.includes('正在恢复登录')) plugin.cancelSignIn(); };
  reply.set(pollPath, () => { throw new TypeError('synthetic disconnect'); });
  await assert.rejects(plugin.signIn(), { code: 'cancelled' });
  assert.equal(requests.filter(item => item.url.pathname === pollPath).length, 1);
  assert.equal(storage.has('qishuiAccount'), false);
});

test('HTTP refusals, verification challenges and malformed data are never retried', async context => {
  fastPolling(context);
  for (const result of [response({}, { status: 503 }), response({ status_code: 2046 }), response({ message: 'error', data: { error_code: 2156 } }), response({ message: 'error', data: { error_code: 7 } }), response('broken JSON')]) {
    const { requests, storage, reply } = accountFixture();
    reply.set(pollPath, () => result);
    const plugin = await import(`./index.js?test=${++sequence}`);
    await assert.rejects(plugin.signIn());
    assert.equal(requests.filter(item => item.url.pathname === pollPath).length, 1);
    assert.equal(storage.has('qishuiAccount'), false);
  }
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
  assert.equal(storage.has('qishuiAccount'), false);
  requests.length = 0;
  reply.set(pollPath, () => response({ message: 'error', data: { error_code: 2046, redirect_url: 'https://outside.test/verify' } }));
  await assert.rejects(plugin.signIn(), { code: 'verify' });
  assert.deepEqual(requests.map(item => item.url.pathname), [qrPath, pollPath]);
  assert.equal(storage.has('qishuiAccount'), false);
});

test('only the platform can mint a new session and an outside QR or redirect is rejected', async context => {
  fastPolling(context);
  const { storage, requests, reply } = accountFixture();
  const original = reply.get(qrPath);
  const plugin = await import(`./index.js?test=${++sequence}`);
  reply.set(qrPath, () => response({ message: 'success', data: { token: 'fake', qrcode_index_url: 'https://outside.test/qr' } }));
  await assert.rejects(plugin.signIn(), { code: 'unavailable' });
  assert.deepEqual(requests.map(item => item.url.pathname), [devicePath, qrPath]);
  reply.set(qrPath, original);
  reply.set(pollPath, () => response({ message: 'success', data: { status: 'confirmed', redirect_url: 'https://outside.test/finish' } }));
  await assert.rejects(plugin.signIn(), { code: 'unavailable' });
  assert.ok(requests.every(item => item.url.origin === accountOrigin));
  assert.equal(storage.has('qishuiAccount'), false);
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

test('anonymous device identity is reused across login attempts without copying another installation', async context => {
  fastPolling(context);
  const { storage, requests } = accountFixture();
  const first = await import(`./index.js?test=${++sequence}`);
  await first.signIn();
  first.signOut();
  storage.delete('qishuiAccount');
  const second = await import(`./index.js?test=${++sequence}`);
  await second.signIn();
  assert.equal(requests.filter(item => item.url.pathname === devicePath).length, 1);
  assert.equal(requests.filter(item => item.url.pathname === qrPath).length, 2);
  for (const { url } of requests.filter(item => [qrPath, pollPath].includes(item.url.pathname))) {
    assert.equal(url.searchParams.get('device_id'), fixtureDevice.id);
    assert.equal(url.searchParams.get('did'), fixtureDevice.id);
    assert.equal(url.searchParams.get('install_id'), fixtureDevice.install);
    assert.equal(url.searchParams.get('iid'), fixtureDevice.install);
  }
});

test('invalid registration and registration disconnects never create a QR or save a login', async context => {
  fastPolling(context);
  for (const answer of [() => response({ device_id_str: '7' }), () => response({}, { status: 503 }), () => { throw new TypeError('synthetic disconnect'); }]) {
    const { storage, requests, reply } = accountFixture();
    reply.set(devicePath, answer);
    const plugin = await import(`./index.js?test=${++sequence}`);
    await assert.rejects(plugin.signIn());
    assert.deepEqual(requests.map(item => item.url.pathname), [devicePath]);
    assert.equal(storage.size, 0);
  }
});

test('cancelling anonymous registration rejects a late identity before storage or QR creation', async context => {
  fastPolling(context);
  const { storage, requests, reply } = accountFixture();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  reply.set(devicePath, () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const plugin = await import(`./index.js?test=${++sequence}`);
  const signing = plugin.signIn();
  await waiting;
  plugin.cancelSignIn();
  release(response({ device_id_str: fixtureDevice.id, install_id_str: fixtureDevice.install }));
  await assert.rejects(signing, { code: 'cancelled' });
  assert.deepEqual(requests.map(item => item.url.pathname), [devicePath]);
  assert.equal(storage.size, 0);
});

test('browser sign-in keeps SDK and cookies in one page and verifies the returned session before saving', async context => {
  fastPolling(context);
  const { storage, requests } = accountFixture();
  host.capabilities = { webSignInHTML: true };
  let pages = 0;
  host.webSignIn = async options => {
    pages++;
    assert.equal(options.url, accountOrigin + '/passport/');
    assert.equal(options.cookiesOf, accountOrigin + '/');
    assert.deepEqual(options.until, ['sessionid']);
    assert.ok(Buffer.byteLength(options.html) < 262144);
    assert.ok(options.html.includes(fixtureDevice.id));
    assert.ok(options.html.includes(fixtureDevice.install));
    return { cookie: 'sessionid=fixture-browser-session; passport_csrf_token=fixture-browser-csrf' };
  };
  const plugin = await import(`./index.js?test=${++sequence}`);
  assert.equal((await plugin.signIn()).id, fixtureAccount);
  assert.equal(pages, 1);
  assert.deepEqual(requests.map(item => item.url.pathname), [devicePath, mePath]);
  assert.deepEqual(storage.get('qishuiAccount').cookies.map(item => item.name), ['sessionid']);
});

test('browser failures and late completion after cancellation preserve the previous account', async context => {
  fastPolling(context);
  for (const cancel of [false, true]) {
    const { storage, requests } = accountFixture();
    const previous = { version: 1, id: '7', cookies: [], active: false };
    storage.set('qishuiAccount', previous);
    host.capabilities = { webSignInHTML: true };
    const plugin = await import(`./index.js?test=${++sequence}`);
    host.webSignIn = async () => {
      if (!cancel) throw new Error('synthetic browser failure');
      plugin.cancelSignIn();
      return { cookie: 'sessionid=fixture-late' };
    };
    await assert.rejects(plugin.signIn());
    assert.deepEqual(storage.get('qishuiAccount'), previous);
    assert.deepEqual(requests.map(item => item.url.pathname), [devicePath]);
  }
});

test('artist entry loads the PC artist contract, follows cursors and rejects stale account continuations', async context => {
  fastPolling(context);
  const { reply } = accountFixture();
  const base = '/luna/pc/artists/92';
  reply.set(base, (url, options) => { assert.equal(options.headers.Cookie, undefined); assert.equal(url.searchParams.get('app_name'), 'luna_pc'); return response({ artist_info: { id: '92', name: 'Artist', url_avatar: { urls: ['https://cover.test/avatar'] } } }); });
  reply.set(base + '/tracks', url => {
    const next = url.searchParams.get('cursor') === 'next';
    return response({ tracks: [{ id: next ? '102' : '101', name: 'Song', artists: [{ id: '92', name: 'Artist' }] }], has_more: !next, next_cursor: next ? '0' : 'next' });
  });
  reply.set(base + '/albums', () => response({ status_code: 500 }));
  const plugin = await import(`./index.js?test=${++sequence}`);
  await plugin.signIn();
  const first = await plugin.artist({ id: '92' });
  assert.equal(first.artist.id, '92'); assert.equal(first.more, true);
  assert.equal(first.tracks[0].artists[0].id, '92'); assert.deepEqual(first.albums, []);
  const next = await plugin.artist({ id: '92', offset: 1 });
  assert.equal(next.tracks[0].id, '102'); assert.equal(next.more, false);
  await assert.rejects(plugin.artist({ id: '../92' }), { code: 'unavailable' });
  plugin.signOut();
  await assert.rejects(plugin.artist({ id: '92', offset: 1 }), { code: 'signIn' });
});


test('explicit logout clears only session and login registration then requires a new QR after reload', async context => {
  fastPolling(context);
  const { storage, requests } = accountFixture();
  const plugin = await import(`./index.js?test=${++sequence}`);
  await plugin.signIn();
  storage.set('user-preferences', { quality: 'high' });
  plugin.signOutAndClearCache();
  assert.equal(storage.has('qishuiAccount'), false);
  assert.equal(storage.has('qishuiDevice'), false);
  assert.deepEqual(storage.get('user-preferences'), { quality: 'high' });
  const reopened = await import(`./index.js?test=${++sequence}`);
  requests.length = 0;
  assert.equal(await reopened.account(), null);
  assert.equal(requests.length, 0);
  await reopened.signIn();
  assert.deepEqual(requests.map(item => item.url.pathname), [devicePath, qrPath, pollPath, mePath]);
});

test('clearing login prevents a pending profile from restoring saved credentials', async context => {
  fastPolling(context);
  const { storage, reply } = accountFixture();
  const plugin = await import(`./index.js?test=${++sequence}`);
  await plugin.signIn();
  let requested, complete;
  const started = new Promise(resolve => { requested = resolve; });
  reply.set(mePath, () => { requested(); return new Promise(resolve => { complete = resolve; }); });
  const pending = plugin.account();
  await started;
  plugin.signOutAndClearCache();
  complete(response({ my_info: { id: fixtureAccount, nickname: 'late' } }));
  assert.equal(await pending, null);
  assert.equal(storage.has('qishuiAccount'), false);
  assert.equal(storage.has('qishuiDevice'), false);
});

test('platform playlist append validates ownership, preserves int64 strings and never retries a write', async context => {
 fastPolling(context);
 const {reply}=accountFixture();
 const plugin=await import(`./index.js?test=${++sequence}`);await plugin.signIn();
 reply.set(libraryPath,()=>response({playlists:[{id:fixtureList,title:'Mine',type:2,owner:{id:fixtureAccount}},{id:'32',title:'Other',type:2,owner:{id:'100'}},{id:'31',title:'Liked',type:1,owner:{id:fixtureAccount}}],has_more:false}));
 let writes=0;
 reply.set(libraryPath+'/media/append',(_,options)=>{
  writes++;assert.equal(options.method,'POST');assert.equal(options.headers.Cookie,'sessionid=fixture-session');
  const body=JSON.parse(options.body);assert.deepEqual(body,{playlist_id:fixtureList,media:[{id:fixtureTrack,type:'track'}]});
  assert.equal(options.headers['X-SS-STUB'],createHash('md5').update(options.body).digest('hex').toUpperCase());return response({status_code:0});
 });
 await plugin.addToPlaylist({id:`account:${fixtureList}`,trackIds:[fixtureTrack,fixtureTrack]});assert.equal(writes,1);
 for(const id of ['account:32','account:31','account:999'])await assert.rejects(plugin.addToPlaylist({id,trackIds:[fixtureTrack]}),/本人/);
 assert.equal(writes,1);
 reply.set(libraryPath+'/media/append',()=>{writes++;throw Error('ambiguous');});
 await assert.rejects(plugin.addToPlaylist({id:`account:${fixtureList}`,trackIds:[fixtureTrack]}));assert.equal(writes,2);
});
