import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = path.join(ROOT, "README.md");
const CATALOG_PATH = path.join(ROOT, "content", "catalog.json");
const REQUIRED_HEADINGS = [
  "## 这节解决什么问题",
  "## 先记住什么",
  "## 当场怎么做",
  "## 怎么检查",
  "## 常见翻车",
  "## 最小例子",
  "## 来源与时效",
  "## 状态",
];

const args = new Set(process.argv.slice(2));

function fail(message) {
  console.error(`catalog check: ${message}`);
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function relative(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function firstHeading(text) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function lessonFiles() {
  return walk(ROOT)
    .map(relative)
    .filter((file) => /^第\d+部分-[^/]+\/第\d+章-[^/]+\/[^/]+\.md$/.test(file));
}

function sortByNumber(a, b) {
  return a.number - b.number;
}

function appendixOrder(file) {
  if (file.startsWith("附录/A-")) return 1;
  if (file.startsWith("附录/B-")) return 2;
  if (file.startsWith("附录/C-")) return 3;
  return 4;
}

function discoverCatalog() {
  const partMap = new Map();
  for (const file of lessonFiles()) {
    const segments = file.split("/");
    const partMatch = segments[0].match(/^第(\d+)部分-(.+)$/);
    const chapterMatch = segments[1].match(/^第(\d+)章-(.+)$/);
    const lessonMatch = segments[2].match(/^(\d+\.\d+)\s+(.+)\.md$/);
    if (!partMatch || !chapterMatch || !lessonMatch) {
      throw new Error(`无法解析章节路径：${file}`);
    }

    const partNumber = Number(partMatch[1]);
    const chapterNumber = Number(chapterMatch[1]);
    const part = partMap.get(partNumber) ?? {
      number: partNumber,
      title: partMatch[2],
      track: partNumber === 5 ? "elective" : "core",
      chapters: [],
    };
    let chapter = part.chapters.find((item) => item.number === chapterNumber);
    if (!chapter) {
      chapter = { number: chapterNumber, title: chapterMatch[2], lessons: [] };
      part.chapters.push(chapter);
    }
    chapter.lessons.push({
      number: lessonMatch[1],
      title: firstHeading(fs.readFileSync(path.join(ROOT, file), "utf8")),
      path: file,
    });
    partMap.set(partNumber, part);
  }

  const parts = [...partMap.values()].sort(sortByNumber);
  for (const part of parts) {
    part.chapters.sort(sortByNumber);
    for (const chapter of part.chapters) {
      chapter.lessons.sort((a, b) => {
        const [aChapter, aLesson] = a.number.split(".").map(Number);
        const [bChapter, bLesson] = b.number.split(".").map(Number);
        return aChapter - bChapter || aLesson - bLesson;
      });
    }
  }

  const appendixDir = path.join(ROOT, "附录");
  const appendices = fs
    .readdirSync(appendixDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const file = `附录/${entry.name}`;
      return {
        title: firstHeading(fs.readFileSync(path.join(ROOT, file), "utf8")),
        path: file,
      };
    })
    .sort((a, b) => appendixOrder(a.path) - appendixOrder(b.path));

  return {
    schemaVersion: 1,
    title: "职场 AI 实践指南",
    intro: { title: "怎么用这本指南", path: "00-怎么用这本指南.md" },
    lessonContract: { requiredHeadings: REQUIRED_HEADINGS },
    parts,
    appendices,
  };
}

function readCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error(`缺少 ${relative(CATALOG_PATH)}；首次创建请运行 --bootstrap`);
  }
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function allLessons(catalog) {
  return catalog.parts.flatMap((part) =>
    part.chapters.flatMap((chapter) => chapter.lessons),
  );
}

function encodePath(file) {
  return file.replaceAll(" ", "%20");
}

function renderDirectory(catalog) {
  const lines = [
    "## 目录",
    "",
    `- [${catalog.intro.title}](${encodePath(catalog.intro.path)})`,
    "",
  ];
  for (const part of catalog.parts) {
    const elective = part.track === "elective" ? "（选修）" : "";
    lines.push(`### 第 ${part.number} 部分 · ${part.title}${elective}`);
    lines.push("");
    for (const chapter of part.chapters) {
      lines.push(`- 第 ${chapter.number} 章 ${chapter.title}`);
      for (const lesson of chapter.lessons) {
        lines.push(`  - [${lesson.title}](${encodePath(lesson.path)})`);
      }
    }
    lines.push("");
  }
  lines.push("### 附录", "");
  for (const appendix of catalog.appendices) {
    lines.push(`- [${appendix.title}](${encodePath(appendix.path)})`);
  }
  return lines.join("\n");
}

function replaceDirectory(readme, directory) {
  const pattern = /^## 目录\r?\n[\s\S]*?(?=^## 版权\s*$)/m;
  if (!pattern.test(readme)) throw new Error("README.md 缺少可同步的 ## 目录 区块");
  return readme.replace(pattern, `${directory}\n\n`);
}

