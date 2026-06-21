"use client";

import Link from "next/link";
import { FolderGit2, Boxes, Link2, Box, Tag } from "lucide-react";
import type { EntityType } from "@/lib/entities";
import { cn } from "@/lib/utils";

const STYLES: Record<EntityType, string> = {
  github: "bg-foreground/10 text-foreground",
  huggingface: "bg-accent/15 text-accent",
  url: "bg-secondary text-secondary-foreground",
  project: "bg-primary/15 text-primary",
  concept: "bg-accent/10 text-accent",
};

const ICONS: Record<EntityType, typeof Box> = {
  github: FolderGit2,
  huggingface: Boxes,
  url: Link2,
  project: Box,
  concept: Tag,
};

export function EntityBadge({
  type,
  value,
  label,
  className,
}: {
  type: EntityType;
  value: string;
  label?: string;
  className?: string;
}) {
  const Icon = ICONS[type];
  const href = `/entities?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`;
  return (
    <Link
      href={href}
      title={`${type}: ${value}`}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-[filter] hover:brightness-110",
        STYLES[type],
        className,
      )}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{label ?? value}</span>
    </Link>
  );
}
