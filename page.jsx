"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Upload, Scan, Download, Trash2, Move, Type,
  Palette, AlignLeft, Loader2, X, ChevronUp,
  ChevronDown, RotateCcw, Bold, Italic, Sparkles,
  Plus, Languages, AlignJustify, AlignCenter,
  PenTool, CloudFog, Undo2, Redo2, Crop, SlidersHorizontal, Check,
} from "lucide-react";

// ════════════════════════════════════════════════════════════
// UNDO / REDO 用カスタムフック
// ════════════════════════════════════════════════════════════
/**
 * layers配列の履歴を管理するフック。
 * - commit(newLayers): 履歴に新しいスナップショットを積む（Undo可能な確定操作）
 * - update(newLayers): 履歴を積まずに「今のスナップショット」だけ書き換える
 *   （ドラッグ中の連続更新など、操作完了までUndo単位にしたくない場合に使う）
 * - undo() / redo(): 履歴を移動
 */
function useHistoryState(initial, maxHistory = 50) {
  const [present, setPresent] = useState(initial);
  const pastRef   = useRef([]);
  const futureRef = useRef([]);
  const [, forceRender] = useState(0);
  const bump = () => forceRender(n => n + 1);

  const commit = useCallback((updater) => {
    setPresent(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      pastRef.current = [...pastRef.current, prev].slice(-maxHistory);
      futureRef.current = [];
      bump();
      return next;
    });
  }, [maxHistory]);

  const update = useCallback((updater) => {
    setPresent(prev => (typeof updater === "function" ? updater(prev) : updater));
  }, []);

  /**
   * ドラッグ／リサイズ／テキスト編集のように「操作開始前の状態」を
   * あらかじめ保持しておき、操作完了時にそのスナップショットだけを
   * 履歴に積む（現在値は変えない）ためのヘルパー。
   * 本アプリでは EditorCanvas 側がドラッグ開始時の layers をクロージャで
   * 直接キャプチャして commitSnapshot に渡す方式を採用しているため、
   * beginSnapshot 自体は呼ばれていないが、フックの汎用APIとして提供する。
   */
  const beginSnapshot = useCallback(() => present, [present]);

  const commitSnapshot = useCallback((snapshotBeforeOperation) => {
    setPresent(prev => {
      // 変化が無ければ履歴を汚さない
      if (snapshotBeforeOperation === prev) return prev;
      pastRef.current = [...pastRef.current, snapshotBeforeOperation].slice(-maxHistory);
      futureRef.current = [];
      bump();
      return prev;
    });
  }, [maxHistory]);

  const undo = useCallback(() => {
    setPresent(prev => {
      if (pastRef.current.length === 0) return prev;
      const previous = pastRef.current[pastRef.current.length - 1];
      pastRef.current = pastRef.current.slice(0, -1);
      futureRef.current = [prev, ...futureRef.current];
      bump();
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setPresent(prev => {
      if (futureRef.current.length === 0) return prev;
      const next = futureRef.current[0];
      futureRef.current = futureRef.current.slice(1);
      pastRef.current = [...pastRef.current, prev].slice(-maxHistory);
      bump();
      return next;
    });
  }, []);

  const reset = useCallback((newInitial) => {
    pastRef.current = [];
    futureRef.current = [];
    setPresent(newInitial);
    bump();
  }, []);

  return {
    state: present,
    commit,         // 即時1操作としてUndo履歴に積む（追加・削除・スタイル変更など）
    update,         // Undo履歴に積まない一時更新（ドラッグ・リサイズ中の連続フレーム）
    beginSnapshot,  // ドラッグ開始時などに呼び、操作前の状態を保持する
    commitSnapshot, // 操作完了時に呼び、保持していた操作前の状態を履歴に積む
    undo,
    redo,
    reset,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}

// ════════════════════════════════════════════════════════════
// 画像補正（明るさ・コントラスト）ユーティリティ
// ════════════════════════════════════════════════════════════
/**
 * brightness: -100〜100 (0が無補正。CSS filterのbrightness%に変換して使う場面もあるが、
 *             ここではCanvasのpixelデータに直接焼き込むための加算値として扱う)
 * contrast:   -100〜100 (0が無補正)
 *
 * CSSのfilterプロパティ文字列（プレビュー用、軽量・リアルタイム）
 */
function buildCssFilter(adjustments) {
  const { brightness, contrast } = adjustments;
  // CSS filter は 100% が無補正。brightness/contrastの-100~100を 0~200% にマッピング
  const b = 100 + brightness;
  const c = 100 + contrast;
  return `brightness(${b}%) contrast(${c}%)`;
}

/**
 * 与えられた HTMLImageElement (またはCanvas) を、指定の明るさ・コントラストを
 * 焼き込んだ新しい Canvas として返す（エクスポート・OCR前処理用、原寸精度）。
 */
function renderAdjustedImageToCanvas(source, srcW, srcH, adjustments) {
  const canvas = document.createElement("canvas");
  canvas.width = srcW;
  canvas.height = srcH;
  const ctx = canvas.getContext("2d");
  // CSS filterをCanvas描画時に適用（ブラウザのネイティブ実装に処理させることで
  // ピクセル単位ループより高速かつブラウザのfilterと見た目が完全一致する）
  ctx.filter = buildCssFilter(adjustments);
  ctx.drawImage(source, 0, 0, srcW, srcH);
  ctx.filter = "none";
  return canvas;
}

const DEFAULT_ADJUSTMENTS = { brightness: 0, contrast: 0 };

// ════════════════════════════════════════════════════════════
// トリミング用ユーティリティ
// ════════════════════════════════════════════════════════════
/**
 * 元画像(source)から rect{x,y,w,h}（オリジナル解像度基準）の範囲を
 * 切り出した新しい HTMLImageElement を生成して resolve する。
 */
function cropImageToNewElement(source, rect) {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.w));
    canvas.height = Math.max(1, Math.round(rect.h));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      source,
      rect.x, rect.y, rect.w, rect.h,
      0, 0, canvas.width, canvas.height
    );
    const newImg = new Image();
    newImg.onload = () => resolve(newImg);
    newImg.src = canvas.toDataURL("image/png");
  });
}

// ════════════════════════════════════════════════════════════
// OCR SERVICE
// ════════════════════════════════════════════════════════════
let tesseractLoaded = false;
let tesseractLoading = false;
const tesseractCallbacks = [];

function loadTesseract() {
  return new Promise((resolve, reject) => {
    if (tesseractLoaded) { resolve(window.Tesseract); return; }
    tesseractCallbacks.push({ resolve, reject });
    if (tesseractLoading) return;
    tesseractLoading = true;
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js";
    script.onload = () => {
      tesseractLoaded = true;
      tesseractCallbacks.forEach(cb => cb.resolve(window.Tesseract));
    };
    script.onerror = () => tesseractCallbacks.forEach(cb => cb.reject(new Error("Tesseract読み込み失敗")));
    document.head.appendChild(script);
  });
}

