/**
 * Browser half of dsh-download — the download panel.
 *
 * Shipped as a hand-written client bundle rather than a build artifact. The contract, read off a
 * shipped client plugin, is small: a CommonJS-style factory registered on the loader, whose
 * exports are `apply(ctx)` and `inject` — the same shape a host-side plugin has.
 *
 * This file is load-bearing in a way that is easy to miss: it is NOT an ES module. It must not use
 * `import`, because the browser module system here is a `require` registry built before cordis
 * exists, and this file is evaluated as a plain script that only *registers* a factory. The only
 * modules it requires are ones the loader itself provides.
 *
 * Where it lives, and why that matters
 * ------------------------------------
 * The panel is a tab under Settings → Plugins. Settings is somewhere a person already goes, and a
 * status window the user has to discover on their own is a status window nobody opens. It also has
 * a property worth stating plainly: **when the tab is not displayed, it stops polling entirely.**
 * The host keeps a visited tab mounted (hidden) rather than unmounting it, so "is it open?" cannot
 * be answered by mount state — an IntersectionObserver on the panel's own root answers it instead,
 * combined with the document's visibility. A background panel therefore costs nothing: no timer,
 * no request, no disk read.
 *
 * Where its numbers come from
 * ---------------------------
 * Two read-only GET routes the host half registers: `/dsh-download/status.json` (what is running
 * plus how the recent ones ended) and `/dsh-download/settings.json` (the effective settings). Both
 * are plain `fetch` — this is the Web surface, where the browser talks to the same origin over
 * HTTP. Settings are fetched once per visit and only refetched on demand, because they change
 * rarely; status is the document that has to be fresh. There is no write route at all, so nothing
 * this panel can do can change a download.
 */

