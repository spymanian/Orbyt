import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import ignore from "ignore";
import { execSync } from "child_process";
import Graph from "graphology";
import * as babelParser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

/** VS Code entry point */
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
    panel.webview.html = getWebviewContent(
      graphologyUri.toString(),
      sigmaUri.toString(),
      cspSource
    );

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "ready") {
        vscode.window.showInformationMessage("🧩 Generating CodeAtlas...");
        const repoGraph = await buildRepoGraph();
        panel.webview.postMessage({ type: "graphData", data: repoGraph });
      }
    });
  });

  context.subscriptions.push(disposable);
}

/** 🔍 Scans workspace + builds dependency graph */
export async function buildRepoGraph() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders){
    return { nodes: [], edges: [] };
  } 

  const root = workspaceFolders[0].uri.fsPath;

  // Load .gitignore
  const gitignorePath = path.join(root, ".gitignore");
  const ig = ignore();
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }

  const files: string[] = [];
  const exts = /\.(js|ts|jsx|tsx)$/i;

  // Recursively walk workspace
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
      if (ig.ignores(rel)){
        continue;
      } 

      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "dist", "out", ".next"].includes(entry.name)) {
          walk(full);
        }
      } else if (exts.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(root);

  // Build Graphology graph
  const graph = new Graph();
  const fileIndex = new Map<string, string>();
  for (const f of files){
    fileIndex.set(path.basename(f), f);
  } 

  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // Basic metrics
    const loc = content.split("\n").length;
    const complexity = (content.match(/\b(if|for|while|case|catch|&&|\|\|)\b/g) || []).length + 1;

    let commits = 0;
    try {
      const out = execSync(`git log --oneline -- "${file}"`, {
        cwd: root,
        encoding: "utf8",
      });
      commits = out.split("\n").filter(Boolean).length;
    } catch {
      commits = 0;
    }

    // Folder cluster
    const rel = path.relative(root, file);
    const cluster = rel.includes(path.sep) ? rel.split(path.sep)[0] : "(root)";

    const imports: string[] = [];
    const functions: string[] = [];

    // Parse JS/TS via Babel
    try {
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
        FunctionDeclaration(p: NodePath<t.FunctionDeclaration>) {
          if (p.node.id?.name){

          } 
        },
      });
    } catch (err) {
      console.warn("Parse failed for", file);
    }

    // Add file node
    if (!graph.hasNode(file)) {
      graph.addNode(file, {
        id: file,
        label: path.basename(file),
        cluster,
        loc,
        complexity,
        commits,
        functions,
        color: clusterColor(cluster),
        size: Math.max(3, Math.min(12, 4 + Math.log10(loc + 1))),
      });
    }

    // Add dependency edges
    for (const dep of imports) {
      const depFile =
        fileIndex.get(dep) ||
        fileIndex.get(dep + ".js") ||
        fileIndex.get(dep + ".ts") ||
        Array.from(fileIndex.entries()).find(([k]) => dep.endsWith(k))?.[1];

      if (depFile && graph.hasNode(depFile) && !graph.hasEdge(file, depFile)) {
        graph.addEdge(file, depFile, { color: "#aaa", weight: 1 });
      }
    }
  }

  const nodes = graph.nodes().map((id) => ({
    id,
    ...graph.getNodeAttributes(id),
  }));
  const edges = graph.edges().map((edge) => {
    const [from, to] = graph.extremities(edge);
    return { from, to };
  });

  console.log(`✅ Built graph: ${nodes.length} nodes, ${edges.length} edges`);
  return { nodes, edges };
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
  ];
  let hash = 0;
  for (let i = 0; i < cluster.length; i++) {
    hash = cluster.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

/** 🧠 Webview HTML with Sigma renderer */
function getWebviewContent(
  graphologyUri: string,
  sigmaUri: string,
  cspSource: string
): string {
  const nonce = getNonce();

  return /* html */ `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}' ${cspSource};">
    <title>Orbyt</title>
    <style>
      html,body{margin:0;padding:0;width:100%;height:100%;background:#f4f6f8;font-family:sans-serif;}
      #graph-container{width:100%;height:100vh;}
      #status{position:absolute;bottom:10px;left:15px;font-size:13px;color:#555;}
      .tooltip{position:absolute;padding:8px 10px;background:#222;color:#fff;border-radius:6px;font-size:12px;opacity:0;pointer-events:none;transition:opacity 0.2s;}
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
      const Graphology = window.graphology?.Graph || window.Graphology || window.Graph;
      const Sigma = window.sigma?.Sigma || window.Sigma;
      if (!Graphology || !Sigma){document.getElementById("status").textContent="❌ Failed to load libs";throw new Error("Missing libs");}
      vscode.postMessage({type:"ready"});

      window.addEventListener("message",(event)=>{
        const msg=event.data;
        if(msg.type==="graphData"){
          const {nodes,edges}=msg.data;
          const graph=new Graphology();

          // Clustered ring layout
          const clusters=[...new Set(nodes.map(n=>n.cluster))];
          const clusterRadius=150;
          clusters.forEach((cluster,ci)=>{
            const cx=Math.cos((ci/clusters.length)*2*Math.PI)*clusterRadius;
            const cy=Math.sin((ci/clusters.length)*2*Math.PI)*clusterRadius;
            const clusterNodes=nodes.filter(n=>n.cluster===cluster);
            const radius=40+Math.log(clusterNodes.length+1)*25;
            clusterNodes.forEach((n,i)=>{
              const angle=(i/clusterNodes.length)*2*Math.PI;
              graph.addNode(n.id,{
                label:n.label,
                x:cx+Math.cos(angle)*radius,
                y:cy+Math.sin(angle)*radius,
                size:n.size,
                color:n.color,
                cluster:n.cluster,
                loc:n.loc,
                complexity:n.complexity,
                commits:n.commits,
              });
            });
          });

          edges.forEach(e=>{
            if(graph.hasNode(e.from)&&graph.hasNode(e.to)&&!graph.hasEdge(e.from,e.to)){
              graph.addEdge(e.from,e.to,{color:"rgba(0,0,0,0.2)",size:0.5});
            }
          });

          const container=document.getElementById("graph-container");
          const renderer=new Sigma(graph,container);
          const tooltip=document.getElementById("tooltip");

          renderer.on("enterNode",({node})=>{
            const d=graph.getNodeAttributes(node);
            tooltip.innerHTML=\`<b>\${d.label}</b><br/>Cluster: \${d.cluster}<br/>LOC: \${d.loc}<br/>Complexity: \${d.complexity}<br/>Commits: \${d.commits}\`;
            tooltip.style.opacity=1;
          });
          renderer.on("leaveNode",()=>tooltip.style.opacity=0);
          container.addEventListener("mousemove",e=>{
            tooltip.style.left=e.pageX+15+"px";
            tooltip.style.top=e.pageY+10+"px";
          });

          document.getElementById("status").textContent="✅ "+nodes.length+" files visualized.";
        }
      });
    </script>
  </body>
  </html>`;
}

function getNonce(): string {
  return Array.from({ length: 16 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
      Math.floor(Math.random() * 62)
    )
  ).join("");
}

export function deactivate() {}
