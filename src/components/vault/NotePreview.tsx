"use client";

import {
  isValidElement,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useMemo, useState } from "react";
import matter from "gray-matter";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  decodeWikilinkHref,
  resolveWikilinkPath,
  transformWikilinks,
} from "@/lib/wikilinks";
import { openFileExternal } from "@/lib/tauri";
import { X, ExternalLink, ChevronLeft, ChevronRight, Copy, Check } from "lucide-react";
import FrontmatterBlock from "@/components/vault/FrontmatterBlock";

interface NotePreviewProps {
  notePath: string | null;
  content: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenNote: (path: string) => void;
  onOpenInEditor?: (path: string) => void;
}

interface ParsedNoteContent {
  frontmatter: Record<string, unknown>;
  markdown: string;
}

const BLOCK_CHILD_TAGS = new Set([
  "div",
  "pre",
  "table",
  "ul",
  "ol",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

function parseNoteContent(content: string | null): ParsedNoteContent {
  const raw = content ?? "";
  if (!raw.trim()) {
    return { frontmatter: {}, markdown: "" };
  }

  try {
    const parsed = matter(raw);
    const frontmatter =
      parsed.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)
        : {};

    return {
      frontmatter,
      markdown: transformWikilinks(parsed.content ?? ""),
    };
  } catch {
    return {
      frontmatter: {},
      markdown: transformWikilinks(raw),
    };
  }
}

function normalizeCodeText(children: ReactNode): string {
  return String(children ?? "").replace(/\n$/, "");
}

function detectLanguage(className?: string): string {
  if (!className) return "text";
  const match = className.match(/language-([a-z0-9_+-]+)/i);
  if (!match) return "text";
  return match[1].toLowerCase();
}

function textFromReactChildren(children: ReactNode): string {
  const collect = (node: ReactNode): string => {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    if (Array.isArray(node)) {
      return node.map((child) => collect(child)).join("");
    }
    if (isValidElement(node)) {
      const props = node.props as { children?: ReactNode };
      return collect(props.children);
    }
    return "";
  };

  return collect(children).trim();
}

function MarkdownCodeBlock({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const language = detectLanguage(className);
  const code = normalizeCodeText(children);

  async function handleCopy() {
    if (!code.trim()) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      console.error("Failed to copy code block:", error);
    }
  }

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border/40 bg-bg-secondary/45">
      <div className="flex items-center justify-between border-b border-border/25 px-3 py-2">
        <span className="pill-badge text-text-muted">{language}</span>
        <button
          type="button"
          onClick={() => {
            void handleCopy();
          }}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-text-muted transition-colors hover:border-border/30 hover:bg-bg-tertiary/50 hover:text-text focus-visible:border-border-focus focus-visible:shadow-[0_0_0_1px_var(--color-border-focus)] outline-none"
          title={copied ? "Copied" : "Copy code"}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <pre className="hljs m-0 overflow-x-auto bg-transparent px-4 py-3 text-[13px] leading-relaxed">
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
}

function ToolbarIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-text-muted transition-colors hover:border-border/30 hover:bg-bg-tertiary/50 hover:text-text focus-visible:border-border-focus focus-visible:shadow-[0_0_0_1px_var(--color-border-focus)] outline-none disabled:cursor-not-allowed disabled:opacity-40"
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

export default function NotePreview({
  notePath,
  content,
  loading,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onOpenNote,
  onOpenInEditor,
}: NotePreviewProps) {
  const parsedNote = useMemo(() => parseNoteContent(content), [content]);
  const isExternalMarkdownHref = (href: string): boolean =>
    /^(https?:\/\/|mailto:|tel:)/i.test(href.trim());

  const handleMarkdownClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href")?.trim() ?? "";
    const textTarget = anchor.textContent?.trim() ?? "";
    const candidateTarget = href || textTarget;
    if (!candidateTarget || href.startsWith("#")) return;

    event.preventDefault();
    event.stopPropagation();

    if (href && isExternalMarkdownHref(href)) {
      void openFileExternal(href);
      return;
    }

    const wikilinkTarget = decodeWikilinkHref(href);
    if (wikilinkTarget) {
      const resolved = resolveWikilinkPath(wikilinkTarget, [], notePath);
      onOpenNote(resolved);
      return;
    }

    onOpenNote(candidateTarget);
  };

  const title = notePath ? notePath.split("/").pop() ?? notePath : "No note selected";

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border/20 px-4 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-text">{title}</p>
            {notePath && (
              <p className="truncate text-[11px] font-mono text-text-muted/70">{notePath}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <ToolbarIconButton
              label="Close preview"
              disabled={!notePath}
              onClick={() => onOpenNote("")}
            >
              <X className="h-3.5 w-3.5" />
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Open in editor"
              disabled={!notePath || loading}
              onClick={() => {
                if (notePath) {
                  onOpenInEditor?.(notePath);
                }
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.6} />
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Back"
              disabled={!canGoBack}
              onClick={onGoBack}
            >
              <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.7} />
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Forward"
              disabled={!canGoForward}
              onClick={onGoForward}
            >
              <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.7} />
            </ToolbarIconButton>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-visible px-6 py-5">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-text-muted/60 border-t-transparent" />
          </div>
        ) : !notePath ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Select a markdown file from the sidebar.
          </div>
        ) : content === null ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Unable to load note preview.
          </div>
        ) : (
          <div className="space-y-4">
            <FrontmatterBlock data={parsedNote.frontmatter} />

            <div
              className="prose prose-invert prose-sm prose-note max-w-none [&_blockquote]:my-4 [&_code]:font-mono [&_h1]:mb-4 [&_h2]:mt-8 [&_h3]:mt-6 [&_p]:leading-relaxed"
              onClickCapture={handleMarkdownClickCapture}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  p: ({
                    children,
                    node: _node,
                    ...props
                  }: ComponentPropsWithoutRef<"p"> & { node?: unknown }) => {
                    const hasBlockChild = (Array.isArray(children)
                      ? children
                      : [children]
                    ).some(
                      (child) =>
                        isValidElement(child) &&
                        typeof child.type === "string" &&
                        BLOCK_CHILD_TAGS.has(child.type),
                    );

                    if (hasBlockChild) {
                      return <div {...props}>{children}</div>;
                    }

                    return <p {...props}>{children}</p>;
                  },
                  pre: ({
                    children,
                    node: _node,
                    ...props
                  }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) => {
                    const codeChild = Array.isArray(children) ? children[0] : children;
                    if (
                      isValidElement(codeChild) &&
                      typeof codeChild.type === "string" &&
                      codeChild.type === "code"
                    ) {
                      const codeProps = codeChild.props as {
                        className?: string;
                        children?: ReactNode;
                      };
                      return (
                        <MarkdownCodeBlock className={codeProps.className}>
                          {codeProps.children}
                        </MarkdownCodeBlock>
                      );
                    }

                    return <pre {...props}>{children}</pre>;
                  },
                  a: ({
                    href,
                    children,
                    className,
                    node: _node,
                    ...props
                  }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => {
                    const wikilinkTarget = decodeWikilinkHref(href);
                    const resolvedHref = (href ?? "").trim();
                    const fallbackTextTarget = textFromReactChildren(children);
                    const internalTarget = resolvedHref || fallbackTextTarget;
                    const isHashLink = resolvedHref.startsWith("#");
                    const isExternalLink = isExternalMarkdownHref(resolvedHref);
                    if (wikilinkTarget) {
                      const resolved = resolveWikilinkPath(
                        wikilinkTarget,
                        [],
                        notePath,
                      );
                      return (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onOpenNote(resolved);
                          }}
                          className="mx-0.5 inline-flex items-center rounded-full border border-accent/30 bg-accent/[0.08] px-2 py-0.5 text-[11px] font-mono text-accent transition-colors hover:border-accent/50 hover:bg-accent/[0.14]"
                          title={`Open [[${wikilinkTarget}]]`}
                        >
                          [[{children}]]
                        </button>
                      );
                    }

                    if (internalTarget && !isExternalLink && !isHashLink) {
                      return (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onOpenNote(internalTarget);
                          }}
                          className={`cursor-pointer text-text-secondary underline decoration-border-hover/75 underline-offset-2 transition-colors hover:text-text ${
                            className ?? ""
                          }`.trim()}
                          title={internalTarget}
                        >
                          {children}
                        </button>
                      );
                    }

                    if (!resolvedHref) {
                      return (
                        <span
                          className={`text-text-secondary underline decoration-border-hover/75 underline-offset-2 ${
                            className ?? ""
                          }`.trim()}
                        >
                          {children}
                        </span>
                      );
                    }

                    return (
                      <a
                        {...props}
                        href={resolvedHref}
                        className={`text-text-secondary underline decoration-border-hover/75 underline-offset-2 transition-colors hover:text-text ${
                          className ?? ""
                        }`.trim()}
                        target={isExternalLink ? "_blank" : props.target}
                        rel={isExternalLink ? "noreferrer" : props.rel}
                        onClick={(event) => {
                          if (!isExternalLink) return;
                          event.preventDefault();
                          event.stopPropagation();
                          void openFileExternal(resolvedHref);
                        }}
                      >
                        {children}
                      </a>
                    );
                  },
                  code: ({
                    children,
                    className,
                    node: _node,
                    ...props
                  }: ComponentPropsWithoutRef<"code"> & { node?: unknown }) => {
                    const asText = String(children ?? "");
                    const isInlineCode =
                      !className && !asText.includes("\n");
                    if (isInlineCode) {
                      return <code className={className} {...props}>{children}</code>;
                    }

                    return (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {parsedNote.markdown}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