function extractBackgroundColor(ctx, x, y, w, h) {
  try {
    const pad = 3;
    const sx = Math.max(0, x - pad);
    const sy = Math.max(0, y - pad);
    const sw = Math.min(w + pad * 2, ctx.canvas.width  - sx);
    const sh = Math.min(h + pad * 2, ctx.canvas.height - sy);
    const imgData = ctx.getImageData(sx, sy, sw, sh);
    const d = imgData.data;
    let r = 0, g = 0, b = 0, count = 0;
    const tw = sw, th = sh;
    for (let py = 0; py < th; py++) {
      for (let px = 0; px < tw; px++) {
        if (py < 2 || py >= th - 2 || px < 2 || px >= tw - 2) {
          const i = (py * tw + px) * 4;
          r += d[i]; g += d[i+1]; b += d[i+2]; count++;
        }
      }
    }
    if (count === 0) return "#ffffff";
    const toHex = v => Math.round(v/count).toString(16).padStart(2,"0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch { return "#ffffff"; }
}

// ── レイヤーのデフォルトスタイル一式（新規追加プロパティ含む） ──
function defaultLayerStyle() {
  return {
    color: "#000000",
    backgroundColor: "transparent",
    fontFamily: "sans-serif",
    fontWeight: "normal",
    fontStyle: "normal",
    opacity: 1,
    // ── 追加機能 ──
    writingMode: "horizontal",   // "horizontal" | "vertical"
    lineHeight: 1.25,            // 行間（倍率）
    letterSpacing: 0,            // 字間（px, オリジナル解像度基準）
    strokeColor: "#ffffff",      // 縁取り色
    strokeWidth: 0,              // 縁取りの太さ（px, オリジナル解像度基準）。0で非表示
    shadowEnabled: false,        // ドロップシャドウの有無
    shadowColor: "#000000",
    shadowBlur: 4,               // px（オリジナル解像度基準）
    shadowOffsetX: 2,
    shadowOffsetY: 2,
  };
}

async function runOCR(imgEl, lang = "jpn+eng", onProgress, adjustments = DEFAULT_ADJUSTMENTS) {
  const Tesseract = await loadTesseract();
  const origW = imgEl.naturalWidth || imgEl.width;
  const origH = imgEl.naturalHeight || imgEl.height;

  // 明るさ・コントラスト補正を焼き込んだCanvasを作成
  // → これをOCRの入力にすることで、文字をくっきりさせた状態で認識できる
  // → 背景色抽出（座布団用）も同じ補正後の色を使うことで見た目が一致する
  const offscreen = renderAdjustedImageToCanvas(imgEl, origW, origH, adjustments);
  const ctx = offscreen.getContext("2d");

  const worker = await Tesseract.createWorker(lang, 1, {
    logger: m => { if (m.status === "recognizing text") onProgress(Math.round(m.progress * 100)); },
  });
  // 補正済みCanvasをそのままOCRエンジンに渡す
  const { data } = await worker.recognize(offscreen);
  await worker.terminate();

  const layers = [];
  let uid = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const trimmed = line.text.trim();
        if (!trimmed) continue;
        const { x0, y0, x1, y1 } = line.bbox;
        const w = x1-x0, h = y1-y0;
        const autoBg = ctx ? extractBackgroundColor(ctx, x0, y0, w, h) : "#ffffff";
        layers.push({
          id: `layer-${Date.now()}-${uid++}`,
          text: trimmed,
          x: x0, y: y0, width: w, height: h,
          fontSize: Math.max(12, Math.round(h * 0.8)),
          ...defaultLayerStyle(),
          backgroundColor: autoBg,
        });
      }
    }
  }
  return layers;
}

// ════════════════════════════════════════════════════════════
// CANVAS描画ヘルパー（プレビューとエクスポートで共通のロジック）
// ════════════════════════════════════════════════════════════

/**
 * ctx に対して、ストローク（縁取り）→塗りの順で1文字/1行を描画する。
 * シャドウが有効な場合は ctx.shadow* を設定してから描画する。
 */
