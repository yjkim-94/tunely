"""Minimal Web Push sender (RFC 8030 + VAPID RFC 8292 + aes128gcm RFC 8291).

Kept to `cryptography` and `http_ece` so the Vercel function stays small.
VAPID_PRIVATE_KEY is the base64url-encoded 32-byte P-256 private key.
"""
import base64, json, os, time
from urllib.parse import urlparse

# Only real browser push services; the endpoint comes from the client, so this blocks SSRF.
PUSH_HOSTS = ('.push.apple.com', 'fcm.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com')


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def allowed_endpoint(endpoint: str) -> bool:
    u = urlparse(endpoint)
    host = (u.hostname or '').lower()
    return (u.scheme == 'https' and not u.username and u.port in (None, 443)
            and any(host == h.lstrip('.') or host.endswith(h) for h in PUSH_HOSTS))


def _private_key():
    from cryptography.hazmat.primitives.asymmetric import ec
    raw = b64url_decode(os.environ['VAPID_PRIVATE_KEY'])
    return ec.derive_private_key(int.from_bytes(raw, 'big'), ec.SECP256R1())


def configured() -> bool:
    return bool(os.getenv('VAPID_PRIVATE_KEY'))


def public_key() -> str:
    from cryptography.hazmat.primitives import serialization
    pub = _private_key().public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64url(pub)


def vapid_headers(endpoint: str, subject: str) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, utils
    u = urlparse(endpoint)
    head = b64url(json.dumps({'typ': 'JWT', 'alg': 'ES256'}, separators=(',', ':')).encode())
    claims = b64url(json.dumps({'aud': f'{u.scheme}://{u.netloc}', 'exp': int(time.time()) + 12 * 3600, 'sub': subject},
                               separators=(',', ':')).encode())
    signing_input = f'{head}.{claims}'.encode()
    r, s = utils.decode_dss_signature(_private_key().sign(signing_input, ec.ECDSA(hashes.SHA256())))
    token = f'{head}.{claims}.{b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))}'
    return {'Authorization': f'vapid t={token}, k={public_key()}'}


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    import http_ece
    from cryptography.hazmat.primitives.asymmetric import ec
    return http_ece.encrypt(payload, salt=os.urandom(16), private_key=ec.generate_private_key(ec.SECP256R1()),
                            dh=b64url_decode(p256dh), auth_secret=b64url_decode(auth), version='aes128gcm')


def request(sub: dict, message: dict, subject: str):
    """Return (url, headers, body) for one subscription."""
    body = encrypt(json.dumps(message, ensure_ascii=False).encode(), sub['p256dh'], sub['auth'])
    headers = {**vapid_headers(sub['endpoint'], subject), 'Content-Encoding': 'aes128gcm',
               'Content-Type': 'application/octet-stream', 'TTL': '86400', 'Urgency': 'high'}
    if message.get('tag'):
        headers['Topic'] = ''.join(c for c in str(message['tag']) if c.isalnum())[:32]
    return sub['endpoint'], headers, body
