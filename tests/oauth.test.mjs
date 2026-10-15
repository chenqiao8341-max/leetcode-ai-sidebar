// Adapted MIT tests from dsh-chatgpt-plan; see companion/THIRD_PARTY.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../companion/storage.mjs';
import {ChatGPTAuth,validateIdToken,ISSUER,RESOURCE,TOKEN,SCOPES,PLAN_SCOPE} from '../companion/oauth.mjs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const NOW = 1800000000000;
function jwt(clientId, nonce, extra = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: ISSUER, sub: 'account-one', email: 'test@example.invalid', aud: clientId, nonce, exp: NOW / 1000 + 3600, ...extra })).toString('base64url');
  const input = `${header}.${claims}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}
async function fixture(t) {
  const testRoot=resolve(process.env.SIDEBAR_TEST_TMP || tmpdir());
  const directory = await mkdtemp(join(testRoot, 'sidebar-oauth-test-'));
  t.after(() => {if(!directory.startsWith(testRoot+sep))throw new Error('Unexpected cleanup path');return rm(directory,{recursive:true,force:true});});
  const store = new Store(directory), calls = [];
  let lastNonce, currentId = 'oaiapp_test', scopes = SCOPES, refreshes = 0, failRefresh, now = NOW;
  let identity = { sub: 'account-one', email: 'test@example.invalid' }, modelName = 'gpt-test';
  const fetcher = async (url, options = {}) => {
    calls.push({ url, body: options.body, headers: options.headers });
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (url === TOKEN) {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('client_id'), currentId); assert.equal(params.get('resource'), RESOURCE);
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++; await new Promise(r => setTimeout(r, 20));
        if (failRefresh) return Response.json({ error: failRefresh }, { status: 400 });
      }
      return Response.json({ access_token: 'private-access-' + refreshes, refresh_token: 'private-refresh-' + refreshes, id_token: jwt(currentId, lastNonce, identity), token_type: 'Bearer', expires_in: 3600, scope: scopes });
    }
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: modelName, display_name: 'Test', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }], input_modalities: ['text','image'] }, { slug: 'hidden', visibility: 'hidden' }] });
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
    throw new Error('Unexpected endpoint');
  };
  const auth = new ChatGPTAuth({ store, fetcher, now: () => now }); await auth.initialize();
  async function begin(options = {}) { const url = new URL(await auth.begin({ redirectUri: 'http://127.0.0.1:18762/auth/callback', ...options })); lastNonce = url.searchParams.get('nonce'); return url; }
  async function finish(url, override = {}) { const callback = new URL('http://127.0.0.1:18762/auth/callback'); callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'one-use-code', client_id: currentId, ...override }); await auth.callback(callback); return callback; }
  return { store, auth, calls, fetcher, begin, finish, setNow: value => now = value, setIdentity: value => identity = value, setModel: value => modelName = value, setScopes: value => scopes = value, setClient: value => currentId = value, setRefreshError: value => failRefresh = value, refreshes: () => refreshes };
}

test('new registration uses this app name, PKCE and persistent host, then reuses issued client', async t => {
  const f=await fixture(t),url=await f.begin();
  assert.equal(url.searchParams.get('agent_name_hint'),'力扣伴读');assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');
  assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(f.auth.pending.verifier).digest('base64url'));
  const host=url.searchParams.get('ext_agent_host_id');await f.finish(url);
  const next=await f.begin();assert.equal(next.searchParams.get('ext_agent_host_id'),host);assert.equal(next.searchParams.get('client_id'),'oaiapp_test');
  const exposed=JSON.stringify(await f.auth.status());assert(!exposed.includes('private-access'));assert(!exposed.includes('refresh_token'));assert(!exposed.includes('id_token'));
});

test('callback verifies state before denial, rejects client substitution and consumes a code once', async t => {
  const f = await fixture(t), url = await f.begin();
  await assert.rejects(f.auth.callback(new URL('http://127.0.0.1:18762/auth/callback?state=wrong&error=access_denied')), /state/);
  assert.ok(f.auth.pending); const callback = await f.finish(url);
  await assert.rejects(f.auth.callback(callback), /state/);
  const again = await f.begin(); await assert.rejects(f.finish(again, { client_id: 'oaiapp_impostor' }), /身份/);
  assert.equal((await f.store.load()).profiles[0].clientId, 'oaiapp_test');
});
test('ID token signature, issuer, audience, nonce, expiry and identity are enforced', () => {
  const options = { jwks: { keys: [jwk] }, clientId: 'oaiapp_test', nonce: 'nonce', now: NOW };
  assert.equal(validateIdToken(jwt('oaiapp_test', 'nonce'), options).subject, 'account-one');
  for (const token of [jwt('other','nonce'), jwt('oaiapp_test','wrong'), jwt('oaiapp_test','nonce',{ iss: 'https://evil.invalid' }), jwt('oaiapp_test','nonce',{ exp: 1 }), jwt('oaiapp_test','nonce') + 'tampered']) assert.throws(() => validateIdToken(token, options), /身份验证失败/);
});
test('declining plan permission retains identity but prevents inference and model requests', async t => {
  const f = await fixture(t); f.setScopes('openid profile email offline_access'); await f.finish(await f.begin());
  assert.equal((await f.auth.status()).profiles[0].connected, true); assert.equal((await f.auth.status()).profiles[0].planEnabled, false);
  await assert.rejects(f.auth.access(), /允许使用套餐/); assert.ok(!f.calls.some(c => c.url.endsWith('/models')));
});
test('identity-only login without access or refresh tokens is retained and disabled for inference', async t => {
  const f = await fixture(t);
  f.auth.tokenRequest = async () => ({ id_token: jwt('oaiapp_test', f.auth.savedTestNonce), scope: 'openid email profile' });
  const url = await f.begin(); f.auth.savedTestNonce = url.searchParams.get('nonce'); await f.finish(url);
  const status = await f.auth.status(); assert.equal(status.profiles[0].connected, true); assert.equal(status.profiles[0].planEnabled, false);
  await assert.rejects(f.auth.access(), /允许使用套餐/);
});
test('multiple registrations stay separate and reauthorization rejects a different verified subject', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const first = (await f.store.load()).profiles[0]; f.setClient('oaiapp_second'); await f.finish(await f.begin({ newProfile: true }));
  const state = await f.store.load(); assert.equal(state.profiles.length, 2); assert.notEqual(state.activeProfileId, first.id);
  await f.auth.select(first.id); assert.equal((await f.store.load()).activeProfileId, first.id);
  f.setClient(first.clientId); const url = await f.begin();
  const original = f.auth.identity.bind(f.auth); f.auth.identity = async (...args) => ({ ...await original(...args), subject: 'different-user' });
  await assert.rejects(f.finish(url), /账号与已保存/); assert.equal((await f.store.load()).profiles[0].subject, 'account-one');
});
test('two auth instances serialize rotating refresh and preserve credentials on transient failure', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 1000; });
  const second = new ChatGPTAuth({ store: new Store(f.store.directory), fetcher: f.fetcher, now: () => NOW });
  const values = await Promise.all([f.auth.access(), second.access(), f.auth.access()]);
  assert.equal(f.refreshes(), 1); assert.ok(values.every(v => v.token === 'private-access-1'));
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 1000; }); f.setRefreshError('temporarily_unavailable');
  assert.equal((await f.auth.access()).token, 'private-access-1'); assert.equal((await f.store.load()).profiles[0].refresh_token, 'private-refresh-1');
  f.auth.refreshFailures.clear(); f.setRefreshError('invalid_grant'); await assert.rejects(f.auth.access(), /授权已失效/); assert.equal((await f.store.load()).profiles[0].access_token, undefined);
});
test('sign out revokes DSH refresh token, aborts streams and preserves reusable client registration', async t => {
  const f = await fixture(t); await f.finish(await f.begin()); const before = await f.store.load(); const signal = f.auth.requestController.signal;
  const result = await f.auth.signOut(before.activeProfileId); assert.equal(result.revoked, true); assert.equal(signal.aborted, true);
  const profile = (await f.store.load()).profiles[0]; assert.equal(profile.clientId, 'oaiapp_test'); assert.equal(profile.access_token, undefined); assert.equal(profile.id_token, undefined);
  const revoke = f.calls.find(c => c.url.endsWith('/revoke')); assert.equal(new URLSearchParams(revoke.body).get('client_id'), 'oaiapp_test');
});
test('two different ChatGPT identities retain separate models and labels; sign-out never falls back to another account', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const first = (await f.store.load()).profiles[0];
  f.setClient('oaiapp_second'); f.setIdentity({ sub: 'account-two', email: 'second@example.invalid' }); f.setModel('second-model');
  await f.finish(await f.begin({ newProfile: true }));
  const second = (await f.store.load()).profiles[1];
  assert.notEqual(first.subject, second.subject); assert.notEqual(first.email, second.email);
  assert.equal(first.models[0].slug, 'gpt-test'); assert.equal(second.models[0].slug, 'second-model');
  await f.auth.rename(first.id, '个人 Pro'); await f.auth.rename(second.id, '工作账号');
  const signal = f.auth.requestController.signal;
  await f.auth.select(first.id); assert.equal(signal.aborted, true);
  assert.equal((await f.auth.access()).profileId, first.id);
  assert.equal((await f.auth.status()).profiles[1].label, '工作账号');
  await f.auth.signOut(first.id);
  await assert.rejects(f.auth.access(), /登录/);
  assert.equal((await f.auth.access(second.id)).profileId, second.id);
  assert.equal((await f.store.load()).profiles[1].clientId, 'oaiapp_second');
  await f.auth.select(second.id);
  assert.equal((await f.auth.access()).profileId, second.id);
  const reloaded = new ChatGPTAuth({ store: new Store(f.store.directory), fetcher: f.fetcher, now: () => NOW });
  assert.equal((await reloaded.status()).profiles.length, 2);
  assert.equal((await reloaded.status()).profiles[0].label, '个人 Pro');
});

test('repeated client ids are rejected before exchanging a code', async t => {
  const f = await fixture(t), url = await f.begin();
  const callback = new URL('http://127.0.0.1:18762/auth/callback');
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'one-use', client_id: 'oaiapp_test' });
  callback.searchParams.append('client_id', 'oaiapp_other');
  await assert.rejects(f.auth.callback(callback), /身份/);
  assert.ok(!f.calls.some(c => c.url === TOKEN));
});

test('near-expiry requests keep running while a single background refresh rotates credentials', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 180000; });
  let release, started;
  const reached = new Promise(r => started = r), gate = new Promise(r => release = r);
  const original = f.auth.tokenRequest.bind(f.auth);
  f.auth.tokenRequest = async params => { started(); await gate; return original(params); };
  const results = await Promise.all([f.auth.access(), f.auth.access(), f.auth.access()]);
  assert.ok(results.every(r => r.token === 'private-access-0'));
  await reached; const work = [...f.auth.refreshes.values()]; release(); await Promise.all(work);
  assert.equal(f.refreshes(), 1);
  assert.equal((await f.auth.access()).token, 'private-access-1');
});

test('transient refresh backoff never serves an expired token and recovers after retry delay', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 1000; });
  f.setRefreshError('temporarily_unavailable');
  assert.equal((await f.auth.access()).token, 'private-access-0');
  assert.equal((await f.auth.access()).token, 'private-access-0'); assert.equal(f.refreshes(), 1);
  f.setNow(NOW + 2000); await assert.rejects(f.auth.access(), /temporarily_unavailable/);
  f.setRefreshError(undefined); f.setNow(NOW + 61000);
  assert.equal((await f.auth.access()).token, 'private-access-2');
  assert.equal(f.auth.refreshFailures.size, 0);
});

test('earliest_refresh_at prevents premature forced renewal', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  await f.store.transact(data => { data.profiles[0].expiresAt = NOW + 1000; data.profiles[0].earliestRefreshAt = NOW + 500; });
  assert.equal((await f.auth.access()).token, 'private-access-0');
  await assert.rejects(f.auth.access(undefined, { force: true }), /尚未允许/);
  assert.equal(f.refreshes(), 0);
});

test('an inference 401 forces one refresh and replays the same body exactly once', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const id = (await f.store.load()).activeProfileId, calls = [];
  f.auth.fetcher = async (input, init) => {
    if (!(input instanceof Request)) return f.fetcher(input, init);
    calls.push({ authorization: input.headers.get('authorization'), body: await input.text(), url: input.url });
    return new Response(calls.length === 1 ? 'unauthorized' : 'stream', { status: calls.length === 1 ? 401 : 200 });
  };
  const body = JSON.stringify({ model: 'gpt-test', input: [], stream: true });
  const response = await f.auth.fetchInference(id, `${RESOURCE}/responses`, { method: 'POST', body });
  assert.equal(response.status, 200); assert.equal(calls.length, 2); assert.equal(f.refreshes(), 1);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].authorization, 'Bearer private-access-0'); assert.equal(calls[1].authorization, 'Bearer private-access-1');
  calls.length = 0;
  f.auth.fetcher = async (input, init) => {
    if (!(input instanceof Request)) return f.fetcher(input, init);
    calls.push(input.url); return new Response('unauthorized', { status: 401 });
  };
  assert.equal((await f.auth.fetchInference(id, `${RESOURCE}/responses`, { method: 'POST', body })).status, 401);
  assert.equal(calls.length, 2);
});

test('quota and successful stream responses are never replayed by auth', async t => {
  const f = await fixture(t); await f.finish(await f.begin());
  const id = (await f.store.load()).activeProfileId;
  for (const status of [200, 429, 500]) {
    let calls = 0;
    f.auth.fetcher = async () => { calls++; return new Response('response', { status }); };
    const response = await f.auth.fetchInference(id, `${RESOURCE}/responses`, { method: 'POST', body: '{}' });
    assert.equal(response.status, status); assert.equal(calls, 1);
  }
});

test('cancel while authorization is exchanging cannot reactivate an account', async t => {
  const f = await fixture(t), url = await f.begin();
  const original = f.auth.tokenRequest.bind(f.auth);
  f.auth.tokenRequest = async params => { const token = await original(params); f.auth.cancel(); return token; };
  await assert.rejects(f.finish(url), /取消/);
  const state = await f.store.load();
  assert.equal(state.activeProfileId, null); assert.equal(state.profiles[0].access_token, undefined);
});
