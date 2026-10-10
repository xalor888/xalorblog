# 两个站点（博客域 / 个人主页域）共用的反向代理片段，由各 server 块 `include` 引入。
#
# 关键点：`proxy_set_header Host $host` —— 后端按 Host 派发 SEO 路由
# （个人主页域名出主页版 robots/sitemap/rss，其余出博客版）。若用固定 Host 覆盖，
# 派发会失效，两个域名都会拿到博客版。
#
# 对应的后端配置（server/.env）：
#   ALLOWED_HOSTS=<主页域名>,<博客域名>,localhost,127.0.0.1,::1
#   HOME_SITE_HOST=<主页域名>
#
# ── 源站校验头（可选兜底：无法在安全组限制源站直连时用）────────────────────
# 原理：让边缘（阿里云 ESA 等）回源时追加一个只有你和边缘知道的密钥头，
# 这里校验，不通过直接 444 断连（不回任何响应，不给扫描器反馈）。
#
# 用法：
#   1) 生成一串长随机值：openssl rand -hex 32
#   2) ESA 控制台 → 回源配置 → 请求头：新增 X-Origin-Verify = <该随机值>
#      （确认它同时作用于健康检查与回源请求，否则 ESA 探活会被自己挡住）
#   3) 取消下面 if 的注释并替换 <换成你自己的长随机串>
#
# ⚠ 两个注意：
#   - Let's Encrypt HTTP-01 校验、以及任何直连源站的探活（含你自己的监控）
#     都会命中 444，需要的话按注释里的白名单行放行。
#   - 这项只是「安全组没配好」时的兜底；能在安全组按 ESA 回源网段收口更好。
#
# if ($http_x_origin_verify != "<换成你自己的长随机串>") {
#     # 放行证书校验与健康探测（按需调整路径）
#     # if ($request_uri !~ "^/\.well-known/acme-challenge/") { return 444; }
#     return 444;
# }
# ──────────────────────────────────────────────────────────────────────────
    # 若修改 API_PREFIX，请同步修改此 location。
    location ^~ /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # 覆盖而不是追加客户端提供的转发头，防止伪造来源 IP/协议。
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header Forwarded "";
        proxy_set_header Connection "";
    }

    # 搜索引擎与通用订阅器标准根路径，直接反代给后端
    location ~* ^/(robots\.txt|sitemap\.xml|rss\.xml|health)$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 上传文件由后端执行访问控制与安全响应头。
    location ^~ /uploads/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header Forwarded "";
        proxy_set_header Connection "";
    }