function drawTextWithEffects(ctx, text, x, y, layer) {
  ctx.save();
  if (layer.shadowEnabled) {
    ctx.shadowColor   = layer.shadowColor;
    ctx.shadowBlur     = layer.shadowBlur;
    ctx.shadowOffsetX  = layer.shadowOffsetX;
    ctx.shadowOffsetY  = layer.shadowOffsetY;
  } else {
    ctx.shadowColor = "rgba(0,0,0,0)";
  }

  if (layer.strokeWidth > 0) {
    ctx.lineWidth   = layer.strokeWidth;
    ctx.strokeStyle = layer.strokeColor;
    ctx.lineJoin    = "round";
    ctx.miterLimit  = 2;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = layer.color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * letterSpacing を考慮して1文字ずつ描画し、描画後のX座標を返す（横書き用）
 */
function drawLineWithLetterSpacing(ctx, line, startX, y, layer) {
  if (!layer.letterSpacing) {
    drawTextWithEffects(ctx, line, startX, y, layer);
    return startX + ctx.measureText(line).width;
  }
  let cx = startX;
  for (const ch of Array.from(line)) {
    drawTextWithEffects(ctx, ch, cx, y, layer);
    cx += ctx.measureText(ch).width + layer.letterSpacing;
  }
  return cx;
}

/**
 * オリジナル解像度基準の layer 情報から、Canvas全体（横書き・縦書き両対応、
 * 行間・字間・縁取り・影をすべて反映）にテキストを合成描画する。
 * プレビュー(displaySize経由のスケール済みlayer)とエクスポート(原寸layer)の
 * 両方からこの関数を呼べるよう、すべての数値はすでに描画先スケールに
 * 変換済みのものを渡す想定（呼び出し側でスケーリングする）。
 */
function paintLayerOnCanvas(ctx, layer) {
  const weight = layer.fontWeight === "bold"   ? "bold"   : "normal";
  const style  = layer.fontStyle  === "italic" ? "italic" : "normal";
  ctx.font = `${style} ${weight} ${layer.fontSize}px ${layer.fontFamily}`;
  ctx.textBaseline = "top";
  ctx.globalAlpha = layer.opacity;

  // 座布団（背景色）
  if (layer.backgroundColor && layer.backgroundColor !== "transparent") {
    ctx.fillStyle = layer.backgroundColor;
    ctx.fillRect(layer.x - 2, layer.y - 2, layer.width + 4, layer.height + 4);
  }

  const lineH = layer.fontSize * layer.lineHeight;

  if (layer.writingMode === "vertical") {
    // ── 縦書き ──
    // 列（縦方向の1本のテキスト列）を右→左に進める。
    // 各列内では文字を上→下に letterSpacing 分の間隔を空けて配置。
    const chars = Array.from(layer.text);
    const colW = lineH; // 1列の幅 = 行間を列の幅として利用
    let colIndex = 0;
    let curY = layer.y + 2;
    // 右端から開始（layer.width右端を最初の列の中心とする）
    let colX = layer.x + layer.width - colW / 2;

    for (const ch of chars) {
      if (ch === "\n") {
        colIndex++;
        colX = layer.x + layer.width - colW / 2 - colIndex * colW;
        curY = layer.y + 2;
        continue;
      }
      // 列の右端（layer.x）を超えたら折り返し不可なのでそのまま続行（はみ出し許容）
      drawTextWithEffects(ctx, ch, colX - ctx.measureText(ch).width / 2, curY, layer);
      curY += layer.fontSize + layer.letterSpacing;
      if (curY > layer.y + layer.height) {
        colIndex++;
        colX = layer.x + layer.width - colW / 2 - colIndex * colW;
        curY = layer.y + 2;
      }
    }
  } else {
    // ── 横書き（自動折り返し、letterSpacing対応） ──
    const chars = Array.from(layer.text);
    let line = "";
    let curY = layer.y + 2;

    const measureLineWidth = (str) => {
      if (!layer.letterSpacing) return ctx.measureText(str).width;
      let total = 0;
      for (const ch of Array.from(str)) total += ctx.measureText(ch).width + layer.letterSpacing;
      return total;
    };

    for (const ch of chars) {
      if (ch === "\n") {
        drawLineWithLetterSpacing(ctx, line, layer.x + 2, curY, layer);
        line = ""; curY += lineH;
        continue;
      }
      const test = line + ch;
      if (measureLineWidth(test) > layer.width && line) {
        drawLineWithLetterSpacing(ctx, line, layer.x + 2, curY, layer);
        line = ch; curY += lineH;
      } else {
        line = test;
      }
    }
    if (line) drawLineWithLetterSpacing(ctx, line, layer.x + 2, curY, layer);
  }

  ctx.globalAlpha = 1;
}

function exportHighResPNG(imgEl, layers, adjustments = DEFAULT_ADJUSTMENTS) {
  const W = imgEl.naturalWidth || imgEl.width;
  const H = imgEl.naturalHeight || imgEl.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // 明るさ・コントラストを焼き込んでベース画像を描画
  ctx.filter = buildCssFilter(adjustments);
  ctx.drawImage(imgEl, 0, 0, W, H);
  ctx.filter = "none";

  for (const layer of layers) {
    ctx.save();
    // layer はすでにオリジナル解像度基準の値なので、そのまま描画する
    paintLayerOnCanvas(ctx, layer);
    ctx.restore();
  }

  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `edited-${Date.now()}.png`; a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ════════════════════════════════════════════════════════════
// TOOLBAR
// ════════════════════════════════════════════════════════════
const FONT_FAMILIES = [
  { value: "sans-serif", label: "ゴシック" },
  { value: "serif",      label: "明朝"     },
  { value: "monospace",  label: "等幅"     },
  { value: "cursive",    label: "筆記体"   },
];

function Toolbar({ layer, onChange, onDelete, onDeselect }) {
  const set = (key, value) => onChange({ ...layer, [key]: value });
  return (
    <div style={{ background:"#13131f", border:"1px solid #2a2a3d", borderRadius:14, padding:"10px 12px", display:"flex", flexDirection:"column", gap:10 }}>

      {/* ── 行1: フォント基本設定 ── */}
      <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
        <select value={layer.fontFamily} onChange={e => set("fontFamily", e.target.value)}
          style={{ background:"#1c1c2a", color:"#c4c4d4", border:"1px solid #3a3a52", borderRadius:7, padding:"5px 8px", fontSize:"0.78rem", cursor:"pointer" }}>
          {FONT_FAMILIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>

        <div style={{ display:"flex", alignItems:"center", gap:2 }}>
          <TbBtn onClick={() => set("fontSize", Math.max(8, layer.fontSize-2))}><ChevronDown size={13}/></TbBtn>
          <span style={{ fontSize:"0.78rem", color:"#c4c4d4", minWidth:42, textAlign:"center" }}>{layer.fontSize}px</span>
          <TbBtn onClick={() => set("fontSize", layer.fontSize+2)}><ChevronUp size={13}/></TbBtn>
        </div>

        <TbBtn active={layer.fontWeight==="bold"} onClick={() => set("fontWeight", layer.fontWeight==="bold"?"normal":"bold")}><Bold size={13}/></TbBtn>
        <TbBtn active={layer.fontStyle==="italic"} onClick={() => set("fontStyle", layer.fontStyle==="italic"?"normal":"italic")}><Italic size={13}/></TbBtn>

        {/* 横書き/縦書き切り替え */}
        <TbBtn
          active={layer.writingMode==="vertical"}
          title={layer.writingMode==="vertical" ? "縦書き中（クリックで横書きに）" : "横書き中（クリックで縦書きに）"}
          onClick={() => set("writingMode", layer.writingMode==="vertical" ? "horizontal" : "vertical")}
        >
          {layer.writingMode==="vertical" ? <AlignCenter size={13}/> : <AlignJustify size={13}/>}
        </TbBtn>

        <label title="文字色" style={{ display:"flex", alignItems:"center", gap:4, background:"#1c1c2a", border:"1px solid #3a3a52", borderRadius:7, padding:"4px 8px", cursor:"pointer" }}>
          <Type size={12} style={{ color:"#888" }}/>
          <input type="color" value={layer.color} onChange={e => set("color", e.target.value)}
            style={{ width:20, height:20, border:"none", background:"none", cursor:"pointer", padding:0 }}/>
        </label>

        <label title="背景色（座布団）" style={{ display:"flex", alignItems:"center", gap:4, background:"#1c1c2a", border:"1px solid #3a3a52", borderRadius:7, padding:"4px 8px", cursor:"pointer" }}>
          <Palette size={12} style={{ color:"#888" }}/>
          <input type="color"
            value={layer.backgroundColor==="transparent"?"#ffffff":layer.backgroundColor}
            onChange={e => set("backgroundColor", e.target.value)}
            style={{ width:20, height:20, border:"none", background:"none", cursor:"pointer", padding:0 }}/>
          <button onClick={e=>{e.preventDefault();set("backgroundColor","transparent");}}
            style={{ background:"none", border:"none", color:"#666", cursor:"pointer", fontSize:10, padding:"0 2px" }} title="透明に">✕</button>
        </label>

        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ fontSize:"0.72rem", color:"#888" }}>α</span>
          <input type="range" min={0.1} max={1} step={0.05} value={layer.opacity}
            onChange={e => set("opacity", parseFloat(e.target.value))}
            style={{ width:55, accentColor:"#6366f1", cursor:"pointer" }}/>
          <span style={{ fontSize:"0.72rem", color:"#888", minWidth:26 }}>{Math.round(layer.opacity*100)}%</span>
        </div>

        <TbBtn onClick={onDeselect} title="選択解除"><X size={13}/></TbBtn>
        <TbBtn danger onClick={onDelete} title="削除"><Trash2 size={13}/></TbBtn>
      </div>

      {/* ── 行2: 行間・字間 ── */}
      <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"center", borderTop:"1px solid #22223a", paddingTop:8 }}>
        <SliderRow
          label="行間"
          value={layer.lineHeight}
          min={0.8} max={3} step={0.05}
          display={`${layer.lineHeight.toFixed(2)}x`}
          onChange={v => set("lineHeight", v)}
        />
        <SliderRow
          label="字間"
          value={layer.letterSpacing}
          min={-5} max={40} step={1}
          display={`${layer.letterSpacing}px`}
          onChange={v => set("letterSpacing", v)}
        />
      </div>

      {/* ── 行3: 縁取り ── */}
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", borderTop:"1px solid #22223a", paddingTop:8 }}>
        <span style={{ fontSize:"0.72rem", color:"#888", display:"flex", alignItems:"center", gap:4 }}>
          <PenTool size={12}/> 縁取り
        </span>
        <SliderRow
          label="太さ"
          value={layer.strokeWidth}
          min={0} max={20} step={0.5}
          display={`${layer.strokeWidth}px`}
          onChange={v => set("strokeWidth", v)}
        />
        <label title="縁取り色" style={{ display:"flex", alignItems:"center", gap:4, background:"#1c1c2a", border:"1px solid #3a3a52", borderRadius:7, padding:"4px 8px", cursor:"pointer", opacity: layer.strokeWidth>0?1:0.4 }}>
          <input type="color" value={layer.strokeColor} onChange={e => set("strokeColor", e.target.value)}
            disabled={layer.strokeWidth<=0}
            style={{ width:20, height:20, border:"none", background:"none", cursor:"pointer", padding:0 }}/>
        </label>
      </div>

      {/* ── 行4: ドロップシャドウ ── */}
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", borderTop:"1px solid #22223a", paddingTop:8 }}>
        <TbBtn
          active={layer.shadowEnabled}
          title={layer.shadowEnabled ? "影:ON（クリックでOFF）" : "影:OFF（クリックでON）"}
          onClick={() => set("shadowEnabled", !layer.shadowEnabled)}
        >
          <CloudFog size={13}/>
        </TbBtn>
        <span style={{ fontSize:"0.72rem", color:"#888" }}>影</span>

        <label title="影の色" style={{ display:"flex", alignItems:"center", gap:4, background:"#1c1c2a", border:"1px solid #3a3a52", borderRadius:7, padding:"4px 8px", cursor:"pointer", opacity: layer.shadowEnabled?1:0.4 }}>
          <input type="color" value={layer.shadowColor} onChange={e => set("shadowColor", e.target.value)}
            disabled={!layer.shadowEnabled}
            style={{ width:20, height:20, border:"none", background:"none", cursor:"pointer", padding:0 }}/>
        </label>

        <SliderRow
          label="ぼかし" disabled={!layer.shadowEnabled}
          value={layer.shadowBlur} min={0} max={30} step={1}
          display={`${layer.shadowBlur}px`}
          onChange={v => set("shadowBlur", v)}
        />
        <SliderRow
          label="X" disabled={!layer.shadowEnabled}
          value={layer.shadowOffsetX} min={-20} max={20} step={1}
          display={`${layer.shadowOffsetX}px`}
          onChange={v => set("shadowOffsetX", v)}
        />
        <SliderRow
          label="Y" disabled={!layer.shadowEnabled}
          value={layer.shadowOffsetY} min={-20} max={20} step={1}
          display={`${layer.shadowOffsetY}px`}
          onChange={v => set("shadowOffsetY", v)}
        />
      </div>
    </div>
  );
}

function SliderRow({ label, value, min, max, step, display, onChange, disabled=false }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:5, opacity: disabled?0.4:1 }}>
      <span style={{ fontSize:"0.72rem", color:"#888", minWidth: 28 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width:60, accentColor:"#6366f1", cursor: disabled?"not-allowed":"pointer" }}/>
      <span style={{ fontSize:"0.7rem", color:"#888", minWidth:34 }}>{display}</span>
    </div>
  );
}

function TbBtn({ children, onClick, active=false, danger=false, title }) {
  return (
    <button onClick={onClick} title={title} style={{
      display:"flex", alignItems:"center", justifyContent:"center",
      width:28, height:28, borderRadius:7, cursor:"pointer",
      border:"1px solid #3a3a52",
      background: active?"#4f46e5":"#1c1c2a",
      color: active?"#fff": danger?"#ef4444":"#c4c4d4",
      transition:"all 0.15s",
      flexShrink: 0,
    }}>{children}</button>
  );
}

// ════════════════════════════════════════════════════════════
// CROP OVERLAY（トリミングモード用UI）
// ════════════════════════════════════════════════════════════
/**
 * トリミングモード中に表示する、ドラッグで矩形選択できるオーバーレイ。
 * 表示座標(displaySize基準)で矩形を管理し、確定時にオリジナル解像度に
 * 変換した rect を onConfirm に渡す。
 */
