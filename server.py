# -*- coding: utf-8 -*-
"""
日学 · 本地服务器
既能像 http.server 一样托管静态页面，又提供 /tts 代理：
手机 → 本服务器（取音频）→ 本服务器去百度/有道取真实日语 → 原样返回。
这样手机只需要连得通你的电脑，不需要自己有外网/能直连百度。
"""
import os
import urllib.parse
import urllib.request
import http.server

PORT = int(os.environ.get("PORT", "8000"))


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # 安静，少打日志
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/tts":
            qs = urllib.parse.parse_qs(parsed.query)
            text = (qs.get("text") or [""])[0]
            spd = (qs.get("spd") or ["5"])[0]
            self.serve_tts(text, spd)
            return
        super().do_GET()

    def serve_tts(self, text, spd):
        if not text:
            self.send_error(400, "missing text")
            return
        q = urllib.parse.quote(text)
        # 优先取真实的日语 TTS：百度（日语），失败再试有道
        sources = [
            "https://fanyi.baidu.com/getTTS?lan=jp&text=%s&spd=%s&source=web" % (q, spd),
            "https://dict.youdao.com/dictvoice?audio=%s&type=2" % q,
        ]
        body = None
        for s in sources:
            try:
                req = urllib.request.Request(s, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=8) as r:
                    b = r.read()
                    if b and len(b) > 100 and (b[0] == 0xFF):  # MPEG 帧头
                        body = b
                        break
            except Exception:
                continue
        if body is None:
            self.send_error(502, "tts failed")
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("日学服务器运行在 http://localhost:%d  （/tts 代理已启用）" % PORT)
    server.serve_forever()
