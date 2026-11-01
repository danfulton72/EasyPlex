// scripts/tizen-samsung-cert.mjs against a fake Samsung developer CA: the
// requests it sends, the sign-in callback, and the .p12 files it writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import forge from 'node-forge';
import { createProfile, distributorCsr, makeKeys, parseCallback, signIn, signInUrl, setEnv, readEnv, SIGN_IN } from '../scripts/tizen-samsung-cert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easyplex-cert-'));
const keys = makeKeys();   // one RSA key for the whole file keeps the tests quick

// A root and an intermediate CA standing in for Samsung's.
function cert(subjectCn, issuerCert, issuerKey, publicKey, isCa, extra = []) {
  const c = forge.pki.createCertificate();
  c.publicKey = publicKey;
  c.serialNumber = String(Math.floor(Math.random() * 1e9));
  c.validity.notBefore = new Date(Date.now() - 1000);
  c.validity.notAfter = new Date(Date.now() + 86400000);
  const subject = [{ name: 'commonName', value: subjectCn }, { name: 'organizationName', value: 'Fake Samsung' }];
  c.setSubject(subject);
  c.setIssuer(issuerCert ? issuerCert.subject.attributes : subject);
  c.setExtensions([{ name: 'basicConstraints', cA: isCa }, ...extra]);
  c.sign(issuerKey, forge.md.sha256.create());
  return c;
}
const rootKeys = makeKeys();
const root = cert('Fake Root', null, rootKeys.privateKey, rootKeys.publicKey, true);
const inter = cert('Fake VD Public CA', root, rootKeys.privateKey, rootKeys.publicKey, true);
const caDir = path.join(tmp, 'ca');
fs.mkdirSync(caDir);
fs.writeFileSync(path.join(caDir, 'root.crt'), forge.pki.certificateToPem(root));
fs.writeFileSync(path.join(caDir, 'inter.cer'), forge.pki.certificateToPem(inter));

let server, endpoint;
const seen = [];
before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const form = await new Request('http://x', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
    const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
    const csrFile = form.get('csr');
    seen.push({ path: req.url, fields, filename: csrFile.name });
    if (fields.access_token !== 'tok') { res.writeHead(401).end('{"error":"bad token"}'); return; }
    const csr = forge.pki.certificationRequestFromPem(await csrFile.text());
    if (req.url === '/apis/v1/distributors') { res.writeHead(200).end('<profile/>'); return; }
    const ext = csr.getAttribute({ name: 'extensionRequest' });
    const leaf = cert(csr.subject.getField('CN').value, inter, rootKeys.privateKey, csr.publicKey, false, ext ? ext.extensions : []);
    res.writeHead(200).end(req.url === '/apis/v3/authors' ? Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(leaf)).getBytes(), 'binary') : forge.pki.certificateToPem(leaf));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  endpoint = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('distributor request lists each TV DUID and the account e-mail', () => {
  const csr = forge.pki.certificationRequestFromPem(distributorCsr(keys, ['DUID-ONE', 'DUID-TWO'], 'dan@example.com'));
  assert.equal(csr.subject.getField('CN').value, 'TizenSDK');
  assert.equal(csr.subject.getField('E').value, 'dan@example.com');
  const san = csr.getAttribute({ name: 'extensionRequest' }).extensions.find(e => e.name === 'subjectAltName');
  assert.deepEqual(san.altNames.map(a => a.value), ['URN:tizen:packageid=', 'URN:tizen:deviceid=DUID-ONE', 'URN:tizen:deviceid=DUID-TWO']);
  assert.ok(csr.verify());
});

