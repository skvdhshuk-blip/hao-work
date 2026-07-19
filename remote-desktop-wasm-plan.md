# 基于 WASM 的 Web 远程桌面方案调研

> 目标：类似 ToDesk 的体验 —— 浏览器打开一个地址，就能远程控制"当前这台电脑"。
> 部署：阿里云 ECS `47.97.41.141`，开一个端口供浏览器访问。

## 1. 需求拆解与总体架构

ToDesk 的核心链路是：

```
被控端 Agent（当前电脑）  ──►  中继/ID 服务器（ECS）  ◄──  控制端（浏览器）
```

- **被控端 Agent**：跑在你的本机，负责抓屏、编码、注入键鼠事件。
- **ECS（47.97.41.141）**：承担 ID 分发 / 信令 / 中继转发 + 托管 Web 页面。
- **浏览器端**：无插件、无安装，最好基于 WebRTC（视频流）+ WebSocket（控制信令），视频解码用 **WebCodecs**（浏览器原生硬解），降级路径用 **WASM 软解**。

⚠️ 关键结论先行：**"纯 WASM 解码"已经不是最优路径**。2026 年的主流做法是 WebCodecs 优先（延迟 <100ms、零 30MB+ WASM 下载），WASM 解码器仅作老浏览器兜底。所以方案选型上以 "Web 化 + WASM/WebCodecs 前端" 为准，而不是执着纯 WASM。

## 2. 候选方案对比

### 方案 A：RustDesk 自建中继 + WASM Web 客户端（⭐ 推荐，最像 ToDesk）

- **架构**：ECS 上跑 `hbbs`（ID/信令）+ `hbbr`（中继）；当前电脑装 RustDesk 客户端指向自建服务器；浏览器用 RustDesk 官方 **Web Client（Rust 编译为 WASM）**。
- **优点**：体验最接近 ToDesk（ID + 密码连接）；WASM 客户端纯浏览器运行；支持 TCP 打洞 + 中继，NAT 穿透完整；文件传输、剪贴板都有。
- **缺点**：Web 客户端功能比原生客户端弱（部分功能 beta）；延迟略高于原生 WebRTC 方案。
- **端口**：21115-21117（hbbs/hbbr）、21118/21119（web 客户端 WebSocket），需在 ECS 安全组放行 TCP/UDP 21116 等。

### 方案 B：Sunshine + moonlight-web-stream（⭐ 推荐，延迟最低）

- **架构**：当前电脑跑 **Sunshine**（抓屏 + GPU 硬编码 H.264/HEVC）；ECS 上跑 **moonlight-web-stream**（Web 服务器，把 Sunshine 流量转成浏览器 WebRTC/WebSocket，前端用 WebCodecs 解码，WASM 兜底）。
- **优点**：串流界公认延迟最低（游戏级，几十 ms）；画质可调，支持硬件编码（你的 Mac 走 VideoToolbox）。
- **缺点**：项目非官方、相对小众；功能聚焦串流，文件传输/无人值守管理弱；配对流程比 ToDesk 繁琐一点。

### 方案 C：MeshCentral（功能最全的"管理平台"路线）

- **架构**：ECS 上跑 MeshCentral（Node.js，自带 Web 控制台）；当前电脑装 Agent；浏览器直接开控制台即可远程桌面/终端/文件管理。
- **优点**：Apache 2.0，成熟稳定；Web 端零安装；用户/权限/2FA/审计齐全；部署最简单（npm 装完即用）。
- **缺点**：画面是 JPEG/WebSocket 流，不是 WASM/WebCodecs 视频管线，延迟和流畅度弱于 A/B；更偏"运维管理"而非"ToDesk 式串流体验"。

### 方案 D：自研（WebRTC + WebCodecs，screego 式）

- 用 Go/Pion 或 Rust 写被控端（抓屏 + 编码）+ ECS 信令服务 + 浏览器 WebCodecs 解码。
- 灵活性最高，但工作量最大，不建议第一版走这条；screego 只有屏幕分享、没有反向控制，需要自研键鼠注入。

### 方案 E：noVNC / KasmVNC / Guacamole（传统路线）

- WebSocket + JPEG/WebP 图像帧，前端非 WASM，延迟和带宽表现最差；只在"被控端是纯 Linux 无图形环境"时有优势，不符合本题。

## 3. 结论与建议

| 你的优先级 | 选哪个 |
|---|---|
| 最像 ToDesk、WASM 客户端、功能完整 | **方案 A：RustDesk 自建 + WASM Web Client** |
| 画面流畅/低延迟、主要给自己用 | **方案 B：Sunshine + moonlight-web-stream** |
| 想顺便管理多台设备、要权限/审计 | 方案 C：MeshCentral |

**建议路线**：先落地方案 A（RustDesk 自建），因为它开箱即用、WASM 客户端正好匹配你"基于 wasm"的诉求；若对延迟不满意，再在同一台 ECS 上叠加方案 B 对比。

## 4. 部署要点（方案 A）

1. **ECS 安全组**放行：TCP 21115/21116/21117/21118/21119、UDP 21116（hbbs 打洞用），以及 Web 端口（如 443/8443）。
2. **ECS 上**（Docker 最省事）：
   ```bash
   docker run -d --name hbbs -p 21115:21115 -p 21116:21116 -p 21116:21116/udp -p 21118:21118 rustdesk/rustdesk-server hbbs
   docker run -d --name hbbr -p 21117:21117 -p 21119:21119 rustdesk/rustdesk-server hbbr
   ```
   Web Client 镜像：`rustdesk/rustdesk-web-client`（Rust→WASM 编译产物，浏览器加载）。
3. **当前电脑**：装 RustDesk，设置 → 网络 → 填 `47.97.41.141` 作为 ID/中继服务器，开启无人值守密码。
4. **浏览器访问**：`http://47.97.41.141:<web端口>`，输入本机 RustDesk ID + 密码即可控制。

### 已知坑

- **Secure Context**：WebCodecs / 剪贴板 / 键鼠捕获 API 要求 HTTPS。纯 IP + HTTP 下部分能力受限，建议：① 绑个域名 + Let's Encrypt；或 ② 用 mkcert/自签证书并在浏览器信任；或 ③ 接受 HTTP 下功能降级。
- **macOS 被控端**（如果"当前电脑"是这台 Mac）：需要授予屏幕录制、辅助功能权限；macOS 上 RustDesk/Sunshine 都支持。
- **带宽**：1080p60 大约 8-15 Mbps；ECS 按量带宽建议 ≥10 Mbps，否则降分辨率/帧率。

## 5. 下一步

确认选型后可直接动手：写 docker-compose + 安全组放行清单 + 一键部署脚本，SSH 到 47.97.41.141 部署，最后给你浏览器可访问的地址。
