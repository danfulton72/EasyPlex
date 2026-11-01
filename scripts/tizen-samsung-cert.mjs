#!/usr/bin/env node
// Creates a Samsung TV signing certificate (author + distributor tied to your
// TV's DUID) without Tizen Studio's Certificate Manager, which Samsung no
// longer supports. Then registers it as a Tizen CLI signing profile and points
// .env at it, so ./scripts/tizen-deploy.sh signs with it.
//
// Only needed if the TV refuses the plain Tizen certificate that
// ./scripts/tizen-setup.sh makes (2019-2022 TVs normally accept it; 2023+
// models need this).
//
//   node scripts/tizen-samsung-cert.mjs                 uses TV_DUID from .env
//   node scripts/tizen-samsung-cert.mjs --duid <DUID>   (repeat for more TVs)
//   options: --name <profile> (default easyplex-samsung)  --email <account e-mail>
//            --out <dir> (default ~/SamsungCertificate/<profile>)  --no-browser
//            --no-register (just write the files)
//
// How it works (the same requests Samsung's own Tizen tools make, as
// implemented by Apps2Samsung, MIT, https://github.com/Apps2Samsung/Apps2Samsung):
//  1. You sign in to your Samsung account in the browser. Samsung's sign-in
//     page posts a token back to a listener on http://localhost:4794.
//  2. A key pair and two certificate requests are made locally. The private
//     key never leaves this computer.
//  3. Samsung's developer CA (svdca.samsungqbe.com) signs them. The distributor
//     certificate lists your TV's DUID.
//  4. author.p12 / distributor.p12 are written with Samsung's public CA
//     certificates (tizen/ca/) and added to the Tizen CLI as a profile.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SIGN_IN = {
  gate: 'https://account.samsung.com/accounts/be1dce529476c1a6d407c4c7578c31bd/signInGate',
  clientId: 'v285zxnl3h',
  state: 'accountcheckdogeneratedstatetext',
  port: 4794,
  path: '/signin/callback',
};
export const SVDCA = 'https://svdca.samsungqbe.com';
const CA_DIR = path.join(ROOT, 'tizen/ca');
const AUTHOR_CA = 'vd_tizen_dev_author_ca.cer';
const PUBLIC_CA = 'vd_tizen_dev_public2.crt';

// ---- certificate requests -----------------------------------------------------------

export function makeKeys() {
  return forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
}

function csrPem(keys, subject, attributes) {
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject(subject);
  if (attributes) csr.setAttributes(attributes);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

export function authorCsr(keys) {
  return csrPem(keys, [{ name: 'commonName', value: 'EasyPlex' }]);
}

// The distributor certificate names the TVs it may install on, one
// URN:tizen:deviceid=<DUID> per TV, alongside an empty package id.
export function distributorCsr(keys, duids, email) {
  const altNames = [{ type: 6, value: 'URN:tizen:packageid=' }]
    .concat(duids.map(d => ({ type: 6, value: 'URN:tizen:deviceid=' + d })));
  const subject = [{ name: 'commonName', value: 'TizenSDK' }];
  if (email) subject.push({ name: 'emailAddress', value: email });
  return csrPem(keys, subject, [{ name: 'extensionRequest', extensions: [{ name: 'subjectAltName', altNames }] }]);
}

// ---- Samsung account sign-in --------------------------------------------------------

export function signInUrl() {
  const redirect = 'http://localhost:' + SIGN_IN.port + SIGN_IN.path;
  return SIGN_IN.gate + '?locale=&clientId=' + SIGN_IN.clientId +
    '&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + SIGN_IN.state + '&tokenType=TOKEN';
}

// Samsung posts "state=...&code=<url-encoded JSON>" to the redirect address.
export function parseCallback(body) {
  let state = null, code = null;
  for (const part of String(body).split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i), v = part.slice(i + 1);
    if (k === 'state') state = decodeURIComponent(v.replace(/\+/g, ' '));
    if (k === 'code') code = decodeURIComponent(v);
  }
  if (state !== SIGN_IN.state || !code) return null;
  const auth = JSON.parse(code);
  if (!auth.access_token || !auth.userId) throw new Error('Samsung sign-in returned no token');
  return auth;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true; } catch (e) { return false; }
}

