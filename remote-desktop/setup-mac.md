# Mac 被控端配置（当前这台 Mac，Apple Silicon）

> ✅ 已完成：RustDesk 1.4.9 已安装、自建服务器配置已预写入（`~/.config/rustdesk/RustDesk.toml`）。
> 以下 3 步因 macOS 安全机制必须在界面上手动点，约 2 分钟。

## 剩余手动步骤（在 RustDesk 窗口里操作）

### 1. 安装后台服务
打开 RustDesk（已在运行）→ 主界面若显示"安装"按钮，点击它 → 输入 Mac 开机密码授权。

### 2. 授予系统权限（必做）
系统会弹窗或在 **系统设置 → 隐私与安全性** 中手动开启：

- **屏幕录制与系统音频** → 勾选 RustDesk（抓屏必需，不开则浏览器端黑屏）
- **辅助功能** → 勾选 RustDesk（远程键鼠控制必需）

授权后按提示重启 RustDesk。

### 3. 设置固定密码
RustDesk → 设置 → 安全 → 解锁安全设置 → **使用固定密码**，设置一个强密码。
（浏览器端连这台 Mac 时输入：RustDesk ID + 这个密码）

## 连接方式

- 浏览器打开 **http://47.97.41.141:21114** → 登录后进入 Web Client
- 输入这台 Mac 的 RustDesk ID（主界面 9 位数字）+ 固定密码

## 已部署信息（备忘）

| 项目 | 值 |
|---|---|
| ID/中继服务器 | `47.97.41.141` |
| 加密 Key | `CjJI70GMRmFiP7dS4npDx8dKBiKEsAR44chYoHfFrHA=`（已写入配置） |
| 管理后台 | http://47.97.41.141:21114/_admin/ （admin / 密码见本目录 `.admin-pw` 文件） |
| ECS 实例 | i-bp1a99p1vvyu49cl8u76（杭州，Alibaba Cloud Linux 3） |
| 安全组 | sg-bp1hw4dpspxwld97xqpt，已放行 TCP 21114-21119 / UDP 21116 |
| 服务目录 | ECS `/opt/rustdesk`（docker compose 管理） |
| SSH | `ssh ecs-rustdesk`（已配置别名，端口 9822） |

## 注意

- **锁屏/休眠**：Mac 合盖或睡眠后无法连接。系统设置 → 节能：关闭自动睡眠、开启"唤醒以供网络访问"。
- **HTTP 降级**：纯 IP + HTTP 下浏览器部分能力受限（剪贴板、全键捕获）。要完整体验建议后续绑域名上 HTTPS。
- **带宽**：1080p 建议 ECS 带宽 ≥ 10 Mbps；卡顿可在连接设置里降画质。