function localTarget(fromFile, target) {
  const withoutAnchor = target.split("#", 1)[0];
  if (!withoutAnchor || /^(?:https?:|mailto:)/i.test(withoutAnchor)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutAnchor);
  } catch {
    return { path: null, error: "URL 编码无效" };
  }
  const fromDirectory = path.posix.dirname(fromFile);
  const resolved = path.posix.normalize(path.posix.join(fromDirectory, decoded));
  return { path: resolved };
}

function markdownLinks(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const links = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    const target = match[1].trim();
    const local = localTarget(file, target);
    if (local) links.push({ target, ...local });
  }
  return links;
}

function validate(catalog) {
  const errors = [];
  const actual = new Set(lessonFiles());
  const lessons = allLessons(catalog);
  const listed = new Set();
  const required = catalog.lessonContract?.requiredHeadings ?? [];

  if (catalog.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (!Array.isArray(catalog.parts) || catalog.parts.length !== 5) {
    errors.push("catalog 必须包含 5 个部分");
  }
  for (const lesson of lessons) {
    if (listed.has(lesson.path)) errors.push(`重复章节：${lesson.path}`);
    listed.add(lesson.path);
    if (!actual.has(lesson.path)) errors.push(`catalog 指向不存在的文件：${lesson.path}`);
    else {
      const text = fs.readFileSync(path.join(ROOT, lesson.path), "utf8");
      for (const heading of required) {
        if (!text.includes(heading)) errors.push(`${lesson.path} 缺少 ${heading}`);
      }
      const heading = firstHeading(text);
      if (heading !== lesson.title) errors.push(`${lesson.path} 标题与 catalog 不一致`);
    }
  }
  for (const file of actual) {
    if (!listed.has(file)) errors.push(`章节未收录到 catalog：${file}`);
  }

  const orderedParts = [...catalog.parts].sort(sortByNumber).map((part) => part.number);
  if (orderedParts.some((number, index) => number !== index + 1)) {
    errors.push("部分编号必须从 1 连续排列");
  }
  for (const part of catalog.parts) {
    const chapters = part.chapters ?? [];
    const orderedChapters = [...chapters].sort(sortByNumber).map((chapter) => chapter.number);
    if (orderedChapters.some((number, index) => number !== orderedChapters[0] + index)) {
      errors.push(`第 ${part.number} 部分的章编号必须连续排列`);
    }
    const expectedTrack = part.number === 5 ? "elective" : "core";
    if (part.track !== expectedTrack) errors.push(`第 ${part.number} 部分 track 不正确`);
  }
  const allChapterNumbers = catalog.parts
    .flatMap((part) => part.chapters.map((chapter) => chapter.number))
    .sort((a, b) => a - b);
  if (allChapterNumbers.some((number, index) => number !== index + 1)) {
    errors.push("全书章编号必须从 1 到 20 连续排列");
  }

  const catalogTargets = new Set([
    catalog.intro.path,
    ...lessons.map((lesson) => lesson.path),
    ...catalog.appendices.map((appendix) => appendix.path),
  ]);
  const readme = fs.readFileSync(README_PATH, "utf8");
  const expectedDirectory = renderDirectory(catalog);
  const actualDirectory = readme.match(/^## 目录\r?\n[\s\S]*?(?=^## 版权\s*$)/m)?.[0]
    ?.trimEnd();
  if (actualDirectory !== expectedDirectory) {
    errors.push("README.md 的目录与 catalog 不一致；运行 --write-readme 同步");
  }
  for (const link of markdownLinks("README.md")) {
    if (link.error) errors.push(`README.md: ${link.error}`);
  }
  const readmeTargets = new Set(markdownLinks("README.md").map((link) => link.path));
  for (const target of catalogTargets) {
    if (!readmeTargets.has(target)) errors.push(`README.md 未链接 catalog 条目：${target}`);
  }

  for (const file of walk(ROOT).map(relative).filter((item) => item.endsWith(".md"))) {
    for (const link of markdownLinks(file)) {
      if (link.error) errors.push(`${file}: ${link.error}`);
      else if (link.path && !fs.existsSync(path.join(ROOT, link.path))) {
        errors.push(`${file}: 内链不存在：${link.target}`);
      }
    }
  }
  return errors;
}

function writeBootstrap() {
  const catalog = discoverCatalog();
  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return catalog;
}

function main() {
  if (args.has("--bootstrap")) writeBootstrap();
  const catalog = readCatalog();
  if (args.has("--write-readme")) {
    const readme = fs.readFileSync(README_PATH, "utf8");
    fs.writeFileSync(README_PATH, replaceDirectory(readme, renderDirectory(catalog)), "utf8");
  }
  if (args.has("--check")) {
    const errors = validate(catalog);
    if (errors.length) {
      errors.forEach(fail);
      process.exitCode = 1;
      return;
    }
    console.log(`catalog check: ok (${allLessons(catalog).length} lessons)`);
    return;
  }
  if (!args.has("--bootstrap") && !args.has("--write-readme")) {
    console.error("用法：node scripts/catalog.mjs --bootstrap [--write-readme] 或 --check");
    process.exitCode = 1;
  }
}

main();