export function signIn({ browser = true, timeoutMs = 10 * 60 * 1000, port = SIGN_IN.port } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const isCallback = req.method === 'POST' && req.url.startsWith(SIGN_IN.path);
        let auth = null, error = null;
        if (isCallback) { try { auth = parseCallback(body); } catch (e) { error = e; } }
        res.writeHead(auth ? 200 : isCallback ? 400 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(auth ? 'Signed in. You can close this tab and go back to the terminal.' : isCallback ? 'Invalid sign-in response.' : 'Not found');
        if (auth || error) {
          clearTimeout(timer);
          server.close();
          if (auth) resolve(auth); else reject(error);
        }
      });
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('No sign-in within ' + Math.round(timeoutMs / 60000) + ' minutes')); }, timeoutMs);
    let ipv4Only = false;
    server.on('error', e => {
      // No IPv6 on this computer: IPv4 alone is all "localhost" can mean then.
      if (e.code === 'EAFNOSUPPORT' && !ipv4Only) { ipv4Only = true; server.listen({ port, host: '127.0.0.1' }, ready); return; }
      clearTimeout(timer);
      reject(e.code === 'EADDRINUSE' ? new Error('Port ' + port + ' is in use; close whatever is using it and try again') : e);
    });
    // Both IPv4 and IPv6: browsers may send "localhost" to either.
    server.listen({ port, host: '::', ipv6Only: false }, ready);
    function ready() {
      const url = signInUrl();
      console.log('\nSign in to your Samsung account (a free one is fine):');
      console.log('  ' + url + '\n');
      if (browser && openBrowser(url)) console.log('A browser window should open. Waiting for the sign-in…');
      else console.log('Open that address in a browser on this computer. Waiting for the sign-in…');
    }
  });
}

// ---- Samsung's developer CA --------------------------------------------------------------

async function post(url, fields, csr, name) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('csr', new Blob([csr], { type: 'application/octet-stream' }), name);
  const res = await fetch(url, { method: 'POST', body: form });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    const text = bytes.toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error('Samsung certificate service refused ' + path.basename(new URL(url).pathname) + ' (HTTP ' + res.status + '): ' + text);
  }
  return bytes;
}

export async function signCsrs({ auth, author, distributor, endpoint = SVDCA, level = 'public' }) {
  const base = { access_token: auth.access_token, user_id: auth.userId };
  const signedAuthor = await post(endpoint + '/apis/v3/authors', { ...base, platform: 'VD' }, author, 'author.csr');
  const dist = { ...base, privilege_level: level, developer_type: 'Individual', platform: 'VD' };
  const deviceProfile = await post(endpoint + '/apis/v1/distributors', dist, distributor, 'distributor.csr');
  const signedDistributor = await post(endpoint + '/apis/v3/distributors', dist, distributor, 'distributor.csr');
  return { signedAuthor, deviceProfile, signedDistributor };
}

// ---- .p12 files ----------------------------------------------------------------------------

export function readCert(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  if (text.includes('-----BEGIN CERTIFICATE-----')) return forge.pki.certificateFromPem(text.slice(text.indexOf('-----BEGIN CERTIFICATE-----')));
  return forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(text)));
}

// key + [leaf, the CA that issued it], 3DES throughout (readable by every OpenSSL).
export function makeP12(privateKey, leafBytes, caCandidates, password) {
  const leaf = readCert(leafBytes);
  const issuer = leaf.issuer.hash;
  const ca = caCandidates.map(readCert).find(c => c.subject.hash === issuer && c.subject.hash !== c.issuer.hash);
  if (!ca) throw new Error('Samsung issued a certificate from a CA this script doesn\'t have (' +
    leaf.issuer.attributes.map(a => a.shortName + '=' + a.value).join(', ') + ')');
  const asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, [leaf, ca], password,
    { algorithm: '3des', friendlyName: 'usercertificate', generateLocalKeyId: true });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

