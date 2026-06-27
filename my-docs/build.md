# VS Code macOS 构建指南

## 前置准备(一次性)

```bash
xcode-select --install      # 命令行工具
npm install                 # 安装依赖(含 Electron)
```

> Electron 下载慢:`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

---

## 边改边跑(开发模式)

**终端 1** — 监听编译(常驻):

```bash
npm run watch
```

**终端 2** — 启动开发实例:

```bash
./scripts/code.sh \
  --user-data-dir=$HOME/.vscode-oss-dev \
  --extensions-dir=$HOME/.vscode-oss-dev/extensions
```

> `--user-data-dir` / `--extensions-dir` 用于隔离,避免污染官方版 VS Code。

**看效果**:开发实例窗口 `Cmd+Shift+P` → `Developer: Reload Window`(或 `Ctrl+R`)。

> 结构性改动(改 `product.json`、加依赖、改主进程)需完全退出开发实例后重新跑 `./scripts/code.sh`。

---

## 任务方式(更省事,不敲命令)

`Cmd+Shift+B` 或命令面板运行任务:

| 任务                         | 作用                      |
| ---------------------------- | ------------------------- |
| `VS Code - Build`            | 后台 watch 全量编译(常驻) |
| `Run Dev`                    | 启动 `./scripts/code.sh`  |
| `Run and Compile Code - OSS` | 转译 + 启动(一键)         |

---

## 编译命令

```bash
npm run transpile-client          # 仅快速转译(最快,无类型检查)
npm run build-fast                # 转译 + 扩展 + Copilot
npm run compile                   # 完整编译(核心 + Copilot)
npm run gulp compile-extensions   # 编译内置扩展
npm run compile-web               # 编译 Web 版
npm run compile-cli               # 编译 CLI(Rust)
```

---

## 校验

```bash
npm run typecheck-client      # 类型检查(需 tsgo)
npm run eslint                # ESLint
npm run valid-layers-check    # 分层校验
npm run hygiene               # 代码规范
```

---

## 测试

```bash
./scripts/test.sh                 # 单元测试
./scripts/test-integration.sh     # 集成测试
npm run test-browser              # 浏览器单元测试
```

---

## 调试开发实例

`Cmd+Shift+D` → 选启动配置 **"Launch VS Code"** → `F5`(官方版作为调试器拉起开发实例)。

---

## 打包安装成独立 App(开发完成后)

⚠️ **不能直接覆盖官方 release 版**:两者 Bundle ID、签名、自动更新机制都不同,强行覆盖会损坏官方版(更新失效、macOS Gatekeeper 拦截)。正确做法是**打包成独立的 `Code - OSS.app`,与官方版共存**。

### 1. 编译发布产物

```bash
npm run gulp compile-build-with-mangling   # 生成 out-build(发布版,带 mangle)
# 或用 minify 版(更小):npm run gulp minify-vscode
```

### 2. 打包成 macOS App

```bash
# Apple Silicon(arm64)
npm run gulp vscode-darwin-arm64
# Intel(x64)
npm run gulp vscode-darwin-x64
```

产物在项目上级目录:

```
../VSCode-darwin-arm64/Code - OSS.app
```

### 3. 安装

```bash
# 移到 /Applications(与官方版共存,名字不同:Code - OSS vs Visual Studio Code)
mv "../VSCode-darwin-arm64/Code - OSS.app" /Applications/

