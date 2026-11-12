(async () => {
  //#region 1: ExternalDependencies
  window.coi = document.coi = {
    shouldRegister: () => !window.crossOriginIsolated,
    shouldDeregister: () => false,
    coepCredentialless: () => true,
    coepDegrade: () => true,
    doReload: () => window.location.reload(),
    quiet: false,
    ...window.coi,
    ...document.coi
  };
  if (!window.crossOriginIsolated && window.isSecureContext && "serviceWorker" in navigator) {
    const coiScript = document.createElement("script");
    coiScript.src = "./coi-serviceworker.min.js";
    document.head.appendChild(coiScript);
  }

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
            <button id="backBtn" class="${btnSec}" title="Back to uploads">📁 Uploads</button>
            <span class="text-xs font-semibold text-zinc-400">Entry:</span>
            <select id="entrySelect" disabled class="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-md px-2.5 py-1 outline-none focus:border-blue-500 cursor-pointer disabled:opacity-40">
              <option>No files uploaded</option>
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
          <iframe id="sandbox" class="w-full h-full border-0 block bg-white" sandbox="allow-scripts allow-modals allow-forms allow-popups"></iframe>
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
          <pre id="logs" class="flex-1 p-3 font-mono text-xs text-zinc-300 overflow-auto whitespace-pre-wrap break-all leading-relaxed">Waiting for files...</pre>
        </div>
      </div>
    `;

    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    while (wrapper.firstChild) document.body.appendChild(wrapper.firstChild);

    const $ = (id) => document.getElementById(id);
    const refs = {
      fileInput: $("fileInput"), folderInput: $("folderInput"), entrySelect: $("entrySelect"),
      runBtn: $("runBtn"), stopBtn: $("stopBtn"), downloadBtn: $("downloadBtn"), clearBtn: $("clearBtn"),
      sandbox: $("sandbox"), canvasContainer: $("canvasContainer"), logsEl: $("logs"),
      runnerViewport: $("runnerViewport"), mainDashboard: $("mainDashboard"), backBtn: $("backBtn"),
      viewActiveBtn: $("viewActiveBtn"), fullscreenBtn: $("fullscreenBtn"), toggleLogsBtn: $("toggleLogsBtn"),
      logsDrawer: $("logsDrawer"), closeLogsBtn: $("closeLogsBtn"),
      resetSandbox() {
        const fresh = document.createElement("iframe");
        fresh.id = "sandbox";
        fresh.className = refs.sandbox.className;
        fresh.setAttribute("sandbox", "allow-scripts allow-modals allow-forms allow-popups");
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

    const flush = () => {
      if (!logBuf.length) return;
      const comb = DOM.logsEl.textContent + logBuf.join("\n") + "\n";
      DOM.logsEl.textContent = comb.length > 1e5 ? "...[truncated]...\n" + comb.slice(-1e5) : comb;
      logBuf = [];
      raf = null;
      DOM.logsEl.scrollTop = DOM.logsEl.scrollHeight;
    };

    const log = (m) => {
      logBuf.push(String(m ?? "").replace(/\n$/, ""));
      raf = raf || requestAnimationFrame(flush);
    };

    const clear = () => {
      logBuf = [];
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      DOM.logsEl.textContent = "";
    };

    window.addEventListener("message", ({ source, data }) => {
      if (source === DOM.sandbox.contentWindow && data?.type === "SANDBOX_LOG") {
        log(`[${String(data.level || "LOG").toUpperCase()}] ${(Array.isArray(data.messages) ? data.messages : [data.messages ?? ""]).join(" ")}`);
      }
    });

    return { log, flush, clear };
  })();
  //#endregion

  //#region 4: FileSystemAndPathUtilities
  const FSUtils = (() => {
    const IGNORED = /(?:^|\/)(?:node_modules|\.git|dist|build|\.next|coverage|out|\.vscode|__pycache__|__MACOSX)\//i;
    const TEXT_EXTS = /\.(?:py|txt|csv|json|html?|xml|md|sql|[jt]sx?|mjs|cjs|qjs|css|svg)$/i;
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
    const toStr = (c) => (typeof c === "string" ? c : new TextDecoder().decode(c));

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
      TEXT_EXTS, MIME, isPy, isHtml, isTsOrJs, isZip, toStr, sanitizePath, toB64,
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
        Logger.log("Initializing esbuild-wasm...");
        esbuildInit = esbuild.initialize({ wasmURL: "https://esm.sh/esbuild-wasm@0.28.2/esbuild.wasm", worker: true })
          .catch((e) => { esbuildInit = null; throw e; });
      }
      await esbuildInit;
      const isReact = FSUtils.isReactProj(files);

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
              if (/^(?:https?:|data:|blob:)/i.test(a.path)) return { path: a.path, external: true };
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
              return { path: `https://esm.sh/${a.path}${extQ}`, external: true };
            });

            b.onLoad({ filter: /.*/, namespace: "vfs" }, async (a) => {
              if (a.path === "__r__") return { contents: SHIM_R, loader: "js" };
              if (a.path === "__rx__") return { contents: SHIM_RX, loader: "js" };
              if (a.path === "__rd__") return { contents: SHIM_RD, loader: "js" };

              const { cleanPath, query } = FSUtils.splitQuery(a.path);
              const params = new URLSearchParams(query.replace(/^\?/, ""));
              const m = FSUtils.findFile(files, cleanPath);
              if (!m) return { errors: [{ text: `Module not found: ${cleanPath}` }] };

              const ext = m.path.split(".").pop()?.toLowerCase() ?? "";
              const raw = FSUtils.toStr(m.content);

              if (params.has("raw")) return { contents: raw, loader: "text" };
              if (params.has("worker") || params.has("sharedworker") || (params.has("url") && FSUtils.isTsOrJs(m.path))) {
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
      const out = res.outputFiles[0].text;
      return isWorker ? wrapWorkerEsm(out) : out;
    }

    function createSandboxHtml(codeOrHtml, isHtmlEntry = false, isReactProject = true) {
      const harness = `<script>(() => {
        try { localStorage.getItem("__t"); } catch {
          const ms = () => { let s = {}; return { getItem: k => Object.hasOwn(s, k) ? s[k] : null, setItem: (k, v) => { s[k] = String(v); }, removeItem: k => { delete s[k]; }, clear: () => { s = {}; }, key: i => Object.keys(s)[i] ?? null, get length() { return Object.keys(s).length; } }; };
          try { Object.defineProperty(window, "localStorage", { value: ms(), configurable: true }); Object.defineProperty(window, "sessionStorage", { value: ms(), configurable: true }); } catch {}
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
        window.__createVirtualWorker = (codeOrPromise) => {
          const ht = new EventTarget(), wt = new EventTarget(), mc1 = new MessageChannel(), mc2 = new MessageChannel();
          const wq = [], hq = []; let started = false, closed = false, wom = null, woe = null, hom = null, hoe = null;
          mc1.port2.onmessage = () => { if (!closed && started) while (wq.length && !closed) wt.dispatchEvent(new MessageEvent("message", { data: wq.shift() })); };
          mc2.port2.onmessage = () => { if (!closed) while (hq.length && !closed) ht.dispatchEvent(new MessageEvent("message", { data: hq.shift() })); };
          const close = () => { closed = true; wq.length = hq.length = 0; mc1.port1.close(); mc1.port2.close(); mc2.port1.close(); mc2.port2.close(); };
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
          }).catch(e => { hoe?.(new ErrorEvent("error", { error: e, message: e?.message || String(e) })); });
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
          if (window.__vfsWorkerCodeMap.has(s)) return window.__createVirtualWorker(window.__vfsWorkerCodeMap.get(s));
          if (window.__vfsBlobMap.has(s)) return window.__createVirtualWorker(window.__vfsBlobMap.get(s).text());
          return new NW(u, o);
        };
        window.Worker.prototype = NW.prototype;
        for (const l of ["log", "info", "warn", "error"]) {
          const o = console[l];
          console[l] = (...a) => { try { parent.postMessage({ type: "SANDBOX_LOG", level: l, messages: a.map(v => typeof v === "object" ? JSON.stringify(v) : String(v)) }, "*"); } catch {} o?.apply(console, a); };
        }
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
  const u = URL.createObjectURL(new Blob([${safeCode}], { type: "application/javascript" }));
  try {
    const m = await import(u);
    if (${Boolean(isReactProject)}) {
      const C = m.default || m.App || m.Main, r = document.getElementById("root");
      if ((window.React?.isValidElement(C) || typeof C === "function" || (C && typeof C === "object" && "$$typeof" in C)) && r && !r.hasChildNodes())
        window.ReactDOM.createRoot(r).render(window.React.isValidElement(C) ? C : window.React.createElement(C));
    }
  } catch (e) { console.error(e); } finally { URL.revokeObjectURL(u); }
<\/script></body></html>`;
    }

    async function buildStandalone(target, projectFiles) {
      const fileMap = FSUtils.toFileMap(projectFiles), isReact = FSUtils.isReactProj(fileMap), t0 = performance.now();
      if (FSUtils.isHtml(target.name)) {
        Logger.log(`Bundling HTML entry: ${target.name}...`);
        const doc = new DOMParser().parseFromString(FSUtils.toStr(target.content), "text/html");
        for (const l of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
          const res = FSUtils.resolvePath(target.name, l.getAttribute("href")), m = FSUtils.findFile(fileMap, res);
          if (m) {
            const s = doc.createElement("style");
            s.textContent = FSUtils.toStr(m.content).replace(/<\/style>/gi, "<\\/style>");
            l.replaceWith(s);
          }
        }
        for (const s of doc.querySelectorAll("script[src]")) {
          const res = FSUtils.resolvePath(target.name, s.getAttribute("src")), entry = res.startsWith("/") ? res : `/workspace/${res}`;
          if (FSUtils.findFile(fileMap, entry)) {
            const inl = doc.createElement("script");
            inl.type = "module";
            inl.textContent = (await bundleCode(entry, fileMap)).replace(/<\/script>/gi, "<\\/script>");
            s.replaceWith(inl);
          }
        }
        Logger.log(`Bundled ${target.name} in ${(performance.now() - t0).toFixed(0)}ms`);
        return createSandboxHtml("<!DOCTYPE html>\n" + doc.documentElement.outerHTML, true, isReact);
      }
      Logger.log(`Bundling TS/JS entry: ${target.name}...`);
      const js = await bundleCode(`/workspace/${target.name.replaceAll("\\", "/").replace(/^\/+/, "")}`, fileMap);
      Logger.log(`Bundled ${target.name} in ${(performance.now() - t0).toFixed(0)}ms`);
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
import ast, asyncio, base64, builtins, concurrent.futures as cf, io, js, micropip, os, pyodide, pyodide.code, pyodide.ffi, pyodide_js, re, shutil, sys, time, tokenize
_WORKSPACE_ROOT = "/workspace"
os.makedirs(_WORKSPACE_ROOT, exist_ok=True); os.chdir(_WORKSPACE_ROOT)
_ORIG_SLEEP = time.sleep
_ORIG_ASYNC_SLEEP = asyncio.sleep
_ORIG_CREATE_TASK = asyncio.create_task
_ORIG_ENSURE_FUTURE = asyncio.ensure_future
_ORIG_CREATE_PROXY = pyodide.ffi.create_proxy
_ORIG_CREATE_ONCE = pyodide.ffi.create_once_callable
_BASELINE_MODULES = set(sys.modules.keys())
_stop_requested = False
_in_user_code = False
_run_gen = 0
_tasks = set()
_handles = set()
_proxies = []
_current_main_task = None
PKG = {"PIL":"pillow","cv2":"opencv-python","sklearn":"scikit-learn","bs4":"beautifulsoup4","yaml":"pyyaml","pygame":"pygame-ce","turtle":"basthon-turtle"}

def _track_task(t):
    if _in_user_code and isinstance(t, asyncio.Future):
        _tasks.add(t)
        t.add_done_callback(lambda x: _tasks.discard(x))
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

        def _guard(fn):
            def _w(*a, **k):
                if _stop_requested:
                    _stop_pygame_audio()
                    raise KeyboardInterrupt("Execution stopped")
                return fn(*a, **k)
            return _w

        if hasattr(pygame, "display"):
            pygame.display.flip = _guard(pygame.display.flip)
            pygame.display.update = _guard(pygame.display.update)
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

    for m in list(sys.modules.keys()):
        if m not in _BASELINE_MODULES:
            mod = sys.modules.get(m)
            f = getattr(mod, "__file__", "") or ""
            if f.startswith(_WORKSPACE_ROOT) or f.startswith("<"):
                sys.modules.pop(m, None)

    abs_entry = os.path.normpath(os.path.join(_WORKSPACE_ROOT, entry_rel))
    entry_dir = os.path.dirname(abs_entry)
    os.chdir(entry_dir); sys.path[:] = [entry_dir, _WORKSPACE_ROOT] + [p for p in sys.path if p not in (entry_dir, _WORKSPACE_ROOT)]
    with tokenize.open(abs_entry) as fp: code = fp.read()

    found = set(pyodide.code.find_imports(code))
    if found and not _stop_requested:
        try: await pyodide_js.loadPackagesFromImports("\n".join(f"import {m}" for m in found))
        except: pass
    for p in found:
        if _stop_requested: break
        if not sys.modules.get(p):
            try: await micropip.install(PKG.get(p, p))
            except: pass

    if _stop_requested:
        return None

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
            raise
    finally:
        if _current_main_task is asyncio.current_task():
            _current_main_task = None
`;

    const IFRAME_HTML = `<!DOCTYPE html><html><head>
<script src="https://unpkg.com/@tailwindcss/browser@4"><\/script>
<style type="text/tailwindcss">@import "tailwindcss";</style>
<style>*{margin:0;box-sizing:border-box}body{background:#000;color:#fff;overflow:hidden;width:100vw;height:100vh}#canvas{position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;outline:0}#o{position:fixed;inset:0;padding:12px;font:14px monospace;overflow:auto;pointer-events:none;text-shadow:0 1px 2px #000}</style>
</head><body><canvas id="canvas" width="960" height="600" tabindex="-1"></canvas><pre id="o"></pre>
<script type="module">
import * as Comlink from "https://cdn.jsdelivr.net/npm/comlink@4.4.2/+esm";
const canvas=document.getElementById("canvas"), o=document.getElementById("o"), W="/workspace";
window.canvas = canvas;
window.c = canvas;
let py=null, pyP=null, bootCode="", intBuf=null, onLog=null, onErr=null;
let stopped=false, tracking=false, currentEpoch=0;

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
const log = (t, err=false) => { o.append(t + "\\n"); o.scrollTop = o.scrollHeight; (err && onErr ? onErr : onLog)?.(t); };
async function ensurePy() {
  if (pyP) return pyP;
  return pyP = (async () => {
    o.textContent = "Loading Pyodide WebAssembly...";
    const { loadPyodide } = await import("https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.mjs");
    py = await loadPyodide({ stdout: s => log(s), stderr: s => log(s, true) });
    py._module.canvas = canvas;
    py.canvas?.setCanvas2D?.(canvas);
    py.canvas?.setCanvas3D?.(canvas);
    if (intBuf) try { py.setInterruptBuffer(intBuf); } catch {}
    await py.loadPackage(["micropip"]);
    if (bootCode) py.runPython(bootCode);
    return py;
  })();
}
Comlink.expose({
  configure(b, out, err, sb) { bootCode = b; onLog = out; onErr = err; if (sb) intBuf = new Uint8Array(sb); },
  async sync(files) {
    const p = await ensurePy();
    stopped = true; tracking = false;
    try { p.runPython("_reset_workspace()"); } catch {}
    cleanupRuntime();
    for (const { name, content } of files) {
      const full = W + "/" + name, d = full.slice(0, full.lastIndexOf("/"));
      if (d) try { p.FS.mkdirTree(d); } catch {}
      p.FS.writeFile(full, typeof content === "string" ? new TextEncoder().encode(content) : content);
    }
  },
  async runFile(entry) {
    if (intBuf) intBuf[0] = 0;
    const p = await ensurePy();
    cleanupRuntime();
    try { p.runPython("_prepare_run()"); } catch {}
    stopped = false; tracking = true;
    canvas.focus(); o.textContent = "";
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
          await pyApi.configure(PYTHON_BOOT_CODE, Comlink.proxy(Logger.log), Comlink.proxy((m) => Logger.log(`[ERR] ${m}`)), interruptBuffer);
        } catch (err) {
          Logger.log(`[ERR] Failed initializing Python runner: ${err.message || err}`);
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
      const entryCode = files.find((f) => f.name === entryName)?.content || "";
      const serializedFiles = JSON.stringify(files).replace(/<\/script>/gi, "<\\/script>");
      return `<!DOCTYPE html><html lang="en" class="bg-zinc-950 text-zinc-100"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${entryName} - Standalone</title><script src="https://unpkg.com/@tailwindcss/browser@4"><\/script><style type="text/tailwindcss">@import "tailwindcss";</style><script src="https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.js"><\/script></head><body class="p-4 flex flex-col gap-3 min-h-screen font-mono"><div class="flex items-center justify-between border-b border-zinc-800 pb-2"><h3 class="font-bold text-sm text-blue-400">${entryName}</h3><div id="st" class="text-xs text-zinc-400">Loading Pyodide...</div></div><canvas id="canvas" width="960" height="600" tabindex="1" class="w-full max-h-[70vh] bg-black border border-zinc-800 rounded-lg object-contain"></canvas><pre id="o" class="bg-zinc-900 border border-zinc-800 p-3 rounded-lg text-xs overflow-auto max-h-48 whitespace-pre-wrap"></pre><script>
const st=document.getElementById("st"), o=document.getElementById("o"), canvas=document.getElementById("canvas");
window.canvas = canvas;
const print=(m)=>{ o.textContent+=m+"\\n"; o.scrollTop=o.scrollHeight; };
async function init(){
  try{
    const pyodide=await loadPyodide({stdout:print,stderr:print}); pyodide.canvas.setCanvas2D(canvas);
    for(const f of ${serializedFiles}){
      const d=f.name.slice(0,f.name.lastIndexOf("/")); if(d) try{pyodide.FS.mkdirTree(d)}catch{}
      pyodide.FS.writeFile(f.name, f.isBinary ? Uint8Array.from(atob(f.content), x=>x.charCodeAt(0)) : f.content);
    }
    await pyodide.loadPackage(["micropip"]);
    try{await pyodide.loadPackagesFromImports(${JSON.stringify(entryCode)})}catch{}
    st.textContent="Running..."; 
    await pyodide.runPythonAsync("import builtins, js; builtins.canvas = js.document.getElementById('canvas');\\n" + ${JSON.stringify(entryCode)});
    st.textContent="Finished.";
  }catch(e){ st.textContent="Error: "+e.message; print("[Error] "+e.message); }
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

  //#region 7: ArchiveAndUploadManager
  const Archive = (() => {
    async function extractZipEntries(zipFile) {
      const u8 = new Uint8Array(await zipFile.arrayBuffer());
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

    return { parseUploadedFiles };
  })();
  //#endregion

  //#region 8: UIControllerAndAppBootstrap
  (() => {
    let projectFiles = [], isRunning = false, pyExecuting = false, activeRuntime = null, busy = false;
    let currentRunId = 0, activePyRunPromise = null;

    const updateUI = (isBusy = busy) => {
      busy = isBusy;
      const has = projectFiles.length > 0;
      DOM.fileInput.disabled = DOM.folderInput.disabled = false;
      DOM.entrySelect.disabled = busy || !has;
      DOM.runBtn.disabled = busy || !has;
      DOM.downloadBtn.disabled = busy || !has;
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

    const findDefaultEntry = (files) => {
      const cands = ["index.html", "main.py", "index.tsx", "app.tsx", "main.tsx", "app.py", "index.py", "run.py", "index.ts", "main.ts", "index.js", "main.js"];
      for (const c of cands) {
        const f = files.find((x) => x.name.split("/").at(-1)?.toLowerCase() === c);
        if (f) return f.name;
      }
      return (files.find((f) => FSUtils.isPy(f.name) || FSUtils.isTsOrJs(f.name) || FSUtils.isHtml(f.name)) ?? files[0])?.name || "";
    };

    async function stopExecution(silent = false) {
      currentRunId++;
      const wasRunning = isRunning || pyExecuting || activeRuntime !== null;

      DOM.resetSandbox();

      if (PythonRuntime.interruptView) PythonRuntime.interruptView[0] = 2;
      try { await PythonRuntime.pyApi?.stop(); } catch {}

      if (!silent && wasRunning) Logger.log("Execution stopped.");

      if (pyExecuting && activePyRunPromise) {
        const stoppedCleanly = await Promise.race([
          activePyRunPromise.then(() => true, () => true),
          new Promise((res) => setTimeout(() => res(false), 300))
        ]);
        if (!stoppedCleanly) {
          Logger.log("[WARN] Resetting unresponsive runner...");
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
          Logger.log(`Exporting standalone HTML for ${target.name}...`);
          const html = PythonRuntime.generateStandaloneHtml(target.name, await PythonRuntime.prepareFilesForStandalone(projectFiles));
          const a = Object.assign(document.createElement("a"), {
            href: URL.createObjectURL(new Blob([html], { type: "text/html" })),
            download: `${target.name.split("/").pop().replace(/\.[^.]+$/, "") || "py_app"}.standalone.html`
          });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          Logger.log("Exported standalone Python file successfully!");
        } else {
          const html = await Bundler.buildStandalone(target, projectFiles);
          const a = Object.assign(document.createElement("a"), {
            href: URL.createObjectURL(new Blob([html], { type: "text/html" })),
            download: `${target.name.split("/").pop().replace(/\.[^.]+$/, "") || "bundle"}.standalone.html`
          });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          Logger.log(`Exported standalone bundle for ${target.name}`);
        }
      } catch (e) {
        Logger.log(`Export Error: ${e.message || e}`);
        DOM.logsDrawer.classList.remove("translate-y-full");
      } finally {
        updateUI(false);
      }
    }

    async function execEntry(download = false) {
      const target = projectFiles.find((f) => f.name === DOM.entrySelect.value);
      if (!target) return;
      if (download) return exportEntry(target);

      await stopExecution(true);
      const runId = ++currentRunId;
      expandViewport();

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
            Logger.log(`Running ${target.name}...`);
            const t0 = performance.now();
            await PythonRuntime.pyApi.sync(projectFiles.map((f) => ({ name: f.name, content: f.content })));
            if (runId !== currentRunId) return;
            await PythonRuntime.pyApi.runFile(target.name);
            if (runId !== currentRunId) return;
            Logger.log(`Execution completed in ${(performance.now() - t0).toFixed(0)}ms`);
          } catch (err) {
            if (runId !== currentRunId) return;
            Logger.log(`Error: ${err?.message || err}`);
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
          const html = await Bundler.buildStandalone(target, projectFiles);
          if (runId !== currentRunId) return;
          DOM.canvasContainer.classList.add("hidden");
          const sandbox = DOM.resetSandbox();
          sandbox.classList.remove("hidden");
          sandbox.srcdoc = html;
        } catch (e) {
          if (runId !== currentRunId) return;
          Logger.log(`Build Error: ${e.message || e}`);
          DOM.logsDrawer.classList.remove("translate-y-full");
          isRunning = false;
          activeRuntime = null;
        } finally {
          if (runId === currentRunId) updateUI(false);
        }
      }
    }

    async function handleUpload(fileList) {
      const rawFiles = [...(fileList || [])];
      if (!rawFiles.length) return;
      await stopExecution(true);
      const uploadId = ++currentRunId;
      Logger.clear();
      Logger.log("Loading files...");
      updateUI(true);
      try {
        const parsed = await Archive.parseUploadedFiles(rawFiles);
        if (uploadId !== currentRunId) return;
        projectFiles = parsed;
        if (!projectFiles.length) {
          DOM.entrySelect.innerHTML = "<option>No valid files found</option>";
          return updateUI(false);
        }
        DOM.entrySelect.innerHTML = projectFiles.map((f) => `<option>${f.name}</option>`).join("");
        DOM.entrySelect.value = findDefaultEntry(projectFiles);
        updateUI(false);
        Logger.log(`Loaded ${projectFiles.length} file(s).`);
        await execEntry(false);
      } catch (e) {
        if (uploadId !== currentRunId) return;
        Logger.log(`Upload error: ${e.message || e}`);
        DOM.logsDrawer.classList.remove("translate-y-full");
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
      DOM.fullscreenBtn.textContent = document.fullscreenElement ? "⤓ Exit Fullscreen" : "⛶ Fullscreen";
    });

    DOM.toggleLogsBtn.onclick = () => DOM.logsDrawer.classList.toggle("translate-y-full");
    DOM.closeLogsBtn.onclick = () => DOM.logsDrawer.classList.add("translate-y-full");
    DOM.clearBtn.onclick = () => { Logger.clear(); PythonRuntime.pyApi?.clearOverlay(); };

    DOM.fileInput.onchange = DOM.folderInput.onchange = async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = "";
      await handleUpload(files);
    };

    DOM.entrySelect.onchange = () => execEntry(false);
    DOM.runBtn.onclick = () => execEntry(false);
    DOM.stopBtn.onclick = () => stopExecution(false);
    DOM.downloadBtn.onclick = () => execEntry(true);

    PythonRuntime.initIframeRuntime().catch(() => {});
  })();
  //#endregion
})();