window.__ModuleLoader__.load({
  id: "dsh-download",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")

    /** Required client service: the UI slot registry. */
    const inject = ["slots"]

    /** Short alias, so the element trees below stay readable without JSX. */
    const h = react.createElement

    /** The two read-only documents the host publishes for this panel. */
    const STATUS_URL = "/dsh-download/status.json"
    const SETTINGS_URL = "/dsh-download/settings.json"

    /** Refresh cadence: what the settings file suggests, and the bounds a UI may pick from. */
    const FALLBACK_INTERVAL_MS = 1000
    const MIN_INTERVAL_MS = 250
    const MAX_INTERVAL_MS = 60000

    /** Refresh choices offered in the header. Zero means "do not poll at all". */
    const INTERVAL_CHOICES = [1000, 2000, 5000, 0]

    /** Identifier for the injected stylesheet, also used to keep it from being added twice. */
    const CSS_TAG_ID = "dsh-download/panel.css"

    const CSS = `
.ndmdl-root{display:flex;flex-direction:column;gap:16px;width:100%;max-width:860px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.ndmdl-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ndmdl-head h3{margin:0;font-size:15px;font-weight:600}
.ndmdl-spacer{flex:1 1 auto}
.ndmdl-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ndmdl-stamp{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.ndmdl-btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:3px 10px}
.ndmdl-btn:hover{background:var(--dsw-alias-bg-layer-3)}
.ndmdl-interval{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ndmdl-interval select{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 6px}
.ndmdl-section{display:flex;flex-direction:column;gap:10px}
.ndmdl-sectionHead{display:flex;align-items:baseline;gap:7px;padding:0 2px}
.ndmdl-sectionHead h4{margin:0;font-size:13px;font-weight:600}
.ndmdl-count{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.ndmdl-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.ndmdl-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:7px}
.ndmdl-cardTop{display:flex;align-items:baseline;gap:10px}
.ndmdl-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}
.ndmdl-pct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;flex:0 0 auto}
.ndmdl-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ndmdl-bar i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary);transition:width .3s ease}
.ndmdl-bar[data-unknown=true] i{width:32%;animation:ndmdl-slide 1.4s ease-in-out infinite}
@keyframes ndmdl-slide{0%{transform:translateX(-110%)}100%{transform:translateX(330%)}}
.ndmdl-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;display:flex;flex-wrap:wrap}
.ndmdl-meta>span+span::before{content:"·";margin:0 6px}
.ndmdl-pathRow{display:flex;align-items:center;gap:8px}
.ndmdl-pathLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:0 0 auto}
.ndmdl-path{font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all;min-width:0;flex:1 1 auto}
.ndmdl-copy{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer;border-radius:6px;padding:1px 8px;flex:0 0 auto}
.ndmdl-state{flex:0 0 auto;width:14px;text-align:center;font-size:12px}
.ndmdl-state[data-state=completed]{color:var(--dsw-alias-state-success-primary,#2f9e44)}
.ndmdl-state[data-state=failed]{color:var(--dsw-alias-state-error-primary)}
.ndmdl-state[data-state=cancelled],.ndmdl-state[data-state=interrupted]{color:var(--dsw-alias-label-tertiary)}
.ndmdl-fail{color:var(--dsw-alias-state-error-primary);font-size:12px;border-left:2px solid var(--dsw-alias-state-error-primary);padding-left:8px;display:flex;flex-direction:column;gap:2px;word-break:break-word}
.ndmdl-hint{color:var(--dsw-alias-label-tertiary)}
.ndmdl-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:0}
.ndmdl-kvRow{display:contents}
.ndmdl-kv dt{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.ndmdl-kv dd{margin:0;font-size:12px;word-break:break-all}
.ndmdl-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.ndmdl-empty{color:var(--dsw-alias-label-tertiary);margin:0}
.ndmdl-error{border:1px solid var(--dsw-alias-state-error-primary);border-left-width:3px;border-radius:8px;padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px;display:flex;flex-direction:column;gap:3px}
.ndmdl-warn{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-label-tertiary);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ndmdl-fields{display:flex;flex-direction:column;gap:14px}
.ndmdl-field{display:flex;flex-direction:column;gap:5px}
.ndmdl-fieldLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ndmdl-field select,.ndmdl-field input{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;max-width:420px}
.ndmdl-field input{width:100%}
.ndmdl-choiceRow{display:flex;gap:8px;flex-wrap:wrap}
.ndmdl-btnOn{border-color:var(--dsw-alias-label-primary);font-weight:600}
.ndmdl-adv{margin:0}
.ndmdl-adv summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ndmdl-adv[open] summary{margin-bottom:8px}
`

    /** Add the stylesheet once, keyed so a client HMR reload cannot stack copies. */
    function injectStyles() {
      if (typeof document === "undefined") return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return
      const tag = document.createElement("style")
      tag.dataset.plugin = "dsh-download"
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Human-readable byte size. Duplicated from the host half on purpose: no shared module here. */
    /**
     * Parse a human-written size such as `1.5GB`, `800MB`, or a raw byte count.
     *
     * Accepts what a person would actually type, because "edit the settings file" was replaced by
     * a text box — and a text box that only takes bytes would be no better than the file.
     *
     * @param text - the typed value.
     * @returns whole bytes, or null when it cannot be understood.
     */
    function parseSize(text) {
      const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB|KB|T|G|M|K|B)?\s*$/i.exec(String(text ?? ""))
      if (match === null) return null
      const scale = { TB: 1099511627776, GB: 1073741824, MB: 1048576, KB: 1024, B: 1 }
      const unit = (match[2] ?? "B").toUpperCase()
      const factor = scale[unit] ?? scale[`${unit}B`] ?? null
      if (factor === null) return null
      const bytes = Math.round(Number(match[1]) * factor)
      return Number.isFinite(bytes) && bytes >= 1 ? bytes : null
    }

    function human(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "未知"
      const units = ["B", "KiB", "MiB", "GiB", "TiB"]
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
    }

    /** The filename part of a path, for the one line a person actually reads. */
    function baseName(path) {
      if (typeof path !== "string" || path === "") return ""
      const parts = path.split(/[\\/]/).filter((part) => part !== "")
      return parts.length === 0 ? "" : parts[parts.length - 1]
    }

    /** Local wall-clock time for an ISO string or an epoch-millisecond stamp. */
    function clock(value) {
      const date = typeof value === "number" ? new Date(value) : new Date(String(value ?? ""))
      if (Number.isNaN(date.getTime())) return ""
      return date.toLocaleTimeString("zh-CN", { hour12: false })
    }

    /** A compact elapsed/used duration between two stamps, using now as the end when absent. */
    function duration(fromStamp, toStamp) {
      const from = Date.parse(String(fromStamp ?? ""))
      const to = toStamp === undefined ? Date.now() : Date.parse(String(toStamp ?? ""))
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return ""
      const seconds = Math.round((to - from) / 1000)
      // Sub-second durations are noise, not information: "用时 0 秒" on a small file — or on a
      // transfer that never actually ran — tells a reader nothing they wanted to know.
      if (seconds < 1) return ""
      if (seconds < 60) return `${seconds} 秒`
      const minutes = Math.floor(seconds / 60)
      return `${minutes} 分 ${seconds % 60} 秒`
    }

    /** Which engine a row used, in words rather than in internal names. */
    function engineLabel(engine) {
      if (engine === "ndm") return "Neat Download Manager"
      if (engine === "built-in") return "内置引擎"
      if (engine === "direct") return "直连"
      if (engine === "builtin") return "内置引擎"
      return String(engine ?? "未知")
    }

    /** How a finished transfer was carried out, when the host recorded it. */
    function methodLabel(method) {
      if (method === "segmented") return "分段下载"
      if (method === "single-stream") return "单流下载"
      if (method === "direct") return "直连下载"
      if (method === "ndm") return "NDM 任务"
      return null
    }

    /** One terminal state's short label and glyph. */
    function stateDisplay(state) {
      if (state === "completed") return { glyph: "✓", label: "完成" }
      if (state === "cancelled") return { glyph: "⊘", label: "已取消" }
      if (state === "interrupted") return { glyph: "⚠", label: "被中断" }
      return { glyph: "✕", label: "失败" }
    }

    /** Clamp an interval to something a browser and a disk can both live with. */
    function clampInterval(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return 0
      return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(number)))
    }

    /**
     * Whether this panel is currently being looked at.
     *
     * A visited Settings tab stays mounted with `hidden` set, so mount state cannot answer this —
     * and a timer that keeps running while the tab is closed is exactly the kind of background
     * noise this plugin is supposed to avoid. An IntersectionObserver reports `false` for an
     * element with `display:none`, which is precisely the signal needed, and the document's own
     * visibility covers the case where the whole browser tab is in the background.
     *
     * @param ref - ref to the panel's root element.
     * @returns true while the panel is both displayed and in a visible document.
     */
    function usePanelVisible(ref) {
      const [visible, setVisible] = react.useState(false)

      react.useEffect(() => {
        const node = ref.current
        if (node === null || node === undefined) return undefined

        let onScreen = false
        const sync = () => {
          setVisible(onScreen && document.visibilityState !== "hidden")
        }

        let observer = null
        if (typeof IntersectionObserver === "function") {
          observer = new IntersectionObserver((records) => {
            for (const record of records) onScreen = record.isIntersecting
            sync()
          })
          observer.observe(node)
        } else {
          // No observer (an unusual embed): fall back to the document signal alone rather than
          // never polling, because a panel that shows nothing is worse than a cheap request.
          onScreen = true
          sync()
        }

        document.addEventListener("visibilitychange", sync)
        sync()
        return () => {
          if (observer !== null) observer.disconnect()
          document.removeEventListener("visibilitychange", sync)
        }
      }, [ref])

      return visible
    }

    /**
     * Poll the host while the panel is on screen.
     *
     * Status is refetched every tick; settings are fetched once and kept, because they are a
     * document that changes when a person edits a file, not a running total. The configured
     * interval is read through a ref so that changing it takes effect on the next tick instead of
     * tearing the loop down and starting a second request in flight.
     *
     * @param visible - whether the panel is being looked at.
     * @param overrideMs - a session-only interval chosen in the header, or null to use the setting.
     * @returns the two documents, the last failure, a timestamp, and a manual refresh trigger.
     */
    function useDownloadFeed(visible, overrideMs) {
      const [state, setState] = react.useState({ status: null, settings: null, error: null, at: null })
      const [nonce, setNonce] = react.useState(0)
      const settingsRef = react.useRef(null)
      const intervalRef = react.useRef(FALLBACK_INTERVAL_MS)

      intervalRef.current = clampInterval(
        overrideMs === null || overrideMs === undefined
          ? state.settings?.uiPollIntervalMs ?? FALLBACK_INTERVAL_MS
          : overrideMs,
      )

      react.useEffect(() => {
        if (!visible) return undefined
        let cancelled = false
        let timer

        const tick = async () => {
          try {
            const statusResponse = await fetch(STATUS_URL, {
              cache: "no-store",
              headers: { accept: "application/json" },
            })
            if (!statusResponse.ok) throw new Error(`状态接口返回 HTTP ${statusResponse.status}`)
            const statusDocument = await statusResponse.json()

            let settingsDocument = settingsRef.current
            if (settingsDocument === null) {
              const settingsResponse = await fetch(SETTINGS_URL, {
                cache: "no-store",
                headers: { accept: "application/json" },
              })
              if (!settingsResponse.ok) throw new Error(`设置接口返回 HTTP ${settingsResponse.status}`)
              settingsDocument = await settingsResponse.json()
              settingsRef.current = settingsDocument
            }

            if (cancelled) return
            setState({ status: statusDocument, settings: settingsDocument, error: null, at: Date.now() })
          } catch (error) {
            if (cancelled) return
            setState((previous) => ({
              ...previous,
              error: error instanceof Error ? error.message : String(error),
              at: Date.now(),
            }))
          }
          // Zero means "paused": the manual refresh button is then the only way to reload.
          if (!cancelled && intervalRef.current > 0) timer = setTimeout(tick, intervalRef.current)
        }

        tick()
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [visible, nonce])

      const refresh = react.useCallback(() => {
        // Drop the cached settings too: a refresh is the moment a settings edit should show up.
        settingsRef.current = null
        setNonce((value) => value + 1)
      }, [])

      return { ...state, refresh }
    }

    /** A one-line copy control: a path is the thing people actually need out of this panel. */
    function CopyPath(props) {
      const [copied, setCopied] = react.useState(false)

      const copy = () => {
        const done = () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }
        try {
          const result = navigator.clipboard?.writeText(props.value)
          if (result !== undefined && typeof result.then === "function") result.then(done, () => {})
          else done()
        } catch {
          /* a clipboard that refuses is a convenience lost, never an error worth showing */
        }
      }

      return h(
        "button",
        { type: "button", className: "ndmdl-copy", title: `复制路径：${props.value}`, onClick: copy },
        copied ? "已复制" : "复制路径",
      )
    }

    /** A progress bar that admits when the total is unknown instead of drawing a fake one. */
    function ProgressBar(props) {
      const percent = props.percent
      const known = typeof percent === "number" && Number.isFinite(percent)
      const clamped = known ? Math.max(0, Math.min(100, percent)) : 0
      return h(
        "div",
        {
          className: "ndmdl-bar",
          "data-unknown": known ? undefined : "true",
          role: "progressbar",
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": known ? Math.round(clamped) : undefined,
          "aria-valuetext": known ? `${clamped.toFixed(1)}%` : "总大小未知",
        },
        h("i", { style: known ? { width: `${clamped}%` } : undefined }),
      )
    }

    /** One in-flight download. */
    function ActiveCard(props) {
      const entry = props.entry
      const total = typeof entry.total === "number" && entry.total > 0 ? entry.total : null
      const facts = []
      facts.push(total === null ? `${human(entry.bytes)}(总大小未知)` : `${human(entry.bytes)} / ${human(total)}`)
      if (typeof entry.speedBps === "number" && entry.speedBps > 0) facts.push(`${human(entry.speedBps)}/s`)
      facts.push(engineLabel(entry.engine))
      if (typeof entry.connections === "number" && entry.connections > 0) facts.push(`${entry.connections} 连接`)
      const used = duration(entry.startedAt)
      if (used !== "") facts.push(`已用 ${used}`)

      return h(
        "li",
        { className: "ndmdl-card" },
        h(
          "div",
          { className: "ndmdl-cardTop" },
          h("strong", { className: "ndmdl-name", title: entry.url }, baseName(entry.dest) || baseName(entry.url) || "下载"),
          h("span", { className: "ndmdl-pct" }, total === null ? "" : `${(entry.percent ?? 0).toFixed(1)}%`),
        ),
        h(ProgressBar, { percent: entry.percent }),
        h("div", { className: "ndmdl-meta" }, facts.map((fact) => h("span", { key: fact }, fact))),
        entry.dest === undefined || entry.dest === ""
          ? null
          : h(
              "div",
              { className: "ndmdl-pathRow" },
              h("span", { className: "ndmdl-pathLabel" }, "写入到"),
              h("code", { className: "ndmdl-path", title: entry.dest }, entry.dest),
              h(CopyPath, { value: entry.dest }),
            ),
      )
    }

    /** One finished download, however it ended. */
    function RecentCard(props) {
      const entry = props.entry
      const display = stateDisplay(entry.state)

      // The one state whose message the panel writes itself: `interrupted` is the host's own
      // bookkeeping about a restart, not an engine's or a server's words about a failure. A real
      // failure is never paraphrased — the reason and the hint are shown exactly as recorded,
      // because they are the only account of what the far end actually said.
      const detail =
        entry.state === "interrupted"
          ? {
              error: "下载在 dsh 重启时中断,文件没有完成。",
              hint: "重新调用 download_file 即可;不会留下半成品文件。",
            }
          : { error: entry.error, hint: entry.hint }

      const facts = []
      if (typeof entry.bytes === "number" && entry.bytes > 0) facts.push(human(entry.bytes))
      facts.push(engineLabel(entry.engine))
      if (typeof entry.connections === "number" && entry.connections > 0) facts.push(`${entry.connections} 连接`)
      const method = methodLabel(entry.method)
      if (method !== null) facts.push(method)
      const used = duration(entry.startedAt, entry.finishedAt)
      if (used !== "") facts.push(`用时 ${used}`)
      const when = clock(entry.finishedAt ?? entry.updatedAt)
      if (when !== "") facts.push(when)

      return h(
        "li",
        { className: "ndmdl-card" },
        h(
          "div",
          { className: "ndmdl-cardTop" },
          h(
            "span",
            {
              className: "ndmdl-state",
              "data-state": entry.state,
              role: "img",
              "aria-label": display.label,
              title: display.label,
            },
            display.glyph,
          ),
          h("strong", { className: "ndmdl-name", title: entry.url }, baseName(entry.dest) || baseName(entry.url) || "下载"),
          h("span", { className: "ndmdl-pct" }, display.label),
        ),
        h("div", { className: "ndmdl-meta" }, facts.map((fact) => h("span", { key: fact }, fact))),
        entry.dest === undefined || entry.dest === ""
          ? null
          : h(
              "div",
              { className: "ndmdl-pathRow" },
              h(
                "span",
                { className: "ndmdl-pathLabel" },
                entry.state === "completed" ? "已保存" : "目标位置",
              ),
              h("code", { className: "ndmdl-path", title: entry.dest }, entry.dest),
              // The copy button is offered only where the file actually is. Handing someone the
              // path of a download that never finished would send them to an empty location.
              entry.state === "completed" ? h(CopyPath, { value: entry.dest }) : null,
            ),
        detail.error === undefined || detail.error === null || detail.error === ""
          ? null
          : h(
              "div",
              { className: "ndmdl-fail" },
              h("span", null, detail.error),
              detail.hint === undefined || detail.hint === null || detail.hint === ""
                ? null
                : h("span", { className: "ndmdl-hint" }, entry.hint),
            ),
      )
    }

    /** A titled group, with an optional count so an empty one is visibly empty. */
    function Section(props) {
      return h(
        "section",
        { className: "ndmdl-section" },
        h(
          "div",
          { className: "ndmdl-sectionHead" },
          h("h4", null, props.title),
          props.count === undefined ? null : h("span", { className: "ndmdl-count" }, props.count),
        ),
        props.children,
      )
    }

    /** Where a settings change is sent. Must match SETTINGS_WRITE_PATH in ui-routes.js. */
    const SETTINGS_WRITE_URL = "/dsh-download/settings"

    /**
     * POST one settings change to the host.
     *
     * `credentials: "same-origin"` and the browser's automatic `Origin` header are what let the
     * host tell this panel apart from some other page open in the same browser; the host refuses
     * anything that fails that check.
     *
     * @param patch - the keys to change.
     * @returns whether it was applied, and why not when it was not.
     */
    async function postSettings(patch) {
      try {
        const response = await fetch(SETTINGS_WRITE_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(patch),
        })
        const payload = await response.json().catch(() => null)
        if (response.ok !== true || payload?.ok !== true) {
          const rejected = Array.isArray(payload?.rejected) && payload.rejected.length > 0
            ? ` ${payload.rejected.map((item) => item.key).join(", ")} 被拒绝`
            : ""
          return { ok: false, error: `${payload?.error ?? `HTTP ${response.status}`}${rejected}` }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) }
      }
    }

    /** A select with a label, used for every enumerated setting. */
    function Choice(props) {
      return h(
        "label",
        { className: "ndmdl-field" },
        h("span", { className: "ndmdl-fieldLabel" }, props.label),
        h(
          "select",
          {
            value: String(props.value),
            disabled: props.disabled === true,
            onChange: (event) => props.onChange(event.currentTarget.value),
          },
          props.options.map(([value, text]) => h("option", { key: String(value), value: String(value) }, text)),
        ),
      )
    }

    /** A text input that saves on blur or Enter, so typing does not fire a write per keystroke. */
    function PathField(props) {
      const [text, setText] = react.useState(props.value ?? "")
      react.useEffect(() => setText(props.value ?? ""), [props.value])
      const commit = () => {
        if ((props.value ?? "") !== text) props.onCommit(text)
      }
      return h(
        "label",
        { className: "ndmdl-field" },
        h("span", { className: "ndmdl-fieldLabel" }, props.label),
        h("input", {
          type: "text",
          value: text,
          spellCheck: false,
          placeholder: props.placeholder,
          onChange: (event) => setText(event.currentTarget.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur()
            } else if (event.key === "Escape") {
              setText(props.value ?? "")
              event.currentTarget.blur()
            }
          },
        }),
      )
    }

    /** Byte thresholds offered as one-click choices, plus a custom entry. */
    const THRESHOLD_CHOICES = [
      [1073741824, "1 GB(默认)"],
      [104857600, "100 MB"],
      [524288000, "500 MB"],
      [2147483648, "2 GB"],
      [4294967296, "4 GB"],
      [10737418240, "10 GB"],
      [1, "所有下载都走分段"],
      [1099511627776, "完全不用 NDM(全部直连)"],
    ]

    /**
     * The settings, each one editable and saved the moment it changes.
     *
     * This replaced a read-only list. The list was honest but useless as a settings UI: the
     * people who most need to change the threshold are exactly the people who will never open
     * `dsh-download.settings.json`, so pointing them at the file is the same as having no
     * setting at all. Every control here writes through the host's validated endpoint.
     */
    function SettingsList(props) {
      const settings = props.settings
      const [status, setStatus] = react.useState(null)
      const [customOpen, setCustomOpen] = react.useState(false)

      if (settings === null || settings === undefined) {
        return h("p", { className: "ndmdl-empty" }, "正在读取设置…")
      }

      const apply = async (patch, label) => {
        setStatus({ kind: "busy", text: `正在保存:${label}` })
        const result = await postSettings(patch)
        setStatus(
          result.ok
            ? { kind: "ok", text: `${label} 已保存,下次下载立即生效` }
            : { kind: "err", text: `${label} 保存失败:${result.error}` },
        )
      }

      const seconds = (ms) => `${Math.round(ms / 1000)} 秒`
      const minutes = (ms) => `${Math.round(ms / 60000)} 分钟`

      return h(
        "div",
        { className: "ndmdl-section" },
        settings.problem === null || settings.problem === undefined
          ? null
          : h("div", { className: "ndmdl-warn", role: "alert" }, `设置文件读取有问题：${settings.problem}`),

        h("p", { className: "ndmdl-note" }, "改完立即生效,不用重启,也不用去动任何文件。"),

        h(
          "div",
          { className: "ndmdl-fields" },

          h(
            "div",
            { className: "ndmdl-field" },
            h("span", { className: "ndmdl-fieldLabel" }, "下载引擎"),
            h(
              "div",
              { className: "ndmdl-choiceRow" },
              [
                ["builtin", "内置引擎", "不用装任何软件;自己决定 UA,国内镜像可直连;直接写到目标位置。实测 4.44GB 用 4 线程 75 秒。"],
                ["ndm", "Neat Download Manager", "久经考验,有进度窗口可以看着下。代价:需要安装,总是先下到自己目录再搬运,UA 可能被部分镜像拒绝。"],
              ].map(([value, title, hint]) =>
                h(
                  "button",
                  {
                    key: value,
                    type: "button",
                    className: settings.engine === value ? "ndmdl-btn ndmdl-btnOn" : "ndmdl-btn",
                    title: hint,
                    onClick: () => apply({ engine: value }, "下载引擎"),
                  },
                  title,
                ),
              ),
            ),
            h(
              "span",
              { className: "ndmdl-note" },
              settings.engine === "ndm"
                ? "NDM:需要安装该软件;它总是先下到保存目录,再由插件搬运到目标位置。"
                : "内置引擎:无需安装,直接写入目标位置,并且能连上封禁浏览器 UA 的镜像源。",
            ),
          ),

          h(Choice, {
            label: "多大的文件才走分段下载",
            value: THRESHOLD_CHOICES.some(([value]) => value === settings.thresholdBytes) ? settings.thresholdBytes : "custom",
            options: [
              ...THRESHOLD_CHOICES.map(([value, text]) => [value, text]),
              ["custom", "自定义…"],
            ],
            onChange: (value) => {
              if (value === "custom") {
                setCustomOpen(true)
                return
              }
              setCustomOpen(false)
              apply({ thresholdBytes: Number(value) }, "路由阈值")
            },
          }),

          customOpen
            ? h(PathField, {
                label: "自定义阈值(可写 1.5GB / 800MB / 字节数)",
                value: "",
                placeholder: "例如 1.5GB",
                onCommit: (text) => {
                  const bytes = parseSize(text)
                  if (bytes === null) {
                    setStatus({ kind: "err", text: `看不懂这个大小:${text}` })
                    return
                  }
                  apply({ thresholdBytes: bytes }, "路由阈值")
                  setCustomOpen(false)
                },
              })
            : null,

          h(Choice, {
            label: "并行连接数(内置引擎)",
            value: settings.builtinConnections,
            options: [1, 2, 4, 8, 16, 32].map((n) => [n, `${n} 连接${n === 16 ? "(默认)" : ""}`]),
            onChange: (value) => apply({ builtinConnections: Number(value) }, "并行连接数"),
          }),

          h(Choice, {
            label: "下载时是否等待",
            value: settings.monitor,
            options: [
              ["block", "等待完成并返回结果(默认)"],
              ["none", "交给 NDM 后立即返回,不等待"],
            ],
            onChange: (value) => apply({ monitor: value }, "监视模式"),
          }),
          settings.monitor === "none"
            ? h(
                "span",
                { className: "ndmdl-note" },
                "不等待时代价是:插件无法知道下载成功还是失败,也无法清理垃圾文件。指定了目标位置时仍会强制等待。",
              )
            : null,

          h(Choice, {
            label: "NDM 轮询间隔",
            value: settings.pollIntervalMs,
            options: [1000, 1500, 3000, 5000].map((n) => [n, `${n} 毫秒${n === 1500 ? "(默认)" : ""}`]),
            onChange: (value) => apply({ pollIntervalMs: Number(value) }, "轮询间隔"),
          }),

          h(Choice, {
            label: "面板刷新间隔",
            value: settings.uiPollIntervalMs,
            options: [1000, 2000, 5000, 0].map((n) => [n, n === 0 ? "不自动刷新(手动)" : `${n / 1000} 秒`]),
            onChange: (value) => apply({ uiPollIntervalMs: Number(value) }, "面板刷新间隔"),
          }),

          h(PathField, {
            label: "完成文件保存目录",
            value: settings.downloadDir ?? "",
            placeholder: "留空 = 用系统下载目录",
            onCommit: (text) => apply({ downloadDir: text }, "保存目录"),
          }),
          h(PathField, {
            label: "NeatDM.exe 路径",
            value: settings.ndmPath ?? "",
            placeholder: "留空 = 自动探测",
            onCommit: (text) => apply({ ndmPath: text }, "NDM 路径"),
          }),
          h(PathField, {
            label: "NDM 任务目录",
            value: settings.taskRoot ?? "",
            placeholder: "留空 = 用 NDM 自己的设置",
            onCommit: (text) => apply({ taskRoot: text }, "任务目录"),
          }),
        ),

        status === null || status === undefined
          ? null
          : h(
              "div",
              { className: status.kind === "err" ? "ndmdl-warn" : "ndmdl-note", role: "status" },
              status.text,
            ),

        h(
          "details",
          { className: "ndmdl-adv" },
          h("summary", null, "高级参数(一般不用动)"),
          h(
            "dl",
            { className: "ndmdl-kv" },
            [
              ["停滞超时", minutes(settings.stallTimeoutMs)],
              ["任务建立超时", seconds(settings.taskAppearTimeoutMs)],
              ["完成稳定等待", seconds(settings.settleMs)],
              ["设置文件", settings.settingsPath ?? "未知"],
            ].map(([label, value]) =>
              h(
                "div",
                { className: "ndmdl-kvRow", key: label },
                h("dt", null, label),
                h("dd", { title: String(value) }, String(value)),
              ),
            ),
          ),
        ),
      )
    }

    /** Refresh cadence choices, including whatever the settings file currently says. */
    function intervalOptions(current) {
      const values = INTERVAL_CHOICES.filter((value) => value !== 0)
      if (current > 0 && !values.includes(current)) values.push(current)
      values.sort((left, right) => left - right)
      return [...values, 0]
    }

    /** The panel. */
    function DownloadPanel() {
      const rootRef = react.useRef(null)
      const visible = usePanelVisible(rootRef)
      const [override, setOverride] = react.useState(null)
      const feed = useDownloadFeed(visible, override)

      const active = Array.isArray(feed.status?.active) ? feed.status.active : []
      const recent = Array.isArray(feed.status?.recent) ? feed.status.recent : []
      const configured = Number(feed.settings?.uiPollIntervalMs)
      const currentInterval =
        override ?? (Number.isFinite(configured) && configured > 0 ? clampInterval(configured) : FALLBACK_INTERVAL_MS)

      const head = h(
        "div",
        { className: "ndmdl-head" },
        h("h3", null, "下载任务"),
        feed.settings === null || feed.settings === undefined
          ? null
          : h("span", { className: "ndmdl-badge" }, `引擎：${engineLabel(feed.settings.engine)}`),
        h("span", { className: "ndmdl-spacer" }),
        h(
          "label",
          { className: "ndmdl-interval" },
          "刷新",
          h(
            "select",
            {
              value: String(currentInterval),
              onChange: (event) => setOverride(Number(event.currentTarget.value)),
              "aria-label": "面板刷新间隔",
            },
            intervalOptions(currentInterval).map((value) =>
              h(
                "option",
                { key: value, value: String(value) },
                value === 0 ? "暂停" : value % 1000 === 0 ? `${value / 1000} 秒` : `${value} 毫秒`,
              ),
            ),
          ),
        ),
        h("button", { type: "button", className: "ndmdl-btn", onClick: feed.refresh }, "立即刷新"),
        feed.at === null ? null : h("span", { className: "ndmdl-stamp" }, `更新于 ${clock(feed.at)}`),
      )

      const error = feed.error
        ? h(
            "div",
            { className: "ndmdl-error", role: "alert" },
            h("span", null, `无法读取下载状态：${feed.error}`),
            h(
              "span",
              { className: "ndmdl-hint" },
              "面板路由由插件在宿主启动时注册;如果你刚刚更新过插件,重启 dsh 后即可。下载工具本身不受影响。",
            ),
          )
        : null

      return h(
        "div",
        { className: "ndmdl-root", ref: rootRef, "data-polling": visible && currentInterval > 0 ? "true" : "false" },
        head,
        error,
        h(
          Section,
          { title: "进行中", count: active.length },
          active.length === 0
            ? h("p", { className: "ndmdl-empty" }, "当前没有正在下载的文件。")
            : h("ul", { className: "ndmdl-list" }, active.map((entry) => h(ActiveCard, { key: entry.id, entry }))),
        ),
        h(
          Section,
          { title: "最近", count: recent.length },
          recent.length === 0
            ? h("p", { className: "ndmdl-empty" }, "还没有下载记录。")
            : h("ul", { className: "ndmdl-list" }, recent.map((entry) => h(RecentCard, { key: entry.id, entry }))),
        ),
        h(Section, { title: "设置" }, h(SettingsList, { settings: feed.settings })),
      )
    }

    /**
     * Register the download tab.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      injectStyles()
      ctx.slots.inject("settings.plugins.tab", () =>
        ctx.slots.register(
          {
            name: "settings.plugins.tab",
            id: "dsh-download",
            order: 20,
            label: () => "下载",
          },
          DownloadPanel,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
