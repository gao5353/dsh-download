# dsh-download

**中文** | [English](#english)

一个给 **DeepSeek Harness (dsh)** 用的下载插件：给模型加一个 `download_file` 工具，给人在「设置 → 插件 → 下载」里加一个下载面板。

> 一句话：**等待下载的过程不消耗一个 token**，文件一定落在你指定的位置，断网或重启后能接着下。

---

## 一、它具体有什么用

### 1. 等待下载**零 token 消耗**（这是它存在的理由）

让 AI 下载一个 5 GB 的文件，常见的做法是让 AI 去看下载器的输出——几十 KB 的进度条文本灌进上下文，还要反复轮询，一次下载能烧掉几千 token。

这个插件换了做法：**整个下载在一次工具调用里等完**，只回一行结果。等待期间模型上下文**完全不增长**（每请求固定开销 219 token，与下载大小无关）。

```
OK 5.54 GiB -> C:\Users\you\Desktop\model.gguf (built-in, segmented x16, 113s)
```

### 2. 分段下载：比普通下载**快 2.5 倍**（同一镜像实测）

| 方式 | 1.99 GiB 耗时 | 速度 |
|---|---|---|
| 普通单连接下载（curl 基线） | 92.1 s | 22.1 MiB/s |
| **本插件（16 段）** | **36.5 s** | **55.8 MiB/s** |
| 本插件（4 段） | 34.8 s | 58.6 MiB/s |
| 本插件（32 段） | 52.7 s | 38.7 MiB/s |

结论：**4～16 段最划算，32 段反而更慢**（镜像限流）。段数可在界面里调。

### 3. 断点续传：断网、重启都不用从头再来

- 中途断网 → 已完成的部分保留，下一次调用**从断点接着下**
- dsh 重启 / 进程被杀 → 半成品和进度记录都在，下次继续
- 可以主动「限时下载」（`waitSeconds`）：到点停下并告诉你已完成多少，之后再接着下

实测：一个 1.99 GiB 的文件限时 15 秒停下时已完成 **879 MiB（43%）**，第二次调用 **21 秒**补完，sha256 与镜像公布值一致。

### 4. 文件一定落在你指定的位置，且**不留垃圾**

- 下载过程中写 `<目标文件>.part`，**全部完成才改名到最终文件名** —— 所以目录里永远不会出现"大小正确但内容有空洞"的假成品
- 成功之后成品旁边**不留任何辅助文件**
- 失败时：**只有真能续传的**半成品才保留；不能续传的（一个字节都没到、或缺少进度记录）**立刻删掉**
- 启动时自动巡检：孤立的 `.part` 无论多新都清掉；可续传的保留 7 天后清理（可设置为 0 = 从不保留）
- **它只删自己写的那几个确切文件名** —— 绝不会按通配符去删你的其它文件

### 5. 双引擎（内置引擎为默认，另一个可选）

| | 内置引擎（默认） | Neat Download Manager |
|---|---|---|
| 需要装什么 | **什么都不用装** | 需安装该 Windows 软件 |
| 速度 | **更快**（实测 2.5 倍于普通下载） | 较慢，但有独立进度窗口 |
| 落点 | 直接落到你指定的位置 | 先下到它自己的目录，插件再搬运并校验 |
| 被镜像拒绝 | 自动换 User-Agent | 需要改注册表 |

两者都保留，改一个设置就能切换。

### 6. 下载面板（设置 → 插件 → 下载）

- **进行中**：文件名、进度条、已下载/总大小、速度、引擎、连接数、目标路径（可一键复制）
- **最近**：成功/失败/取消/被中断，失败的显示**原因 + 建议**
- **全部设置**：在界面里直接查看和修改
- **不打扰你**：它是设置里的一个页签。**关掉页签就完全停止**（不留后台定时器、不发请求），完全感知不到它存在

### 7. 下载记录人和 AI 都能查

记录写在 `%DSH_HOME%\dsh-download.status.json`（最新 25 条），面板读它、AI 也能读它——所以你能问 AI「上次那个下载怎么样了」。

---

## 二、安装（Windows，三步）

1. 把压缩包解压到一个**不会随手删掉的位置**，例如 `D:\tools\dsh-download`
2. **双击 `install.cmd`**
3. 看到这一行就成功了：
   ```
   OK : row 'tool-dsh-download' is composed into profile 'web'
   ```
   然后**重启 dsh**，开一个新对话 —— `download_file` 工具和「下载」面板都会出现。

**特点**：安装器**不需要 pnpm、不需要联网、不需要预先装任何软件**（它自己做 profile 依赖声明、bundle 行、目录链接三件事）。改 profile 前会自动备份，验证不通过会**自动回滚**。重复运行安全。

**前提**：本机已装 dsh，并且**至少启动过一次**（否则 profile 目录还不存在）。

**卸载**：双击 `uninstall.cmd`（加 `-Purge` 连设置和历史一起删）。

**其它安装方式**：`dsh plugin --profile web add "<插件目录>"`，或从 git：`dsh plugin --profile web add github:<user>/<repo>`。详见 `INSTALL.md`。

**系统要求**：Windows 10/11（自带 PowerShell 5.1 即可）、Node 18+、dsh 已安装。

---

## 三、使用方法

### 让 AI 下载

直接说「帮我下载 …」，AI 会调用 `download_file`：

| 参数 | 说明 |
|---|---|
| `url` | 要下载的地址（必填） |
| `dest` | 目标**文件路径**或**目录**；目录要以 `\` 结尾。省略则落到默认下载目录 |
| `force` | 强制走 Neat Download Manager（哪怕当前默认是内置引擎） |
| `waitSeconds` | 限时等待。省略＝等到下载完；给了值＝到点停下并报告已完成多少，之后可继续 |

### 看进度 / 查历史

**设置 → 插件 → 下载**。下载中实时显示，失败的会写清原因。

### 改设置

- 面板里能改的：引擎、阈值、分段数量、监视模式、面板刷新间隔等
- 其余在设置文件里改：`%DSH_HOME%\dsh-download.settings.json`（**下次下载立即生效，不用重启**）
- 也可以双击 `settings.cmd` 用中文菜单向导

### 常用的两种玩法

```
下载一个 5 GB 的模型到 D 盘：
  download_file { url: "…", dest: "D:\\models\\" }

先下 30 秒看看速度，之后再接着下：
  download_file { url: "…", dest: "D:\\models\\x.gguf", waitSeconds: 30 }
  → TIMEOUT … reached 2.1 GiB of 5.5 GiB in 30s. A partial transfer is kept at …; call again to resume.
  download_file { url: "…", dest: "D:\\models\\x.gguf" }     ← 续传补完
```

---

## 四、诚实的限制

- **速度取决于源**：镜像本身限速的话，任何工具都快不了。实测的 2.5 倍来自「不限速但单连接跑不满」的镜像（清华等）
- **NDM 引擎仅 Windows**；内置引擎无平台相关代码，Linux/macOS **预期可用但尚未实测**
- **断电不保证续传**：记录的是「交给操作系统的字节」。进程被杀可以续传，硬断电不保证 —— 需要的话用 sha256 校验
- **它不删你没让它删的东西**：只清理自己产生的 `.part` / `.part.json`。你自己下载的其它文件、或你让 AI 用 `dest` 明确命名的文件，它一个都不碰
- 需要**不受限的文件访问**（目标可能在任意盘符）

---

## 五、许可证

MIT。

---

# English

**A download plugin for DeepSeek Harness (dsh)**: it gives the model a `download_file` tool and gives
you a download panel under **Settings → Plugins → 下载 (Downloads)**.

> In one sentence: **waiting for a download costs zero tokens**, the file lands exactly where you
> asked for it, and an interrupted transfer continues instead of starting over.

## What it actually does

### 1. Waiting costs no tokens

The usual way to have an agent download something is to let it read the downloader's progress output:
tens of kilobytes of progress bars poured into the context, polled repeatedly. This plugin removes
that structurally — **the whole transfer is awaited inside one tool call** and returns a single line:

```
OK 5.54 GiB -> C:\Users\you\Desktop\model.gguf (built-in, segmented x16, 113s)
```

The model context does not grow while it waits. The standing cost is 219 tokens per request,
independent of file size.

### 2. Segmented transfer: measured 2.5× faster than a normal download

| Method | 1.99 GiB | Speed |
|---|---|---|
| Plain single connection (curl baseline) | 92.1 s | 22.1 MiB/s |
| **This plugin (16 segments)** | **36.5 s** | **55.8 MiB/s** |
| This plugin (4 segments) | 34.8 s | 58.6 MiB/s |
| This plugin (32 segments) | 52.7 s | 38.7 MiB/s |

4–16 segments is the sweet spot; 32 is *slower* (mirrors throttle). The count is adjustable in the
panel.

### 3. Resume: a dropped connection or a restart does not cost the work already done

- Network dies mid-transfer → what arrived is kept, and the next call continues from that byte.
- dsh restarts or the process is killed → partial and progress record survive; the next call resumes.
- You can ask for a bounded wait (`waitSeconds`): it stops, tells you how far it got, and you finish
  it later.

Measured: a 1.99 GiB transfer stopped after 15 s had **879 MiB (43%)** on disk; the follow-up call
finished the rest in **21 s**, with a sha256 matching the mirror's published sum.

### 4. The file lands where you asked, and leaves no junk

- The transfer works on `<dest>.part` and only takes the destination name once every segment is
  proven complete — so a folder never contains a right-sized file full of holes.
- After success, **nothing is left beside the finished file**.
- After a failure, a partial is kept **only if it can actually be resumed**; otherwise it is removed.
- On startup, an orphaned `.part` is swept whatever its age, and a resumable pair is swept after
  `partialRetentionDays` (7 by default; set `0` to never keep one).
- It only ever removes the exact file names it created. It will not delete your other files.

### 5. Two engines

The default **built-in engine** needs nothing installed, is faster, and writes straight to your
destination. The optional **Neat Download Manager** engine needs that Windows program, is slower, and
has to download elsewhere and move the file — but it shows its own progress window. Switching is one
setting.

### 6. A download panel you can ignore

In-flight rows show filename, progress bar, bytes/total, speed, engine, connection count and the
destination path; recent rows show outcome, and for failures the **reason and a hint**. It lives in
Settings as a tab: **when the tab is closed it polls nothing at all**.

### 7. Records both you and the agent can read

Written to `%DSH_HOME%\dsh-download.status.json`, so both the panel and the agent can answer "how did
that download go?".

## Install (Windows, three steps)

1. Unzip to a place you will not delete by accident, e.g. `D:\tools\dsh-download`.
2. **Double-click `install.cmd`.**
3. Success looks like `OK : row 'tool-dsh-download' is composed into profile 'web'`. Restart dsh and
   open a new conversation.

The installer is **offline: no pnpm, no network, nothing else to install** — it makes the three edits
`dsh plugin add` would make (dependency, bundle row, folder link), backs up the profile manifest
first, verifies that the profile still composes, and rolls back if it does not.

Requires: Windows 10/11, Node 18+, and dsh installed **and started at least once**. Uninstall with
`uninstall.cmd`. Alternatives (`dsh plugin add`, git) are in `INSTALL.md`.

## Usage

| Argument | Meaning |
|---|---|
| `url` | The URL to download (required) |
| `dest` | Destination file or directory (end a directory with `\`). Omitted → the default download folder |
| `force` | Route through Neat Download Manager even if the built-in engine is the default |
| `waitSeconds` | Bound the wait. Omitted = wait until finished; set = stop early and report progress, then continue later |

Watch progress under **Settings → Plugins → 下载**. Settings the panel can change are editable in
place; everything else lives in `%DSH_HOME%\dsh-download.settings.json` and applies to the next
download with no restart.

## Honest limits

- Speed is bounded by the source: a mirror that throttles stays slow for any tool.
- The Neat Download Manager engine is Windows-only. The built-in engine has no platform-specific
  code, so Linux/macOS are **expected** to work — but that is from reading the code, not from running
  it there.
- Resume assumes the bytes reached the operating system: a process kill is resumable, a power cut is
  not guaranteed. Hash the result if it matters.
- It needs unrestricted file access, because a destination can be on any drive.

## License

MIT.