function CropOverlay({ imageSrc, displaySize, naturalSize, onConfirm, onCancel }) {
  const scale = naturalSize.w > 0 ? displaySize.w / naturalSize.w : 1;
  // 初期値: 画像全体より少し内側
  const initRect = {
    x: Math.round(displaySize.w * 0.1),
    y: Math.round(displaySize.h * 0.1),
    w: Math.round(displaySize.w * 0.8),
    h: Math.round(displaySize.h * 0.8),
  };
  const [rect, setRect] = useState(initRect);
  const dragStateRef = useRef(null);

  const clientPos = e => {
    if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  };

  const clampRect = (r) => {
    let { x, y, w, h } = r;
    w = Math.max(20, Math.min(w, displaySize.w));
    h = Math.max(20, Math.min(h, displaySize.h));
    x = Math.max(0, Math.min(x, displaySize.w - w));
    y = Math.max(0, Math.min(y, displaySize.h - h));
    return { x, y, w, h };
  };

  // ドラッグ種別: "move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w"
  const startInteraction = useCallback((e, mode) => {
    e.preventDefault(); e.stopPropagation();
    const { x: cx, y: cy } = clientPos(e.nativeEvent ?? e);
    dragStateRef.current = { mode, startX: cx, startY: cy, rectStart: rect };

    const onMove = ev => {
      ev.preventDefault();
      const ds = dragStateRef.current;
      if (!ds) return;
      const { x, y } = clientPos(ev);
      const dx = x - ds.startX;
      const dy = y - ds.startY;
      let next = { ...ds.rectStart };

      if (ds.mode === "move") {
        next.x = ds.rectStart.x + dx;
        next.y = ds.rectStart.y + dy;
      } else {
        if (ds.mode.includes("e")) next.w = ds.rectStart.w + dx;
        if (ds.mode.includes("s")) next.h = ds.rectStart.h + dy;
        if (ds.mode.includes("w")) { next.x = ds.rectStart.x + dx; next.w = ds.rectStart.w - dx; }
        if (ds.mode.includes("n")) { next.y = ds.rectStart.y + dy; next.h = ds.rectStart.h - dy; }
      }
      setRect(clampRect(next));
    };
    const onUp = () => {
      dragStateRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
    };
    window.addEventListener("mousemove", onMove, { passive:false });
    window.addEventListener("touchmove", onMove, { passive:false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  }, [rect, displaySize]);

  const handleConfirm = () => {
    // オリジナル解像度基準に変換して確定
    onConfirm({
      x: Math.round(rect.x / scale),
      y: Math.round(rect.y / scale),
      w: Math.round(rect.w / scale),
      h: Math.round(rect.h / scale),
    });
  };

  const HANDLE_SIZE = 22;
  const handles = [
    { mode: "nw", top: -HANDLE_SIZE/2, left: -HANDLE_SIZE/2, cursor: "nwse-resize" },
    { mode: "ne", top: -HANDLE_SIZE/2, left: rect.w-HANDLE_SIZE/2, cursor: "nesw-resize" },
    { mode: "sw", top: rect.h-HANDLE_SIZE/2, left: -HANDLE_SIZE/2, cursor: "nesw-resize" },
    { mode: "se", top: rect.h-HANDLE_SIZE/2, left: rect.w-HANDLE_SIZE/2, cursor: "nwse-resize" },
    { mode: "n", top: -HANDLE_SIZE/2, left: rect.w/2-HANDLE_SIZE/2, cursor: "ns-resize" },
    { mode: "s", top: rect.h-HANDLE_SIZE/2, left: rect.w/2-HANDLE_SIZE/2, cursor: "ns-resize" },
    { mode: "w", top: rect.h/2-HANDLE_SIZE/2, left: -HANDLE_SIZE/2, cursor: "ew-resize" },
    { mode: "e", top: rect.h/2-HANDLE_SIZE/2, left: rect.w-HANDLE_SIZE/2, cursor: "ew-resize" },
  ];

  return (
    <div style={{ position:"relative", width:displaySize.w, height:displaySize.h, flexShrink:0, borderRadius:8, overflow:"hidden" }}>
      <img src={imageSrc} alt="crop-base" draggable={false}
        style={{ width:displaySize.w, height:displaySize.h, display:"block", userSelect:"none", pointerEvents:"none" }}/>

      {/* 暗いオーバーレイ（選択範囲外をマスク） */}
      <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.55)",
        clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${rect.y}px, ${rect.x}px ${rect.y}px, ${rect.x}px ${rect.y+rect.h}px, ${rect.x+rect.w}px ${rect.y+rect.h}px, ${rect.x+rect.w}px ${rect.y}px, 0 ${rect.y}px)`,
        pointerEvents:"none" }}/>

      {/* 選択矩形 */}
      <div
        onMouseDown={e => startInteraction(e, "move")}
        onTouchStart={e => startInteraction(e, "move")}
        style={{
          position:"absolute", left:rect.x, top:rect.y, width:rect.w, height:rect.h,
          border:"2px solid #6366f1", cursor:"move", boxShadow:"0 0 0 9999px rgba(0,0,0,0)",
          touchAction:"none",
        }}
      >
        {/* 3分割グリッド線（構図の目安） */}
        <div style={{ position:"absolute", left:"33.33%", top:0, width:1, height:"100%", background:"rgba(255,255,255,0.4)" }}/>
        <div style={{ position:"absolute", left:"66.66%", top:0, width:1, height:"100%", background:"rgba(255,255,255,0.4)" }}/>
        <div style={{ position:"absolute", top:"33.33%", left:0, height:1, width:"100%", background:"rgba(255,255,255,0.4)" }}/>
        <div style={{ position:"absolute", top:"66.66%", left:0, height:1, width:"100%", background:"rgba(255,255,255,0.4)" }}/>

        {/* リサイズハンドル */}
        {handles.map(h => (
          <div key={h.mode}
            onMouseDown={e => startInteraction(e, h.mode)}
            onTouchStart={e => startInteraction(e, h.mode)}
            style={{
              position:"absolute", top:h.top, left:h.left,
              width:HANDLE_SIZE, height:HANDLE_SIZE, borderRadius:"50%",
              background:"#6366f1", border:"2px solid #fff",
              cursor:h.cursor, touchAction:"none", zIndex:10,
              boxShadow:"0 2px 6px rgba(0,0,0,0.5)",
            }}
          />
        ))}
      </div>

      {/* サイズ表示バッジ */}
      <div style={{
        position:"absolute", left:rect.x, top: rect.y - 28,
        background:"#6366f1", color:"#fff", fontSize:"0.7rem", fontWeight:700,
        padding:"3px 8px", borderRadius:6, pointerEvents:"none",
      }}>
        {Math.round(rect.w/scale)} × {Math.round(rect.h/scale)} px
      </div>

      {/* 確定/キャンセルボタン */}
      <div style={{ position:"absolute", bottom:12, left:"50%", transform:"translateX(-50%)", display:"flex", gap:8, zIndex:20 }}>
        <button onClick={onCancel} style={{
          display:"flex", alignItems:"center", gap:5, padding:"8px 16px", borderRadius:8,
          border:"1px solid #3a3a52", background:"#1e1e2e", color:"#c4c4d4", cursor:"pointer", fontSize:"0.8rem", fontWeight:700,
        }}>
          <X size={14}/> キャンセル
        </button>
        <button onClick={handleConfirm} style={{
          display:"flex", alignItems:"center", gap:5, padding:"8px 16px", borderRadius:8,
          border:"none", background:"#10b981", color:"#fff", cursor:"pointer", fontSize:"0.8rem", fontWeight:700,
        }}>
          <Check size={14}/> 切り抜き確定
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// IMAGE ADJUST PANEL（明るさ・コントラスト調整パネル）
// ════════════════════════════════════════════════════════════
function ImageAdjustPanel({ adjustments, onChange, onReset, onClose }) {
  const set = (key, value) => onChange({ ...adjustments, [key]: value });
  return (
    <div style={{ background:"#13131f", border:"1px solid #2a2a3d", borderRadius:14, padding:"10px 12px", display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <SlidersHorizontal size={13} style={{ color:"#818cf8" }}/>
        <span style={{ fontSize:"0.75rem", fontWeight:700, color:"#c4c4d4" }}>画像補正（明るさ・コントラスト）</span>
        <span style={{ fontSize:"0.68rem", color:"#64748b", marginLeft:4 }}>OCR前に文字をくっきりさせると認識精度が上がります</span>
        <button onClick={onClose} style={{ marginLeft:"auto", background:"none", border:"none", color:"#666", cursor:"pointer" }}>
          <X size={14}/>
        </button>
      </div>

      <div style={{ display:"flex", gap:16, flexWrap:"wrap", alignItems:"center" }}>
        <SliderRow
          label="明るさ"
          value={adjustments.brightness}
          min={-100} max={100} step={1}
          display={`${adjustments.brightness > 0 ? "+" : ""}${adjustments.brightness}`}
          onChange={v => set("brightness", v)}
        />
        <SliderRow
          label="コントラスト"
          value={adjustments.contrast}
          min={-100} max={100} step={1}
          display={`${adjustments.contrast > 0 ? "+" : ""}${adjustments.contrast}`}
          onChange={v => set("contrast", v)}
        />
        <button onClick={onReset} style={{
          display:"flex", alignItems:"center", gap:4, padding:"6px 10px", borderRadius:7,
          border:"1px solid #3a3a52", background:"#1c1c2a", color:"#c4c4d4", cursor:"pointer", fontSize:"0.74rem",
        }}>
          <RotateCcw size={12}/> リセット
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// スナップ（整列ガイド）計算
// ════════════════════════════════════════════════════════════
const SNAP_THRESHOLD = 6; // px（表示スケール後の判定距離）

/**
 * 移動中のレイヤー(movingLayer, 表示座標換算後)について、
 * 他レイヤー・画像中央・画像端 から最も近いスナップ候補を探し、
 * スナップ後の表示座標とガイド線情報を返す。
 */
function computeSnap(movingLayer, otherLayers, scale, canvasW, canvasH) {
  const mx0 = movingLayer.x * scale;
  const my0 = movingLayer.y * scale;
  const mx1 = mx0 + movingLayer.width  * scale;
  const my1 = my0 + movingLayer.height * scale;
  const mcx = (mx0 + mx1) / 2;
  const mcy = (my0 + my1) / 2;

  // 縦方向(X)・横方向(Y)それぞれの候補ガイド値を集める
  const vCandidates = []; // { value, sourceX } 縦線（X座標が一致）
  const hCandidates = []; // { value, sourceY } 横線（Y座標が一致）

  // 画像全体の端・中央
  vCandidates.push({ value: 0 }, { value: canvasW / 2 }, { value: canvasW });
  hCandidates.push({ value: 0 }, { value: canvasH / 2 }, { value: canvasH });

  for (const other of otherLayers) {
    if (other.id === movingLayer.id) continue;
    const ox0 = other.x * scale;
    const oy0 = other.y * scale;
    const ox1 = ox0 + other.width  * scale;
    const oy1 = oy0 + other.height * scale;
    const ocx = (ox0 + ox1) / 2;
    const ocy = (oy0 + oy1) / 2;
    vCandidates.push({ value: ox0 }, { value: ocx }, { value: ox1 });
    hCandidates.push({ value: oy0 }, { value: ocy }, { value: oy1 });
  }

  // 自分の left / center / right それぞれについて最も近い候補を探す
  let bestDx = null, snappedX = null, guideX = null;
  for (const selfX of [mx0, mcx, mx1]) {
    for (const c of vCandidates) {
      const d = c.value - selfX;
      if (bestDx === null || Math.abs(d) < Math.abs(bestDx)) {
        bestDx = d; guideX = c.value;
      }
    }
  }
  if (bestDx !== null && Math.abs(bestDx) <= SNAP_THRESHOLD) {
    snappedX = mx0 + bestDx;
  }

  let bestDy = null, snappedY = null, guideY = null;
  for (const selfY of [my0, mcy, my1]) {
    for (const c of hCandidates) {
      const d = c.value - selfY;
      if (bestDy === null || Math.abs(d) < Math.abs(bestDy)) {
        bestDy = d; guideY = c.value;
      }
    }
  }
  if (bestDy !== null && Math.abs(bestDy) <= SNAP_THRESHOLD) {
    snappedY = my0 + bestDy;
  }

  return {
    snappedDispX: snappedX, // nullなら吸着なし（表示座標）
    snappedDispY: snappedY,
    guideX: snappedX !== null ? guideX : null,
    guideY: snappedY !== null ? guideY : null,
  };
}

// ════════════════════════════════════════════════════════════
// EDITOR CANVAS（CSS表示プレビュー）
// ════════════════════════════════════════════════════════════

/**
 * テキストレイヤーのCSSスタイルを構築する。
 * 横書き/縦書き、行間、字間、縁取り、影をすべてCSSプロパティで再現する。
 * 縁取りは text-shadow を多重スタックすることでアウトライン風に近似する
 * （CSSにネイティブな stroke は無いため）。
 */
function buildLayerTextStyle(layer, dispFs, scale) {
  const dispLetterSpacing = layer.letterSpacing * scale;
  const dispStrokeW = layer.strokeWidth * scale;

  // 縁取り近似: 8方向 + 影を text-shadow に積む
  const shadows = [];
  if (dispStrokeW > 0) {
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const ox = Math.cos(angle) * dispStrokeW;
      const oy = Math.sin(angle) * dispStrokeW;
      shadows.push(`${ox.toFixed(2)}px ${oy.toFixed(2)}px 0 ${layer.strokeColor}`);
    }
  }
  if (layer.shadowEnabled) {
    shadows.push(`${layer.shadowOffsetX*scale}px ${layer.shadowOffsetY*scale}px ${layer.shadowBlur*scale}px ${layer.shadowColor}`);
  }

  const base = {
    color: layer.color,
    fontFamily: layer.fontFamily,
    fontWeight: layer.fontWeight,
    fontStyle: layer.fontStyle,
    fontSize: dispFs,
    lineHeight: layer.lineHeight,
    letterSpacing: `${dispLetterSpacing}px`,
    textShadow: shadows.length ? shadows.join(", ") : "none",
  };

  if (layer.writingMode === "vertical") {
    return {
      ...base,
      writingMode: "vertical-rl",
      textOrientation: "upright",
    };
  }
  return base;
}

function EditorCanvas({
  imageSrc, displaySize, naturalSize, layers, activeId,
  onLayerClick, onLayerChange, onLayerCommit, onLayerDelete, onCanvasClick,
  adjustments,
}) {
  const scale = naturalSize.w > 0 ? displaySize.w / naturalSize.w : 1;
  const dragRef   = useRef(null);
  const resizeRef = useRef(null);
  const textEditSnapshotRef = useRef(null);
  const [guides, setGuides] = useState({ x: null, y: null });

  const clientPos = e => {
    if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  };

  const startDrag = useCallback((e, layerId) => {
    e.preventDefault(); e.stopPropagation();
    onLayerClick(layerId);
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    const { x: cx, y: cy } = clientPos(e.nativeEvent ?? e);
    // ドラッグ開始前のレイヤー配列をスナップショットとして保持（Undo用）
    const snapshotBefore = layers;
    dragRef.current = { layerId, startX: cx - layer.x*scale, startY: cy - layer.y*scale, moved: false, snapshotBefore };

    const onMove = ev => {
      ev.preventDefault();
      if (!dragRef.current) return;
      const { x, y } = clientPos(ev);
      let rawDispX = x - dragRef.current.startX;
      let rawDispY = y - dragRef.current.startY;

      // スナップ判定（表示座標ベース）
      const movingDisplayLayer = { ...layer, x: rawDispX / scale, y: rawDispY / scale };
      const snap = computeSnap(movingDisplayLayer, layers, scale, displaySize.w, displaySize.h);
      let finalDispX = rawDispX, finalDispY = rawDispY;
      if (snap.snappedDispX !== null) finalDispX = snap.snappedDispX;
      if (snap.snappedDispY !== null) finalDispY = snap.snappedDispY;
      setGuides({ x: snap.guideX, y: snap.guideY });

      dragRef.current.moved = true;
      onLayerChange({ ...layer, x: Math.round(finalDispX/scale), y: Math.round(finalDispY/scale) });
    };
    const onUp = () => {
      if (dragRef.current?.moved) onLayerCommit(dragRef.current.snapshotBefore);
      dragRef.current = null;
      setGuides({ x: null, y: null });
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
    };
    window.addEventListener("mousemove", onMove, { passive:false });
    window.addEventListener("touchmove", onMove, { passive:false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  }, [layers, scale, displaySize, onLayerClick, onLayerChange, onLayerCommit]);

  const startResize = useCallback((e, layerId) => {
    e.preventDefault(); e.stopPropagation();
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;
    const { x: cx, y: cy } = clientPos(e.nativeEvent ?? e);
    const snapshotBefore = layers;
    resizeRef.current = { layer, startX: cx, startY: cy, moved: false, snapshotBefore };

    const onMove = ev => {
      ev.preventDefault();
      if (!resizeRef.current) return;
      const { x, y } = clientPos(ev);
      const dx = (x - resizeRef.current.startX) / scale;
      const dy = (y - resizeRef.current.startY) / scale;
      resizeRef.current.moved = true;
      onLayerChange({
        ...resizeRef.current.layer,
        width:    Math.max(20, resizeRef.current.layer.width  + dx),
        height:   Math.max(14, resizeRef.current.layer.height + dy),
        fontSize: Math.max(8,  resizeRef.current.layer.fontSize + Math.round(dy*0.5)),
      });
    };
    const onUp = () => {
      if (resizeRef.current?.moved) onLayerCommit(resizeRef.current.snapshotBefore);
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
    };
    window.addEventListener("mousemove", onMove, { passive:false });
    window.addEventListener("touchmove", onMove, { passive:false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
  }, [layers, scale, onLayerChange, onLayerCommit]);

  return (
    <div style={{ position:"relative", width:displaySize.w, height:displaySize.h, flexShrink:0, boxShadow:"0 8px 40px rgba(0,0,0,0.7)", borderRadius:8, overflow:"visible" }}
      onClick={e => { e.stopPropagation(); onCanvasClick(); }}>
      <img src={imageSrc} alt="base" draggable={false}
        style={{ width:displaySize.w, height:displaySize.h, display:"block", userSelect:"none", pointerEvents:"none", borderRadius:8,
          filter: buildCssFilter(adjustments) }}/>

      {/* ── スナップガイド線 ── */}
      {guides.x !== null && (
        <div style={{ position:"absolute", left:guides.x, top:0, width:1, height:displaySize.h, background:"#f43f5e", zIndex:300, pointerEvents:"none", boxShadow:"0 0 4px #f43f5e" }}/>
      )}
      {guides.y !== null && (
        <div style={{ position:"absolute", top:guides.y, left:0, height:1, width:displaySize.w, background:"#f43f5e", zIndex:300, pointerEvents:"none", boxShadow:"0 0 4px #f43f5e" }}/>
      )}

      {layers.map(layer => {
        const isActive = layer.id === activeId;
        const dx = layer.x*scale, dy = layer.y*scale;
        const dw = layer.width*scale, dh = layer.height*scale;
        const dfs = layer.fontSize*scale;
        const textStyle = buildLayerTextStyle(layer, dfs, scale);

        return (
          <div key={layer.id}
            onMouseDown={e => startDrag(e, layer.id)}
            onTouchStart={e => startDrag(e, layer.id)}
            onClick={e => { e.stopPropagation(); onLayerClick(layer.id); }}
            style={{
              position:"absolute", left:dx, top:dy, width:dw, minHeight:dh,
              backgroundColor:layer.backgroundColor,
              opacity:layer.opacity, boxSizing:"border-box", padding:`${2*scale}px ${4*scale}px`,
              cursor:"move", border: isActive?"2px solid #6366f1":"1px dashed rgba(255,255,255,0.15)",
              borderRadius:3, userSelect:"none", wordBreak:"break-all",
              zIndex: isActive?100:10, touchAction:"none",
              overflow: "visible",
            }}>
            {isActive ? (
              <textarea autoFocus value={layer.text}
                onFocus={() => { textEditSnapshotRef.current = layers; }}
                onChange={e => onLayerChange({ ...layer, text: e.target.value })}
                onBlur={() => {
                  if (textEditSnapshotRef.current) onLayerCommit(textEditSnapshotRef.current);
                  textEditSnapshotRef.current = null;
                }}
                onClick={e => e.stopPropagation()}
                onTouchStart={e => e.stopPropagation()}
                onKeyDown={e => e.stopPropagation()}
                style={{
                  width: layer.writingMode === "vertical" ? dh : "100%",
                  height: layer.writingMode === "vertical" ? "100%" : "auto",
                  minHeight:dh, background:"transparent", border:"none", outline:"none",
                  resize:"none", padding:0, overflow:"hidden", touchAction:"auto",
                  ...textStyle,
                }}
                rows={Math.max(1, Math.ceil(layer.text.length/15))}/>
            ) : (
              <span style={{ display:"block", whiteSpace:"pre-wrap", pointerEvents:"none", ...textStyle }}>
                {layer.text}
              </span>
            )}

            {isActive && <>
              {/* 移動ハンドル */}
              <div title="移動" onMouseDown={e=>startDrag(e,layer.id)} onTouchStart={e=>startDrag(e,layer.id)} onClick={e=>e.stopPropagation()}
                style={{ position:"absolute", top:-14, left:"50%", transform:"translateX(-50%)", width:26, height:26, borderRadius:"50%",
                  background:"#6366f1", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center",
                  cursor:"grab", touchAction:"none", zIndex:200, boxShadow:"0 2px 8px rgba(99,102,241,0.6)" }}>
                <Move size={13}/>
              </div>
              {/* 削除ハンドル */}
              <div title="削除" onMouseDown={e=>{e.stopPropagation();e.preventDefault();onLayerDelete(layer.id);}} onTouchStart={e=>{e.stopPropagation();e.preventDefault();onLayerDelete(layer.id);}}
                style={{ position:"absolute", top:-14, right:-14, width:26, height:26, borderRadius:"50%",
                  background:"#ef4444", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center",
                  cursor:"pointer", touchAction:"none", zIndex:200, boxShadow:"0 2px 8px rgba(239,68,68,0.6)" }}>
                <Trash2 size={12}/>
              </div>
              {/* リサイズハンドル */}
              <div title="リサイズ" onMouseDown={e=>startResize(e,layer.id)} onTouchStart={e=>startResize(e,layer.id)} onClick={e=>e.stopPropagation()}
                style={{ position:"absolute", bottom:-14, right:-14, width:26, height:26, borderRadius:4,
                  background:"#10b981", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center",
                  cursor:"se-resize", touchAction:"none", zIndex:200, fontSize:16, fontWeight:"bold", boxShadow:"0 2px 8px rgba(16,185,129,0.6)" }}>
                ↘
              </div>
            </>}
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════
const LANG_OPTIONS = [
  { value:"jpn+eng", label:"日本語+英語" },
  { value:"jpn",     label:"日本語"      },
  { value:"eng",     label:"英語"        },
  { value:"chi_sim", label:"中国語(簡)"  },
  { value:"kor",     label:"韓国語"      },
];

export default function App() {
  const [imageSrc,    setImageSrc]    = useState(null);
  const [imageEl,     setImageEl]     = useState(null);
  const [naturalSize, setNaturalSize] = useState({ w:0, h:0 });
  const [displaySize, setDisplaySize] = useState({ w:0, h:0 });

  // ── レイヤー状態（Undo/Redo対応） ──
  const layersHistory = useHistoryState([]);
  const layers = layersHistory.state;

  const [activeId,    setActiveId]    = useState(null);
  const [ocrRunning,  setOcrRunning]  = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [saving,      setSaving]      = useState(false);
  const [lang,        setLang]        = useState("jpn+eng");
  const [statusMsg,   setStatusMsg]   = useState("");
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [showLayers,  setShowLayers]  = useState(false);

  // ── 画像補正（明るさ・コントラスト） ──
  const [adjustments, setAdjustments] = useState(DEFAULT_ADJUSTMENTS);
  const [showAdjustPanel, setShowAdjustPanel] = useState(false);

  // ── トリミングモード ──
  const [cropMode, setCropMode] = useState(false);

  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const fileInputRef2 = useRef(null);

  const computeDisplaySize = useCallback((natW, natH) => {
    const el = containerRef.current;
    const maxW = el ? el.clientWidth : window.innerWidth - 24;
    const maxH = window.innerHeight * 0.52;
    const ratio = Math.min(maxW / natW, maxH / natH, 1);
    return { w: Math.round(natW*ratio), h: Math.round(natH*ratio) };
  }, []);

  const handleFileChange = useCallback(e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ds = computeDisplaySize(img.naturalWidth, img.naturalHeight);
      setImageSrc(url); setImageEl(img);
      setNaturalSize({ w:img.naturalWidth, h:img.naturalHeight });
      setDisplaySize(ds); layersHistory.reset([]); setActiveId(null);
      setAdjustments(DEFAULT_ADJUSTMENTS); setCropMode(false);
      setStatusMsg(`画像読み込み完了 (${img.naturalWidth}×${img.naturalHeight}px) — OCRを実行してください`);
    };
    img.src = url;
  }, [computeDisplaySize]);

  const handleDrop = useCallback(e => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file?.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ds = computeDisplaySize(img.naturalWidth, img.naturalHeight);
      setImageSrc(url); setImageEl(img);
      setNaturalSize({ w:img.naturalWidth, h:img.naturalHeight });
      setDisplaySize(ds); layersHistory.reset([]); setActiveId(null);
      setAdjustments(DEFAULT_ADJUSTMENTS); setCropMode(false);
      setStatusMsg("画像を読み込みました — OCRを実行してください");
    };
    img.src = url;
  }, [computeDisplaySize]);

  const handleOCR = useCallback(async () => {
    if (!imageEl || ocrRunning) return;
    setOcrRunning(true); setOcrProgress(0);
    setStatusMsg("Tesseract.jsでOCR解析中...");
    try {
      const result = await runOCR(imageEl, lang, p => setOcrProgress(p), adjustments);
      layersHistory.commit(() => result); setActiveId(null);
      setStatusMsg(`解析完了 — ${result.length}個のテキストレイヤーを生成しました`);
    } catch (err) {
      setStatusMsg("エラー: " + (err?.message ?? "不明なエラー"));
    } finally { setOcrRunning(false); }
  }, [imageEl, lang, ocrRunning, adjustments]);

  const handleAddText = useCallback(() => {
    const id = `layer-manual-${Date.now()}`;
    const newLayer = {
      id, text:"新規テキスト",
      x: Math.round(naturalSize.w/2 - 150),
      y: Math.round(naturalSize.h/2 - 25),
      width:300, height:60, fontSize:32,
      ...defaultLayerStyle(),
    };
    layersHistory.commit(prev => [...prev, newLayer]);
    setActiveId(id);
  }, [naturalSize]);

  // ドラッグ・リサイズ中の連続更新（履歴には積まない）
  const handleLayerChange = useCallback(updated => {
    layersHistory.update(prev => prev.map(l => l.id===updated.id ? updated : l));
  }, []);

  // ドラッグ・リサイズ・テキスト編集の完了時（操作前スナップショットを履歴に積む）
  const handleLayerCommit = useCallback((snapshotBeforeOperation) => {
    layersHistory.commitSnapshot(snapshotBeforeOperation);
  }, []);

  // ツールバーでのスタイル変更（色・フォント・行間など）は即時1操作としてcommit
  const handleLayerStyleChange = useCallback(updated => {
    layersHistory.commit(prev => prev.map(l => l.id===updated.id ? updated : l));
  }, []);

  const handleLayerDelete = useCallback(id => {
    layersHistory.commit(prev => prev.filter(l => l.id!==id));
    setActiveId(null);
  }, []);

  // 矢印キーによる微動（ナッジ）。Undo履歴には1ステップとして積む。
  // ── トリミング確定 ──
  // 切り出したrect(オリジナル解像度基準)で画像を再生成し、
  // レイヤー座標はrectの原点(x,y)だけ引いて追従させる。
  // 画像範囲外に出てしまったレイヤーは破棄せず、そのまま座標だけずらす
  // （ユーザーが後で見える位置に動かせるようにするため）。
  const handleCropConfirm = useCallback(async (rect) => {
    if (!imageEl) return;
    setSaving(true);
    setStatusMsg("トリミング中...");
    try {
      const newImg = await cropImageToNewElement(imageEl, rect);
      const ds = computeDisplaySize(newImg.naturalWidth, newImg.naturalHeight);

      setImageSrc(newImg.src);
      setImageEl(newImg);
      setNaturalSize({ w: newImg.naturalWidth, h: newImg.naturalHeight });
      setDisplaySize(ds);

      // 既存レイヤーをクロップ原点だけシフトして追従させる
      layersHistory.commit(prev => prev.map(l => ({
        ...l,
        x: l.x - rect.x,
        y: l.y - rect.y,
      })));

      setCropMode(false);
      setStatusMsg(`トリミング完了 (${newImg.naturalWidth}×${newImg.naturalHeight}px)`);
    } catch (err) {
      setStatusMsg("トリミングエラー: " + err.message);
    } finally {
      setSaving(false);
    }
  }, [imageEl, computeDisplaySize]);

  const handleNudge = useCallback((dx, dy) => {
    if (!activeId) return;
    layersHistory.commit(prev => prev.map(l =>
      l.id === activeId ? { ...l, x: l.x + dx, y: l.y + dy } : l
    ));
  }, [activeId]);

  const handleExport = useCallback(async () => {
    if (!imageEl) return;
    setSaving(true); setStatusMsg("高解像度PNG生成中...");
    await new Promise(r => setTimeout(r, 80));
    try {
      exportHighResPNG(imageEl, layers, adjustments);
      setStatusMsg("PNG保存完了！");
    } catch (err) { setStatusMsg("保存エラー: " + err.message); }
    finally { setSaving(false); }
  }, [imageEl, layers, adjustments]);

  useEffect(() => {
    if (!naturalSize.w) return;
    const obs = new ResizeObserver(() => {
      const ds = computeDisplaySize(naturalSize.w, naturalSize.h);
      setDisplaySize(prev => (prev.w===ds.w && prev.h===ds.h) ? prev : ds);
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [naturalSize, computeDisplaySize]);

  // ── キーボードショートカット: Undo/Redo + 矢印キーナッジ ──
  useEffect(() => {
    const onKeyDown = (e) => {
      // トリミングモード中はUndo/Redo・ナッジを無効化（誤操作防止）
      if (cropMode) return;
      // テキスト入力中（textarea/input にフォーカスがある）は無視する
      const tag = document.activeElement?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;

      const isMeta = e.metaKey || e.ctrlKey;

      // Undo: Ctrl/Cmd + Z (Shiftなし)
      if (isMeta && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        layersHistory.undo();
        return;
      }
      // Redo: Ctrl/Cmd + Shift + Z, または Ctrl + Y
      if ((isMeta && e.shiftKey && e.key.toLowerCase() === "z") ||
          (isMeta && e.key.toLowerCase() === "y")) {
        e.preventDefault();
        layersHistory.redo();
        return;
      }

      // 矢印キーでのナッジ（レイヤー選択中のみ）
      if (!activeId) return;
      const step = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === "ArrowUp")    dy = -step;
      else if (e.key === "ArrowDown")  dy =  step;
      else if (e.key === "ArrowLeft")  dx = -step;
      else if (e.key === "ArrowRight") dx =  step;
      else return;

      e.preventDefault();
      handleNudge(dx, dy);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, handleNudge, layersHistory, cropMode]);

  const activeLayer = layers.find(l => l.id===activeId) ?? null;

  return (
    <>
      <style>{`
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
        body{background:#0b0b0f;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
        .page{display:flex;flex-direction:column;height:100vh;max-width:860px;margin:0 auto;padding:10px;gap:8px;}
        .header{display:flex;align-items:center;gap:8px;padding:4px 0 8px;border-bottom:1px solid #1e1e2f;flex-wrap:wrap;}
        .logo{font-size:1rem;font-weight:800;color:#818cf8;display:flex;align-items:center;gap:5px;letter-spacing:-0.03em;white-space:nowrap;}
        .hdr-r{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;align-items:center;}
        .btn{display:inline-flex;align-items:center;gap:5px;padding:7px 12px;border-radius:8px;border:none;cursor:pointer;font-size:0.78rem;font-weight:700;transition:all 0.15s;white-space:nowrap;}
        .btn:disabled{opacity:0.4;cursor:not-allowed;}
        .btn-d{background:#1e1e2e;color:#c4c4d4;border:1px solid #3a3a52;}
        .btn-d:hover:not(:disabled){background:#2a2a3f;}
        .btn-p{background:#4f46e5;color:#fff;}
        .btn-p:hover:not(:disabled){background:#4338ca;}
        .btn-g{background:#10b981;color:#fff;}
        .btn-g:hover:not(:disabled){background:#059669;}
        .ocr-track{height:3px;background:#1e1e2e;border-radius:2px;overflow:hidden;}
        .ocr-fill{height:100%;background:linear-gradient(90deg,#4f46e5,#818cf8);transition:width 0.25s;}
        .status{font-size:0.73rem;color:#64748b;background:#0f0f18;border:1px solid #1a1a2a;border-radius:7px;padding:5px 10px;}
        .workspace{flex:1;display:flex;align-items:center;justify-content:center;background:#040408;border-radius:12px;border:1px dashed #1e1e2e;overflow:auto;min-height:0;padding:12px;}
        .drop-zone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;border:2px dashed #2e2e45;border-radius:16px;padding:48px 24px;cursor:pointer;transition:all 0.2s;width:100%;max-width:480px;}
        .drop-zone:hover{border-color:#4f46e5;background:#0d0d1a;}
        .drop-zone h2{font-size:1rem;color:#c4c4d4;}
        .drop-zone p{font-size:0.78rem;color:#64748b;}
        .lang-dd{position:relative;}
        .lang-menu{position:absolute;top:calc(100% + 4px);right:0;background:#1a1a2a;border:1px solid #2e2e45;border-radius:10px;overflow:hidden;z-index:500;min-width:140px;box-shadow:0 8px 24px rgba(0,0,0,0.5);}
        .lang-item{padding:9px 14px;font-size:0.8rem;cursor:pointer;color:#c4c4d4;transition:background 0.1s;}
        .lang-item:hover{background:#2a2a3f;}
        .lang-item.sel{color:#818cf8;font-weight:700;}
        .layers-panel{background:#0f0f18;border:1px solid #1e1e2e;border-radius:12px;overflow:hidden;}
        .layers-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #1e1e2e;cursor:pointer;user-select:none;}
        .layers-hdr span{font-size:0.75rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;}
        .layers-list{max-height:120px;overflow-y:auto;}
        .layer-row{display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;transition:background 0.1s;font-size:0.78rem;}
        .layer-row:hover{background:#1a1a2a;}
        .layer-row.active{background:#1e1e3a;}
        .layer-txt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b0b0c4;}
        .layer-del{background:none;border:none;color:#3a3a52;cursor:pointer;padding:2px 4px;border-radius:4px;}
        .layer-del:hover{color:#ef4444;}
        .overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;}
        .spin{animation:spin 1s linear infinite;}
        @keyframes spin{to{transform:rotate(360deg);}}
        @media(max-width:480px){.btn{padding:7px 9px;font-size:0.72rem;}}
      `}</style>

      <div className="page">
        <header className="header">
          <div className="logo"><Sparkles size={16}/> 文字打ち替えAI</div>
          <div className="hdr-r">
            {/* Undo / Redo */}
            <button className="btn btn-d" title="元に戻す (Ctrl/Cmd+Z)" onClick={() => layersHistory.undo()} disabled={!layersHistory.canUndo || saving}>
              <Undo2 size={13}/>
            </button>
            <button className="btn btn-d" title="やり直す (Ctrl/Cmd+Shift+Z)" onClick={() => layersHistory.redo()} disabled={!layersHistory.canRedo || saving}>
              <Redo2 size={13}/>
            </button>

            {/* 言語選択 */}
            <div className="lang-dd">
              <button className="btn btn-d" onClick={() => setShowLangMenu(v=>!v)}>
                <Languages size={13}/>{LANG_OPTIONS.find(o=>o.value===lang)?.label}
              </button>
              {showLangMenu && (
                <div className="lang-menu">
                  {LANG_OPTIONS.map(o => (
                    <div key={o.value} className={`lang-item ${lang===o.value?"sel":""}`}
                      onClick={() => { setLang(o.value); setShowLangMenu(false); }}>
                      {o.label}
                    </div>
                  ))}
                </div>

              )}
            </div>

            <button className="btn btn-d" onClick={() => fileInputRef.current?.click()} disabled={cropMode}>
              <Upload size={13}/> 開く
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              style={{ display: "none" }}
            />

            {imageSrc && (
              <button className="btn btn-d" onClick={() => setCropMode(true)} disabled={ocrRunning||saving||cropMode}>
                <Crop size={13}/> トリミング
              </button>
            )}
            {imageSrc && (
              <button className={`btn ${showAdjustPanel ? "btn-p" : "btn-d"}`} onClick={() => setShowAdjustPanel(v=>!v)} disabled={ocrRunning||saving||cropMode}>
                <SlidersHorizontal size={13}/> 補正
              </button>
            )}
            {imageSrc && (
              <button className="btn btn-p" onClick={handleOCR} disabled={ocrRunning||saving||cropMode}>
                {ocrRunning ? <><Loader2 size={13} className="spin"/>{ocrProgress}%</> : <><Scan size={13}/>OCR</>}
              </button>
            )}
            {imageSrc && (
              <button className="btn btn-d" onClick={handleAddText} disabled={ocrRunning||saving||cropMode}>
                <Plus size={13}/>テキスト
              </button>
            )}
            {layers.length>0 && (
              <button className="btn btn-d" onClick={() => { layersHistory.commit(() => []); setActiveId(null); setStatusMsg("リセットしました"); }} disabled={saving||cropMode}>
                <RotateCcw size={13}/>
              </button>
            )}
            {imageSrc && (
              <button className="btn btn-g" onClick={handleExport} disabled={saving||ocrRunning||cropMode}>
                {saving ? <><Loader2 size={13} className="spin"/>生成中</> : <><Download size={13}/>保存</>}
              </button>
            )}
          </div>
        </header>

        {ocrRunning && <div className="ocr-track"><div className="ocr-fill" style={{ width:`${ocrProgress}%` }}/></div>}
        {statusMsg && <div className="status">{statusMsg}</div>}

        {showAdjustPanel && !cropMode && (
          <ImageAdjustPanel
            adjustments={adjustments}
            onChange={setAdjustments}
            onReset={() => setAdjustments(DEFAULT_ADJUSTMENTS)}
            onClose={() => setShowAdjustPanel(false)}
          />
        )}

        {activeLayer && !cropMode && (
          <Toolbar layer={activeLayer} onChange={handleLayerStyleChange}
            onDelete={() => handleLayerDelete(activeId)}
            onDeselect={() => setActiveId(null)}/>
        )}

        <div ref={containerRef} className="workspace"
          onClick={() => { if (!cropMode) { setActiveId(null); setShowLangMenu(false); } }}
          onDrop={handleDrop} onDragOver={e => e.preventDefault()}>
          {imageSrc && imageEl && cropMode ? (
            <CropOverlay
              imageSrc={imageSrc} displaySize={displaySize} naturalSize={naturalSize}
              onConfirm={handleCropConfirm}
              onCancel={() => setCropMode(false)}
            />
          ) : imageSrc && imageEl ? (
            <EditorCanvas imageSrc={imageSrc} displaySize={displaySize} naturalSize={naturalSize}
              layers={layers} activeId={activeId}
              onLayerClick={setActiveId} onLayerChange={handleLayerChange}
              onLayerCommit={handleLayerCommit}
              onLayerDelete={handleLayerDelete} onCanvasClick={() => setActiveId(null)}
              adjustments={adjustments}/>
          ) : (
            <div className="drop-zone" onClick={() => fileInputRef2.current?.click()}>
              <Upload size={36} style={{ color:"#4f46e5" }}/>
              <h2>画像をアップロード</h2>
              <p>タップして選択 または ドラッグ＆ドロップ</p>
              <p>JPG / PNG / WEBP 対応</p>

              <input
                ref={fileInputRef2}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
            </div>
          )}
        </div>

        {layers.length>0 && !cropMode && (
          <div className="layers-panel">
            <div className="layers-hdr" onClick={() => setShowLayers(v=>!v)}>
              <AlignLeft size={13} style={{ color:"#64748b" }}/>
              <span>レイヤー ({layers.length})</span>
              <span style={{ marginLeft:"auto", fontSize:"0.7rem", color:"#3a3a52" }}>{showLayers?"▲":"▼"}</span>
            </div>
            {showLayers && (
              <div className="layers-list">
                {layers.map(l => (
                  <div key={l.id} className={`layer-row ${l.id===activeId?"active":""}`} onClick={() => setActiveId(l.id)}>
                    <Type size={11} style={{ color:"#3a3a52", flexShrink:0 }}/>
                    <span className="layer-txt">{l.text||"(空)"}</span>
                    <button className="layer-del" onClick={e => { e.stopPropagation(); handleLayerDelete(l.id); }}><X size={12}/></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {saving && (
        <div className="overlay">
          <Loader2 size={44} color="#4f46e5" className="spin"/>
          <span style={{ fontSize:"0.9rem", color:"#e2e8f0" }}>高解像度PNGを生成しています...</span>
        </div>
      )}

      {showLangMenu && <div style={{ position:"fixed", inset:0, zIndex:400 }} onClick={() => setShowLangMenu(false)}/>}
    </>
  );
}
