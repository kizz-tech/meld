const WIKILINK_PREFIX = "wikilink:";

export interface WikilinkReference {
  target: string;
  label: string;
}

export function parseWikilink(raw: string): WikilinkReference | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf("|");
  const target =
    separatorIndex >= 0
      ? trimmed.slice(0, separatorIndex).trim()
      : trimmed;
  const label =
    separatorIndex >= 0
      ? trimmed.slice(separatorIndex + 1).trim()
      : target;

  if (!target) return null;
  return {
    target,
    label: label || target,
  };
}

function transformLineOutsideInlineCode(line: string): string {
  if (!line.includes("[[")) return line;

  let result = "";
  let cursor = 0;
  let inInlineCode = false;

  while (cursor < line.length) {
    const symbol = line[cursor];

    if (symbol === "`") {
      inInlineCode = !inInlineCode;
      result += symbol;
      cursor += 1;
      continue;
    }

    if (
      !inInlineCode &&
      symbol === "[" &&
      line[cursor + 1] === "["
    ) {
      const closeIndex = line.indexOf("]]", cursor + 2);
      if (closeIndex !== -1) {
        const body = line.slice(cursor + 2, closeIndex);
        const parsed = parseWikilink(body);
        if (parsed) {
          result += `[${parsed.label}](${WIKILINK_PREFIX}${encodeURIComponent(parsed.target)})`;
          cursor = closeIndex + 2;
          continue;
        }
      }
    }

    result += symbol;
    cursor += 1;
  }

  return result;
}

export function transformWikilinks(markdown: string): string {
  if (!markdown.includes("[[")) return markdown;

  const lines = markdown.split("\n");
  let inFence = false;

  const transformed = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }

    if (inFence) {
      return line;
    }

    return transformLineOutsideInlineCode(line);
  });

  return transformed.join("\n");
}

export function decodeWikilinkHref(href?: string | null): string | null {
  if (!href || !href.startsWith(WIKILINK_PREFIX)) return null;
  const encoded = href.slice(WIKILINK_PREFIX.length);
  if (!encoded.trim()) return null;

  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function resolveWikilinkPath(
  target: string,
  sources: string[] = [],
  currentNotePath?: string | null,
): string {
  const withoutHeader = target.split("#")[0]?.trim() ?? "";
  if (!withoutHeader) return "";

  const normalizedTarget = withoutHeader.replace(/\\/g, "/");
  const withExtension = normalizedTarget.endsWith(".md")
    ? normalizedTarget
    : `${normalizedTarget}.md`;

  const candidates = new Set<string>();
  candidates.add(withExtension);

  const hasExplicitDirectory = withExtension.includes("/");
  const currentFolder = currentNotePath
    ? normalizeRelativePath(currentNotePath)
        .split("/")
        .slice(0, -1)
        .join("/")
    : "";
  if (!hasExplicitDirectory && currentFolder) {
    candidates.add(`${currentFolder}/${withExtension}`);
  }

  for (const candidate of candidates) {
    const targetNormalized = normalizeForCompare(candidate);
    const targetLeaf = targetNormalized.split("/").pop() ?? targetNormalized;
    const sourceMatch = sources.find((source) => {
      const normalizedSource = normalizeForCompare(source);
      if (normalizedSource.endsWith(targetNormalized)) return true;
      const leaf = normalizedSource.split("/").pop() ?? normalizedSource;
      return leaf === targetLeaf;
    });
    if (sourceMatch) {
      return sourceMatch;
    }
  }

  if (!hasExplicitDirectory && currentFolder) {
    return `${currentFolder}/${withExtension}`;
  }

  return withExtension;
}
