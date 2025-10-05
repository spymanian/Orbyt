import * as vscode from "vscode";
import * as fs from "fs";
import ignore from "ignore";
import { execSync } from "child_process";
import Graph from "graphology";
import * as babelParser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import dotenv from "dotenv";
import * as path from "path";

// Explicitly load .env from project root (one level up from /out)
const envPath = path.join(__dirname, "..", ".env");
dotenv.config({ path: envPath });

console.log("📂 Loading .env from:", envPath);
console.log("🔑 GEMINI_API_KEY loaded?", !!process.env.GEMINI_API_KEY);



// ✅ Use native fetch (no need for node-fetch)
const fetchFn: typeof fetch = globalThis.fetch;

/** Type for node attributes */
type NodeData = {
  id: string;
  label: string;
  cluster: string;
  path: string;
  loc: number;
  complexity: number;
  commits: number;
  color: string;
  size: number;
};

/** 🧩 Activate extension */
export function activate(context: vscode.ExtensionContext) {
  console.log("🚀 Orbyt (CodeAtlas) activated!");

  const disposable = vscode.commands.registerCommand("orbyt.start", async () => {
    const panel = vscode.window.createWebviewPanel(
      "orbyt",
      "🌌 Orbyt – Codebase Visualizer",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const graphologyUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "graphology.umd.min.js")
    );
    const sigmaUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "sigma.min.js")
    );

    const cspSource = panel.webview.cspSource;
    panel.webview.html = getWebviewContent(graphologyUri.toString(), sigmaUri.toString(), cspSource);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ready") {
        vscode.window.showInformationMessage("🧩 Generating CodeAtlas...");
        const repoGraph = await buildRepoGraph();
        panel.webview.postMessage({ type: "graphData", data: repoGraph });
      } else if (msg.type === "openFile") {
        const fileUri = vscode.Uri.file(msg.path);
        await vscode.window.showTextDocument(fileUri);
      } else if (msg.type === "explainFile") {
        const code = fs.readFileSync(msg.path, "utf8");
        const explanation = await getGeminiExplanation(msg.path, code);
        panel.webview.postMessage({ type: "explanation", path: msg.path, explanation });
      }
    });
  });

  context.subscriptions.push(disposable);
}