# 首次打开被 Gatekeeper 拦(未签名):
#   系统设置 → 隐私与安全性 → 仍要打开
# 或命令行放行:
xattr -dr com.apple.quarantine "/Applications/Code - OSS.app"
open "/Applications/Code - OSS.app"
```

> 未签名 App 自带的数据目录是独立的(`~/Library/Application Support/Code - OSS`),不会动官方版的 `Code` 目录。

### 4.(可选)做成 DMG 安装包

```bash
node build/darwin/create-dmg.ts
```

---

## 替换官方版的正确姿势(不推荐)

若一定要让"官方版 VS Code"跑你的代码,正确顺序是:

1. 先打包出 `Code - OSS.app`(见上一节)。
2. **完全卸载官方版**:`/Applications/Visual\ Studio\ Code.app` 拖到废纸篓,并清理 `~/Library/Application Support/Code`、`~/Library/Caches/com.microsoft.VSCode` 等。
3. 把 `Code - OSS.app` 改名/改图标后放进 `/Applications`。

> ❌ 不要直接把官方版 App 里的 `Resources/app/out` 换成你的产物——签名校验失败会导致崩溃或白屏,自动更新也会把它还原。

---

## 能否复用官方版的同步 / 扩展市场 / 配置目录?

**默认全部隔离**,由 `product.json` 决定。对比如下:

| 能力     | 官方版 (VS Code)                         | 你的 OSS 版                                                   | 默认复用? |
| -------- | ---------------------------------------- | ------------------------------------------------------------- | --------- |
| 配置目录 | `~/Library/Application Support/Code`     | `…/Application Support/Code - OSS`(开发模式是 `code-oss-dev`) | ❌ 隔离    |
| 扩展目录 | `~/.vscode/extensions`                   | `~/.vscode-oss/extensions`                                    | ❌ 隔离    |
| 扩展市场 | 有(`product.extensionsGallery`)          | ❌ 无(装不了商店扩展)                                          | ❌         |
| 设置同步 | 有(`product["configurationSync.store"]`) | ❌ 无                                                          | ❌         |
| 登录账号 | 绑定同步服务                             | 无同步端点                                                    | ❌         |

**根本原因**:这些全靠 `product.json` 配置。OSS 版的 `product.json` 故意精简——没有 `extensionsGallery`、没有 `configurationSync.store`,`dataFolderName` 也不同(`.vscode-oss` vs `.vscode`)。

### 想复用:三种做法

#### 做法 A:启动时手动指向同一目录(最安全,不打包也行)

开发模式即可,无需改 `product.json`:

```bash
./scripts/code.sh \
  --user-data-dir="$HOME/Library/Application Support/Code" \
  --extensions-dir="$HOME/.vscode/extensions"
```

> ⚠️ 风险:和官方版**共享同一份配置/扩展**,两边互相干扰(官方版启动会改写状态库、扩展版本可能不兼容)。建议**先备份**:`cp -R ~/Library/Application\ Support/Code ~/Library/Application\ Support/Code.bak`。

#### 做法 B:把官方版的 `product.json` 配置抄进 OSS 版(解锁同步+市场)

编辑项目根 `product.json`,从官方版 App 里复制这几个字段进去:

```bash
# 官方版 product.json 路径
PROD="/Applications/Visual Studio Code.app/Contents/Resources/app/product.json"

# 用 node 提取并合并进本项目的 product.json(建议手动核对)
node -e "
  const fs=require('fs');
  const official=JSON.parse(fs.readFileSync('$PROD','utf8'));
  const mine=JSON.parse(fs.readFileSync('./product.json','utf8'));
  ['extensionsGallery','configurationSync.store','editSessions.store','settingsSyncBrandName'].forEach(k=>{ if(official[k]) mine[k]=official[k]; });
  fs.writeFileSync('./product.json', JSON.stringify(mine,null,'\t'));
"
```

> 改完后重新 `npm run watch`(或重打包),OSS 版就能装商店扩展、能用 Settings Sync 登录官方账号。
> ⚠️ 仅供本地自用。`product.json` 是构建产物配置,**不要提交这个改动**到上游。

#### 做法 C:完全不管,各自独立(默认,推荐)

OSS 版用独立目录,官方版互不干扰。缺点:扩展要单独装(OSS 版默认无市场,需用做法 B 才能装)。

### 关于登录账号

Settings Sync 的登录(GitHub / Microsoft)走 `configurationSync.store.authenticationProviders`,**OSS 版默认没有这个端点**,所以:
- 不做任何修改 → 无法登录、无法同步。
- 用做法 B 注入 `configurationSync.store` → 可以登录官方账号同步(和官方版共享同一份云端同步数据)。

---

## 常见问题

| 问题                                     | 解决                                               |
| ---------------------------------------- | -------------------------------------------------- |
| `sh: xxx: command not found`(退出码 127) | `npm install`(node_modules 不全)                   |
| 原生模块编译失败                         | `xcode-select --install`,确认 Node 版本            |
| `transpile-client` 报错                  | `node build/next/index.ts transpile` 看详细错误    |
| 改了代码 Reload 无变化                   | 确认 watch 终端有编译完成日志;结构性改动需重启实例 |
| 找不到 Electron                          | `npm install` 或 `npm run electron`                |


## 本地发布
```shell
# 确保官方版已退出,然后一键编译+打包+替换+启动
cd /Users/zhaihao/Code/node/vscode && \
npm run gulp vscode-darwin-arm64  && \
rm -rf "/Applications/Visual Studio Code.app" && \
mv "../VSCode-darwin-arm64/Visual Studio Code.app" /Applications/ && \
xattr -dr com.apple.quarantine "/Applications/Visual Studio Code.app" && \
open "/Applications/Visual Studio Code.app"
```
