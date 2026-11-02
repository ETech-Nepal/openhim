import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
if (!existsSync(dir + 'key.pem')) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(dir + 'key.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
}
const key = createPrivateKey(readFileSync(dir + 'key.pem'));
const jwk = { ...createPublicKey(key).export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
writeFileSync(dir + 'jwks.json', JSON.stringify({ keys: [jwk] }));
const [client, scope] = process.argv.slice(2);
if (client) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b({ iss: 'http://issuer.test/realms/openhie', azp: client, scope, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  process.stdout.write(`${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`);
}