/** 🧠 Build repository dependency graph */
/** 🧠 Build repository dependency graph with folder encapsulation */
export async function buildRepoGraph() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders){
    return { nodes: [], edges: [], stats: {} };
  } 

  const root = workspaceFolders[0].uri.fsPath;
  const gitignorePath = path.join(root, ".gitignore");
  const ig = ignore();
  if (fs.existsSync(gitignorePath)){
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  } 

  const files: string[] = [];
  const exts = /\.(js|ts|jsx|tsx|py|java|cpp|c|cs|php|rb|go|rs|html|css|json|sh|yml|yaml)$/i;

  /** 🔍 Walk the directory recursively */
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (ig.ignores(rel)){
        continue;
      }
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "dist", "out", ".next", "build"].includes(entry.name)) {
          walk(full);
        }
      } else if (exts.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(root);

  const graph = new Graph();
  const fileIndex = new Map<string, string>();
  const folderSet = new Set<string>();

  /** 📁 Collect all folder paths */
  for (const f of files) {
    const rel = path.relative(root, f);
    const parts = rel.split(path.sep);
    for (let i = 0; i < parts.length - 1; i++) {
      folderSet.add(parts.slice(0, i + 1).join(path.sep));
    }
  }

  /** 🎨 Create folder nodes */
  for (const folder of folderSet) {
    const depth = folder.split(path.sep).length;
    const color = clusterColor(folder, depth);
    if (!graph.hasNode(folder)) {
      graph.addNode(folder, {
        id: folder,
        label: "📁 " + path.basename(folder),
        cluster: folder,
        path: path.join(root, folder),
        loc: 0,
        complexity: 0,
        commits: 0,
        color,
        size: 12 + Math.max(0, 3 - depth) * 2,
      });
    }
  }

  /** 🧩 Add parent→child folder edges */
  for (const folder of folderSet) {
    const parent = path.dirname(folder);
    if (parent && parent !== "." && graph.hasNode(parent)) {
      graph.addEdge(parent, folder, { color: "rgba(255,255,255,0.15)", size: 0.6 });
    }
  }

  /** 🗂️ Add file nodes and link them to folders */
  for (const f of files) {
    fileIndex.set(path.basename(f), f);
    let content = "";
    try { content = fs.readFileSync(f, "utf8"); } catch {}
    const loc = content.split("\n").length;
    const complexity = (content.match(/\b(if|for|while|case|catch|&&|\|\|)\b/g) || []).length + 1;

    let commits = 0;
    try {
      const out = execSync(`git log --oneline -- "${f}"`, { cwd: root, encoding: "utf8" });
      commits = out.split("\n").filter(Boolean).length;
    } catch {}

    const rel = path.relative(root, f);
    const folder = path.dirname(rel) || "(root)";
    const color = clusterColor(folder, folder.split(path.sep).length + 1);

    graph.addNode(f, {
      id: f,
      label: path.basename(f),
      cluster: folder,
      path: f,
      loc,
      complexity,
      commits,
      color,
      size: Math.max(4, Math.min(14, 5 + Math.log10(loc + 1))),
    });

    // connect to encapsulating folder
    if (graph.hasNode(folder)) {
      graph.addEdge(folder, f, { color: "rgba(255,255,255,0.2)", size: 0.7 });
    }
  }

  /** 🔗 Parse imports & connect across folders */
  for (const file of files) {
    let content = "";
    try { content = fs.readFileSync(file, "utf8"); } catch {}
    const imports: string[] = [];
    try {
      if (/\.(js|ts|jsx|tsx)$/i.test(file)) {
        const ast = babelParser.parse(content, {
          sourceType: "unambiguous",
          plugins: ["typescript", "jsx", "classProperties", "decorators-legacy"],
        });
        traverse(ast, {
          ImportDeclaration(p: NodePath<t.ImportDeclaration>) {
            if (p.node.source?.value){
              imports.push(p.node.source.value);
            }
          },
          CallExpression(p: NodePath<t.CallExpression>) {
            if (
              t.isIdentifier(p.node.callee, { name: "require" }) &&
              p.node.arguments[0] &&
              t.isStringLiteral(p.node.arguments[0])
            ) {
              imports.push(p.node.arguments[0].value);
            }
          },
        });
      }
    } catch {}

    const fromFolder = path.dirname(path.relative(root, file)) || "(root)";
    for (const dep of imports) {
      const depFile =
        fileIndex.get(dep) ||
        fileIndex.get(dep + ".js") ||
        fileIndex.get(dep + ".ts") ||
        Array.from(fileIndex.entries()).find(([k]) => dep.endsWith(k))?.[1];
      if (depFile && graph.hasNode(depFile)) {
        const toFolder = path.dirname(path.relative(root, depFile)) || "(root)";
        const intra = fromFolder === toFolder;
        const color = intra ? "rgba(255,255,255,0.08)" : "rgba(78,161,255,0.45)";
        const width = intra ? 0.5 : 1.4;
        graph.addEdge(file, depFile, { color, size: width });
        if (!intra && graph.hasNode(fromFolder) && graph.hasNode(toFolder)) {
          graph.addEdge(fromFolder, toFolder, { color: "rgba(78,161,255,0.6)", size: 2.2 });
        }
      }
    }
  }

  /** 📊 Stats summary */
  const nodes = graph.nodes().map(id => ({ id, ...graph.getNodeAttributes(id) }));
  const edges = graph.edges().map(e => {
    const [from, to] = graph.extremities(e);
    return { from, to };
  });

  const avgComplexity =
    files.length > 0
      ? files.reduce((acc, f) => acc + (graph.getNodeAttribute(f, "complexity") || 0), 0) / files.length
      : 0;

  const mostEdited = [...graph.nodes()]
    .filter(n => graph.getNodeAttribute(n, "commits") > 0)
    .sort((a, b) => (graph.getNodeAttribute(b, "commits") || 0) - (graph.getNodeAttribute(a, "commits") || 0))
    .slice(0, 5)
    .map(n => ({
      file: graph.getNodeAttribute(n, "label"),
      commits: graph.getNodeAttribute(n, "commits"),
    }));

  return {
    nodes,
    edges,
    stats: {
      avgComplexity: avgComplexity.toFixed(2),
      mostEdited,
      totalFiles: files.length,
      clusters: [...new Set((nodes as any[]).map((n: any) => n.cluster))].length,
    },
  };
}