test('creates author.p12 and distributor.p12 that OpenSSL can read, with the CA chain', async () => {
  const out = path.join(tmp, 'profile');
  const files = await createProfile({ auth: { access_token: 'tok', userId: 'u1' }, duids: ['DUID-ONE'], email: 'dan@example.com', outDir: out, endpoint, caDir, keys });
  assert.deepEqual(seen.map(s => s.path), ['/apis/v3/authors', '/apis/v1/distributors', '/apis/v3/distributors']);
  assert.deepEqual(seen[0].fields, { access_token: 'tok', user_id: 'u1', platform: 'VD' });
  assert.deepEqual(seen[1].fields, { access_token: 'tok', user_id: 'u1', privilege_level: 'public', developer_type: 'Individual', platform: 'VD' });
  assert.equal(seen[2].filename, 'distributor.csr');
  assert.equal(fs.readFileSync(path.join(out, 'device-profile.xml'), 'utf8'), '<profile/>');
  assert.equal(fs.readFileSync(path.join(out, 'password.txt'), 'utf8').trim(), files.password);
  for (const name of ['author', 'distributor']) {
    const pem = execFileSync('openssl', ['pkcs12', '-in', files[name], '-nodes', '-passin', 'pass:' + files.password], { encoding: 'utf8' });
    const subjects = [...pem.matchAll(/^subject=(.*)$/gm)].map(m => m[1]);
    assert.equal(subjects.length, 2, name + ': leaf and intermediate');
    assert.match(subjects.join('|'), /Fake VD Public CA/);
    assert.doesNotMatch(subjects.join('|'), /Fake Root/);
    assert.match(pem, /friendlyName: usercertificate/);
    assert.match(pem, /BEGIN PRIVATE KEY/);
  }
  const dist = execFileSync('openssl', ['pkcs12', '-in', files.distributor, '-nokeys', '-clcerts', '-passin', 'pass:' + files.password], { encoding: 'utf8' });
  const text = execFileSync('openssl', ['x509', '-noout', '-ext', 'subjectAltName'], { input: dist, encoding: 'utf8' });
  assert.match(text, /URI:URN:tizen:deviceid=DUID-ONE/);
  assert.equal(fs.statSync(path.join(out, 'password.txt')).mode & 0o077, 0, 'secrets are private to the user');
});

test('a refused request reports Samsung\'s answer', async () => {
  await assert.rejects(createProfile({ auth: { access_token: 'nope', userId: 'u1' }, duids: ['D'], email: 'e', outDir: path.join(tmp, 'x'), endpoint, caDir, keys }),
    /refused authors \(HTTP 401\): \{"error":"bad token"\}/);
});

test('sign-in: URL, and the token Samsung posts back to localhost', async () => {
  const url = new URL(signInUrl());
  assert.equal(url.searchParams.get('clientId'), SIGN_IN.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4794/signin/callback');
  const token = { access_token: 'a+b/c=', userId: 'u1', inputEmailID: 'dan@example.com' };
  const body = 'state=' + SIGN_IN.state + '&code=' + encodeURIComponent(JSON.stringify(token));
  assert.deepEqual(parseCallback(body), token);
  assert.equal(parseCallback('state=wrong&code=x'), null);

  const port = 47940 + Math.floor(Math.random() * 50);
  const waiting = signIn({ browser: false, port, timeoutMs: 5000 });
  await new Promise(r => setTimeout(r, 100));
  const miss = await fetch('http://127.0.0.1:' + port + '/favicon.ico');
  assert.equal(miss.status, 404);
  const res = await fetch('http://localhost:' + port + SIGN_IN.path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(res.status, 200);
  assert.deepEqual(await waiting, token);
});

test('.env update keeps other settings', () => {
  const file = path.join(tmp, '.env');
  fs.writeFileSync(file, 'TV_IP=1.2.3.4\nTIZEN_SIGN_PROFILE=easyplex\n');
  setEnv(file, 'TIZEN_SIGN_PROFILE', 'easyplex-samsung');
  assert.deepEqual(readEnv(file), { TV_IP: '1.2.3.4', TIZEN_SIGN_PROFILE: 'easyplex-samsung' });
});
