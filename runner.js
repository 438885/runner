(async () => {
  //#region 1: ExternalDependencies
  {
    const s = Object.assign(document.createElement("script"), { src: "./coi-sw.min.js" });
    window.coi = document.coi = {
      quiet: !1,
      ...window.coi,
      ...document.coi,
      ready: new Promise(r => {
        s.onload = () => r(window.coi.ready),
        s.onerror = () => r(!1)
      })
    }, document.head.appendChild(s)
  };

  const { fflate, esbuild, Comlink } = await (async () => {
    await new Promise((resolve, reject) => {
      if (document.querySelector('script[src*="@tailwindcss/browser"]')) return resolve();
      const s = document.createElement("script");
      s.src = "https://unpkg.com/@tailwindcss/browser@4";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load Tailwind v4 from unpkg"));
      document.head.appendChild(s);
    });

    const [fflateMod, rawEsbuildMod, comlinkMod] = await Promise.all([
      import("https://esm.sh/fflate@0.8.3"),
      import("https://esm.sh/esbuild-wasm@0.28.2/esm/browser.min.js"),
      import("https://cdn.jsdelivr.net/npm/comlink@4.4.2/+esm")
    ]);

    const esbuild = rawEsbuildMod.initialize ? rawEsbuildMod : rawEsbuildMod.default;
    return { fflate: fflateMod, esbuild, Comlink: comlinkMod };
  })();
  //#endregion

  //#region 2: DOMAndStylesManager
  const DOM = (() => {
    const SANDBOX_ATTR = "allow-scripts allow-modals allow-forms allow-popups allow-same-origin";
    
    const twStyle = document.createElement("style");
    twStyle.setAttribute("type", "text/tailwindcss");
    twStyle.textContent = `@import "tailwindcss";`;
    document.head.appendChild(twStyle);

    document.body.className = "bg-zinc-950 text-zinc-100 min-h-screen font-sans antialiased overflow-x-hidden";

    const btnBase = "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition active:scale-95 disabled:opacity-40 disabled:pointer-events-none cursor-pointer whitespace-nowrap";
    const btnSec = `${btnBase} border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white`;
    const btnPri = `${btnBase} border-blue-500 bg-blue-600 text-white hover:bg-blue-500 shadow-sm`;
    const btnDanger = `${btnBase} border-red-500 bg-red-600 text-white hover:bg-red-500 shadow-sm`;

    const html = `
      <div id="mainDashboard" class="max-w-3xl mx-auto my-12 p-6 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl flex flex-col gap-5">
        <div class="flex items-center justify-between border-b border-zinc-800 pb-4">
          <h3 class="text-lg font-bold text-zinc-100 tracking-tight">TypeScript & Python Runner</h3>
          <span class="text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded">Tailwind v4 JIT</span>
        </div>

        <div class="p-5 border border-zinc-700/80 rounded-lg bg-zinc-800/50 flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <label for="builtinSelect" class="text-sm font-medium text-zinc-200">
              📦 Select Built-in or Loaded Project (HTML, JS, TS, Python):
            </label>
            <button id="refreshBuiltinBtn" class="${btnSec}" title="Rescan built-in folders & URLs">↻ Refresh</button>
          </div>
          <div class="flex gap-2">
            <select id="builtinSelect" class="flex-1 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs rounded-md px-3 py-2 outline-none focus:border-blue-500 cursor-pointer disabled:opacity-40">
              <option value="">Scanning built-in projects...</option>
            </select>
            <button id="loadBuiltinBtn" class="${btnPri}" disabled>▶ Run Selected</button>
          </div>
        </div>

        <div class="p-5 border-2 border-dashed border-zinc-700 hover:border-indigo-500 rounded-lg bg-zinc-800/40 transition">
          <label class="text-sm font-medium text-zinc-300 block cursor-pointer">
            Upload Files (.ts, .tsx, .js, .py, .css, .html, assets, .zip):
            <input id="fileInput" type="file" multiple class="mt-2 block w-full text-xs text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-zinc-700 file:bg-zinc-800 file:text-zinc-200 file:text-xs file:cursor-pointer hover:file:bg-zinc-700" />
          </label>
        </div>
        <div class="p-5 border-2 border-dashed border-zinc-700 hover:border-indigo-500 rounded-lg bg-zinc-800/40 transition">
          <label class="text-sm font-medium text-zinc-300 block cursor-pointer">
            Or Upload Entire Project Directory:
            <input id="folderInput" type="file" webkitdirectory directory multiple class="mt-2 block w-full text-xs text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-zinc-700 file:bg-zinc-800 file:text-zinc-200 file:text-xs file:cursor-pointer hover:file:bg-zinc-700" />
          </label>
        </div>
        <div class="pt-2 flex justify-end">
          <button id="viewActiveBtn" class="${btnSec} hidden">⤢ Reopen Full Viewport</button>
        </div>
      </div>

      <div id="runnerViewport" class="hidden fixed inset-0 w-screen h-screen z-50 bg-black flex-col">
        <header id="topbar" class="relative h-11 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-3 gap-2 shrink-0 select-none z-50">
          <div class="flex items-center gap-2">
            <button id="backBtn" class="${btnSec}" title="Back to uploads & project selector">📁 Projects</button>
            <span class="text-xs font-semibold text-zinc-400">Script:</span>
            <select id="entrySelect" disabled class="max-w-xs bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-md px-2.5 py-1 outline-none focus:border-blue-500 cursor-pointer disabled:opacity-40">
              <option>Loading projects...</option>
            </select>
            <button id="runBtn" class="${btnPri}" disabled>▶ Run</button>
            <button id="stopBtn" class="${btnDanger}" disabled>⏹ Stop</button>
          </div>
          <div class="flex items-center gap-2">
            <button id="downloadBtn" class="${btnSec}" disabled>💾 Export HTML</button>
            <button id="toggleLogsBtn" class="${btnSec}">📋 Console</button>
            <button id="fullscreenBtn" class="${btnSec}">⛶ Fullscreen</button>
          </div>
        </header>

        <main id="runnerArea" class="flex-1 w-full h-[calc(100vh-44px)] relative bg-black overflow-hidden">
          <iframe id="sandbox" class="w-full h-full border-0 block bg-white" sandbox="${SANDBOX_ATTR}"></iframe>
          <div id="canvasContainer" class="w-full h-full hidden bg-black"></div>
        </main>

        <div id="logsDrawer" class="absolute bottom-0 inset-x-0 h-64 bg-zinc-950/95 backdrop-blur-md border-t border-zinc-800 flex flex-col transition-transform duration-200 translate-y-full z-40">
          <div class="h-8 px-3 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between text-xs text-zinc-300">
            <span class="font-semibold text-zinc-400">Console / Runtime Logs</span>
            <div class="flex gap-1.5">
              <button id="clearBtn" class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700">Clear</button>
              <button id="closeLogsBtn" class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700">✕ Close</button>
            </div>
          </div>
          <pre id="logs" class="flex-1 p-3 font-mono text-xs text-zinc-300 overflow-auto whitespace-pre-wrap break-all leading-relaxed">Waiting for selection or files...</pre>
        </div>
      </div>
    `;

    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    while (wrapper.firstChild) document.body.appendChild(wrapper.firstChild);

    const $ = (id) => document.getElementById(id);
    const refs = {
      fileInput: $("fileInput"), folderInput: $("folderInput"), entrySelect: $("entrySelect"),
      builtinSelect: $("builtinSelect"), loadBuiltinBtn: $("loadBuiltinBtn"), refreshBuiltinBtn: $("refreshBuiltinBtn"),
      runBtn: $("runBtn"), stopBtn: $("stopBtn"), downloadBtn: $("downloadBtn"), clearBtn: $("clearBtn"),
      sandbox: $("sandbox"), canvasContainer: $("canvasContainer"), logsEl: $("logs"),
      runnerViewport: $("runnerViewport"), mainDashboard: $("mainDashboard"), backBtn: $("backBtn"),
      viewActiveBtn: $("viewActiveBtn"), fullscreenBtn: $("fullscreenBtn"), toggleLogsBtn: $("toggleLogsBtn"),
      logsDrawer: $("logsDrawer"), closeLogsBtn: $("closeLogsBtn"),
      resetSandbox() {
        const fresh = document.createElement("iframe");
        fresh.id = "sandbox";
        fresh.className = refs.sandbox.className;
        fresh.setAttribute("sandbox", SANDBOX_ATTR);
        refs.sandbox.replaceWith(fresh);
        refs.sandbox = fresh;
        return fresh;
      }
    };
    return refs;
  })();
  //#endregion

  //#region 3: LoggingAndConsoleManager
  const Logger = (() => {
    let logBuf = [], raf = null;

    const ts = () => {
      const d = new Date();
      return d.toTimeString().split(" ")[0] + "." + String(d.getMilliseconds()).padStart(3, "0");
    };

    const formatVal = (v, seen = new WeakSet()) => {
      if (v === null) return "null";
      if (v === undefined) return "undefined";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
      if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
      if (typeof v === "function") return `[Function: ${v.name || "anonymous"}]`;
      if (typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
        try {
          return JSON.stringify(v, (_, val) => {
            if (typeof val === "bigint") return `${val}n`;
            if (typeof val === "symbol") return String(val);
            if (typeof val === "function") return `[Function: ${val.name || "anonymous"}]`;
            if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
            if (val instanceof Map) return { __type: "Map", entries: [...val.entries()] };
            if (val instanceof Set) return { __type: "Set", values: [...val.values()] };
            if (val instanceof RegExp) return val.toString();
            if (typeof val === "object" && val !== null) {
              if (seen.has(val) && val !== v) return "[Circular]";
              seen.add(val);
            }
            return val;
          });
        } catch {
          return Object.prototype.toString.call(v);
        }
      }
      return String(v);
    };

    const flush = () => {
      if (!logBuf.length) return;
      const comb = DOM.logsEl.textContent + logBuf.join("\n") + "\n";
      DOM.logsEl.textContent = comb.length > 250000 ? "...[truncated]...\n" + comb.slice(-250000) : comb;
      logBuf = [];
      raf = null;
      DOM.logsEl.scrollTop = DOM.logsEl.scrollHeight;
    };

    const log = (m, level = "") => {
      const raw = String(m ?? "").replace(/\n$/, "");
      if (!raw) return;
      const hasBracket = /^\[[A-Z0-9_:-]+\]/i.test(raw);
      const tag = level ? `[${level.toUpperCase()}] ` : hasBracket ? "" : "[SYS] ";
      const prefix = `[${ts()}] ${tag}`;
      const indent = " ".repeat(prefix.length);
      const lines = raw.split("\n").map((line, i) => (i === 0 ? `${prefix}${line}` : `${indent}${line}`));
      logBuf.push(lines.join("\n"));
      raf = raf || requestAnimationFrame(flush);
    };

    const clear = () => {
      logBuf = [];
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      DOM.logsEl.textContent = "";
    };

    window.addEventListener("message", ({ data }) => {
      if (data?.type === "SANDBOX_LOG") {
        const lvl = String(data.level || "LOG").toUpperCase();
        const msgs = Array.isArray(data.messages) ? data.messages.map((x) => formatVal(x)) : [formatVal(data.messages ?? "")];
        log(msgs.join(" "), lvl);
      }
    });

    window.addEventListener("error", (e) => {
      if (e.target && e.target !== window) {
        const el = e.target;
        const src = el.src || el.href || "";
        if (src) log(`Host resource failed to load: <${el.tagName?.toLowerCase() || "asset"}> ${src}`, "HOST_WARN");
        return;
      }
      const loc = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
      log(`Host Uncaught Error: ${e.message || e}${loc}${e.error?.stack ? "\n" + e.error.stack : ""}`, "HOST_ERR");
    }, true);

    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason;
      log(`Host Unhandled Promise Rejection: ${r?.stack || r?.message || formatVal(r)}`, "HOST_ERR");
    });

    return { log, flush, clear, formatVal };
  })();
  //#endregion

  //#region 4: FileSystemAndPathUtilities
  const FSUtils = (() => {
    const IGNORED = /(?:^|\/)(?:node_modules|\.git|dist|build|\.next|coverage|out|\.vscode|__pycache__|__MACOSX)\//i;
    const TEXT_EXTS = /\.(?:py|txt|csv|json|html?|xml|md|sql|[jt]sx?|mjs|cjs|qjs|css|svg)$/i;
    const RUNNABLE_EXTS = /\.(?:py|html?|[jt]sx?|mjs|cjs|zip)$/i;
    const EXTS = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".css", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
    const MIME = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
      ico: "image/x-icon", avif: "image/avif", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
      otf: "font/otf", wasm: "application/wasm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
      mp4: "video/mp4", webm: "video/webm"
    };

    const isPy = (n = "") => /\.py$/i.test(n);
    const isHtml = (n = "") => /\.html?$/i.test(n);
    const isTsOrJs = (n = "") => /\.(?:[jt]sx?|mjs|cjs)$/i.test(n);
    const isZip = (n = "") => /\.zip$/i.test(n);
    const isRunnable = (n = "") => RUNNABLE_EXTS.test(n);
    const toStr = (c) => (typeof c === "string" ? c : new TextDecoder().decode(c));

    const detectLangLabel = (name = "") => {
      const n = name.toLowerCase();
      if (n.endsWith(".py")) return "Python";
      if (n.endsWith(".ts") || n.endsWith(".tsx")) return "TypeScript";
      if (n.endsWith(".js") || n.endsWith(".jsx") || n.endsWith(".mjs")) return "JavaScript";
      if (n.endsWith(".html") || n.endsWith(".htm")) return "HTML";
      if (n.endsWith(".zip")) return "Archive";
      return "Project";
    };

    const sanitizePath = (p = "") => {
      p = p.replace(/\\/g, "/").replace(/^\/+/, "");
      if (!p || IGNORED.test(p)) return "";
      const out = [];
      for (const x of p.split("/")) {
        if (!x || x === ".") continue;
        if (x === ".." || x === ".DS_Store" || x === "__MACOSX") return "";
        out.push(x);
      }
      return out.join("/");
    };

    const toB64 = (u8) => {
      let b = "";
      for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(b);
    };

    const toBase64 = (b) => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(b instanceof Blob ? b : new Blob([b]));
    });

    const normPath = (p) => {
      const s = [];
      for (const seg of p.split("/")) if (seg && seg !== ".") seg === ".." ? s.pop() : s.push(seg);
      return (p.startsWith("/") ? "/" : "") + s.join("/") || (p.startsWith("/") ? "/" : ".");
    };

    const joinPath = (...ps) => normPath(ps.filter(Boolean).join("/"));
    const splitQuery = (p = "") => {
      const q = p.indexOf("?"), h = p.indexOf("#"), cut = q > -1 && h > -1 ? Math.min(q, h) : Math.max(q, h);
      return { cleanPath: cut > -1 ? p.slice(0, cut) : p, query: q > -1 ? p.slice(q, h > q ? h : undefined) : "" };
    };

    const getDir = (p) => {
      const n = normPath(splitQuery(p).cleanPath), i = n.lastIndexOf("/");
      return i < 0 ? "." : i === 0 ? "/" : n.slice(0, i);
    };

    const resolvePath = (base, rel) => {
      const c = splitQuery(rel).cleanPath;
      return c.startsWith("/") ? c.replace(/^\/+/, "") : normPath([...base.split("/").slice(0, -1), c].join("/")).replace(/^\/+/, "");
    };

    const findFile = (files, p) => {
      const cp = splitQuery(p).cleanPath, clean = cp.replace(/^\/workspace\//, "").replace(/^\/+/, "");
      for (const ext of EXTS)
        for (const k of ["/workspace/" + clean, cp, clean, "/" + clean])
          if (Object.hasOwn(files, k + ext)) return { path: "/workspace/" + clean + ext, content: files[k + ext] };
      return null;
    };

    const toFileMap = (files) => Object.fromEntries(files.flatMap((f) => {
      const k = f.name.replaceAll("\\", "/").replace(/^\/+/, "");
      return [[k, f.content], ["/" + k, f.content], ["/workspace/" + k, f.content]];
    }));

    const isReactProj = (files) =>
      Object.keys(files).some((p) => /\.[jt]sx$/i.test(p)) ||
      Object.values(files).some((c) => typeof c === "string" && /(?:["']react["']|React\.|react\/)/.test(c));

    const stripRoot = (paths) => {
      const seg = paths[0]?.includes("/") ? paths[0].split("/")[0] + "/" : "";
      return seg && paths.every((p) => p.startsWith(seg)) ? seg : "";
    };

    return {
      TEXT_EXTS, MIME, isPy, isHtml, isTsOrJs, isZip, isRunnable, detectLangLabel, toStr, sanitizePath, toB64,
      toBase64, normPath, joinPath, splitQuery, getDir, resolvePath, findFile, toFileMap, isReactProj, stripRoot
    };
  })();
  //#endregion

  //#region 5: TypeScriptAndBundlerModule
  const Bundler = (() => {
    let esbuildInit = null;

    const SHIM_R = 'const R=globalThis.React||(typeof window<"u"&&window.React)||{};export default R;export const{Children,Component,Fragment,Profiler,PureComponent,StrictMode,Suspense,act,cloneElement,createContext,createElement,createFactory,createRef,forwardRef,isValidElement,lazy,memo,startTransition,unstable_act,unstable_batchedUpdates,useCallback,useContext,useDebugValue,useDeferredValue,useEffect,useId,useImperativeHandle,useInsertionEffect,useLayoutEffect,useMemo,useReducer,useRef,useState,useSyncExternalStore,useTransition,version}=R;';
    const SHIM_RX = 'const R=globalThis.React||(typeof window<"u"&&window.React)||{};export const Fragment=R.Fragment,jsx=(t,p,k)=>(globalThis.React||R).createElement(t,k!==undefined?{...p,key:k}:p),jsxs=jsx,jsxDEV=jsx;';
    const SHIM_RD = 'const RD=globalThis.ReactDOM||(typeof window<"u"&&window.ReactDOM)||{};export default RD;export const createRoot=(...a)=>RD.createRoot(...a),hydrateRoot=(...a)=>RD.hydrateRoot(...a),render=(...a)=>RD.render(...a),{hydrate,createPortal,findDOMNode,unmountComponentAtNode,flushSync,unstable_batchedUpdates,version}=RD;';

    const transformImportMetaUrls = (code) => {
      if (!code.includes("import.meta.url")) return code;
      const imps = [];
      const out = code.replace(/new\s+URL\(\s*(['"`])(\.\.?\/[^'"`]+)\1\s*,\s*import\.meta\.url\s*\)/g, (_, q, rel) => {
        const id = `__vfs_asset_url_${imps.length}__`;
        imps.push(`import ${id} from ${JSON.stringify(rel + (rel.includes("?") ? "&" : "?") + "url")};`);
        return `new URL(${id})`;
      });
      return imps.length ? imps.join("\n") + "\n" + out : code;
    };

    function wrapWorkerEsm(code) {
      if (code.includes("function __runWorker__(")) return code;
      const imps = [];
      const body = code
        .replace(/^\s*import\s+(?:["'][^"']+["']|[^"';]+\s+from\s+["'][^"']+["'])\s*;?/gm, (m) => (imps.push(m), ""))
        .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
        .replace(/^\s*export\s+default\s+/gm, "const __worker_default__ = ");
      return imps.join("\n") + "\nexport default async function __runWorker__(self,globalThis,postMessage,addEventListener,removeEventListener,close){\nlet onmessage=null,onerror=null;\n" + body + "\nif(typeof onmessage==='function'&&!self.onmessage)self.onmessage=onmessage;\nif(typeof onerror==='function'&&!self.onerror)self.onerror=onerror;\n}";
    }

    async function bundleCode(entryPath, files, { isWorker = false } = {}) {
      if (!esbuildInit) {
        const tInit = performance.now();
        Logger.log("Initializing esbuild-wasm (v0.28.2)...", "BUNDLE");
        esbuildInit = esbuild.initialize({ wasmURL: "https://esm.sh/esbuild-wasm@0.28.2/esbuild.wasm", worker: true })
          .then(() => Logger.log(`esbuild-wasm initialized in ${(performance.now() - tInit).toFixed(0)}ms`, "BUNDLE"))
          .catch((e) => { esbuildInit = null; throw e; });
      }
      await esbuildInit;
      const isReact = FSUtils.isReactProj(files);
      const resolvedExternals = new Set();
      const loadedVfsFiles = [];

      const res = await esbuild.build({
        entryPoints: [entryPath], bundle: true, write: false, format: "esm", outfile: "bundle.js",
        jsx: isReact ? "automatic" : undefined,
        define: { "process.env.NODE_ENV": '"development"', global: "globalThis" },
        plugins: [{
          name: "vfs",
          setup(b) {
            b.onResolve({ filter: /.*/ }, (a) => {
              const { cleanPath: cp, query: q } = FSUtils.splitQuery(a.path);
              if (cp === "react" || cp === "react/index" || cp === "react/index.js") return { path: "__r__", namespace: "vfs" };
              if (cp.startsWith("react/jsx-")) return { path: "__rx__", namespace: "vfs" };
              if (cp === "react-dom" || cp.startsWith("react-dom/")) return { path: "__rd__", namespace: "vfs" };
              if (a.kind === "entry-point") {
                const t = cp.startsWith("/workspace") ? cp : FSUtils.joinPath("/workspace", cp);
                return { path: (FSUtils.findFile(files, t)?.path ?? t) + q, namespace: "vfs" };
              }
              if (/^(?:https?:|data:|blob:)/i.test(a.path)) {
                resolvedExternals.add(a.path);
                return { path: a.path, external: true };
              }
              if (/^\.\.?\//.test(cp)) {
                const r = FSUtils.normPath(FSUtils.joinPath(a.importer ? FSUtils.getDir(a.importer) : "/workspace", cp));
                return { path: (FSUtils.findFile(files, r)?.path ?? r) + q, namespace: "vfs" };
              }
              if (/^[@~]\//.test(cp)) {
                const m = FSUtils.findFile(files, FSUtils.joinPath("/workspace/src", cp.slice(2))) ?? FSUtils.findFile(files, FSUtils.joinPath("/workspace", cp.slice(2)));
                return m ? { path: m.path + q, namespace: "vfs" } : { errors: [{ text: `Cannot resolve alias: ${a.path}` }] };
              }
              const loc = FSUtils.findFile(files, FSUtils.joinPath("/workspace", cp));
              if (loc) return { path: loc.path + q, namespace: "vfs" };
              const extQ = isReact && !a.path.includes("external=") ? (a.path.includes("?") ? "&" : "?") + "external=react,react-dom" : "";
              const cdnUrl = `https://esm.sh/${a.path}${extQ}`;
              resolvedExternals.add(cdnUrl);
              return { path: cdnUrl, external: true };
            });

            b.onLoad({ filter: /.*/, namespace: "vfs" }, async (a) => {
              if (a.path === "__r__") return { contents: SHIM_R, loader: "js" };
              if (a.path === "__rx__") return { contents: SHIM_RX, loader: "js" };
              if (a.path === "__rd__") return { contents: SHIM_RD, loader: "js" };

              const { cleanPath, query } = FSUtils.splitQuery(a.path);
              const params = new URLSearchParams(query.replace(/^\?/, ""));
              const m = FSUtils.findFile(files, cleanPath);
              if (!m) return { errors: [{ text: `Module not found: ${cleanPath}` }] };

              loadedVfsFiles.push(m.path.replace(/^\/workspace\//, ""));
              const ext = m.path.split(".").pop()?.toLowerCase() ?? "";
              const raw = FSUtils.toStr(m.content);

              if (params.has("raw")) return { contents: raw, loader: "text" };
              if (params.has("worker") || params.has("sharedworker") || (params.has("url") && FSUtils.isTsOrJs(m.path))) {
                Logger.log(`Bundling Web Worker module: ${m.path}`, "WORKER");
                const wCode = JSON.stringify(await bundleCode(m.path, files, { isWorker: true }));
                return {
                  contents: params.has("url")
                    ? `const c=${wCode},u=URL.createObjectURL(new Blob([c],{type:"application/javascript"}));globalThis.__vfsWorkerCodeMap?.set(u,c);export default u;`
                    : `export default function(o){return globalThis.__createVirtualWorker(${wCode},o);}`,
                  loader: "js"
                };
              }
              if (ext === "css") {
                const c = JSON.stringify(raw);
                return {
                  contents: params.has("url")
                    ? `export default URL.createObjectURL(new Blob([${c}],{type:"text/css"}));`
                    : `if(typeof document<"u")document.head.appendChild(Object.assign(document.createElement("style"),{textContent:${c}}));export default ${c};`,
                  loader: "js"
                };
              }
              if (ext === "svg") return { contents: `export default ${JSON.stringify("data:image/svg+xml;charset=utf-8," + encodeURIComponent(raw))};`, loader: "js" };
              if (Object.hasOwn(FSUtils.MIME, ext)) {
                const u8 = m.content instanceof Uint8Array ? m.content : new TextEncoder().encode(raw);
                return { contents: `export default "data:${FSUtils.MIME[ext]};base64,${FSUtils.toB64(u8)}";`, loader: "js" };
              }
              if (/^(?:txt|md|csv|html?|xml|py|sql)$/.test(ext)) return { contents: raw, loader: "text" };
              return { contents: FSUtils.isTsOrJs(m.path) ? transformImportMetaUrls(raw) : raw, loader: /^(?:tsx?|jsx|json)$/.test(ext) ? ext : "js" };
            });
          }
        }]
      });

      if (res.warnings?.length) {
        for (const w of res.warnings) {
          const loc = w.location ? `${w.location.file}:${w.location.line}:${w.location.column}: ` : "";
          Logger.log(`esbuild warning: ${loc}${w.text}`, "WARN");
        }
      }
      if (resolvedExternals.size) {
        Logger.log(`Resolved ${resolvedExternals.size} external CDN module(s): ${[...resolvedExternals].join(", ")}`, "BUNDLE");
      }
      const out = res.outputFiles[0].text;
      Logger.log(
        `Compiled ${loadedVfsFiles.length} VFS module(s) (${loadedVfsFiles.join(", ")}) -> ${(out.length / 1024).toFixed(1)} KB${isReact ? " [JSX/React enabled]" : ""}`,
        "BUNDLE"
      );
      return isWorker ? wrapWorkerEsm(out) : out;
    }

    function createSandboxHtml(codeOrHtml, isHtmlEntry = false, isReactProject = true) {
      const harness = `<script>(() => {
        const sendLog = (level, messages) => {
          try { parent.postMessage({ type: "SANDBOX_LOG", level, messages }, "*"); } catch {}
        };
        const fmt = (v, depth = 0, seen = new WeakSet()) => {
          if (v === null) return "null";
          if (v === undefined) return "undefined";
          if (typeof v === "string") return depth > 0 ? JSON.stringify(v) : v;
          if (typeof v === "number" || typeof v === "boolean" || typeof v === "symbol") return String(v);
          if (typeof v === "bigint") return v.toString() + "n";
          if (typeof v === "function") return "[Function: " + (v.name || "anonymous") + "]";
          if (v instanceof Error) return v.stack || (v.name + ": " + v.message);
          if (v instanceof Date) return v.toISOString();
          if (v instanceof RegExp) return v.toString();
          if (typeof Element !== "undefined" && v instanceof Element) {
            const id = v.id ? "#" + v.id : "";
            const cls = typeof v.className === "string" && v.className.trim() ? "." + v.className.trim().split(/\\s+/).join(".") : "";
            return "<" + v.tagName.toLowerCase() + id + cls + ">";
          }
          if (v instanceof ArrayBuffer) return "ArrayBuffer(" + v.byteLength + ")";
          if (ArrayBuffer.isView(v)) return v.constructor.name + "(" + v.byteLength + " bytes)";
          if (typeof v === "object") {
            if (seen.has(v)) return "[Circular]";
            if (depth > 3) return Object.prototype.toString.call(v);
            seen.add(v);
            if (v instanceof Map) {
              const entries = [...v.entries()].slice(0, 50).map(([k, val]) => fmt(k, depth + 1, seen) + " => " + fmt(val, depth + 1, seen));
              return "Map(" + v.size + ") { " + entries.join(", ") + " }";
            }
            if (v instanceof Set) {
              const vals = [...v.values()].slice(0, 50).map((val) => fmt(val, depth + 1, seen));
              return "Set(" + v.size + ") { " + vals.join(", ") + " }";
            }
            if (Array.isArray(v)) {
              const items = v.slice(0, 100).map((item) => fmt(item, depth + 1, seen));
              return "[" + items.join(", ") + (v.length > 100 ? ", ...+" + (v.length - 100) + " more" : "") + "]";
            }
            try {
              const keys = Object.keys(v);
              const pairs = keys.slice(0, 50).map((k) => k + ": " + fmt(v[k], depth + 1, seen));
              return "{ " + pairs.join(", ") + (keys.length > 50 ? ", ..." : "") + " }";
            } catch {
              return Object.prototype.toString.call(v);
            }
          }
          return String(v);
        };

        try { localStorage.getItem("__t"); } catch {
          const ms = () => { let s = {}; return { getItem: k => Object.hasOwn(s, k) ? s[k] : null, setItem: (k, v) => { s[k] = String(v); }, removeItem: k => { delete s[k]; }, clear: () => { s = {}; }, key: i => Object.keys(s)[i] ?? null, get length() { return Object.keys(s).length; } }; };
          try { Object.defineProperty(window, "localStorage", { value: ms(), configurable: true }); Object.defineProperty(window, "sessionStorage", { value: ms(), configurable: true }); } catch {}
        }

        let groupDepth = 0;
        const counts = new Map(), timers = new Map();
        const pad = () => groupDepth > 0 ? "  ".repeat(groupDepth) : "";

        for (const l of ["log", "info", "warn", "error", "debug"]) {
          const o = console[l];
          console[l] = (...a) => {
            sendLog(l.toUpperCase(), [pad() + a.map(v => fmt(v)).join(" ")]);
            o?.apply(console, a);
          };
        }
        const origTrace = console.trace;
        console.trace = (...a) => {
          const stack = (new Error().stack || "").split("\\n").slice(2).join("\\n");
          sendLog("TRACE", [pad() + (a.length ? a.map(v => fmt(v)).join(" ") + "\\n" : "console.trace()\\n") + stack]);
          origTrace?.apply(console, a);
        };
        const origDir = console.dir;
        console.dir = (obj, ...a) => {
          sendLog("DIR", [pad() + fmt(obj)]);
          origDir?.call(console, obj, ...a);
        };
        const origTable = console.table;
        console.table = (data, cols) => {
          sendLog("TABLE", [pad() + fmt(data)]);
          origTable?.call(console, data, cols);
        };
        const origAssert = console.assert;
        console.assert = (cond, ...a) => {
          if (!cond) sendLog("ASSERT", [pad() + "Assertion failed: " + (a.length ? a.map(v => fmt(v)).join(" ") : "console.assert")]);
          origAssert?.call(console, cond, ...a);
        };
        console.count = (label = "default") => {
          const k = String(label), n = (counts.get(k) || 0) + 1;
          counts.set(k, n);
          sendLog("COUNT", [pad() + k + ": " + n]);
        };
        console.countReset = (label = "default") => { counts.delete(String(label)); };
        console.time = (label = "default") => { timers.set(String(label), performance.now()); };
        console.timeLog = (label = "default", ...a) => {
          const k = String(label), t0 = timers.get(k);
          if (t0 !== undefined) sendLog("TIMER", [pad() + k + ": " + (performance.now() - t0).toFixed(2) + "ms" + (a.length ? " " + a.map(v => fmt(v)).join(" ") : "")]);
          else sendLog("WARN", [pad() + "Timer '" + k + "' does not exist"]);
        };
        console.timeEnd = (label = "default") => {
          const k = String(label), t0 = timers.get(k);
          if (t0 !== undefined) {
            timers.delete(k);
            sendLog("TIMER", [pad() + k + ": " + (performance.now() - t0).toFixed(2) + "ms"]);
          } else sendLog("WARN", [pad() + "Timer '" + k + "' does not exist"]);
        };
        console.group = (...a) => {
          sendLog("GROUP", [pad() + "▼ " + (a.length ? a.map(v => fmt(v)).join(" ") : "console.group")]);
          groupDepth = Math.min(groupDepth + 1, 10);
        };

        console.groupCollapsed = (...a) => {
          sendLog("GROUP", [pad() + "▶ " + (a.length ? a.map(v => fmt(v)).join(" ") : "console.groupCollapsed")]);
          groupDepth = Math.min(groupDepth + 1, 10);
        };
        console.groupEnd = () => { groupDepth = Math.max(0, groupDepth - 1); };
        const origClear = console.clear;
        console.clear = () => { sendLog("CONSOLE", ["Console cleared by script"]); origClear?.call(console); };

        window.addEventListener("error", (e) => {
          if (e.target && e.target !== window) {
            const el = e.target;
            const src = el.src || el.href || "";
            sendLog("RES_ERR", ["Failed to load <" + (el.tagName || "resource").toLowerCase() + ">: " + (src || "(inline)")]);
            return;
          }
          const loc = e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ":" + e.colno + ")" : "";
          const stack = e.error?.stack ? "\\n" + e.error.stack : "";
          sendLog("UNCAUGHT_ERR", [(e.message || String(e)) + loc + stack]);
        }, true);

        window.addEventListener("unhandledrejection", (e) => {
          const r = e.reason;
          sendLog("UNHANDLED_PROMISE", [r instanceof Error ? (r.stack || r.message) : fmt(r)]);
        });

        window.addEventListener("securitypolicyviolation", (e) => {
          sendLog("CSP_ERR", ["Blocked '" + e.blockedURI + "' by directive '" + e.violatedDirective + "'"]);
        });

        if (typeof window.fetch === "function") {
          const origFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
            const rawUrl = typeof input === "string" ? input : (input?.url || String(input));
            const shortUrl = rawUrl.startsWith("data:") ? rawUrl.slice(0, 48) + "..." : rawUrl;
            const t0 = performance.now();
            try {
              const res = await origFetch(input, init);
              const dt = (performance.now() - t0).toFixed(0);
              sendLog(res.ok ? "NET" : "NET_WARN", [method + " " + shortUrl + " -> " + res.status + " " + res.statusText + " (" + dt + "ms)"]);
              return res;
            } catch (err) {
              const dt = (performance.now() - t0).toFixed(0);
              sendLog("NET_ERR", [method + " " + shortUrl + " -> FAILED (" + dt + "ms): " + (err?.message || err)]);
              throw err;
            }
          };
        }

        if (typeof XMLHttpRequest !== "undefined") {
          const origOpen = XMLHttpRequest.prototype.open;
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this.__xhrMeta = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
            return origOpen.call(this, method, url, ...rest);
          };
          XMLHttpRequest.prototype.send = function(...args) {
            const meta = this.__xhrMeta || { method: "GET", url: "(unknown)" };
            const t0 = performance.now();
            this.addEventListener("loadend", () => {
              const dt = (performance.now() - t0).toFixed(0);
              const lvl = this.status >= 200 && this.status < 400 ? "NET" : "NET_WARN";
              sendLog(lvl, ["XHR " + meta.method + " " + meta.url + " -> " + (this.status || "ERR") + " (" + dt + "ms)"]);
            }, { once: true });
            return origSend.apply(this, args);
          };
        }

        if (typeof WebSocket !== "undefined") {
          const OrigWS = window.WebSocket;
          window.WebSocket = function(url, protocols) {
            sendLog("WS", ["Connecting to " + url]);
            const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
            ws.addEventListener("open", () => sendLog("WS", ["Connected: " + url]));
            ws.addEventListener("close", (e) => sendLog("WS", ["Closed: " + url + " (code " + e.code + ")"]));
            ws.addEventListener("error", () => sendLog("WS_ERR", ["WebSocket error on " + url]));
            return ws;
          };
          window.WebSocket.prototype = OrigWS.prototype;
          Object.assign(window.WebSocket, OrigWS);
        }

        const OrigAC = window.AudioContext || window.webkitAudioContext;
        if (OrigAC) {
          const PatchedAC = function(...args) {
            const ctx = new OrigAC(...args);
            sendLog("AUDIO", ["AudioContext created (" + ctx.sampleRate + "Hz, state: " + ctx.state + ")"]);
            ctx.addEventListener("statechange", () => sendLog("AUDIO", ["AudioContext state -> " + ctx.state]));
            return ctx;
          };
          PatchedAC.prototype = OrigAC.prototype;
          try { Object.setPrototypeOf(PatchedAC, OrigAC); } catch {}
          window.AudioContext = window.webkitAudioContext = PatchedAC;
        }

        window.__vfsWorkerCodeMap = new Map(); window.__vfsBlobMap = new Map(); window.__vfsWorkerModuleCache = new Map();
        const origURL = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (o) => { const u = origURL(o); if (o instanceof Blob) window.__vfsBlobMap.set(u, o); return u; };
        const wrapWorkerEsm = ${wrapWorkerEsm.toString()};
        const loadMod = (raw) => {
          const w = wrapWorkerEsm(raw);
          if (!window.__vfsWorkerModuleCache.has(w)) {
            const u = origURL(new Blob([w], { type: "application/javascript" }));
            window.__vfsWorkerModuleCache.set(w, import(u).finally(() => URL.revokeObjectURL(u)));
          }
          return window.__vfsWorkerModuleCache.get(w);
        };
        window.__createVirtualWorker = (codeOrPromise, opts) => {
          const wName = opts?.name || "VirtualWorker";
          sendLog("WORKER", ["Spawning " + wName]);
          const ht = new EventTarget(), wt = new EventTarget(), mc1 = new MessageChannel(), mc2 = new MessageChannel();
          const wq = [], hq = []; let started = false, closed = false, wom = null, woe = null, hom = null, hoe = null;
          mc1.port2.onmessage = () => { if (!closed && started) while (wq.length && !closed) wt.dispatchEvent(new MessageEvent("message", { data: wq.shift() })); };
          mc2.port2.onmessage = () => { if (!closed) while (hq.length && !closed) ht.dispatchEvent(new MessageEvent("message", { data: hq.shift() })); };
          const close = () => { if (!closed) sendLog("WORKER", ["Terminated " + wName]); closed = true; wq.length = hq.length = 0; mc1.port1.close(); mc1.port2.close(); mc2.port1.close(); mc2.port2.close(); };
          const wSelf = new Proxy(window, {
            get(t, p) {
              if (p === "self" || p === "globalThis") return wSelf;
              if (p === "postMessage") return (d) => { if (!closed) { hq.push(d); mc2.port1.postMessage(null); } };
              if (p === "addEventListener" || p === "removeEventListener" || p === "dispatchEvent") return wt[p].bind(wt);
              if (p === "close") return close;
              if (p === "onmessage") return wom;
              if (p === "onerror") return woe;
              const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v;
            },
            set(t, p, v) {
              if (p === "onmessage") { if (wom) wt.removeEventListener("message", wom); wom = v; if (typeof v === "function") wt.addEventListener("message", v); return true; }
              if (p === "onerror") { woe = v; return true; }
              t[p] = v; return true;
            }
          });
          Promise.resolve(codeOrPromise).then(loadMod).then(async (m) => {
            if (closed) return;
            if (typeof m.default === "function") await m.default(wSelf, wSelf, wSelf.postMessage, wSelf.addEventListener, wSelf.removeEventListener, close);
            if (!closed && !started) { started = true; if (wq.length) mc1.port1.postMessage(null); }
          }).catch(e => {
            sendLog("WORKER_ERR", [wName + " error: " + (e?.stack || e?.message || String(e))]);
            hoe?.(new ErrorEvent("error", { error: e, message: e?.message || String(e) }));
          });
          return {
            postMessage(d) { if (!closed) { wq.push(d); if (started) mc1.port1.postMessage(null); } },
            addEventListener: ht.addEventListener.bind(ht), removeEventListener: ht.removeEventListener.bind(ht), dispatchEvent: ht.dispatchEvent.bind(ht),
            terminate: close,
            get onmessage() { return hom; }, set onmessage(fn) { hom = fn; if (typeof fn === "function") ht.addEventListener("message", fn); },
            get onerror() { return hoe; }, set onerror(fn) { hoe = fn; if (typeof fn === "function") ht.addEventListener("error", fn); }
          };
        };
        const NW = window.Worker;
        window.Worker = function(u, o) {
          const s = String(u);
          if (window.__vfsWorkerCodeMap.has(s)) return window.__createVirtualWorker(window.__vfsWorkerCodeMap.get(s), o);
          if (window.__vfsBlobMap.has(s)) return window.__createVirtualWorker(window.__vfsBlobMap.get(s).text(), o);
          sendLog("WORKER", ["Spawning native Worker: " + s]);
          return new NW(u, o);
        };
        window.Worker.prototype = NW.prototype;
      })();<\/script>`;

      const uri = (s) => "data:text/javascript," + encodeURIComponent(s);
      const rU = uri(SHIM_R), rxU = uri(SHIM_RX), rdU = uri(SHIM_RD);
      const importMap = JSON.stringify({
        imports: { "react": rU, "react/": rU, "react/jsx-runtime": rxU, "react/jsx-dev-runtime": rxU, "react-dom": rdU, "react-dom/": rdU, "react-dom/client": rdU }
      });

      const head = `<script type="importmap">${importMap}<\/script>
  <script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"><\/script>
  <script src="https://unpkg.com/@tailwindcss/browser@4"><\/script>
  <style type="text/tailwindcss">@import "tailwindcss";</style>
  <script>globalThis.global=globalThis;globalThis.process={env:{NODE_ENV:"development"}};<\/script>${harness}`;

      if (isHtmlEntry) {
        if (/<head(?:\s[^>]*)?>/i.test(codeOrHtml)) return codeOrHtml.replace(/<head(?:\s[^>]*)?>/i, (m) => m + head);
        return `<!DOCTYPE html><html><head>${head}</head><body>${codeOrHtml}</body></html>`;
      }

      const safeCode = JSON.stringify(codeOrHtml || "").replace(/<\/script>/gi, "<\\/script>");
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head>
<body class="p-4 bg-zinc-950 text-zinc-100 min-h-screen"><div id="root"></div><script type="module">
  const t0 = performance.now();
  const u = URL.createObjectURL(new Blob([${safeCode}], { type: "application/javascript" }));
  try {
    const m = await import(u);
    parent.postMessage({ type: "SANDBOX_LOG", level: "RUNTIME", messages: ["Entry module evaluated in " + (performance.now() - t0).toFixed(1) + "ms"] }, "*");
    if (${Boolean(isReactProject)}) {
      const C = m.default || m.App || m.Main, r = document.getElementById("root");
      if ((window.React?.isValidElement(C) || typeof C === "function" || (C && typeof C === "object" && "$$typeof" in C)) && r && !r.hasChildNodes()) {
        const compName = typeof C === "function" ? (C.displayName || C.name || "Component") : "Element";
        parent.postMessage({ type: "SANDBOX_LOG", level: "REACT", messages: ["Mounting <" + compName + " /> to #root (React " + (window.React?.version || "18") + ")"] }, "*");
        window.ReactDOM.createRoot(r).render(window.React.isValidElement(C) ? C : window.React.createElement(C));
      }
    }
  } catch (e) { console.error(e); } finally { URL.revokeObjectURL(u); }
<\/script></body></html>`;
    }

    async function buildStandalone(target, projectFiles) {
      const fileMap = FSUtils.toFileMap(projectFiles), isReact = FSUtils.isReactProj(fileMap), t0 = performance.now();
      if (FSUtils.isHtml(target.name)) {
        Logger.log(`Bundling HTML entry: ${target.name}...`, "BUNDLE");
        const doc = new DOMParser().parseFromString(FSUtils.toStr(target.content), "text/html");
        for (const l of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
          const href = l.getAttribute("href");
          const res = FSUtils.resolvePath(target.name, href), m = FSUtils.findFile(fileMap, res);
          if (m) {
            const s = doc.createElement("style");
            const cssText = FSUtils.toStr(m.content);
            s.textContent = cssText.replace(/<\/style>/gi, "<\\/style>");
            l.replaceWith(s);
            Logger.log(`Inlined stylesheet: ${href} (${(cssText.length / 1024).toFixed(1)} KB)`, "BUNDLE");
          } else if (!/^(?:https?:|data:|blob:|\/\/)/i.test(href)) {
            Logger.log(`Stylesheet not found in workspace: ${href}`, "WARN");
          }
        }
        for (const s of doc.querySelectorAll("script[src]")) {
          const src = s.getAttribute("src");
          const res = FSUtils.resolvePath(target.name, src), entry = res.startsWith("/") ? res : `/workspace/${res}`;
          if (FSUtils.findFile(fileMap, entry)) {
            const inl = doc.createElement("script");
            inl.type = "module";
            inl.textContent = (await bundleCode(entry, fileMap)).replace(/<\/script>/gi, "<\\/script>");
            s.replaceWith(inl);
            Logger.log(`Bundled & inlined script: ${src}`, "BUNDLE");
          } else if (!/^(?:https?:|data:|blob:|\/\/)/i.test(src)) {
            Logger.log(`Script not found in workspace: ${src}`, "WARN");
          }
        }
        Logger.log(`Finished bundling HTML ${target.name} in ${(performance.now() - t0).toFixed(0)}ms`, "PERF");
        return createSandboxHtml("<!DOCTYPE html>\n" + doc.documentElement.outerHTML, true, isReact);
      }
      Logger.log(`Bundling TS/JS entry: ${target.name}...`, "BUNDLE");
      const js = await bundleCode(`/workspace/${target.name.replaceAll("\\", "/").replace(/^\/+/, "")}`, fileMap);
      Logger.log(`Finished bundling ${target.name} in ${(performance.now() - t0).toFixed(0)}ms`, "PERF");
      return createSandboxHtml(js, false, isReact);
    }

    return { bundleCode, createSandboxHtml, buildStandalone };
  })();
  //#endregion

  //#region 6: PythonExecutionRuntime
  const PythonRuntime = (() => {
    let iframe = null, pyApi = null, iframeReadyPromise = null;
    const interruptBuffer = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(1) : null;
    const interruptView = interruptBuffer ? new Uint8Array(interruptBuffer) : null;

    const PYTHON_BOOT_CODE = String.raw`
import ast, asyncio, base64, builtins, concurrent.futures as cf, gc, importlib, importlib.util, inspect, io, js, micropip, os, platform, pyodide, pyodide.code, pyodide.ffi, pyodide_js, re, shutil, sys, time, tokenize, traceback
_WORKSPACE_ROOT = "/workspace"
os.makedirs(_WORKSPACE_ROOT, exist_ok=True); os.chdir(_WORKSPACE_ROOT)
_ORIG_SLEEP = time.sleep
_ORIG_ASYNC_SLEEP = asyncio.sleep
_ORIG_CREATE_TASK = asyncio.create_task
_ORIG_ENSURE_FUTURE = asyncio.ensure_future
_ORIG_CREATE_PROXY = pyodide.ffi.create_proxy
_ORIG_CREATE_ONCE = pyodide.ffi.create_once_callable
_ORIG_MICROPIP_INSTALL = micropip.install
_BASELINE_MODULES = set(sys.modules.keys())
_BOOT_TIME = time.perf_counter()
_stop_requested = False
_in_user_code = False
_run_gen = 0
_tasks = set()
_handles = set()
_proxies = []
_current_main_task = None
PKG = {
    "PIL": "pillow",
    "cv2": "opencv-python",
    "sklearn": "scikit-learn",
    "skimage": "scikit-image",
    "bs4": "beautifulsoup4",
    "yaml": "pyyaml",
    "pygame": "pygame-ce",
    "turtle": "basthon-turtle",
    "attr": "attrs",
    "dateutil": "python-dateutil",
    "dotenv": "python-dotenv",
    "jwt": "PyJWT",
    "serial": "pyserial",
    "websocket": "websocket-client",
    "Crypto": "pycryptodome",
    "OpenGL": "PyOpenGL",
    "docx": "python-docx",
    "pptx": "python-pptx",
    "fitz": "PyMuPDF",
}

def _is_mod_available(mod_name):
    root = (mod_name or "").split(".")[0]
    if not root:
        return False
    if root in sys.modules or root in sys.builtin_module_names or root in getattr(sys, "stdlib_module_names", ()):
        return True
    try:
        return importlib.util.find_spec(root) is not None
    except (ImportError, ValueError, AttributeError):
        return False

def _is_local_mod(mod_name, entry_dir=_WORKSPACE_ROOT):
    root = (mod_name or "").split(".")[0]
    if not root:
        return False
    for base in (entry_dir, _WORKSPACE_ROOT):
        if os.path.isfile(os.path.join(base, f"{root}.py")) or os.path.isdir(os.path.join(base, root)):
            return True
    return False

async def _patched_micropip_install(requirements, *args, **kwargs):
    single = isinstance(requirements, str)
    reqs = [requirements] if single else list(requirements)
    norm_reqs = []
    for r in reqs:
        if isinstance(r, str) and not any(c in r for c in ("/", "\\", ":", "=", "<", ">", "~", "!", "@", "[")) and not r.endswith(".whl"):
            root = r.split(".")[0]
            if _is_mod_available(root):
                continue
            mapped = PKG.get(root, PKG.get(r, root))
            if mapped not in norm_reqs:
                norm_reqs.append(mapped)
        else:
            if r not in norm_reqs:
                norm_reqs.append(r)
    if not norm_reqs:
        return None
    res = await _ORIG_MICROPIP_INSTALL(norm_reqs[0] if single and len(norm_reqs) == 1 else norm_reqs, *args, **kwargs)
    importlib.invalidate_caches()
    _apply_compat_shims()
    return res

micropip.install = _patched_micropip_install

def _apply_compat_shims():
    # 1. NumPy 2.0 backwards-compatibility aliases
    if _is_mod_available("numpy"):
        try:
            import numpy as np
            for alias, target in (
                ("float", float),
                ("int", int),
                ("bool", bool),
                ("object", object),
                ("str", str),
                ("unicode", str),
                ("complex", complex),
                ("NaN", np.nan),
                ("Inf", np.inf),
                ("infty", np.inf),
                ("alltrue", np.all),
                ("sometrue", np.any),
                ("product", np.prod),
                ("cumproduct", np.cumprod),
            ):
                if not hasattr(np, alias):
                    setattr(np, alias, target)
            if not hasattr(np, "trapz") and hasattr(np, "trapezoid"):
                np.trapz = np.trapezoid
            if not hasattr(np, "in1d") and hasattr(np, "isin"):
                np.in1d = np.isin
            if not hasattr(np, "row_stack") and hasattr(np, "vstack"):
                np.row_stack = np.vstack
        except Exception:
            pass

    # 2. filterpy.kalman compatibility (IMMFilter alias & NumPy 2.0 / SciPy vector shape fixes)
    if _is_mod_available("filterpy"):
        try:
            import numpy as np
            import filterpy.stats
            import filterpy.kalman
            from filterpy.kalman import IMMEstimator, KalmanFilter

            if not hasattr(filterpy.kalman, "IMMFilter"):
                filterpy.kalman.IMMFilter = IMMEstimator
            if hasattr(filterpy.kalman, "IMM") and not hasattr(filterpy.kalman.IMM, "IMMFilter"):
                filterpy.kalman.IMM.IMMFilter = IMMEstimator
            if not hasattr(filterpy.kalman, "MMAEFilter") and hasattr(filterpy.kalman, "MMAEFilterBank"):
                filterpy.kalman.MMAEFilter = filterpy.kalman.MMAEFilterBank
            if hasattr(filterpy.kalman, "__all__") and isinstance(filterpy.kalman.__all__, list):
                for sym in ("IMMFilter", "MMAEFilter"):
                    if sym not in filterpy.kalman.__all__:
                        filterpy.kalman.__all__.append(sym)

            if not getattr(filterpy.stats, "_runner_patched", False):
                filterpy.stats._runner_patched = True
                _orig_logpdf = filterpy.stats.logpdf
                def _safe_logpdf(x, mean=None, cov=1, allow_singular=True):
                    x_arr = np.asarray(x, dtype=float).ravel()
                    m_arr = np.asarray(mean, dtype=float).ravel() if mean is not None else np.zeros_like(x_arr)
                    c_arr = np.asarray(cov, dtype=float)
                    if c_arr.ndim == 2:
                        c_arr = 0.5 * (c_arr + c_arr.T) + np.eye(c_arr.shape[0]) * 1e-9
                    try:
                        val = _orig_logpdf(x_arr, m_arr, c_arr, allow_singular=allow_singular)
                    except Exception:
                        diff = x_arr - m_arr
                        val = -0.5 * float(np.dot(diff, diff))
                    return float(np.asarray(val).flat[0])
                filterpy.stats.logpdf = _safe_logpdf
                if hasattr(filterpy.kalman, "kalman_filter"):
                    filterpy.kalman.kalman_filter.logpdf = _safe_logpdf

            if not getattr(IMMEstimator, "_runner_patched", False):
                IMMEstimator._runner_patched = True
                def _imm_init(self, filters, mu, M):
                    if len(filters) < 1:
                        raise ValueError("filters must contain at least one filter")
                    self.filters = list(filters)
                    self.N = len(self.filters)
                    mu_arr = np.asarray(mu, dtype=float).ravel()
                    mu_sum = float(np.sum(mu_arr))
                    self.mu = mu_arr / mu_sum if mu_sum > 0 else np.full(self.N, 1.0 / self.N)
                    self.M = np.asarray(M, dtype=float)
                    self.x = np.zeros_like(self.filters[0].x, dtype=float)
                    self.P = np.zeros_like(self.filters[0].P, dtype=float)
                    self.likelihood = np.zeros(self.N, dtype=float)
                    self.omega = np.zeros((self.N, self.N), dtype=float)
                    self._compute_mixing_probabilities()
                    self._compute_state_estimate()
                    self.x_prior = self.x.copy()
                    self.P_prior = self.P.copy()
                    self.x_post = self.x.copy()
                    self.P_post = self.P.copy()

                def _imm_mixing(self):
                    self.cbar = np.maximum(np.dot(self.mu, self.M), 1e-300)
                    for i in range(self.N):
                        for j in range(self.N):
                            self.omega[i, j] = (self.M[i, j] * self.mu[i]) / self.cbar[j]
                    col_sums = np.sum(self.omega, axis=0, keepdims=True)
                    col_sums = np.where(col_sums > 0, col_sums, 1.0)
                    self.omega /= col_sums

                def _imm_state(self):
                    self.x.fill(0.0)
                    for f, mu_i in zip(self.filters, self.mu):
                        self.x += np.asarray(f.x, dtype=float).reshape(self.x.shape) * float(mu_i)
                    self.P.fill(0.0)
                    for f, mu_i in zip(self.filters, self.mu):
                        y = (np.asarray(f.x, dtype=float).reshape(self.x.shape) - self.x).ravel()
                        self.P += float(mu_i) * (np.outer(y, y) + f.P)

                def _imm_update(self, z, *args, **kwargs):
                    for i, f in enumerate(self.filters):
                        f.update(z, *args, **kwargs)
                        lk = getattr(f, "likelihood", None)
                        if lk is None:
                            try:
                                lk = np.exp(filterpy.stats.logpdf(getattr(f, "y", 0.0), cov=getattr(f, "S", 1.0)))
                            except Exception:
                                lk = 1.0
                        val = float(np.asarray(lk).flat[0])
                        self.likelihood[i] = val if np.isfinite(val) and val > 1e-300 else 1e-300
                    self.mu = self.cbar * self.likelihood
                    total = float(np.sum(self.mu))
                    if not np.isfinite(total) or total <= 0:
                        self.mu = np.full(self.N, 1.0 / self.N)
                    else:
                        self.mu /= total
                    self._compute_mixing_probabilities()
                    self._compute_state_estimate()
                    self.x_post = self.x.copy()
                    self.P_post = self.P.copy()

                IMMEstimator.__init__ = _imm_init
                IMMEstimator._compute_mixing_probabilities = _imm_mixing
                IMMEstimator._compute_state_estimate = _imm_state
                IMMEstimator.update = _imm_update

            if hasattr(filterpy.kalman, "EnsembleKalmanFilter"):
                EnKF = filterpy.kalman.EnsembleKalmanFilter
                if not getattr(EnKF, "_runner_patched", False):
                    EnKF._runner_patched = True
                    _orig_enkf_init = EnKF.__init__
                    def _enkf_init(self, x, P, dim_z, dt, N, hx, fx):
                        _orig_enkf_init(self, np.asarray(x, dtype=float).ravel(), P, dim_z, dt, N, hx, fx)
                    EnKF.__init__ = _enkf_init
        except Exception:
            pass

    # 3. py_trees composite default arguments (memory=False, policy=SuccessOnAll)
    if _is_mod_available("py_trees"):
        try:
            import py_trees
            import py_trees.composites as _ptc
            import py_trees.common as _pt_common
            for _cls_name in ("Selector", "Sequence"):
                _cls = getattr(_ptc, _cls_name, None)
                if _cls and not getattr(_cls, "_runner_patched", False):
                    _cls._runner_patched = True
                    _orig_init = _cls.__init__
                    def _make_init(orig):
                        def _patched_init(self, name="Composite", memory=False, children=None, *a, **kw):
                            if isinstance(memory, (list, tuple)) and children is None:
                                children, memory = list(memory), False
                            orig(self, name=name, memory=bool(memory), children=children, *a, **kw)
                        return _patched_init
                    _cls.__init__ = _make_init(_orig_init)
            _par_cls = getattr(_ptc, "Parallel", None)
            if _par_cls and not getattr(_par_cls, "_runner_patched", False):
                _par_cls._runner_patched = True
                _orig_par_init = _par_cls.__init__
                def _patched_par_init(self, name="Parallel", policy=None, children=None, *a, **kw):
                    if isinstance(policy, (list, tuple)) and children is None:
                        children, policy = list(policy), None
                    if policy is None:
                        policy = _pt_common.ParallelPolicy.SuccessOnAll()
                    _orig_par_init(self, name=name, policy=policy, children=children, *a, **kw)
                _par_cls.__init__ = _patched_par_init
        except Exception:
            pass

    # 4. esper 2.x / 3.x World backwards compatibility
    if _is_mod_available("esper"):
        try:
            import esper
            if not hasattr(esper, "World"):
                class _EsperWorld:
                    _counter = 0
                    def __init__(self, *args, **kwargs):
                        _EsperWorld._counter += 1
                        self._name = "default" if _EsperWorld._counter == 1 else f"world_{_EsperWorld._counter}"
                    def _activate(self):
                        if getattr(esper, "current_world", None) != self._name and hasattr(esper, "switch_world"):
                            esper.switch_world(self._name)
                    def __getattr__(self, attr):
                        fn = getattr(esper, attr)
                        if callable(fn):
                            def _wrapped(*a, **kw):
                                self._activate()
                                return fn(*a, **kw)
                            return _wrapped
                        return fn
                esper.World = _EsperWorld
        except Exception:
            pass

def _boot_banner():
    py_ver = sys.version.replace("\n", " ")
    arch = f"{platform.system()} {platform.machine()} ({sys.platform})"
    mp_ver = getattr(micropip, "__version__", "builtin")
    pyodide_ver = getattr(pyodide, "__version__", "314.0.7")
    print(f"[CPYTHON] Python {py_ver}")
    print(f"[CPYTHON] Target: {arch} | Pyodide: v{pyodide_ver} | micropip: v{mp_ver}")
    print(f"[CPYTHON] Baseline stdlib modules: {len(_BASELINE_MODULES)} | Recursion limit: {sys.getrecursionlimit()} | GC: {'enabled' if gc.isenabled() else 'disabled'}")

_boot_banner()

def _on_task_done(t):
    _tasks.discard(t)
    if not _stop_requested and not t.cancelled():
        exc = t.exception()
        if exc is not None:
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            sys.stderr.write(f"[AsyncTask Error] Unhandled exception in background task:\n{tb}\n")

def _track_task(t):
    if _in_user_code and isinstance(t, asyncio.Future):
        _tasks.add(t)
        t.add_done_callback(_on_task_done)
    return t

async def _patched_async_sleep(delay, result=None):
    if _in_user_code and _stop_requested:
        raise asyncio.CancelledError("Execution stopped")
    res = await _ORIG_ASYNC_SLEEP(delay, result)
    if _in_user_code and _stop_requested:
        raise asyncio.CancelledError("Execution stopped")
    return res

def _patched_create_task(coro, **kwargs):
    if _in_user_code and _stop_requested:
        try: coro.close()
        except: pass
        raise asyncio.CancelledError("Execution stopped")
    return _track_task(_ORIG_CREATE_TASK(coro, **kwargs))

def _patched_ensure_future(coro_or_future, *, loop=None):
    if _in_user_code and _stop_requested and asyncio.iscoroutine(coro_or_future):
        try: coro_or_future.close()
        except: pass
        raise asyncio.CancelledError("Execution stopped")
    return _track_task(_ORIG_ENSURE_FUTURE(coro_or_future, loop=loop))

asyncio.sleep = _patched_async_sleep
asyncio.create_task = _patched_create_task
asyncio.ensure_future = _patched_ensure_future

try:
    _loop = asyncio.get_event_loop()
    _orig_loop_ct = _loop.create_task
    _orig_call_later = _loop.call_later
    _orig_call_soon = _loop.call_soon
    _orig_call_at = _loop.call_at

    def _loop_create_task(coro, **kw):
        if _in_user_code and _stop_requested:
            try: coro.close()
            except: pass
            raise asyncio.CancelledError("Execution stopped")
        return _track_task(_orig_loop_ct(coro, **kw))

    def _track_handle(h):
        if _in_user_code and h is not None:
            _handles.add(h)
        return h

    _loop.create_task = _loop_create_task
    _loop.call_later = lambda d, cb, *a, **k: _track_handle(_orig_call_later(d, cb, *a, **k))
    _loop.call_soon = lambda cb, *a, **k: _track_handle(_orig_call_soon(cb, *a, **k))
    _loop.call_at = lambda w, cb, *a, **k: _track_handle(_orig_call_at(w, cb, *a, **k))
except Exception:
    pass

def _patched_create_proxy(obj, *args, **kwargs):
    if _in_user_code and callable(obj):
        gen = _run_gen
        def _wrapped(*a, **kw):
            if _stop_requested or gen != _run_gen:
                return None
            return obj(*a, **kw)
        p = _ORIG_CREATE_PROXY(_wrapped, *args, **kwargs)
        _proxies.append(p)
        return p
    return _ORIG_CREATE_PROXY(obj, *args, **kwargs)

def _patched_create_once(obj, *args, **kwargs):
    if _in_user_code and callable(obj):
        gen = _run_gen
        def _wrapped(*a, **kw):
            if _stop_requested or gen != _run_gen:
                return None
            return obj(*a, **kw)
        return _ORIG_CREATE_ONCE(_wrapped, *args, **kwargs)
    return _ORIG_CREATE_ONCE(obj, *args, **kwargs)

pyodide.ffi.create_proxy = _patched_create_proxy
pyodide.ffi.create_once_callable = _patched_create_once

def _patch_pygame():
    if "pygame" not in sys.modules:
        return
    try:
        import pygame
        if getattr(pygame, "_runner_patched", False):
            return
        pygame._runner_patched = True
        _overlay_cleared = False

        def _clear_boot_overlay():
            nonlocal _overlay_cleared
            if not _overlay_cleared:
                _overlay_cleared = True
                try:
                    el = js.document.getElementById("o")
                    if el is not None:
                        el.textContent = ""
                except Exception:
                    pass

        def _guard(fn, clear_ov=False):
            def _w(*a, **k):
                if _stop_requested:
                    _stop_pygame_audio()
                    raise KeyboardInterrupt("Execution stopped")
                if clear_ov:
                    _clear_boot_overlay()
                return fn(*a, **k)
            return _w

        if hasattr(pygame, "display"):
            if hasattr(pygame.display, "set_mode"):
                pygame.display.set_mode = _guard(pygame.display.set_mode, True)
            pygame.display.flip = _guard(pygame.display.flip, True)
            pygame.display.update = _guard(pygame.display.update, True)
        if hasattr(pygame, "event"):
            pygame.event.get = _guard(pygame.event.get)
            pygame.event.poll = _guard(pygame.event.poll)
        if hasattr(pygame, "time"):
            pygame.time.wait = _guard(pygame.time.wait)
            pygame.time.delay = _guard(pygame.time.delay)
    except Exception:
        pass

def _stop_pygame_audio():
    if "pygame" in sys.modules:
        try:
            import pygame
            if getattr(pygame, "mixer", None) and pygame.mixer.get_init():
                try: pygame.mixer.stop()
                except: pass
                try: pygame.mixer.music.stop()
                except: pass
                try: pygame.mixer.quit()
                except: pass
            try: pygame.quit()
            except: pass
        except Exception:
            pass

def _request_stop():
    global _stop_requested, _in_user_code, _current_main_task, _run_gen
    _stop_requested = True
    _in_user_code = False
    _run_gen += 1
    _stop_pygame_audio()
    if _current_main_task and not _current_main_task.done():
        try: _current_main_task.cancel()
        except: pass
    for t in list(_tasks):
        if not t.done():
            try: t.cancel()
            except: pass
    _tasks.clear()
    for h in list(_handles):
        try: h.cancel()
        except: pass
    _handles.clear()
    for p in _proxies:
        try: p.destroy()
        except: pass
    _proxies.clear()

def _prepare_run():
    global _stop_requested, _in_user_code, _run_gen
    _request_stop()
    _stop_requested = False
    _in_user_code = False
    _run_gen += 1

def _reset_workspace():
    global _stop_requested, _in_user_code
    _request_stop()
    os.chdir("/")
    if os.path.exists(_WORKSPACE_ROOT): shutil.rmtree(_WORKSPACE_ROOT, ignore_errors=True)
    os.makedirs(_WORKSPACE_ROOT, exist_ok=True); os.chdir(_WORKSPACE_ROOT)
    _stop_requested = False
    _in_user_code = False

async def _run_entry(entry_rel):
    global _stop_requested, _in_user_code, _current_main_task
    _stop_requested = False
    _in_user_code = False
    _current_main_task = asyncio.current_task()

    evicted = 0
    for m in list(sys.modules.keys()):
        if m not in _BASELINE_MODULES:
            mod = sys.modules.get(m)
            f = getattr(mod, "__file__", "") or ""
            if f.startswith(_WORKSPACE_ROOT) or f.startswith("<"):
                sys.modules.pop(m, None)
                evicted += 1
    if evicted:
        print(f"[CACHE] Reloaded {evicted} workspace module(s)")

    abs_entry = os.path.normpath(os.path.join(_WORKSPACE_ROOT, entry_rel))
    entry_dir = os.path.dirname(abs_entry)
    os.chdir(entry_dir); sys.path[:] = [entry_dir, _WORKSPACE_ROOT] + [p for p in sys.path if p not in (entry_dir, _WORKSPACE_ROOT)]
    with tokenize.open(abs_entry) as fp: code = fp.read()

    line_count = len(code.splitlines())
    byte_count = len(code.encode("utf-8"))
    print(f"[ENTRY] Target: {abs_entry} ({line_count} lines, {byte_count} bytes)")

    found = sorted(set(pyodide.code.find_imports(code)))
    root_imports = sorted({p.split(".")[0] for p in found if p})
    local_mods = [r for r in root_imports if _is_local_mod(r, entry_dir)]
    preloaded = [r for r in root_imports if r not in local_mods and _is_mod_available(r)]
    missing = [r for r in root_imports if r not in local_mods and not _is_mod_available(r)]

    print(f"[AST] Imports detected ({len(found)}): {', '.join(found) if found else 'none'}")
    if preloaded:
        print(f"[DEPS] Stdlib / cached ({len(preloaded)}): {', '.join(preloaded)}")
    if local_mods:
        print(f"[DEPS] Local workspace modules ({len(local_mods)}): {', '.join(local_mods)}")

    if missing and not _stop_requested:
        print(f"[DEPS] Resolving external packages ({len(missing)}): {', '.join(missing)}...")
        try:
            await pyodide_js.loadPackagesFromImports("\n".join(f"import {m}" for m in missing))
            importlib.invalidate_caches()
        except Exception as e:
            print(f"[DEPS] Pyodide package loader note: {e}")

    still_missing = [p for p in missing if not _is_mod_available(p)]
    for p in still_missing:
        if _stop_requested: break
        pkg_name = PKG.get(p, p)
        try:
            t_mp = time.perf_counter()
            print(f"[DEPS] Fetching wheel '{pkg_name}' via micropip...")
            await _ORIG_MICROPIP_INSTALL(pkg_name)
            importlib.invalidate_caches()
            print(f"[DEPS] Installed '{pkg_name}' in {(time.perf_counter() - t_mp)*1000:.0f}ms")
        except Exception as e:
            sys.stderr.write(f"[DEPS] Failed to install '{pkg_name}': {e}\n")

    if _stop_requested:
        return None

    _apply_compat_shims()
    _BASELINE_MODULES.update(sys.modules.keys())
    _patch_pygame()

    def _ysleep(s=0):
        if _stop_requested: raise KeyboardInterrupt("Interrupted")
        try:
            if pyodide.ffi.can_run_sync():
                pyodide.ffi.run_sync(_ORIG_ASYNC_SLEEP(s))
            else:
                _ORIG_SLEEP(s)
        except BaseException:
            if _stop_requested: raise KeyboardInterrupt("Interrupted")
            raise
        if _stop_requested: raise KeyboardInterrupt("Interrupted")
    time.sleep = _ysleep

    canvas_el = js.document.getElementById("canvas")
    builtins.canvas = canvas_el
    builtins.input = lambda p="": (js.prompt(str(p)) or "")

    globs = {
        "__name__": "__main__",
        "__file__": abs_entry,
        "__doc__": None,
        "canvas": canvas_el,
        "builtins": builtins
    }
    print(f"[EXEC] Launching __main__ ({entry_rel}) | Uptime: {(time.perf_counter() - _BOOT_TIME):.2f}s")
    print("─" * 62)
    _in_user_code = True
    try:
        res = await pyodide.code.eval_code_async(code, globals=globs, filename=abs_entry)
        _patch_pygame()
        while _tasks and not _stop_requested:
            pending = [t for t in list(_tasks) if not t.done() and t is not _current_main_task]
            if not pending: break
            await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        return res
    except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
        if not _stop_requested:
            sys.stderr.write(traceback.format_exc())
            raise
    except Exception:
        sys.stderr.write(traceback.format_exc())
        raise
    finally:
        if _current_main_task is asyncio.current_task():
            _current_main_task = None
`;

    const IFRAME_HTML = `<!DOCTYPE html><html><head>
<script src="https://unpkg.com/@tailwindcss/browser@4"><\/script>
<style type="text/tailwindcss">@import "tailwindcss";</style>
<style>*{margin:0;box-sizing:border-box}body{background:#000;color:#fff;overflow:hidden;width:100vw;height:100vh}#canvas{position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;outline:0}#o{position:fixed;inset:0;padding:12px;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;overflow:auto;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,0.95);color:#e4e4e7;white-space:pre-wrap}</style>
</head><body><canvas id="canvas" width="960" height="600" tabindex="-1"></canvas><pre id="o"></pre>
<script type="module">
import * as Comlink from "https://cdn.jsdelivr.net/npm/comlink@4.4.2/+esm";
const canvas=document.getElementById("canvas"), o=document.getElementById("o"), W="/workspace";
window.canvas = canvas;
window.c = canvas;
let py=null, pyP=null, bootCode="", intBuf=null, onLog=null, onErr=null;
let stopped=false, tracking=false, currentEpoch=0, isColdBoot=false, bootT0=performance.now();

const sendHostLog = (level, msg) => {
  try { parent.postMessage({ type: "SANDBOX_LOG", level, messages: [String(msg)] }, "*"); } catch {}
};

const log = (t, err=false) => {
  o.append(t + "\\n");
  o.scrollTop = o.scrollHeight;
  (err && onErr ? onErr : onLog)?.(t);
};

const bootStep = (tag, msg) => {
  const dt = "+" + (performance.now() - bootT0).toFixed(0).padStart(4, " ") + "ms";
  const line = "[" + dt + "] [" + tag + "] " + msg;
  o.append(line + "\\n");
  o.scrollTop = o.scrollHeight;
  sendHostLog("PY_BOOT", "[" + tag + "] " + msg);
};

for (const l of ["log", "info", "warn", "error", "debug"]) {
  const orig = console[l];
  console[l] = (...a) => {
    if (tracking) sendHostLog("PY_" + l.toUpperCase(), a.map(v => typeof v === "object" ? JSON.stringify(v) : String(v)).join(" "));
    orig?.apply(console, a);
  };
}

window.addEventListener("error", (e) => {
  if (!tracking) return;
  const loc = e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "";
  sendHostLog("PY_DOM_ERR", (e.message || String(e)) + loc);
}, true);

window.addEventListener("unhandledrejection", (e) => {
  if (!tracking) return;
  const r = e.reason;
  sendHostLog("PY_PROMISE_ERR", r?.stack || r?.message || String(r));
});

const origST = window.setTimeout.bind(window), origCT = window.clearTimeout.bind(window);
const origSI = window.setInterval.bind(window), origCI = window.clearInterval.bind(window);
const origRAF = window.requestAnimationFrame.bind(window), origCAF = window.cancelAnimationFrame.bind(window);
const origAddEL = EventTarget.prototype.addEventListener, origRemEL = EventTarget.prototype.removeEventListener;
const intervals = new Set(), rafs = new Set(), timeouts = new Set(), listeners = [];
const audioContexts = new Set(), audioNodes = new Set(), sourceNodes = new Set(), mediaElements = new Set();

const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
if (OrigAudioContext) {
  const PatchedAC = function(...args) {
    const ctx = new OrigAudioContext(...args);
    audioContexts.add(ctx);
    sendHostLog("AUDIO", "Python WebAudio context created (" + ctx.sampleRate + "Hz, state: " + ctx.state + ")");
    ctx.addEventListener("statechange", () => sendHostLog("AUDIO", "Python WebAudio state -> " + ctx.state));
    return ctx;
  };
  PatchedAC.prototype = OrigAudioContext.prototype;
  try { Object.setPrototypeOf(PatchedAC, OrigAudioContext); } catch {}
  window.AudioContext = window.webkitAudioContext = PatchedAC;
}

if (typeof AudioNode !== "undefined" && AudioNode.prototype.connect) {
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(...args) {
    if (stopped && tracking) return args[0];
    audioNodes.add(this);
    if (this.context) audioContexts.add(this.context);
    return origConnect.apply(this, args);
  };
}

for (const NodeCls of [window.AudioScheduledSourceNode, window.OscillatorNode, window.AudioBufferSourceNode]) {
  if (NodeCls?.prototype?.start && !NodeCls.prototype.__patchedStart) {
    const origStart = NodeCls.prototype.start;
    NodeCls.prototype.__patchedStart = true;
    NodeCls.prototype.start = function(...args) {
      if (stopped && tracking) return;
      sourceNodes.add(this);
      if (this.context) audioContexts.add(this.context);
      return origStart.apply(this, args);
    };
  }
}

const OrigAudio = window.Audio;
if (OrigAudio) {
  const PatchedAudio = function(...args) {
    const a = new OrigAudio(...args);
    mediaElements.add(a);
    return a;
  };
  PatchedAudio.prototype = OrigAudio.prototype;
  window.Audio = PatchedAudio;
}

if (typeof HTMLMediaElement !== "undefined" && HTMLMediaElement.prototype.play) {
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    if (stopped && tracking) return Promise.resolve();
    mediaElements.add(this);
    return origPlay.apply(this, args);
  };
}

const origCreateElement = document.createElement.bind(document);
document.createElement = function(tag, opts) {
  const el = origCreateElement(tag, opts);
  const t = String(tag).toLowerCase();
  if (t === "audio" || t === "video") mediaElements.add(el);
  return el;
};

window.setInterval = (fn, ms, ...args) => {
  if (stopped && tracking) return 0;
  const ep = currentEpoch, tr = tracking;
  const id = origSI((...a) => {
    if (tr && (stopped || ep !== currentEpoch)) return origCI(id);
    fn(...a);
  }, ms, ...args);
  if (tr) intervals.add(id);
  return id;
};
window.clearInterval = (id) => { intervals.delete(id); return origCI(id); };

window.requestAnimationFrame = (fn) => {
  if (stopped && tracking) return 0;
  const ep = currentEpoch, tr = tracking;
  const id = origRAF((ts) => {
    rafs.delete(id);
    if (tr && (stopped || ep !== currentEpoch)) return;
    fn(ts);
  });
  if (tr) rafs.add(id);
  return id;
};
window.cancelAnimationFrame = (id) => { rafs.delete(id); return origCAF(id); };

window.setTimeout = (fn, ms, ...args) => {
  if (stopped && tracking) return 0;
  const ep = currentEpoch, tr = tracking;
  const id = origST((...a) => {
    timeouts.delete(id);
    if (tr && (stopped || ep !== currentEpoch)) return;
    fn(...a);
  }, ms, ...args);
  if (tr) timeouts.add(id);
  return id;
};
window.clearTimeout = (id) => { timeouts.delete(id); return origCT(id); };

EventTarget.prototype.addEventListener = function(type, fn, opts) {
  if (tracking && !(this === window && type === "message")) {
    listeners.push({ target: this, type, fn, opts });
  }
  return origAddEL.call(this, type, fn, opts);
};

function stopAllAudio() {
  for (const src of sourceNodes) {
    try { src.stop?.(0); } catch {}
    try { src.disconnect?.(); } catch {}
  }
  sourceNodes.clear();

  for (const node of audioNodes) {
    try { node.disconnect?.(); } catch {}
  }
  audioNodes.clear();

  if (py?._module?.SDL2) {
    const sdl = py._module.SDL2;
    if (sdl.audio?.scriptProcessorNode) {
      try { sdl.audio.scriptProcessorNode.disconnect(); } catch {}
      try { sdl.audio.scriptProcessorNode.onaudioprocess = null; } catch {}
    }
    if (sdl.audioContext) {
      audioContexts.add(sdl.audioContext);
      delete sdl.audioContext;
    }
    delete sdl.audio;
  }

  for (const ctx of audioContexts) {
    try { ctx.suspend?.(); } catch {}
    try { ctx.close?.(); } catch {}
  }
  audioContexts.clear();

  document.querySelectorAll("audio, video").forEach((el) => mediaElements.add(el));
  for (const el of mediaElements) {
    try {
      el.pause?.();
      el.src = "";
      el.removeAttribute?.("src");
      el.load?.();
      el.remove?.();
    } catch {}
  }
  mediaElements.clear();
  try { window.speechSynthesis?.cancel?.(); } catch {}
}

function cleanupRuntime() {
  currentEpoch++;
  for (const id of intervals) origCI(id);
  intervals.clear();
  for (const id of rafs) origCAF(id);
  rafs.clear();
  for (const id of timeouts) origCT(id);
  timeouts.clear();
  for (const { target, type, fn, opts } of listeners.splice(0)) {
    try { origRemEL.call(target, type, fn, opts); } catch {}
  }
  stopAllAudio();
  for (const el of [window, document, document.body, canvas]) {
    if (!el) continue;
    for (const k of Object.keys(el)) {
      if (k.startsWith("on") && k !== "onpointerdown") {
        try { el[k] = null; } catch {}
      }
    }
  }
  for (const ch of [...document.body.children]) {
    if (ch !== canvas && ch !== o && ch.tagName !== "SCRIPT") {
      try { ch.remove(); } catch {}
    }
  }
  const ctx2d = canvas.getContext("2d");
  if (ctx2d) {
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  }
  canvas.onpointerdown = () => canvas.focus();
}

canvas.onpointerdown = () => canvas.focus();

async function ensurePy() {
  if (pyP) return pyP;
  isColdBoot = true;
  bootT0 = performance.now();
  return pyP = (async () => {
    o.textContent = "╔══════════════════════════════════════════════════════════════╗\\n║       PYODIDE WEBASSEMBLY PYTHON RUNTIME BOOTLOADER          ║\\n╚══════════════════════════════════════════════════════════════╝\\n";
    const hasWebGL2 = Boolean(document.createElement("canvas").getContext("webgl2"));
    const cores = navigator.hardwareConcurrency || "n/a";
    const mem = navigator.deviceMemory ? navigator.deviceMemory + " GB" : "n/a";
    bootStep("ENV", "Host: " + (navigator.platform || "Web") + " | Threads: " + cores + " | RAM: " + mem + " | COI: " + Boolean(window.crossOriginIsolated));
    bootStep("ENV", "Display: #canvas (" + canvas.width + "x" + canvas.height + ") | 2D: true | WebGL2: " + hasWebGL2 + " | WebAudio: " + Boolean(OrigAudioContext));
    bootStep("ENV", "Interrupts: " + (intBuf ? "SharedArrayBuffer SIGINT (1-byte hardware interrupt)" : "Cooperative async/sleep yield fallback"));
    bootStep("NET", "Importing Pyodide v314.0.7 ESM bootstrapper from cdn.jsdelivr.net...");

    const tImport = performance.now();
    const { loadPyodide } = await import("https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs");
    bootStep("NET", "ESM loader fetched in " + (performance.now() - tImport).toFixed(0) + "ms. Downloading & compiling CPython WASM + stdlib...");

    const tWasm = performance.now();
    py = await loadPyodide({ stdout: s => log(s), stderr: s => log(s, true) });
    const heapMb = py._module?.HEAPU8 ? (py._module.HEAPU8.byteLength / 1048576).toFixed(1) + " MB" : "initialized";
    bootStep("WASM", "CPython WebAssembly VM instantiated in " + (performance.now() - tWasm).toFixed(0) + "ms (Initial WASM Heap: " + heapMb + ")");

    py._module.canvas = canvas;
    py.canvas?.setCanvas2D?.(canvas);
    py.canvas?.setCanvas3D?.(canvas);
    bootStep("SDL2", "Bound HTML5 #canvas surface to Pyodide 2D & 3D rendering backends");

    if (intBuf) {
      try {
        py.setInterruptBuffer(intBuf);
        bootStep("SIGINT", "Attached SharedArrayBuffer interrupt vector to CPython VM");
      } catch (e) {
        bootStep("SIGINT", "Interrupt buffer attachment skipped: " + (e?.message || e));
      }
    }

    const tPkg = performance.now();
    bootStep("PKG", "Loading core wheel installer (micropip + packaging)...");
    await py.loadPackage(["micropip"]);
    bootStep("PKG", "micropip package manager ready in " + (performance.now() - tPkg).toFixed(0) + "ms");

    if (bootCode) {
      bootStep("HOOKS", "Installing runtime hooks (asyncio task supervisor, FFI proxy guard, Pygame/SDL audio cleanup)...");
      py.runPython(bootCode);
    }
    bootStep("READY", "Cold boot completed in " + (performance.now() - bootT0).toFixed(0) + "ms");
    return py;
  })();
}
Comlink.expose({
  configure(b, out, err, sb) { bootCode = b; onLog = out; onErr = err; if (sb) intBuf = new Uint8Array(sb); },
  async sync(files) {
    const wasLoaded = Boolean(py);
    const p = await ensurePy();
    stopped = true; tracking = false;
    try { p.runPython("_reset_workspace()"); } catch {}
    cleanupRuntime();
    if (wasLoaded && !isColdBoot) {
      bootT0 = performance.now();
      o.textContent = "╔══════════════════════════════════════════════════════════════╗\\n║         PYODIDE PYTHON RUNTIME — WARM RELOAD SESSION         ║\\n╚══════════════════════════════════════════════════════════════╝\\n";
      const heapMb = p._module?.HEAPU8 ? (p._module.HEAPU8.byteLength / 1048576).toFixed(1) + " MB" : "n/a";
      bootStep("VM", "Reusing active CPython WASM instance | Heap: " + heapMb + " | Interrupts: " + (intBuf ? "SAB SIGINT" : "Cooperative"));
    }
    isColdBoot = false;
    let totalBytes = 0;
    const summary = [];
    for (const { name, content } of files) {
      const full = W + "/" + name, d = full.slice(0, full.lastIndexOf("/"));
      if (d) try { p.FS.mkdirTree(d); } catch {}
      const u8 = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const sz = u8.byteLength || 0;
      totalBytes += sz;
      summary.push(name + " (" + sz + " B)");
      p.FS.writeFile(full, u8);
    }
    bootStep("VFS", "Mounted " + files.length + " file(s) (" + (totalBytes / 1024).toFixed(2) + " KB) into /workspace: " + summary.join(", "));
  },
  async runFile(entry) {
    if (intBuf) intBuf[0] = 0;
    const p = await ensurePy();
    cleanupRuntime();
    try { p.runPython("_prepare_run()"); } catch {}
    stopped = false; tracking = true;
    canvas.focus();
    const fn = p.globals.get("_run_entry");
    try {
      await fn(entry);
    } finally {
      fn.destroy();
    }
  },
  stop() {
    stopped = true; tracking = false;
    if (intBuf) intBuf[0] = 2;
    try { py?.runPython("_request_stop()"); } catch {}
    cleanupRuntime();
  },
  clearOverlay() { o.textContent = ""; }
}, Comlink.windowEndpoint(window.parent));
<\/script></body></html>`;

    async function initIframeRuntime(onBusy) {
      onBusy?.(true);
      if (iframe) { try { iframe.remove(); } catch {} iframe = pyApi = null; }

      const f = document.createElement("iframe");
      f.sandbox = "allow-scripts allow-modals allow-pointer-lock allow-popups allow-same-origin";
      f.className = "w-full h-full border-0 bg-black block";
      DOM.canvasContainer.replaceChildren(f);
      iframe = f;

      return iframeReadyPromise = (async () => {
        try {
          await new Promise((res, rej) => { f.onload = res; f.onerror = rej; f.srcdoc = IFRAME_HTML; });
          pyApi = Comlink.wrap(Comlink.windowEndpoint(f.contentWindow));
          await pyApi.configure(
            PYTHON_BOOT_CODE,
            Comlink.proxy((m) => Logger.log(m, "PY_OUT")),
            Comlink.proxy((m) => Logger.log(m, "PY_ERR")),
            interruptBuffer
          );
          Logger.log(`Python worker iframe configured (SharedArrayBuffer interrupt: ${interruptBuffer ? "enabled" : "unavailable"})`, "PYODIDE");
        } catch (err) {
          Logger.log(`Failed initializing Python runner: ${err.message || err}`, "PY_ERR");
        } finally {
          onBusy?.(false);
        }
      })();
    }

    const prepareFilesForStandalone = (files) => Promise.all(
      files.map(async ({ name, content }) => {
        const isBinary = !FSUtils.TEXT_EXTS.test(name);
        return {
          name, isBinary,
          content: isBinary ? (typeof content === "string" ? btoa(content) : await FSUtils.toBase64(content)) : FSUtils.toStr(content)
        };
      })
    );

    function generateStandaloneHtml(entryName, files) {
      const serializedFiles = JSON.stringify(files).replace(/<\/script>/gi, "<\\/script>");
      const serializedBoot = JSON.stringify(PYTHON_BOOT_CODE).replace(/<\/script>/gi, "<\\/script>");
      return `<!DOCTYPE html><html lang="en" class="bg-zinc-950 text-zinc-100"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${entryName} - Standalone</title><script src="https://unpkg.com/@tailwindcss/browser@4"><\/script><style type="text/tailwindcss">@import "tailwindcss";</style><script src="https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.js"><\/script></head><body class="p-4 flex flex-col gap-3 min-h-screen font-mono"><div class="flex items-center justify-between border-b border-zinc-800 pb-2"><h3 class="font-bold text-sm text-blue-400">${entryName}</h3><div id="st" class="text-xs text-zinc-400">Booting Pyodide...</div></div><canvas id="canvas" width="960" height="600" tabindex="1" class="w-full max-h-[70vh] bg-black border border-zinc-800 rounded-lg object-contain"></canvas><pre id="o" class="bg-zinc-900 border border-zinc-800 p-3 rounded-lg text-xs overflow-auto max-h-56 whitespace-pre-wrap"></pre><script>
const st=document.getElementById("st"), o=document.getElementById("o"), canvas=document.getElementById("canvas"), t0=performance.now();
window.canvas = canvas;
const print=(m)=>{ o.textContent+=m+"\\n"; o.scrollTop=o.scrollHeight; };
const boot=(tag,m)=>{ const dt="+"+(performance.now()-t0).toFixed(0)+"ms"; st.textContent="["+tag+"] "+m; print("["+dt+"] ["+tag+"] "+m); };
async function init(){
  try{
    boot("ENV", "Host: "+(navigator.platform||"Web")+" | Cores: "+(navigator.hardwareConcurrency||"n/a")+" | Canvas: "+canvas.width+"x"+canvas.height);
    boot("WASM", "Initializing Pyodide v314.0.7 WebAssembly runtime...");
    const pyodide=await loadPyodide({stdout:print,stderr:print});
    pyodide._module.canvas = canvas;
    pyodide.canvas?.setCanvas2D?.(canvas);
    pyodide.canvas?.setCanvas3D?.(canvas);
    boot("PKG", "Loading micropip & runtime hooks...");
    await pyodide.loadPackage(["micropip"]);
    pyodide.runPython(${serializedBoot});
    const files=${serializedFiles};
    for(const f of files){
      const full="/workspace/"+f.name;
      const d=full.slice(0,full.lastIndexOf("/")); if(d) try{pyodide.FS.mkdirTree(d)}catch{}
      pyodide.FS.writeFile(full, f.isBinary ? Uint8Array.from(atob(f.content), x=>x.charCodeAt(0)) : f.content);
    }
    boot("VFS", "Mounted "+files.length+" workspace file(s)");
    st.textContent="Running ${entryName}...";
    const fn=pyodide.globals.get("_run_entry");
    try{ await fn(${JSON.stringify(entryName)}); }finally{ fn.destroy(); }
    st.textContent="Finished.";
  }catch(e){ st.textContent="Error: "+e.message; print("[Error] "+(e.stack||e.message)); }
}
init();
<\/script></body></html>`;
    }

    return {
      initIframeRuntime, prepareFilesForStandalone, generateStandaloneHtml,
      get pyApi() { return pyApi; }, get iframe() { return iframe; },
      get iframeReadyPromise() { return iframeReadyPromise; }, get interruptView() { return interruptView; }
    };
  })();
  //#endregion

  //#region 7: ArchiveAndBuiltinProjectsManager
  const Archive = (() => {
    const encodeDataUrl = (mime, code, filename) =>
      `data:${mime};charset=utf-8,${encodeURIComponent(code)}#${encodeURIComponent(filename)}`;

    const DEFAULT_BUILTIN_URLS = [
      {
        name: "HTML Neon Physics & Synth",
        lang: "HTML",
        entry: "index.html",
        url: "./examples/html/chimes/index.html"
      },
      {
        name: "JavaScript Neon Physics & Synth",
        lang: "JavaScript",
        entry: "main.js",
        url: "./examples/html/chimes/index.html"
      },
      {
        name: "TypeScript Neon Physics & Synth",
        lang: "TypeScript",
        entry: "main.ts",
        url: encodeDataUrl("text/typescript", 
`interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: number;
  freq: number;
}
document.body.className = "m-0 bg-black text-white overflow-hidden w-screen h-screen";
const canvas = document.createElement("canvas");
canvas.id = "canvas";
canvas.width = 960;
canvas.height = 600;
canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;outline:0";
const overlay = document.createElement("pre");
overlay.style.cssText = "position:fixed;inset:0;padding:12px;font:14px monospace;overflow:auto;pointer-events:none;text-shadow:0 1px 2px #000;margin:0";
document.body.replaceChildren(canvas, overlay);
const ctx = canvas.getContext("2d")!;
const W = canvas.width;
const H = canvas.height;
const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
const audioCtx = new AudioCtx();
window.addEventListener("pointerdown", () => {
  if (audioCtx.state === "suspended") audioCtx.resume();
});
function beep(freq: number = 440): void {
  try {
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch {
    // Ignore audio context restrictions
  }
}
const speedChoices = [-5, -4, 4, 5];
const randomUniform = (min: number, max: number): number => min + Math.random() * (max - min);
const randomInt = (min: number, max: number): number => Math.floor(randomUniform(min, max + 1));
const randomChoice = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const balls: Ball[] = Array.from({ length: 6 }, (_, i) => ({
  x: randomUniform(80, W - 80),
  y: randomUniform(80, H - 80),
  vx: randomChoice(speedChoices),
  vy: randomChoice(speedChoices),
  r: randomInt(16, 26),
  hue: i * 55,
  freq: 280 + i * 70
}));
const msg = "TypeScript Neon Physics running! Bounces trigger WebAudio chimes.";
overlay.textContent = msg + "\\n";
console.log(msg);
function loop(): void {
  ctx.fillStyle = "rgba(10, 10, 18, 0.35)";
  ctx.fillRect(0, 0, W, H);
  for (const b of balls) {
    b.x += b.vx;
    b.y += b.vy;
    if (b.x - b.r < 0 || b.x + b.r > W) {
      b.vx *= -1;
      beep(b.freq);
    }
    if (b.y - b.r < 0 || b.y + b.r > H) {
      b.vy *= -1;
      beep(b.freq * 1.25);
    }
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = \`hsl(\${b.hue}, 90%, 60%)\`;
    ctx.fill();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
`, "main.ts")
      },
      {
        name: "Python Neon Physics & Synth",
        lang: "Python",
        entry: "main.py",
        url: encodeDataUrl("text/x-python", 
`import asyncio, math, random, js
from pyodide.ffi import create_proxy
ctx = canvas.getContext("2d")
W, H = canvas.width, canvas.height
audio_ctx = js.AudioContext.new()
def beep(freq=440):
    try:
        if audio_ctx.state == "suspended":
            audio_ctx.resume()
        osc = audio_ctx.createOscillator()
        gain = audio_ctx.createGain()
        osc.type = "sine"
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.06, audio_ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, audio_ctx.currentTime + 0.12)
        osc.connect(gain)
        gain.connect(audio_ctx.destination)
        osc.start()
        osc.stop(audio_ctx.currentTime + 0.12)
    except Exception:
        pass
balls = [
    {"x": random.uniform(80, W-80), "y": random.uniform(80, H-80),
     "vx": random.choice([-5, -4, 4, 5]), "vy": random.choice([-5, -4, 4, 5]),
     "r": random.randint(16, 26), "hue": i * 55, "freq": 280 + i * 70}
    for i in range(6)
]
print("Python Neon Physics running! Bounces trigger WebAudio chimes.")
while True:
    ctx.fillStyle = "rgba(10, 10, 18, 0.35)"
    ctx.fillRect(0, 0, W, H)
    for b in balls:
        b["x"] += b["vx"]
        b["y"] += b["vy"]
        if b["x"] - b["r"] < 0 or b["x"] + b["r"] > W:
            b["vx"] *= -1
            beep(b["freq"])
        if b["y"] - b["r"] < 0 or b["y"] + b["r"] > H:
            b["vy"] *= -1
            beep(b["freq"] * 1.25)
        ctx.beginPath()
        ctx.arc(b["x"], b["y"], b["r"], 0, math.pi * 2)
        ctx.fillStyle = f"hsl({b['hue']}, 90%, 60%)"
        ctx.fill()
    await asyncio.sleep(1 / 60)
`, "main.py")        
      }
    ];

    function getBuiltinConfig() {
      const ext = window.BUILTIN_PROJECTS || document.builtinProjects;
      const folders = ["./projects", "./examples", "./builtin"];
      const urls = [];
      if (typeof ext === "string") {
        folders.unshift(ext);
      } else if (Array.isArray(ext)) {
        urls.push(...ext);
      } else if (ext && typeof ext === "object") {
        if (typeof ext.folder === "string") folders.unshift(ext.folder);
        if (Array.isArray(ext.folders)) folders.unshift(...ext.folders);
        if (Array.isArray(ext.urls)) urls.push(...ext.urls);
      }
      if (Array.isArray(window.BUILTIN_URLS)) urls.push(...window.BUILTIN_URLS);
      if (typeof window.BUILTIN_FOLDER === "string") folders.unshift(window.BUILTIN_FOLDER);
      urls.push(...DEFAULT_BUILTIN_URLS);
      return { folders: [...new Set(folders)], urls };
    }

    async function extractZipEntries(zipBytesOrFile) {
      const u8 = zipBytesOrFile instanceof Uint8Array
        ? zipBytesOrFile
        : new Uint8Array(await zipBytesOrFile.arrayBuffer());
      const data = await new Promise((res, rej) => fflate.unzip(u8, (e, d) => (e ? rej(e) : res(d))));
      const rawEntries = Object.entries(data)
        .filter(([k]) => !k.endsWith("/"))
        .map(([k, content]) => ({ name: FSUtils.sanitizePath(k), content }))
        .filter((e) => e.name);
      if (!rawEntries.length) return [];
      const rootPrefix = FSUtils.stripRoot(rawEntries.map((e) => e.name));
      return rawEntries.map((e) => ({
        name: rootPrefix && e.name.startsWith(rootPrefix) ? e.name.slice(rootPrefix.length) : e.name,
        content: FSUtils.TEXT_EXTS.test(e.name) ? fflate.strFromU8(e.content) : e.content
      })).filter((e) => e.name);
    }

    async function parseUploadedFiles(fileList) {
      const fileMap = new Map();
      const files = [...fileList];
      const rootPrefix = FSUtils.stripRoot(files.map((f) => (f.webkitRelativePath || "").replaceAll("\\", "/")));

      for (const f of files) {
        if (FSUtils.isZip(f.name)) {
          const entries = await extractZipEntries(f);
          for (const e of entries) fileMap.set(e.name, e.content);
        } else {
          const raw = (f.webkitRelativePath || f.name).replaceAll("\\", "/");
          const stripped = rootPrefix && raw.startsWith(rootPrefix) ? raw.slice(rootPrefix.length) : raw;
          const name = FSUtils.sanitizePath(stripped);
          if (name) fileMap.set(name, FSUtils.TEXT_EXTS.test(name) ? await f.text() : new Uint8Array(await f.arrayBuffer()));
        }
      }
      return Array.from(fileMap, ([name, content]) => ({ name, content }));
    }

    function inferFileNameFromUrl(url, fallback = "main.js") {
      if (url.startsWith("data:")) {
        const hashIdx = url.indexOf("#");
        return hashIdx > -1 ? decodeURIComponent(url.slice(hashIdx + 1)) : fallback;
      }
      try {
        const u = new URL(url, window.location.href);
        const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
        return seg || fallback;
      } catch {
        return url.split(/[?#]/)[0].split("/").filter(Boolean).pop() || fallback;
      }
    }

    async function fetchRawUrl(url, asText = true) {
      if (url.startsWith("data:")) {
        const withoutHash = url.split("#")[0];
        const commaIdx = withoutHash.indexOf(",");
        const meta = withoutHash.slice(0, commaIdx);
        const body = withoutHash.slice(commaIdx + 1);
        if (meta.includes(";base64")) {
          const bin = atob(body);
          const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          return asText ? new TextDecoder().decode(u8) : u8;
        }
        const text = decodeURIComponent(body);
        return asText ? text : new TextEncoder().encode(text);
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return asText ? await res.text() : new Uint8Array(await res.arrayBuffer());
    }

    function normalizeDescriptor(item, baseUrl = "") {
      const resolveUrl = (u) => {
        if (!u || u.startsWith("data:") || /^(?:https?:|blob:)/i.test(u)) return u;
        if (!baseUrl) return u;
        return `${baseUrl.replace(/\/+$/, "")}/${u.replace(/^\.?\//, "")}`;
      };

      if (typeof item === "string") {
        const resolved = resolveUrl(item);
        const fileName = inferFileNameFromUrl(resolved);
        if (!FSUtils.isRunnable(fileName)) return null;
        const lang = FSUtils.detectLangLabel(fileName);
        return {
          id: `url:${resolved}`,
          name: fileName,
          lang,
          entry: FSUtils.isZip(fileName) ? "" : fileName,
          url: resolved
        };
      }

      if (item && typeof item === "object") {
        const url = item.url ? resolveUrl(item.url) : "";
        const urls = Array.isArray(item.urls) ? item.urls.map(resolveUrl) : null;
        const files = Array.isArray(item.files) ? item.files : null;
        const entry = item.entry || (url ? inferFileNameFromUrl(url) : urls?.[0] ? inferFileNameFromUrl(urls[0]) : "");
        const lang = item.lang || FSUtils.detectLangLabel(entry || url || item.name || "");
        const name = item.name || entry || "Project";
        return {
          id: item.id || `proj:${name}:${url || (urls ? urls.join(",") : "inline")}`,
          name,
          lang,
          entry,
          url,
          urls,
          files,
          baseUrl: item.folder ? resolveUrl(item.folder) : baseUrl
        };
      }
      return null;
    }

    async function scanFolderListing(folderUrl) {
      const cleanFolder = folderUrl.replace(/\/+$/, "");
      for (const manifestName of ["manifest.json", "index.json", "projects.json"]) {
        try {
          const res = await fetch(`${cleanFolder}/${manifestName}`);
          if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
            const data = await res.json();
            const list = Array.isArray(data)
              ? data
              : Array.isArray(data?.projects)
                ? data.projects
                : Array.isArray(data?.files)
                  ? data.files
                  : Object.entries(data || {}).map(([name, val]) => (typeof val === "string" ? { name, url: val } : { name, ...val }));
            const mapped = list.map((item) => normalizeDescriptor(item, cleanFolder)).filter(Boolean);
            if (mapped.length) return mapped;
          }
        } catch {}
      }

      try {
        const res = await fetch(`${cleanFolder}/`);
        if (!res.ok) return [];
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("text/html")) return [];
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const baseResolved = new URL(`${cleanFolder}/`, window.location.href);
        const found = [];

        for (const a of doc.querySelectorAll("a[href]")) {
          const rawHref = a.getAttribute("href") || "";
          if (!rawHref || rawHref.startsWith("?") || rawHref.startsWith("#") || rawHref === "../" || rawHref === "./") continue;
          const resolved = new URL(rawHref, baseResolved);
          if (!resolved.href.startsWith(baseResolved.href) || resolved.href === baseResolved.href) continue;
          const rel = decodeURIComponent(resolved.href.slice(baseResolved.href.length));
          if (rel.endsWith("/")) {
            const subName = rel.replace(/\/+$/, "");
            if (!subName || subName.startsWith(".")) continue;
            const subUrl = `${cleanFolder}/${subName}`;
            const subRes = await fetch(`${subUrl}/`).catch(() => null);
            if (subRes?.ok && (subRes.headers.get("content-type") || "").includes("text/html")) {
              const subDoc = new DOMParser().parseFromString(await subRes.text(), "text/html");
              const subBase = new URL(`${subUrl}/`, window.location.href);
              const subFiles = [];
              for (const sa of subDoc.querySelectorAll("a[href]")) {
                const sh = sa.getAttribute("href") || "";
                if (!sh || sh.startsWith("?") || sh.startsWith("#") || sh.endsWith("/")) continue;
                const sr = new URL(sh, subBase);
                if (sr.href.startsWith(subBase.href)) subFiles.push(sr.href);
              }
              if (subFiles.length) {
                found.push(normalizeDescriptor({ name: subName, urls: subFiles }, subUrl));
              }
            }
          } else if (FSUtils.isRunnable(rel)) {
            found.push(normalizeDescriptor({ name: rel, url: resolved.href }));
          }
        }
        return found.filter(Boolean);
      } catch {
        return [];
      }
    }

    async function discoverBuiltins() {
      const { folders, urls } = getBuiltinConfig();
      const folderResults = (await Promise.all(folders.map(scanFolderListing))).flat();
      const urlResults = urls.map((u) => normalizeDescriptor(u)).filter(Boolean);
      const seen = new Set();
      return [...folderResults, ...urlResults].filter((item) => {
        if (!item || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    }

    async function loadProjectFiles(project) {
      if (Array.isArray(project.files) && project.files.length && project.files[0].content !== undefined) {
        return project.files.map((f) => ({
          name: FSUtils.sanitizePath(f.name),
          content: f.content
        })).filter((f) => f.name);
      }

      if (project.url && FSUtils.isZip(inferFileNameFromUrl(project.url))) {
        const u8 = await fetchRawUrl(project.url, false);
        return extractZipEntries(u8);
      }

      const targetUrls = Array.isArray(project.urls) && project.urls.length
        ? project.urls
        : project.url
          ? [project.url]
          : [];

      const fetched = await Promise.all(
        targetUrls.map(async (u) => {
          const fileName = FSUtils.sanitizePath(inferFileNameFromUrl(u, project.entry || "main.js"));
          const isText = FSUtils.TEXT_EXTS.test(fileName);
          const content = await fetchRawUrl(u, isText);
          return { name: fileName, content };
        })
      );

      if (fetched.length === 1 && FSUtils.isHtml(fetched[0].name) && !project.url?.startsWith("data:")) {
        const htmlContent = FSUtils.toStr(fetched[0].content);
        const doc = new DOMParser().parseFromString(htmlContent, "text/html");
        const base = new URL(targetUrls[0], window.location.href);
        const linked = [];
        for (const el of doc.querySelectorAll("script[src], link[rel~='stylesheet'][href]")) {
          const ref = el.getAttribute("src") || el.getAttribute("href");
          if (!ref || /^(?:https?:|data:|blob:|\/\/)/i.test(ref)) continue;
          const relName = FSUtils.sanitizePath(ref);
          if (relName) linked.push({ relName, url: new URL(ref, base).href });
        }
        const extras = await Promise.all(
          linked.map(async ({ relName, url }) => {
            try {
              const content = await fetchRawUrl(url, FSUtils.TEXT_EXTS.test(relName));
              return { name: relName, content };
            } catch {
              return null;
            }
          })
        );
        fetched.push(...extras.filter(Boolean));
      }

      return fetched.filter((f) => f.name);
    }

    return { parseUploadedFiles, discoverBuiltins, loadProjectFiles };
  })();
  //#endregion

  //#region 8: UIControllerAndAppBootstrap
  (() => {
    let projectFiles = [], builtinProjects = [], activeBuiltinId = "";
    let isRunning = false, pyExecuting = false, activeRuntime = null, busy = false;
    let currentRunId = 0, activePyRunPromise = null;

    const getByteSize = (c) => (typeof c === "string" ? new TextEncoder().encode(c).byteLength : (c?.byteLength || 0));

    const findDefaultEntry = (files, preferred = "") => {
      if (preferred && files.some((f) => f.name === preferred)) return preferred;
      const cands = ["index.html", "main.py", "index.tsx", "app.tsx", "main.tsx", "app.py", "index.py", "run.py", "index.ts", "main.ts", "index.js", "main.js"];
      for (const c of cands) {
        const f = files.find((x) => x.name.split("/").at(-1)?.toLowerCase() === c);
        if (f) return f.name;
      }
      return (files.find((f) => FSUtils.isPy(f.name) || FSUtils.isTsOrJs(f.name) || FSUtils.isHtml(f.name)) ?? files[0])?.name || "";
    };

    const getSelectedEntryName = () => {
      const val = DOM.entrySelect.value || "";
      if (val.startsWith("file:")) return val.slice(5);
      return findDefaultEntry(projectFiles);
    };

    const syncUnifiedSelectors = (selectedEntry = "") => {
      const groups = [];
      if (projectFiles.length) {
        const opts = projectFiles
          .map((f) => `<option value="file:${f.name}">[${FSUtils.detectLangLabel(f.name)}] ${f.name}</option>`)
          .join("");
        groups.push(`<optgroup label="📂 Current Project Files">${opts}</optgroup>`);
      }
      if (builtinProjects.length) {
        const opts = builtinProjects
          .map((p) => `<option value="builtin:${p.id}">[${p.lang}] ${p.name}</option>`)
          .join("");
        groups.push(`<optgroup label="📦 Built-in Projects (Folder & URLs)">${opts}</optgroup>`);
      }

      const combinedHtml = groups.join("") || "<option value=''>No projects available</option>";
      DOM.entrySelect.innerHTML = combinedHtml;
      DOM.builtinSelect.innerHTML = combinedHtml;

      const targetVal = selectedEntry && projectFiles.some((f) => f.name === selectedEntry)
        ? `file:${selectedEntry}`
        : activeBuiltinId
          ? `builtin:${activeBuiltinId}`
          : projectFiles.length
            ? `file:${findDefaultEntry(projectFiles)}`
            : builtinProjects.length
              ? `builtin:${builtinProjects[0].id}`
              : "";

      if (targetVal) {
        DOM.entrySelect.value = targetVal;
        DOM.builtinSelect.value = targetVal;
      }
    };

    const updateUI = (isBusy = busy) => {
      busy = isBusy;
      const hasAny = projectFiles.length > 0 || builtinProjects.length > 0;
      DOM.fileInput.disabled = DOM.folderInput.disabled = false;
      DOM.builtinSelect.disabled = busy || !hasAny;
      DOM.loadBuiltinBtn.disabled = busy || !hasAny;
      DOM.refreshBuiltinBtn.disabled = busy;
      DOM.entrySelect.disabled = busy || !hasAny;
      DOM.runBtn.disabled = busy || !hasAny;
      DOM.downloadBtn.disabled = busy || projectFiles.length === 0;
      DOM.stopBtn.disabled = !isRunning;
    };

    const expandViewport = () => {
      DOM.runnerViewport.classList.remove("hidden");
      DOM.runnerViewport.classList.add("flex");
      DOM.mainDashboard.classList.add("hidden");
      DOM.viewActiveBtn.classList.remove("hidden");
    };

    const collapseViewport = () => {
      DOM.runnerViewport.classList.add("hidden");
      DOM.runnerViewport.classList.remove("flex");
      DOM.mainDashboard.classList.remove("hidden");
    };

    async function stopExecution(silent = false) {
      currentRunId++;
      const wasRunning = isRunning || pyExecuting || activeRuntime !== null;
      const prevRuntime = activeRuntime;

      DOM.resetSandbox();

      if (PythonRuntime.interruptView) PythonRuntime.interruptView[0] = 2;
      try { await PythonRuntime.pyApi?.stop(); } catch {}

      if (!silent && wasRunning) {
        Logger.log(`Execution stopped (runtime: ${prevRuntime === "py" ? "Python/Pyodide" : "TypeScript/JS Sandbox"}).`, "RUNTIME");
      }

      if (pyExecuting && activePyRunPromise) {
        const stoppedCleanly = await Promise.race([
          activePyRunPromise.then(() => true, () => true),
          new Promise((res) => setTimeout(() => res(false), 300))
        ]);
        if (!stoppedCleanly) {
          Logger.log("Python runner did not yield within 300ms; hard-resetting Pyodide iframe...", "WARN");
          try { await PythonRuntime.initIframeRuntime(updateUI); } catch {}
        }
      }

      isRunning = false;
      pyExecuting = false;
      activeRuntime = null;
      activePyRunPromise = null;
      Logger.flush();
      updateUI(false);
    }

    async function exportEntry(target) {
      updateUI(true);
      try {
        if (FSUtils.isPy(target.name)) {
          Logger.log(`Exporting standalone Python HTML for ${target.name}...`, "EXPORT");
          const html = PythonRuntime.generateStandaloneHtml(target.name, await PythonRuntime.prepareFilesForStandalone(projectFiles));
          const fileName = `${target.name.split("/").pop().replace(/\.[^.]+$/, "") || "py_app"}.standalone.html`;
          const a = Object.assign(document.createElement("a"), {
            href: URL.createObjectURL(new Blob([html], { type: "text/html" })),
            download: fileName
          });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          Logger.log(`Exported ${fileName} (${(html.length / 1024).toFixed(1)} KB)`, "EXPORT");
        } else {
          Logger.log(`Exporting standalone JS/TS HTML bundle for ${target.name}...`, "EXPORT");
          const html = await Bundler.buildStandalone(target, projectFiles);
          const fileName = `${target.name.split("/").pop().replace(/\.[^.]+$/, "") || "bundle"}.standalone.html`;
          const a = Object.assign(document.createElement("a"), {
            href: URL.createObjectURL(new Blob([html], { type: "text/html" })),
            download: fileName
          });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          Logger.log(`Exported ${fileName} (${(html.length / 1024).toFixed(1)} KB)`, "EXPORT");
        }
      } catch (e) {
        Logger.log(`Export Error: ${e?.stack || e?.message || e}`, "ERR");
        DOM.logsDrawer.classList.remove("translate-y-full");
      } finally {
        updateUI(false);
      }
    }

    async function execEntry(download = false, explicitEntryName = "") {
      const entryName = explicitEntryName || getSelectedEntryName();
      const target = projectFiles.find((f) => f.name === entryName) || projectFiles[0];
      if (!target) return;
      if (download) return exportEntry(target);

      await stopExecution(true);
      const runId = ++currentRunId;
      syncUnifiedSelectors(target.name);
      expandViewport();

      const langLabel = FSUtils.detectLangLabel(target.name);
      const sizeKb = (getByteSize(target.content) / 1024).toFixed(2);

      if (FSUtils.isPy(target.name)) {
        if (PythonRuntime.interruptView) PythonRuntime.interruptView[0] = 0;
        isRunning = true;
        pyExecuting = true;
        activeRuntime = "py";
        updateUI(false);
        DOM.sandbox.classList.add("hidden");
        DOM.canvasContainer.classList.remove("hidden");
        PythonRuntime.iframe?.contentWindow?.focus();

        const runTask = (async () => {
          try {
            await PythonRuntime.iframeReadyPromise;
            if (runId !== currentRunId) return;
            Logger.log(`Starting [${langLabel}] ${target.name} (${sizeKb} KB, ${projectFiles.length} workspace file(s))...`, "RUNTIME");
            const t0 = performance.now();
            await PythonRuntime.pyApi.sync(projectFiles.map((f) => ({ name: f.name, content: f.content })));
            if (runId !== currentRunId) return;
            await PythonRuntime.pyApi.runFile(target.name);
            if (runId !== currentRunId) return;
            Logger.log(`Python script ${target.name} finished in ${(performance.now() - t0).toFixed(0)}ms`, "PERF");
          } catch (err) {
            if (runId !== currentRunId) return;
            Logger.log(`Python Runtime Error: ${err?.stack || err?.message || err}`, "PY_ERR");
            DOM.logsDrawer.classList.remove("translate-y-full");
            isRunning = false;
            activeRuntime = null;
          } finally {
            if (runId === currentRunId) {
              pyExecuting = false;
              activePyRunPromise = null;
              Logger.flush();
              updateUI(false);
            }
          }
        })();

        activePyRunPromise = runTask;
        await runTask;
      } else {
        isRunning = true;
        activeRuntime = "js";
        updateUI(true);
        try {
          Logger.log(`Starting [${langLabel}] ${target.name} (${sizeKb} KB, ${projectFiles.length} workspace file(s))...`, "RUNTIME");
          const html = await Bundler.buildStandalone(target, projectFiles);
          if (runId !== currentRunId) return;
          DOM.canvasContainer.classList.add("hidden");
          const sandbox = DOM.resetSandbox();
          sandbox.classList.remove("hidden");
          sandbox.srcdoc = html;
          Logger.log(`Mounted sandbox iframe (${(html.length / 1024).toFixed(1)} KB srcdoc)`, "RUNTIME");
        } catch (e) {
          if (runId !== currentRunId) return;
          Logger.log(`Build Error: ${e?.stack || e?.message || e}`, "ERR");
          DOM.logsDrawer.classList.remove("translate-y-full");
          isRunning = false;
          activeRuntime = null;
        } finally {
          if (runId === currentRunId) updateUI(false);
        }
      }
    }

    async function handleSelectionActivation(rawVal) {
      if (!rawVal) return;
      if (rawVal.startsWith("file:")) {
        const fileName = rawVal.slice(5);
        await execEntry(false, fileName);
        return;
      }
      if (rawVal.startsWith("builtin:")) {
        const id = rawVal.slice(8);
        const proj = builtinProjects.find((p) => p.id === id);
        if (!proj) return;
        await stopExecution(true);
        const loadId = ++currentRunId;
        Logger.clear();
        Logger.log(`Loading built-in project: [${proj.lang}] ${proj.name}...`, "PROJECT");
        updateUI(true);
        try {
          const t0 = performance.now();
          const files = await Archive.loadProjectFiles(proj);
          if (loadId !== currentRunId) return;
          if (!files.length) throw new Error("No runnable files found in project.");
          projectFiles = files;
          activeBuiltinId = proj.id;
          const totalBytes = projectFiles.reduce((acc, f) => acc + getByteSize(f.content), 0);
          Logger.log(
            `Loaded ${projectFiles.length} file(s) (${(totalBytes / 1024).toFixed(2)} KB) in ${(performance.now() - t0).toFixed(0)}ms: ${projectFiles.map((f) => f.name).join(", ")}`,
            "PROJECT"
          );
          const entry = findDefaultEntry(projectFiles, proj.entry);
          syncUnifiedSelectors(entry);
          updateUI(false);
          await execEntry(false, entry);
        } catch (e) {
          if (loadId !== currentRunId) return;
          Logger.log(`Load error: ${e?.stack || e?.message || e}`, "ERR");
          DOM.logsDrawer.classList.remove("translate-y-full");
          updateUI(false);
        }
      }
    }

    async function handleUpload(fileList) {
      const rawFiles = [...(fileList || [])];
      if (!rawFiles.length) return;
      await stopExecution(true);
      const uploadId = ++currentRunId;
      Logger.clear();
      Logger.log(`Processing ${rawFiles.length} uploaded item(s)...`, "UPLOAD");
      updateUI(true);
      try {
        const t0 = performance.now();
        const parsed = await Archive.parseUploadedFiles(rawFiles);
        if (uploadId !== currentRunId) return;
        projectFiles = parsed;
        activeBuiltinId = "";
        if (!projectFiles.length) {
          syncUnifiedSelectors();
          return updateUI(false);
        }
        const totalBytes = projectFiles.reduce((acc, f) => acc + getByteSize(f.content), 0);
        const defaultEntry = findDefaultEntry(projectFiles);
        syncUnifiedSelectors(defaultEntry);
        updateUI(false);
        Logger.log(
          `Extracted ${projectFiles.length} workspace file(s) (${(totalBytes / 1024).toFixed(1)} KB) in ${(performance.now() - t0).toFixed(0)}ms: ${projectFiles.map((f) => f.name).join(", ")}`,
          "UPLOAD"
        );
        await execEntry(false, defaultEntry);
      } catch (e) {
        if (uploadId !== currentRunId) return;
        Logger.log(`Upload error: ${e?.stack || e?.message || e}`, "ERR");
        DOM.logsDrawer.classList.remove("translate-y-full");
        updateUI(false);
      }
    }

    async function refreshBuiltinList() {
      updateUI(true);
      try {
        const t0 = performance.now();
        builtinProjects = await Archive.discoverBuiltins();
        syncUnifiedSelectors(projectFiles.length ? getSelectedEntryName() : "");
        Logger.log(
          `Discovered ${builtinProjects.length} built-in project(s) in ${(performance.now() - t0).toFixed(0)}ms: ${builtinProjects.map((p) => `[${p.lang}] ${p.name}`).join(", ")}`,
          "SYS"
        );
      } catch (e) {
        Logger.log(`Failed scanning built-in projects: ${e.message || e}`, "ERR");
      } finally {
        updateUI(false);
      }
    }

    DOM.backBtn.onclick = collapseViewport;
    DOM.viewActiveBtn.onclick = expandViewport;
    DOM.fullscreenBtn.onclick = async () => {
      if (!document.fullscreenElement) await DOM.runnerViewport.requestFullscreen?.();
      else await document.exitFullscreen?.();
    };
    document.addEventListener("fullscreenchange", () => {
      const isFs = Boolean(document.fullscreenElement);
      DOM.fullscreenBtn.textContent = isFs ? "⤓ Exit Fullscreen" : "⛶ Fullscreen";
      Logger.log(`Viewport fullscreen ${isFs ? "enabled" : "exited"}`, "UI");
    });

    DOM.toggleLogsBtn.onclick = () => DOM.logsDrawer.classList.toggle("translate-y-full");
    DOM.closeLogsBtn.onclick = () => DOM.logsDrawer.classList.add("translate-y-full");
    DOM.clearBtn.onclick = () => { Logger.clear(); PythonRuntime.pyApi?.clearOverlay(); };

    DOM.fileInput.onchange = DOM.folderInput.onchange = async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = "";
      await handleUpload(files);
    };

    DOM.builtinSelect.onchange = () => handleSelectionActivation(DOM.builtinSelect.value);
    DOM.loadBuiltinBtn.onclick = () => handleSelectionActivation(DOM.builtinSelect.value);
    DOM.refreshBuiltinBtn.onclick = () => refreshBuiltinList();

    DOM.entrySelect.onchange = () => handleSelectionActivation(DOM.entrySelect.value);
    DOM.runBtn.onclick = () => handleSelectionActivation(DOM.entrySelect.value);
    DOM.stopBtn.onclick = () => stopExecution(false);
    DOM.downloadBtn.onclick = () => execEntry(true);

    Logger.log(
      `Host environment ready (crossOriginIsolated=${Boolean(window.crossOriginIsolated)}, SharedArrayBuffer=${typeof SharedArrayBuffer !== "undefined"}, cores=${navigator.hardwareConcurrency || "n/a"})`,
      "ENV"
    );
    PythonRuntime.initIframeRuntime().catch(() => {});
    refreshBuiltinList();
  })();
  //#endregion
})();