"use client";

import type { LucideIcon } from "lucide-react";
import { BriefcaseBusiness, Brain, FlaskConical, Folder, Layers } from "lucide-react";

export type FolderIconId =
  | "folder"
  | "brain"
  | "briefcase"
  | "layers"
  | "flask";

type FolderIconMeta = {
  id: FolderIconId;
  label: string;
  Icon: LucideIcon;
};

export const FOLDER_ICON_PRESETS: FolderIconMeta[] = [
  { id: "folder", label: "Folder", Icon: Folder },
  { id: "brain", label: "Brain", Icon: Brain },
  { id: "briefcase", label: "Briefcase", Icon: BriefcaseBusiness },
  { id: "layers", label: "Layers", Icon: Layers },
  { id: "flask", label: "Flask", Icon: FlaskConical },
];

const FOLDER_ICON_PRESET_MAP: Record<FolderIconId, FolderIconMeta> = {
  folder: FOLDER_ICON_PRESETS[0],
  brain: FOLDER_ICON_PRESETS[1],
  briefcase: FOLDER_ICON_PRESETS[2],
  layers: FOLDER_ICON_PRESETS[3],
  flask: FOLDER_ICON_PRESETS[4],
};

const LEGACY_ICON_ALIASES: Record<string, FolderIconId> = {
  "📁": "folder",
  "🧠": "brain",
  "💼": "briefcase",
  "🗂️": "layers",
  "🗂": "layers",
  "🧪": "flask",
};

const isFolderIconId = (value: string): value is FolderIconId => value in FOLDER_ICON_PRESET_MAP;

export const normalizeFolderIconId = (icon: string | null | undefined): FolderIconId | null => {
  if (!icon) return null;
  const trimmed = icon.trim();
  if (!trimmed) return null;
  if (isFolderIconId(trimmed)) return trimmed;

  const lowered = trimmed.toLowerCase();
  if (isFolderIconId(lowered)) return lowered;

  return LEGACY_ICON_ALIASES[trimmed] ?? null;
};

export const toStoredFolderIcon = (
  icon: string | null | undefined,
): FolderIconId | null => normalizeFolderIconId(icon);

interface FolderIconGlyphProps {
  icon: string | null | undefined;
  className?: string;
}

export function FolderIconGlyph({ icon, className }: FolderIconGlyphProps) {
  const iconId = normalizeFolderIconId(icon);
  if (!iconId) return null;

  const meta = FOLDER_ICON_PRESET_MAP[iconId];
  return <meta.Icon className={className ?? "h-4 w-4"} strokeWidth={1.9} aria-hidden="true" />;
}

