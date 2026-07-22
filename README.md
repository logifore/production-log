# 制片日志 2.0 正式发布包

此仓库只保留可发布文件，并按平台拆分。

- `web/`: 上传至 Web 静态托管平台。
- `cloudflare-worker/`: 部署 Cloudflare Worker，并先配置 D1、域名和密钥。
- `miniprogram/`: 导入微信开发者工具后上传。

Web 和小程序的跨端同步依赖已部署的 Worker API。部署前需替换小程序 AppID，并在对应客户端构建时注入正式 API 域名。
