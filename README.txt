dsh-download  ——  DeepSeek Harness 下载插件
================================================

怎么装(最简单的方式)
--------------------
1. 把整个文件夹解压到任意位置,建议放在一个不会随手删掉的地方,
   例如 D:\tools\dsh-download

2. 双击 install.cmd

3. 看到这一行就成功了:
       OK : row 'tool-dsh-download' is composed into profile 'web'

4. 重启 dsh,然后开一个新对话 —— download_file 会出现在工具列表里

5. 「设置 → 插件 → 下载」就是下载面板:进度条、速度、失败原因、下载历史


不需要什么
----------
· 不需要 pnpm,不需要联网,不需要预先装任何别的软件
· 内置引擎(本项目自己写的那个)是默认引擎,任何大小的文件都走它
· Neat Download Manager 是可选的 —— 只有把设置里的 engine 改成 "ndm" 才用到它


注意
----
· 装完之后不要移动或删除这个文件夹:profile 里是指向它的链接
· 卸载:双击 uninstall.cmd(加 -Purge 会连设置和历史一起删掉)
· 前提:dsh 已经装好,并且至少启动过一次(否则 profile 目录还不存在)
· 完整介绍(中英双语,含功能与用法):INTRODUCTION.md
· 详细安装说明:INSTALL.md;引擎对比与风险:README.md


English
-------
Double-click install.cmd. It wires this plugin into your dsh profile entirely offline:
no pnpm, no network, nothing else to install. Then restart dsh and open a new
conversation - the download_file tool will be there, together with a download panel
under Settings -> Plugins.

Do not move this folder afterwards: the profile links to it.
To remove everything: uninstall.cmd.
Details, platform notes and troubleshooting: INSTALL.md
