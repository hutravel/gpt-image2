"""本地冒烟测试：验证 fc/index.py 的转发、认证头和 CORS 行为。

通过 mock urlopen 把 https://127.0.0.1:port 换成本地 http 假上游，
绕过脚本对上游必须 https 的校验（该校验本身在前面的测试中已单独验证过）。
"""

import base64
import importlib.util
import json
import threading
import unittest.mock as mock
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('fc_index', 'index.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

received = []


class UpstreamHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _handle(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''
        received.append((self.command, self.path, dict(self.headers), body))
        resp = json.dumps({'ok': True}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    do_GET = do_POST = _handle


up = ThreadingHTTPServer(('127.0.0.1', 0), UpstreamHandler)
upstream_port = up.server_address[1]
threading.Thread(target=up.serve_forever, daemon=True).start()

srv = ThreadingHTTPServer(('127.0.0.1', 0), mod.ProxyHandler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

config = base64.urlsafe_b64encode(
    json.dumps({'baseUrl': f'https://127.0.0.1:{upstream_port}', 'apiKey': 'test-key'}).encode()
).decode().rstrip('=')
headers = {
    'Origin': 'https://hutravel.github.io',
    'X-Target-Config': config,
    'Content-Type': 'application/json',
}

real_urlopen = urllib.request.urlopen


def http_urlopen(req, timeout=None):
    # 保留方法与请求体，只把上游地址换成 http 本地假上游
    rewritten = urllib.request.Request(
        req.full_url.replace('https://127.0.0.1', 'http://127.0.0.1', 1),
        data=req.data,
        headers=req.headers,
        method=req.get_method())
    return real_urlopen(rewritten, timeout=timeout)


with mock.patch.object(mod.urllib.request, 'urlopen', side_effect=http_urlopen):
    # 1. POST /v1/images/generations（OpenAI images）
    r = real_urlopen(urllib.request.Request(
        f'http://127.0.0.1:{port}/v1/images/generations', data=b'{"model":"gpt-image-2.6"}', headers=headers))
    assert r.headers['Access-Control-Allow-Origin'] == 'https://hutravel.github.io'
    assert json.loads(r.read()) == {'ok': True}

    # 2. GET /v1/tasks/abc（grok 异步任务轮询）
    r = real_urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/v1/tasks/abc', headers=headers))
    assert json.loads(r.read()) == {'ok': True}

    # 3. POST /v1beta/models/xxx:generateContent（google 原生）
    r = real_urlopen(urllib.request.Request(
        f'http://127.0.0.1:{port}/v1beta/models/gemini-3.1-flash-image:generateContent', data=b'{}', headers=headers))
    assert json.loads(r.read()) == {'ok': True}

    # 4. POST /api/v3/images/generations（bytedance ark）
    r = real_urlopen(urllib.request.Request(
        f'http://127.0.0.1:{port}/api/v3/images/generations', data=b'{"model":"doubao-seedream-5-5-261028"}', headers=headers))
    assert json.loads(r.read()) == {'ok': True}

m, p, uh, b = received[0]
assert (m, p) == ('POST', '/v1/images/generations'), (m, p)
assert uh['Authorization'] == 'Bearer test-key'
assert b == b'{"model":"gpt-image-2.6"}'

m, p, uh, b = received[1]
assert (m, p) == ('GET', '/v1/tasks/abc'), (m, p)
assert uh['Authorization'] == 'Bearer test-key'
assert not b

m, p, uh, b = received[2]
assert (m, p) == ('POST', '/v1beta/models/gemini-3.1-flash-image:generateContent'), (m, p, uh)
# urllib 对自定义头名的规范化不确定，用小写比较
lowered = {k.lower(): v for k, v in uh.items()}
assert lowered['x-goog-api-key'] == 'test-key', uh
assert 'authorization' not in lowered

m, p, uh, b = received[3]
assert (m, p) == ('POST', '/api/v3/images/generations'), (m, p)
assert uh['Authorization'] == 'Bearer test-key'
assert b == b'{"model":"doubao-seedream-5-5-261028"}'

print('forwarding + auth header + CORS checks OK')
srv.shutdown()
up.shutdown()