export async function createProfile({ auth, duids, email, outDir, endpoint, caDir = CA_DIR, keys = makeKeys() }) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const password = crypto.randomBytes(18).toString('base64url');
  const author = authorCsr(keys);
  const distributor = distributorCsr(keys, duids, email);
  const signed = await signCsrs({ auth, author, distributor, endpoint });
  const cas = fs.readdirSync(caDir).filter(f => /\.(cer|crt)$/.test(f)).map(f => fs.readFileSync(path.join(caDir, f)));
  const files = {
    'author.csr': author, 'distributor.csr': distributor,
    'signed_author.cer': signed.signedAuthor, 'signed_distributor.cer': signed.signedDistributor,
    'device-profile.xml': signed.deviceProfile,
    'author.p12': makeP12(keys.privateKey, signed.signedAuthor, cas, password),
    'distributor.p12': makeP12(keys.privateKey, signed.signedDistributor, cas, password),
    'password.txt': password + '\n',
  };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), data, { mode: 0o600 });
  return { password, author: path.join(outDir, 'author.p12'), distributor: path.join(outDir, 'distributor.p12') };
}

// ---- .env and the Tizen CLI ---------------------------------------------------------------

export function readEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export function setEnv(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp('^' + key + '=.*$', 'm');
  fs.writeFileSync(file, re.test(text) ? text.replace(re, key + '=' + value) : text + (text && !text.endsWith('\n') ? '\n' : '') + key + '=' + value + '\n');
}

function registerProfile(tizen, name, files) {
  try { execFileSync(tizen, ['security-profiles', 'remove', '-n', name], { stdio: 'ignore' }); } catch (e) { /* new profile */ }
  execFileSync(tizen, ['security-profiles', 'add', '-n', name, '-a', files.author, '-p', files.password,
    '-d', files.distributor, '-dp', files.password], { stdio: 'inherit' });
}

function args(argv) {
  const out = { duids: [], browser: true, register: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--duid') out.duids.push(argv[++i]);
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--no-browser') out.browser = false;
    else if (a === '--no-register') out.register = false;
    else if (a === '--auth-json') out.authJson = argv[++i];   // advanced: reuse a saved sign-in
    else if (a === '--endpoint') out.endpoint = argv[++i];    // testing only
    else throw new Error('Unknown option ' + a);
  }
  return out;
}

async function main() {
  const opt = args(process.argv.slice(2));
  const envFile = path.join(ROOT, '.env');
  const env = readEnv(envFile);
  const duids = opt.duids.length ? opt.duids : (env.TV_DUID ? [env.TV_DUID] : []);
  if (!duids.length) throw new Error('No TV DUID. Run ./scripts/tizen-setup.sh (it reads it from the TV), or pass --duid <DUID>.');
  const name = opt.name || 'easyplex-samsung';
  const outDir = path.resolve(opt.out || path.join(os.homedir(), 'SamsungCertificate', name));

  const auth = opt.authJson ? JSON.parse(fs.readFileSync(opt.authJson, 'utf8')) : await signIn({ browser: opt.browser });
  const email = opt.email || auth.inputEmailID;
  if (!email) throw new Error('Samsung didn\'t return your account e-mail; run again with --email <your Samsung account e-mail>');
  console.log('Signed in as ' + email + '. Asking Samsung to sign the certificates for ' + duids.join(', ') + '…');

  const files = await createProfile({ auth, duids, email, outDir, endpoint: opt.endpoint || SVDCA });
  console.log('Wrote ' + outDir + ' (author.p12, distributor.p12, password.txt, device-profile.xml)');

  if (!opt.register) return;
  let studio = (env.TIZEN_STUDIO || '$HOME/tizen-studio').replace('$HOME', os.homedir());
  const tizen = path.join(studio, 'tools/ide/bin', process.platform === 'win32' ? 'tizen.bat' : 'tizen');
  if (!fs.existsSync(tizen)) {
    console.log('Tizen CLI not found at ' + tizen + '. Add the profile yourself:\n  tizen security-profiles add -n ' + name +
      ' -a ' + files.author + ' -p <password.txt> -d ' + files.distributor + ' -dp <password.txt>');
    return;
  }
  registerProfile(tizen, name, files);
  if (fs.existsSync(envFile)) setEnv(envFile, 'TIZEN_SIGN_PROFILE', name);
  console.log('\nSigning profile "' + name + '" is ready' + (fs.existsSync(envFile) ? ' and set in .env' : '') +
    '. Install with ./scripts/tizen-deploy.sh');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('\n' + (e.message || e)); process.exit(1); });
}