/** 🎨 Folder-aware color palette */
function clusterColor(cluster: string, depth = 1) {
  const base = [
    "#4ea1ff", "#ff9966", "#cc99ff", "#99ff99", "#ffcc66",
    "#ff6699", "#66ffcc", "#aaaaaa", "#ff6666", "#66ff66",
  ];
  let hash = 0;
  for (let i = 0; i < cluster.length; i++) {
    hash = cluster.charCodeAt(i) + ((hash << 5) - hash);
  }
  const baseColor = base[Math.abs(hash) % base.length];
  // Fade brightness by depth
  const fade = Math.max(0.5, 1 - depth * 0.08);
  const c = parseInt(baseColor.slice(1), 16);
  const r = ((c >> 16) & 255) * fade,
        g = ((c >> 8) & 255) * fade,
        b = (c & 255) * fade;
  return `rgb(${r},${g},${b})`;
}


/** 🧠 Gemini explanation generator */
/** 🧠 Gemini explanation generator — simple and clean */
async function getGeminiExplanation(filePath: string, code: string) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return "❌ GEMINI_API_KEY missing.";
  }

  const prompt = `
Explain the purpose and functionality of the file ${path.basename(filePath)} in three short paragraphs:
1. Use a simple analogy understandable by a child.
2. Provide a brief intermediate explanation of what the code does.
3. Give a concise technical description for an expert.
Keep each paragraph under 5 sentences and do not use markdown or formatting.

SEPERATE BY Explain it Like I'm 5, INTERMEDIATE, TECHNICAL as the titles of each paragraph.
Code (first 3000 characters):
${code.slice(0, 3000)}
`;

  try {
    // ✅ Import new Gemini SDK
    const { GoogleGenAI } = await import("@google/genai");

    // ✅ Initialize client
    const ai = new GoogleGenAI({ apiKey: geminiKey });

    // ✅ Request explanation
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    // ✅ Return text result
    return response.text ?? "⚠️ No explanation generated.";
  } catch (err: any) {
    console.error("❌ Gemini error:", err);
    return `❌ Gemini request failed: ${err.message || err}`;
  }
}


/** 🎨 Cluster color palette */


