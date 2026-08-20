#!/usr/bin/env node
/**
 * fetch-assets — 从 Steam UGC CDN 拉取 Brass: Birmingham 官方扫描素材并加工到 public/assets/。
 *
 * 来源：ikegami/tts_brass（Tabletop Simulator mod，官方扫描件），URL 清单见同目录
 * asset-manifest.json（个人非商用，见 README Legal note）。素材不进 git（.gitignore）。
 *
 * 用法：npm run fetch-assets -w @brass/web
 * 幂等：已存在的产物跳过；--force 全量重来。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'public', 'assets');
const RAW = join(OUT, 'raw');
const FORCE = process.argv.includes('--force');

const manifest = JSON.parse(readFileSync(join(here, 'asset-manifest.json'), 'utf8'));

const CDN_FALLBACKS = [
  (u) => u, // manifest 里已是 akamai 主源
  (u) => u.replace('steamusercontent-a.akamaihd.net', 'images.steamusercontent.com'),
  (u) => u.replace('steamusercontent-a.akamaihd.net', 'cloud-3.steamusercontent.com'),
];

async function fetchBuf(url) {
  let lastErr;
  for (const rewrite of CDN_FALLBACKS) {
    const u = rewrite(url);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(120_000) });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        lastErr = new Error(`HTTP ${res.status} ${u}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** 下载到 raw/（按 URL 哈希命名，幂等）。返回本地路径。 */
async function download(url) {
  const name = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const path = join(RAW, name);
  if (!FORCE && existsSync(path)) return path;
  const buf = await fetchBuf(url);
  if (buf.length < 1000) throw new Error(`suspiciously small (${buf.length}B): ${url}`);
  writeFileSync(path, buf);
  return path;
}

const tasks = []; // { name, run }
const job = (name, run) => tasks.push({ name, run });

// ---- 版图：降采样到 3000px JPEG ----
job('board.jpg', async (sharp) => {
  const raw = await download(manifest.board);
  await sharp(raw).resize(3000, 3000).jpeg({ quality: 82 }).toFile(join(OUT, 'board.jpg'));
});

// ---- 卡牌：精灵图裁单卡（一个牌面可能有多张美术，输出 face.png / face@2.png …）----
job('cards/*.png', async (sharp) => {
  const { url, back, cols, rows, cells } = manifest.cardSheet;
  const sheet = sharp(await download(url));
  const meta = await sheet.metadata();
  const cw = Math.floor(meta.width / cols);
  const ch = Math.floor(meta.height / rows);
  mkdirSync(join(OUT, 'cards'), { recursive: true });
  const seen = new Map(); // face -> count
  for (const [idx, face] of Object.entries(cells)) {
    const i = Number(idx);
    const left = (i % cols) * cw;
    const top = Math.floor(i / cols) * ch;
    const n = seen.get(face) ?? 0;
    seen.set(face, n + 1);
    const suffix = n === 0 ? '' : `@${n + 1}`;
    await sharp(await download(url))
      .extract({ left, top, width: cw, height: ch })
      .resize(250)
      .png()
      .toFile(join(OUT, 'cards', `${face}${suffix}.png`));
  }
  await sharp(await download(back)).resize(250).png().toFile(join(OUT, 'cards', 'back.png'));
});

// ---- 商人板块：精灵图裁格 ----
job('merchants/*.png', async (sharp) => {
  const { url, cols, rows, cells } = manifest.merchantSheet;
  const buf = await download(url);
  const meta = await sharp(buf).metadata();
  const cw = Math.floor(meta.width / cols);
  const ch = Math.floor(meta.height / rows);
  mkdirSync(join(OUT, 'merchants'), { recursive: true });
  for (const [idx, type] of Object.entries(cells)) {
    const i = Number(idx);
    await sharp(buf)
      .extract({ left: (i % cols) * cw, top: Math.floor(i / cols) * ch, width: cw, height: ch })
      .resize(200)
      .png()
      .toFile(join(OUT, 'merchants', `${type}.png`));
  }
});

// ---- 产业板块：正/背面，按 产业-等级-颜色 命名 ----
job('tiles/*.png', async (sharp) => {
  mkdirSync(join(OUT, 'tiles'), { recursive: true });
  for (const [key, { front, back }] of Object.entries(manifest.tiles)) {
    const [industry, level, color] = key.split('|');
    const base = `${industry}-${level}-${color}`;
    for (const [side, url] of [['', front], ['-back', back]]) {
      const dest = join(OUT, 'tiles', `${base}${side}.png`);
      if (!FORCE && existsSync(dest)) continue;
      await sharp(await download(url)).resize(200).png().toFile(dest);
    }
  }
});

// ---- 钱币 / 玩家肖像 ----
job('coins/*.png', async (sharp) => {
  mkdirSync(join(OUT, 'coins'), { recursive: true });
  for (const [denom, url] of Object.entries(manifest.coins)) {
    await sharp(await download(url)).resize(96).png().toFile(join(OUT, 'coins', `${denom}.png`));
  }
});
job('players/*.png', async (sharp) => {
  mkdirSync(join(OUT, 'players'), { recursive: true });
  for (const [color, url] of Object.entries(manifest.players)) {
    await sharp(await download(url)).resize(128).png().toFile(join(OUT, 'players', `${color}.png`));
  }
});

// ---- 啤酒桶图标：从 Brewery I 板块圆形裁出（紧圈木桶，少带底色）----
job('beer.png', async (sharp) => {
  const url = manifest.tiles['brewery|1|purple'].front;
  const img = sharp(await download(url)).resize(128, 128);
  const circle = Buffer.from(
    `<svg><circle cx="64" cy="64" r="46" fill="#fff"/></svg>`,
  );
  await img
    .composite([{ input: circle, blend: 'dest-in' }])
    .png()
    .toFile(join(OUT, 'beer.png'));
});

// ---- 连线 token 图标：从版图扫描右下角的建路图例裁驳船/火车 ----
job('link-icons', async (sharp) => {
  const raw = await download(manifest.board);
  await sharp(raw).extract({ left: 3995, top: 4698, width: 88, height: 48 }).resize(176).png().toFile(join(OUT, 'link-canal.png'));
  await sharp(raw).extract({ left: 4075, top: 4697, width: 92, height: 52 }).resize(184).png().toFile(join(OUT, 'link-rail.png'));
});

// ---- 执行 ----
const { default: sharp } = await import('sharp').catch(() => {
  console.error('缺少 sharp：请先 npm install（sharp 在 @brass/web 的 devDependencies）');
  process.exit(1);
});

mkdirSync(RAW, { recursive: true });
let failed = 0;
for (const { name, run } of tasks) {
  process.stdout.write(`▸ ${name} … `);
  try {
    await run(sharp);
    console.log('ok');
  } catch (err) {
    failed++;
    console.log(`失败: ${err.message}`);
  }
}
if (failed) {
  console.error(`\n${failed} 个任务失败（网络问题可重跑，已完成的会跳过）`);
  process.exit(1);
}
console.log(`\n素材就绪 → ${OUT}`);
