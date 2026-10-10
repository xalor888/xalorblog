# 两个站点（博客域 / 个人主页域）共用的反向代理片段，由各 server 块 `include` 引入。
#
# 关键点：`proxy_set_header Host $host` —— 后端按 Host 派发 SEO 路由
# （个人主页域名出主页版 robots/sitemap/rss，其余出博客版）。若用固定 Host 覆盖，
# 派发会失效，两个域名都会拿到博客版。
#
# 对应的后端配置（server/.env）：
#   ALLOWED_HOSTS=<主页域名>,<博客域名>,localhost,127.0.0.1,::1
#   HOME_SITE_HOST=<主页域名>
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
