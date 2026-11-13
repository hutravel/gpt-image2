import base64
import binascii
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ALLOWED_ORIGINS = {
    "https://hutravel.github.io",
}

# 精确路径（OpenAI Images 生成/编辑、字节跳动 Ark Images 生成/编辑）
ALLOWED_PATHS = {
    "/v1/images/generations",
    "/v1/images/edits",
    "/api/v3/images/generations",
    "/api/v3/images/edits",
}

# 前缀路径（Grok 异步任务轮询、Google 原生 generateContent）
ALLOWED_PATH_PREFIXES = (
    "/v1/tasks/",
    "/v1beta/models/",
)

ALLOWED_REQUEST_HEADERS = (
    "Content-Type, Accept, Authorization, "
    "X-Target-Config, "
    "X-Target-Base-Url, X-Target-Api-Key"
)

MAX_BODY_SIZE = 50 * 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 580


def is_allowed_path(path):
    if path in ALLOWED_PATHS:
        return True

    return any(
        path.startswith(prefix)
        for prefix in ALLOWED_PATH_PREFIXES
    )


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, message_format, *args):
        print(
            "%s - - [%s] %s"
            % (
                self.address_string(),
                self.log_date_time_string(),
                message_format % args,
            ),
            flush=True,
        )

    def get_origin(self):
        return self.headers.get("Origin", "").strip()

    def add_cors_headers(self):
        origin = self.get_origin()

        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS",
        )
        self.send_header(
            "Access-Control-Allow-Headers",
            ALLOWED_REQUEST_HEADERS,
        )
        self.send_header("Access-Control-Max-Age", "86400")

    def send_body(
        self,
        status,
        body,
        content_type="application/json; charset=utf-8",
    ):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.add_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_body(status, body)

    def validate_origin(self):
        origin = self.get_origin()

        if origin not in ALLOWED_ORIGINS:
            self.send_json(
                403,
                {"error": "Origin is not allowed"},
            )
            return False

        return True

    def read_target_config(self):
        encoded_config = self.headers.get(
            "X-Target-Config",
            "",
        ).strip()

        if not encoded_config:
            return None, None, "Missing X-Target-Config header"

        try:
            padding = "=" * (-len(encoded_config) % 4)
            decoded_config = base64.b64decode(
                encoded_config + padding,
                altchars=b"-_",
                validate=True,
            ).decode("utf-8")
            target_config = json.loads(decoded_config)
        except (
            binascii.Error,
            UnicodeDecodeError,
            json.JSONDecodeError,
            ValueError,
        ):
            return None, None, "Invalid X-Target-Config header"

        if not isinstance(target_config, dict):
            return None, None, "Invalid target configuration"

        target_base_url = target_config.get("baseUrl", "")
        target_api_key = target_config.get("apiKey", "")

        if not isinstance(target_base_url, str):
            return None, None, "Invalid target Base URL"

        if not isinstance(target_api_key, str):
            return None, None, "Invalid target API key"

        target_base_url = target_base_url.strip()
        target_api_key = target_api_key.strip()

        if not target_base_url:
            return None, None, "Missing target Base URL"

        if not target_api_key:
            return None, None, "Missing target API key"

        return target_base_url, target_api_key, None

    def build_upstream_headers(self, path, request_body):
        # /v1beta/models/ 是 Google 原生接口，用 x-goog-api-key 认证；
        # 其余路径（OpenAI Images、Grok 任务轮询）统一 Authorization: Bearer
        _, target_api_key, _ = self.read_target_config()

        headers = {
            "Accept": self.headers.get("Accept", "*/*"),
            "User-Agent": "gpt-image-proxy/1.0",
        }

        if path.startswith("/v1beta/models/"):
            headers["x-goog-api-key"] = target_api_key
        else:
            headers["Authorization"] = f"Bearer {target_api_key}"

        if request_body:
            headers["Content-Type"] = self.headers.get(
                "Content-Type",
                "application/octet-stream",
            )

        return headers

    def forward_request(self, request_body):
        target_base_url, _, config_error = (
            self.read_target_config()
        )

        if config_error:
            self.send_json(400, {"error": config_error})
            return

        parsed_target = urllib.parse.urlsplit(target_base_url)

        if (
            parsed_target.scheme != "https"
            or not parsed_target.netloc
            or parsed_target.username
            or parsed_target.password
        ):
            self.send_json(400, {"error": "Invalid target Base URL"})
            return

        parsed_request_url = urllib.parse.urlsplit(self.path)
        request_path = parsed_request_url.path

        target_url = target_base_url.rstrip("/") + request_path

        if parsed_request_url.query:
            target_url += "?" + parsed_request_url.query

        upstream_headers = self.build_upstream_headers(
            request_path,
            request_body,
        )

        if request_body:
            upstream_request = urllib.request.Request(
                target_url,
                data=request_body,
                headers=upstream_headers,
                method="POST",
            )
        else:
            upstream_request = urllib.request.Request(
                target_url,
                headers=upstream_headers,
                method="GET",
            )

        try:
            with urllib.request.urlopen(
                upstream_request,
                timeout=UPSTREAM_TIMEOUT_SECONDS,
            ) as response:
                response_body = response.read()
                response_type = response.headers.get(
                    "Content-Type",
                    "application/octet-stream",
                )
                self.send_body(
                    response.status,
                    response_body,
                    response_type,
                )

        except urllib.error.HTTPError as error:
            error_body = error.read()
            error_type = error.headers.get(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_body(
                error.code,
                error_body,
                error_type,
            )

        except urllib.error.URLError as error:
            self.send_json(
                502,
                {
                    "error": (
                        "Unable to reach upstream API: "
                        f"{error.reason}"
                    )
                },
            )

        except TimeoutError:
            self.send_json(
                504,
                {"error": "Upstream API request timed out"},
            )

        except Exception as error:
            print(f"Proxy error: {error!r}", flush=True)
            self.send_json(
                500,
                {"error": "Internal proxy error"},
            )

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path

        if path in {"/", "/health"}:
            self.send_json(
                200,
                {
                    "ok": True,
                    "service": "gpt-image-proxy",
                },
            )
            return

        if not self.validate_origin():
            return

        if not is_allowed_path(path):
            self.send_json(404, {"error": "Unsupported API path"})
            return

        self.forward_request(b"")

    def do_OPTIONS(self):
        if not self.validate_origin():
            return

        path = urllib.parse.urlsplit(self.path).path

        if not is_allowed_path(path):
            self.send_json(404, {"error": "Unsupported API path"})
            return

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.add_cors_headers()
        self.end_headers()

    def do_POST(self):
        if not self.validate_origin():
            return

        parsed_request_url = urllib.parse.urlsplit(self.path)
        request_path = parsed_request_url.path

        if not is_allowed_path(request_path):
            self.send_json(404, {"error": "Unsupported API path"})
            return

        target_base_url, _, config_error = (
            self.read_target_config()
        )

        if config_error:
            self.send_json(400, {"error": config_error})
            return

        content_length_text = self.headers.get("Content-Length")

        if not content_length_text:
            self.send_json(
                411,
                {"error": "Content-Length is required"},
            )
            return

        try:
            content_length = int(content_length_text)
        except ValueError:
            self.send_json(
                400,
                {"error": "Invalid Content-Length"},
            )
            return

        if content_length < 0 or content_length > MAX_BODY_SIZE:
            self.send_json(
                413,
                {"error": "Request body is too large"},
            )
            return

        request_body = self.rfile.read(content_length)
        self.forward_request(request_body)


def main():
    port = int(os.environ.get("PORT", "9000"))
    server = ThreadingHTTPServer(
        ("0.0.0.0", port),
        ProxyHandler,
    )

    print(
        f"Proxy listening on 0.0.0.0:{port}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
