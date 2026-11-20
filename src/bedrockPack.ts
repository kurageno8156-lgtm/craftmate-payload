// Minecraft統合版（Bedrock Edition）向けリソースパック (.mcpack) ジェネレータ。
// .mcpack は ZIP 形式。JSON UI の modifications 機能で HUD に
// CraftMate のロゴ＋ステータスラベルを追加する（バニラ HUD は保持）。
import sharp from 'sharp';

// ---- CRC32 (ZIP store方式で使用) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry { name: string; data: Buffer }

// 最小限の ZIP (store / 無圧縮) ライター。Minecraft は無圧縮ZIPも読める。
function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // UTF-8 flag
    lh.writeUInt16LE(0, 8);             // method: store
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); // time/date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // extra len
    chunks.push(lh, nameBuf, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/int-attr/ext-attr/local-header-offset = 0
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + e.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// CraftMate ロゴ風アイコン（緑のツルハシモチーフ）を SVG→PNG で生成
function iconSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#14532d"/>
  <rect x="4" y="4" width="56" height="56" rx="10" fill="none" stroke="#34d399" stroke-width="3"/>
  <text x="32" y="44" font-size="34" text-anchor="middle">⛏️</text>
</svg>`;
}

const PACK_UUID = '3f8a1c2e-9b4d-4e6f-a1c3-7d5e9f0b2a4c';
const MODULE_UUID = '8c2d5f7a-1e3b-4a6d-9f8e-2b4c6d8a0e1f';

export async function buildBedrockResourcePack(): Promise<Buffer> {
  const packIcon = await sharp(Buffer.from(iconSvg(128))).png().toBuffer();
  const hudIcon = await sharp(Buffer.from(iconSvg(64))).png().toBuffer();

  const manifest = {
    format_version: 1,
    header: {
      name: 'CraftMate HUD',
      description: 'CraftMate AI エージェントのステータスを HUD に表示するリソースパック（Minecraft統合版）',
      uuid: PACK_UUID,
      version: [1, 0, 0],
      min_engine_version: [1, 20, 0],
    },
    modules: [
      { type: 'resources', uuid: MODULE_UUID, version: [1, 0, 0] },
    ],
  };

  // JSON UI: バニラ hud_screen の root_panel に modifications で
  // CraftMate パネルを挿入する（バニラ要素は保持される）。
  const hudScreen = {
    namespace: 'hud',
    craftmate_panel: {
      type: 'panel',
      size: [150, 30],
      anchor_from: 'top_left',
      anchor_to: 'top_left',
      offset: [6, 6],
      layer: 10,
      controls: [
        {
          craftmate_icon: {
            type: 'image',
            texture: 'textures/ui/craftmate_icon',
            size: [26, 26],
            offset: [2, 2],
          },
        },
        {
          craftmate_label: {
            type: 'label',
            text: 'CraftMate AI',
            offset: [32, 8],
            color: [0.55, 0.95, 0.65],
            shadow: true,
          },
        },
        {
          craftmate_status: {
            type: 'label',
            text: 'bot ready',
            offset: [32, 18],
            color: [0.85, 0.9, 0.85],
            shadow: true,
            font_scale_factor: 0.8,
          },
        },
      ],
    },
    root_panel: {
      modifications: [
        {
          array_name: 'controls',
          operation: 'insert_front',
          value: [{ '@hud.craftmate_panel': {} }],
        },
      ],
    },
  };

  const readme = `CraftMate HUD — Minecraft統合版リソースパック
================================================

【インストール方法】
1. この .mcpack ファイルを Minecraft にドラッグ＆ドロップ
   （または「設定 → ストレージ → リソースパック → ファイルを選択」）
2. 「マイパック」から有効化する

【表示内容】
画面左上に CraftMate のロゴとステータスラベルを表示します。
バニラの HUD（ハート・空腹・ホットバー等）はそのまま残ります。

【注意】
- 統合版は Java 版とプロトコルが異なるため、CraftMate ボット本体の
  自動操作はこのパックでは行えません（見た目のカスタマイズ専用です）。
- 他の UI 系リソースパックと併用する場合、HUD の表示位置が
  重なることがあります。その場合は本パック側の offset を調整してください。
`;

  return buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'pack_icon.png', data: packIcon },
    { name: 'textures/ui/craftmate_icon.png', data: hudIcon },
    { name: 'ui/hud_screen.json', data: Buffer.from(JSON.stringify(hudScreen, null, 2), 'utf8') },
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
  ]);
}
