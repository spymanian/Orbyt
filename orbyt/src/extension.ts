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
export async function buildRepoGraph() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return { nodes: [], edges: [], stats: {} };
  }

  const root = workspaceFolders[0].uri.fsPath;

  // Load .gitignore
  const gitignorePath = path.join(root, ".gitignore");
  const ig = ignore();
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }

  const files: string[] = [];
  const exts = /\.(js|ts|jsx|tsx|py|java|cpp|c|cs|php|rb|go|rs|html|css|json|sh|yml|yaml)$/i;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (ig.ignores(rel)) {
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

  for (const f of files) {
    fileIndex.set(path.basename(f), f);
  }

  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const loc = content.split("\n").length;
    const complexity = (content.match(/\b(if|for|while|case|catch|&&|\|\|)\b/g) || []).length + 1;

    let commits = 0;
    try {
      const out = execSync(`git log --oneline -- "${file}"`, { cwd: root, encoding: "utf8" });
      commits = out.split("\n").filter(Boolean).length;
    } catch {
      commits = 0;
    }

    const rel = path.relative(root, file);
    const cluster = rel.includes(path.sep) ? rel.split(path.sep)[0] : "(root)";

    const imports: string[] = [];
    try {
      if (/\.(js|ts|jsx|tsx)$/i.test(file)) {
        const ast = babelParser.parse(content, {
          sourceType: "unambiguous",
          plugins: ["typescript", "jsx", "classProperties", "decorators-legacy"],
        });

        traverse(ast, {
          ImportDeclaration(p: NodePath<t.ImportDeclaration>) {
            if (p.node.source?.value) {
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
    } catch {
      // ignore parse errors
    }

    if (!graph.hasNode(file)) {
      graph.addNode(file, {
        id: file,
        label: path.basename(file),
        cluster,
        path: file,
        loc,
        complexity,
        commits,
        color: clusterColor(cluster),
        size: Math.max(4, Math.min(14, 5 + Math.log10(loc + 1))),
      });
    }

    for (const dep of imports) {
      const depFile =
        fileIndex.get(dep) ||
        fileIndex.get(dep + ".js") ||
        fileIndex.get(dep + ".ts") ||
        Array.from(fileIndex.entries()).find(([k]) => dep.endsWith(k))?.[1];
      if (depFile && graph.hasNode(depFile) && !graph.hasEdge(file, depFile)) {
        graph.addEdge(file, depFile, { color: "#ccc", weight: 1 });
      }
    }
  }

  const nodes: NodeData[] = graph.nodes().map((id) => {
  const attrs = graph.getNodeAttributes(id) as Omit<NodeData, "id">;
  return { id, ...attrs };
});

  const edges = graph.edges().map((edge) => {
    const [from, to] = graph.extremities(edge);
    return { from, to };
  });

  // 📊 Analytics
  const avgComplexity =
    files.length > 0
      ? files.reduce((acc, f) => acc + (graph.getNodeAttribute(f, "complexity") || 0), 0) / files.length
      : 0;
  const mostEdited = [...graph.nodes()]
    .sort((a, b) => (graph.getNodeAttribute(b, "commits") || 0) - (graph.getNodeAttribute(a, "commits") || 0))
    .slice(0, 5)
    .map((n) => ({
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
      clusters: [...new Set(nodes.map((n) => n.cluster))].length,
    },
  };
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
function clusterColor(cluster: string) {
  const palette = [
    "#66ccff",
    "#ff9966",
    "#cc99ff",
    "#99ff99",
    "#ffcc66",
    "#ff6699",
    "#66ffcc",
    "#aaaaaa",
    "#ff6666",
    "#66ff66",
  ];
  let hash = 0;
  for (let i = 0; i < cluster.length; i++) {
    hash = cluster.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

/** 🌐 Webview UI */
function getWebviewContent(graphologyUri: string, sigmaUri: string, cspSource: string): string {
  const nonce = getNonce();
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src https: data:;
               style-src 'unsafe-inline' ${cspSource};
               script-src 'unsafe-eval' 'nonce-${nonce}' ${cspSource};">
    <title>Orbyt</title>
    <style>
      html, body { margin:0; padding:0; width:100%; height:100%; background:#fafafa; font-family:sans-serif; }
      #graph-container { width:100%; height:100vh; }
      #status { position:absolute; bottom:10px; left:15px; font-size:13px; color:#555; background:rgba(255,255,255,0.8); padding:4px 8px; border-radius:6px; }
      .tooltip { position:absolute; padding:8px 12px; background:#222; color:#fff; border-radius:6px; font-size:13px;
        opacity:0; pointer-events:none; transition:opacity .2s; }
    </style>
  </head>
  <body>
    <div id="graph-container"></div>
    <div id="status">🌀 Building your code map...</div>
    <div class="tooltip" id="tooltip"></div>

    <script nonce="${nonce}" src="${graphologyUri}"></script>
    <script nonce="${nonce}" src="${sigmaUri}"></script>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const Graphology = window.graphology?.Graph || window.Graph;
      const Sigma = window.sigma?.Sigma || window.Sigma;

      vscode.postMessage({ type: "ready" });

      window.addEventListener("message", (e) => {
        const msg = e.data;
        if (msg.type === "graphData") {
          const { nodes, edges, stats } = msg.data;
          const graph = new Graphology();
          const clusters = [...new Set(nodes.map(n => n.cluster))];
          const R = 350;

          clusters.forEach((cluster, ci) => {
            const cx = Math.cos((ci / clusters.length) * 2 * Math.PI) * R;
            const cy = Math.sin((ci / clusters.length) * 2 * Math.PI) * R;
            const clusterNodes = nodes.filter(n => n.cluster === cluster);
            const r = 80 + Math.log(clusterNodes.length + 1) * 30;
            clusterNodes.forEach((n, i) => {
              const a = (i / clusterNodes.length) * 2 * Math.PI;
              const offset = Math.random() * 10;
              graph.addNode(n.id, {
                label: n.label,
                x: cx + Math.cos(a) * r + offset,
                y: cy + Math.sin(a) * r + offset,
                size: n.size,
                color: n.color,
                cluster,
                path: n.path,
                loc: n.loc,
                complexity: n.complexity,
                commits: n.commits,
              });
            });
          });

          edges.forEach(e => {
            if (graph.hasNode(e.from) && graph.hasNode(e.to)) {
              try { graph.addEdge(e.from, e.to, { color: "rgba(0,0,0,0.15)", size: 0.7 }); } catch {}
            }
          });

          const renderer = new Sigma(graph, document.getElementById("graph-container"));
          const tooltip = document.getElementById("tooltip");

          renderer.on("enterNode", ({ node }) => {
            const d = graph.getNodeAttributes(node);
            tooltip.innerHTML = \`
              <b>\${d.label}</b><br>
              📂 <i>\${d.cluster}</i><br>
              📏 LOC: \${d.loc} | ⚙️ \${d.complexity} | 🕒 \${d.commits}
            \`;
            tooltip.style.opacity = 1;
          });
          renderer.on("leaveNode", () => tooltip.style.opacity = 0);

          renderer.on("clickNode", ({ node }) => {
            const d = graph.getNodeAttributes(node);
            const existing = document.getElementById("infoBox");
            if (existing) existing.remove();

            const info = document.createElement("div");
            info.id = "infoBox";
            info.style.position = "absolute";
            info.style.top = "10px";
            info.style.right = "10px";
            info.style.background = "#fff";
            info.style.padding = "12px";
            info.style.borderRadius = "10px";
            info.style.boxShadow = "0 2px 10px rgba(0,0,0,0.2)";
            info.style.width = "320px";
            info.innerHTML = \`
              <b>\${d.label}</b><br><small>\${d.path}</small><br><br>
              📏 LOC: \${d.loc} | ⚙️ \${d.complexity} | 🕒 \${d.commits}<br><br>
              <button id="openFileBtn">📂 Open</button>
              <button id="explainBtn">🧠 Explain</button>
              <div id="explainArea" style="margin-top:10px;font-size:13px;color:#333;"></div>
            \`;
            document.body.appendChild(info);
            document.getElementById("openFileBtn").onclick = () =>
              vscode.postMessage({ type: "openFile", path: d.path });
            document.getElementById("explainBtn").onclick = () => {
              document.getElementById("explainArea").innerHTML = "⏳ Fetching Gemini insights...";
              vscode.postMessage({ type: "explainFile", path: d.path });
            };
          });

          window.addEventListener("message", (e2) => {
            if (e2.data.type === "explanation") {
              const el = document.getElementById("explainArea");
              if (el && e2.data.explanation) {
                el.innerHTML = e2.data.explanation.replace(/\\n/g, "<br>");
              }
            }
          });

          document.getElementById("graph-container").addEventListener("mousemove", e => {
            tooltip.style.left = e.pageX + 15 + "px";
            tooltip.style.top = e.pageY + 10 + "px";
          });

          document.getElementById("status").innerHTML = \`
            ✅ \${stats.totalFiles} files visualized (\${stats.clusters} clusters)<br>
            📊 Avg Complexity: \${stats.avgComplexity}<br>
            🔥 Top Edited: \${stats.mostEdited.map(f => f.file + " (" + f.commits + ")").join(", ")}
          \`;
        }
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