/** 🌐 Webview UI */
/** 🌐 Enhanced Webview UI with animations and guided tour */
/** 🌐 Professional UI/UX Polished Webview */
/** 🌐 Orbyt – polished professional UI/UX with minimap + ripple feedback */
/** 🌐 Orbyt — Polished UI/UX with WORKING Minimap + White Node Labels */
/** 🌐 Orbyt — Fully functional minimap + drag navigation + white labels */
function getWebviewContent(graphologyUri: string, sigmaUri: string, cspSource: string): string {
  const nonce = getNonce();
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src https: data:;
               style-src 'unsafe-inline' ${cspSource};
               script-src 'unsafe-eval' 'nonce-${nonce}' ${cspSource};">
    <title>Orbyt</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg:#ffffff; --fg:#1a1a1a; --card:#f7f8fa;
        --accent:#007aff; --muted:#666; --shadow:rgba(0,0,0,0.08);
        --tooltip-bg:rgba(0,0,0,0.8);
      }
      html,body{
        margin:0;padding:0;width:100%;height:100%;
        background:var(--bg);color:var(--fg);
        font-family:'Inter',sans-serif;overflow:hidden;
        transition:background .4s ease,color .4s ease;
      }
      #graph-container{width:100%;height:100vh;opacity:0;transition:opacity .6s ease;}
      #status{position:absolute;bottom:20px;left:20px;background:var(--card);
        box-shadow:0 2px 10px var(--shadow);border-radius:10px;padding:10px 14px;
        font-size:13px;color:var(--muted);backdrop-filter:blur(6px);}
      .tooltip{position:absolute;background:var(--tooltip-bg);color:#fff;
        border-radius:8px;padding:8px 12px;font-size:13px;opacity:0;
        pointer-events:none;transition:opacity .3s ease,transform .3s ease;
        transform:translateY(4px);}
      .tooltip.show{opacity:1;transform:translateY(0);}
      #infoBox{position:absolute;top:0;right:-360px;width:340px;height:100%;
        background:var(--card);box-shadow:-4px 0 16px var(--shadow);
        padding:24px;font-size:14px;overflow-y:auto;
        transition:right .4s cubic-bezier(.4,0,.2,1);}
      #infoBox.visible{right:0;}
      #infoBox button{margin-top:8px;margin-right:8px;padding:6px 10px;
        border:none;border-radius:6px;background:var(--accent);color:#fff;
        font-weight:500;cursor:pointer;transition:opacity .2s,transform .2s;}
      #infoBox button:hover{opacity:.85;transform:translateY(-1px);}
      #closeInfo{position:absolute;top:12px;right:14px;background:transparent;
        border:none;font-size:18px;color:var(--muted);cursor:pointer;
        transition:color .2s ease,transform .2s ease;}
      #closeInfo:hover{color:var(--accent);transform:scale(1.15);}
      #healthBox{position:absolute;top:20px;left:20px;background:var(--card);
        border-radius:10px;box-shadow:0 2px 8px var(--shadow);
        padding:10px 16px;text-align:center;width:150px;}
      #healthBox h4{margin:4px 0;font-size:14px;color:var(--fg);}
      #paletteOverlay{position:fixed;top:0;left:0;width:100%;height:100%;
        background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);
        display:none;align-items:center;justify-content:center;z-index:999;}
      #paletteBox{background:var(--card);border-radius:10px;
        box-shadow:0 2px 12px var(--shadow);width:360px;padding:20px;}
      #paletteBox input{width:100%;padding:10px;border-radius:6px;
        border:1px solid #ddd;outline:none;font-size:14px;margin-bottom:10px;}
      #paletteList div{padding:6px 8px;border-radius:6px;cursor:pointer;}
      #paletteList div:hover{background:var(--accent);color:#fff;}
      #minimap{position:absolute;top:20px;right:20px;width:180px;height:120px;
        border:2px solid var(--accent);border-radius:8px;background:var(--card);
        box-shadow:0 2px 8px var(--shadow);overflow:hidden;cursor:grab;}
      #miniCanvas{width:100%;height:100%;}
      .ripple{position:absolute;border-radius:50%;transform:scale(0);
        animation:rippleAnim .6s linear;background:rgba(0,122,255,0.25);}
      @keyframes rippleAnim{to{transform:scale(4);opacity:0;}}
    </style>
  </head>
  <body>
    <div id="graph-container"></div>
    <div id="status">🌀 Building your code map...</div>
    <div class="tooltip" id="tooltip"></div>
    <div id="minimap"><canvas id="miniCanvas" width="180" height="120"></canvas></div>

    <div id="healthBox">
      <h4>📊 Health Dashboard</h4>
      <canvas id="healthCanvas" width="120" height="120"></canvas>
      <p id="metricText" style="font-size:12px;color:var(--muted);margin-top:6px;"></p>
    </div>

    <div id="paletteOverlay">
      <div id="paletteBox">
        <input type="text" id="paletteInput" placeholder="Type a command..." />
        <div id="paletteList"></div>
      </div>
    </div>

    <script nonce="${nonce}" src="${graphologyUri}"></script>
    <script nonce="${nonce}" src="${sigmaUri}"></script>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      vscode.postMessage({ type: "ready" });

      const tooltip = document.getElementById("tooltip");
      const status = document.getElementById("status");
      const miniCanvas = document.getElementById("miniCanvas");
      const ctxMini = miniCanvas.getContext("2d");
      const container = document.getElementById("graph-container");
      const paletteOverlay = document.getElementById("paletteOverlay");
      const paletteInput = document.getElementById("paletteInput");
      const paletteList = document.getElementById("paletteList");

      window.addEventListener("message", (e) => {
        const msg = e.data;
        if (msg.type !== "graphData") return;
        const { nodes, edges, stats } = msg.data;

        const Graphology = window.graphology?.Graph || window.Graph;
        const Sigma = window.sigma?.Sigma || window.Sigma;
        const graph = new Graphology();

        const clusters = [...new Set(nodes.map(n => n.cluster))];
        const R = 350;
        clusters.forEach((c, i) => {
          const cx = Math.cos((i / clusters.length) * 2 * Math.PI) * R;
          const cy = Math.sin((i / clusters.length) * 2 * Math.PI) * R;
          const cs = nodes.filter(n => n.cluster === c);
          const r = 80 + Math.log(cs.length + 1) * 30;
          cs.forEach((n, j) => {
            const a = (j / cs.length) * 2 * Math.PI;
            const ext = n.label.split(".").pop()?.toLowerCase();
            let nodeColor = n.color;
            if (["ts","js"].includes(ext)) nodeColor="#4ea1ff";
            else if (ext==="py") nodeColor="#ffcc00";
            else if (["css","html"].includes(ext)) nodeColor="#ff66cc";
            else if (["json","yml","yaml"].includes(ext)) nodeColor="#999";
            graph.addNode(n.id,{label:n.label,x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r,
              size:n.size,color:nodeColor,cluster:n.cluster,path:n.path,
              loc:n.loc,complexity:n.complexity,commits:n.commits});
          });
        });
        edges.forEach(e => {
          if (graph.hasNode(e.from) && graph.hasNode(e.to))
            try { graph.addEdge(e.from,e.to,{color:"rgba(0,0,0,0.15)",size:0.6}); } catch {}
        });

        const renderer = new Sigma(graph, container, {
          renderLabels:true,
          labelRenderer:(ctx,d)=>{
            ctx.fillStyle="#000";
            ctx.font="12px Inter";
            ctx.fillText(d.label,d.x+d.size+2,d.y+3);
          }
        });
        container.style.opacity=1;
        const camera=renderer.getCamera();

        // 🧭 Guided Tour
        setTimeout(()=>{
          const tour=document.createElement("div");
          tour.style.cssText="position:absolute;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:#fff;padding:10px 18px;border-radius:10px;font-size:14px;opacity:0;transition:opacity 0.8s ease;";
          tour.innerText="Welcome to Orbyt 🌌";
          document.body.appendChild(tour);
          setTimeout(()=>tour.style.opacity=1,200);
          const steps=[
            {text:"🧭 Zooming into your root folder...",zoom:0.5},
            {text:"🔍 Highlighting key clusters...",zoom:0.25},
            {text:"💡 Gemini narrates insights as you explore!",zoom:0.1}
          ];
          let i=0;const next=()=>{if(i>=steps.length){setTimeout(()=>tour.remove(),1200);return;}
            tour.innerText=steps[i].text;
            camera.animate({ratio:steps[i].zoom},{duration:1000});
            i++;setTimeout(next,1800);};
          setTimeout(next,1200);
        },1000);

        // 🧠 Tooltip
        renderer.on("enterNode",({node})=>{
          const d=graph.getNodeAttributes(node);
          tooltip.innerHTML=\`<b>\${d.label}</b><br>📂 \${d.cluster}<br>📏 \${d.loc} | ⚙️ \${d.complexity}\`;
          tooltip.classList.add("show");
        });
        renderer.on("leaveNode",()=>tooltip.classList.remove("show"));
        container.addEventListener("mousemove",e=>{
          tooltip.style.left=e.pageX+15+"px";
          tooltip.style.top=e.pageY+10+"px";
        });

        // 🪟 Info panel
        renderer.on("clickNode",({node})=>{
          const d=graph.getNodeAttributes(node);
          let info=document.getElementById("infoBox");
          if(!info){info=document.createElement("div");info.id="infoBox";document.body.appendChild(info);}
          info.innerHTML=\`
            <button id='closeInfo'>✖</button>
            <h2>\${d.label}</h2><small>\${d.path}</small><br><br>
            📏 LOC \${d.loc} | ⚙️ \${d.complexity} | 🕒 \${d.commits}<br><br>
            <button id='openFileBtn'>📂 Open</button>
            <button id='explainBtn'>🧠 Explain</button>
            <div id='explainArea' style='margin-top:10px;font-size:13px;color:var(--muted);font-family:"JetBrains Mono",monospace;'></div>\`;
          info.classList.add("visible");
          document.getElementById("closeInfo").onclick=()=>info.classList.remove("visible");
          document.getElementById("openFileBtn").onclick=()=>vscode.postMessage({type:"openFile",path:d.path});
          document.getElementById("explainBtn").onclick=()=>{
            const area=document.getElementById("explainArea");
            area.innerHTML="⏳ Fetching Gemini insights...";
            vscode.postMessage({type:"explainFile",path:d.path});
          };
        });

        // ✅ Listen for Gemini explanation results
        window.addEventListener("message",(e2)=>{
          if(e2.data.type==="explanation"){
            const el=document.getElementById("explainArea");
            if(el && e2.data.explanation)
              el.innerHTML=e2.data.explanation.replace(/\\n/g,"<br>");
          }
        });

        // 📊 Health Dashboard
        const healthCanvas=document.getElementById("healthCanvas");
        const metricText=document.getElementById("metricText");
        if(healthCanvas&&metricText){
          const ctx=healthCanvas.getContext("2d");
          const avg=parseFloat(stats.avgComplexity||"0");
          const coupled=stats.clusters||0;
          const edits=(stats.mostEdited||[]).length;
          const score=Math.max(0,Math.min(100,100-avg*1.5+coupled*0.5-edits*2));
          metricText.textContent=\`Health: \${score.toFixed(0)} / 100\`;
          let progress=0;
          const draw=(s)=>{
            const c=60,r=40;
            ctx.clearRect(0,0,120,120);
            ctx.lineWidth=8;ctx.lineCap="round";
            ctx.strokeStyle="#eee";
            ctx.beginPath();ctx.arc(c,c,r,0,2*Math.PI);ctx.stroke();
            const grad=ctx.createLinearGradient(0,0,120,0);
            grad.addColorStop(0,"#4cd964");
            grad.addColorStop(.5,"#ffcc00");
            grad.addColorStop(1,"#ff3b30");
            ctx.strokeStyle=grad;
            ctx.beginPath();
            ctx.arc(c,c,r,-Math.PI/2,(s/100)*2*Math.PI-Math.PI/2);
            ctx.stroke();
            ctx.fillStyle="#333";
            ctx.font="bold 16px Inter";
            ctx.textAlign="center";ctx.textBaseline="middle";
            ctx.fillText(\`\${Math.round(s)}%\`,c,c);
          };
          const animate=()=>{progress+=(score-progress)*0.08;draw(progress);
            if(Math.abs(progress-score)>0.5)requestAnimationFrame(animate);};
          animate();
        }

        // ⌨️ Command Palette
        
        document.addEventListener("keydown",(e)=>{
          if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){
            e.preventDefault();
            paletteOverlay.style.display="flex";
            paletteInput.focus();
            paletteList.innerHTML=commands.map(c=>"<div>"+c.name+"</div>").join("");
          }else if(e.key==="Escape"){
            paletteOverlay.style.display="none";
          }
        });
        paletteList.addEventListener("click",(e)=>{
          const item=e.target.closest("div");if(!item)return;
          const cmd=commands.find(c=>c.name===item.textContent);
          if(cmd)cmd.action();
          paletteOverlay.style.display="none";
        });

        status.innerHTML=\`✅ \${stats.totalFiles} files • \${stats.clusters} clusters<br>📊 Avg Complexity: \${stats.avgComplexity}\`;
      });
    </script>
  </body>
  </html>`;
}
 

/** 🔐 Nonce generator */
function getNonce() {
  return Array.from({ length: 16 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
      Math.floor(Math.random() * 62)
    )
  ).join("");
}

export function deactivate() {}
